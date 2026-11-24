import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

/**
 * Three settings fail silently: two break the app without failing the build,
 * and the third shows up only as a flaky end-to-end run on a cold dependency
 * cache. All three are asserted against Vite's *resolved* configuration — not
 * against the text of vite.config.ts, which would pass just as happily if the
 * setting were commented out.
 */
describe('resolved build configuration', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  it('uses a relative base, so dist/ runs from any subdirectory', async () => {
    const config = await resolveConfig({ root }, 'build');
    expect(config.base).toBe('./');
  }, 60_000);

  it('keeps every wasm codec out of dev-server pre-bundling', async () => {
    const config = await resolveConfig({ root }, 'serve');
    expect(config.optimizeDeps.exclude).toEqual(
      expect.arrayContaining([
        '@jsquash/avif',
        '@jsquash/jpeg',
        '@jsquash/oxipng',
        '@jsquash/png',
        '@jsquash/resize',
        '@jsquash/webp',
      ]),
    );
  }, 60_000);

  it('pre-bundles libheif, which no scanned entry reaches', async () => {
    // Discovered mid-session instead, it re-optimises and full-reloads the
    // page, which fails whatever end-to-end test happened to be running.
    const config = await resolveConfig({ root }, 'serve');
    expect(config.optimizeDeps.include).toEqual(expect.arrayContaining(['libheif-js/wasm-bundle']));
  }, 60_000);
});

/**
 * The response headers are the strongest part of the privacy claim: they are
 * the only thing that restricts a dedicated worker, which is where files are
 * actually processed. Nothing else in the repo notices if one of the three
 * copies of the policy drifts, so this compares them directly.
 */
describe('Content-Security-Policy', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  /** Directive name -> sorted sources, so ordering differences do not matter. */
  function parse(policy: string): Map<string, string[]> {
    const directives = new Map<string, string[]>();
    for (const part of policy.split(';')) {
      const [name, ...sources] = part.trim().split(/\s+/);
      if (name) directives.set(name, sources.sort());
    }
    return directives;
  }

  const metaPolicy = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(
    read('../index.html'),
  )?.[1];
  const headersPolicy = /Content-Security-Policy:\s*(.+)/.exec(read('../public/_headers'))?.[1];
  const vercelPolicy = (
    JSON.parse(read('../vercel.json')) as {
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    }
  ).headers[0]?.headers.find((h) => h.key === 'Content-Security-Policy')?.value;

  it('is present in all three places it ships', () => {
    expect(metaPolicy).toBeTruthy();
    expect(headersPolicy).toBeTruthy();
    expect(vercelPolicy).toBeTruthy();
  });

  it('is identical between the Netlify/Cloudflare and Vercel header files', () => {
    expect(headersPolicy).toBe(vercelPolicy);
  });

  it('matches the meta tag apart from frame-ancestors, which meta cannot set', () => {
    const fromHeaders = parse(headersPolicy ?? '');
    const fromMeta = parse(metaPolicy ?? '');
    fromHeaders.delete('frame-ancestors');
    expect(Object.fromEntries(fromMeta)).toEqual(Object.fromEntries(fromHeaders));
  });

  it('permits no origin other than this one', () => {
    for (const policy of [metaPolicy, headersPolicy, vercelPolicy]) {
      // blob: and data: never touch the network; an http(s) source would.
      expect(policy).not.toMatch(/https?:/);
      expect(parse(policy ?? '').get('default-src')).toEqual(["'self'"]);
      expect(parse(policy ?? '').get('connect-src')).toEqual(["'self'", 'blob:'].sort());
    }
  });
});

/**
 * The service worker's precache list is the difference between a 240 KB first
 * visit and a multi-megabyte one, and a regression there is invisible until
 * someone opens the site on mobile data.
 */
describe('precache configuration', () => {
  const config = readFileSync(fileURLToPath(new URL('../vite.config.ts', import.meta.url)), 'utf8');
  const globs = /globPatterns:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? '';

  it('precaches the entry bundle and the shell, by name', () => {
    expect(globs).toContain('index.html');
    expect(globs).toContain('entry-*.js');
  });

  it('does not precache every script', () => {
    // A blanket js glob looks equivalent and is not: a worker chunk is a
    // script, and libheif inlines 1.4 MB of WebAssembly into one as base64.
    expect(globs).not.toMatch(/\{[^}]*\bjs\b[^}]*\}/);
    expect(globs).not.toContain("'**/*.js'");
  });

  it('does not precache codecs or workers', () => {
    expect(globs).not.toContain('wasm');
    expect(globs).not.toContain('worker-');
    expect(globs).not.toContain('chunk-');
  });
});
