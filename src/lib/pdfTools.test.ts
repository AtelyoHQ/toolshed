import { describe, expect, it } from 'vitest';
import { buildEncryptedPdf, buildPdf } from '../../test/pdfFixtures';
import { createRaster } from './image/raster';
import { loadDocument } from './pdf/document';
import type { PdfJobDeps, PdfJobResult } from './pdf/jobs';
import { runPdfRequest } from './pdf/request';
import {
  PdfSettingsError,
  openPasswordKey,
  toJobOutput,
  toPdfRequest,
  type PdfInput,
} from './pdfTools';
import { PDF_TOOLS, toolById, type Tool } from './tools';
import type { ToolSettings } from './types';

function tool(id: string): Tool {
  const found = toolById(id);
  if (!found) throw new Error(`no tool ${id}`);
  return found;
}

/** The engine's real code with only the ports that need a browser faked. */
const deps = {
  jpeg: {
    decode: async () => createRaster(4, 4),
    encode: async () => new Uint8Array(8),
  },
  rasterizer: {
    async rasterize() {
      throw new Error('not used here');
    },
  },
  textReader: { extract: async () => [] },
} as unknown as PdfJobDeps;

/** Pages are labelled by width, which survives every operation. */
const widthsOf = async (bytes: Uint8Array) =>
  (await loadDocument(bytes)).getPages().map((page) => page.getSize().width);

const fivePages = () =>
  buildPdf([101, 102, 103, 104, 105].map((width) => ({ width, height: 200 })));

async function input(
  name = 'report.pdf',
  bytes?: Uint8Array,
  password?: string,
): Promise<PdfInput> {
  return { id: name, name, bytes: bytes ?? (await fivePages()), ...(password ? { password } : {}) };
}

/** Runs a tool the way the queue does: settings in, a file out. */
async function run(id: string, settings: ToolSettings, inputs: PdfInput[]): Promise<PdfJobResult> {
  const chosen = tool(id);
  const request = toPdfRequest(chosen, { ...chosen.defaults, ...settings }, inputs);
  return runPdfRequest(request.job, request.selection, deps);
}

