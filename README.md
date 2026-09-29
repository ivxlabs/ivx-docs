# ivx/docs

Free, open-source document tools that run entirely in your browser, at
[docs.ivx.run](https://docs.ivx.run). There's no server behind them, no
account and no upload: you open a file, work on it, and save it back. The site
is a static PWA, so once installed it works offline, and it can open PDFs
straight from your file manager.

## Sign

[docs.ivx.run/sign](https://docs.ivx.run/sign/) does two things: it places
signature fields anywhere in a PDF, and it signs them.

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

Password-protected PDFs are refused, because they can't be signed without
decrypting them first. Signatures carry no trusted timestamp and no embedded
revocation data (PAdES B-B). Signing with the browser key proves integrity,
not identity: a reader will say the document is unmodified but that the
signer's identity is unknown, until they choose to trust that certificate.

## Development

```sh
npm install
npm run dev        # http://localhost:5173 (the hub) and /sign/
npm run build      # static site in dist/, deployable to any directory of any host
npm test           # signs sample PDFs and verifies them with OpenSSL 3
```

`npm test` needs OpenSSL 3 (`OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl`
on macOS). To include the hardware path, run the bridge against
[SoftHSM](https://github.com/softhsm/SoftHSMv2) and set `PKCS11_MODULE` as
well; see [bridge/README.md](bridge/README.md).

Pushing to `main` runs the tests, builds, and publishes to GitHub Pages
([deploy.yml](.github/workflows/deploy.yml)). The bridge is a separate Go
program; pushing a `bridge-v*` tag builds it for every platform and publishes
a release ([bridge.yml](.github/workflows/bridge.yml)).

## Layout

```
index.html               the hub: one entry per tool
src/site.js, site.css    what every page shares: type, base styles, offline worker
public/                  manifest, service worker, icons (tools/make-icons.mjs)

sign/index.html          Sign
src/sign/                its UI and signature appearance (typed, drawn, uploaded)
src/pdf/                 PDF.js rendering, incremental updates, fields, signing
src/crypto/              CMS for PAdES; browser key, .p12 file, hardware token
bridge/                  the token bridge: a Go program, released as binaries
```

A new tool is a directory with an `index.html` that imports `src/site.js`,
an entry in `build.rollupOptions.input` in `vite.config.js`, and a line on
the hub.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
