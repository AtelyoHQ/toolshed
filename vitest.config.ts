import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engines are pure functions over bytes and plain pixel buffers, with
    // no DOM: they run in Node. Interface behaviour is covered by Playwright.
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
