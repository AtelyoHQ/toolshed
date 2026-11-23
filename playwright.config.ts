import { defineConfig, devices } from '@playwright/test';

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
  ],
});
