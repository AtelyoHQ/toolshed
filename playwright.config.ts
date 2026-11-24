import { defineConfig, devices } from '@playwright/test';

/**
 * Ports are overridable because several checkouts of this repo can be under
 * test at once, and the failure mode is silent: with a server already on the
 * port, Playwright would happily run the whole suite against somebody else's
 * build and report it green.
 */
const PREVIEW_PORT = Number(process.env.TOOLSHED_PREVIEW_PORT ?? 4173);
const DEV_PORT = Number(process.env.TOOLSHED_DEV_PORT ?? 5174);
const previewUrl = `http://localhost:${PREVIEW_PORT}`;
const devUrl = `http://localhost:${DEV_PORT}`;

/**
 * Two servers, because the two suites prove different things.
 *
 * The app suite runs against the built bundle, which is the artifact people
 * actually get. The engine suite imports modules by source path to drive the
 * codecs directly, which only the dev server can serve; what the build does
 * to those codecs is checked by scripts/check-bundle.mjs instead.
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
      testMatch: /image-engine\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: devUrl },
      // WebAssembly codecs on a large image are genuinely slow the first time.
      timeout: 120_000,
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
  ],
});
