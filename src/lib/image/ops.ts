import { assertRaster, createRaster, type RasterImage } from './raster';

/** Clockwise rotation, the only one the UI offers. */
export type QuarterTurn = 0 | 90 | 180 | 270;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rotates by a quarter turn. Exact: pixels are moved, never resampled, so a
 * rotate-and-rotate-back round trip is lossless.
 */
export function rotate(image: RasterImage, degrees: QuarterTurn): RasterImage {
  assertRaster(image);
  if (degrees === 0) return image;

  const turned = degrees === 90 || degrees === 270;
  const width = turned ? image.height : image.width;
  const height = turned ? image.width : image.height;
  const out = createRaster(width, height);

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      let dx: number;
      let dy: number;
      if (degrees === 90) {
        dx = image.height - 1 - y;
        dy = x;
      } else if (degrees === 180) {
        dx = image.width - 1 - x;
        dy = image.height - 1 - y;
      } else {
        dx = y;
        dy = image.width - 1 - x;
      }
      const from = (y * image.width + x) * 4;
      const to = (dy * width + dx) * 4;
      out.data[to] = image.data[from] ?? 0;
      out.data[to + 1] = image.data[from + 1] ?? 0;
      out.data[to + 2] = image.data[from + 2] ?? 0;
      out.data[to + 3] = image.data[from + 3] ?? 0;
    }
  }
  return out;
}

export function flip(image: RasterImage, axis: 'horizontal' | 'vertical'): RasterImage {
  assertRaster(image);
  const out = createRaster(image.width, image.height);
  for (let y = 0; y < image.height; y++) {
    const sy = axis === 'vertical' ? image.height - 1 - y : y;
    for (let x = 0; x < image.width; x++) {
      const sx = axis === 'horizontal' ? image.width - 1 - x : x;
      const from = (sy * image.width + sx) * 4;
      const to = (y * image.width + x) * 4;
      out.data[to] = image.data[from] ?? 0;
      out.data[to + 1] = image.data[from + 1] ?? 0;
      out.data[to + 2] = image.data[from + 2] ?? 0;
      out.data[to + 3] = image.data[from + 3] ?? 0;
    }
  }
  return out;
}

/** Crops to a rectangle, which must lie inside the image. */
export function crop(image: RasterImage, rect: CropRect): RasterImage {
  assertRaster(image);
  const { x, y, width, height } = rect;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    x < 0 ||
    y < 0 ||
    x + width > image.width ||
    y + height > image.height
  ) {
    throw new RangeError(
      `Crop ${width}x${height}+${x}+${y} does not fit inside ${image.width}x${image.height}`,
    );
  }

  const out = createRaster(width, height);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    out.data.set(image.data.subarray(from, from + rowBytes), row * rowBytes);
  }
  return out;
}

export interface ResizeTarget {
  width?: number;
  height?: number;
  /** Longest edge, the control most people actually want. */
  longestEdge?: number;
  /** 0..1 of the original. */
  scale?: number;
}

/**
 * Works out the output size from whichever control was used, keeping the
 * aspect ratio unless both width and height were given explicitly.
 *
 * Never upscales by default: enlarging a photo cannot add detail and only
 * makes the file bigger, which is the opposite of what this app is for.
 */
