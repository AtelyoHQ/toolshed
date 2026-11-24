import { loadDocument, requirePages, type LoadOptions } from './document';
import { PageSelectionError, PdfOperationError } from './errors';
import { allPages, parsePageSelection } from './ranges';
import { runPdfJob, type PdfJob, type PdfJobDeps, type PdfJobResult } from './jobs';

/**
 * Page selections as a person types them, resolved against the document.
 *
 * The interface cannot turn "3-" or "reverse" into page numbers: it has not
 * read the file, and reading it there would put pdf-lib on the main thread.
 * The worker has the bytes, so the selection travels beside the job and is
 * resolved here, immediately before the engine runs it.
 */
export type PageSelection =
  /** `1, 4-7, 9-`, or `all`. Blank means every page where the operation allows that. */
  | { kind: 'pages'; text: string }
  /**
   * A complete new order, in the order typed: `5, 1-4, 6-`. Unlike `pages` this
   * is not sorted, which is the whole point of it.
   */
  | { kind: 'order'; text: string }
  | { kind: 'reverse' }
  /** Split into pieces of this many pages. */
  | { kind: 'every'; count: number };

/** Operations that act on every page when given no selection. */
const DEFAULTS_TO_ALL = new Set<PdfJob['op']>([
  'rotate',
  'watermark',
  'page-numbers',
  'pdf-to-images',
  'pdf-to-text',
]);

export function resolveSelection(job: PdfJob, selection: PageSelection, pageCount: number): PdfJob {
  switch (selection.kind) {
    case 'pages': {
      if (selection.text.trim() === '' && DEFAULTS_TO_ALL.has(job.op)) return job;
      return withPages(job, parsePageSelection(selection.text, pageCount));
    }

    case 'order': {
      if (job.op !== 'reorder') throw notForThis(job, 'a new page order');
      return { ...job, order: parseSequence(selection.text, pageCount) };
    }

    case 'reverse': {
      if (job.op !== 'reorder') throw notForThis(job, 'reversing the pages');
      return { ...job, order: allPages(pageCount).reverse() };
    }

    case 'every': {
      if (job.op !== 'split') throw notForThis(job, 'splitting every few pages');
      const { count } = selection;
      if (!Number.isInteger(count) || count < 1) {
        throw new PageSelectionError('Pieces must be a whole number of pages, at least 1.');
      }
      // A piece the size of the document, or larger, is not a split: refused
      // rather than answered with one copy of the file that looks like a
      // success.
      if (count >= pageCount) {
        throw new PageSelectionError(
          `This document has ${pageCount} page${pageCount === 1 ? '' : 's'}, so pieces of ${count} would leave it in one piece.`,
        );
      }
      const points: number[] = [];
      for (let point = count; point < pageCount; point += count) points.push(point);
      return { ...job, options: { ...job.options, mode: 'after', points } };
    }
  }
}

function withPages(job: PdfJob, pages: number[]): PdfJob {
  switch (job.op) {
    case 'delete':
    case 'extract':
      return { ...job, pages };
    case 'rotate':
    case 'watermark':
    case 'page-numbers':
    case 'pdf-to-images':
    case 'pdf-to-text':
      return { ...job, options: { ...job.options, pages } } as PdfJob;
    default:
      throw notForThis(job, 'a page selection');
  }
}

/**
 * `5, 1-4, 6-` as the pages it lists, in that order.
 *
 * Each term goes through the engine's own parser, so what counts as a page or
 * a range is defined in one place; only the joining differs, because that
 * parser sorts and this must not. A page named twice is kept, so that the
 * order check downstream names it rather than this dropping it quietly.
 */
export function parseSequence(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (trimmed === '') throw new PageSelectionError('Type the new order of the pages.');

  const terms = trimmed.replace(/\s*-\s*/g, '-').split(/[,\s]+/);
  return terms.flatMap((term) => parsePageSelection(term, pageCount));
}

function notForThis(job: PdfJob, what: string): PdfOperationError {
  return new PdfOperationError(`"${job.op}" does not take ${what}.`);
}

/**
 * What the worker runs: a job, plus a selection to resolve first.
 *
 * The document is opened once here only to count its pages, which costs a
 * second parse. It is paid only when there is a selection to resolve, and it
 * is also what makes a missing or wrong password fail before any work starts.
 */
export async function runPdfRequest(
  job: PdfJob,
  selection: PageSelection | undefined,
  deps: PdfJobDeps,
  onProgress?: (fraction: number) => void,
): Promise<PdfJobResult> {
  if (!selection) return runPdfJob(job, deps, onProgress);

  if (job.op === 'merge' || job.op === 'images-to-pdf') {
    throw notForThis(job, 'a page selection');
  }
  const options = (job as { options?: LoadOptions }).options;
  const doc = await loadDocument(job.bytes, { password: options?.password });
  const pageCount = requirePages(doc);

  return runPdfJob(resolveSelection(job, selection, pageCount), deps, onProgress);
}