describe('toPdfRequest', () => {
  it('builds a job or says why not, for every tool on its defaults', async () => {
    // Defaults with no input are what a person gets by pressing Run at once.
    // The answer may be a refusal, but never a TypeError from reading a
    // setting that was not there.
    for (const candidate of PDF_TOOLS) {
      const inputs = [await input('a.pdf'), await input('b.pdf')];
      try {
        const { job } = toPdfRequest(candidate, candidate.defaults, inputs);
        expect(job.op, candidate.id).toBeTruthy();
      } catch (error) {
        expect(error, candidate.id).toBeInstanceOf(PdfSettingsError);
      }
    }
  });

  it('sends a resolution only to the compression that draws pages', async () => {
    const images = toPdfRequest(
      tool('pdf-compress'),
      { strategy: 'images', quality: 60, dpi: 200 },
      [await input()],
    );
    const flat = toPdfRequest(
      tool('pdf-compress'),
      { strategy: 'rasterize', quality: 60, dpi: 200 },
      [await input()],
    );
    expect(images.job).toMatchObject({ options: { strategy: 'images', quality: 60 } });
    expect(images.job).not.toMatchObject({ options: { dpi: 200 } });
    expect(flat.job).toMatchObject({ options: { strategy: 'rasterize', dpi: 200 } });
  });

  it('refuses a compression strategy it does not know, rather than picking one', async () => {
    expect(() =>
      toPdfRequest(tool('pdf-compress'), { strategy: 'magic', quality: 60 }, [
        { id: 'a', name: 'a.pdf', bytes: new Uint8Array() },
      ]),
    ).toThrow(PdfSettingsError);
  });

  it('keeps each merged file with its own password', async () => {
    const request = toPdfRequest(tool('pdf-merge'), {}, [
      { id: 'a', name: 'a.pdf', bytes: new Uint8Array(1), password: 'one' },
      { id: 'b', name: 'b.pdf', bytes: new Uint8Array(1) },
    ]);
    expect(request.job).toMatchObject({
      op: 'merge',
      sources: [
        { name: 'a.pdf', password: 'one' },
        { name: 'b.pdf', password: undefined },
      ],
    });
  });

  it('will not merge one file', async () => {
    expect(() =>
      toPdfRequest(tool('pdf-merge'), {}, [{ id: 'a', name: 'a.pdf', bytes: new Uint8Array() }]),
    ).toThrow(/at least two/i);
  });

  it('treats blank pages as every page where that is safe, and as a mistake where it is not', async () => {
    const rotate = toPdfRequest(tool('pdf-rotate'), { turn: '90', pages: '' }, [await input()]);
    expect(rotate.selection).toBeUndefined();

    // Delete and extract keep the blank so the worker refuses it: "delete
    // nothing" must not be read as "delete everything".
    const doomed = toPdfRequest(tool('pdf-delete'), { pages: '' }, [await input()]);
    expect(doomed.selection).toEqual({ kind: 'pages', text: '' });
  });

  it('only turns by quarter turns', async () => {
    expect(() => toPdfRequest(tool('pdf-rotate'), { turn: '45', pages: '' }, [])).toThrow(
      PdfSettingsError,
    );
  });

  it('turns opacity from a percentage into the fraction the engine takes', async () => {
    const request = toPdfRequest(
      tool('pdf-watermark'),
      { text: 'DRAFT', opacity: 20, rotation: '45', placement: 'center', pages: '' },
      [await input()],
    );
    expect(request.job).toMatchObject({ options: { text: 'DRAFT', opacity: 0.2, rotation: 45 } });
  });

  it('refuses to lock a file when the two passwords differ', async () => {
    // A mistyped password is encrypted into the file for good.
    expect(() =>
      toPdfRequest(tool('pdf-set-password'), { userPassword: 'abc', confirmPassword: 'abd' }, [
        { id: 'a', name: 'a.pdf', bytes: new Uint8Array() },
      ]),
    ).toThrow(/different/);
    expect(() =>
      toPdfRequest(tool('pdf-set-password'), { userPassword: '', confirmPassword: '' }, [
        { id: 'a', name: 'a.pdf', bytes: new Uint8Array() },
      ]),
    ).toThrow(PdfSettingsError);
  });

  it('does not start numbering at zero because the field was cleared', async () => {
    expect(() =>
      toPdfRequest(
        tool('pdf-page-numbers'),
        { placement: 'bottom-center', startAt: '', template: '{page}', pages: '' },
        [{ id: 'a', name: 'a.pdf', bytes: new Uint8Array() }],
      ),
    ).toThrow(/first page/);
  });

  it('does not stamp nothing because the format was cleared', async () => {
    expect(() =>
      toPdfRequest(
        tool('pdf-page-numbers'),
        { placement: 'bottom-center', startAt: 1, template: '  ', pages: '' },
        [{ id: 'a', name: 'a.pdf', bytes: new Uint8Array() }],
      ),
    ).toThrow(/format/);
  });

  it('does not number from a negative page', async () => {
    expect(() =>
      toPdfRequest(
        tool('pdf-page-numbers'),
        { placement: 'bottom-center', startAt: -3, template: '{page}', pages: '' },
        [{ id: 'a', name: 'a.pdf', bytes: new Uint8Array() }],
      ),
    ).toThrow(/0 or more/);
  });

  it('refuses a cleared field that has no sensible default, for every tool', async () => {
    // A blank that falls through to an engine default produces a believable
    // file that is wrong. Pages are the one text field where blank is a
    // meaning of its own (every page), handled in its own tests above.
    const inputs = [await input('a.pdf'), await input('b.pdf')];
    for (const candidate of PDF_TOOLS) {
      for (const field of candidate.fields) {
        if (field.type !== 'text' || field.secret || field.key === 'pages') continue;
        const cleared = { ...candidate.defaults, [field.key]: '' };
        // Reached through the mode that shows the field.
        if (field.showWhen) cleared[field.showWhen.key] = field.showWhen.oneOf[0] as string;
        let outcome: 'refused' | 'built' = 'built';
        let request;
        try {
          request = toPdfRequest(candidate, cleared, inputs);
        } catch (error) {
          expect(error, `${candidate.id}.${field.key}`).toBeInstanceOf(PdfSettingsError);
          outcome = 'refused';
        }
        // Built is acceptable only when the worker refuses it: selections
        // (order, points) are resolved there and tested against it.
        if (outcome === 'built') {
          const resolvedByEngine = request?.selection !== undefined;
          // The watermark text is refused by the engine itself; see below.
          const refusedByEngine = `${candidate.id}.${field.key}` === 'pdf-watermark.text';
          expect(resolvedByEngine || refusedByEngine, `${candidate.id}.${field.key}`).toBe(true);
        }
      }
    }
  });

  it('names a split point that is not a number', async () => {
    expect(() =>
      toPdfRequest(tool('pdf-split'), { mode: 'after', points: '3, x' }, [
        { id: 'a', name: 'a.pdf', bytes: new Uint8Array() },
      ]),
    ).toThrow(/"x" is not a page number/);
  });

  it('keys passwords apart per file in a merge, and plainly for a single file', () => {
    expect(openPasswordKey()).toBe('openPassword');
    expect(openPasswordKey('a.pdf:10:1')).not.toBe(openPasswordKey('b.pdf:10:1'));
  });
});

