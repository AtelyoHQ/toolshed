import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPdf,
  buildHairlinePdf,
  buildPdf,
  buildScanPdf,
  buildPdfWithImageXObjects,
  buildPdfWithMetadata,
  everythingIn,
  tinyJpeg,
} from '../../../test/pdfFixtures';
import { createRaster } from '../image/raster';
import { compressPdf, decideResult } from './compress';
import { loadDocument, saveDocument } from './document';
import { PdfOperationError } from './errors';
import type { JpegCodec } from './jpegStreams';
import type { PdfRasterizer } from './render';

function codec(outputBytes: number): JpegCodec {
  return {
    async decode() {
      return createRaster(40, 20);
    },
    async encode() {
      return new Uint8Array(outputBytes).fill(0x33);
    },
  };
}

/** Renders each page as a 150-by-300 pixel "JPEG", whatever the page holds. */
function rasterizer(options: { bytesPerPage?: number } = {}): PdfRasterizer {
  return {
    async rasterize(request, onPage) {
      for (const page of request.pages) {
        await onPage({
          page,
          bytes: tinyJpeg({ width: 150, height: 300, size: options.bytesPerPage ?? 400 }),
          mime: 'image/jpeg',
          width: 150,
          height: 300,
          ink: true,
        });
      }
    },
  };
}

describe('decideResult', () => {
  /** A real document, since the fallback below has to be able to re-save it. */
  const original = () => buildPdfWithMetadata();

  it('returns the compressed bytes when they are smaller', async () => {
    const result = await decideResult(await original(), new Uint8Array(40), 1, {}, 'did something');
    expect(result.bytes.byteLength).toBe(40);
    expect(result.note).toBe('did something');
    expect(result.unchanged).toBeUndefined();
  });

  /**
   * The promise the whole feature rests on. An already-optimised PDF comes out
   * larger from either strategy, and handing that back as a success is how
   * these tools lose people's trust.
   */
  it('does not hand back something bigger than it was given', async () => {
    const input = await original();
    const result = await decideResult(input, new Uint8Array(input.byteLength + 40), 1, {}, 'x');

    expect(result.unchanged).toBe(true);
    expect(result.bytes.byteLength).toBeLessThan(input.byteLength + 40);
  });

  /**
   * Compressing here also means dropping the metadata, and that part always
   * works. Returning the raw input would silently keep the author and the
   * producing application on exactly the files the engine decided not to
   * recompress.
   */
  it('still removes the metadata from the document it decided not to touch', async () => {
    const input = await original();
    const result = await decideResult(input, new Uint8Array(input.byteLength + 40), 1, {}, 'x');

    // Decompressed, because the information dictionary ends up inside an
    // object stream where neither pdf-lib's getters nor a grep can see it.
    const everything = await everythingIn(result.bytes);
    for (const marker of ['A Person', 'Quarterly figures', 'D:20200101', 'dc:creator']) {
      expect(everything, marker).not.toContain(marker);
    }
    expect(result.note).toMatch(/metadata was still removed/);
  });

  it('counts an exactly equal result as not worth taking', async () => {
    const input = await original();
    const result = await decideResult(input, new Uint8Array(input.byteLength), 1, {}, 'x');
    expect(result.unchanged).toBe(true);
  });

  it('can be told to return the compressed bytes regardless', async () => {
    const input = await original();
    const result = await decideResult(
      input,
      new Uint8Array(input.byteLength + 40),
      1,
      { neverGrow: false },
      'x',
    );
    expect(result.bytes.byteLength).toBe(input.byteLength + 40);
  });

  /**
   * The branch that was missed: a document that arrives with a password and
   * does not shrink still has to come back as a file someone can open, and
   * still has to say the password did not survive.
   */
  it('returns an openable file, and says the password is gone, for a locked document', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    const result = await decideResult(
      locked,
      new Uint8Array(locked.byteLength + 40),
      1,
      { password: 'open-me' },
      'x',
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.note).toMatch(/anyone with this file can open it/);
  });

  it('hands back the original when even stripping it does not help', async () => {
    // Already through this engine once, so it has no metadata left to drop
    // and nothing orphaned to sweep: saving it again cannot be smaller.
    const input = await saveDocument(
      await loadDocument(await buildPdf([{ width: 10, height: 10 }])),
    );
    const result = await decideResult(input, new Uint8Array(input.byteLength + 40), 1, {}, 'x');

    expect(result.bytes).toBe(input);
    expect(result.note).toMatch(/would have made it larger/);
  });
});

