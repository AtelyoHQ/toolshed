/**
 * Proves the headline claim of the build: dist/ works when served from a
 * subdirectory, not only from a domain root.
 *
 * Serves the built bundle under /deep/app/, parses index.html, and fetches
 * every asset it references plus the PWA files. Any absolute URL fails here.
 *
 * Run: npm run build && npm run check:subpath
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

const PREFIX = '/deep/app/';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

try {
  await stat(join(DIST, 'index.html'));
} catch {
  console.error('dist/index.html is missing. Run `npm run build` first.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (!path.startsWith(PREFIX)) {
    res.writeHead(404).end('outside the mount point');
    return;
  }
  const requested = path.slice(PREFIX.length);
  // A directory request serves its index, the way every static host does.
  const relative = normalize(
    requested === '' || requested.endsWith('/') ? `${requested}index.html` : requested,
  );
  if (relative.startsWith('..')) {
    res.writeHead(403).end('traversal');
    return;
  }
  try {
    const body = await readFile(join(DIST, relative));
    res.writeHead(200, { 'content-type': TYPES[extname(relative)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}${PREFIX}`;

let failures = 0;
const check = async (url, label) => {
  const response = await fetch(url);
  const ok = response.status === 200;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${response.status} ${label}`);
};

const indexResponse = await fetch(base);
if (indexResponse.status !== 200) {
  console.error(`FAIL ${indexResponse.status} serving index.html at ${PREFIX}`);
  process.exit(1);
}
const html = await indexResponse.text();

// Anything addressed from the domain root cannot work under a subdirectory.
const absolute = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
if (absolute.length > 0) {
  console.error(`FAIL index.html references absolute paths: ${absolute.join(', ')}`);
  failures += 1;
}

const referenced = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
if (referenced.length === 0) {
  console.error('FAIL index.html references no relative assets; did the build run?');
  failures += 1;
}

for (const asset of referenced) await check(new URL(asset, base).href, asset);
for (const extra of ['manifest.webmanifest', 'sw.js']) {
  await check(new URL(extra, base).href, extra);
}

// index.html is only the entry point. A dynamically imported chunk or a codec
// .wasm with an absolute URL baked into it would pass every check above and
// still 404 under a subdirectory, which is the realistic way `base` breaks.
let scanned = 0;
try {
  const scripts = [];
  for (const dir of [DIST, join(DIST, 'assets')]) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.js') || name.endsWith('.mjs')) scripts.push(join(dir, name));
    }
  }
  for (const file of scripts) {
    scanned += 1;
    const source = await readFile(file, 'utf8');
    const absolute = [...source.matchAll(/["'`](\/assets\/[^"'`]+)["'`]/g)].map((m) => m[1]);
    if (absolute.length > 0) {
      console.error(
        `FAIL ${file} hard-codes absolute asset paths: ${[...new Set(absolute)].join(', ')}`,
      );
      failures += 1;
    }
  }
  console.log(`ok   scanned ${scanned} built script(s) for absolute asset paths`);
} catch {
  console.log('note no assets/ directory to scan');
}

server.close();
console.log(
  failures === 0 ? '\nall assets resolve under a subdirectory' : `\n${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
