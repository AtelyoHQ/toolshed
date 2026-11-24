import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPdf,
  buildPdf,
  buildPdfWithImageXObjects,
  tinyJpeg,
  tinyPng,
} from '../../../test/pdfFixtures';
import { createRaster } from '../image/raster';
import { loadDocument } from './document';
import { PDF_MIME, runPdfJob, type PdfJobDeps } from './jobs';
import type { PdfRasterizer, PdfTextReader } from './render';

/**
 * The dispatcher is tested through the same ports the worker injects, which is
 * the point of having them: this covers the message surface between the main
 * thread and the worker without a browser.
 */
function deps(): PdfJobDeps {
  const rasterizer: PdfRasterizer = {
    async rasterize(request, onPage) {
      for (const page of request.pages) {
        await onPage({
          page,
          bytes: tinyJpeg({ width: 80, height: 160, size: 400 }),
          mime: 'image/jpeg',
          width: 80,
          height: 160,
          ink: true,
        });
      }
    },
  };
  const textReader: PdfTextReader = {
    async extract(request) {
      return request.pages.map((page) => `Page ${page} text`);
    },
  };
  return {
    jpeg: {
      async decode() {
        return createRaster(40, 20);
      },
      async encode() {
        return new Uint8Array(600).fill(0x44);
      },
    },
    rasterizer,
    textReader,
  };
}

const twoPages = () =>
  buildPdf([
    { width: 101, height: 400 },
    { width: 102, height: 400 },
  ]);

describe('runPdfJob', () => {
  it('merges, returning one PDF', async () => {
    const result = await runPdfJob(
      { op: 'merge', sources: [{ bytes: await twoPages() }, { bytes: await twoPages() }] },
      deps(),
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ mime: PDF_MIME, pages: 4 });
  });

  it('splits, returning one labelled output per document', async () => {
    const result = await runPdfJob(
      { op: 'split', bytes: await twoPages(), options: { mode: 'pages' } },
      deps(),
    );

    expect(result.outputs.map((output) => output.label)).toEqual(['1', '2']);
    expect(result.outputs.every((output) => output.mime === PDF_MIME)).toBe(true);
    expect(result.note).toMatch(/Split into 2 documents/);
  });

  it('reorders, rotates, deletes and extracts', async () => {
    const bytes = await twoPages();
    const jobs = [
      { op: 'reorder' as const, bytes, order: [2, 1] },
      { op: 'rotate' as const, bytes, options: { turn: 90 } },
      { op: 'delete' as const, bytes, pages: [1] },
      { op: 'extract' as const, bytes, pages: [2] },
    ];

    const pages = [];
    for (const job of jobs) pages.push((await runPdfJob(job, deps())).outputs[0]!.pages);
    expect(pages).toEqual([2, 2, 1, 1]);
  });

  it('turns images into a PDF', async () => {
    const result = await runPdfJob(
      {
        op: 'images-to-pdf',
        images: [{ bytes: tinyJpeg() }, { bytes: tinyPng() }],
        options: { sizing: { mode: 'image' } },
      },
      deps(),
    );

    expect(result.outputs[0]).toMatchObject({ mime: PDF_MIME, pages: 2 });
  });

  it('renders pages to images, one output each, named by page', async () => {
    const result = await runPdfJob(
      { op: 'pdf-to-images', bytes: await twoPages(), options: { dpi: 150, format: 'jpeg' } },
      deps(),
    );

    expect(result.outputs.map((output) => output.label)).toEqual(['page-1', 'page-2']);
    expect(result.outputs[0]).toMatchObject({ mime: 'image/jpeg', width: 80, height: 160 });
    expect(result.note).toMatch(/at 150 dpi/);
  });

  it('extracts text as a UTF-8 text file', async () => {
    const result = await runPdfJob(
      { op: 'pdf-to-text', bytes: await twoPages(), options: {} },
      deps(),
    );

    const output = result.outputs[0]!;
    expect(output.mime).toBe('text/plain');
    expect(new TextDecoder().decode(output.bytes)).toBe('Page 1 text\n\nPage 2 text');
  });

  it('compresses, and reports when it decided to keep the original', async () => {
    const original = await buildPdf([{ width: 200, height: 200, text: 'all text' }]);
    const result = await runPdfJob(
      { op: 'compress', bytes: original, options: { strategy: 'images', quality: 70 } },
      deps(),
    );

    expect(result.unchanged).toBe(true);
    expect(result.outputs[0]!.bytes).toBe(original);
  });

  it('compresses by re-encoding the images when that wins', async () => {
    const original = await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 40000 }) }]);
    const result = await runPdfJob(
      { op: 'compress', bytes: original, options: { strategy: 'images', quality: 50 } },
      deps(),
    );

    expect(result.unchanged).toBeUndefined();
    expect(result.outputs[0]!.bytes.byteLength).toBeLessThan(original.byteLength);
  });

  it('compresses by rasterising, through the injected renderer', async () => {
    const result = await runPdfJob(
      {
        op: 'compress',
        bytes: await twoPages(),
        options: { strategy: 'rasterize', quality: 60, dpi: 150, neverGrow: false },
      },
      deps(),
    );

    expect(result.outputs[0]!.pages).toBe(2);
    expect(result.note).toMatch(/redrawn at 150 dpi/);
  });

  it('sets and removes a password', async () => {
    const locked = await runPdfJob(
      { op: 'set-password', bytes: await twoPages(), options: { userPassword: 'open-me' } },
      deps(),
    );
    const unlocked = await runPdfJob(
      {
        op: 'remove-password',
        bytes: locked.outputs[0]!.bytes,
        options: { password: 'open-me' },
      },
      deps(),
    );

    const doc = await loadDocument(unlocked.outputs[0]!.bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it('watermarks and numbers pages', async () => {
    const watermarked = await runPdfJob(
      { op: 'watermark', bytes: await twoPages(), options: { text: 'DRAFT' } },
      deps(),
    );
    const numbered = await runPdfJob(
      { op: 'page-numbers', bytes: watermarked.outputs[0]!.bytes, options: { startAt: 1 } },
      deps(),
    );

    expect(numbered.outputs[0]).toMatchObject({ mime: PDF_MIME, pages: 2 });
    expect(numbered.note).toMatch(/Numbered 2 pages from 1/);
  });

  it("reports a job's progress through the callback it was given", async () => {
    const seen: number[] = [];
    await runPdfJob(
      {
        op: 'compress',
        bytes: await twoPages(),
        options: { strategy: 'rasterize', quality: 60, neverGrow: false },
      },
      deps(),
      (fraction) => seen.push(fraction),
    );

    expect(seen.at(-1)).toBe(1);
  });

  it('lets a failure out rather than returning an empty result', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(
      runPdfJob({ op: 'rotate', bytes: locked, options: { turn: 90 } }, deps()),
    ).rejects.toThrow(/password/i);
  });
});
