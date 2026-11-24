import { readFile } from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';
import JSZip from 'jszip';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildEncryptedPdf, buildPdf } from '../test/pdfFixtures';

/**
 * The PDF tools as a person uses them: a file dropped on the page, a worker
 * that really runs pdf-lib and pdf.js, and a download that is opened again to
 * see what is in it.
 *
 * Every assertion that matters is about the saved file, not the row. A row
 * says Done whether or not the file is right, and this project has shipped
 * that before. Pages are told apart by width, which survives every operation.
 */

const BASE = `http://localhost:${process.env.TOOLSHED_PREVIEW_PORT ?? 4173}`;

test.beforeEach(async ({ page }) => {
  // Headless Chromium exposes showSaveFilePicker and never resolves it.
  // Removing it exercises the anchor fallback, which is also what Firefox and
  // Safari users get, and which Playwright can observe as a download.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
});

// The first PDF job in a page starts the worker and parses pdf.js.
test.setTimeout(90_000);

type Upload = { name: string; mimeType: string; buffer: Buffer };

function pdfFile(name: string, bytes: Uint8Array): Upload {
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) };
}

async function widths(bytes: Uint8Array, password?: string): Promise<number[]> {
  const doc = await PDFDocument.load(bytes, { password: password ?? '', updateMetadata: false });
  return doc.getPages().map((candidate) => candidate.getSize().width);
}

const pagesOfWidth = (...sizes: number[]) =>
  buildPdf(sizes.map((width) => ({ width, height: 200 })));

function row(page: Page, name: string): Locator {
  // The outer list only: a merge row has a nested list of its files.
  return page.locator('ul > li', { hasText: name });
}

async function expand(target: Locator): Promise<void> {
  await target.getByRole('button').first().click();
}

async function runAll(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Run \d/ }).click();
}

/** What a click on Save writes: the file the browser was handed. */
async function download(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(path)) };
}

async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, Uint8Array> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    out[name] = await entry.async('uint8array');
  }
  return out;
}

/** A JPEG with enough noise in it that re-encoding it is a real saving. */
async function noisyJpeg(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1000, 700);
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 1000, 700);
    gradient.addColorStop(0, '#23415f');
    gradient.addColorStop(1, '#d58a1b');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1000, 700);
    let seed = 5;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
    for (let i = 0; i < 9000; i++) {
      context.fillStyle = `rgba(255,255,255,${random() * 0.4})`;
      context.fillRect(random() * 1000, random() * 700, 3, 3);
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return new Uint8Array(bytes);
}

async function documentWithPhoto(jpeg: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const image = await doc.embedJpg(jpeg);
  const page = doc.addPage([500, 350]);
  page.drawImage(image, { x: 0, y: 0, width: 500, height: 350 });
  return doc.save({ useObjectStreams: true });
}

test('compresses a PDF with a photo in it, and the saved file is smaller and opens', async ({
  page,
}) => {
  await page.goto('/');
  const original = await documentWithPhoto(await noisyJpeg(page));
  await page.setInputFiles('input[type=file]', pdfFile('report.pdf', original));

  const target = row(page, 'report.pdf');
  await expand(target);
  await target.getByLabel('Quality').fill('25');
  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(saved.name).toBe('report-compressed.pdf');
  expect(saved.bytes.byteLength).toBeLessThan(original.byteLength * 0.6);
  // Opened again rather than trusted: smaller is easy, still a PDF is the claim.
  expect(await widths(saved.bytes)).toEqual([500]);
  await expect(target.getByText(/Re-encoded 1 of 1 image/)).toBeVisible();
});

test('splits a PDF into its pages and saves every one of them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Split/ }).click();
  await page.setInputFiles(
    'input[type=file]',
    pdfFile('book.pdf', await pagesOfWidth(101, 102, 103)),
  );

  const target = row(page, 'book.pdf');
  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('3 files');
  await expect(page.getByRole('button', { name: 'Save all (3)' })).toBeVisible();

  const all = await download(page, () => page.getByRole('button', { name: /^Save all/ }).click());
  const files = await unzip(all.bytes);
  expect(Object.keys(files).sort()).toEqual([
    'book-page-1.pdf',
    'book-page-2.pdf',
    'book-page-3.pdf',
  ]);
  // Each file holds the page its name says, not a copy of the first.
  expect(await widths(files['book-page-1.pdf']!)).toEqual([101]);
  expect(await widths(files['book-page-2.pdf']!)).toEqual([102]);
  expect(await widths(files['book-page-3.pdf']!)).toEqual([103]);

  // The row's own button saves the same parts, named for the source.
  const own = await download(page, () => target.getByRole('button', { name: 'Save 3' }).click());
  expect(own.name).toBe('book.zip');
  expect(Object.keys(await unzip(own.bytes))).toHaveLength(3);
});

