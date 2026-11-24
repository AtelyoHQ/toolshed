import { PdfOperationError } from './errors';

/**
 * The two things this engine cannot do over bytes alone, as injected ports.
 *
 * Rendering a page and reading its text layer mean running pdf.js, which needs
 * a canvas and a worker. Everything that *decides* — which pages, at what
 * resolution, whether the result is worth keeping — stays on this side of the
 * interface and is unit-tested in Node against a fake. The real
 * implementation, in `pdfjs.ts`, is covered by the end-to-end tests in a
 * browser, because that is the only place it can be.
 */

export type RasterFormat = 'jpeg' | 'png' | 'webp';

export interface RenderedPage {
  /** 1-based, so it matches what the person sees in a viewer. */
  page: number;
  bytes: Uint8Array;
  mime: string;
  /** Pixel size of the render, which the page size in points is derived from. */
  width: number;
  height: number;
  /**
   * Whether anything was actually drawn.
   *
   * The renderer is the only place this can be known, and it is the only
   * defence against the worst thing this engine can do. pdf.js degrades by
   * drawing nothing: a font it cannot translate becomes an error font whose
   * glyphs map to nothing, an image whose codec failed to load is skipped.
   * Rasterising compression would then produce a smaller file of empty pages
   * and report it as a saving, which is data loss presented as success.
   *
   * Absent when the renderer was not asked to measure, rather than `true`:
   * a caller that reads this without setting `measureInk` should find nothing
   * here, not an answer that happens to be the optimistic one.
   */
  ink?: boolean;
}

export interface RasterizeRequest {
  bytes: Uint8Array;
  password?: string;
  /** 1-based page numbers, ascending. */
  pages: readonly number[];
  dpi: number;
  format: RasterFormat;
  /** 1..100, ignored by PNG. */
  quality: number;
  /**
   * Report whether each page had anything drawn on it. Off by default: it
   * costs a read of the rendered pixels, and only the compressor acts on it.
   */
  measureInk?: boolean;
}

export interface PdfRasterizer {
  /**
   * Renders the requested pages, handing each to `onPage` as it finishes.
   *
   * A callback rather than an array: a 300-page scan at 200 dpi is gigabytes
   * of pixels, and the only way to stay inside a tab's memory is to let the
   * caller consume and release each page before the next is drawn.
   */
  rasterize(
    request: RasterizeRequest,
    onPage: (page: RenderedPage) => void | Promise<void>,
  ): Promise<void>;
}

export interface TextRequest {
  bytes: Uint8Array;
  password?: string;
  pages: readonly number[];
}

export interface PdfTextReader {
  /** One string per requested page, in the order requested. */
  extract(request: TextRequest): Promise<string[]>;
}

/**
 * Above this, a single page stops being an image and becomes a way to run a
 * tab out of memory: A4 at 1200 dpi is 140 megapixels, 560 MB of RGBA before
 * anything is encoded. 600 dpi is already beyond what any consumer printer
 * resolves.
 */
export const MAX_DPI = 600;
export const MIN_DPI = 12;

export function checkDpi(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new PdfOperationError(`Resolution must be between ${MIN_DPI} and ${MAX_DPI} dpi.`);
  }
  return dpi;
}

/** A PDF point is 1/72 inch, so this is the scale pdf.js renders at. */
export function scaleForDpi(dpi: number): number {
  return checkDpi(dpi) / 72;
}

/** Pixels back to points, for rebuilding a page around a render. */
export function pointsForPixels(pixels: number, dpi: number): number {
  return (pixels * 72) / dpi;
}
