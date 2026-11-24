/**
 * Serves the build with the deploy headers actually applied, and drives it in
 * a browser.
 *
 * Every other check in this repo goes through `vite preview` or reads files
 * off disk, and neither sends `public/_headers`. So the Content-Security-
 * Policy that production really runs under has never been exercised: a page
 * could rely on something the policy forbids, pass every gate, and arrive
 * broken on Netlify, Cloudflare Pages or Vercel. That happened once already,
 * with an inline <style> block on the privacy page.
 *
 * Run: npm run build && npm run check:headers
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const HEADERS_FILE = fileURLToPath(new URL('../public/_headers', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown',
};

try {
  await stat(join(DIST, 'index.html'));
} catch {
  console.error('dist/index.html is missing. Run `npm run build` first.');
  process.exit(1);
}

/** Reads the `/*` block of a Netlify/Cloudflare `_headers` file. */
async function globalHeaders() {
  const lines = (await readFile(HEADERS_FILE, 'utf8')).split('\n');
  const headers = {};
  let inGlobal = false;
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      inGlobal = line.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

const headers = await globalHeaders();
if (!headers['Content-Security-Policy']) {
  console.error('FAIL no Content-Security-Policy in the /* block of public/_headers');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative =
    path === '/' || path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
  try {
    const body = await readFile(join(DIST, relative));
    res.writeHead(200, {
      ...headers,
      'content-type': TYPES[extname(relative)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage();

/** Anything the policy refuses shows up here, and nowhere else. */
const violations = [];
page.on('console', (message) => {
  const text = message.text();
  if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
});

for (const [label, url] of [
  ['the application', `${origin}/`],
  ['the privacy page', `${origin}/privacy.html`],
]) {
  violations.length = 0;
  await page.goto(url, { waitUntil: 'networkidle' });
  if (violations.length > 0) {
    fail(`${label} breaks its own policy:\n       ${violations.join('\n       ')}`);
  } else {
    console.log(`ok   ${label} loads with no policy violation`);
  }
}

// The privacy page's styling is the thing that silently went missing: an
// inline block is dropped under style-src 'self', leaving a readable page
// whose long lines scroll sideways on a phone.
await page.goto(`${origin}/privacy.html`, { waitUntil: 'networkidle' });
const wrapping = await page.evaluate(
  () => getComputedStyle(document.querySelector('pre')).whiteSpace,
);
if (wrapping === 'pre-wrap') console.log('ok   the privacy page is styled under the real policy');
else fail(`the privacy page lost its stylesheet: pre white-space is "${wrapping}"`);

await browser.close();
server.close();

console.log(failures === 0 ? '\nthe real headers hold' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