test('splits every few pages, with the count resolved by the worker', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Split/ }).click();
  await page.getByLabel('Split', { exact: true }).selectOption('every');
  await page.getByLabel('Pages per piece').fill('2');
  await page.setInputFiles(
    'input[type=file]',
    pdfFile('five.pdf', await pagesOfWidth(101, 102, 103, 104, 105)),
  );

  await runAll(page);
  const target = row(page, 'five.pdf');
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const all = await download(page, () => page.getByRole('button', { name: /^Save all/ }).click());
  const files = await unzip(all.bytes);
  expect(Object.keys(files).sort()).toEqual([
    'five-page-5.pdf',
    'five-pages-1-2.pdf',
    'five-pages-3-4.pdf',
  ]);
  expect(await widths(files['five-pages-3-4.pdf']!)).toEqual([103, 104]);
});

test('merges two PDFs into one, in the order listed, and reordering changes the file', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Merge/ }).click();
  await page.setInputFiles('input[type=file]', [
    pdfFile('a.pdf', await pagesOfWidth(111)),
    pdfFile('b.pdf', await pagesOfWidth(222, 223)),
  ]);

  // Two files, one row: the queue is not asked to hold a result per file.
  await expect(page.locator('ul > li')).toHaveCount(1);
  const target = row(page, 'merged.pdf');
  await expect(target).toContainText('2 files');

  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const first = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(first.name).toBe('merged.pdf');
  expect(await widths(first.bytes)).toEqual([111, 222, 223]);

  // Moving a file makes the finished result stale, and the row says so.
  await expand(target);
  await target.getByRole('button', { name: 'Move b.pdf earlier' }).click();
  await expect(target.getByText('Waiting')).toBeVisible();
  await expect(target.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const second = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(await widths(second.bytes)).toEqual([222, 223, 111]);
});

test('merges files that were already waiting, when the button above the queue is used', async ({
  page,
}) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file]', [
    pdfFile('one.pdf', await pagesOfWidth(131)),
    pdfFile('two.pdf', await pagesOfWidth(132)),
  ]);
  await expect(page.locator('ul > li')).toHaveCount(2);

  await page.getByRole('button', { name: 'Merge into one PDF (2)' }).click();

  await expect(page.locator('ul > li')).toHaveCount(1);
  await runAll(page);
  const target = row(page, 'merged.pdf');
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(await widths(saved.bytes)).toEqual([131, 132]);
});

test('keeps a typed page range and applies it to the document it was typed for', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Extract pages/ }).click();
  await page.getByLabel('Keep pages').fill('2-');
  await page.setInputFiles(
    'input[type=file]',
    pdfFile('three.pdf', await pagesOfWidth(101, 102, 103)),
  );

  await runAll(page);
  const target = row(page, 'three.pdf');
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(await widths(saved.bytes)).toEqual([102, 103]);
});

