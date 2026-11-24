import { describe, expect, it } from 'vitest';
import {
  buildPdf,
  latin1,
  pageOperators,
  tinyJpeg,
  tinyJpegWithExif,
  tinyJpegWithOrientation,
  tinyPng,
} from '../../../test/pdfFixtures';
import { imagesToPdf, pdfToImages, pdfToText, placeImage } from './convert';
import { loadDocument } from './document';
import { PageSelectionError, PdfOperationError } from './errors';
import type { PdfRasterizer, PdfTextReader, RenderedPage } from './render';

/** Renders a flat "image" whose size records the scale it was asked for. */
function rasterizer(): PdfRasterizer & { calls: Array<{ pages: readonly number[]; dpi: number }> } {
  const calls: Array<{ pages: readonly number[]; dpi: number }> = [];
  return {
    calls,
    async rasterize(request, onPage) {
      calls.push({ pages: request.pages, dpi: request.dpi });
      for (const page of request.pages) {
        await onPage({
          page,
          bytes: tinyJpeg({ width: 100, height: 200, size: 300 }),
          mime: 'image/jpeg',
          width: 100,
          height: 200,
          ink: true,
        });
      }
    },
  };
}

function textReader(pages: Record<number, string>): PdfTextReader {
  return {
    async extract(request) {
      return request.pages.map((page) => pages[page] ?? '');
    },
  };
}

async function sizesOf(bytes: Uint8Array): Promise<Array<{ width: number; height: number }>> {
  const doc = await loadDocument(bytes);
  return doc.getPages().map((page) => page.getSize());
}

describe('placeImage', () => {
  it('fits a wide image inside a tall page without cropping it', () => {
    const placed = placeImage(
      { width: 200, height: 100 },
      { width: 100, height: 400 },
      'contain',
      0,
    );
    expect(placed).toEqual({ x: 0, y: 175, width: 100, height: 50 });
  });

  it('fills the page when asked to cover, letting the overflow fall off the edge', () => {
    const placed = placeImage({ width: 200, height: 100 }, { width: 100, height: 400 }, 'cover', 0);
    expect(placed).toEqual({ x: -350, y: 0, width: 800, height: 400 });
  });

  it('centres the image inside the margins, not inside the page', () => {
    const placed = placeImage(
      { width: 10, height: 10 },
      { width: 100, height: 100 },
      'contain',
      20,
    );
    expect(placed).toEqual({ x: 20, y: 20, width: 60, height: 60 });
  });

  it('refuses a margin that leaves no room at all', () => {
    expect(() =>
      placeImage({ width: 10, height: 10 }, { width: 100, height: 100 }, 'contain', 50),
    ).toThrow(PdfOperationError);
  });
});

/**
 * Where a corner of the image lands on the page, from the transformation
 * matrices the page's content stream applies before it draws the picture.
 * `(0, 1)` is the image's own top-left, `(1, 1)` its top-right.
 */
async function landing(bytes: Uint8Array, corner: [number, number]): Promise<[number, number]> {
  const operators = await pageOperators(bytes, 0);
  const matrices = [...operators.matchAll(/((?:-?[\d.]+(?:e-?\d+)?\s+){6})cm/g)].map((match) =>
    match[1]!.trim().split(/\s+/).map(Number),
  );
  let [x, y] = corner;
  // Concatenation: the last matrix in the stream is the first applied.
  for (const [a, b, c, d, e, f] of matrices.reverse() as Array<
    [number, number, number, number, number, number]
  >) {
    [x, y] = [a * x + c * y + e, b * x + d * y + f];
  }
  return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
}