export function resolveSize(
  image: RasterImage,
  target: ResizeTarget,
  allowUpscale = false,
): { width: number; height: number } {
  const ratio = image.width / image.height;
  let width: number;
  let height: number;

  if (target.width !== undefined && target.height !== undefined) {
    width = target.width;
    height = target.height;
  } else if (target.width !== undefined) {
    width = target.width;
    height = Math.round(target.width / ratio);
  } else if (target.height !== undefined) {
    height = target.height;
    width = Math.round(target.height * ratio);
  } else if (target.longestEdge !== undefined) {
    const longest = Math.max(image.width, image.height);
    const factor = target.longestEdge / longest;
    width = Math.round(image.width * factor);
    height = Math.round(image.height * factor);
  } else if (target.scale !== undefined) {
    width = Math.round(image.width * target.scale);
    height = Math.round(image.height * target.scale);
  } else {
    return { width: image.width, height: image.height };
  }

  if (!allowUpscale && (width > image.width || height > image.height)) {
    return { width: image.width, height: image.height };
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** Lanczos-3 kernel; a: lobes. */
function lanczos(x: number, a = 3): number {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const pix = Math.PI * x;
  return (a * Math.sin(pix) * Math.sin(pix / a)) / (pix * pix);
}

interface Contribution {
  start: number;
  weights: Float32Array;
}

/**
 * Precomputes, for each output pixel along one axis, which input pixels feed
 * it and with what weight. When shrinking, the filter widens to the output
 * pixel's footprint, which is what stops downscaling from aliasing.
 */
function contributions(sourceLength: number, targetLength: number): Contribution[] {
  const scale = targetLength / sourceLength;
  const support = scale < 1 ? 3 / scale : 3;
  const out: Contribution[] = [];

  for (let i = 0; i < targetLength; i++) {
    const centre = (i + 0.5) / scale - 0.5;
    const start = Math.max(0, Math.ceil(centre - support));
    const end = Math.min(sourceLength - 1, Math.floor(centre + support));
    const count = Math.max(1, end - start + 1);
    const weights = new Float32Array(count);

    let total = 0;
    for (let j = 0; j < count; j++) {
      const distance = start + j - centre;
      const weight = lanczos(scale < 1 ? distance * scale : distance);
      weights[j] = weight;
      total += weight;
    }
    // Normalising keeps overall brightness unchanged.
    if (total !== 0) {
      for (let j = 0; j < count; j++) weights[j] = (weights[j] ?? 0) / total;
    } else {
      weights[0] = 1;
    }
    out.push({ start, weights });
  }
  return out;
}

/**
 * High-quality separable Lanczos-3 resample.
 *
 * Alpha is premultiplied for the duration, otherwise the colour of fully
 * transparent pixels bleeds into their visible neighbours and edges pick up a
 * dark or white halo.
 */
export function resize(
  image: RasterImage,
  target: ResizeTarget,
  allowUpscale = false,
): RasterImage {
  assertRaster(image);
  const { width, height } = resolveSize(image, target, allowUpscale);
  if (width === image.width && height === image.height) return image;

  const src = image.data;
  const premultiplied = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const alpha = (src[i + 3] ?? 0) / 255;
    premultiplied[i] = (src[i] ?? 0) * alpha;
    premultiplied[i + 1] = (src[i + 1] ?? 0) * alpha;
    premultiplied[i + 2] = (src[i + 2] ?? 0) * alpha;
    premultiplied[i + 3] = alpha * 255;
  }

  // Horizontal pass into an intermediate of the target width.
  const horizontal = contributions(image.width, width);
  const middle = new Float32Array(width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    const rowStart = y * image.width * 4;
    for (let x = 0; x < width; x++) {
      const { start, weights } = horizontal[x] as Contribution;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k++) {
        const weight = weights[k] ?? 0;
        const i = rowStart + (start + k) * 4;
        r += (premultiplied[i] ?? 0) * weight;
        g += (premultiplied[i + 1] ?? 0) * weight;
        b += (premultiplied[i + 2] ?? 0) * weight;
        a += (premultiplied[i + 3] ?? 0) * weight;
      }
      const o = (y * width + x) * 4;
      middle[o] = r;
      middle[o + 1] = g;
      middle[o + 2] = b;
      middle[o + 3] = a;
    }
  }

  // Vertical pass into the final size, un-premultiplying on the way out.
  const vertical = contributions(image.height, height);
  const out = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    const { start, weights } = vertical[y] as Contribution;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < weights.length; k++) {
        const weight = weights[k] ?? 0;
        const i = ((start + k) * width + x) * 4;
        r += (middle[i] ?? 0) * weight;
        g += (middle[i + 1] ?? 0) * weight;
        b += (middle[i + 2] ?? 0) * weight;
        a += (middle[i + 3] ?? 0) * weight;
      }
      const o = (y * width + x) * 4;
      const alpha = Math.min(255, Math.max(0, a));
      out.data[o + 3] = alpha;
      if (alpha === 0) {
        out.data[o] = 0;
        out.data[o + 1] = 0;
        out.data[o + 2] = 0;
      } else {
        const scale = 255 / alpha;
        out.data[o] = r * scale;
        out.data[o + 1] = g * scale;
        out.data[o + 2] = b * scale;
      }
    }
  }
  return out;
}
