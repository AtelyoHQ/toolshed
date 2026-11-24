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

|                      | Hosted tools       | Toolshed                          |
| -------------------- | ------------------ | --------------------------------- |
| Where your file goes | their servers      | nowhere                           |
| File size limit      | 25–100 MB typical  | your RAM                          |
| Tasks per day        | 2–3 free, then pay | unlimited                         |
| Account              | usually required   | none                              |
| Works on a plane     | no                 | yes, it installs and runs offline |
| Price                | freemium           | free, MIT licensed                |

## What it does

**Images** — compress (including _compress to an exact target size_, for the
forms that demand "under 200 KB"), convert between JPEG, PNG, WebP and AVIF,
decode HEIC from iPhones, resize, crop, rotate, and strip EXIF/GPS metadata.

**PDF** — compress, merge, split, reorder, rotate and delete pages, extract a
page range, convert images to PDF and PDF to images or plain text, add a
watermark or page numbers, and set or remove a password.

**Batch** — queue many files at once, give each its own settings, and download
the results individually or as a single zip.

## How offline works

The application shell is precached on first visit, so Toolshed opens with the
network off straight away. The WebAssembly codecs are a different matter: taken
together they are more than ten megabytes, and someone who came to rotate one
JPEG should not pay for the AVIF encoder on mobile data. So each codec is
cached the first time a tool actually uses it, and that tool works offline from
then on.

In short: the app is always available offline; a given tool is available
offline once you have used it once.

Installing it is optional and offered once. When the browser decides the app is
installable it says so in a small bar, and dismissing that is remembered —
unless the browser gives the page no durable local storage, in which case the
offer can come back after a reload. New versions install themselves in the
background; a line of text tells you one is ready rather than reloading the
tab, because a reload in the middle of a batch would throw the batch away.
Reload before reaching for a tool you have not opened in that tab, though:
codec chunks are named by content hash and are not precached, so one you have
never fetched will ask the host for a file the new release replaced.

Toolshed will keep its state in the URL hash rather than the path, so that the
whole thing can be served from any subdirectory — a path-based route would
make the app's relative asset URLs resolve against the route and 404 on a deep
link. `npm run check:subpath` serves `dist/` from a nested directory, fetches
every asset `index.html` references, and scans the built scripts for absolute
asset paths. It runs in CI.

## Verifying the privacy claim

Do not take the word of a README for this. Open DevTools, go to the Network
tab, process a file, and watch: there are no requests. For a stronger check,
load the page, turn off your network adapter entirely, and keep working.

There is no analytics, no telemetry, no error reporting and no font or script
loaded from a CDN. Three separate things hold that, in descending order of how
much they are worth:

1. **A Content-Security-Policy**: `default-src 'self'`, `connect-src 'self'`.
   This is enforcement rather than intention — it holds against code nobody
   here reviewed, including a dependency compromised after this was written.
   It ships both as a `<meta>` tag and as real response headers
   (`public/_headers`, `vercel.json`), because **a meta tag does not apply to
   Web Workers**, and the workers are where your files are processed. A host
   that cannot send headers, such as GitHub Pages, leaves that gap;
   [PRIVACY.md](PRIVACY.md) spells out exactly what it costs.
2. **An end-to-end test** that loads the real built app and fails if a single
   request goes anywhere else. This is the check that catches a CDN font added
   to the HTML or the stylesheet, which no JavaScript linter would see.
3. **Lint rules** that reject `fetch`, `XMLHttpRequest`, `WebSocket`,
   `EventSource`, `navigator.sendBeacon` and remote dynamic imports outside the
   network guard. A first line of defence, not the guarantee: it stops the
   accident, not the determined.

The interface will also show a live count of requests attempted since the page
loaded, so you can watch it stay at zero while you work.

[PRIVACY.md](PRIVACY.md) states all of this plainly, including the gaps.

## Running it yourself

```sh
npm install
npm run dev
```

Build a static bundle you can host anywhere:

```sh
npm run build        # outputs ./dist
npm run preview
```

`dist/` has no backend requirements at all: any static host will serve it,
including from a subdirectory. It does need to be _served_, though — opening
`dist/index.html` by double-clicking it will not work, because a module script
and a service worker both need a real origin. Any one-line static server does
the job.

If your host can send response headers, point it at `public/_headers`
(Netlify, Cloudflare Pages) or `vercel.json` (Vercel). That is what extends the
Content-Security-Policy to the Web Workers where files are processed.
[DEPLOYING.md](DEPLOYING.md) goes through the hosts one at a time, including
why GitHub Pages cannot do it and what that costs.

## Development

```sh
npm run typecheck    # tsc project references, no emit
npm run lint         # eslint
npm run test         # vitest unit tests for the engines
npm run test:e2e     # playwright: the built app, the engine, and an offline run
npm run check:subpath # serves dist/ from a nested directory
npm run check:icons   # the committed icons still match their generator
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
