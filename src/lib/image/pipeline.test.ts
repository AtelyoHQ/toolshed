import { describe, expect, it, vi } from 'vitest';
import {
  processImage,
  UnreadableImageError,
  type ImageCodecs,
  type ImageSettings,
} from './pipeline';
import { createRaster, setPixel, type RasterImage } from './raster';

/** A JPEG skeleton, optionally carrying an EXIF orientation tag. */
function jpegBytes(options: { orientation?: number; size?: number } = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (options.orientation !== undefined) {
    const payload = [
      0x45,
      0x78,
      0x69,
      0x66,
      0x00,
      0x00,
      0x49,
      0x49,
      0x2a,
      0x00,
      0x08,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x12,
      0x01,
      0x03,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      options.orientation,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ];
    const length = payload.length + 2;
    parts.push(0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  parts.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22);
  while (parts.length < (options.size ?? 64) - 2) parts.push(0x55);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function pngBytes(size = 64): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  while (parts.length < size) parts.push(0x21);
  return new Uint8Array(parts);
}

function picture(width = 8, height = 4, alpha = 255): RasterImage {
  const image = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPixel(image, x, y, [120, 60, 30, alpha]);
  }
  return image;
}

/**
 * Codecs whose output size is a function of quality and pixel count, so the
 * pipeline's decisions can be observed without any WebAssembly.
 */
function fakeCodecs(image: RasterImage = picture(), bytesPerPixel = 1): ImageCodecs {
  return {
    decode: vi.fn(async () => image),
    encode: vi.fn(async (img, _format, options) => {
      const size = Math.max(
        1,
        Math.round(img.width * img.height * bytesPerPixel * (options.quality / 100)),
      );
      return new Uint8Array(size);
    }),
  };
}

const BASE: ImageSettings = { format: 'keep', quality: 75 };

