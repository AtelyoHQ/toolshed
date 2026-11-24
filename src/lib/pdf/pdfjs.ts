import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import { PasswordRequiredError, UnreadablePdfError, WrongPasswordError } from './errors';
import { pdfjsCMapDirectory, pdfjsFontDirectory, pdfjsWasmDirectory } from './pdfjsAssets';
import {
  scaleForDpi,
  type PdfRasterizer,
  type PdfTextReader,
  type RasterFormat,
  type RasterizeRequest,
  type RenderedPage,
  type TextRequest,
} from './render';

/**
 * pdf.js, driven from inside a worker.
 *
 * This is the only file in the engine that needs a browser, and it is
 * deliberately thin: it opens documents, draws pages onto an OffscreenCanvas
 * and reads the text layer. Which pages, at what resolution and whether the
 * answer is worth keeping are decided by the pure modules that inject it, so
 * those stay testable in Node. This part is covered by `e2e/pdf-engine.spec.ts`,
 * which runs it in a real browser, because nothing else can.
 *
 * Three things here are not obvious and all three are load-bearing:
 *
 * - the asset directories, for the reasons set out in `pdfjsAssets.ts`;
 * - the worker entry point, bundled through Vite's `?worker` rather than
 *   fetched from a CDN, which is what pdf.js does if left alone;
 * - the canvas and filter factories, because pdf.js reaches for `document`
 *   and there is none in a worker.
 */

const MIME: Record<RasterFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * pdf.js's own worker, started once and shared.
 *
 * A dedicated worker may start another, which is how this engine ends up with
 * pdf.js off its own thread while still living inside Toolshed's PDF worker.
 * It is never shut down explicitly: it dies with the worker that started it,
 * which is what the pool terminates.
 */
let pdfjsWorker: Worker | null = null;

function ensureWorker(): void {
  if (pdfjsWorker) return;
  pdfjsWorker = new PdfjsWorker();
  GlobalWorkerOptions.workerPort = pdfjsWorker;
}

/**
 * An OffscreenCanvas factory, standing in for pdf.js's DOM one.
 *
 * pdf.js creates canvases of its own for transparency groups, soft masks and
 * tiling patterns. Its default factory calls `document.createElement`, which
 * in a worker is a TypeError on the first page that has a transparent group
 * in it — which is most pages produced by a design application.
 */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: context2d(canvas, true) };
  }

  reset(entry: { canvas: OffscreenCanvas | null }, width: number, height: number) {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    // Zero the dimensions before dropping the reference: that is what frees
    // the backing store promptly rather than at the next collection, and a
    // 200-page render at 200 dpi cannot wait for the collector.
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }

  getNoAlphaContext(canvas: OffscreenCanvas) {
    return context2d(canvas, false);
  }
}

function context2d(canvas: OffscreenCanvas, alpha: boolean): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha, willReadFrequently: true });
  if (!context) throw new Error('This browser gave no 2D canvas context');
  return context;
}

/**
 * pdf.js's filter factory, with every filter declined.
 *
 * The DOM one builds SVG `<filter>` elements to implement transfer functions
 * and colour-key masking, which needs a document. Returning "none" is what
 * pdf.js's own base class does, and is also what happens in any browser that
 * cannot do SVG filters: the page renders, and the rare document that uses a
 * transfer function renders without it.
 */
class NoFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addKnockoutFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  addSelectionHCMFilter() {
    return 'none';
  }
  addSelectionFilter() {
    return 'none';
  }
  createSelectionStyle() {
    return null;
  }
  destroy() {}
}

/**
 * Opens a document and hands back the loading task as well as the document.
 *
 * The task is what releases pdf.js's resources: in this version the document
 * proxy has `cleanup()` — which only frees cached page data — and the task has
 * `destroy()`. Finishing with the former leaks every document ever opened.
 */
async function open(
  bytes: Uint8Array,
  password?: string,
): Promise<{ doc: PDFDocumentProxy; close: () => Promise<void> }> {
  ensureWorker();
  try {
    const task = getDocument({
      // A copy, because pdf.js transfers the buffer it is given to its worker.
      // Handing it the caller's array would detach it, and the caller — the
      // compressor — still needs those bytes to compare sizes afterwards.
      data: bytes.slice(),
      password,
      wasmUrl: pdfjsWasmDirectory(),
      // The fourteen typefaces a reader must provide and a document therefore
      // does not embed. Without this pdf.js substitutes glyphs, which would
      // make rasterised compression quietly change a document's typography —
      // including Toolshed's own watermarks, which are drawn in Helvetica.
      standardFontDataUrl: pdfjsFontDirectory(),
      // The predefined character maps. Needed for a document that uses one as
      // its encoding, and — the case that makes this not optional — for any
      // composite font with no `/ToUnicode`, where pdf.js builds the Unicode
      // map from `<registry>-<ordering>-UCS2.bcmap`. Without them such a font
      // fails to translate at all and its text renders and extracts as
      // nothing, which rasterising compression would hand back as a saving.
      cMapUrl: pdfjsCMapDirectory(),
      cMapPacked: true,
      // pdf.js's worker loads the wasm above itself. The alternative routes
      // every byte back through this thread for no gain, and switching it off
      // also disables colour management outright — pdf.js reads this flag as
      // "may I load qcms at all". The cost is that those requests happen in a
      // worker the network guard never patched, so what covers them is the
      // Content-Security-Policy and the end-to-end test that fails if any
      // request leaves this origin.
      useWorkerFetch: true,
      // A third worker that renders into transferred frames. It needs
      // `document.fonts`, so it is unavailable here anyway; saying so keeps
      // pdf.js from starting one to find that out.
      disableWorkerRendering: true,
      CanvasFactory: OffscreenCanvasFactory,
      FilterFactory: NoFilterFactory,
      // No font faces to install without a document, and no need: the text is
      // drawn into the canvas by pdf.js itself.
      disableFontFace: true,
      isOffscreenCanvasSupported: true,
    });
    return { doc: await task.promise, close: () => task.destroy() };
  } catch (error) {
    throw translate(error);
  }
}

