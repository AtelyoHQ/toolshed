/**
 * The pixel type the whole image engine speaks.
 *
 * It is deliberately a plain structural type rather than `ImageData`, so every
 * operation here is a pure function over numbers and can be unit-tested in
 * Node with no DOM and no WebAssembly. A real `ImageData` satisfies it, so the
 * worker can pass one straight in.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major, non-premultiplied. */
  readonly data: Uint8ClampedArray;
}

export function createRaster(width: number, height: number): RasterImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid raster size ${width}x${height}`);
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function assertRaster(image: RasterImage): void {
  const expected = image.width * image.height * 4;
  if (image.data.length !== expected) {
    throw new RangeError(
      `Raster is ${image.width}x${image.height} but holds ${image.data.length} bytes, expected ${expected}`,
    );
  }
}

/** Index of a pixel's first (red) byte. */
export function offset(image: RasterImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

export function getPixel(
  image: RasterImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = offset(image, x, y);
  return [
    image.data[i] ?? 0,
    image.data[i + 1] ?? 0,
    image.data[i + 2] ?? 0,
    image.data[i + 3] ?? 0,
  ];
}

export function setPixel(
  image: RasterImage,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  const i = offset(image, x, y);
  image.data[i] = rgba[0];
  image.data[i + 1] = rgba[1];
  image.data[i + 2] = rgba[2];
  image.data[i + 3] = rgba[3];
}

/** True when any pixel is not fully opaque; decides JPEG vs PNG/WebP. */
export function hasTransparency(image: RasterImage): boolean {
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

/**
 * Composites onto an opaque background.
 *
 * JPEG has no alpha channel. Encoding a transparent PNG to JPEG without this
 * turns every transparent pixel black, which is the single most common
 * surprise when converting a logo.
 */
export function flatten(image: RasterImage, background: [number, number, number]): RasterImage {
  const out = createRaster(image.width, image.height);
  const src = image.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const alpha = (src[i + 3] ?? 0) / 255;
    const inverse = 1 - alpha;
    dst[i] = (src[i] ?? 0) * alpha + background[0] * inverse;
    dst[i + 1] = (src[i + 1] ?? 0) * alpha + background[1] * inverse;
    dst[i + 2] = (src[i + 2] ?? 0) * alpha + background[2] * inverse;
    dst[i + 3] = 255;
  }
  return out;
}
