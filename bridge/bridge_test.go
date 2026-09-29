// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestOnlyAllowedOriginsAndHost(t *testing.T) {
	h := handler(&Bridge{Log: t.Logf}, 47111, []string{"https://docs.ivx.run"})
	cases := []struct {
		host, origin string
		want         int
	}{
		{"127.0.0.1:47111", "https://evil.example", http.StatusForbidden},
		{"127.0.0.1:47111", "", http.StatusForbidden},
		{"rebound.example:47111", "https://docs.ivx.run", http.StatusForbidden},
		{"127.0.0.1:47111", "https://docs.ivx.run", http.StatusNoContent},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodOptions, "/certificates", nil)
		req.Host = c.host
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		if res.Code != c.want {
			t.Errorf("%s from %q: got %d, want %d", c.host, c.origin, res.Code, c.want)
		}
	}
}

func TestRejectsWhatIsNotADigest(t *testing.T) {
	if _, err := (&Bridge{}).Sign("0:x:01", "1234", []byte("a whole document")); err == nil {
		t.Fatal("signed something that is not a SHA-256 digest")
	}
}

// With PKCS11_MODULE pointing at a module with a token (SoftHSM will do; see
// README.md) and PIN set, signs with every certificate and checks the result.
func TestSignsWithEveryCertificate(t *testing.T) {
	module := os.Getenv("PKCS11_MODULE")
	if module == "" {
		t.Skip("set PKCS11_MODULE (and PIN) to test against a token")
	}
	pin := os.Getenv("PIN")
	if pin == "" {
		pin = "1234"
	}
	b := &Bridge{explicit: []string{module}, Log: t.Logf}
	certs, err := b.Certificates()
	if err != nil || len(certs) == 0 {
		t.Fatalf("no certificates: %v", err)
	}

	digest := sha256.Sum256([]byte("ivx/docs"))
	if _, err := b.Sign(certs[0].ID, "wrong-pin", digest[:]); err == nil || !strings.Contains(err.Error(), "PIN") {
		t.Errorf("a wrong PIN gave %v", err)
	}

	for _, c := range certs {
		der, _ := base64.StdEncoding.DecodeString(c.Certificate)
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := b.Sign(c.ID, pin, digest[:])
		if err != nil {
			t.Fatalf("%s: %v", c.Label, err)
		}
		switch key := cert.PublicKey.(type) {
		case *rsa.PublicKey:
			err = rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig)
		case *ecdsa.PublicKey:
			half := len(sig) / 2
			if !ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(sig[:half]), new(big.Int).SetBytes(sig[half:])) {
				err = os.ErrInvalid
			}
		}
		if err != nil {
			t.Errorf("%s: signature does not verify: %v", c.Label, err)
		} else {
			t.Logf("%s (%T): verified", c.Label, cert.PublicKey)
		}
	}
}
