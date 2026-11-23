# Third-party components

Toolshed itself is MIT licensed. It is built on the work below, which keeps its
own terms.

Everything here runs in your browser. None of it is a service, and none of it
sends your files anywhere.

## Runtime dependencies

| Component                                                                                                                                                                                                     | Licence                      | What it does                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| [React](https://react.dev)                                                                                                                                                                                    | MIT                          | Interface                                               |
| [pdf-lib (Cantoo fork)](https://github.com/cantoo-scribe/pdf-lib)                                                                                                                                             | MIT                          | Reading and writing PDF structure, AES-256 encryption   |
| [pdf.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`)                                                                                                                                                    | Apache-2.0                   | Rendering PDF pages and extracting text                 |
| [jSquash](https://github.com/jamsinclair/jSquash) (`@jsquash/*`)                                                                                                                                              | Apache-2.0                   | WebAssembly image codecs, derived from Google's Squoosh |
| [mozjpeg](https://github.com/mozilla/mozjpeg), [oxipng](https://github.com/shssoichiro/oxipng), [libwebp](https://chromium.googlesource.com/webm/libwebp), [libavif](https://github.com/AOMediaCodec/libavif) | BSD-style / MIT / Apache-2.0 | The encoders inside those codecs                        |
| [libheif](https://github.com/strukturag/libheif) (`libheif-js`)                                                                                                                                               | **LGPL-3.0**                 | Decoding HEIC photos from iPhones                       |
| [JSZip](https://stuk.github.io/jszip/)                                                                                                                                                                        | MIT or GPLv3                 | Packaging batch results into one archive                |
| [Comlink](https://github.com/GoogleChromeLabs/comlink)                                                                                                                                                        | Apache-2.0                   | Talking to Web Workers                                  |
| [Tailwind CSS](https://tailwindcss.com)                                                                                                                                                                       | MIT                          | Styling                                                 |

## A note on libheif and the LGPL

HEIC decoding uses libheif, which is licensed under the LGPL-3.0 rather than a
permissive licence. That carries an obligation the rest of this list does not:
recipients must be able to replace libheif with their own version.

Toolshed is built so that obligation is straightforwardly met.

- libheif is loaded as a **separate, unmodified module**, fetched on demand the
  first time someone opens a HEIC file. It is not inlined into or merged with
  Toolshed's own code.
- It is used through its public API only. Nothing in this repository is a
  derivative of it.
- Replacing it means swapping the `libheif-js` dependency and rebuilding; the
  build is a plain `npm install && npm run build` with no proprietary steps.

If you redistribute a build of Toolshed, those terms travel with it. If you do
not want the LGPL obligation at all, removing HEIC support removes libheif: it
has exactly one call site, in `src/lib/image/codecs.ts`.

## Fonts

None are bundled or fetched. Toolshed uses the fonts already on your system.
