/**
 * The third-party code that ships inside the bundle, and where its licence
 * text lives.
 *
 * Shared by the Vite plugin that emits the notices and by the build check
 * that proves they are there, so the two cannot disagree.
 *
 * pdf.js's own notices are not here: it ships them beside its runtime assets
 * and `src/lib/pdf/pdfjsAssets.ts` already imports each one as a build asset.
 */
export const BUNDLED_LICENCES = [
  {
    package: 'libheif-js',
    licence: 'LGPL-3.0',
    file: 'node_modules/libheif-js/LICENSE',
    note:
      'Decodes HEIC photos. The LGPL requires that you can replace this ' +
      'library with your own build: it is loaded as a separate, unmodified ' +
      'module and used only through its public API, and the source it was ' +
      'built from is at https://github.com/catdad-experiments/libheif-js. ' +
      'Removing HEIC support removes it entirely; it has one call site.',
  },
  { package: '@jsquash/jpeg', licence: 'Apache-2.0', file: 'node_modules/@jsquash/jpeg/LICENSE' },
  { package: '@jsquash/png', licence: 'Apache-2.0', file: 'node_modules/@jsquash/png/LICENSE' },
  { package: '@jsquash/webp', licence: 'Apache-2.0', file: 'node_modules/@jsquash/webp/LICENSE' },
  { package: '@jsquash/avif', licence: 'Apache-2.0', file: 'node_modules/@jsquash/avif/LICENSE' },
  {
    package: '@jsquash/oxipng',
    licence: 'Apache-2.0',
    file: 'node_modules/@jsquash/oxipng/LICENSE',
  },
  {
    package: '@cantoo/pdf-lib',
    licence: 'MIT',
    file: 'node_modules/@cantoo/pdf-lib/LICENSE.md',
  },
  {
    package: 'jszip',
    licence: 'MIT OR GPL-3.0-or-later',
    file: 'node_modules/jszip/LICENSE.markdown',
    note: 'Used under the MIT option.',
  },
  { package: 'comlink', licence: 'Apache-2.0', file: 'node_modules/comlink/LICENSE' },
  { package: 'react', licence: 'MIT', file: 'node_modules/react/LICENSE' },
  { package: 'react-dom', licence: 'MIT', file: 'node_modules/react-dom/LICENSE' },
  { package: 'scheduler', licence: 'MIT', file: 'node_modules/scheduler/LICENSE' },
];

/** Where a package's notice is served from, inside the build. */
export function licencePath(name) {
  return `licences/${name.replace('@', '').replace('/', '-')}.txt`;
}
