import { expect, test } from '@playwright/test';

/**
 * The unit tests drive the pipeline against fake codecs, which proves the
 * decision tree and nothing about the WebAssembly. These run the real
 * encoders in a real browser, inside the worker, on real images.
 *
 * They run against the dev server rather than the built bundle, because they
 * import the engine by source path. What the *build* does to the codecs — in
 * particular that the multithreaded AVIF encoder is kept out — is checked by
 * scripts/check-bundle.mjs instead.
 */

/** Imported by a variable so TypeScript does not try to resolve a browser path. */
const ENGINE = '/src/lib/workers/imageClient.ts';

interface Engine {
  processImageInWorker: (
    bytes: Uint8Array,
    settings: Record<string, unknown>,
  ) => Promise<{
    bytes: Uint8Array;
    format: string;
    width: number;
    height: number;
    note?: string;
  }>;
}

test('compresses a real photograph through the worker', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (enginePath) => {
    // A gradient with noise: flat colour would compress to almost nothing and
    // prove very little about the encoder.
    const size = 512;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        image.data[i] = (x * 255) / size + Math.random() * 40;
        image.data[i + 1] = (y * 255) / size + Math.random() * 40;
        image.data[i + 2] = 128 + Math.random() * 40;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const original = new Uint8Array(await blob.arrayBuffer());

    const { processImageInWorker } = (await import(/* @vite-ignore */ enginePath)) as Engine;
    const out = await processImageInWorker(new Uint8Array(original), {
      format: 'jpeg',
      quality: 70,
    });

    return {
      originalBytes: original.byteLength,
      resultBytes: out.bytes.byteLength,
      format: out.format,
      width: out.width,
      height: out.height,
      // JPEG magic, so we know it really is a JPEG and not an empty buffer.
      magic: [out.bytes[0], out.bytes[1], out.bytes[2]],
    };
  }, ENGINE);

  expect(result.format).toBe('jpeg');
  expect(result.magic).toEqual([0xff, 0xd8, 0xff]);
  expect(result.width).toBe(512);
  expect(result.height).toBe(512);
  expect(result.resultBytes).toBeGreaterThan(0);
  expect(result.resultBytes).toBeLessThan(result.originalBytes);
});

test('hits an exact size budget', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (enginePath) => {
    // A detailed but photographic image. Pure random noise is the
    // pathological case for JPEG and would make this a test of the encoder's
    // limits rather than of the search finding the budget.
    //
    // The noise is seeded rather than Math.random: an image that differs run
    // to run makes a size assertion flaky, and a flaky test on the headline
    // feature is worse than no test.
    let seed = 0x2f6e2b1;
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const size = 600;
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const wave = Math.sin(x / 9) * Math.cos(y / 11) * 60;
        image.data[i] = 128 + wave + noise() * 25;
        image.data[i + 1] = (y * 200) / size + noise() * 25;
        image.data[i + 2] = (x * 200) / size + noise() * 25;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });

    const { processImageInWorker } = (await import(/* @vite-ignore */ enginePath)) as Engine;
    const target = 60 * 1024;
    const out = await processImageInWorker(new Uint8Array(await blob.arrayBuffer()), {
      format: 'jpeg',
      quality: 80,
      targetBytes: target,
    });
    return { bytes: out.bytes.byteLength, target, note: out.note ?? '' };
  }, ENGINE);

  // The whole point of the feature: at or under the number that was asked for.
  expect(result.note).not.toMatch(/could not reach/i);
  expect(result.bytes).toBeLessThanOrEqual(result.target);
  // And not absurdly under it — landing at 5 KB for a 60 KB budget would mean
  // throwing away quality nobody asked to lose.
  expect(result.bytes).toBeGreaterThan(result.target * 0.4);
});

test('converts to WebP and AVIF with the real encoders', async ({ page }) => {
  await page.goto('/');
  for (const format of ['webp', 'avif'] as const) {
    const magic = await page.evaluate(
      async (target: { format: string; path: string }) => {
        const canvas = new OffscreenCanvas(128, 128);
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#3366cc';
        context.fillRect(0, 0, 128, 128);
        const blob = await canvas.convertToBlob({ type: 'image/png' });

        const { processImageInWorker } = (await import(/* @vite-ignore */ target.path)) as Engine;
        const out = await processImageInWorker(new Uint8Array(await blob.arrayBuffer()), {
          format: target.format,
          quality: 60,
        });
        return Array.from(out.bytes.slice(0, 12));
      },
      { format, path: ENGINE },
    );

    const text = String.fromCharCode(...magic);
    if (format === 'webp') expect(text).toContain('WEBP');
    else expect(text).toContain('ftyp');
  }
});

test('strips EXIF without re-encoding the pixels', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (enginePath) => {
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#884422';
    context.fillRect(0, 0, 64, 64);
    const jpeg = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
    );

    // Splice an EXIF APP1 segment in after SOI.
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0];
    const segment = [0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff];
    const withExif = new Uint8Array(jpeg.length + segment.length + payload.length);
    withExif.set(jpeg.subarray(0, 2), 0);
    withExif.set([...segment, ...payload], 2);
    withExif.set(jpeg.subarray(2), 2 + segment.length + payload.length);

    // Read these before the call: the input buffer is transferred to the
    // worker, which detaches it and leaves byteLength at 0.
    const before = withExif.byteLength;
    const jpegOnly = jpeg.byteLength;

    const { processImageInWorker } = (await import(/* @vite-ignore */ enginePath)) as Engine;
    const out = await processImageInWorker(withExif, { format: 'keep', quality: 80 });

    return { before, after: out.bytes.byteLength, jpegOnly, note: out.note ?? '' };
  }, ENGINE);

  // The metadata is gone and the compressed scan data is untouched, so the
  // result is exactly the original minus the segment.
  expect(result.after).toBe(result.jpegOnly);
  expect(result.after).toBeLessThan(result.before);
  expect(result.note).toMatch(/without re-encoding/i);
});
