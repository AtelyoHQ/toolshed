import { defineConfig, devices } from '@playwright/test';

/**
 * Three servers, because the three suites prove different things.
 *
 * The app suite runs against the built bundle, which is the artifact people
 * actually get. The engine suite imports modules by source path to drive the
 * codecs directly, which only the dev server can serve; what the build does
 * to those codecs is checked by scripts/check-bundle.mjs instead.
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
      testMatch: /app\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
    {
      name: 'engine',
      testMatch: /image-engine\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5174' },
      // WebAssembly codecs on a large image are genuinely slow the first time.
      timeout: 120_000,
    },
    {
      name: 'offline',
      testMatch: /offline\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4175' },
      // Two codec runs on a small image, the second from cache with the
      // network off. It takes under a second warm; the budget is for a cold
      // CI runner compiling the WebAssembly for the first time.
      timeout: 60_000,
    },
  ],
  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run build:harness && npm run preview:harness',
      url: 'http://localhost:4175',
      reuseExistingServer: !process.env.CI,
      // Building the harness compiles every codec the engine can reach.
      timeout: 240_000,
    },
  ],
});
