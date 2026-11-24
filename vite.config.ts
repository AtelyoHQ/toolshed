import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Codecs ship their own .wasm and resolve it from `import.meta.url`.
 *
 * This exclusion is a *dev server* setting: esbuild's dependency pre-bundling
 * rewrites those generated URLs and the codecs then fail to resolve inside a
 * worker under `npm run dev`. It has no effect on `vite build` — the produced
 * bundle is byte-identical either way — so it protects local development only.
 */
const CODECS = [
  '@jsquash/avif',
  '@jsquash/jpeg',
  '@jsquash/png',
  '@jsquash/resize',
  '@jsquash/webp',
];

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
  return {
    name: 'toolshed:privacy-statement',
    async generateBundle() {
      const text = await readFile(new URL('./PRIVACY.md', import.meta.url), 'utf8');
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
    <style>
      :root { color-scheme: dark light; }
      body {
        margin: 0 auto;
        max-width: 46rem;
        padding: 2.5rem 1.25rem 4rem;
        background: #0b0f14;
        color: #e6eaf1;
        font: 15px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      @media (prefers-color-scheme: light) {
        body { background: #fff; color: #171d26; }
      }
      pre { white-space: pre-wrap; word-wrap: break-word; margin: 0; }
      a { color: inherit; }
    </style>
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

export default defineConfig({
  // Relative, so dist/ runs from any subdirectory. The app routes on the URL
  // hash rather than the path for the same reason: a path route would make
  // './assets/...' resolve against the route and 404 on a deep link.
  base: './',
  plugins: [
    emitPrivacyStatement(),
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
              // Content-hashed filenames, so entries are immutable; the cap is
              // there to stop the cache growing without bound across releases.
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 180 },
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
  optimizeDeps: { exclude: CODECS },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/worker-[name]-[hash].js',
        chunkFileNames: 'assets/worker-[name]-[hash].js',
      },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // The prefixes are load-bearing: the service worker precaches
        // entry-*.js and nothing else, so a lazily imported codec or a worker
        // cannot creep into the first visit by being renamed.
        entryFileNames: 'assets/entry-[name]-[hash].js',
        chunkFileNames: 'assets/chunk-[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    // Maps are emitted but not linked from the bundle: debuggable when you
    // fetch them deliberately, without shipping tens of megabytes to everyone.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 4096,
  },
});
