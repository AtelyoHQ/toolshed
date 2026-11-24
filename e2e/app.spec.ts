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

test('offers to install, and takes no for an answer', async ({ page }) => {
  // Chrome fires beforeinstallprompt only once its own engagement heuristics
  // are satisfied, which no test can arrange. What is under test here is the
  // application's reaction to the event, so the event is dispatched directly.
  const browserOffersInstall = () =>
    page.evaluate(async () => {
      const event = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void> };
      event.prompt = () => Promise.resolve();
      window.dispatchEvent(event);
      // Waits for React to have rendered whatever the event caused, which the
      // negative assertions below depend on: `toBeHidden` is satisfied by its
      // first poll, and a bar that reappeared a few milliseconds later would
      // pass an assertion made the instant after the dispatch.
      await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
    });

  await page.goto('/');
  const offer = page.getByRole('complementary', { name: 'Install Toolshed' });

  // Nothing until the browser says the app is installable.
  await expect(offer).toBeHidden();
  await browserOffersInstall();
  await expect(offer).toBeVisible();

  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(offer).toBeHidden();

  // PRIVACY.md promises this one flag is everything the application keeps
  // outside its own code cache. Nothing else in the repo would notice a
  // second key appearing beside it.
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    'toolshed:install-dismissed',
  ]);

  // Not even if the browser offers again before the page has been reloaded.
  await browserOffersInstall();
  await expect(offer).toBeHidden();

  // And still nothing on the next visit. An install bar that returns every
  // time is exactly the behaviour this application exists in opposition to,
  // and a dismissal that is not persisted looks identical until you reload.
  await page.reload();
  await browserOffersInstall();
  await expect(offer).toBeHidden();
});

test('says when a new version has taken over, without reloading the page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Reloading puts the page under the worker's control before the notice
  // starts watching. That distinction is the whole of the logic: a first
  // claim is not a new version and must stay quiet.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.reload();
  // Checked rather than assumed: an uncontrolled page would make the notice
  // correctly stay silent, and the failure below would then read as "the
  // notice never appeared".
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const notice = page.getByRole('status');
  await expect(notice).toBeHidden();

  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    // A genuine update needs a second deployment. This is the event the
    // application listens for, fired on the object it listens to.
    navigator.serviceWorker.dispatchEvent(new Event('controllerchange'));
  });

  await expect(notice).toContainText('A new version');
  // The reason the notice exists: an automatic reload would have thrown away
  // whatever was queued or mid-encode.
  expect(await page.evaluate(() => '__sameDocument' in window)).toBe(true);
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
