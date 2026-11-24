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
    // recompress, not a no-op resize: asking for geometry now deliberately
    // disables this guard, because a rotation must happen even when the
    // result comes out bigger.
    const result = await processImage(original, { ...BASE, recompress: true }, codecs);
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
      { ...BASE, neverGrow: false, recompress: true },
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

describe('the metadata-only fast path knows when it must not be taken', () => {
  it('decodes and rotates a photo that carries an orientation tag', () => {
    // The whole point of the fast path is to avoid a generation of quality
    // loss. But dropping the orientation tag while leaving the pixels alone
    // turns every portrait phone photo on its side — and a portrait phone
    // photo is exactly what this feature gets used on.
    const codecs = fakeCodecs(picture(8, 4));
    return processImage(jpegBytes({ orientation: 6 }), BASE, codecs).then((result) => {
      expect(codecs.decode).toHaveBeenCalled();
      expect(codecs.encode).toHaveBeenCalled();
      expect([result.width, result.height]).toEqual([4, 8]);
    });
  });

  it('still takes it for an upright photo', async () => {
    const codecs = fakeCodecs();
    const result = await processImage(jpegBytes({ orientation: 1 }), BASE, codecs);
    expect(codecs.decode).not.toHaveBeenCalled();
    expect(result.note).toMatch(/without re-encoding/i);
  });

  it('re-encodes a multi-picture file instead of claiming the location is gone', async () => {
    // Samsung and Apple append whole extra JPEGs after the primary one, each
    // with its own GPS. A marker walk over the primary image never sees them.
    const one = jpegBytes({ orientation: 1 });
    const two = new Uint8Array(one.length * 2);
    two.set(one, 0);
    two.set(one, one.length);

    const codecs = fakeCodecs();
    await processImage(two, BASE, codecs);
    expect(codecs.decode).toHaveBeenCalled();
  });

  it('reports the real dimensions rather than zeros', async () => {
    // Read from the header without decoding; a row showing 0x0 is useless.
    const withSof = (() => {
      const parts: number[] = [0xff, 0xd8];
      const payload = [0x08, 0x00, 0x40, 0x00, 0x80, 0x03];
      parts.push(0xff, 0xc0, 0x00, payload.length + 2, ...payload);
      const exif = [
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00,
        0x00,
      ];
      parts.push(0xff, 0xe1, 0x00, exif.length + 2, ...exif);
      parts.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9);
      return new Uint8Array(parts);
    })();

    const result = await processImage(withSof, BASE, fakeCodecs());
    expect([result.width, result.height]).toEqual([128, 64]);
  });
});

describe('keeping metadata', () => {
  it('changes nothing at all when that is what was asked for', async () => {
    // Re-encoding would cost a generation of quality and drop the metadata
    // anyway, since the encoders do not carry it — the opposite of the ask.
    const codecs = fakeCodecs();
    const original = jpegBytes({ orientation: 1 });
    const result = await processImage(original, { ...BASE, stripMetadata: false }, codecs);

    expect(codecs.decode).not.toHaveBeenCalled();
    expect(codecs.encode).not.toHaveBeenCalled();
    expect(result.bytes).toBe(original);
    expect(result.unchanged).toBe(true);
  });

  it('does not block a real edit', async () => {
    const codecs = fakeCodecs();
    await processImage(
      jpegBytes({ orientation: 1 }),
      { ...BASE, stripMetadata: false, rotate: 90 },
      codecs,
    );
    expect(codecs.encode).toHaveBeenCalled();
  });
});

describe('reporting a downscale', () => {
  it('reports the dimensions it actually encoded, and says it shrank the image', async () => {
    // Resolution is the most visible thing this engine can take away, and it
    // was taken to meet a budget the person set. Reporting the original size
    // would be telling them it did not happen.
    const codecs = fakeCodecs(picture(400, 300), 1);
    const result = await processImage(
      pngBytes(),
      { ...BASE, format: 'jpeg', targetBytes: 3000 },
      codecs,
    );

    expect(result.width).toBeLessThan(400);
    expect(result.height).toBeLessThan(300);
    expect(result.note).toMatch(/resized to/i);
  });

  it('says nothing about resizing when it did not resize', async () => {
    const codecs = fakeCodecs(picture(100, 100), 1);
    const result = await processImage(
      pngBytes(),
      { ...BASE, format: 'jpeg', targetBytes: 8000 },
      codecs,
    );
    expect(result.note ?? '').not.toMatch(/resized/i);
  });
});

describe('a tool whose job is re-encoding', () => {
  it('compresses a photo that carries EXIF, instead of only stripping it', async () => {
    // This is every photo from a phone. Without an explicit re-encode flag,
    // "keep the format, quality 20, strip the metadata" is indistinguishable
    // from "just strip the metadata", the fast path wins, and Compress hands
    // back the input reporting a 0% saving.
    const codecs = fakeCodecs();
    const result = await processImage(
      jpegBytes({ orientation: 1 }),
      { ...BASE, quality: 20, recompress: true },
      codecs,
    );

    expect(codecs.encode).toHaveBeenCalled();
    expect(result.note ?? '').not.toMatch(/without re-encoding/i);
  });

  it('leaves the fast path to the tool that only strips metadata', async () => {
    const codecs = fakeCodecs();
    await processImage(jpegBytes({ orientation: 1 }), BASE, codecs);
    expect(codecs.encode).not.toHaveBeenCalled();
  });
});

