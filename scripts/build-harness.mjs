/**
 * Builds the offline harness that e2e/offline.spec.ts drives.
 *
 * The point of that test is the generated service worker, so the harness is
 * built from the project's own vite.config.ts and nothing about the caching is
 * overridden here. Only the root moves.
 *
 * Run: npm run build:harness
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

await build({
  /**
   * The harness directory becomes the Vite root so that its index.html is
   * emitted at the top of the output. Both matter: the precache list names
   * 'index.html' by that exact path, and the injected registration script
   * registers './sw.js' relative to the page, so a page one directory down
   * would ask for a worker that is not there and would not be precached
   * either — which is the whole thing under test.
   *
   * The harness imports the engine from outside that root, which Rollup
   * resolves without complaint in a build. It is never served from the dev
   * server, where the same import would need an fs.allow entry.
   */
  root: join(ROOT, 'scripts/probe/harness'),
  configFile: join(ROOT, 'vite.config.ts'),
  // Named explicitly because publicDir resolves against the root, and the
  // harness directory has none. Without it the icons the generated manifest
  // declares are absent from the output, and a browser that goes looking for
  // one makes the offline test's "nothing reached the network" assertion fail
  // for a reason that is nothing to do with the codecs.
  publicDir: join(ROOT, 'public'),
  logLevel: 'warn',
  build: { outDir: join(ROOT, 'dist-offline-harness'), emptyOutDir: true },
});
