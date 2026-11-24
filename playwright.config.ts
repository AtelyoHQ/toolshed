import { defineConfig, devices } from '@playwright/test';

/**
 * Ports are overridable because several checkouts of this repo can be under
 * test at once, and the failure mode is silent: with a server already on the
 * port, Playwright would happily run the whole suite against somebody else's
 * build and report it green.
 */
const PREVIEW_PORT = Number(process.env.TOOLSHED_PREVIEW_PORT ?? 4173);
const DEV_PORT = Number(process.env.TOOLSHED_DEV_PORT ?? 5174);
const HARNESS_PORT = Number(process.env.TOOLSHED_HARNESS_PORT ?? 4175);
const previewUrl = `http://localhost:${PREVIEW_PORT}`;
const devUrl = `http://localhost:${DEV_PORT}`;
const harnessUrl = `http://localhost:${HARNESS_PORT}`;

/**
 * Three servers, because the three suites prove different things.
 *
 * The app suite runs against the built bundle, which is the artifact people
 * actually get. The engine suite imports modules by source path to drive the
 * codecs and pdf.js directly, which only the dev server can serve; what the
 * build does to those is checked by scripts/check-bundle.mjs instead.
 *
 * The offline suite needs a built bundle that really loads WebAssembly, and
 * nothing in the app imports the engine yet, so it gets a built harness page
 * of its own — same vite.config.ts, same generated service worker, see
 * scripts/build-harness.mjs.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'on-first-retry' },
  projects: [
    {
      name: 'app',
      testMatch: /(app|ui)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: previewUrl },
    },
    {
      name: 'engine',
      testMatch: /-engine\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: devUrl },
      // WebAssembly codecs on a large image are genuinely slow the first time.
      timeout: 120_000,
    },
    {
      name: 'offline',
      testMatch: /offline\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: harnessUrl },
      // Two codec runs on a small image, the second from cache with the
      // network off. It takes under a second warm; the budget is for a cold
      // CI runner compiling the WebAssembly for the first time.
      timeout: 60_000,
    },
  ],
  webServer: [
    {
      command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: previewUrl,
      // Never reuse: a stray server from another checkout would make the
      // whole suite pass against the wrong application.
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: devUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The script reads TOOLSHED_HARNESS_PORT itself, so it already has
      // whatever this config resolved.
      command: 'npm run build:harness && npm run preview:harness',
      url: harnessUrl,
      // Never reuse, for the same reason as the other two: a stray server
      // from another checkout would make the suite pass against the wrong
      // build and look green.
      reuseExistingServer: false,
      // Building the harness compiles every codec the engine can reach.
      timeout: 240_000,
    },
  ],
});
