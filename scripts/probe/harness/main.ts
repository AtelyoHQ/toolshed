/**
 * Not part of the application: a page whose only content is the image engine,
 * so that e2e/offline.spec.ts has something to run with the network off.
 *
 * It exists because nothing in the shipped bundle imports the engine yet, so
 * `dist/` contains no WebAssembly at all and an offline test against it would
 * have nothing to assert — the same reason scripts/check-bundle.mjs builds a
 * probe entry of its own. The service worker under test is generated from the
 * project's real vite.config.ts, so its precache list and its two
 * runtime-caching rules are the ones that ship; the only difference from the
 * app is which modules this page imports. When the interface lands and the
 * built app loads a codec by itself, that test should move onto the real page
 * and this harness should go.
 */
import { processImageInWorker } from '../../../src/lib/workers/imageClient';

(globalThis as Record<string, unknown>).__imageEngine = processImageInWorker;