describe('the tools, against the real engine', () => {
  it('deletes the pages that were typed', async () => {
    const result = await run('pdf-delete', { pages: '2, 4-' }, [await input()]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([101, 103]);
  });

  it('keeps the pages that were typed', async () => {
    const result = await run('pdf-extract', { pages: '3-4' }, [await input()]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([103, 104]);
  });

  it('refuses to delete nothing', async () => {
    await expect(run('pdf-delete', { pages: '' }, [await input()])).rejects.toThrow(/no pages/i);
  });

  it('turns only the pages named', async () => {
    const result = await run('pdf-rotate', { turn: '90', pages: '2' }, [await input()]);
    const doc = await loadDocument(result.outputs[0]!.bytes);
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 90, 0, 0, 0]);
  });

  it('turns every page when none are named', async () => {
    const result = await run('pdf-rotate', { turn: '180', pages: '' }, [await input()]);
    const doc = await loadDocument(result.outputs[0]!.bytes);
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([
      180, 180, 180, 180, 180,
    ]);
  });

  it('puts the pages in the order typed', async () => {
    const result = await run('pdf-reorder', { mode: 'custom', order: '5, 1-4' }, [await input()]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([105, 101, 102, 103, 104]);
  });

  it('reverses the pages', async () => {
    const result = await run('pdf-reorder', { mode: 'reverse' }, [await input()]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([105, 104, 103, 102, 101]);
  });

  it('splits into one file a page', async () => {
    const result = await run('pdf-split', { mode: 'pages' }, [await input()]);
    expect(result.outputs).toHaveLength(5);
  });

  it('splits after the pages named', async () => {
    const result = await run('pdf-split', { mode: 'after', points: '2, 4' }, [await input()]);
    expect(result.outputs.map((output) => output.label)).toEqual(['1-2', '3-4', '5']);
    expect(await widthsOf(result.outputs[2]!.bytes)).toEqual([105]);
  });

  it('splits every few pages', async () => {
    const result = await run('pdf-split', { mode: 'every', every: 2 }, [await input()]);
    expect(result.outputs.map((output) => output.pages)).toEqual([2, 2, 1]);
  });

  it('merges in the order given, which is the order on the row', async () => {
    const a = await input('a.pdf', await buildPdf([{ width: 111, height: 200 }]));
    const b = await input(
      'b.pdf',
      await buildPdf([
        { width: 222, height: 200 },
        { width: 223, height: 200 },
      ]),
    );
    const result = await run('pdf-merge', {}, [b, a]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([222, 223, 111]);
  });

  it('merges a locked file when it is given its password, and names it when it is not', async () => {
    const locked = await buildEncryptedPdf({
      userPassword: 'open',
      pages: [{ width: 333, height: 200 }],
    });
    const plain = await input('plain.pdf', await buildPdf([{ width: 111, height: 200 }]));

    const merged = await run('pdf-merge', {}, [plain, await input('locked.pdf', locked, 'open')]);
    expect(await widthsOf(merged.outputs[0]!.bytes)).toEqual([111, 333]);

    await expect(run('pdf-merge', {}, [plain, await input('locked.pdf', locked)])).rejects.toThrow(
      /^locked\.pdf: /,
    );
  });

  it('locks a file and unlocks it again with the same password', async () => {
    const locked = await run(
      'pdf-set-password',
      { userPassword: 's3cret', confirmPassword: 's3cret' },
      [await input()],
    );
    await expect(loadDocument(locked.outputs[0]!.bytes)).rejects.toThrow(/password/i);

    const reopened = await run('pdf-remove-password', {}, [
      await input('report.pdf', locked.outputs[0]!.bytes, 's3cret'),
    ]);
    expect(await widthsOf(reopened.outputs[0]!.bytes)).toEqual([101, 102, 103, 104, 105]);
  });

  it('will not stamp an empty watermark', async () => {
    await expect(run('pdf-watermark', { text: '  ' }, [await input()])).rejects.toThrow(
      /needs some text/,
    );
  });

  it('stamps and numbers without changing the page count', async () => {
    const stamped = await run('pdf-watermark', { text: 'DRAFT', pages: '1-2' }, [await input()]);
    expect(stamped.outputs[0]?.pages).toBe(5);

    const numbered = await run('pdf-page-numbers', { startAt: 7, template: 'p. {page}' }, [
      await input(),
    ]);
    expect(numbered.outputs[0]?.pages).toBe(5);
  });

  it('compresses without breaking a document that has nothing to compress', async () => {
    const result = await run('pdf-compress', { strategy: 'images', quality: 70 }, [await input()]);
    expect(await widthsOf(result.outputs[0]!.bytes)).toEqual([101, 102, 103, 104, 105]);
  });
});

describe('toJobOutput', () => {
  const pdf = (label?: string, bytes = 10) => ({
    bytes: new Uint8Array(bytes),
    mime: 'application/pdf',
    ...(label ? { label } : {}),
  });

  it('names each piece of a split by its pages, so the flat zip says what each is', () => {
    const output = toJobOutput(tool('pdf-split'), 'report.pdf', {
      outputs: [pdf('1-3'), pdf('4'), pdf('5-9')],
    });
    expect(output.name).toBe('report-pages-1-3.pdf');
    expect(output.siblings?.map((sibling) => sibling.name)).toEqual([
      'report-page-4.pdf',
      'report-pages-5-9.pdf',
    ]);
  });

  it('keeps the first output as the row own and the rest as siblings, with every byte accounted for', () => {
    const output = toJobOutput(tool('pdf-split'), 'r.pdf', {
      outputs: [pdf('1', 5), pdf('2', 7), pdf('3', 11)],
    });
    expect(output.bytes.byteLength).toBe(5);
    expect(output.siblings?.map((sibling) => sibling.bytes.byteLength)).toEqual([7, 11]);
  });

  it('names rendered pages for the page they are, with the right extension', () => {
    const image = (label: string) => ({
      bytes: new Uint8Array(3),
      mime: 'image/jpeg',
      label,
      width: 10,
      height: 20,
    });
    const output = toJobOutput(tool('pdf-to-images'), 'scan.pdf', {
      outputs: [image('page-1'), image('page-2')],
    });
    expect(output.name).toBe('scan-page-1.jpg');
    expect(output.siblings?.[0]?.name).toBe('scan-page-2.jpg');
    expect(output.width).toBe(10);
  });

  it('does not give a one-page render a page label it does not need', () => {
    const output = toJobOutput(tool('pdf-to-images'), 'scan.pdf', {
      outputs: [{ bytes: new Uint8Array(3), mime: 'image/png', label: 'page-1' }],
    });
    expect(output.name).toBe('scan.png');
    expect(output.siblings).toBeUndefined();
  });

  it('writes text as .txt and a result as a new name beside the original', () => {
    expect(
      toJobOutput(tool('pdf-to-text'), 'notes.pdf', {
        outputs: [{ bytes: new Uint8Array(1), mime: 'text/plain' }],
      }).name,
    ).toBe('notes.txt');
    expect(toJobOutput(tool('pdf-compress'), 'deck.pdf', { outputs: [pdf()] }).name).toBe(
      'deck-compressed.pdf',
    );
  });

  it('keeps the name a merge was given', () => {
    expect(toJobOutput(tool('pdf-merge'), 'merged.pdf', { outputs: [pdf()] }).name).toBe(
      'merged.pdf',
    );
  });

  it('carries the engine note across', () => {
    expect(
      toJobOutput(tool('pdf-compress'), 'a.pdf', { outputs: [pdf()], note: 'Already small.' }).note,
    ).toBe('Already small.');
  });

  it('fails a text extraction that found no text, instead of offering an empty file', () => {
    const empty = (text: string) => ({
      outputs: [{ bytes: new TextEncoder().encode(text), mime: 'text/plain' }],
      note: 'No text layer was found.',
    });
    expect(() => toJobOutput(tool('pdf-to-text'), 's.pdf', empty('\n\n'))).toThrow(/No text layer/);
    expect(toJobOutput(tool('pdf-to-text'), 's.pdf', empty('hello')).name).toBe('s.txt');
  });

  it('refuses an empty result rather than showing a finished row with no file', () => {
    expect(() => toJobOutput(tool('pdf-split'), 'a.pdf', { outputs: [] })).toThrow(
      PdfSettingsError,
    );
  });
});
