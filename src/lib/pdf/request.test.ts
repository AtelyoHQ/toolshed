import { describe, expect, it } from 'vitest';
import { buildEncryptedPdf, buildPdf } from '../../../test/pdfFixtures';
import { loadDocument } from './document';
import { PasswordRequiredError } from './errors';
import type { PdfJob, PdfJobDeps } from './jobs';
import { parseSequence, resolveSelection, runPdfRequest } from './request';

/** Selections never reach a renderer, so the ports are never called. */
const deps = {} as PdfJobDeps;

/** Pages are labelled by width, which survives every operation under test. */
async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await loadDocument(bytes);
  return doc.getPages().map((page) => page.getSize().width);
}

const fivePages = () =>
  buildPdf([101, 102, 103, 104, 105].map((width) => ({ width, height: 200 })));

describe('parseSequence', () => {
  it('keeps the order typed rather than sorting it', () => {
    expect(parseSequence('5, 1-3, 4', 5)).toEqual([5, 1, 2, 3, 4]);
  });

  it('expands an open-ended range against the document', () => {
    expect(parseSequence('3, 1-2, 4-', 6)).toEqual([3, 1, 2, 4, 5, 6]);
  });

  it('keeps a page named twice, so that the order check can name it', () => {
    expect(parseSequence('1, 1, 2', 3)).toEqual([1, 1, 2]);
  });

  it('refuses an empty order rather than reading it as no change', () => {
    expect(() => parseSequence('  ', 3)).toThrow(/new order/i);
  });

  it('reports a page the document does not have', () => {
    expect(() => parseSequence('1, 9', 3)).toThrow(/3 pages, so page 9 does not exist/);
  });
});

describe('resolveSelection', () => {
  const bytes = new Uint8Array();

  it('turns a typed range into the pages a delete takes', () => {
    const job: PdfJob = { op: 'delete', bytes, pages: [] };
    expect(resolveSelection(job, { kind: 'pages', text: '2, 4-' }, 5)).toMatchObject({
      pages: [2, 4, 5],
    });
  });

  it('leaves a blank selection alone where every page is the default', () => {
    const job: PdfJob = { op: 'rotate', bytes, options: { turn: 90 } };
    expect(resolveSelection(job, { kind: 'pages', text: '' }, 5)).toBe(job);
  });

  it('refuses a blank selection where acting on every page would be a surprise', () => {
    // Deleting or extracting "nothing" must not quietly become "everything".
    expect(() =>
      resolveSelection({ op: 'delete', bytes, pages: [] }, { kind: 'pages', text: '' }, 5),
    ).toThrow(/no pages were selected/i);
    expect(() =>
      resolveSelection({ op: 'extract', bytes, pages: [] }, { kind: 'pages', text: ' ' }, 5),
    ).toThrow(/no pages were selected/i);
  });

  it('keeps the options a job already had when it adds the pages', () => {
    const job: PdfJob = { op: 'rotate', bytes, options: { turn: 270, password: 'x' } };
    expect(resolveSelection(job, { kind: 'pages', text: '1' }, 3)).toMatchObject({
      options: { turn: 270, password: 'x', pages: [1] },
    });
  });

  it('reverses a document of any length', () => {
    const job: PdfJob = { op: 'reorder', bytes, order: [] };
    expect(resolveSelection(job, { kind: 'reverse' }, 4)).toMatchObject({ order: [4, 3, 2, 1] });
  });

  it('splits every few pages at the right boundaries', () => {
    const job: PdfJob = { op: 'split', bytes, options: { mode: 'pages' } };
    expect(resolveSelection(job, { kind: 'every', count: 3 }, 10)).toMatchObject({
      options: { mode: 'after', points: [3, 6, 9] },
    });
  });

  it('does not leave an empty last piece when the length is a multiple', () => {
    const job: PdfJob = { op: 'split', bytes, options: { mode: 'pages' } };
    expect(resolveSelection(job, { kind: 'every', count: 2 }, 6)).toMatchObject({
      options: { points: [2, 4] },
    });
  });

  it('refuses a split that would hand back the whole document', () => {
    const job: PdfJob = { op: 'split', bytes, options: { mode: 'pages' } };
    expect(() => resolveSelection(job, { kind: 'every', count: 5 }, 5)).toThrow(/one piece/);
    expect(() => resolveSelection(job, { kind: 'every', count: 0 }, 5)).toThrow(/whole number/);
    expect(() => resolveSelection(job, { kind: 'every', count: 1.5 }, 5)).toThrow(/whole number/);
  });

  it('refuses a selection the operation cannot use, rather than ignoring it', () => {
    const job: PdfJob = { op: 'compress', bytes, options: { strategy: 'images', quality: 70 } };
    expect(() => resolveSelection(job, { kind: 'pages', text: '1' }, 3)).toThrow(/does not take/);
    expect(() => resolveSelection(job, { kind: 'reverse' }, 3)).toThrow(/does not take/);
  });
});

