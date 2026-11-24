import { expect, test } from '@playwright/test';

const BASE = 'http://localhost:4173';

test('serves the built bundle and renders the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toContainText('toolshed');
});

test('loads without contacting any other origin', async ({ page }) => {
  // The project's one hard promise. A CDN font added to index.html or a
  // tracker pulled in by a dependency fails here; ESLint parses neither.
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    // blob: and data: never touch the network and are how the app hands a
    // result to the browser; the shipped policy allows both for that reason.
    if (url.startsWith(BASE) || url.startsWith('blob:') || url.startsWith('data:')) return;
    external.push(url);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  expect(external).toEqual([]);
});

test('ships a Content-Security-Policy that forbids other origins', async ({ page }) => {
  // The guarantee has to survive code nobody in this repo reviewed, so it is
  // enforced by the browser and not only by lint.
  await page.goto('/');
  const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  // Counted first so a missing tag fails in milliseconds rather than burning
  // the full test timeout (and then two retries of it) in CI.
  expect(await meta.count()).toBe(1);
  const policy = await meta.getAttribute('content');

  expect(policy).toBeTruthy();
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).not.toMatch(/connect-src[^;]*https?:/);
});

test('keeps working with the network switched off', async ({ page, context }) => {
  // The README tells people to pull their network cable and keep going. This
  // is the only thing standing between that sentence and a silent regression:
  // dropping html from the precache leaves the service worker registering
  // happily while offline is completely broken.
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('banner')).toContainText('toolshed');
  } finally {
    await context.setOffline(false);
  }
});

test('blocks a request to another origin at runtime', async ({ page }) => {
  // Issue #2's acceptance criterion, and the only check that exercises the
  // guard against real browser globals rather than a stub. The unit tests
  // install it over a fake scope object; this proves the production bundle
  // actually patches window.fetch before anything can use it.
  await page.goto('/');

  const outcome = await page.evaluate(async () => {
    try {
      await fetch('https://tracker.example.com/collect');
      return 'allowed';
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(outcome).toBe('ExternalRequestBlocked');
});

test('does not mistake a lookalike hostname for this origin', async ({ page }) => {
  // A string-prefix origin check says yes to this; the real host is not ours.
  // Note what this proves and what it does not: the preview origin carries a
  // port, so `localhost:4173.evil.example` is not a parseable URL and the
  // block comes from the "unparseable counts as external" rule rather than
  // from comparing hosts. The host comparison itself is covered by the unit
  // tests, which use a port-free origin.
  await page.goto('/');

  const outcome = await page.evaluate(async () => {
    const lookalike = `${location.origin}.evil.example/collect`;
    try {
      await fetch(lookalike);
      return 'allowed';
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(outcome).toBe('ExternalRequestBlocked');
});