describe('compressPdf, re-encoding images', () => {
  it('shrinks a document whose weight is in its photographs', async () => {
    const original = await buildPdfWithImageXObjects([
      { bytes: tinyJpeg({ size: 40000 }) },
      { bytes: tinyJpeg({ size: 40000 }) },
    ]);
    const result = await compressPdf(
      original,
      { strategy: 'images', quality: 60 },
      { jpeg: codec(1000) },
    );

    expect(result.bytes.byteLength).toBeLessThan(original.byteLength);
    expect(result.note).toMatch(/Re-encoded 2 of 2 images/);
    expect(result.note).toMatch(/text and vector graphics were left alone/);
  });

  it('keeps the pages it was given', async () => {
    const original = await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 40000 }) }]);
    const result = await compressPdf(
      original,
      { strategy: 'images', quality: 60 },
      { jpeg: codec(1000) },
    );

    const doc = await loadDocument(result.bytes);
    expect(result.pages).toBe(1);
    expect(doc.getPageCount()).toBe(1);
  });

  it('removes the metadata, which is part of what compression means here', async () => {
    const original = await buildPdfWithMetadata();
    const result = await compressPdf(
      original,
      // Nothing to re-encode, so the saving has to come from the metadata and
      // the object streams — which is exactly the case being asserted.
      { strategy: 'images', quality: 60, neverGrow: false },
      { jpeg: codec(10) },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
  });

  it('says plainly when there was nothing worth re-encoding', async () => {
    const result = await compressPdf(
      await buildPdf([{ width: 200, height: 200, text: 'All text, no pictures' }]),
      { strategy: 'images', quality: 60, neverGrow: false },
      { jpeg: codec(10) },
    );
    expect(result.note).toMatch(/all text has nothing here to give/);
  });

  it('reports the images it left as it found them', async () => {
    const original = await buildPdfWithImageXObjects([
      { bytes: tinyJpeg({ size: 9000 }) },
      { bytes: tinyJpeg({ size: 9100 }) },
    ]);
    const result = await compressPdf(
      original,
      { strategy: 'images', quality: 95, neverGrow: false },
      { jpeg: codec(30000) },
    );

    expect(result.note).toMatch(/Re-encoded 0 of 2 images/);
    expect(result.note).toMatch(/already smaller than this quality/);
  });

  it('returns the original when re-encoding would not pay for itself', async () => {
    const original = await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 9000 }) }]);
    const result = await compressPdf(
      original,
      { strategy: 'images', quality: 95 },
      { jpeg: codec(30000) },
    );

    expect(result.unchanged).toBe(true);
    expect(result.bytes).toBe(original);
  });

  /**
   * As in the page operations: without the cleanup at the end of this path,
   * compressing a password-protected document writes a file that nobody —
   * pdf-lib included — can open again.
   */
  it('leaves a document that had a password openable without one', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    const result = await compressPdf(
      locked,
      { strategy: 'images', quality: 60, password: 'open-me', neverGrow: false },
      { jpeg: codec(10) },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.note).toMatch(/anyone with this file can open it/);
  });

  it('refuses a quality outside 1..100', async () => {
    const original = await buildPdf([{ width: 10, height: 10 }]);
    await expect(
      compressPdf(original, { strategy: 'images', quality: 0 }, { jpeg: codec(1) }),
    ).rejects.toThrow(PdfOperationError);
    await expect(
      compressPdf(original, { strategy: 'images', quality: 101 }, { jpeg: codec(1) }),
    ).rejects.toThrow(PdfOperationError);
  });
});

