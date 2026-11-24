import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';
import { buildCjkPdf, buildHairlinePdf, HAIRLINE_DPI } from '../test/pdfFixtures';

/**
 * The unit tests drive the engine against a fake renderer, which proves the
 * decision tree and nothing about pdf.js. These run the real thing in a real
 * browser: pdf.js inside Toolshed's PDF worker, rendering to an
 * OffscreenCanvas, with the WebAssembly it resolves at runtime coming from
 * this origin and nowhere else.
 *
 * They run against the dev server because they import the engine by source
 * path. What the *build* does with those wasm files is checked by
 * scripts/check-bundle.mjs instead.
 *
 * Fixtures are built here, in Node, with the same library the engine uses, so
 * a document with an awkward image in it can be described in a few lines
 * rather than committed as a binary nobody can review.
 */

const ENGINE = '/src/lib/workers/pdfClient.ts';
const ASSETS_MODULE = '/src/lib/pdf/pdfjsAssets.ts';

interface Output {
  bytes: number[];
  mime: string;
  label?: string;
  pages?: number;
  width?: number;
  height?: number;
}

interface JobResult {
  outputs: Output[];
  note?: string;
  unchanged?: boolean;
}

/**
 * Runs one job in the page, in the worker, through the real client.
 *
 * Byte arrays cross as plain number arrays: that is what survives the
 * round trip to the browser intact, and the sizes here are a few hundred
 * kilobytes at most.
 */
async function runJob(
  page: Page,
  job: Record<string, unknown>,
  bytesByKey: Record<string, number[]> = {},
): Promise<JobResult> {
  return page.evaluate(
    async ({ enginePath, job: plain, bytesByKey: inputs }) => {
      const { runPdfJobInWorker } = (await import(/* @vite-ignore */ enginePath)) as {
        runPdfJobInWorker: (job: unknown) => Promise<{
          outputs: Array<{
            bytes: Uint8Array;
            mime: string;
            label?: string;
            pages?: number;
            width?: number;
            height?: number;
          }>;
          note?: string;
          unchanged?: boolean;
        }>;
      };

      const prepared: Record<string, unknown> = { ...plain };
      for (const [key, value] of Object.entries(inputs)) {
        prepared[key] = new Uint8Array(value);
      }

      const result = await runPdfJobInWorker(prepared);
      return {
        outputs: result.outputs.map((output) => ({
          bytes: Array.from(output.bytes),
          mime: output.mime,
          label: output.label,
          pages: output.pages,
          width: output.width,
          height: output.height,
        })),
        note: result.note,
        unchanged: result.unchanged,
      };
    },
    { enginePath: ENGINE, job, bytesByKey },
  );
}

/** A one-page document, 2 by 1 inch, with a line of text on it. */
async function textDocument(text: string): Promise<number[]> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([144, 72]);
  page.drawText(text, { x: 8, y: 30, size: 11, font });
  return Array.from(await doc.save({ useObjectStreams: true }));
}

/**
 * A document whose images force pdf.js to load two of its WebAssembly
 * modules: an ICC-tagged image needs qcms, and a CCITT Group 4 image is
 * decoded by the jbig2 module.
 *
 * Neither image carries real samples, and that is deliberate: pdf.js asks for
 * the module before it looks at the data, so a hand-written byte or two
 * exercises the loading path that ground rule 1 is about. Synthesising a
 * genuine Group 4 codestream would test the decoder, which is Mozilla's to
 * test, not this.
 */
