import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

/**
 * Two build settings break the app without failing the build, so they are
 * asserted here against Vite's *resolved* configuration — not against the text
 * of vite.config.ts, which would pass just as happily if the setting were
 * commented out.
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
        '@jsquash/png',
        '@jsquash/resize',
        '@jsquash/webp',
      ]),
    );
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
