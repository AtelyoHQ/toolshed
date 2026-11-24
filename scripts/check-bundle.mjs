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

// The update notice in src/components/UpdateNotice.tsx only ever fires because
// the new worker claims this page: that is what makes a version take over an
// open tab, and `controllerchange` the signal that it did. clientsClaim is
// what registerType decides — vite-plugin-pwa emits it for 'autoUpdate' and
// not for 'prompt' — so a switch there would leave the notice permanently
// silent with every other test still green. This is the only line in the repo
// that would notice. skipWaiting is deliberately not checked beside it: the
// workbox template emits that call in both configurations, inside a message
// handler when the option is off, so looking for it cannot fail.
if (!sw.includes('clientsClaim()')) {
  fail('sw.js does not call clientsClaim(), so a new version never takes over an open tab');
}

// 4. The manifest has to keep clearing the browser's bar for installability.
//    Installing is what makes the app openable from a dock with no network,
//    and the whole requirement is a list of manifest fields that a browser
//    silently stops offering to install when one of them goes missing.
const failuresBeforeManifest = failures;
let manifest = {};
try {
  manifest = JSON.parse(await readFile(join(DIST, 'manifest.webmanifest'), 'utf8'));
} catch (error) {
  // A missing or unparseable manifest is the headline case this section is
  // about, so it has to arrive as a FAIL line rather than a thrown stack.
  fail(`could not read dist/manifest.webmanifest: ${error.message}`);
}
const icons = manifest.icons ?? [];
// An omitted purpose means "any". A maskable-only icon does not count: a
// browser will not install on the strength of one.
const usable = icons.filter((icon) => (icon.purpose ?? 'any').split(/\s+/).includes('any'));
const hasSquare = (size) =>
  usable.some((icon) => (icon.sizes ?? '').split(/\s+/).includes(`${size}x${size}`));

if (!manifest.name || !manifest.short_name) fail('the manifest is missing name or short_name');
if (!manifest.start_url) fail('the manifest is missing start_url');
if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) {
  fail(`display is "${manifest.display}", which no browser offers to install`);
}
if (!hasSquare(192) || !hasSquare(512)) {
  fail('the manifest has no square any-purpose icon at both 192 and 512');
}

// Every declared icon has to exist, maskable ones included: Android draws the
// installed app from the maskable icon, so a dangling src there is invisible
// until someone installs it. A renamed or dropped PNG is the quiet way this
// breaks, since the manifest still parses and check:icons compares the
// committed PNGs against their generator rather than against these names.
for (const icon of icons) {
  try {
    await stat(join(DIST, icon.src));
  } catch {
    fail(`the manifest names an icon that is not in the bundle: ${icon.src}`);
  }
}

// start_url and scope have to stay relative for the same reason `base` is:
// a leading slash pins the installed app to a domain root, and this bundle is
// meant to run from a subdirectory. There is deliberately no `id` either —
// it would do the same thing, permanently, since a manifest id cannot be
// relative.
for (const field of ['start_url', 'scope', 'id']) {
  const value = manifest[field];
  if (typeof value === 'string' && value.startsWith('/')) {
    fail(`${field} is "${value}", which pins the installed app to a domain root`);
  }
}

if (failures === failuresBeforeManifest) {
  console.log(
    `ok   manifest is installable: ${icons.length} icon(s) present, ${usable.length} any-purpose`,
  );
}

console.log(failures === 0 ? '\nbundle looks right' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