async function documentNeedingWasm(): Promise<number[]> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([144, 144]);
  const { context } = doc;

  const profile = context.register(context.stream(new Uint8Array(128).fill(0x20), { N: 3 }));
  const iccImage = context.register(
    context.stream(new Uint8Array(64).fill(0x7f), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 4,
      BitsPerComponent: 8,
      ColorSpace: context.obj(['ICCBased', profile]),
    }),
  );
  const ccittImage = context.register(
    context.stream(new Uint8Array([0x26, 0xa0, 0x00, 0x00]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 8,
      Height: 8,
      BitsPerComponent: 1,
      ColorSpace: 'DeviceGray',
      Filter: 'CCITTFaxDecode',
      DecodeParms: context.obj({ K: -1, Columns: 8, Rows: 8 }),
    }),
  );

  page.node.set(
    PDFName.of('Resources'),
    context.obj({ XObject: context.obj({ Icc: iccImage, Fax: ccittImage }) }),
  );
  // Both images have to be painted, or pdf.js never looks at either.
  const content = context.register(
    context.stream('q 72 0 0 72 0 72 cm /Icc Do Q q 72 0 0 72 0 0 cm /Fax Do Q'),
  );
  page.node.set(PDFName.of('Contents'), content);

  return Array.from(await doc.save({ useObjectStreams: true }));
}

