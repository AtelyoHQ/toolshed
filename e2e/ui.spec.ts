import { expect, test, type Page } from '@playwright/test';

/** A PNG big enough that compressing it is a real result, not a rounding error. */
async function samplePhoto(page: Page, name = 'holiday.png'): Promise<void> {
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(900, 600);
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 900, 600);
    gradient.addColorStop(0, '#2b5876');
    gradient.addColorStop(1, '#d38312');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 900, 600);
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
    for (let i = 0; i < 3000; i++) {
      context.fillStyle = `rgba(255,255,255,${random() * 0.25})`;
      context.fillRect(random() * 900, random() * 600, 3, 3);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

  await page.setInputFiles('input[type=file]', {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(bytes),
  });
}

/** A JPEG carrying an EXIF block, which is what every phone photo is. */
async function photoWithExif(page: Page, name = 'phone.jpg'): Promise<void> {
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(900, 600);
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 900, 600);
    gradient.addColorStop(0, '#1b3a5c');
    gradient.addColorStop(1, '#c97b22');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 900, 600);
    let seed = 11;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
    for (let i = 0; i < 4000; i++) {
      context.fillStyle = `rgba(255,255,255,${random() * 0.3})`;
      context.fillRect(random() * 900, random() * 600, 4, 4);
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
    const jpeg = new Uint8Array(await blob.arrayBuffer());

    // Splice in a minimal, upright EXIF APP1 right after SOI.
    const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0];
    const header = [0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff];
    const out = new Uint8Array(jpeg.length + header.length + payload.length);
    out.set(jpeg.subarray(0, 2), 0);
    out.set([...header, ...payload], 2);
    out.set(jpeg.subarray(2), 2 + header.length + payload.length);
    return Array.from(out);
  });

  await page.setInputFiles('input[type=file]', {
    name,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(bytes),
  });
}

test('compresses a photo that carries EXIF, which is every phone photo', async ({ page }) => {
  // Compress used to hand these straight back: "keep the format, quality 75,
  // strip the metadata" read as "just strip the metadata", so the engine
  // took its lossless path and the row said Done at 0.0%. A canvas PNG has
  // no EXIF, which is exactly why the first test here missed it.
  await page.goto('/');
  await photoWithExif(page);

  const row = page.locator('li', { hasText: 'phone.jpg' });
  await row.getByRole('button').first().click();
  await row.getByLabel('Quality').fill('20');

  await page.getByRole('button', { name: /^Run \d/ }).click();
  await expect(row.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const delta = await row
    .getByText(/[-+]\d+\.\d%/)
    .first()
    .innerText();
  const saved = Number(delta.replace(/[^0-9.]/g, ''));
  expect(delta.startsWith('-')).toBe(true);
  expect(saved).toBeGreaterThan(40);
});

test('still strips metadata losslessly when that is the tool chosen', async ({ page }) => {
  await page.goto('/');
  await photoWithExif(page, 'keepme.jpg');

  const row = page.locator('li', { hasText: 'keepme.jpg' });
  await row.getByRole('button').first().click();
  await row.getByLabel('Tool').selectOption('image-strip-metadata');

  await page.getByRole('button', { name: /^Run \d/ }).click();
  await expect(row.getByText('Done')).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText(/without re-encoding/i)).toBeVisible();
});

test('keeps the tool chosen in the grid when a file is dropped', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Resize/ }).click();
  await samplePhoto(page);

  const row = page.locator('li', { hasText: 'holiday.png' });
  await row.getByRole('button').first().click();
  await expect(row.getByLabel('Tool')).toHaveValue('image-resize');
});

test('carries the settings chosen on the first screen onto the file', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Quality').fill('42');
  await samplePhoto(page);

  const row = page.locator('li', { hasText: 'holiday.png' });
  await row.getByRole('button').first().click();
  await expect(row.getByLabel('Quality')).toHaveValue('42');
});

test('refuses to run a size budget it cannot read', async ({ page }) => {
  await page.goto('/');
  await samplePhoto(page);

  const row = page.locator('li', { hasText: 'holiday.png' });
  await row.getByRole('button').first().click();
  await row.getByLabel('Tool').selectOption('image-target-size');
  await row.getByLabel('Must be under').fill('two hundred');

  await page.getByRole('button', { name: /^Run \d/ }).click();
  // Rather than quietly ignoring the budget and producing some other size.
  await expect(row.getByText(/is not a size/i)).toBeVisible({ timeout: 30_000 });
});

