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

## Verify

[docs.ivx.run/verify](https://docs.ivx.run/verify/) checks every signature in
a PDF and says, in plain sentences, what it found. For each one: whether the
bytes it covers are unchanged and the signature over them verifies; when it
was made, from a trusted timestamp if it carries one, or else the signer's
own clock; and the certificate chain it carries. If the signature doesn't
cover the whole file, Verify compares the signed revision with the current
one and reports what the later revisions did: added signatures, filled in or
added form fields, added comments, or something else that could change what
the document shows. The signed revision itself can be downloaded, to see
exactly what was signed.

It reads PAdES and the older `adbe.pkcs7.detached` and `adbe.pkcs7.sha1`
signatures, plus document timestamps. Nothing is fetched while checking: there
is no revocation lookup and no list of trusted issuers, so Verify shows who a
certificate names and who issued it, and leaves trusting them to you.

## Merge PDFs

[docs.ivx.run/merge](https://docs.ivx.run/merge/) combines PDFs into one. Put
them in order by dragging, and take every page of each or a range like
`1-3, 5, 8-` (`5-1` runs backwards). The result is a new file, so signatures
in the originals don't carry over as valid signatures.

## Tasks

[docs.ivx.run/tasks](https://docs.ivx.run/tasks/) is a to-do list in the manner
of Google Tasks, kept in this browser. Lists hold tasks, and any list can be
shown as a list or as a board, with To do, In progress and Done columns that
tasks are dragged between. A task can be given a day, a start time, and an end
time that blocks out the time it takes, and it can repeat: every few days,
weeks (on chosen weekdays), months or years, until a date or for a number of
times. Completing a repeating one sets up the next.

Upcoming gathers the dated tasks from every list for a span you choose (today,
this week, this month, the next 30 days, or your own dates), grouped by day
and sorted by time, starred first among tasks at the same time. Starred
gathers every starred task.

A completed task moves to the archive after 30 days, the archive to the trash
after 30 more, and the trash empties itself after another 30; each is set in
Settings, and 0 turns it off.

Reminders are the browser's own notifications: at a task's start, or a chosen
time before it, at the end of its time block, and at a set time of day for
tasks with a day but no time. They come while Tasks is open, in a tab or
installed as an app, since browsers give a closed page no way to wake itself;
ones missed while it was closed show when it next opens.

Tasks syncs between your own browsers on the same Wi-Fi, browser to browser
over WebRTC, with no server and nothing to install. One device shows a code
as a QR code (also a link, so a phone's camera opens it), the other scans it
and shows a reply that the first scans back, and the two connect directly
and encrypted. No STUN or TURN server is involved, so they can only reach
each other on the same network, and while both stay open every change goes
across as it is made. For a backup beyond
your devices, it can save everything to a file, or, if you sign in with an
ivx account and connect Google there, to your own Google Drive: the backup
goes from the browser to Google directly, optionally encrypted with a
passphrase first, and [iam.ivx.run](https://iam.ivx.run) only hands Tasks a
short-lived token that reaches the files ivx itself made in that Drive. To
turn Drive backups on in your own copy, register Tasks as an OAuth client on
iam (redirect URI: the Tasks page itself) and set `IAM.clientId` in
`src/tasks/backup.js`.

## Development

```sh
npm install
npm run dev        # http://localhost:5173 (the hub), /sign/, /verify/, /merge/
npm run build      # static site in dist/, deployable to any directory of any host
npm test           # signs sample PDFs, checks them with OpenSSL 3 and Verify, merges them
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
verify/index.html        Verify, with its UI in src/verify/
merge/index.html         Merge PDFs, with its UI in src/merge/
src/pdf/                 PDF.js rendering, incremental updates, fields, signing,
                         verifying, merging
src/crypto/              CMS for PAdES; browser key, .p12 file, hardware token
bridge/                  the token bridge: a Go program, released as binaries
```

A new tool is a directory with an `index.html` that imports `src/site.js`,
an entry in `build.rollupOptions.input` in `vite.config.js`, and a line on
the hub.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
