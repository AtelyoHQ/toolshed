import {
  degrees,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
  type PDFPageDrawTextOptions,
} from '@cantoo/pdf-lib';
import { loadDocument, requirePages, resultNote, saveDocument, type LoadOptions } from './document';
import { PdfOperationError } from './errors';
import { normaliseAngle } from './pages';
import { allPages, checkPages } from './ranges';
import type { PdfResult } from './types';

/**
 * Text stamped onto pages: watermarks and page numbers.
 *
 * Both draw with one of the fourteen fonts every PDF reader is required to
 * have, so nothing is embedded and the file grows by a few hundred bytes
 * rather than by a font. The cost is the character set: those fonts are
 * Latin-1, and text outside it cannot be written this way at all — which is
 * refused here, loudly, because the library's own answer is to substitute a
 * question mark per character and stamp that on every page.
 */

export type Placement =
  | 'center'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface Box {
  width: number;
  height: number;
}

/**
 * Where a piece of text goes, as the bottom-left corner of its box.
 *
 * In points from the bottom-left of the page, which is the PDF coordinate
 * system: `y` grows upwards, so a "top" placement is the *largest* y, and
 * getting that backwards puts the page number off the bottom of the page.
 */
export function placeText(
  placement: Placement,
  page: Box,
  text: Box,
  margin: number,
): { x: number; y: number } {
  const left = margin;
  const centre = (page.width - text.width) / 2;
  const right = page.width - text.width - margin;
  const bottom = margin;
  const middle = (page.height - text.height) / 2;
  const top = page.height - text.height - margin;

  switch (placement) {
    case 'center':
      return { x: centre, y: middle };
    case 'top-left':
      return { x: left, y: top };
    case 'top-center':
      return { x: centre, y: top };
    case 'top-right':
      return { x: right, y: top };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-center':
      return { x: centre, y: bottom };
    case 'bottom-right':
      return { x: right, y: bottom };
  }
}

/**
 * The page as a reader sees it.
 *
 * A page carries a `/Rotate` entry that every viewer applies before showing
 * it, so a 300 by 600 page marked 90 is displayed 600 wide and 300 tall. Any
 * scan from a phone or an office machine has this set, and so does anything
 * this engine's own rotate tool has produced.
 */
export function displayedBox(page: Box, rotation: number): Box {
  return rotation % 180 === 0
    ? { width: page.width, height: page.height }
    : { width: page.height, height: page.width };
}

/**
 * A point in the displayed page, converted to the coordinates content is
 * drawn in.
 *
 * Stamps are placed where the reader will see them — "bottom centre" means the
 * bottom of the page as displayed — and then moved into page space, because
 * that is what `drawText` takes. Skip this and a watermark on a rotated scan
 * comes out along a side edge, turned on its side, centred against the wrong
 * axis.
 */
