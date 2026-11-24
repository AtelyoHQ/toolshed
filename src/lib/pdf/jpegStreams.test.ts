import { PDFArray, PDFName, PDFNumber, PDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPdfWithImageXObjects, tinyJpeg } from '../../../test/pdfFixtures';
import { createRaster, type RasterImage } from '../image/raster';
import { loadDocument } from './document';
import { jpegImageStreams, recompressJpegStreams, type JpegCodec } from './jpegStreams';

/**
 * A stand-in for mozjpeg that produces a result of a size this test chose.
 *
 * The real encoder is exercised by `e2e/pdf-engine.spec.ts` in a browser. What
 * matters here is which images the walk picks up and what it writes back,
 * neither of which depends on the encoder being real — and a fake keeps these
 * tests free of WebAssembly.
 */
function codec(
  options: { outputBytes?: number; failOn?: (bytes: Uint8Array) => boolean } = {},
): JpegCodec {
  return {
    async decode(bytes) {
      if (options.failOn?.(bytes)) throw new Error('not a decodable JPEG');
      return createRaster(40, 20);
    },
    async encode(_image: RasterImage, _quality: number) {
      return new Uint8Array(options.outputBytes ?? 512).fill(0x33);
    },
  };
}

async function imageDicts(bytes: Uint8Array) {
  const doc = await loadDocument(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream)
    .map(([, object]) => (object as PDFRawStream).dict)
    .filter((dict) => dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
}

describe('jpegImageStreams', () => {
  it('finds a plain RGB JPEG image', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 9000 }) }]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(1);
  });

  it('finds an ICC-tagged JPEG with three components', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }), colorSpace: ['ICCBased', 3] },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(1);
  });

  /**
   * Every entry in an image dictionary may be an indirect reference. Reading
   * them without resolving would skip such a document's images and then tell
   * the person there was nothing worth compressing.
   */
  it('finds an image whose colour space is written as a reference', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }), colorSpace: 'DeviceRGB', indirectColorSpace: true },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(1);
  });

  it('leaves a CMYK photograph alone: an RGB encoder cannot carry its channels', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000, components: 4 }), colorSpace: 'DeviceCMYK' },
        { bytes: tinyJpeg({ size: 9000, components: 4 }), colorSpace: ['ICCBased', 4] },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });

  /**
   * `/Decode [1 0 1 0 1 0]` inverts the samples as the viewer reads them.
   * Re-encoding the decoded pixels and leaving the array in place would have
   * the viewer invert them a second time.
   */
  it('leaves an image with a Decode array alone', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }), decode: [1, 0, 1, 0, 1, 0] },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });

  it('leaves a JPEG wrapped in a filter chain alone', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }), filter: ['FlateDecode', 'DCTDecode'] },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });

  it('leaves an indexed-palette image alone', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 9000 }), colorSpace: 'Indexed' }]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });

  it('ignores a stream whose bytes are not a JPEG, whatever its filter claims', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([{ bytes: new Uint8Array(9000).fill(0x41) }]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });

  it('ignores a PNG image stream, which this strategy does not handle', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: new Uint8Array(9000).fill(0x11), filter: 'FlateDecode' },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);
  });
});

