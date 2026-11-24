import { readFile } from 'node:fs/promises';
import { BUNDLED_LICENCES, licencePath } from './scripts/licences.mjs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Codecs ship their own .wasm and resolve it from `import.meta.url`.
 *
 * This exclusion is a *dev server* setting: dependency pre-bundling rewrites
 * those generated URLs and the codecs then fail to resolve inside a worker
 * under `npm run dev`. It has no effect on `vite build`, so it protects local
 * development only.
 */
const CODECS = [
  '@jsquash/avif',
  '@jsquash/jpeg',
  '@jsquash/oxipng',
  '@jsquash/png',
  '@jsquash/resize',
  '@jsquash/webp',
];

/**
 * libheif, pre-bundled before the dev server starts serving.
 *
 * Vite's dependency scan cannot reach it. It is imported by
 * src/lib/image/codecs.ts, and the only path to that file runs through
 * `new Worker(new URL('./image.worker.ts', import.meta.url))`, which the
 * scanner does not follow. So on a cold dependency cache it is discovered
 * when the dev server first transforms codecs.ts — with a page already open.
 *
 * Its bundler entry point is one line of CommonJS, and re-bundling it emits
 * the shared interop runtime chunk and rewrites the file hashes of the
 * dependencies the page has already loaded. Vite answers that with a full
 * reload, which destroys the execution context underneath whatever is
 * running; in the engine end-to-end suite it surfaces as `Execution context
 * was destroyed` in whichever test was in flight. Only a cold cache reaches
 * it, so CI — installing from scratch every run — does, and a developer with
 * a warm cache does not. A plain ESM dependency found just as late
 * re-optimises without the reload, which is why this list has one entry.
 *
 * Note which lever this is, because the other two do not work here.
 * `needsInterop`, which is what Vite's own warning about mixed CommonJS
 * suggests, is irrelevant: nothing mismatches, and the reload comes from the
 * changed file hashes. `exclude`, which is how the codecs above are handled,
 * breaks libheif outright — excluded, the dev server hands the browser that
 * raw `module.exports` line. Pre-bundling is safe for exactly the reason the
 * codecs cannot have it: libheif inlines its WebAssembly as base64 rather
 * than resolving a URL from `import.meta.url`, so there is no generated URL
 * for pre-bundling to rewrite.
 *
 * This is not scaffolding that the interface landing will retire. The engine's
 * only entry point spawns the worker, so codecs.ts stays behind that boundary
 * however much UI is built on top; the line can go only if something on the
 * main thread ever imports it directly.
 *
 * The other three entries are the PDF engine's libraries, and they are here
 * for the first of those reasons and not the second: they are plain ESM, so a
 * late discovery would re-optimise without a reload — but they sit behind
 * `new Worker(new URL('./pdf.worker.ts', import.meta.url))`, which the scanner
 * does not follow either, and they are 4 MB to pre-bundle while a job waits.
 */
const PREBUNDLE = ['libheif-js/wasm-bundle', 'comlink', '@cantoo/pdf-lib', 'pdfjs-dist'];

/**
 * Serves the privacy statement from the built site, as a page.
 *
 * The footer links to it as the evidence behind "nothing is uploaded", and
 * Vite only copies `public/`, so there is nothing to link to otherwise. It
 * is emitted as HTML rather than raw Markdown for two reasons: a .md file is
 * sent as text/markdown and Chrome downloads it instead of showing it, and a
 * page can be precached so the statement is readable with the network off
 * like the rest of the app.
 *
 * The text itself still lives in one place, PRIVACY.md at the repo root.
 */
