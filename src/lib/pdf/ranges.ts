import { PageSelectionError } from './errors';

/**
 * Page selections, as typed by a person.
 *
 * Everything in this file works in **1-based page numbers**, the way the
 * interface and the person both talk about pages, and converts to 0-based
 * indices only at the boundary with pdf-lib. Mixing the two conventions in one
 * function is the classic way these tools delete the wrong page.
 */

/** `1`, `4-7`, `9-` (to the end), in any comma- or space-separated mixture. */
const TERM = /^(\d+)(?:-(\d+)?)?$/;

/**
 * Parses a selection such as `1,4-7,9-` into sorted, unique page numbers.
 *
 * An empty selection is an error rather than "no pages": every operation that
 * takes one does something destructive, and silently applying it to nothing
 * looks to the person like the tool ignored them.
 */
export function parsePageSelection(spec: string, pageCount: number): number[] {
  if (pageCount < 1) throw new PageSelectionError('This document has no pages.');

  const trimmed = spec.trim();
  if (trimmed === '') throw new PageSelectionError('No pages were selected.');
  if (/^all$/i.test(trimmed)) return allPages(pageCount);

  const pages = new Set<number>();
  // Spaces around a hyphen are closed up before the terms are split apart, or
  // "4 - 7" would be read as three terms and rejected.
  for (const term of trimmed.replace(/\s*-\s*/g, '-').split(/[,\s]+/)) {
    const match = TERM.exec(term);
    if (!match) {
      throw new PageSelectionError(
        `"${term}" is not a page or a range. Use something like 1, 4-7, 9-.`,
      );
    }

    const from = Number(match[1]);
    // `4-` is open-ended; `4` on its own is a single page, not a range to the
    // end, so the two cases cannot share a default.
    const to = match[2] !== undefined ? Number(match[2]) : term.includes('-') ? pageCount : from;

    assertInDocument(from, pageCount);
    assertInDocument(to, pageCount);
    if (to < from) {
      throw new PageSelectionError(`Page range ${from}-${to} ends before it starts.`);
    }
    for (let page = from; page <= to; page++) pages.add(page);
  }

  return [...pages].sort((a, b) => a - b);
}

export function allPages(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_unused, index) => index + 1);
}

/** 1-based page numbers to the 0-based indices pdf-lib wants. */
export function toIndices(pages: readonly number[]): number[] {
  return pages.map((page) => page - 1);
}

function assertInDocument(page: number, pageCount: number): void {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new PageSelectionError(
      `This document has ${pageCount} page${pageCount === 1 ? '' : 's'}, so page ${page} does not exist.`,
    );
  }
}

/**
 * Validates a list of pages against a document, returning it sorted and unique.
 *
 * Used by the operations that take pages directly rather than as typed text.
 */
export function checkPages(pages: readonly number[], pageCount: number): number[] {
  if (pages.length === 0) throw new PageSelectionError('No pages were selected.');
  for (const page of pages) assertInDocument(page, pageCount);
  return [...new Set(pages)].sort((a, b) => a - b);
}

/**
 * Validates a new page order: every page of the document exactly once.
 *
 * A partial order would be ambiguous — is the rest dropped, or appended? —
 * and both readings lose pages, so neither is worth guessing at.
 */
export function checkPageOrder(order: readonly number[], pageCount: number): number[] {
  if (order.length !== pageCount) {
    throw new PageSelectionError(
      `A new order must list all ${pageCount} pages; ${order.length} were given.`,
    );
  }
  const seen = new Set<number>();
  for (const page of order) {
    assertInDocument(page, pageCount);
    if (seen.has(page)) throw new PageSelectionError(`Page ${page} appears twice in the order.`);
    seen.add(page);
  }
  return [...order];
}

/**
 * Turns split points into page spans.
 *
 * A point is the page a new document starts *after*: `[3]` over 10 pages gives
 * 1-3 and 4-10. A point on the last page would produce an empty final
 * document, so it is rejected rather than quietly dropped — a person who typed
 * it meant something, and it was not "no split at all".
 */
export function spansForSplitPoints(
  points: readonly number[],
  pageCount: number,
): Array<[number, number]> {
  if (pageCount < 1) throw new PageSelectionError('This document has no pages.');
  if (points.length === 0) throw new PageSelectionError('No split points were given.');

  const sorted = [...new Set(points)].sort((a, b) => a - b);
  for (const point of sorted) {
    if (!Number.isInteger(point) || point < 1 || point >= pageCount) {
      throw new PageSelectionError(
        `A split point must be between 1 and ${pageCount - 1}; ${point} is not.`,
      );
    }
  }

  const spans: Array<[number, number]> = [];
  let start = 1;
  for (const point of sorted) {
    spans.push([start, point]);
    start = point + 1;
  }
  spans.push([start, pageCount]);
  return spans;
}

/** `4` for a single page, `4-7` for a span: the label a file name uses. */
export function spanLabel([from, to]: readonly [number, number]): string {
  return from === to ? `${from}` : `${from}-${to}`;
}