describe('recompressJpegStreams', () => {
  it('replaces an image when the re-encode is smaller, and reports it', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 9000 }) }]),
    );
    const report = await recompressJpegStreams(doc, { quality: 60 }, codec({ outputBytes: 500 }));

    expect(report).toMatchObject({ considered: 1, replaced: 1, keptLarger: 0, failed: 0 });
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
  });

  it('keeps the original image when the re-encode is no smaller', async () => {
    const original = tinyJpeg({ size: 9000 });
    const doc = await loadDocument(await buildPdfWithImageXObjects([{ bytes: original }]));
    const report = await recompressJpegStreams(doc, { quality: 95 }, codec({ outputBytes: 20000 }));

    expect(report).toMatchObject({ considered: 1, replaced: 0, keptLarger: 1 });
    expect(report.bytesAfter).toBe(report.bytesBefore);
    expect(jpegImageStreams(doc)[0]!.getContents().byteLength).toBe(original.byteLength);
  });

  it('skips images too small to be worth the round trip', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([{ bytes: tinyJpeg({ size: 1000 }) }]),
    );
    const report = await recompressJpegStreams(
      doc,
      { quality: 60, minBytes: 4096 },
      codec({ outputBytes: 10 }),
    );
    expect(report.considered).toBe(0);
  });

  it('counts an image it cannot decode and leaves the document usable', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }) },
        { bytes: tinyJpeg({ size: 9500 }) },
      ]),
    );
    const report = await recompressJpegStreams(
      doc,
      { quality: 60 },
      codec({ outputBytes: 400, failOn: (bytes) => bytes.byteLength === 9500 }),
    );

    expect(report).toMatchObject({ considered: 2, replaced: 1, failed: 1 });
  });

  /**
   * A one-channel JPEG is nearly always a soft mask, and an `/SMask` must be
   * DeviceGray: re-encoding it through a three-channel encoder means either
   * tagging it DeviceRGB — which pdf.js refuses with "Reading gray scale from
   * a color image" — or lying about the channel count. The transparency of a
   * logo is not worth the handful of bytes.
   */
  it('leaves a grey image alone, because it is probably a soft mask', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000, components: 1 }), colorSpace: 'DeviceGray' },
      ]),
    );
    expect(jpegImageStreams(doc)).toHaveLength(0);

    const report = await recompressJpegStreams(doc, { quality: 60 }, codec({ outputBytes: 600 }));
    expect(report.considered).toBe(0);
    const [dict] = await imageDicts(await doc.save({ useObjectStreams: true }));
    expect(dict!.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'));
  });

  it('rewrites the dictionary to describe the bytes it just wrote', async () => {
    const bytes = await buildPdfWithImageXObjects([
      {
        bytes: tinyJpeg({ size: 9000 }),
        colorSpace: 'DeviceRGB',
        width: 40,
        height: 20,
      },
    ]);
    const doc = await loadDocument(bytes);
    await recompressJpegStreams(doc, { quality: 60 }, codec({ outputBytes: 600 }));

    const [dict] = await imageDicts(await doc.save({ useObjectStreams: true }));
    expect(dict!.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceRGB'));
    expect(dict!.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect(dict!.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber()).toBe(8);
    expect(dict!.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber()).toBe(40);
    expect(dict!.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber()).toBe(20);
    // Set by the writer from the new contents; a stale Length truncates the
    // image in every reader.
    expect(dict!.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber()).toBe(600);
  });

  /**
   * mozjpeg neither applies nor strips an ICC profile: the samples come back
   * in the space they were in. Re-tagging an Adobe RGB photograph as sRGB
   * would leave the pixels alone and tell every reader they mean something
   * else — a visible colour shift in a file this engine said it had only
   * recompressed.
   */
  it('keeps a three-channel colour profile rather than re-tagging the image sRGB', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }), colorSpace: ['ICCBased', 3] },
      ]),
    );
    await recompressJpegStreams(doc, { quality: 60 }, codec({ outputBytes: 600 }));

    const [dict] = await imageDicts(await doc.save({ useObjectStreams: true }));
    const space = dict!.lookup(PDFName.of('ColorSpace'), PDFArray);
    expect(space.get(0)).toBe(PDFName.of('ICCBased'));
  });

  it('reports progress from start to finish', async () => {
    const doc = await loadDocument(
      await buildPdfWithImageXObjects([
        { bytes: tinyJpeg({ size: 9000 }) },
        { bytes: tinyJpeg({ size: 9100 }) },
      ]),
    );
    const seen: number[] = [];
    await recompressJpegStreams(doc, { quality: 60 }, codec({ outputBytes: 500 }), (fraction) =>
      seen.push(fraction),
    );

    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
  });
});