test('says so when a page range names a page the document does not have', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Delete pages/ }).click();
  await page.getByLabel('Delete pages').fill('7');
  await page.setInputFiles(
    'input[type=file]',
    pdfFile('three.pdf', await pagesOfWidth(101, 102, 103)),
  );

  await runAll(page);
  const target = row(page, 'three.pdf');
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('3 pages, so page 7 does not exist');
  await expect(target.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('asks for the password a locked PDF needs, rejects a wrong one, and opens with the right one', async ({
  page,
}) => {
  await page.goto('/');
  const locked = await buildEncryptedPdf({
    userPassword: 'open sesame',
    pages: [{ width: 321, height: 200 }],
  });
  await page.setInputFiles('input[type=file]', pdfFile('locked.pdf', locked));

  const target = row(page, 'locked.pdf');
  await runAll(page);
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('password-protected');

  const prompt = target.getByLabel('Password for locked.pdf');
  await prompt.fill('not it');
  await target.getByRole('button', { name: 'Unlock' }).click();
  await expect(target).toContainText('That password does not open this PDF');
  // Still asking: a wrong guess is not the end of the row.
  await expect(prompt).toBeVisible();

  await prompt.fill('open sesame');
  await target.getByRole('button', { name: 'Unlock' }).click();
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(await widths(saved.bytes)).toEqual([321]);
});

test('names the locked file in a merge and takes its password from the list', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Merge/ }).click();
  const locked = await buildEncryptedPdf({
    userPassword: 'hunter2',
    pages: [{ width: 333, height: 200 }],
  });
  await page.setInputFiles('input[type=file]', [
    pdfFile('open.pdf', await pagesOfWidth(111)),
    pdfFile('locked.pdf', locked),
  ]);

  const target = row(page, 'merged.pdf');
  await runAll(page);
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  // Which file, not just "a password is needed".
  await expect(target).toContainText('locked.pdf: This PDF is password-protected');

  // The list opens by itself, with the field for that file in it.
  await target.getByLabel('Password for locked.pdf, if it has one').fill('hunter2');
  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(await widths(saved.bytes)).toEqual([111, 333]);
});

test('locks a PDF so that it needs the password, and will not lock it on a typo', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add a password/ }).click();
  await page.getByLabel('Password', { exact: true }).fill('correct horse');
  await page.getByLabel('Type it again').fill('correct hose');
  await page.setInputFiles('input[type=file]', pdfFile('plain.pdf', await pagesOfWidth(141)));

  const target = row(page, 'plain.pdf');
  await runAll(page);
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('The two passwords are different');

  // Fixed in the row, where it can be seen, and run again.
  await expand(target);
  await target.getByLabel('Type it again').fill('correct horse');
  await target.getByRole('button', { name: 'Run' }).click();
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  await expect(PDFDocument.load(saved.bytes, { updateMetadata: false })).rejects.toThrow(
    /encrypted|password/i,
  );
  expect(await widths(saved.bytes, 'correct horse')).toEqual([141]);
});

test('renders pages to images with pdf.js from this origin, loaded only when a PDF is run', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // The first visit must not have paid for pdf.js: it is megabytes, and
  // someone who came to compress a JPEG should never download it.
  expect(requested.filter((url) => /pdf\.worker|pdfjs-/.test(url))).toEqual([]);

  await page.getByRole('button', { name: /^PDF to images/ }).click();
  await page.setInputFiles('input[type=file]', pdfFile('slides.pdf', await pagesOfWidth(144, 145)));
  await runAll(page);

  const target = row(page, 'slides.pdf');
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('2 files');

  expect(requested.some((url) => /worker-pdf\.worker/.test(url))).toBe(true);
  // Nothing went anywhere else, however many files pdf.js asked for.
  const foreign = requested.filter(
    (url) => !url.startsWith(BASE) && !url.startsWith('blob:') && !url.startsWith('data:'),
  );
  expect(foreign).toEqual([]);

  const all = await download(page, () => page.getByRole('button', { name: /^Save all/ }).click());
  const files = await unzip(all.bytes);
  expect(Object.keys(files).sort()).toEqual(['slides-page-1.png', 'slides-page-2.png']);
  for (const bytes of Object.values(files)) {
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }
});

test('does not offer an image tool for a PDF row, or a PDF tool for an image row', async ({
  page,
}) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file]', pdfFile('doc.pdf', await pagesOfWidth(101)));
  const target = row(page, 'doc.pdf');
  await expand(target);

  const options = await target.getByLabel('Tool').locator('option').allInnerTexts();
  expect(options).toContain('Compress');
  expect(options).toContain('PDF to images');
  expect(options).not.toContain('Resize');
  // Merge is chosen before dropping or with the button, never per row.
  expect(options).not.toContain('Merge');
});