describe('runPdfRequest', () => {
  it('runs a selection against the real document it was typed for', async () => {
    const result = await runPdfRequest(
      { op: 'extract', bytes: await fivePages(), pages: [] },
      { kind: 'pages', text: '2, 4-' },
      deps,
    );
    expect(await widths(result.outputs[0]!.bytes)).toEqual([102, 104, 105]);
  });

  it('reorders by a typed sequence, end to end', async () => {
    const result = await runPdfRequest(
      { op: 'reorder', bytes: await fivePages(), order: [] },
      { kind: 'order', text: '5, 1-4' },
      deps,
    );
    expect(await widths(result.outputs[0]!.bytes)).toEqual([105, 101, 102, 103, 104]);
  });

  it('names the page a partial order left out, rather than guessing', async () => {
    await expect(
      runPdfRequest(
        { op: 'reorder', bytes: await fivePages(), order: [] },
        { kind: 'order', text: '2, 1' },
        deps,
      ),
    ).rejects.toThrow(/list all 5 pages; 2 were given/);
  });

  it('splits every few pages into the right documents', async () => {
    const result = await runPdfRequest(
      { op: 'split', bytes: await fivePages(), options: { mode: 'pages' } },
      { kind: 'every', count: 2 },
      deps,
    );
    expect(result.outputs.map((output) => output.label)).toEqual(['1-2', '3-4', '5']);
  });

  it('passes the job straight through when there is nothing to resolve', async () => {
    const result = await runPdfRequest(
      { op: 'rotate', bytes: await fivePages(), options: { turn: 90 } },
      undefined,
      deps,
    );
    expect(result.outputs[0]?.pages).toBe(5);
  });

  it('asks for the password before anything else, and with the right class', async () => {
    const bytes = await buildEncryptedPdf({ userPassword: 'open sesame' });
    await expect(
      runPdfRequest({ op: 'delete', bytes, pages: [] }, { kind: 'pages', text: '1' }, deps),
    ).rejects.toBeInstanceOf(PasswordRequiredError);
  });

  it('opens a protected document with the password it was given', async () => {
    const bytes = await buildEncryptedPdf({
      userPassword: 'open sesame',
      pages: [
        { width: 101, height: 200 },
        { width: 102, height: 200 },
      ],
    });
    const result = await runPdfRequest(
      { op: 'extract', bytes, pages: [], options: { password: 'open sesame' } },
      { kind: 'pages', text: '2' },
      deps,
    );
    expect(await widths(result.outputs[0]!.bytes)).toEqual([102]);
  });

  it('will not apply a selection to a job that has no single document', async () => {
    await expect(
      runPdfRequest({ op: 'merge', sources: [] }, { kind: 'pages', text: '1' }, deps),
    ).rejects.toThrow(/does not take/);
  });
});
