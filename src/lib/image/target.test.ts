import { describe, expect, it, vi } from 'vitest';
import { encodeToTargetSize, type QualityEncoder } from './target';
import { createRaster } from './raster';

/**
 * A stand-in encoder whose output size is a smooth function of quality and
 * pixel count. Real encoders are noisier, but the search must be correct on
 * the easy case before noise is worth worrying about.
 */
function modelEncoder(bytesPerPixelAtFullQuality = 1): QualityEncoder {
  return async (image, quality) => {
    const pixels = image.width * image.height;
    const size = Math.max(
      1,
      Math.round(pixels * bytesPerPixelAtFullQuality * (quality / 100) ** 2),
    );
    return new Uint8Array(size);
  };
}

const image = createRaster(100, 100); // 10000 px

describe('encodeToTargetSize', () => {
  it('stops after one encode when the top quality already fits', async () => {
    const encode = vi.fn(modelEncoder());
    const result = await encodeToTargetSize(image, encode, { targetBytes: 1_000_000 });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(result.quality).toBe(95);
    expect(result.withinBudget).toBe(true);
  });

  it('lands at or under the budget', async () => {
    const result = await encodeToTargetSize(image, modelEncoder(), { targetBytes: 2500 });
    expect(result.withinBudget).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(2500);
  });

  it('finds a high quality, not merely a passing one', async () => {
    // At 10000 px, 2500 bytes is quality 50 exactly. A lazy search would
    // return the minimum quality and lose detail for nothing.
    const result = await encodeToTargetSize(image, modelEncoder(), { targetBytes: 2500 });
    expect(result.quality).toBeGreaterThanOrEqual(45);
  });

  it('respects the iteration ceiling', async () => {
    const encode = vi.fn(modelEncoder());
    await encodeToTargetSize(image, encode, { targetBytes: 2500, maxIterations: 4 });
    expect(encode.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('downscales when no quality setting can reach the budget', async () => {
    // 300 bytes is below even quality 20 at full size (10000 * 0.04 = 400).
    const result = await encodeToTargetSize(image, modelEncoder(), {
      targetBytes: 300,
      maxIterations: 20,
    });
    expect(result.withinBudget).toBe(true);
    expect(result.scale).toBeLessThan(1);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(300);
  });

  it('does not downscale when told not to, and says the budget was missed', async () => {
    const result = await encodeToTargetSize(image, modelEncoder(), {
      targetBytes: 300,
      allowDownscale: false,
    });
    expect(result.withinBudget).toBe(false);
    expect(result.scale).toBe(1);
  });

  it('terminates on an impossible budget instead of looping', async () => {
    const encode = vi.fn(modelEncoder());
    const result = await encodeToTargetSize(image, encode, {
      targetBytes: 1,
      maxIterations: 10,
      minScale: 0.35,
    });
    expect(result.withinBudget).toBe(false);
    expect(encode.mock.calls.length).toBeLessThanOrEqual(10);
    // The best effort is still returned, so the UI has something to show.
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('returns the smallest attempt when the budget is unreachable', async () => {
    const result = await encodeToTargetSize(image, modelEncoder(), {
      targetBytes: 1,
      allowDownscale: false,
    });
    // Quality 20 is the smallest the search is allowed to go at full size.
    expect(result.quality).toBe(20);
  });

  it('reports progress without exceeding 1', async () => {
    const seen: number[] = [];
    await encodeToTargetSize(image, modelEncoder(), {
      targetBytes: 2500,
      onProgress: (f) => seen.push(f),
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const fraction of seen) expect(fraction).toBeLessThanOrEqual(1);
  });

  it('rejects a nonsensical budget', async () => {
    await expect(encodeToTargetSize(image, modelEncoder(), { targetBytes: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      encodeToTargetSize(image, modelEncoder(), { targetBytes: Number.NaN }),
    ).rejects.toThrow(RangeError);
  });

  it('copes with an encoder whose size is not perfectly monotonic', async () => {
    // Add a wobble so a mid quality can come out slightly larger than a higher
    // one, as mozjpeg genuinely does near its quality plateaus.
    const base = modelEncoder();
    const wobbly: QualityEncoder = async (img, quality) => {
      const bytes = await base(img, quality);
      const jitter = quality % 7 === 0 ? 400 : 0;
      return new Uint8Array(bytes.byteLength + jitter);
    };
    const result = await encodeToTargetSize(image, wobbly, {
      targetBytes: 2500,
      maxIterations: 12,
    });
    expect(result.bytes.byteLength).toBeLessThanOrEqual(2500);
  });
});