test('renders a page to a real image at the resolution asked for', async ({ page }) => {
  await page.goto('/');
  const result = await runJob(
    page,
    { op: 'pdf-to-images', options: { dpi: 144, format: 'png' } },
    { bytes: await textDocument('Rendered by pdf.js') },
  );

  expect(result.outputs).toHaveLength(1);
  const [image] = result.outputs;
  // 144 by 72 points at 144 dpi is 288 by 144 pixels.
  expect(image!.width).toBe(288);
  expect(image!.height).toBe(144);
  expect(image!.label).toBe('page-1');
  expect(image!.bytes.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

/**
 * pdf.js draws glyphs from the font program, and nothing in this document
 * embeds one: it asks for Helvetica, which every reader is required to have
 * and which pdf.js therefore ships as a separate file that Toolshed does not
 * bundle. If that turns out to mean blank pages, rasterising a text document
 * would quietly destroy it — so the pixels are counted rather than trusted.
 */
test('draws the page content, not a blank sheet', async ({ page }) => {
  await page.goto('/');
  const bytes = await textDocument('Pixels, please');

  const dark = await page.evaluate(
    async ({ enginePath, document: input }) => {
      const { runPdfJobInWorker } = (await import(/* @vite-ignore */ enginePath)) as {
        runPdfJobInWorker: (job: unknown) => Promise<{ outputs: Array<{ bytes: Uint8Array }> }>;
      };
      const rendered = await runPdfJobInWorker({
        op: 'pdf-to-images',
        bytes: new Uint8Array(input),
        options: { dpi: 144, format: 'png' },
      });

      // `.slice()` rather than the array itself: the typed array may be a view
      // onto a larger buffer, and a Blob built from one takes the whole thing.
      const bitmap = await createImageBitmap(new Blob([rendered.outputs[0]!.bytes.slice()]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;

      let count = 0;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! < 128) count += 1;
      return count;
    },
    { enginePath: ENGINE, document: bytes },
  );

  // A line of 11 pt text at 144 dpi is a few hundred dark pixels; a blank
  // page is none.
  expect(dark).toBeGreaterThan(100);
});

test('reads the text layer out of a document', async ({ page }) => {
  await page.goto('/');
  const result = await runJob(
    page,
    { op: 'pdf-to-text', options: {} },
    { bytes: await textDocument('Toolshed can read this') },
  );

  const text = new TextDecoder().decode(new Uint8Array(result.outputs[0]!.bytes));
  expect(text).toContain('Toolshed can read this');
});

/**
 * The document asks for Helvetica and does not embed it, which is the normal
 * case for a generated PDF and for this engine's own watermarks. pdf.js draws
 * glyphs from a font program, so it fetches one — and if it is not told where
 * they are, it requests a path built out of the string "null", fails, and
 * substitutes glyphs. Counting dark pixels cannot see that happen, because
 * substituted glyphs are dark too.
 */
test('fetches a real standard font rather than substituting glyphs', async ({ page, baseURL }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto('/');
  await runJob(
    page,
    { op: 'pdf-to-images', options: { dpi: 96, format: 'png' } },
    { bytes: await textDocument('Helvetica, please') },
  );

  const fonts = requested.filter((url) => /\.(ttf|pfb)$/.test(url));
  expect(fonts.length).toBeGreaterThan(0);
  for (const url of fonts) expect(url.startsWith(new URL(baseURL!).origin)).toBe(true);
  expect(requested.filter((url) => url.includes('null'))).toEqual([]);
});

test('re-encodes the photographs in a document with the real JPEG encoder', async ({ page }) => {
  await page.goto('/');
  const sizes = await page.evaluate(async (enginePath) => {
    const { runPdfJobInWorker } = (await import(/* @vite-ignore */ enginePath)) as {
      runPdfJobInWorker: (job: unknown) => Promise<{
        outputs: Array<{ bytes: Uint8Array }>;
        note?: string;
        unchanged?: boolean;
      }>;
    };

    // A photographic image: a smooth gradient with grain over it. Flat colour
    // would compress to almost nothing at any quality and prove nothing about
    // the encoder.
    let seed = 0x5bd1e995;
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const size = 600;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (y * size + x) * 4;
        image.data[at] = (x * 255) / size + noise() * 30;
        image.data[at + 1] = (y * 255) / size + noise() * 30;
        image.data[at + 2] = 120 + Math.sin(x / 13) * 40 + noise() * 30;
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const photo = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer(),
    );

    // The engine builds its own fixture: a PDF holding that photograph.
    const built = await runPdfJobInWorker({
      op: 'images-to-pdf',
      images: [{ bytes: photo }],
      options: { sizing: { mode: 'image' } },
    });
    const document = built.outputs[0]!.bytes;
    const before = document.byteLength;

    const compressed = await runPdfJobInWorker({
      op: 'compress',
      bytes: document,
      options: { strategy: 'images', quality: 35 },
    });

    // The start-of-frame marker of the JPEG that ended up inside the PDF.
    // 0xFFC0 is baseline, 0xFFC2 is progressive, which is mozjpeg's default
    // and is outside what DCTDecode is defined over.
    const result = compressed.outputs[0]!.bytes;
    let frameMarker = 0;
    for (let at = 0; at + 1 < result.byteLength; at++) {
      if (result[at] !== 0xff) continue;
      const marker = result[at + 1]!;
      if (marker === 0xc0 || marker === 0xc2) {
        frameMarker = marker;
        break;
      }
    }

    return {
      before,
      after: result.byteLength,
      note: compressed.note ?? '',
      unchanged: compressed.unchanged ?? false,
      magic: String.fromCharCode(...result.slice(0, 5)),
      frameMarker,
    };
  }, ENGINE);

  expect(sizes.unchanged).toBe(false);
  expect(sizes.note).toMatch(/Re-encoded 1 of 1 image/);
  expect(sizes.after).toBeLessThan(sizes.before);
  expect(sizes.magic).toBe('%PDF-');
  expect(sizes.frameMarker).toBe(0xc0);
});

test('rasterising a document replaces its text with a picture of it', async ({ page }) => {
  await page.goto('/');
  const document = await textDocument('This sentence is about to become pixels');

  const rasterised = await runJob(
    page,
    {
      op: 'compress',
      options: { strategy: 'rasterize', quality: 60, dpi: 96, neverGrow: false },
    },
    { bytes: document },
  );
  expect(rasterised.outputs[0]!.pages).toBe(1);

  // Read back through pdf.js: a page that is now a photograph of itself has
  // nothing left for the text layer to report, which is the trade the note
  // promises.
  const text = await runJob(
    page,
    { op: 'pdf-to-text', options: {} },
    { bytes: rasterised.outputs[0]!.bytes },
  );
  expect(new TextDecoder().decode(new Uint8Array(text.outputs[0]!.bytes)).trim()).toBe('');
  expect(text.note).toMatch(/no text layer/i);

  // And the page it produced is still the size of the page it replaced.
  const images = await runJob(
    page,
    { op: 'pdf-to-images', options: { dpi: 72, format: 'png' } },
    { bytes: rasterised.outputs[0]!.bytes },
  );
  expect(images.outputs[0]!.width).toBe(144);
  expect(images.outputs[0]!.height).toBe(72);
});

/**
 * The test this change most needed and nearly did not have.
 *
 * A CJK font with no `/ToUnicode` map — what Word and Acrobat write — sends
 * pdf.js looking for `Adobe-Japan1-UCS2.bcmap` before it will draw or read a
 * character. Without the predefined character maps bundled, the font fails to
 * translate, every glyph maps to nothing, and the page is blank: `pdf-to-text`
 * returned "" and called the document a scan, and rasterising compression
 * turned every page into an empty one and reported a saving.
 *
 * The `Identity` ordering is the control. pdf.js needs no map for it, so if
 * both go blank the fixture is at fault; if only the Japanese one does, the
 * maps are missing.
 */
test('draws and reads a CJK document, which needs a character map', async ({ page }) => {
  await page.goto('/');

  const ink = async (bytes: Uint8Array) => {
    const rendered = await runJob(
      page,
      { op: 'pdf-to-images', options: { dpi: 144, format: 'png' } },
      { bytes: Array.from(bytes) },
    );
    return page.evaluate(async (png: number[]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let dark = 0;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! < 128) dark += 1;
      return dark;
    }, rendered.outputs[0]!.bytes);
  };

  expect(await ink(await buildCjkPdf('Identity'))).toBeGreaterThan(50);
  expect(await ink(await buildCjkPdf('Japan1'))).toBeGreaterThan(50);

  // And the text layer, which comes from the same failed translation.
  const text = await runJob(
    page,
    { op: 'pdf-to-text', options: {} },
    { bytes: Array.from(await buildCjkPdf('Japan1')) },
  );
  const extracted = new TextDecoder().decode(new Uint8Array(text.outputs[0]!.bytes));
  expect(extracted.trim().length).toBeGreaterThan(0);
  // Text came out, so there is nothing to explain and no note at all.
  expect(text.note).toBeUndefined();
});

/**
 * The guard, against the real renderer and a real failure.
 *
 * One blocked request is all it takes: a character map that never arrives —
 * evicted from the cache, or asked for while offline — and pdf.js draws
 * nothing for every glyph of that font. Before the guard this came back as a
 * smaller document and a cheerful note. The request is blocked here rather
 * than simulated, because the point is that the engine cannot tell the
 * difference and must not have to.
 */
test('refuses to call a blank rasterisation a saving', async ({ page }) => {
  await page.route('**/*.bcmap', (route) => route.abort());
  await page.goto('/');

  const failed = await page.evaluate(
    async ({ enginePath, document: input }) => {
      const { runPdfJobInWorker } = (await import(/* @vite-ignore */ enginePath)) as {
        runPdfJobInWorker: (job: unknown) => Promise<unknown>;
      };
      try {
        await runPdfJobInWorker({
          op: 'compress',
          bytes: new Uint8Array(input),
          options: { strategy: 'rasterize', quality: 70, dpi: 110, neverGrow: false },
        });
        return 'no error';
      } catch (error) {
        return (error as Error).message;
      }
    },
    { enginePath: ENGINE, document: Array.from(await buildCjkPdf('Japan1', 8)) },
  );

  expect(failed).toMatch(/Every page rendered blank/);
});

/**
 * The other side of the guard, and the only test that can reach the exact
 * scan: a page whose entire content is two hairline rules must not be called
 * blank.
 *
 * Reading every eighth row is enough for a line of text and misses these, and
 * a false blank is the refusal of a document that was fine. Only the real
 * renderer puts pixels on a canvas, so this cannot be tested in Node against a
 * fake — and the half of it that *can* be, that this document counts as having
 * something to paint at all, is pinned in compress.test.ts, because without
 * that this test would pass no matter how blind `hasInk` became.
 */
test('does not call a page blank because its only marks are hairlines', async ({ page }) => {
  await page.goto('/');

  const result = await runJob(
    page,
    {
      op: 'compress',
      options: { strategy: 'rasterize', quality: 70, dpi: HAIRLINE_DPI, neverGrow: false },
    },
    { bytes: Array.from(await buildHairlinePdf()) },
  );

  expect(result.outputs).toHaveLength(1);
  expect(result.outputs[0]!.pages).toBe(1);
});

/**
 * Ground rule 1, at the one place in this project where a dependency would
 * otherwise go and fetch part of itself from a URL the build never chose.
 */
test('loads pdf.js WebAssembly from this origin and nowhere else', async ({ page, baseURL }) => {
  const external: string[] = [];
  const requested: string[] = [];
  const base = new URL(baseURL!).origin;

  page.on('request', (request) => {
    const url = request.url();
    requested.push(url);
    if (url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:')) return;
    external.push(url);
  });

  await page.goto('/');

  // A document that makes pdf.js reach for two of its four wasm modules.
  const result = await runJob(
    page,
    { op: 'pdf-to-images', options: { dpi: 72, format: 'png' } },
    { bytes: await documentNeedingWasm() },
  );
  expect(result.outputs).toHaveLength(1);

  // The fixture is here to make pdf.js load WebAssembly at all, so the loop
  // below is worth nothing unless that happened. Playwright reports requests
  // from the nested pdf.js worker, which is where these are made.
  const wasmRequests = requested.filter((url) => url.endsWith('.wasm'));
  expect(wasmRequests.some((url) => url.endsWith('jbig2.wasm'))).toBe(true);
  expect(wasmRequests.some((url) => url.endsWith('qcms_bg.wasm'))).toBe(true);

  // Whatever it loaded, it came from here.
  for (const url of wasmRequests) expect(url.startsWith(base)).toBe(true);
  expect(external).toEqual([]);
  // This fixture has no predefined CMap, which is the one base URL pdf.js is
  // not given, so nothing here should be fetching a path assembled out of a
  // missing setting.
  expect(requested.filter((url) => url.includes('null'))).toEqual([]);

  // And the files really are served from the directories pdf.js is given,
  // which is the thing that breaks if the build's asset naming changes.
  const reachable = await page.evaluate(async (assetsPath) => {
    const { pdfjsWasmDirectory, pdfjsFontDirectory, STANDARD_FONT_ASSETS } = (await import(
      /* @vite-ignore */ assetsPath
    )) as {
      pdfjsWasmDirectory: () => string;
      pdfjsFontDirectory: () => string;
      STANDARD_FONT_ASSETS: Record<string, string>;
    };

    const checked = [];
    const wanted: Array<[string, string]> = [
      ...['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'].map((name): [string, string] => [
        pdfjsWasmDirectory(),
        name,
      ]),
      ...Object.keys(STANDARD_FONT_ASSETS).map((name): [string, string] => [
        pdfjsFontDirectory(),
        name,
      ]),
    ];

    for (const [directory, name] of wanted) {
      const url = new URL(name, directory);
      const response = await fetch(url);
      const head = new Uint8Array((await response.arrayBuffer()).slice(0, 4));
      checked.push({
        name,
        sameOrigin: url.origin === location.origin,
        status: response.status,
        // Every WebAssembly module starts with \0asm; a font is not empty.
        looksRight: name.endsWith('.wasm')
          ? head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d
          : head.length === 4,
      });
    }
    return { wasm: pdfjsWasmDirectory(), fonts: pdfjsFontDirectory(), checked };
  }, ASSETS_MODULE);

  expect(new URL(reachable.wasm).origin).toBe(base);
  expect(new URL(reachable.fonts).origin).toBe(base);
  expect(reachable.checked).toHaveLength(17);
  for (const file of reachable.checked) {
    expect(file, file.name).toMatchObject({ sameOrigin: true, status: 200, looksRight: true });
  }
});