describe('a geometry change is not optional', () => {
  it('rotates even when the rotated file comes out larger', async () => {
    // Most images on a disk are already compressed, so a re-encode usually
    // grows them. A guard written for compression used to swallow the
    // rotation and report Done on an unrotated file.
    const codecs: ImageCodecs = {
      decode: async () => picture(8, 4),
      encode: async () => new Uint8Array(10_000),
    };
    const result = await processImage(
      jpegBytes({ size: 200 }),
      { ...BASE, recompress: true, rotate: 90 },
      codecs,
    );

    expect(result.unchanged).toBeUndefined();
    expect([result.width, result.height]).toEqual([4, 8]);
    expect(result.bytes.byteLength).toBe(10_000);
  });

  it('does the same for a mirror, a crop and a resize', async () => {
    const codecs: ImageCodecs = {
      decode: async () => picture(8, 4),
      encode: async () => new Uint8Array(10_000),
    };

    for (const settings of [
      { flip: 'horizontal' as const },
      { crop: { x: 0, y: 0, width: 4, height: 2 } },
      { resize: { longestEdge: 4 } },
    ]) {
      const result = await processImage(
        jpegBytes({ size: 200 }),
        { ...BASE, recompress: true, ...settings },
        codecs,
      );
      expect(result.unchanged, JSON.stringify(settings)).toBeUndefined();
    }
  });
});

describe('the never-grow guard asks what happened, not what was asked for', () => {
  const growing: ImageCodecs = {
    decode: async () => picture(8, 6),
    encode: async () => new Uint8Array(10_000),
  };

  it('keeps the original when a resize had nothing to resize', async () => {
    // Resize always sets `resize`, and it never upscales. For an image
    // already under the chosen edge nothing moves, so a re-encode would ship
    // a bigger file at one generation less quality for no reason at all.
    const result = await processImage(
      jpegBytes({ size: 200 }),
      { ...BASE, recompress: true, resize: { longestEdge: 1920 } },
      growing,
    );

    expect(result.unchanged).toBe(true);
    expect(result.bytes.byteLength).toBeLessThan(10_000);
  });

  it('still re-encodes when the resize actually shrank something', async () => {
    const result = await processImage(
      jpegBytes({ size: 200 }),
      { ...BASE, recompress: true, resize: { longestEdge: 4 } },
      growing,
    );
    expect(result.unchanged).toBeUndefined();
  });

  it('keeps a baked-in orientation even when the file grew', async () => {
    // Otherwise the guard hands back the original pixels with the
    // orientation tag deleted: a portrait phone photo, permanently sideways,
    // reported as Done.
    const result = await processImage(
      jpegBytes({ orientation: 6, size: 200 }),
      { ...BASE, recompress: true },
      growing,
    );

    expect(result.unchanged).toBeUndefined();
    expect(result.bytes.byteLength).toBe(10_000);
    // 8x6 decoded, turned a quarter.
    expect([result.width, result.height]).toEqual([6, 8]);
  });

  it('does the same for the metadata-only tool on a sideways photo', async () => {
    const result = await processImage(
      jpegBytes({ orientation: 8, size: 200 }),
      { ...BASE, quality: 90 },
      growing,
    );
    expect(result.unchanged).toBeUndefined();
    expect([result.width, result.height]).toEqual([6, 8]);
  });
});

describe('a multi-picture file is never handed back as "metadata removed"', () => {
  /** Two JPEGs end to end, as Samsung and Apple cameras write them. */
  function multiPicture(): Uint8Array {
    const primary = jpegBytes({ orientation: 1, size: 120 });
    const hidden = jpegBytes({ orientation: 1, size: 120 });
    const out = new Uint8Array(primary.length + hidden.length);
    out.set(primary, 0);
    out.set(hidden, primary.length);
    return out;
  }

  const growing: ImageCodecs = {
    decode: async () => picture(8, 6),
    encode: async () => new Uint8Array(100_000),
  };

  it('re-encodes rather than returning bytes that still hide a second image', async () => {
    // The in-place strip walks only the primary image's markers, so the
    // appended copy keeps its own EXIF and GPS. Returning it with a note
    // saying the metadata was removed is the worst outcome this app has:
    // the person believes their location is gone and ships it anyway.
    const input = multiPicture();
    const result = await processImage(input, { ...BASE, quality: 90 }, growing);

    expect(result.unchanged).toBeUndefined();
    expect(result.bytes.byteLength).toBe(100_000);
    expect(result.note ?? '').not.toMatch(/removed the metadata/i);
  });

  it('does the same when compressing', async () => {
    const result = await processImage(
      multiPicture(),
      { ...BASE, recompress: true, quality: 75 },
      growing,
    );
    expect(result.unchanged).toBeUndefined();
  });

  it('may still return the original when metadata was asked to be kept', async () => {
    // Nothing is being promised about the hidden image in that case.
    const result = await processImage(
      multiPicture(),
      { ...BASE, recompress: true, stripMetadata: false },
      growing,
    );
    expect(result.unchanged).toBe(true);
  });
});