test('compresses a dropped file and offers it back', async ({ page }) => {
  await page.goto('/');
  await samplePhoto(page);

  await expect(page.getByText('holiday.png')).toBeVisible();
  await page.getByRole('button', { name: /^Run \d/ }).click();

  const row = page.locator('li', { hasText: 'holiday.png' });
  await expect(row.getByText('Done')).toBeVisible({ timeout: 60_000 });

  // The saving that was actually achieved, not a promise about it.
  await expect(row.getByText(/-\d+\.\d%/)).toBeVisible();

  // Headless Chromium exposes showSaveFilePicker but never resolves it, since
  // there is no dialog to pick with. Removing it exercises the anchor
  // fallback, which is also what Firefox and Safari users actually get.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });
  await page.reload();
  await samplePhoto(page);
  await page.getByRole('button', { name: /^Run \d/ }).click();
  const second = page.locator('li', { hasText: 'holiday.png' });
  await expect(second.getByText('Done')).toBeVisible({ timeout: 60_000 });

  const download = page.waitForEvent('download');
  await second.getByRole('button', { name: 'Save' }).click();
  expect((await download).suggestedFilename()).toBe('holiday.png');
});

test('writes through the save dialog when the browser has one', async ({ page }) => {
  // The other half of saveBlob: where the File System Access API exists, the
  // file goes where the person chose rather than into the downloads folder.
  await page.addInitScript(() => {
    const written: string[] = [];
    (window as unknown as { __written: string[] }).__written = written;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options: { suggestedName?: string }) => ({
        createWritable: async () => ({
          write: async () => written.push(options.suggestedName ?? ''),
          close: async () => {},
        }),
      }),
    });
  });

  await page.goto('/');
  await samplePhoto(page);
  await page.getByRole('button', { name: /^Run \d/ }).click();
  const row = page.locator('li', { hasText: 'holiday.png' });
  await expect(row.getByText('Done')).toBeVisible({ timeout: 60_000 });

  await row.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __written: string[] }).__written))
    .toEqual(['holiday.png']);
});

test('gives each file its own settings', async ({ page }) => {
  // The thing hosted tools get wrong: one quality slider for the whole batch.
  await page.goto('/');
  await samplePhoto(page, 'first.png');
  await samplePhoto(page, 'second.png');

  await page.locator('li', { hasText: 'first.png' }).getByRole('button').first().click();
  const quality = page.locator('li', { hasText: 'first.png' }).getByLabel('Quality');
  await quality.fill('30');

  await page.locator('li', { hasText: 'second.png' }).getByRole('button').first().click();
  await expect(page.locator('li', { hasText: 'second.png' }).getByLabel('Quality')).toHaveValue(
    '75',
  );
  await expect(quality).toHaveValue('30');
});

test('says a size budget is unreadable before running anything', async ({ page }) => {
  await page.goto('/');
  await samplePhoto(page);
  await page.locator('li', { hasText: 'holiday.png' }).getByRole('button').first().click();

  const row = page.locator('li', { hasText: 'holiday.png' });
  await row.getByLabel('Tool').selectOption('image-target-size');
  await row.getByLabel('Must be under').fill('two hundred');

  // Told now rather than silently ignored at run time, when the file would
  // just come out the wrong size with no explanation.
  await expect(row.getByText(/not a size/i)).toBeVisible();
  await expect(row.getByLabel('Must be under')).toHaveAttribute('aria-invalid', 'true');
});

test('is reachable from the keyboard alone', async ({ page }) => {
  await page.goto('/');

  // Tab to the file picker and open the queue without touching the mouse.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(focused.length).toBeGreaterThan(0);

  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
});

test('keeps the upload counter at zero while working', async ({ page }) => {
  await page.goto('/');
  await samplePhoto(page);
  await page.getByRole('button', { name: /^Run \d/ }).click();
  await expect(page.locator('li', { hasText: 'holiday.png' }).getByText('Done')).toBeVisible({
    timeout: 60_000,
  });

  // The number the whole promise rests on, after real work has happened.
  await expect(page.getByTitle(/no request has been made/i)).toContainText('0 uploads');
});

