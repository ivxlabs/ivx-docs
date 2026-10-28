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
| `-no-sync` | | never let the page sync with your other devices |

## Sync

The bridge also lets ivx/docs keep your documents in step across your own
devices on the same Wi-Fi, with nothing on the internet and nothing stored
anywhere but those devices. A page cannot find other devices or accept a
connection, so the bridge does that much and no more: it announces this
device on the local network, lists the others, and carries messages between
the pages. The pages encrypt everything they send under a key two devices
agree when you pair them, by checking that both show the same six-digit
code, so the bridge cannot read what it carries.

Nothing happens until you turn sync on in the app. Then the bridge announces
itself over mDNS (`_ivx-sync._tcp`) and opens a second port, on every
interface, that takes sync messages and nothing else. On Windows this is when
the firewall asks; allow *Private networks*. Both devices need the app open
and the bridge running for a sync to happen.

It speaks the same protocol as ivx/ai Chat's bridge, so the page side is
shared too: `sync-engine.js` in
[ivxai-app](https://github.com/ivxlabs/ivxai-app/blob/main/web/src/sync-engine.js),
given an adapter for the app's own records and files. Devices only ever see
others syncing for the same app.

## Security

- Signing listens on `127.0.0.1` only, and answers only requests whose `Host` is its own, which defeats DNS rebinding.
- The sync port, open only while sync is on, answers private and link-local addresses only, takes one kind of request, and never reaches `/certificates` or `/sign`. It sends no CORS headers and wants a custom header, so a web page on your network cannot post to it either.
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
