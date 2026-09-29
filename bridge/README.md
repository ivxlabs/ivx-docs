# ivx/docs Sign — token bridge

Browsers cannot talk to smart cards or USB signing tokens. This small program
can: [ivx/docs Sign](https://docs.ivx.run/sign/) hands it a SHA-256 digest,
and your token signs it. The key never leaves the token.

It is a single file with nothing to install: no Node.js, no Java, no runtime.

## Use it

1. Install your token's driver, as you would for any other signing software.
2. Download the bridge for your system from the [latest release](https://github.com/ivxlabs/ivx-docs/releases/latest) and unpack it.
3. Run it and leave the window open while you sign:
   - **Windows:** double-click `ivx-docs-bridge.exe`. If SmartScreen warns about an unrecognised app, choose *More info → Run anyway*.
   - **macOS:** in Terminal, `xattr -d com.apple.quarantine ivx-docs-bridge && ./ivx-docs-bridge`. The first command stops Gatekeeper blocking a download it does not recognise.
   - **Linux:** `./ivx-docs-bridge`
4. In Sign, choose *Hardware token*, then *Find certificates*, pick yours, enter the token PIN and sign.

The bridge finds the drivers for these tokens by itself:

| Token | Driver it looks for |
| --- | --- |
| HyperSecu HYP2003, ePass2003 | `eps2003csp11.dll`, `libcastle` |
| WatchData ProxKey | `SignatureP11.dll`, `libwdpkcs_SignatureP11.so` |
| Longmai mToken CryptoID | `CryptoIDA_pkcs11.dll` |
| SafeNet / Aladdin eToken | `eTPKCS11.dll`, `libeTPkcs11` |
| Gemalto IDPrime | `IDPrimePKCS11.dll` |
| Most other smart cards and eID cards | OpenSC's `opensc-pkcs11` |
| YubiKey | `libykcs11` |

On Windows it falls back to any PKCS#11 DLL a driver put in `System32`. To
check what it sees, run it with `-list`. If your token isn't found, point it
at the driver's PKCS#11 module yourself:

```
ivx-docs-bridge -module "C:\Windows\System32\your-token-pkcs11.dll"
```

## Options

| Flag | Default | |
| --- | --- | --- |
| `-module` | found automatically | path to a PKCS#11 module; repeat it for several |
| `-list` | | print the certificates on connected tokens, then exit |
| `-port` | `47111` | the app reaches it at `http://127.0.0.1:PORT` |
| `-origins` | `https://docs.ivx.run,http://localhost:5173,http://localhost:4173` | web origins allowed to use it; add yours if you host the app elsewhere |

## Security

- It listens on `127.0.0.1` only, and answers only requests whose `Host` is its own, which defeats DNS rebinding.
- Only pages from `-origins` get an answer.
- It accepts only a 32-byte digest, never a document.
- Every signature needs the PIN. It logs in, signs once and logs out again, and keeps nothing.

## Building and testing

It calls PKCS#11 modules directly, without cgo, so any machine builds every
platform:

```sh
GOOS=windows GOARCH=amd64 go build -o ivx-docs-bridge.exe .
go test ./...
```

The tests that need a token run against [SoftHSM](https://github.com/softhsm/SoftHSMv2)
when `PKCS11_MODULE` is set. See `.github/workflows/bridge.yml` for setting up
a token with an RSA and an EC key. The same token also drives the web app's
end-to-end test: start the bridge with `-module`, then run
`PKCS11_MODULE=1 npm test` from the repository root.

Releases are built by pushing a `bridge-v*` tag.