/** pdf.js reports both password cases through one exception with a code. */
function translate(error: unknown): Error {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'PasswordException') {
    const code = 'code' in error ? error.code : undefined;
    // 1 is NEED_PASSWORD, 2 is INCORRECT_PASSWORD.
    return code === 2 ? new WrongPasswordError() : new PasswordRequiredError();
  }
  return error instanceof Error ? new UnreadablePdfError(error.message) : new UnreadablePdfError();
}

export const pdfjsRasterizer: PdfRasterizer = {
  async rasterize(
    request: RasterizeRequest,
    onPage: (page: RenderedPage) => void | Promise<void>,
  ): Promise<void> {
    const { doc, close } = await open(request.bytes, request.password);
    const scale = scaleForDpi(request.dpi);
    const mime = MIME[request.format];

    try {
      for (const number of request.pages) {
        const page = await doc.getPage(number);
        const viewport = page.getViewport({ scale });
        // Whole pixels, and never zero: a 0.4 pt wide page exists in the
        // wild, and `new OffscreenCanvas(0, …)` throws.
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = new OffscreenCanvas(width, height);

        await page.render({
          // pdf.js types this as an HTMLCanvasElement; it reads width, height
          // and getContext from it, all of which an OffscreenCanvas has.
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
        }).promise;
        // The operator list and the decoded images for this page, which are
        // the bulk of the memory, go as soon as the page is drawn.
        page.cleanup();

        const blob = await canvas.convertToBlob({ type: mime, quality: request.quality / 100 });
        await onPage({
          page: number,
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime,
          width,
          height,
          // Measured only for a caller that will act on it: reading the
          // pixels back costs a copy of the page, and `pdf-to-images` hands
          // the person the image itself, where a blank one is visible.
          ...(request.measureInk === true ? { ink: hasInk(canvas, width, height) } : {}),
        });
      }
    } finally {
      await close();
    }
  },
};

/**
 * Whether the canvas has anything on it.
 *
 * pdf.js fills the page white before drawing, so "any pixel that is not white"
 * is the question, and an answer of "no" is the one that costs a person their
 * document — so it is the one that has to be exact.
 *
 * Every eighth row first, as an early exit for any page with a line of text on
 * it; if that finds nothing, every row, because by then the answer is about to
 * be used to refuse someone's file. Sampling within a row instead would be
 * cheaper and wrong: a hairline rule falls between the sampled columns and the
 * page would be called blank.
 */
function hasInk(canvas: OffscreenCanvas, width: number, height: number): boolean {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return true;

  for (let y = 0; y < height; y += 8) {
    if (rowHasInk(context, width, y, 1)) return true;
  }
  // Nothing in every eighth row. Read all of them before saying so.
  for (let y = 0; y < height; y += 64) {
    if (rowHasInk(context, width, y, Math.min(64, height - y))) return true;
  }
  return false;
}

function rowHasInk(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  y: number,
  rows: number,
): boolean {
  const { data } = context.getImageData(0, y, width, rows);
  for (let at = 0; at < data.length; at += 4) {
    // Anything appreciably off white, in any channel.
    if (data[at]! < 250 || data[at + 1]! < 250 || data[at + 2]! < 250) return true;
  }
  return false;
}

export const pdfjsTextReader: PdfTextReader = {
  async extract(request: TextRequest): Promise<string[]> {
    const { doc, close } = await open(request.bytes, request.password);
    try {
      const pages: string[] = [];
      for (const number of request.pages) {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          // Marked-content boundaries have no `str`; only text items do.
          if (!('str' in item)) continue;
          text += item.str;
          // pdf.js sets hasEOL where the layout ends a line. Without it the
          // whole page arrives as one run-on paragraph.
          if (item.hasEOL) text += '\n';
        }
        page.cleanup();
        pages.push(text);
      }
      return pages;
    } finally {
      await close();
    }
  },
};
