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
import { BUNDLED_LICENCES, licencePath } from './licences.mjs';

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

// 1b. pdf.js resolves its wasm modules and its standard fonts at runtime, from
//     base URLs it appends file names to. The build keeps them side by side
//     under their own names so those bases can be same-origin directories from
//     this bundle; if the layout breaks, pdf.js builds a URL out of a base it
//     was never given and requests that instead, which is ground rule 1 in
//     CONTRIBUTING.md. src/lib/pdf/pdfjsAssets.ts throws at runtime for the
//     same reason, but by then the build has already shipped.
const PDFJS_RUNTIME_FILES = [
  'jbig2.wasm',
  'openjpeg.wasm',
  'qcms_bg.wasm',
  'FoxitDingbats.pfb',
  'FoxitFixed.pfb',
  'FoxitFixedBold.pfb',
  'FoxitFixedBoldItalic.pfb',
  'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb',
  'FoxitSerifBold.pfb',
  'FoxitSerifBoldItalic.pfb',
  'FoxitSerifItalic.pfb',
  'FoxitSymbol.pfb',
  'LiberationSans-Bold.ttf',
  'LiberationSans-BoldItalic.ttf',
  'LiberationSans-Italic.ttf',
  'LiberationSans-Regular.ttf',
  // Not loaded by pdf.js: every one of these licences — BSD-style, MIT, and
  // the GPL v2 font exception Liberation Sans carries — asks that the notice
  // travel with the files, and a deployed dist/ is a redistribution.
  'LICENSE_FOXIT',
  'LICENSE_LIBERATION',
  'LICENSE_JBIG2',
  'LICENSE_OPENJPEG',
  'LICENSE_QCMS',
  // pdf.js compiles a wrapper of its own into each of those three binaries and
  // ships a second notice per binary for it.
  'LICENSE_PDFJS_JBIG2',
  'LICENSE_PDFJS_OPENJPEG',
  'LICENSE_PDFJS_QCMS',
  // Adobe's notice for the character maps. A .bcmap is the compiled form of a
  // CMap and its licence asks for the notice in a binary redistribution.
  'LICENSE',
];
// The directory carries pdfjs-dist's version, since the files inside it
// cannot carry a content hash. Found rather than named, so an upgrade does
// not need this script edited.
const pdfjsDirectories = [
  ...new Set(
    probeFiles
      .map((file) => /^(.*[\\/]assets[\\/]pdfjs-[^\\/]+)[\\/]/.exec(file)?.[1])
      .filter((directory) => directory !== undefined),
  ),
];
if (pdfjsDirectories.length !== 1) {
  fail(
    `expected exactly one assets/pdfjs-<version>/ directory, found ` +
      `${pdfjsDirectories.length === 0 ? 'none' : pdfjsDirectories.join(', ')}`,
  );
}
const pdfjsDirectory = pdfjsDirectories[0] ?? join(PROBE_DIST, 'assets/pdfjs');
const pdfjsMissing = [];
for (const name of PDFJS_RUNTIME_FILES) {
  const file = join(pdfjsDirectory, name);
  const size = await stat(file).then(
    (stats) => stats.size,
    () => 0,
  );
  if (size === 0) pdfjsMissing.push(name);
}
// The character maps are a set rather than a list: the glob in pdfjsAssets.ts
// emits whatever the installed pdfjs-dist carries. So the installed set is
// read and the emitted one has to match it by name — not by count, which an
// upgrade that adds one map and drops another would satisfy while a map was
// missing, and not against a floor, which an upgrade that splits the directory
// would satisfy with most of them. A document with a CJK font and no
// /ToUnicode renders blank without these, so a build that quietly stops
// emitting them is the worst failure this engine has.
const cmapsDirectory = join(ROOT, 'node_modules/pdfjs-dist/cmaps');
let cmapsInstalled;
try {
  cmapsInstalled = (await readdir(cmapsDirectory)).filter((file) => file.endsWith('.bcmap'));
} catch {
  cmapsInstalled = null;
}
if (cmapsInstalled === null) {
  fail(`${cmapsDirectory} is not there, so the character maps cannot be checked`);
} else {
  // Each one asked for by name, exactly where pdf.js will ask for it, and not
  // empty — the same test the named runtime files above get. A `.bcmap` under
  // a subdirectory of this one, or a zero-byte one, is a 404 or a blank page
  // at runtime, and a set comparison would have accepted both.
  const absent = [];
  for (const name of cmapsInstalled) {
    const { size } = await stat(join(pdfjsDirectory, name)).catch(() => ({ size: 0 }));
    if (size === 0) absent.push(name);
  }
  if (absent.length > 0) {
    fail(
      `expected all ${cmapsInstalled.length} installed character maps beside the fonts in ` +
        `${pdfjsDirectory}; ${absent.length} missing or empty, among them ` +
        absent.slice(0, 5).join(', '),
    );
  } else {
    console.log(`ok   ${cmapsInstalled.length} character maps ship, so CJK text is not lost`);
  }
}

