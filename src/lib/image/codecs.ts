import type { EncodableFormat, ImageFormat } from './format';
import type { RasterImage } from './raster';

/**
 * The WebAssembly codecs, behind one small surface.
 *
 * Everything here is a thin adapter: all the decisions live in the pure
 * modules beside it, which are unit-tested without WebAssembly. Each codec is
 * imported dynamically so a visitor who only merges PDFs never downloads the
 * AVIF encoder.
 */

export interface EncodeOptions {
  /** 0..100. Ignored when `lossless` is set. */
  quality: number;
  /** 0..10 for AVIF, where higher is slower and smaller. */
  effort?: number;
  lossless?: boolean;
}

export class UnsupportedFormatError extends Error {
  constructor(format: string) {
    super(`Toolshed cannot read ${format} files`);
    this.name = 'UnsupportedFormatError';
  }
}

/** jSquash returns an ImageData, which already satisfies RasterImage. */
function asRaster(image: { data: Uint8ClampedArray; width: number; height: number }): RasterImage {
  return { width: image.width, height: image.height, data: image.data };
}

function asBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * The codecs take an ArrayBuffer, and a Uint8Array is often a view onto a
 * larger one. Handing over the whole buffer would make the decoder read
 * neighbouring data as if it were part of the file.
 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function requireImage(
  image: { data: Uint8ClampedArray; width: number; height: number } | null,
  format: ImageFormat,
): RasterImage {
  if (!image) throw new UnsupportedFormatError(`${format} (the decoder returned nothing)`);
  return asRaster(image);
}

async function decodeHeic(bytes: Uint8Array): Promise<RasterImage> {
  // libheif is LGPL-3.0 and ~1.5 MB. It is loaded as a separate, unmodified
  // module, only for people who actually open a HEIC. See THIRD-PARTY.md.
  const { default: libheif } = await import('libheif-js/wasm-bundle');
  const images = new libheif.HeifDecoder().decode(bytes);
  const first = images[0];
  if (!first) throw new UnsupportedFormatError('HEIC (no image found inside)');

  const width = first.get_width();
  const height = first.get_height();
  const target = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  await new Promise<void>((resolve, reject) => {
    first.display(target, (result) => {
      if (result) resolve();
      else reject(new Error('HEIC decoding failed'));
    });
  });
  first.free?.();

  return { width, height, data: target.data };
}

export async function decodeImage(bytes: Uint8Array, format: ImageFormat): Promise<RasterImage> {
  switch (format) {
    case 'jpeg': {
      const { default: decode } = await import('@jsquash/jpeg/decode');
      return requireImage(await decode(asArrayBuffer(bytes)), 'jpeg');
    }
    case 'png': {
      const { default: decode } = await import('@jsquash/png/decode');
      return requireImage(await decode(asArrayBuffer(bytes)), 'png');
    }
    case 'webp': {
      const { default: decode } = await import('@jsquash/webp/decode');
      return requireImage(await decode(asArrayBuffer(bytes)), 'webp');
    }
    case 'avif': {
      const { default: decode } = await import('@jsquash/avif/decode');
      return requireImage(await decode(asArrayBuffer(bytes)), 'avif');
    }
    case 'heic':
      return decodeHeic(bytes);
    case 'gif':
    case 'bmp':
      // Both are decodable by the platform itself; no wasm needed.
      return decodeViaImageBitmap(bytes, format);
  }
}

/**
 * Falls back to the browser's own decoder for formats no codec is shipped for.
 * Runs in a worker, so OffscreenCanvas rather than a DOM canvas.
 */
async function decodeViaImageBitmap(bytes: Uint8Array, format: ImageFormat): Promise<RasterImage> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new UnsupportedFormatError(format);
  }
  const blob = new Blob([bytes.slice()]);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new UnsupportedFormatError(format);
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return asRaster(data);
}

export async function encodeImage(
  image: RasterImage,
  format: EncodableFormat,
  options: EncodeOptions,
): Promise<Uint8Array> {
  // The encoders read .data/.width/.height, which RasterImage provides.
  const source = image as unknown as ImageData;

  switch (format) {
    case 'jpeg': {
      const { default: encode } = await import('@jsquash/jpeg/encode');
      return asBytes(await encode(source, { quality: options.quality }));
    }
    case 'webp': {
      const { default: encode } = await import('@jsquash/webp/encode');
      return asBytes(
        await encode(source, options.lossless ? { lossless: 1 } : { quality: options.quality }),
      );
    }
    case 'avif': {
      const { default: encode } = await import('@jsquash/avif/encode');
      return asBytes(
        await encode(source, {
          quality: options.quality,
          // jSquash calls this "speed", inverted from effort: 0 is slowest.
          speed: 10 - Math.round(((options.effort ?? 4) / 10) * 10),
        }),
      );
    }
    case 'png': {
      const { default: encode } = await import('@jsquash/png/encode');
      const raw = await encode(source);
      // PNG is lossless, so "quality" cannot mean discarding detail. It
      // becomes how hard oxipng works at finding a smaller encoding of the
      // same pixels: level 0 skips that pass entirely, level 6 is slow.
      const level = Math.min(6, Math.max(0, Math.round((options.quality / 100) * 6)));
      if (level === 0) return asBytes(raw);
      const { default: optimise } = await import('@jsquash/oxipng/optimise');
      return asBytes(await optimise(raw, { level, interlace: false, optimiseAlpha: true }));
    }
  }
}