test('a PDF stopped before a worker takes it stays stopped when the others finish', async ({
  page,
}) => {
  // The epoch contract through the PDF path: the third document is waiting
  // behind a pool of at most two workers when Stop is pressed, and its row must
  // not flip to Done later, whether or not the job was dropped before it ran.
  await page.goto('/');
  const long = (label: string) =>
    buildPdf(Array.from({ length: 24 }, () => ({ width: 300, height: 300, text: label })));
  await page.setInputFiles('input[type=file]', [
    pdfFile('first.pdf', await long('first')),
    pdfFile('second.pdf', await long('second')),
    pdfFile('third.pdf', await long('third')),
  ]);

  // Rendering every page is the slow strategy, which is what makes a queue.
  for (const name of ['first.pdf', 'second.pdf', 'third.pdf']) {
    const target = row(page, name);
    await expand(target);
    await target.getByLabel('How').selectOption('rasterize');
  }

  await runAll(page);
  const third = row(page, 'third.pdf');
  await third.getByRole('button', { name: 'Stop' }).click();
  await expect(third.getByText('Stopped')).toBeVisible();

  await expect(row(page, 'first.pdf').getByText('Done')).toBeVisible({ timeout: 80_000 });
  await expect(row(page, 'second.pdf').getByText('Done')).toBeVisible({ timeout: 80_000 });

  await expect(third.getByText('Stopped')).toBeVisible();
  await expect(third.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

/** A flat-colour image of a known size, as the browser encodes it. */
async function canvasImage(
  page: Page,
  type: 'image/png' | 'image/jpeg',
  width: number,
  height: number,
) {
  const bytes = await page.evaluate(
    async (spec) => {
      const canvas = new OffscreenCanvas(spec.width, spec.height);
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#336699';
      context.fillRect(0, 0, spec.width, spec.height);
      const blob = await canvas.convertToBlob({ type: spec.type });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { type, width, height },
  );
  return Buffer.from(bytes);
}

test('turns a JPEG and a PNG into one PDF, a page each, in the order listed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Images to PDF/ }).click();
  await page.setInputFiles('input[type=file]', [
    {
      name: 'a.jpg',
      mimeType: 'image/jpeg',
      buffer: await canvasImage(page, 'image/jpeg', 300, 300),
    },
    {
      name: 'b.png',
      mimeType: 'image/png',
      buffer: await canvasImage(page, 'image/png', 600, 300),
    },
  ]);

  await expect(page.locator('ul > li')).toHaveCount(1);
  const target = row(page, 'images.pdf');
  await runAll(page);
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(saved.name).toBe('images.pdf');
  // Pages the size of their images at 300 dpi: 300 px is 72 pt.
  expect((await widths(saved.bytes)).map(Math.round)).toEqual([72, 144]);
});

test('removes a password, asking for it first, and the copy opens with none', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Remove a password/ }).click();
  const locked = await buildEncryptedPdf({
    userPassword: 'letmein',
    pages: [{ width: 211, height: 200 }],
  });
  await page.setInputFiles('input[type=file]', pdfFile('shut.pdf', locked));

  const target = row(page, 'shut.pdf');
  await runAll(page);
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await target.getByLabel('Password for shut.pdf').fill('letmein');
  await target.getByRole('button', { name: 'Unlock' }).click();
  await expect(target.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const saved = await download(page, () => target.getByRole('button', { name: 'Save' }).click());
  expect(saved.name).toBe('shut-unlocked.pdf');
  expect(await widths(saved.bytes)).toEqual([211]);
});

test('will not number pages with an empty format', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Page numbers/ }).click();
  await page.getByLabel('Format').fill('');
  await page.setInputFiles('input[type=file]', pdfFile('plain.pdf', await pagesOfWidth(101)));

  await runAll(page);
  const target = row(page, 'plain.pdf');
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('Give the format');
});

test('fails a text extraction that found no text, rather than offering an empty file', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^PDF to text/ }).click();
  await page.setInputFiles('input[type=file]', pdfFile('scan.pdf', await pagesOfWidth(101, 102)));

  await runAll(page);
  const target = row(page, 'scan.pdf');
  await expect(target.getByText('Failed')).toBeVisible({ timeout: 60_000 });
  await expect(target).toContainText('No text layer was found');
  await expect(target.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('does not carry a typed password over to the next file dropped', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Add a password/ }).click();
  await page.getByLabel('Password', { exact: true }).fill('only for the first');
  await page.getByLabel('Type it again').fill('only for the first');
  await page.setInputFiles('input[type=file]', pdfFile('one.pdf', await pagesOfWidth(101)));

  await page.getByRole('button', { name: 'Remove one.pdf' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Type it again')).toHaveValue('');
});
