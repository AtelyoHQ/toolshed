/**
 * Not part of the application. scripts/check-bundle.mjs builds this entry on
 * its own to make the codec assertions real before any tool imports the
 * engine — otherwise the checks pass by having nothing to look at.
 */
import { processImageInWorker } from '../../src/lib/workers/imageClient';

(globalThis as Record<string, unknown>).__codecProbe = processImageInWorker;
