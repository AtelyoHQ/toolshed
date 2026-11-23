import { resize } from './ops';
import type { RasterImage } from './raster';

/**
 * "Compress this to under 200 KB."
 *
 * Government forms, job portals and ticketing systems state a hard byte budget
 * and reject anything above it. Almost no tool offers this, so people guess at
 * a quality slider, export, check the size, and go round again. This does the
 * search for them: find the *highest* quality whose encoded size still fits.
 *
 * The encoder is injected so the search is a pure function of (image, budget,
 * encoder) and can be tested against a model encoder with no WebAssembly.
 */

export type QualityEncoder = (image: RasterImage, quality: number) => Promise<Uint8Array>;

export interface TargetOptions {
  /** Hard ceiling in bytes. The result is at or under this, when reachable. */
  targetBytes: number;
  minQuality?: number;
  maxQuality?: number;
  /**
   * Hard ceiling on encode calls, across the quality search and any
   * downscaling. Each encode of a large photo costs real time, so this is
   * what bounds how long a target-size request can take.
   */
  maxIterations?: number;
  /**
   * Shrink the image when even the lowest quality will not fit. On by default:
   * a budget that cannot be met at full resolution is normally met easily at
   * 70% of it, and a slightly smaller photo beats a rejected upload.
   */
  allowDownscale?: boolean;
  /** How far down scaling may go, as a fraction of the original longest edge. */
  minScale?: number;
  onProgress?: (fraction: number) => void;
}

export interface TargetResult {
  bytes: Uint8Array;
  quality: number;
  /** 1 when the image was not resized. */
  scale: number;
  /** False when the budget could not be met; `bytes` is then the best effort. */
  withinBudget: boolean;
  /** Encode calls made, for the UI to explain why a large file took a moment. */
  attempts: number;
}

const DEFAULTS = {
  minQuality: 20,
  maxQuality: 95,
  // The quality search spends two encodes bracketing and three or four
  // narrowing, so a budget of eight left almost nothing for the downscale
  // phase — and that phase is exactly what a hard target needs on a noisy
  // photograph, where no quality setting alone will fit. Each encode of a
  // typical photo is tens of milliseconds, so the extra headroom is cheap.
  maxIterations: 12,
  allowDownscale: true,
  minScale: 0.35,
};

/**
 * Binary search over quality, then over scale if quality alone cannot do it.
 *
 * Size is monotonic in quality in practice, but not perfectly so for every
 * encoder, so the best fitting result seen is tracked rather than assumed from
 * the final bounds.
 */
export async function encodeToTargetSize(
  image: RasterImage,
  encode: QualityEncoder,
  options: TargetOptions,
): Promise<TargetResult> {
  const config = { ...DEFAULTS, ...options };
  if (!Number.isFinite(config.targetBytes) || config.targetBytes <= 0) {
    throw new RangeError('A target size must be a positive number of bytes');
  }

  let attempts = 0;
  let best: TargetResult | null = null;
  /** Smallest output seen, used when the budget turns out to be unreachable. */
  let smallest: TargetResult | null = null;

  const record = (bytes: Uint8Array, quality: number, scale: number): void => {
    const fits = bytes.byteLength <= config.targetBytes;
    const candidate: TargetResult = {
      bytes,
      quality,
      scale,
      withinBudget: fits,
      attempts,
    };
    if (fits) {
      // Prefer the highest quality that fits; at equal quality, prefer less
      // downscaling, since resolution is the more visible loss.
      if (!best || quality > best.quality || (quality === best.quality && scale > best.scale)) {
        best = candidate;
      }
    }
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) smallest = candidate;
  };

  const searchQuality = async (candidate: RasterImage, scale: number): Promise<void> => {
    let low = config.minQuality;
    let high = config.maxQuality;

    // Try the ceiling first: a photo that already fits at high quality should
    // cost one encode, not eight.
    if (attempts >= config.maxIterations) return;
    attempts += 1;
    const atHigh = await encode(candidate, high);
    record(atHigh, high, scale);
    config.onProgress?.(attempts / config.maxIterations);
    if (atHigh.byteLength <= config.targetBytes) return;

    if (attempts >= config.maxIterations) return;
    attempts += 1;
    const atLow = await encode(candidate, low);
    record(atLow, low, scale);
    config.onProgress?.(attempts / config.maxIterations);
    if (atLow.byteLength > config.targetBytes) return; // unreachable at this scale

    while (attempts < config.maxIterations && high - low > 1) {
      const mid = Math.round((low + high) / 2);
      if (mid === low || mid === high) break;
      attempts += 1;
      const bytes = await encode(candidate, mid);
      record(bytes, mid, scale);
      config.onProgress?.(attempts / config.maxIterations);
      if (bytes.byteLength <= config.targetBytes) low = mid;
      else high = mid;
    }
  };

  await searchQuality(image, 1);
  if (best) return { ...(best as TargetResult), attempts };

  if (config.allowDownscale) {
    // Bytes fall roughly with area, so area scales by the size ratio and the
    // linear scale by its square root. Two guided steps beat a blind ladder.
    let scale = 1;
    for (let step = 0; step < 3 && attempts < config.maxIterations; step++) {
      const reference = smallest as TargetResult | null;
      const ratio = reference ? config.targetBytes / reference.bytes.byteLength : 0.5;
      scale = Math.max(config.minScale, scale * Math.sqrt(Math.min(0.95, ratio)));
      const smaller = resize(image, { scale });
      await searchQuality(smaller, scale);
      if (best) return { ...(best as TargetResult), attempts };
      if (scale <= config.minScale) break;
    }
  }

  // Could not meet the budget. Hand back the smallest achieved and say so,
  // rather than silently returning something over the limit as if it passed.
  const fallback = smallest as TargetResult | null;
  if (!fallback) throw new Error('The encoder produced no output');
  return { ...fallback, withinBudget: false, attempts };
}