describe('imagesToPdf orientation', () => {
  // A 300 by 150 sensor image. Held upright, a phone writes this with a tag
  // saying how far to turn it, and the tag is stripped before embedding.
  const photo = (orientation: number) =>
    tinyJpegWithOrientation(orientation, { width: 300, height: 150 });
  const options = { sizing: { mode: 'image' } } as const;

  it('makes a page the shape the photograph is shown in', async () => {
    const result = await imagesToPdf([{ bytes: photo(6) }], options);
    expect(await sizesOf(result.bytes)).toEqual([{ width: 150, height: 300 }]);
  });

  it('turns a photograph a quarter clockwise, its top going to the right', async () => {
    const { bytes } = await imagesToPdf([{ bytes: photo(6) }], options);
    expect(await landing(bytes, [0, 1])).toEqual([150, 300]);
    expect(await landing(bytes, [1, 1])).toEqual([150, 0]);
    expect(await landing(bytes, [0, 0])).toEqual([0, 300]);
  });

  it('turns it a half, and three quarters', async () => {
    const half = (await imagesToPdf([{ bytes: photo(3) }], options)).bytes;
    expect(await sizesOf(half)).toEqual([{ width: 300, height: 150 }]);
    expect(await landing(half, [0, 1])).toEqual([300, 0]);

    const back = (await imagesToPdf([{ bytes: photo(8) }], options)).bytes;
    expect(await sizesOf(back)).toEqual([{ width: 150, height: 300 }]);
    expect(await landing(back, [0, 1])).toEqual([0, 0]);
    expect(await landing(back, [1, 1])).toEqual([0, 300]);
  });

  it('leaves an upright photograph where it was', async () => {
    const { bytes } = await imagesToPdf([{ bytes: photo(1) }], options);
    expect(await landing(bytes, [0, 1])).toEqual([0, 150]);
    expect(await landing(bytes, [1, 0])).toEqual([300, 0]);
  });

  it('fits a turned photograph inside a fixed page by its shown shape', async () => {
    const { bytes } = await imagesToPdf([{ bytes: photo(6) }], {
      sizing: { mode: 'fixed', width: 200, height: 400, fit: 'contain' },
    });
    // 150 by 300 shown, scaled to the page's 200 width: 200 by 400, filling it.
    expect(await landing(bytes, [0, 1])).toEqual([200, 400]);
    expect(await landing(bytes, [1, 0])).toEqual([0, 0]);
  });

  it('refuses a mirrored photograph and names it', async () => {
    await expect(imagesToPdf([{ bytes: photo(5), name: 'selfie.jpg' }], options)).rejects.toThrow(
      /selfie\.jpg is stored mirrored/,
    );
  });
});

describe('imagesToPdf', () => {
  it('gives each page the size of its own image', async () => {
    const result = await imagesToPdf(
      [
        { bytes: tinyJpeg({ width: 300, height: 150 }) },
        { bytes: tinyJpeg({ width: 100, height: 400 }) },
      ],
      { sizing: { mode: 'image' } },
    );

    expect(result.pages).toBe(2);
    expect(await sizesOf(result.bytes)).toEqual([
      { width: 300, height: 150 },
      { width: 100, height: 400 },
    ]);
  });

  it('reads the image at the resolution asked for, so 300 dpi gives a printable page', async () => {
    const result = await imagesToPdf([{ bytes: tinyJpeg({ width: 300, height: 600 }) }], {
      sizing: { mode: 'image' },
      dpi: 300,
    });
    // 300 px at 300 dpi is one inch, and an inch is 72 points.
    expect(await sizesOf(result.bytes)).toEqual([{ width: 72, height: 144 }]);
  });

  it('adds the margin to the page rather than shrinking the image into it', async () => {
    const result = await imagesToPdf([{ bytes: tinyJpeg({ width: 100, height: 100 }) }], {
      sizing: { mode: 'image' },
      margin: 10,
    });
    expect(await sizesOf(result.bytes)).toEqual([{ width: 120, height: 120 }]);
  });

  it('puts every image on a page of the size asked for', async () => {
    const result = await imagesToPdf(
      [{ bytes: tinyJpeg({ width: 300, height: 150 }) }, { bytes: tinyPng(40, 90) }],
      { sizing: { mode: 'fixed', width: 595, height: 842, fit: 'contain' }, margin: 20 },
    );

    expect(await sizesOf(result.bytes)).toEqual([
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ]);
  });

  it('embeds a PNG as well as a JPEG', async () => {
    const result = await imagesToPdf([{ bytes: tinyPng(12, 8) }], { sizing: { mode: 'image' } });
    expect(await sizesOf(result.bytes)).toEqual([{ width: 12, height: 8 }]);
  });

  /**
   * The operation people reach for with a camera roll, so the one most likely
   * to publish a location. The image engine removes this by default and the
   * PDF side has no business being the exception.
   */
  it("removes the photograph's EXIF, which is where the GPS tag lives", async () => {
    const photo = tinyJpegWithExif();
    expect(latin1(photo)).toContain('GPSLatitude');

    const result = await imagesToPdf([{ bytes: photo }], { sizing: { mode: 'image' } });
    const text = latin1(result.bytes);
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('CAMERA-SERIAL-123');
  });

  it('refuses a format pdf-lib cannot embed, naming the file', async () => {
    await expect(
      imagesToPdf([{ bytes: new Uint8Array([0x42, 0x4d, 0x00]), name: 'scan.bmp' }], {
        sizing: { mode: 'image' },
      }),
    ).rejects.toThrow(/scan\.bmp is not a JPEG or PNG/);
  });

  it('refuses an empty list of images', async () => {
    await expect(imagesToPdf([], { sizing: { mode: 'image' } })).rejects.toThrow(PdfOperationError);
  });

  it('refuses a negative margin', async () => {
    await expect(
      imagesToPdf([{ bytes: tinyJpeg() }], { sizing: { mode: 'image' }, margin: -1 }),
    ).rejects.toThrow(PdfOperationError);
  });
});

