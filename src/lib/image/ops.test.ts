import { describe, expect, it } from 'vitest';
import { crop, flip, resize, resolveSize, rotate } from './ops';
import {
  createRaster,
  getPixel,
  hasTransparency,
  flatten,
  setPixel,
  type RasterImage,
} from './raster';

/** A 2x3 image whose every pixel is identifiable by its red channel. */
function labelled(width: number, height: number): RasterImage {
  const image = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      setPixel(image, x, y, [y * width + x, 0, 0, 255]);
    }
  }
  return image;
}

function solid(width: number, height: number, rgba: [number, number, number, number]): RasterImage {
  const image = createRaster(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) setPixel(image, x, y, rgba);
  return image;
}

describe('rotate', () => {
  it('swaps the dimensions on a quarter turn', () => {
    const turned = rotate(labelled(2, 3), 90);
    expect([turned.width, turned.height]).toEqual([3, 2]);
  });

  it('moves the top-left pixel to the top-right on a 90 degree turn', () => {
    const turned = rotate(labelled(2, 3), 90);
    expect(getPixel(turned, 2, 0)[0]).toBe(0);
  });

  it('is lossless over a full circle', () => {
    const original = labelled(4, 7);
    const round = rotate(rotate(rotate(rotate(original, 90), 90), 90), 90);
    expect([round.width, round.height]).toEqual([4, 7]);
    expect(Array.from(round.data)).toEqual(Array.from(original.data));
  });

  it('returns the same object for a zero turn', () => {
    const original = labelled(2, 2);
    expect(rotate(original, 0)).toBe(original);
  });

  it('agrees with two 90 degree turns for 180', () => {
    const original = labelled(3, 5);
    expect(Array.from(rotate(original, 180).data)).toEqual(
      Array.from(rotate(rotate(original, 90), 90).data),
    );
  });
});

describe('flip', () => {
  it('mirrors horizontally', () => {
    const flipped = flip(labelled(3, 1), 'horizontal');
    expect([getPixel(flipped, 0, 0)[0], getPixel(flipped, 2, 0)[0]]).toEqual([2, 0]);
  });

  it('is its own inverse', () => {
    const original = labelled(3, 4);
    expect(Array.from(flip(flip(original, 'vertical'), 'vertical').data)).toEqual(
      Array.from(original.data),
    );
  });
});

describe('crop', () => {
  it('takes the requested rectangle', () => {
    const cropped = crop(labelled(4, 4), { x: 1, y: 1, width: 2, height: 2 });
    expect([cropped.width, cropped.height]).toEqual([2, 2]);
    expect(getPixel(cropped, 0, 0)[0]).toBe(5);
    expect(getPixel(cropped, 1, 1)[0]).toBe(10);
  });

  it('refuses a rectangle that runs off the edge', () => {
    expect(() => crop(labelled(4, 4), { x: 3, y: 0, width: 2, height: 1 })).toThrow(RangeError);
    expect(() => crop(labelled(4, 4), { x: -1, y: 0, width: 2, height: 1 })).toThrow(RangeError);
    expect(() => crop(labelled(4, 4), { x: 0, y: 0, width: 0, height: 1 })).toThrow(RangeError);
  });
});

describe('resolveSize', () => {
  const image = createRaster(1000, 500);

  it('keeps the aspect ratio when only one edge is given', () => {
    expect(resolveSize(image, { width: 500 })).toEqual({ width: 500, height: 250 });
    expect(resolveSize(image, { height: 250 })).toEqual({ width: 500, height: 250 });
  });

  it('honours the longest edge regardless of orientation', () => {
    expect(resolveSize(image, { longestEdge: 100 })).toEqual({ width: 100, height: 50 });
    expect(resolveSize(createRaster(500, 1000), { longestEdge: 100 })).toEqual({
      width: 50,
      height: 100,
    });
  });

  it('allows a deliberate aspect change when both edges are given', () => {
    expect(resolveSize(image, { width: 100, height: 100 })).toEqual({ width: 100, height: 100 });
  });

  it('refuses to upscale unless asked, because it cannot add detail', () => {
    expect(resolveSize(image, { longestEdge: 4000 })).toEqual({ width: 1000, height: 500 });
    expect(resolveSize(image, { longestEdge: 2000 }, true)).toEqual({ width: 2000, height: 1000 });
  });

  it('never resolves to a zero dimension', () => {
    expect(resolveSize(image, { scale: 0.0001 })).toEqual({ width: 1, height: 1 });
  });
});

describe('resize', () => {
  it('produces the resolved size', () => {
    const out = resize(labelled(64, 32), { longestEdge: 16 });
    expect([out.width, out.height]).toEqual([16, 8]);
  });

  it('returns the same object when nothing changes', () => {
    const original = labelled(10, 10);
    expect(resize(original, { scale: 1 })).toBe(original);
  });

  it('preserves a flat colour exactly, so brightness does not drift', () => {
    const out = resize(solid(40, 40, [200, 100, 50, 255]), { longestEdge: 10 });
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBeCloseTo(200, -0.5);
      expect(out.data[i + 1]).toBeCloseTo(100, -0.5);
      expect(out.data[i + 2]).toBeCloseTo(50, -0.5);
      expect(out.data[i + 3]).toBe(255);
    }
  });

  it('does not bleed colour out of fully transparent pixels', () => {
    // Left half opaque white, right half transparent *red*. Un-premultiplied
    // averaging would tint the seam pink.
    const image = createRaster(8, 2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        setPixel(image, x, y, x < 4 ? [255, 255, 255, 255] : [255, 0, 0, 0]);
      }
    }
    const out = resize(image, { width: 4, height: 1 });
    const [r, g, b] = getPixel(out, 1, 0);
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it('keeps fully transparent regions transparent', () => {
    const out = resize(solid(20, 20, [10, 20, 30, 0]), { scale: 0.25 });
    expect(hasTransparency(out)).toBe(true);
    expect(getPixel(out, 2, 2)[3]).toBe(0);
  });
});

describe('flatten', () => {
  it('composites transparency onto the background instead of blackening it', () => {
    const out = flatten(solid(2, 2, [255, 0, 0, 0]), [255, 255, 255]);
    expect(getPixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('leaves opaque pixels alone', () => {
    const out = flatten(solid(2, 2, [10, 20, 30, 255]), [255, 255, 255]);
    expect(getPixel(out, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it('blends a half-transparent pixel', () => {
    const out = flatten(solid(1, 1, [0, 0, 0, 128]), [255, 255, 255]);
    expect(getPixel(out, 0, 0)[0]).toBeGreaterThan(120);
    expect(getPixel(out, 0, 0)[0]).toBeLessThan(135);
  });
});