describe('compressPdf, rasterising', () => {
  it('rebuilds every page as a picture of itself', async () => {
    const original = await buildPdf([
      { width: 200, height: 400, text: 'one' },
      { width: 200, height: 400, text: 'two' },
    ]);
    const result = await compressPdf(
      original,
      { strategy: 'rasterize', quality: 70, dpi: 150, neverGrow: false },
      { jpeg: codec(1), rasterizer: rasterizer() },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(result.note).toMatch(/redrawn at 150 dpi/);
    expect(result.note).toMatch(/cannot be selected, searched or copied/);
  });

  /**
   * The render is a picture *of* a page, so its pixels have to come back to
   * points at the resolution they were drawn at. Get this wrong and every
   * page of the result is a different size from the page it replaced.
   */
  it('gives each rebuilt page the size the render says it had', async () => {
    const result = await compressPdf(
      await buildPdf([{ width: 72, height: 144 }]),
      { strategy: 'rasterize', quality: 70, dpi: 150, neverGrow: false },
      { jpeg: codec(1), rasterizer: rasterizer() },
    );

    const doc = await loadDocument(result.bytes);
    // 150 by 300 pixels at 150 dpi is one inch by two.
    expect(doc.getPage(0).getSize()).toEqual({ width: 72, height: 144 });
  });

  /**
   * The failure this guard exists for, and it is not hypothetical: before the
   * character maps were bundled, a Japanese document rasterised to empty pages
   * and came back as a saving. pdf.js degrades by drawing nothing, so every
   * other check here would have called that a success.
   */
  it('refuses a result whose every page came out blank', async () => {
    const drawsNothing: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const page of request.pages) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 80, height: 160, size: 400 }),
            mime: 'image/jpeg',
            width: 80,
            height: 160,
            ink: false,
          });
        }
      },
    };

    await expect(
      compressPdf(
        await buildPdf([{ width: 200, height: 200, text: 'something to lose' }]),
        { strategy: 'rasterize', quality: 70, neverGrow: false },
        { jpeg: codec(1), rasterizer: drawsNothing },
      ),
    ).rejects.toThrow(/Every page rendered blank/);
  });

  /**
   * The document rasterising is *for*, and the one the first version of this
   * guard let through: a scanned page paints one full-page image with a
   * content stream of thirty bytes, so anything deciding "there was something
   * to lose" by content length reports a scan as empty. A 40 MB scan whose
   * image codec failed to load would have come back blank and been called a
   * saving.
   */
  it('refuses a blank render of a scan, whose content stream is thirty bytes', async () => {
    const drawsNothing: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const page of request.pages) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 80, height: 160, size: 400 }),
            mime: 'image/jpeg',
            width: 80,
            height: 160,
            ink: false,
          });
        }
      },
    };

    await expect(
      compressPdf(
        await buildScanPdf(),
        { strategy: 'rasterize', quality: 70, neverGrow: false },
        { jpeg: codec(1), rasterizer: drawsNothing },
      ),
    ).rejects.toThrow(/Every page rendered blank/);
  });

  /**
   * The precondition the hairline end-to-end test depends on and cannot check.
   *
   * That test proves `hasInk` finds a mark no strided scan would; it can only
   * prove it because this document counts as having something to paint, which
   * it does on the length of its content stream alone — it names no font and no
   * image. If that ever stops being true the guard goes quiet for this page and
   * the end-to-end test passes however blind the renderer has become. So the
   * claim is pinned here, where a fake renderer can state it outright.
   */
  it('counts a page of hairlines as having something to paint', async () => {
    const drawsNothing: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const page of request.pages) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 80, height: 80, size: 400 }),
            mime: 'image/jpeg',
            width: 80,
            height: 80,
            ink: false,
          });
        }
      },
    };

    await expect(
      compressPdf(
        await buildHairlinePdf(),
        { strategy: 'rasterize', quality: 70, neverGrow: false },
        { jpeg: codec(1), rasterizer: drawsNothing },
      ),
    ).rejects.toThrow(/Every page rendered blank/);
  });

  /**
   * Load-bearing for the whole guard: `ink` is optional and absent means "not
   * measured", so if this request ever stopped asking, every page would count
   * as inked and the refusal above could never fire again — with every test
   * here still green, because they all supply `ink` themselves.
   */
  it('asks the renderer to measure ink, since nothing else can', async () => {
    const asked: Array<boolean | undefined> = [];
    const rasterizer: PdfRasterizer = {
      async rasterize(request, onPage) {
        asked.push(request.measureInk);
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

    await compressPdf(
      await buildPdf([{ width: 200, height: 200, text: 'x' }]),
      { strategy: 'rasterize', quality: 70, neverGrow: false },
      { jpeg: codec(1), rasterizer },
    );
    expect(asked).toEqual([true]);
  });

  it('allows a blank page from a document that is actually blank', async () => {
    const drawsNothing: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const page of request.pages) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 80, height: 160, size: 400 }),
            mime: 'image/jpeg',
            width: 80,
            height: 160,
            ink: false,
          });
        }
      },
    };

    // This page paints nothing and names nothing, so there is nothing a
    // renderer could have failed to draw. Refusing it would be refusing the
    // truth. (A *scanned* blank page names an image XObject and is refused —
    // see `hasDrawableContent`, which explains why that is the right trade.)
    const result = await compressPdf(
      await buildPdf([{ width: 200, height: 200 }]),
      { strategy: 'rasterize', quality: 70, neverGrow: false },
      { jpeg: codec(1), rasterizer: drawsNothing },
    );
    expect(result.pages).toBe(1);
  });

  it('accepts a document where only some pages are blank', async () => {
    const firstPageOnly: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const [index, page] of request.pages.entries()) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 80, height: 160, size: 400 }),
            mime: 'image/jpeg',
            width: 80,
            height: 160,
            ink: index === 0,
          });
        }
      },
    };

    const result = await compressPdf(
      await buildPdf([
        { width: 200, height: 200, text: 'page one' },
        { width: 200, height: 200, text: 'page two' },
      ]),
      { strategy: 'rasterize', quality: 70, neverGrow: false },
      { jpeg: codec(1), rasterizer: firstPageOnly },
    );
    expect(result.pages).toBe(2);
  });

  it('refuses to return a document with pages missing', async () => {
    const skipsAPage: PdfRasterizer = {
      async rasterize(request, onPage) {
        for (const page of request.pages.slice(1)) {
          await onPage({
            page,
            bytes: tinyJpeg({ width: 10, height: 10, size: 300 }),
            mime: 'image/jpeg',
            width: 10,
            height: 10,
            ink: true,
          });
        }
      },
    };

    await expect(
      compressPdf(
        await buildPdf([
          { width: 10, height: 10 },
          { width: 10, height: 10 },
        ]),
        { strategy: 'rasterize', quality: 70 },
        { jpeg: codec(1), rasterizer: skipsAPage },
      ),
    ).rejects.toThrow(/pages missing/);
  });

  it('returns the original when the rasters come out bigger than the document', async () => {
    const original = await buildPdf([{ width: 200, height: 400, text: 'tiny text document' }]);
    const result = await compressPdf(
      original,
      { strategy: 'rasterize', quality: 90, dpi: 150 },
      { jpeg: codec(1), rasterizer: rasterizer({ bytesPerPage: 60000 }) },
    );

    expect(result.unchanged).toBe(true);
    expect(result.bytes).toBe(original);
  });

  it('refuses to rasterise without a renderer, rather than returning the input', async () => {
    await expect(
      compressPdf(
        await buildPdf([{ width: 10, height: 10 }]),
        { strategy: 'rasterize', quality: 70 },
        { jpeg: codec(1) },
      ),
    ).rejects.toThrow(PdfOperationError);
  });

  it('refuses a resolution outside what a page can be rendered at', async () => {
    await expect(
      compressPdf(
        await buildPdf([{ width: 10, height: 10 }]),
        { strategy: 'rasterize', quality: 70, dpi: 2400 },
        { jpeg: codec(1), rasterizer: rasterizer() },
      ),
    ).rejects.toThrow(/dpi/);
  });

  it('reports progress from start to finish', async () => {
    const seen: number[] = [];
    await compressPdf(
      await buildPdf([
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ]),
      { strategy: 'rasterize', quality: 70, neverGrow: false },
      { jpeg: codec(1), rasterizer: rasterizer() },
      (fraction) => seen.push(fraction),
    );

    expect(seen.at(-1)).toBe(1);
    expect(seen.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
  });
});
