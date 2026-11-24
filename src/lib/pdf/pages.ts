import { degrees, type PDFDocument } from '@cantoo/pdf-lib';
import {
  createDocument,
  loadDocument,
  requirePages,
  resultNote,
  saveDocument,
  type LoadOptions,
} from './document';
import { PageSelectionError, PdfOperationError } from './errors';
import {
  allPages,
  checkPageOrder,
  checkPages,
  spanLabel,
  spansForSplitPoints,
  toIndices,
} from './ranges';
import type { PdfPart, PdfResult, PdfSource } from './types';

/**
 * Page operations: merge, split, reorder, rotate, delete, extract.
 *
 * Two shapes of operation live here and the difference is worth knowing.
 *
 * Merge, split, extract and reorder build a **new** document and copy pages
 * into it.
 * That is the only way pdf-lib can move a page between documents, and it
 * copies the page and what it points at — its resources, fonts and
 * annotations — but not the document-level furniture: outlines, the form
 * field catalogue, attachments and named destinations do not come along.
 *
 * Rotate and delete work **in place** on the loaded document, so all of that
 * survives. Delete can therefore leave an outline entry pointing at a page
 * that is gone; readers treat such an entry as inert, which is a better
 * outcome than throwing the whole outline away.
 */

/** Turns several documents into one, in the order given. */
export async function mergeDocuments(sources: readonly PdfSource[]): Promise<PdfResult> {
  if (sources.length === 0) throw new PdfOperationError('No documents were given to merge.');

  const merged = await createDocument();
  // A source that needed a password contributes its pages to a document that
  // needs none, which the note has to say.
  let unlocked: string | undefined;
  for (const source of sources) {
    const doc = await loadDocument(source.bytes, { password: source.password });
    requirePages(doc);
    unlocked ??= resultNote(doc);
    await copyAll(merged, doc);
  }

  const bytes = await saveDocument(merged);
  return { bytes, pages: merged.getPageCount(), ...(unlocked ? { note: unlocked } : {}) };
}

export type SplitMode =
  /** One document per page. */
  | { mode: 'pages' }
  /**
   * Split after each of these page numbers: `[3]` over ten pages gives 1-3
   * and 4-10.
   */
  | { mode: 'after'; points: readonly number[] };

export async function splitDocument(
  bytes: Uint8Array,
  options: SplitMode & LoadOptions,
): Promise<PdfPart[]> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);

  const spans: Array<[number, number]> =
    options.mode === 'pages'
      ? allPages(pageCount).map((page) => [page, page])
      : spansForSplitPoints(options.points, pageCount);

  const parts: PdfPart[] = [];
  for (const span of spans) {
    const part = await createDocument();
    const pages = [];
    for (let page = span[0]; page <= span[1]; page++) pages.push(page);
    await copySome(part, doc, toIndices(pages));
    const note = resultNote(doc);
    parts.push({
      bytes: await saveDocument(part),
      pages: part.getPageCount(),
      label: spanLabel(span),
      firstPage: span[0],
      lastPage: span[1],
      ...(note ? { note } : {}),
    });
  }
  return parts;
}

/**
 * Rearranges the pages. `order` lists every page number exactly once.
 *
 * Copied into a new document rather than reordered in place. Detaching every
 * leaf from the page tree and re-attaching it is the obvious implementation
 * and it does not work: pdf-lib leaves the tree's `Count` entries behind and
 * the second insertion fails with "corrupt page tree" (verified against
 * 2.11). Rebuilding costs the document-level furniture, as the note above
 * says, and is the only reliable way to do this with this library.
 */
export async function reorderPages(
  bytes: Uint8Array,
  order: readonly number[],
  options: LoadOptions = {},
): Promise<PdfResult> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const wanted = checkPageOrder(order, pageCount);

  const reordered = await createDocument();
  await copySome(reordered, doc, toIndices(wanted));

  const note = resultNote(doc);
  return {
    bytes: await saveDocument(reordered),
    pages: reordered.getPageCount(),
    ...(note ? { note } : {}),
  };
}

export interface RotateOptions extends LoadOptions {
  /** Clockwise quarter turns. Negative turns anticlockwise. */
  turn: number;
  /** 1-based page numbers; every page when omitted. */
  pages?: readonly number[];
}

/**
 * Turns pages, relative to how they already sit.
 *
 * Relative rather than absolute: a page that a scanner already marked as 90°
 * and that the person turns once more belongs at 180°, and setting the
 * rotation outright would instead undo the scanner's correction.
 */
export async function rotatePages(bytes: Uint8Array, options: RotateOptions): Promise<PdfResult> {
  if (options.turn % 90 !== 0) {
    throw new PdfOperationError('Pages can only be turned in quarter turns.');
  }

  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const pages = checkPages(options.pages ?? allPages(pageCount), pageCount);

  for (const number of pages) {
    const page = doc.getPage(number - 1);
    page.setRotation(degrees(normaliseAngle(page.getRotation().angle + options.turn)));
  }

  const note = resultNote(doc);
  return { bytes: await saveDocument(doc), pages: doc.getPageCount(), ...(note ? { note } : {}) };
}

/** 0, 90, 180 or 270: the only values the PDF `/Rotate` entry may take. */
export function normaliseAngle(angle: number): number {
  const wrapped = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return wrapped;
}

export async function deletePages(
  bytes: Uint8Array,
  pages: readonly number[],
  options: LoadOptions = {},
): Promise<PdfResult> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const doomed = checkPages(pages, pageCount);

  if (doomed.length === pageCount) {
    throw new PageSelectionError('That would delete every page; a PDF needs at least one.');
  }

  // Highest first: removing page 2 renumbers everything after it, so a
  // low-to-high walk deletes the wrong pages from the second one onwards.
  for (const number of [...doomed].reverse()) doc.removePage(number - 1);

  const note = resultNote(doc);
  return { bytes: await saveDocument(doc), pages: doc.getPageCount(), ...(note ? { note } : {}) };
}

/**
 * Keeps the selected pages, in ascending order, and drops the rest.
 *
 * A page named twice still appears once: this is "keep these pages", not
 * "assemble this sequence", and duplicating a page is the reordering tool's
 * job.
 */
export async function extractPages(
  bytes: Uint8Array,
  pages: readonly number[],
  options: LoadOptions = {},
): Promise<PdfResult> {
  const doc = await loadDocument(bytes, options);
  const pageCount = requirePages(doc);
  const wanted = checkPages(pages, pageCount);

  const extracted = await createDocument();
  await copySome(extracted, doc, toIndices(wanted));

  const note = resultNote(doc);
  return {
    bytes: await saveDocument(extracted),
    pages: extracted.getPageCount(),
    ...(note ? { note } : {}),
  };
}

async function copyAll(target: PDFDocument, source: PDFDocument): Promise<void> {
  await copySome(target, source, source.getPageIndices());
}

async function copySome(
  target: PDFDocument,
  source: PDFDocument,
  indices: readonly number[],
): Promise<void> {
  const copied = await target.copyPages(source, [...indices]);
  for (const page of copied) target.addPage(page);
}
