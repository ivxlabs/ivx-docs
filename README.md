# ivx/docs Sign

Free, open-source PDF signing that runs entirely in your browser. It does two
things: it places signature fields anywhere in a PDF, and it signs them.

Every signature is a real digital signature (PAdES, `ETSI.CAdES.detached`)
that any PDF reader can verify, and it can carry a visible mark: your name
typed in a handwriting font, a signature drawn with a mouse, pen or finger, or
an uploaded image. The key behind it can come from three places:

- **This browser.** A key is generated in the browser and stored there, non-extractable, with a self-signed certificate in your name. It proves the document has not changed since you signed it.
- **A certificate file.** A `.p12` or `.pfx` file and its password, for example one issued by a certificate authority.
- **A hardware token.** A smart card, national eID card, YubiKey (PIV) or USB signing token, through the small local [bridge](bridge/). The key never leaves the hardware; only a SHA-256 digest is sent to it.

Each change is saved as an incremental update, so the original bytes are
never rewritten. That means several people can sign the same document one
after another, and each earlier signature stays valid.

Nothing is uploaded. The app is a static PWA: install it and it works offline,
and, once installed, it can open PDFs straight from your file manager.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any directory of any host
npm test           # signs sample PDFs and verifies them with OpenSSL 3
```

`npm test` needs OpenSSL 3 (`OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl`
on macOS). To include the hardware path, run the bridge against
[SoftHSM](https://github.com/softhsm/SoftHSMv2) and set `PKCS11_MODULE` as
well; see [bridge/README.md](bridge/README.md).

## Layout

```
src/pdf/incremental.js   append-only revisions on top of pdf-lib
src/pdf/fields.js        find, add and remove signature fields; their appearance
src/pdf/sign.js          byte range, placeholder and the signature itself
src/crypto/cms.js        CMS SignedData for PAdES
src/crypto/signers.js    browser key, .p12 file, hardware token
src/appearance.js        typed, drawn or uploaded signature → PNG
src/viewer.js            PDF.js rendering
src/main.js              the UI
bridge/                  local PKCS#11 bridge for hardware tokens
```

## Limits

Password-protected PDFs are refused, because they can't be signed without
decrypting them first. Signatures carry no trusted timestamp and no embedded
revocation data (PAdES B-B). Signing with the browser key proves integrity,
not identity: a reader will say the document is unmodified but that the
signer's identity is unknown, until they choose to trust that certificate.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
