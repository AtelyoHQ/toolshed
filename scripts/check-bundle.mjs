/**
 * Checks on the built bundle itself, for things that cannot be seen from the
 * source: what actually got emitted, and what actually got linked.
 *
 * Run: npm run build && npm run check:bundle
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PROBE_DIST = join(ROOT, 'dist-codec-probe');

try {
  await stat(join(DIST, 'index.html'));
} catch {
  console.error('dist/index.html is missing. Run `npm run build` first.');
  process.exit(1);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const files = await walk(DIST);
let failures = 0;

const fail = (message) => {
  console.error(`FAIL ${message}`);
  failures += 1;
};

// 1. The multithreaded AVIF encoder must not ship. It is 3.5 MB of wasm that
//    needs SharedArrayBuffer, which needs COOP/COEP headers a static host
//    serving from a subdirectory generally cannot send.
// Built separately, so this is true from the first day the engine exists
// rather than from the day a tool happens to import it. A check that passes
// by having nothing to look at is worse than no check.
await rm(PROBE_DIST, { recursive: true, force: true });
await build({
  root: ROOT,
  logLevel: 'error',
  build: {
    outDir: PROBE_DIST,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: join(ROOT, 'scripts/probe/codecs-entry.ts') },
  },
});

const probeFiles = await walk(PROBE_DIST);
const codecAssets = probeFiles.filter((file) => file.endsWith('.wasm'));
const threadedAvif = probeFiles.filter((file) => /avif_enc_mt/.test(file));

if (codecAssets.length === 0) {
  fail('the codec probe build emitted no .wasm at all, so it is not testing anything');
} else if (threadedAvif.length > 0) {
  const names = threadedAvif.map((file) => file.slice(PROBE_DIST.length + 1));
  fail(`the multithreaded AVIF encoder was bundled: ${names.join(', ')}`);
} else {
  console.log(
    `ok   ${codecAssets.length} codec asset(s) emitted, none of them the threaded AVIF encoder`,
  );
}
await rm(PROBE_DIST, { recursive: true, force: true });

// 2. Nothing in the bundle may name another origin. This is the crudest of
//    the privacy checks and the only one that looks at the shipped bytes.
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.webmanifest']);
const TRACKERS = [
  'google-analytics.com',
  'googletagmanager.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'sentry.io',
  'plausible.io',
  'segment.com',
  'mixpanel.com',
  'hotjar.com',
  'doubleclick.net',
];

let scanned = 0;
for (const file of files) {
  if (!TEXT.has(extname(file))) continue;
  scanned += 1;
  const source = await readFile(file, 'utf8');
  for (const host of TRACKERS) {
    if (source.includes(host)) fail(`${file} references ${host}`);
  }
}
if (failures === 0) console.log(`ok   scanned ${scanned} text file(s), no third-party origins`);

// 3. The service worker must not precache the heavy chunks. A regression here
//    is invisible until someone loads the site on mobile data.
const sw = await readFile(join(DIST, 'sw.js'), 'utf8');
// Workbox minifies the manifest, so the key is bare: {url:"...",revision:"..."}
const precached = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]);
if (precached.length === 0) fail('could not read the precache manifest out of sw.js');
const heavy = precached.filter((url) => /(^|\/)(chunk|worker)-/.test(url) || url.endsWith('.wasm'));
if (heavy.length > 0) {
  fail(`the service worker precaches on-demand chunks: ${heavy.join(', ')}`);
} else {
  console.log(`ok   precache holds ${precached.length} shell file(s), no codecs or workers`);
}

console.log(failures === 0 ? '\nbundle looks right' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
