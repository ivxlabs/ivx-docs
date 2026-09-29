# ivx/docs Sign — token bridge

Browsers cannot talk to smart cards or USB tokens. This bridge is a small
local server that can: ivx/docs Sign sends it a SHA-256 digest, and the token
signs the digest through its PKCS#11 module.

```sh
cd bridge
npm install
PKCS11_MODULE=/path/to/pkcs11-module node server.js
```

Common modules:

| Token | Module |
| --- | --- |
| Most smart cards, eID cards, YubiKey PIV (via OpenSC) | `/opt/homebrew/lib/opensc-pkcs11.so`, `/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so`, `C:\Windows\System32\opensc-pkcs11.dll` |
| YubiKey (Yubico's own) | `libykcs11` |
| Vendor USB tokens (ePass, SafeNet, WatchData…) | the `.so`, `.dylib` or `.dll` that ships with the token's driver |

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PKCS11_MODULE` | — | path to the PKCS#11 library (or pass it as the first argument) |
| `PORT` | `47111` | the address the app points at is `http://127.0.0.1:PORT` |
| `ORIGINS` | `https://docs.ivx.run,http://localhost:5173,http://localhost:4173` | comma-separated origins allowed to use the bridge; add yours if you host the app elsewhere |

## Security

- It listens on `127.0.0.1` only, and answers only requests whose `Host` is its own, which defeats DNS rebinding.
- Only pages from `ORIGINS` get an answer.
- It accepts only a 32-byte digest, never a document.
- Every signature needs the PIN. The bridge logs in, signs once, and logs out again; it keeps nothing.

## Testing without hardware

With [SoftHSM](https://github.com/softhsm/SoftHSMv2) and OpenSC's `pkcs11-tool`:

```sh
export SOFTHSM2_CONF=$PWD/softhsm2.conf
echo "directories.tokendir = $PWD/tokens" > softhsm2.conf && mkdir tokens
softhsm2-util --init-token --free --label test --pin 1234 --so-pin 5678
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=Test -keyout k.pem -out c.pem
openssl pkey -in k.pem -outform DER -out k.der && openssl x509 -in c.pem -outform DER -out c.der
M=$(brew --prefix)/lib/softhsm/libsofthsm2.so
pkcs11-tool --module $M --login --pin 1234 --write-object k.der --type privkey --id 01
pkcs11-tool --module $M --login --pin 1234 --write-object c.der --type cert --id 01
PKCS11_MODULE=$M node server.js
# in another shell, from the repository root:
PKCS11_MODULE=$M npm test
```