function emitPrivacyStatement(): Plugin {
  // A separate stylesheet, not a <style> block. The shipped policy is
  // `style-src 'self'`, so an inline block is dropped on any host that sends
  // the real headers — the page stays readable but loses pre-wrap, and long
  // lines scroll sideways on a phone. `vite preview` does not send the header
  // files, which is exactly why that went unnoticed; scripts/check-headers.mjs
  // now serves dist/ with them applied.
  const stylesheet = `:root {
  color-scheme: dark light;
}

body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 2.5rem 1.25rem 4rem;
  background: #0b0f14;
  color: #e6eaf1;
  font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: light) {
  body {
    background: #fff;
    color: #171d26;
  }
}

pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}

a {
  color: inherit;
}
`;

  return {
    name: 'toolshed:privacy-statement',
    async generateBundle() {
      const text = await readFile(new URL('./PRIVACY.md', import.meta.url), 'utf8');
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      this.emitFile({ type: 'asset', fileName: 'privacy.css', source: stylesheet });
      this.emitFile({
        type: 'asset',
        fileName: 'privacy.html',
        source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy — Toolshed</title>
    <meta name="color-scheme" content="dark light" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self'; img-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    />
    <link rel="stylesheet" href="./privacy.css" />
  </head>
  <body>
    <pre>${escaped}</pre>
    <p><a href="./">Back to Toolshed</a></p>
  </body>
</html>
`,
      });
    },
  };
}

/**
 * pdf.js loads its wasm modules and its standard fonts from base URLs it
 * appends file names to, so those assets have to keep their names and stay
 * side by side. Everything else is content-hashed as usual.
 *
 * The cost is that these are not cache-busted by a hash, so the service
 * worker's expiry is what retires them; they change only when pdfjs-dist is
 * upgraded. The alternative is pdf.js building a URL out of a base it was
 * never given, which is ground rule 1 in CONTRIBUTING.md.
 * `src/lib/pdf/pdfjsAssets.ts` fails loudly if this rule stops applying, and
 * `scripts/check-bundle.mjs` fails the build.
 */
const PDFJS_RUNTIME_ASSET = /pdfjs-dist[\\/](wasm|standard_fonts|cmaps)[\\/][^\\/]+$/;

/**
 * The directory carries pdfjs-dist's version, because the files in it cannot
 * carry a hash. Without it a returning visitor can be served last release's
 * jbig2.wasm — the service worker holds it for 180 days — beside this
 * release's pdf.js. The version changes, the directory changes, the cache
 * entry is a different URL.
 */
const PDFJS_VERSION: string = (
  createRequire(import.meta.url)('pdfjs-dist/package.json') as { version: string }
).version;

/**
 * Used by both the worker build and the main one. Only the worker emits these
 * assets today, because the engine is reached through `new Worker(...)` and
 * nothing else imports it; the main build's copy is there for the day
 * something on the main thread does, where the same rule has to hold.
 */
function pdfjsAwareAssetNames(asset: { originalFileNames?: readonly string[] }): string {
  const fromPdfjs = asset.originalFileNames?.some((name) => PDFJS_RUNTIME_ASSET.test(name));
  return fromPdfjs
    ? `assets/pdfjs-${PDFJS_VERSION}/[name][extname]`
    : 'assets/[name]-[hash][extname]';
}

/**
 * Ships the licence text of the third-party code inside the bundle.
 *
 * Mostly a courtesy, except for libheif, where it is not: that is LGPL-3.0,
 * and distributing a build without its notice and without saying how to
 * replace it does not meet the licence. pdf.js already carries its own
 * notices beside its runtime assets, so this covers the rest.
 */
function emitLicenceNotices(): Plugin {
  return {
    name: 'toolshed:licence-notices',
    async generateBundle() {
      const index: string[] = [
        'Toolshed is MIT licensed. The third-party code inside this build keeps',
        'its own terms, listed below with the full text of each licence.',
        '',
      ];

      for (const entry of BUNDLED_LICENCES) {
        const text = await readFile(new URL(`./${entry.file}`, import.meta.url), 'utf8');
        const path = licencePath(entry.package);
        this.emitFile({ type: 'asset', fileName: path, source: text });

        index.push(`${entry.package} — ${entry.licence}`);
        if (entry.note) index.push(`  ${entry.note}`);
        index.push(`  ${path}`, '');
      }

      index.push(
        'pdf.js and the libraries inside it ship their notices beside their own',
        'runtime assets, under assets/pdfjs-<version>/.',
        '',
      );
      this.emitFile({ type: 'asset', fileName: 'licences/index.txt', source: index.join('\n') });
    },
  };
}

/**
 * Lets the dev server's own stylesheet through, and only there.
 *
 * The policy in index.html says `style-src 'self'`, which is what we want in
 * production. But `vite dev` injects every stylesheet as an inline <style>
 * element, so under that policy the browser drops all of them and
 * `npm run dev` serves an unstyled page — no layout, and controls meant to
 * be visually hidden showing up as raw form widgets.
 *
 * It went unnoticed because nothing tests the dev server's appearance: the
 * app end-to-end suite runs against the built bundle, where the stylesheet
 * is a real file and the strict policy is correct.
 *
 * `apply: 'serve'` is what keeps this out of the build. The unit test on the
 * three shipped copies of the policy reads index.html from source, so it
 * still holds the strict one.
 */
function allowDevServerStyles(): Plugin {
  return {
    name: 'toolshed:dev-server-styles',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");
    },
  };
}

export default defineConfig({
  // Relative, so dist/ runs from any subdirectory. The app routes on the URL
  // hash rather than the path for the same reason: a path route would make
  // './assets/...' resolve against the route and 404 on a deep link.
  base: './',
  plugins: [
    allowDevServerStyles(),
    emitPrivacyStatement(),
    emitLicenceNotices(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Toolshed — private file tools',
        short_name: 'Toolshed',
        description:
          'Compress, convert and edit PDFs and images entirely in your browser. No uploads, no size caps, works offline.',
        theme_color: '#0b0f14',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the shell only. Everything a tool pulls in on demand is
        // runtime-cached instead, so a first visit stays small for someone who
        // came to rotate one JPEG.
        //
        // 'js' is deliberately NOT a glob here. A worker chunk counts as JS,
        // and libheif inlines its 1.4 MB of WebAssembly into the chunk as
        // base64, so a blanket js pattern quietly precaches megabytes while
        // appearing to honour the design above.
        // Only the entry bundle and the shell assets. Chunk names carry an
        // explicit prefix (see build.rollupOptions below) so this split is a
        // rule the build enforces, not a guess about what Rollup will emit.
        globPatterns: [
          'index.html',
          'privacy.html',
          'privacy.css',
          'registerSW.js',
          'manifest.webmanifest',
          '**/entry-*.js',
          '**/*.{css,svg,png}',
        ],
        // Without this the service worker answers every top-level request
        // with the app shell, so the privacy page — and any other page or
        // file linked from the app — silently serves the application
        // instead. It fails invisibly: curl and the file on disk both look
        // right, because neither goes through the service worker.
        navigateFallbackDenylist: [/\.(?:md|txt|html)$/, /^\/LICENSE$/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Script chunks, including the entry bundle and the workers. They
            // are content-hashed, so a cached entry is never stale; the first
            // visit caches whatever it loads and that much works offline.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && /\.m?js$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'toolshed-scripts',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'toolshed-wasm',
              // Immutable URLs — the codecs' file names are content-hashed,
              // and pdf.js's, which this rule also catches, live in a
              // directory named after their version. Thirteen per release now
              // that pdf.js's three are here, so the cap holds several
              // releases; it is there to stop the cache growing without
              // bound, not to be tight. Evicting jbig2.wasm would mean a
              // scan rendering blank offline, which compress.ts refuses but
              // cannot repair.
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // pdf.js's standard fonts and character maps, which are .pfb,
            // .ttf and .bcmap and so match no other rule here (its wasm is
            // already caught above). Without this they are missing offline,
            // and a document using Helvetica renders with substituted glyphs
            // while a CJK one renders blank — in an application whose manifest
            // promises it works offline.
            //
            // Matched without a leading slash, which is not a detail: a
            // literal "/assets/..." in the shipped service worker is what
            // scripts/check-subpath.mjs refuses, because addressing an asset
            // from the domain root breaks a deployment in a subdirectory.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.includes('assets/pdfjs-'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'toolshed-pdfjs',
              // 191 files per pdfjs-dist version — 14 fonts, 168 character
              // maps and 9 licence notices; the 3 wasm modules are taken by
              // the rule above — so this holds two versions and retires the
              // rest.
              //
              // The number is not cosmetic: a miss while online just refetches,
              // but offline it is a CJK document rendering blank — the
              // failure compress.ts now refuses outright. All of it is
              // 1.2 MB.
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: [
      {
        /**
         * jSquash picks the multithreaded AVIF encoder whenever the browser
         * reports WebAssembly threads, and bundles it either way: 3.5 MB of
         * wasm plus its own worker chunk. Threads need SharedArrayBuffer,
         * which needs COOP and COEP response headers — which a static host
         * serving this from a subdirectory generally cannot send, and the
         * page cannot set for itself.
         *
         * Rewriting that one import to the single-threaded encoder is correct
         * either way: where threads are unavailable this path was taken
         * anyway, and where they are available it trades some encoding speed
         * for not shipping a second encoder most deployments cannot use.
         * scripts/check-bundle.mjs fails the build if it reappears.
         */
        find: /avif_enc_mt\.js$/,
        replacement: 'avif_enc.js',
      },
    ],
  },
  optimizeDeps: { exclude: CODECS, include: PREBUNDLE },
  server: {
    watch: {
      /**
       * Vite's watcher ignores `.git`, `node_modules`, `test-results` and the
       * configured `outDir` — and so not the built offline harness, which
       * `npm run test:e2e` writes while a dev server is up. The index.html
       * landing there logs `[vite] page reload
       * dist-offline-harness/index.html`. It changes nothing, because the
       * client ignores a reload for an html file that is not the open page,
       * but it reads exactly like the cause of a failing test and it cost an
       * afternoon before being measured.
       */
      ignored: ['**/dist-offline-harness/**'],
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/worker-[name]-[hash].js',
        chunkFileNames: 'assets/worker-[name]-[hash].js',
        // The wasm and the fonts pdf.js needs are imported from inside a
        // worker, so the rule has to hold for the worker build too.
        assetFileNames: pdfjsAwareAssetNames,
      },
    },
  },
  build: {
    target: 'es2022',
    // pdf.js fetches these by name from a directory, so not one of them may
    // be inlined as a data URI however small it is. Six of the licence
    // notices are under the 4 KB default and were inlined, which left the
    // fonts and the wasm shipping without them.
    assetsInlineLimit: (filePath: string) =>
      PDFJS_RUNTIME_ASSET.test(filePath) ? false : undefined,
    rollupOptions: {
      output: {
        // The prefixes are load-bearing: the service worker precaches
        // entry-*.js and nothing else, so a lazily imported codec or a worker
        // cannot creep into the first visit by being renamed.
        entryFileNames: 'assets/entry-[name]-[hash].js',
        chunkFileNames: 'assets/chunk-[name]-[hash].js',
        assetFileNames: pdfjsAwareAssetNames,
      },
    },
    // Maps are emitted but not linked from the bundle: debuggable when you
    // fetch them deliberately, without shipping tens of megabytes to everyone.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 4096,
  },
});
