// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Where token drivers put their PKCS#11 modules. Vendor drivers come first —
// HyperSecu HYP2003 is a renamed ePass2003 Auto and ships the same module —
// then OpenSC and Yubico as the fallbacks for everything else. Globs, so
// version suffixes match.
var known = map[string][]string{
	"windows": {
		`$SystemRoot\System32\eps2003csp11*.dll`, // ePass2003, HyperSecu HYP2003
		`$SystemRoot\System32\SignatureP11.dll`,  // WatchData ProxKey
		`$SystemRoot\System32\CryptoIDA_pkcs11.dll`,
		`$SystemRoot\System32\eTPKCS11.dll`,
		`$SystemRoot\System32\IDPrimePKCS11.dll`,
		`$ProgramFiles\OpenSC Project\OpenSC\pkcs11\opensc-pkcs11.dll`,
		`$ProgramFiles\Yubico\Yubico PIV Tool\bin\libykcs11.dll`,
	},
	"darwin": {
		"/usr/local/lib/libcastle*.dylib",
		"/usr/local/lib/libeTPkcs11.dylib",
		"/Library/OpenSC/lib/opensc-pkcs11.so",
		"/opt/homebrew/lib/opensc-pkcs11.so",
		"/usr/local/lib/opensc-pkcs11.so",
		"/opt/homebrew/lib/libykcs11.dylib",
		"/usr/local/lib/libykcs11.dylib",
	},
	"linux": {
		"/usr/lib/libcastle.so*",
		"/usr/lib/WatchData/ProxKey/lib/libwdpkcs_SignatureP11.so",
		"/usr/lib*/libeTPkcs11.so",
		"/usr/lib/*/opensc-pkcs11.so",
		"/usr/lib*/opensc-pkcs11.so",
		"/usr/lib/*/libykcs11.so*",
	},
}

// Last resort on Windows: any module-looking DLL a driver put in System32.
var fallback = []string{`$SystemRoot\System32\*pkcs11*.dll`, `$SystemRoot\System32\*csp11*.dll`}

func glob(patterns []string) []string {
	var found []string
	seen := map[string]bool{}
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(os.ExpandEnv(pattern))
		for _, path := range matches {
			real, err := filepath.EvalSymlinks(path)
			if err != nil || seen[strings.ToLower(real)] {
				continue
			}
			seen[strings.ToLower(real)] = true
			found = append(found, path)
		}
	}
	return found
}

func discover() []string {
	if found := glob(known[runtime.GOOS]); len(found) > 0 || runtime.GOOS != "windows" {
		return found
	}
	return glob(fallback)
}

// Bridge holds the loaded modules. PKCS#11 modules are not all safe to call
// from several threads, so every call goes through one lock.
type Bridge struct {
	mu       sync.Mutex
	explicit []string
	modules  []*module
	Log      func(format string, args ...any)
}

// load loads the modules given, or finds them. It is called again whenever
// none are loaded, so a driver installed after start-up is still picked up.
func (b *Bridge) load() {
	if len(b.modules) > 0 {
		return
	}
	paths := b.explicit
	if len(paths) == 0 {
		paths = discover()
	}
	for _, path := range paths {
		m, err := loadModule(path)
		if err != nil {
			b.Log("skipping %s: %v", path, err)
			continue
		}
		b.Log("using %s", path)
		b.modules = append(b.modules, m)
	}
}

// Certificate is one certificate on a token. ID is opaque to the web app.
type Certificate struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Certificate string `json:"certificate"` // base64 DER
}

// Certificates lists the signing certificates on every connected token,
// each once even when two modules can see the same token.
func (b *Bridge) Certificates() ([]Certificate, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	if len(b.modules) == 0 {
		return nil, errors.New("No token driver found. Install your token's driver, or start the bridge with -module.")
	}

	var out []Certificate
	seen := map[[32]byte]bool{}
	for mi, m := range b.modules {
		slots, err := m.slots()
		if err != nil {
			b.Log("%s: %v", m.path, err)
			continue
		}
		for _, slot := range slots {
			tokenLabel, serial, err := m.tokenInfo(slot)
			if err != nil {
				continue // an empty or unreadable slot
			}
			session, err := m.openSession(slot)
			if err != nil {
				continue
			}
			handles, _ := m.find(session, attribute{ckaClass, ulong(ckoCertificate)})
			for _, h := range handles {
				v, err := m.attributes(session, h, ckaValue, ckaID, ckaLabel)
				if err != nil || len(v[0]) == 0 {
					continue
				}
				// Issuer certificates often ride along on the token: a CA whose key
				// usage stops at certificates and CRLs is not one anyone signs with.
				const signing = x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment
				if c, err := x509.ParseCertificate(v[0]); err == nil && c.IsCA && c.KeyUsage != 0 && c.KeyUsage&signing == 0 {
					continue
				}
				sum := sha256.Sum256(v[0])
				if seen[sum] {
					continue
				}
				seen[sum] = true
				label := string(v[2])
				if label == "" {
					label = tokenLabel
				}
				out = append(out, Certificate{
					ID:          fmt.Sprintf("%d:%s:%x", mi, serial, v[1]),
					Label:       label,
					Certificate: base64.StdEncoding.EncodeToString(v[0]),
				})
			}
			m.closeSession(session)
		}
	}
	return out, nil
}

// DER prefix of a SHA-256 DigestInfo: CKM_RSA_PKCS signs exactly what it is given.
var sha256DigestInfo, _ = hex.DecodeString("3031300d060960864801650304020105000420")

// Sign signs a SHA-256 digest with the key behind certificate `id`, and
// returns the raw signature (r||s for ECDSA, as Web Crypto does).
func (b *Bridge) Sign(id, pin string, digest []byte) ([]byte, error) {
	if len(digest) != sha256.Size {
		return nil, errors.New("Expected a SHA-256 digest.")
	}
	// module:serial:keyID — split at the outer colons, since a serial may hold one.
	first, last := strings.Index(id, ":"), strings.LastIndex(id, ":")
	if first < 0 || first == last {
		return nil, errors.New("Unknown certificate.")
	}
	serial := id[first+1 : last]
	mi, err1 := strconv.Atoi(id[:first])
	keyID, err2 := hex.DecodeString(id[last+1:])
	b.mu.Lock()
	defer b.mu.Unlock()
	if err1 != nil || err2 != nil || mi < 0 || mi >= len(b.modules) {
		return nil, errors.New("Unknown certificate.")
	}
	m := b.modules[mi]

	slots, err := m.slots()
	if err != nil {
		return nil, err
	}
	for _, slot := range slots {
		if _, s, err := m.tokenInfo(slot); err != nil || s != serial {
			continue
		}
		session, err := m.openSession(slot)
		if err != nil {
			return nil, err
		}
		defer m.closeSession(session)
		if err := m.login(session, pin); err != nil {
			return nil, err
		}
		defer m.logout(session)

		keys, err := m.find(session, attribute{ckaClass, ulong(ckoPrivateKey)}, attribute{ckaID, keyID})
		if err != nil || len(keys) == 0 {
			return nil, errors.New("No private key on the token matches that certificate.")
		}
		v, err := m.attributes(session, keys[0], ckaKeyType)
		if err != nil {
			return nil, err
		}
		if len(v[0]) > 0 && getUlong(v[0]) == ckkRSA {
			return m.sign(session, keys[0], ckmRSAPKCS, append(append([]byte{}, sha256DigestInfo...), digest...))
		}
		return m.sign(session, keys[0], ckmECDSA, digest)
	}
	return nil, errors.New("That token is not connected.")
}