describe('processImage', () => {
  it('refuses a file that is not an image it knows', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0]);
    await expect(processImage(pdf, BASE, fakeCodecs())).rejects.toThrow(UnreadableImageError);
  });

  it('strips metadata without decoding when nothing else was asked for', async () => {
    const codecs = fakeCodecs();
    const result = await processImage(jpegBytes({ orientation: 1 }), BASE, codecs);
    expect(codecs.decode).not.toHaveBeenCalled();
    expect(codecs.encode).not.toHaveBeenCalled();
    expect(result.note).toMatch(/without re-encoding/i);
    expect(result.bytes.byteLength).toBeLessThan(jpegBytes({ orientation: 1 }).byteLength);
  });

  it('does decode when a pixel change was also requested', async () => {
    const codecs = fakeCodecs();
    await processImage(jpegBytes({ orientation: 1 }), { ...BASE, rotate: 90 }, codecs);
    expect(codecs.decode).toHaveBeenCalled();
    expect(codecs.encode).toHaveBeenCalled();
  });

  it('applies EXIF orientation to the pixels before the tag is discarded', async () => {
    // Orientation 6 means "rotate 90 clockwise"; an 8x4 image becomes 4x8.
    const codecs = fakeCodecs(picture(8, 4));
    const result = await processImage(
      jpegBytes({ orientation: 6 }),
      { ...BASE, format: 'webp' },
      codecs,
    );
    expect([result.width, result.height]).toEqual([4, 8]);
  });

  it('leaves the dimensions of an upright image alone', async () => {
    const codecs = fakeCodecs(picture(8, 4));
    const result = await processImage(
      jpegBytes({ orientation: 1 }),
      { ...BASE, format: 'webp' },
      codecs,
    );
    expect([result.width, result.height]).toEqual([8, 4]);
  });

  it('writes the source format when told to keep it', async () => {
    const codecs = fakeCodecs();
    const result = await processImage(pngBytes(), { ...BASE, rotate: 180 }, codecs);
    expect(result.format).toBe('png');
    expect(result.mime).toBe('image/png');
    expect(result.extension).toBe('png');
  });

  it('converts to the requested format', async () => {
    const codecs = fakeCodecs();
    const result = await processImage(pngBytes(), { ...BASE, format: 'avif' }, codecs);
    expect(result.format).toBe('avif');
    expect(result.extension).toBe('avif');
    expect(codecs.encode).toHaveBeenCalledWith(expect.anything(), 'avif', expect.anything());
  });

  it('flattens transparency onto a background when writing JPEG', async () => {
    const transparent = picture(4, 4, 0);
    const codecs = fakeCodecs(transparent);
    await processImage(pngBytes(), { ...BASE, format: 'jpeg', background: [255, 0, 0] }, codecs);
    const encoded = vi.mocked(codecs.encode).mock.calls[0]?.[0] as RasterImage;
    // Fully transparent pixels must become the background, not black.
    expect(Array.from(encoded.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('does not flatten when the target format has alpha', async () => {
    const transparent = picture(4, 4, 0);
    const codecs = fakeCodecs(transparent);
    await processImage(pngBytes(), { ...BASE, format: 'webp' }, codecs);
    const encoded = vi.mocked(codecs.encode).mock.calls[0]?.[0] as RasterImage;
    expect(encoded.data[3]).toBe(0);
  });

  it('searches for a quality when given a target size', async () => {
    const codecs = fakeCodecs(picture(100, 100), 1);
    const result = await processImage(
      pngBytes(),
      { ...BASE, format: 'jpeg', targetBytes: 4000 },
      codecs,
    );
    expect(result.bytes.byteLength).toBeLessThanOrEqual(4000);
    expect(vi.mocked(codecs.encode).mock.calls.length).toBeGreaterThan(1);
  });

  it('says so plainly when the target size could not be reached', async () => {
    const codecs = fakeCodecs(picture(100, 100), 1);
    const result = await processImage(
      pngBytes(),
      { ...BASE, format: 'jpeg', targetBytes: 2 },
      codecs,
    );
    expect(result.note).toMatch(/could not reach/i);
  });

  it('returns the original rather than a larger "compressed" file', async () => {
    // An encoder that always produces more bytes than it was given.
    const codecs: ImageCodecs = {
      decode: async () => picture(8, 4),
      encode: async () => new Uint8Array(10_000),
    };
    const original = jpegBytes({ size: 200 });
    const result = await processImage(
      original,
      { ...BASE, rotate: 0, resize: { scale: 1 } },
      codecs,
    );
    expect(result.unchanged).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(original.byteLength);
    expect(result.note).toMatch(/already well compressed/i);
  });

  it('still accepts a larger file when the format was deliberately changed', async () => {
    const codecs: ImageCodecs = {
      decode: async () => picture(8, 4),
      encode: async () => new Uint8Array(10_000),
    };
    const result = await processImage(jpegBytes({ size: 200 }), { ...BASE, format: 'png' }, codecs);
    expect(result.unchanged).toBeUndefined();
    expect(result.format).toBe('png');
  });

  it('can be told to accept growth', async () => {
    const codecs: ImageCodecs = {
      decode: async () => picture(8, 4),
      encode: async () => new Uint8Array(10_000),
    };
    const result = await processImage(
      jpegBytes({ size: 200 }),
      { ...BASE, neverGrow: false, resize: { scale: 1 } },
      codecs,
    );
    expect(result.unchanged).toBeUndefined();
    expect(result.bytes.byteLength).toBe(10_000);
  });

  it('reports progress monotonically up to 1', async () => {
    const seen: number[] = [];
    await processImage(pngBytes(), { ...BASE, format: 'webp' }, fakeCodecs(), (f) => seen.push(f));
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number);
    }
  });

  it('applies crop, rotate and resize in a predictable order', async () => {
    const codecs = fakeCodecs(picture(100, 50));
    const result = await processImage(
      pngBytes(),
      {
        ...BASE,
        format: 'webp',
        crop: { x: 0, y: 0, width: 80, height: 40 },
        rotate: 90,
        resize: { longestEdge: 20 },
      },
      codecs,
    );
    // 100x50 -> crop 80x40 -> rotate 40x80 -> longest edge 20 -> 10x20
    expect([result.width, result.height]).toEqual([10, 20]);
  });
});
