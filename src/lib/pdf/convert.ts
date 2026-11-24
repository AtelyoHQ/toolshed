import { isJpeg, isPng, stripMetadata } from '../image/metadata';
import {
  createDocument,
  loadDocument,
  requirePages,
  saveDocument,
  type LoadOptions,
} from './document';
import { PdfOperationError } from './errors';
import { allPages, checkPages } from './ranges';
import {
  checkDpi,
  pointsForPixels,
  type PdfRasterizer,
  type PdfTextReader,
  type RasterFormat,
  type RenderedPage,
} from './render';
import type { PdfResult } from './types';

/** Images to PDF, PDF to images, PDF to plain text. */

export interface ImageInput {
  bytes: Uint8Array;
  /** Only used in error messages, so a person knows which file was refused. */
  name?: string;
}

export type PageSizing =
  /**
   * Each page is cut to its own image. Nothing is scaled and nothing is
   * cropped, which is what people expect when they turn photos or scans into
   * a PDF that is not going to be printed.
   */
  | { mode: 'image' }
  /**
   * A fixed page size in points, with the image fitted into it. `contain`
   * keeps all of the image and leaves margins; `cover` fills the page and
   * loses what hangs over the edge.
   */
  | { mode: 'fixed'; width: number; height: number; fit: 'contain' | 'cover' };

export interface ImagesToPdfOptions {
  sizing: PageSizing;
  /** Points of clear space on every side. */
  margin?: number;
  /**
   * Pixels per inch to read the images at, for `image` sizing. 72 makes one
   * pixel one point; 96 matches what a screenshot "means"; 300 gives a page
   * the size the image would print at.
   */
  dpi?: number;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where an image sits on a page, in PDF points from the bottom-left corner.
 *
 * Pure arithmetic, kept separate from the drawing so the cases that are easy
 * to get wrong — a portrait image on a landscape page, a margin wider than
 * the page — can be asserted on directly.
 */
export function placeImage(
  image: { width: number; height: number },
  page: { width: number; height: number },
  fit: 'contain' | 'cover',
  margin: number,
): Placement {
  const boxWidth = page.width - margin * 2;
  const boxHeight = page.height - margin * 2;
  if (boxWidth <= 0 || boxHeight <= 0) {
    throw new PdfOperationError('The margin leaves no room on the page for the image.');
  }

  const scaleX = boxWidth / image.width;
  const scaleY = boxHeight / image.height;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const width = image.width * scale;
  const height = image.height * scale;
  return {
    // Centred in the box rather than in the page: with an asymmetric margin
    // the two differ, and "centred" has to mean inside the space the person
    // left for the image.
    x: margin + (boxWidth - width) / 2,
    y: margin + (boxHeight - height) / 2,
    width,
    height,
  };
}

export async function imagesToPdf(
  images: readonly ImageInput[],
  options: ImagesToPdfOptions,
): Promise<PdfResult> {
  if (images.length === 0) throw new PdfOperationError('No images were given.');

  const margin = options.margin ?? 0;
  if (margin < 0) throw new PdfOperationError('A margin cannot be negative.');
  const dpi = checkDpi(options.dpi ?? 72);

  const doc = await createDocument();
  for (const [index, input] of images.entries()) {
    const label = input.name ?? `image ${index + 1}`;
    // The EXIF goes before the image does. These inputs are camera files —
    // turning holiday photographs into one PDF is what this operation is for —
    // and a JPEG's APP1 segment carries the GPS coordinates, the timestamp and
    // the device serial. They would otherwise be embedded in the PDF whole,
    // which would make this the one tool here that publishes what the image
    // engine exists to remove. The segment walk does not touch the compressed
    // image data, so this costs no quality.
    const bytes = stripMetadata(input.bytes);
    // pdf-lib can embed JPEG and PNG; everything else has to be converted by
    // the image engine first. Sniffed rather than trusted from the file name,
    // which is routinely wrong for files that have been through a phone.
    const embedded = isJpeg(bytes)
      ? await doc.embedJpg(bytes)
      : isPng(bytes)
        ? await doc.embedPng(bytes)
        : null;
    if (!embedded) {
      throw new PdfOperationError(
        `${label} is not a JPEG or PNG. Convert it to one of those first.`,
      );
    }

    if (options.sizing.mode === 'image') {
      const width = pointsForPixels(embedded.width, dpi);
      const height = pointsForPixels(embedded.height, dpi);
      const page = doc.addPage([width + margin * 2, height + margin * 2]);
      page.drawImage(embedded, { x: margin, y: margin, width, height });
    } else {
      const { width, height, fit } = options.sizing;
      if (width <= 0 || height <= 0) throw new PdfOperationError('A page cannot have no size.');
      const page = doc.addPage([width, height]);
      page.drawImage(embedded, placeImage(embedded, { width, height }, fit, margin));
    }
  }

  return { bytes: await saveDocument(doc), pages: doc.getPageCount() };
}

export interface PdfToImagesOptions extends LoadOptions {
  dpi: number;
  format: RasterFormat;
  /** 1..100. Ignored for PNG, which is lossless. */
  quality?: number;
  /** 1-based page numbers; every page when omitted. */
  pages?: readonly number[];
}

/**
 * Renders pages to images.
 *
 * The page count and the selection are checked through pdf-lib before pdf.js
 * is asked for anything: it reads the structure without decoding content, so a
 * selection that names page 40 of a 12-page document fails in milliseconds
 * with a sentence about the document, rather than part-way through a render.
 */
export async function pdfToImages(
  bytes: Uint8Array,
  options: PdfToImagesOptions,
  rasterizer: PdfRasterizer,
  onProgress?: (fraction: number) => void,
): Promise<RenderedPage[]> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const pages = checkPages(options.pages ?? allPages(pageCount), pageCount);