if (pdfjsMissing.length > 0) {
  fail(
    `pdf.js assets are not where they have to be: ${pdfjsDirectory} is missing ` +
      `${pdfjsMissing.join(', ')}. See the asset naming rule in vite.config.ts.`,
  );
} else {
  console.log(
    `ok   pdf.js resolves ${PDFJS_RUNTIME_FILES.length} runtime files from ` +
      `${pdfjsDirectory.slice(PROBE_DIST.length + 1)}/`,
  );
}

// 1c. quickjs is pdf.js's JavaScript engine for scripted forms, 469 KB of
//     wasm reached only from a sandbox entry point this project never imports.
//     Nothing today pulls it in; this is here so that stays true, for the same
//     reason as the threaded AVIF encoder above. It catches the way it would
//     actually arrive — an asset import beside the other 25 — and not someone
//     loading pdf.sandbox.mjs, which resolves the file from a relative base
//     and would show up as a same-origin 404 instead.
const quickjs = probeFiles.filter((file) => /quickjs/.test(file));
if (quickjs.length > 0) {
  fail(
    `pdf.js's form-scripting engine was bundled: ${quickjs
      .map((file) => file.slice(PROBE_DIST.length + 1))
      .join(', ')}`,
  );
} else {
  console.log("ok   pdf.js's form-scripting engine is not bundled");
}

// 2. Nothing in the bundle may name another origin. This is the crudest of
//    the privacy checks and the only one that looks at the shipped bytes.
//
//    The probe build is scanned as well as dist/: the dependencies that would
//    reach for a CDN — pdf.js above all — are in the engines, and until a tool
//    imports them they are in no other output.
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
  // The origin in pdf.js's own getting-started examples, which is how a
  // copied snippet ends up loading its worker over the network.
  'mozilla.github.io',
];

let scanned = 0;
for (const file of [...files, ...probeFiles]) {
  if (!TEXT.has(extname(file))) continue;
  scanned += 1;
  const source = await readFile(file, 'utf8');
  for (const host of TRACKERS) {
    if (source.includes(host)) fail(`${file} references ${host}`);
  }
}
if (failures === 0) console.log(`ok   scanned ${scanned} text file(s), no third-party origins`);

await rm(PROBE_DIST, { recursive: true, force: true });

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

// 5. pdf.js's fonts are .pfb and .ttf, which match none of the other runtime
//    caching rules. Without a rule of their own they are missing offline and a
//    document using Helvetica renders with substituted glyphs — in an
//    application whose manifest promises it works offline. Nothing else
//    notices: the offline end-to-end test drives a harness that imports the
//    image engine only.
// The strategy is checked as well as the route: a rule that keeps the pattern
// and answers from the network holds the string and loses the point.
//
// The *first* strategy after the route, rather than any strategy within some
// number of characters of it. The handler is registerRoute's second argument,
// so it always comes first; a window instead reads whichever neighbour
// happens to be nearby, and this check has already been wrong in both
// directions — once finding the previous rule's CacheFirst, once a rule
// appended after this one.
const STRATEGY = /\b(CacheFirst|CacheOnly|NetworkFirst|NetworkOnly|StaleWhileRevalidate)\b/;
const routeAt = sw.indexOf('assets/pdfjs-');
// Reading a strategy by position only works while the route is the one place
// that directory is named. Widen the precache globs to match a font and the
// first occurrence moves into the precache manifest, where the strategy after
// it belongs to whichever rule happens to be registered first.
const mentions = sw.split('assets/pdfjs-').length - 1;
if (mentions > 1) {
  fail(
    `sw.js names assets/pdfjs- ${mentions} times, so which rule serves it cannot be read ` +
      'by position any more — check the precache globs and the runtime caching rules in ' +
      'vite.config.ts',
  );
}
const pdfjsStrategy = routeAt === -1 ? undefined : STRATEGY.exec(sw.slice(routeAt))?.[1];
if (pdfjsStrategy !== 'CacheFirst') {
  fail(
    `sw.js serves assets/pdfjs-<version>/ with ${pdfjsStrategy ?? 'no rule at all'} rather ` +
      'than CacheFirst, so the standard fonts are unavailable offline and pdf.js ' +
      'substitutes glyphs',
  );
} else {
  console.log('ok   pdf.js runtime files are cached first, so they survive going offline');
}

// 4. Every bundled third party's licence text must ship. For libheif this
//    is an obligation, not a courtesy: it is LGPL-3.0, and a build without
//    its notice and without saying how to replace it does not meet the
//    licence.
for (const entry of BUNDLED_LICENCES) {
  const path = join(DIST, licencePath(entry.package));
  try {
    const text = await readFile(path, 'utf8');
    if (text.trim().length === 0) fail(`${entry.package}'s licence notice is empty`);
  } catch {
    fail(`${entry.package} ships no licence notice at ${licencePath(entry.package)}`);
  }
}
try {
  const index = await readFile(join(DIST, 'licences/index.txt'), 'utf8');
  if (!index.includes('libheif-js')) fail('the licence index does not mention libheif');
  else console.log(`ok   ${BUNDLED_LICENCES.length} licence notice(s) shipped`);
} catch {
  fail('there is no licences/index.txt');
}

console.log(failures === 0 ? '\nbundle looks right' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
