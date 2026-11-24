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

## A note on the files pdf.js loads at runtime

pdf.js carries WebAssembly modules of its own, each with its own upstream
licence, listed in `node_modules/pdfjs-dist/wasm/`: Apache-2.0, BSD-style and
MIT. Three of them ship here — openjpeg (JPEG 2000 images), jbig2 (JBIG2 and
CCITT scans) and qcms (ICC colour profiles). The fourth, quickjs, runs scripted
forms from a sandbox this project never loads, so it is not bundled.

It also carries the fourteen standard PDF typefaces, which documents do not
embed because every reader is required to have them: the Foxit fonts
(`LICENSE_FOXIT`, a BSD-style notice) and **Liberation Sans 1.07**, which is
the GNU General Public License v2 with font exceptions, not the Open Font
License — pdfjs-dist ships the 1.x fonts, and the OFL applies only from
Liberation 2.0. Both notices ship beside the fonts in
`assets/pdfjs-<version>/`, which is what each of those licences asks of a
redistribution.

Toolshed never embeds Liberation Sans in a document it produces. pdf.js uses
it to draw pages onto a canvas, and the Helvetica that watermarks and page
numbers are drawn with is one of the fourteen fonts a reader must already
have, so pdf-lib writes its name and nothing else: no bytes, no widths, no
descriptor. The metrics are used to place the text and then discarded. The
licence's embedding exception is a backstop here rather than the thing being
relied on. What does apply is the rest of it: the fonts ship unmodified,
alongside their licence, and are reached only through pdf.js.

It also carries the predefined character maps — 168 small files under Adobe's
three-clause BSD notice, which ships beside them as `LICENSE` — and a document
with a CJK font needs them before pdf.js will draw or extract a word of it.

Toolshed ships all of these as separate files, loaded on demand. That is not
only tidiness: pdf.js resolves them at runtime from base URLs it is given,
those bases have no default, and left alone it requests paths built out of the
string "null" while the feature silently degrades. A request to a URL this
build never chose is how ground rule 1 — nothing leaves the browser — stops
being enforceable, so they are bundled and pdf.js is pointed at them
explicitly. The directory name carries pdfjs-dist's version
because the files inside it cannot carry a content hash and are cached for
months. See `src/lib/pdf/pdfjsAssets.ts`.

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