  // Collected rather than streamed: the port hands pages over one at a time so
  // that the compressor can build a document without holding all of them, but
  // this operation's whole output *is* the set of images, and its caller wants
  // a file per page.
  const rendered: RenderedPage[] = [];
  await rasterizer.rasterize(
    {
      bytes,
      password: options.password,
      pages,
      dpi: checkDpi(options.dpi),
      format: options.format,
      quality: options.quality ?? 80,
    },
    (page) => {
      rendered.push(page);
      onProgress?.(rendered.length / pages.length);
    },
  );
  return rendered;
}

export interface PdfToTextOptions extends LoadOptions {
  pages?: readonly number[];
}

export interface PdfTextResult {
  text: string;
  /** How many pages were read, which a selection makes fewer than the document has. */
  pages: number;
  /** Set when the document rendered no characters at all. */
  note?: string;
}

/**
 * Extracts the text layer.
 *
 * Pages are separated by a blank line. A document whose text layer yields
 * nothing comes back empty, and that is reported rather than returned as an
 * empty file, because an empty file looks like a bug. What the note may not do
 * is name a cause: a scan and a font that failed to load are indistinguishable
 * from here, and the second one is a bug this engine has already had.
 */
export async function pdfToText(
  bytes: Uint8Array,
  options: PdfToTextOptions,
  reader: PdfTextReader,
): Promise<PdfTextResult> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const pages = checkPages(options.pages ?? allPages(pageCount), pageCount);

  const perPage = await reader.extract({ bytes, password: options.password, pages });
  const text = perPage.map((page) => page.trimEnd()).join('\n\n');

  return {
    text,
    pages: pages.length,
    ...(text.trim() === ''
      ? {
          // Deliberately not "this is a scan". An empty extraction says the
          // text layer yielded nothing, and a font that failed to load
          // yields nothing in exactly the same way — which is how the
          // character maps came to be bundled. Naming a cause this code
          // cannot see is how a CJK document gets called a photograph.
          note: 'No text layer was found. A scanned document would need character recognition, which Toolshed does not do; a document that should have text may have had a font fail to load.',
        }
      : {}),
  };
}
