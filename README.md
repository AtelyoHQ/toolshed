# Toolshed

Private PDF and image tools that run entirely inside your browser tab.

Nothing you open is uploaded. There is no server to upload it to: the whole
application is a folder of static files, and every byte of work happens in
WebAssembly on your own machine. Close the tab and the files are gone.

> Status: early. The engines and the UI are being built in the open — see the
> [open issues](https://github.com/AtelyoHQ/toolshed/issues) for what is landed
> and what is next.

## Why another one of these

Most "free online PDF tools" work the same way: you hand them your file, they
process it on their servers, and they keep it for somewhere between an hour and
two days. On top of that you get a 25–100 MB size cap, two or three free tasks
a day, and a pricing page.

That is a bad trade for a payslip, a passport scan, a signed contract or a
medical report — which is exactly what people put through these tools.

The browser can do all of this work on its own now. Toolshed is what you get
when you assume that from the start:

| | Hosted tools | Toolshed |
|---|---|---|
| Where your file goes | their servers | nowhere |
| File size limit | 25–100 MB typical | your RAM |
| Tasks per day | 2–3 free, then pay | unlimited |
| Account | usually required | none |
| Works on a plane | no | yes, it installs and runs offline |
| Price | freemium | free, MIT licensed |

## What it does

**Images** — compress (including *compress to an exact target size*, for the
forms that demand "under 200 KB"), convert between JPEG, PNG, WebP and AVIF,
decode HEIC from iPhones, resize, crop, rotate, and strip EXIF/GPS metadata.

**PDF** — compress, merge, split, reorder, rotate and delete pages, extract a
page range, convert images to PDF and PDF to images or plain text, add a
watermark or page numbers, and set or remove a password.

**Batch** — queue many files at once, give each its own settings, and download
the results individually or as a single zip.

## Verifying the privacy claim

Do not take the word of a README for this. Open DevTools, go to the Network
tab, process a file, and watch: there are no requests. For a stronger check,
load the page, turn off your network adapter entirely, and keep working.

The app also ships a network guard that counts any `fetch`, `XMLHttpRequest`,
`WebSocket` or `sendBeacon` attempt made after load and shows the count in the
header. It should read zero, always.

There is no analytics, no telemetry, no error reporting and no font or script
loaded from a CDN.

## Running it yourself

```sh
npm install
npm run dev
```

Build a static bundle you can host anywhere, including a USB stick:

```sh
npm run build        # outputs ./dist
npm run preview
```

`dist/` has no backend requirements at all — any static host or `file://`-style
local server will serve it.

## Development

```sh
npm run typecheck    # tsc project references, no emit
npm run lint         # eslint
npm run test         # vitest unit tests for the engines
npm run test:e2e     # playwright, builds and drives the real app
npm run format       # prettier
```

The code is laid out as a thin UI over two headless engines:

```
src/lib/image/   decode, encode, resize, metadata, target-size search
src/lib/pdf/     page operations, conversion, compression, encryption
src/lib/workers/ the engines, off the main thread, behind Comlink
src/components/  the UI
src/state/       the file queue
```

Both engines are plain TypeScript with no DOM dependencies beyond
`ImageData`/`OffscreenCanvas`, so they are unit-testable and reusable.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE). Third-party components and their licences are
listed in [THIRD-PARTY.md](THIRD-PARTY.md); note that HEIC decoding uses
libheif, which is LGPL-3.0 and is loaded as a separate, unmodified module.