test('actually rotates an image that is already well compressed', async ({ page }) => {
  // Most images on a disk are already compressed, so re-encoding usually
  // makes them bigger. A guard meant for compression used to swallow the
  // rotation entirely: same bytes, same dimensions, row reported Done.
  await page.addInitScript(() => {
    const written: Blob[] = [];
    (window as unknown as { __written: Blob[] }).__written = written;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async (blob: Blob) => void written.push(blob),
          close: async () => {},
        }),
      }),
    });
  });

  await page.goto('/');
  await photoWithExif(page, 'already-small.jpg');

  const row = page.locator('li', { hasText: 'already-small.jpg' });
  await row.getByRole('button').first().click();
  await row.getByLabel('Tool').selectOption('image-rotate');
  await row.getByLabel('Turn').selectOption('90');
  await row.getByLabel('Quality').fill('30');

  await page.getByRole('button', { name: /^Run \d/ }).click();
  await expect(row.getByText('Done')).toBeVisible({ timeout: 60_000 });
  await row.getByRole('button', { name: 'Save' }).click();

  // The source is 900x600, so a quarter turn must give 600x900. Decoding the
  // saved bytes is the only way to know the rotation really happened.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const written = (window as unknown as { __written: Blob[] }).__written;
          if (written.length === 0) return null;
          const bitmap = await createImageBitmap(written[0]!);
          return { width: bitmap.width, height: bitmap.height };
        }),
      { timeout: 30_000 },
    )
    .toEqual({ width: 600, height: 900 });
});

test('does not carry one tool’s settings onto a different tool', async ({ page }) => {
  // An extension-less file with no MIME type reads as unknown, so the drop
  // falls back from Resize to Compress. Carrying Resize's longestEdge over
  // would silently downscale the image through a control the row does not
  // even render, with nothing on screen to show it or undo it.
  await page.goto('/');
  await page.getByRole('button', { name: /^Resize/ }).click();

  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(2400, 1600);
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#4477aa';
    context.fillRect(0, 0, 2400, 1600);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.setInputFiles('input[type=file]', {
    name: 'IMG_0001',
    mimeType: '',
    buffer: Buffer.from(bytes),
  });

  const row = page.locator('li', { hasText: 'IMG_0001' });
  await row.getByRole('button').first().click();

  await expect(row.getByLabel('Tool')).toHaveValue('image-compress');
  // Compress has no size control, so no resolution may be thrown away.
  await expect(row.getByLabel('Longest edge')).toHaveCount(0);
});

test('the totals line matches the files that actually finished', async ({ page }) => {
  // It used to sum every queued file against the output of only the ones
  // that had run, so a half-finished batch advertised a saving nobody got.
  await page.goto('/');
  await samplePhoto(page, 'one.png');
  await samplePhoto(page, 'two.png');

  const first = page.locator('li', { hasText: 'one.png' });
  await first.getByRole('button', { name: 'Run' }).click();
  await expect(first.getByText('Done')).toBeVisible({ timeout: 60_000 });

  // Second file untouched, so the header must describe the first one alone.
  const header = page.locator('p.ml-auto');
  const rowDelta = await first
    .getByText(/[-+]\d+\.\d%/)
    .first()
    .innerText();
  await expect(header).toContainText(rowDelta);
});

test('the privacy statement is a real page, including through the service worker', async ({
  page,
}) => {
  // Two rounds shipped a broken link here. First it 404'd; then the file
  // existed but the service worker's navigation fallback answered with the
  // app shell instead, which curl and the file on disk both miss because
  // neither goes through the worker.
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();

  await page.getByRole('link', { name: /how that is enforced/i }).click();

  await expect(page).toHaveURL(/privacy\.html$/);
  await expect(page.locator('body')).toContainText('Toolshed collects nothing');
  // The app shell would also contain this, so prove it is not the app.
  await expect(page.getByRole('banner')).toHaveCount(0);
});

test('the privacy statement is readable with the network off', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await context.setOffline(true);
  try {
    await page.goto('./privacy.html');
    await expect(page.locator('body')).toContainText('Toolshed collects nothing');
  } finally {
    await context.setOffline(false);
  }
});
