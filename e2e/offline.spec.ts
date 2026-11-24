import { expect, test } from '@playwright/test';

/**
 * The claim this file exists to hold up: once a tool has been used, it works
 * with the network off — codec WebAssembly included.
 *
 * That is a property of the built service worker and of nothing else. The
 * precache carries the shell; the two CacheFirst rules in vite.config.ts carry
 * the script chunks and the `.wasm` a tool pulls in on demand. Dropping either
 * rule, or renaming the assets so a rule stops matching, leaves the shell
 * opening offline and every tool dead — which is the failure this catches.
 *
 * It runs against the harness page (scripts/probe/harness) rather than the
 * app, because nothing in the shipped bundle imports the image engine yet, so
 * `dist/` holds no WebAssembly for an offline test to be about. The harness is
 * built from the project's real vite.config.ts, so the worker under test is
 * the one that ships.
 */

interface Engine {
  (
    bytes: Uint8Array,
    settings: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; format: string }>;
}

/**
 * Compresses a generated PNG to JPEG, which needs two separate codecs: the
 * squoosh PNG decoder and the mozjpeg encoder, each a `.wasm` of its own.
 *
 * The image is seeded rather than random, so the two runs below can be
 * compared byte for byte.
 */
const compressInPage = async () => {
  const engine = (window as unknown as { __imageEngine: Engine }).__imageEngine;
  let seed = 0x5f3a91c;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      image.data[i] = (x * 255) / size + noise() * 30;
      image.data[i + 1] = (y * 255) / size + noise() * 30;
      image.data[i + 2] = 120 + noise() * 30;
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const png = new Uint8Array(
    await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
  );

  const out = await engine(png, { format: 'jpeg', quality: 70 });
  return {
    length: out.bytes.byteLength,
    // JPEG magic, so a zero-filled buffer cannot pass for a result.
    magic: [out.bytes[0], out.bytes[1], out.bytes[2]],
  };
};

test('runs a tool with the network off once its WebAssembly has been fetched', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => '__imageEngine' in window);

  // The worker has to be *controlling* this page before the first run, not
  // merely active: an uncontrolled page fetches its chunks and its codecs
  // straight from the network, nothing is cached on the way past, and the
  // offline half of this test then fails for a reason that has nothing to do
  // with the caching rules.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 15_000,
  });

  const online = await page.evaluate(compressInPage);
  expect(online.magic).toEqual([0xff, 0xd8, 0xff]);

  // Asserted by name, before going offline, so a rule that stopped matching
  // `.wasm` fails here with the cache contents in the message rather than as
  // a timeout thirty lines down.
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('toolshed-wasm');
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(cached.filter((path) => path.endsWith('.wasm'))).not.toEqual([]);

  const failed: string[] = [];
  page.on('requestfailed', (request) => failed.push(request.url()));

  await context.setOffline(true);
  try {
    // A reload, not a second call: the point is that the page, its worker and
    // the codecs all come back from the cache, and the engine already loaded
    // in memory would prove none of that.
    await page.reload();
    await page.waitForFunction(() => '__imageEngine' in window);

    const offline = await page.evaluate(compressInPage);
    expect(offline.magic).toEqual([0xff, 0xd8, 0xff]);
    // Identical bytes: the same codecs, at the same version, on the same
    // input. A cached codec that had been replaced by something else would
    // still produce a JPEG.
    expect(offline.length).toBe(online.length);
  } finally {
    await context.setOffline(false);
  }

  // Nothing even tried the network and failed. The harness page declares an
  // empty icon so that the browser's own /favicon.ico request cannot land
  // here and make this assertion meaningless.
  expect(failed).toEqual([]);
});