export function toPageSpace(
  point: { x: number; y: number },
  page: Box,
  rotation: number,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: page.width - point.y, y: point.x };
    case 180:
      return { x: page.width - point.x, y: page.height - point.y };
    case 270:
      return { x: point.y, y: page.height - point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/**
 * The anchor that puts the *centre* of a rotated string at a given point.
 *
 * pdf-lib rotates text about the point it is drawn from, not about its middle,
 * so a 45° watermark asked for "centre" would otherwise hang off the
 * top-right corner. Rotating the half-extent vector and subtracting it is the
 * whole correction.
 */
export function rotatedAnchor(
  centre: { x: number; y: number },
  text: Box,
  rotation: number,
): { x: number; y: number } {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = text.width / 2;
  const halfHeight = text.height / 2;
  return {
    x: centre.x - (halfWidth * cos - halfHeight * sin),
    y: centre.y - (halfWidth * sin + halfHeight * cos),
  };
}

export interface WatermarkOptions extends LoadOptions {
  text: string;
  /** 0..1. Default 0.15, which reads as a watermark rather than a redaction. */
  opacity?: number;
  /** Degrees anticlockwise. Default 45, the diagonal people expect. */
  rotation?: number;
  placement?: Placement;
  /** Points. Default is a twelfth of the page's shorter side. */
  fontSize?: number;
  /** 0..255 per channel. Default mid-grey, which works on white and on dark. */
  color?: readonly [number, number, number];
  margin?: number;
  /** 1-based page numbers; every page when omitted. */
  pages?: readonly number[];
}

export async function watermarkPdf(
  bytes: Uint8Array,
  options: WatermarkOptions,
): Promise<PdfResult> {
  if (options.text.trim() === '') throw new PdfOperationError('A watermark needs some text.');
  assertWritable(options.text);
  const opacity = options.opacity ?? 0.15;
  if (opacity <= 0 || opacity > 1) {
    throw new PdfOperationError('Opacity must be greater than 0 and at most 1.');
  }

  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const pages = checkPages(options.pages ?? allPages(pageCount), pageCount);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rotation = options.rotation ?? 45;
  const margin = options.margin ?? 24;
  const [red, green, blue] = options.color ?? [128, 128, 128];

  for (const number of pages) {
    const page = doc.getPage(number - 1);
    // The crop box, not the page size: `getSize` reports the media box's
    // dimensions and nothing about where it starts, and a cropped scan or
    // anything through pdfcrop has a box that begins at [100 100] or is a
    // sub-rectangle of the sheet. Placing against the size alone puts the
    // stamp off the visible page.
    const box = page.getCropBox();
    // Placed in the page as the reader sees it, then moved into the
    // coordinates content is drawn in; `/Rotate` is why those differ.
    const turn = normaliseAngle(page.getRotation().angle);
    const displayed = displayedBox(box, turn);
    const size = options.fontSize ?? Math.min(displayed.width, displayed.height) / 12;
    const text = measure(font, options.text, size);

    const placement = options.placement ?? 'center';
    // The upright box is placed first and then rotated about its own centre,
    // so a corner placement keeps its margin whatever the rotation.
    const upright = placeText(placement, displayed, text, margin);
    const centre = { x: upright.x + text.width / 2, y: upright.y + text.height / 2 };
    const anchor = inBox(toPageSpace(rotatedAnchor(centre, text, rotation), box, turn), box);

    draw(page, options.text, {
      ...anchor,
      font,
      size,
      opacity,
      rotate: degrees(rotation + turn),
      color: rgb(red / 255, green / 255, blue / 255),
    });
  }

  const note = resultNote(
    doc,
    `Stamped ${pages.length} of ${pageCount} page${pageCount === 1 ? '' : 's'}.`,
  );
  return { bytes: await saveDocument(doc), pages: pageCount, note };
}

export interface PageNumberOptions extends LoadOptions {
  placement?: Exclude<Placement, 'center'>;
  /**
   * The number printed on the first stamped page. A document whose first two
   * pages are a cover and a contents page is numbered from 1 at page 3 by
   * stamping pages 3- and starting at 1; a second volume continuing from the
   * first starts at 97.
   */
  startAt?: number;
  /** `{page}` and `{total}` are substituted. Default `{page}`. */
  template?: string;
  fontSize?: number;
  margin?: number;
  color?: readonly [number, number, number];
  /** 1-based page numbers; every page when omitted. */
  pages?: readonly number[];
}

export function formatPageNumber(template: string, page: number, total: number): string {
  return template.replaceAll('{page}', String(page)).replaceAll('{total}', String(total));
}

export async function numberPages(
  bytes: Uint8Array,
  options: PageNumberOptions = {},
): Promise<PdfResult> {
  const startAt = options.startAt ?? 1;
  if (!Number.isInteger(startAt)) {
    throw new PdfOperationError('A starting page number must be a whole number.');
  }
  assertWritable(options.template ?? '');

  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const pages = checkPages(options.pages ?? allPages(pageCount), pageCount);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const size = options.fontSize ?? 10;
  const margin = options.margin ?? 24;
  const template = options.template ?? '{page}';
  const placement = options.placement ?? 'bottom-center';
  const [red, green, blue] = options.color ?? [0, 0, 0];
  // `{total}` is the highest number this run will stamp, not the document's
  // page count: on pages 3-10 numbered from 1 that is 8, so the first page
  // reads "1 / 8" rather than "1 / 10"; numbered from 97 it is 98, and
  // "97 / 98" is what a reader expects to see.
  const total = pages.length;

  for (const [index, number] of pages.entries()) {
    const page = doc.getPage(number - 1);
    const label = formatPageNumber(template, startAt + index, total + startAt - 1);
    const text = measure(font, label, size);
    // See the watermark: the crop box, because its origin is not always the
    // origin of user space.
    const box = page.getCropBox();
    // The bottom of the page means the bottom as displayed, which on a
    // rotated scan is not the bottom of the box.
    const turn = normaliseAngle(page.getRotation().angle);
    const at = inBox(
      toPageSpace(placeText(placement, displayedBox(box, turn), text, margin), box, turn),
      box,
    );

    draw(page, label, {
      ...at,
      font,
      size,
      rotate: degrees(turn),
      color: rgb(red / 255, green / 255, blue / 255),
    });
  }

  const note = resultNote(
    doc,
    `Numbered ${pages.length} page${pages.length === 1 ? '' : 's'} from ${startAt}.`,
  );
  return { bytes: await saveDocument(doc), pages: pageCount, note };
}

/**
 * Moves a point from inside the box to the user space content is drawn in.
 *
 * A box that starts at the origin makes this a no-op, which is most documents
 * and is why it is easy to forget.
 */
function inBox(
  point: { x: number; y: number },
  box: { x: number; y: number },
): {
  x: number;
  y: number;
} {
  return { x: point.x + box.x, y: point.y + box.y };
}

function measure(font: PDFFont, text: string, size: number): Box {
  return { width: font.widthOfTextAtSize(text, size), height: font.heightAtSize(size) };
}

function draw(page: PDFPage, text: string, options: PDFPageDrawTextOptions): void {
  page.drawText(text, options);
}

/**
 * The typographic characters WinAnsi adds above Latin-1: curly quotes, the
 * dashes, the euro sign and the rest of the 0x80..0x9F block.
 */
const WIN_ANSI_EXTRAS = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);

/**
 * Refuses text the built-in fonts cannot write.
 *
 * Checked rather than left to pdf-lib, which does not fail: it replaces every
 * character it cannot encode with a question mark, so a Cyrillic watermark is
 * stamped onto all 200 pages as `????????` and the person finds out when they
 * open the result. Writing that text properly needs an embedded font, which is
 * a feature, not a fix for this.
 */
function assertWritable(text: string): void {
  const unsupported = [
    ...new Set(
      [...text].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
        if (code >= 0x20 && code <= 0x7e) return false;
        if (code >= 0xa0 && code <= 0xff) return false;
        return !WIN_ANSI_EXTRAS.has(character);
      }),
    ),
  ];

  if (unsupported.length > 0) {
    throw new PdfOperationError(
      `The built-in PDF fonts cannot write ${unsupported.map((character) => `"${character}"`).join(', ')}. ` +
        'They cover Western European text only.',
    );
  }
}