describe('pdfToImages', () => {
  it('renders every page when none are named', async () => {
    const render = rasterizer();
    const images = await pdfToImages(
      await buildPdf([
        { width: 100, height: 100 },
        { width: 100, height: 100 },
      ]),
      { dpi: 150, format: 'jpeg' },
      render,
    );

    expect(images.map((image) => image.page)).toEqual([1, 2]);
    expect(render.calls[0]).toEqual({ pages: [1, 2], dpi: 150 });
  });

  it('renders only the pages named, sorted', async () => {
    const render = rasterizer();
    await pdfToImages(
      await buildPdf([
        { width: 10, height: 10 },
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ]),
      { dpi: 72, format: 'png', pages: [3, 1] },
      render,
    );
    expect(render.calls[0]!.pages).toEqual([1, 3]);
  });

  /**
   * Checked against the document's structure before pdf.js is started: this
   * fails in milliseconds with a sentence about the document, rather than
   * part-way through a render.
   */
  it('refuses a page the document does not have, without rendering anything', async () => {
    const render = rasterizer();
    await expect(
      pdfToImages(
        await buildPdf([{ width: 10, height: 10 }]),
        { dpi: 72, format: 'jpeg', pages: [5] },
        render,
      ),
    ).rejects.toThrow(PageSelectionError);
    expect(render.calls).toHaveLength(0);
  });

  it('refuses a resolution that would exhaust the tab', async () => {
    await expect(
      pdfToImages(
        await buildPdf([{ width: 10, height: 10 }]),
        { dpi: 4000, format: 'jpeg' },
        rasterizer(),
      ),
    ).rejects.toThrow(/between 12 and 600 dpi/);
  });

  it('reports progress as each page is finished', async () => {
    const seen: number[] = [];
    await pdfToImages(
      await buildPdf([
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ]),
      { dpi: 72, format: 'jpeg' },
      rasterizer(),
      (fraction) => seen.push(fraction),
    );
    expect(seen).toEqual([0.5, 1]);
  });

  it('passes the rendered pixel size through, which the caller needs to size a page', async () => {
    const images: RenderedPage[] = await pdfToImages(
      await buildPdf([{ width: 10, height: 10 }]),
      { dpi: 300, format: 'jpeg', quality: 70 },
      rasterizer(),
    );
    expect(images[0]).toMatchObject({ width: 100, height: 200, mime: 'image/jpeg' });
  });
});

describe('pdfToText', () => {
  it('separates pages with a blank line', async () => {
    const result = await pdfToText(
      await buildPdf([
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ]),
      {},
      textReader({ 1: 'First page.\n', 2: 'Second page.\n' }),
    );

    expect(result.text).toBe('First page.\n\nSecond page.');
    expect(result.pages).toBe(2);
    expect(result.note).toBeUndefined();
  });

  it('reads only the pages named', async () => {
    const result = await pdfToText(
      await buildPdf([
        { width: 10, height: 10 },
        { width: 10, height: 10 },
      ]),
      { pages: [2] },
      textReader({ 1: 'First', 2: 'Second' }),
    );
    expect(result.text).toBe('Second');
  });

  /**
   * The commonest surprise with this tool: a scan has no text layer, and the
   * useful answer is why, not an empty file.
   */
  it('says so when the document has no text layer at all', async () => {
    const result = await pdfToText(await buildPdf([{ width: 10, height: 10 }]), {}, textReader({}));
    expect(result.text).toBe('');
    expect(result.note).toMatch(/no text layer/i);
  });
});
