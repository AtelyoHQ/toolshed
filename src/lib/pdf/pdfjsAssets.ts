import jbig2Url from 'pdfjs-dist/wasm/jbig2.wasm?url';
import openjpegUrl from 'pdfjs-dist/wasm/openjpeg.wasm?url';
import qcmsUrl from 'pdfjs-dist/wasm/qcms_bg.wasm?url';
import jbig2LicenceUrl from 'pdfjs-dist/wasm/LICENSE_JBIG2?url';
import openjpegLicenceUrl from 'pdfjs-dist/wasm/LICENSE_OPENJPEG?url';
import qcmsLicenceUrl from 'pdfjs-dist/wasm/LICENSE_QCMS?url';
import jbig2WrapperLicenceUrl from 'pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2?url';
import openjpegWrapperLicenceUrl from 'pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG?url';
import qcmsWrapperLicenceUrl from 'pdfjs-dist/wasm/LICENSE_PDFJS_QCMS?url';
import dingbatsUrl from 'pdfjs-dist/standard_fonts/FoxitDingbats.pfb?url';
import fixedUrl from 'pdfjs-dist/standard_fonts/FoxitFixed.pfb?url';
import fixedBoldUrl from 'pdfjs-dist/standard_fonts/FoxitFixedBold.pfb?url';
import fixedBoldItalicUrl from 'pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb?url';
import fixedItalicUrl from 'pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb?url';
import serifUrl from 'pdfjs-dist/standard_fonts/FoxitSerif.pfb?url';
import serifBoldUrl from 'pdfjs-dist/standard_fonts/FoxitSerifBold.pfb?url';
import serifBoldItalicUrl from 'pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb?url';
import serifItalicUrl from 'pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb?url';
import symbolUrl from 'pdfjs-dist/standard_fonts/FoxitSymbol.pfb?url';
import sansBoldUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import sansBoldItalicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url';
import sansItalicUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url';
import sansRegularUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';
import foxitLicenceUrl from 'pdfjs-dist/standard_fonts/LICENSE_FOXIT?url';
import liberationLicenceUrl from 'pdfjs-dist/standard_fonts/LICENSE_LIBERATION?url';

import cmapLicenceUrl from 'pdfjs-dist/cmaps/LICENSE?url';

/**
 * Adobe's notice for the maps, which their licence asks to travel with them:
 * a `.bcmap` is the compiled form of a CMap, and clause 2 is about binary
 * redistribution. The glob below takes `*.bcmap`, so this one file in the same
 * directory is the one it would miss.
 */
const CMAP_LICENCE: Record<string, string> = { LICENSE: cmapLicenceUrl };

/**
 * The predefined character maps, all 168 of them, as one glob.
 *
 * Named by a relative path into `node_modules` because a bare specifier
 * cannot be globbed, and one by one would be 168 import lines that have to be
 * revised on every pdfjs-dist upgrade. Vite resolves this at build time, so
 * the set is whatever the installed pdfjs-dist carries.
 *
 * The path assumes a flat `node_modules`, which is what this repo's
 * `package-lock.json` installs. Under a store-based installer it would match
 * nothing and this file's own checks would not notice, because one directory
 * holding one LICENSE is a consistent layout — so `check:bundle` counts the
 * emitted maps against the installed package and fails on any shortfall.
 *
 * Eager, which costs something only in development: the dev server serves each
 * of these as its own tiny module, so the PDF worker's first load fetches 168
 * of them. A build inlines the URLs into the chunk and emits the files, which
 * is the point. Lazy would spare development that and cost the build 168
 * dynamic-import chunks, which is the worse end of the trade.
 */
const CMAP_ASSETS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
      query: '?url',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
);

/**
 * Everything pdf.js resolves at runtime, pinned to assets from this build.
 *
 * This file exists because of ground rule 1 in CONTRIBUTING.md. pdf.js does
 * not statically import the files below; it builds a URL from a base it is
 * given and fetches it. Those bases default to `null`, and left alone pdf.js
 * requests paths like `nullopenjpeg.wasm` and `nullLiberationSans-Regular.ttf`
 * — requests nobody chose, to a URL built out of a missing setting — or, in
 * the one case that checks first (colour management), silently does without.
 * (That concatenation happens inside pdf.js's worker, which is where this
 * build does its loading — see `useWorkerFetch` in `pdfjs.ts`. The main-thread
 * path throws instead.) Naming the assets here makes them part of the
 * build: same-origin, emitted into `dist/`, and runtime-cached by the service
 * worker — which needed a rule of its own, since a `.pfb` matches none of the
 * patterns written for scripts and wasm and the application promises to work
 * offline.
 *
 * Three groups, because pdf.js takes a base URL for each:
 *
 * - the **wasm** modules, for JPEG 2000 and JBIG2 images (openjpeg, jbig2)
 *   and ICC colour management (qcms), each with its licence notice beside it;
 * - the **standard fonts**, which are the fourteen typefaces every PDF reader
 *   is required to provide and which documents therefore do not embed. Without
 *   them a page using Helvetica renders with substituted glyphs, which would
 *   make rasterised compression quietly change a document's typography. Their
 *   two licence notices travel with them — BSD-style for the Foxit fonts, the
 *   GPL v2 font exception for Liberation Sans — because both ask that of a
 *   redistribution and a deployed `dist/` would otherwise drop them.
 *
 * - the **character maps**, 1.2 MB across 168 files, which were very nearly
 *   left out of this on the grounds that they only matter to a document using
 *   a predefined CMap. That was wrong, and the way it was wrong is worth
 *   recording: pdf.js also fetches `<registry>-<ordering>-UCS2.bcmap` to build
 *   a Unicode map for *any* composite font with no `/ToUnicode` entry, which
 *   Word and Acrobat both produce. Without it `translateFont` throws, the font
 *   becomes an `ErrorFont` whose `charsToGlyphs` returns nothing, and the page
 *   renders blank and extracts no text — so a Japanese document would have
 *   rasterised to empty pages and been reported as a successful saving.
 *   A compressor that returns a blank document is the worst failure this
 *   engine has, and it was one unbundled directory away. `compress.ts` now
 *   refuses such a result outright, whatever caused it.
 *
 * Two things pdf.js can also resolve are deliberately left out:
 *
 * - `quickjs-eval.wasm`, 469 KB of JavaScript engine for scripted forms. It
 *   is reached only from `pdf.sandbox.mjs`, which this project never imports,
 *   and its base URL defaults to a relative path rather than to nothing — so
 *   neither the privacy argument nor the capability argument applies.
 * - `iccUrl`, one CMYK profile. pdf.js checks that one before using it and
 *   warns instead of requesting anything, so a CMYK image renders through its
 *   own naive conversion rather than through the profile.
 *
 * The `*_nowasm_fallback.js` pair, which pdf.js reaches for if instantiating
 * openjpeg or jbig2 fails, is not bundled either: that path is a same-origin
 * 404 and the image is then skipped, which is the same outcome as the fallback
 * failing to help.
 *
 * All three are worth doing deliberately, and not in this change.
 *
 * The directories are the awkward part: pdf.js wants one base URL per group
 * and appends its own file names to it, so these assets must keep their names
 * and sit side by side. `vite.config.ts` has the rule,
 * `scripts/check-bundle.mjs` fails the build if the emitted layout stops
 * matching, and `assertSiblings` below is the last line of that defence at
 * runtime: better a thrown error naming the cause than a silent fall back to
 * fetching from somewhere else.
 */

const WASM_ASSETS: Record<string, string> = {
  'jbig2.wasm': jbig2Url,
  'openjpeg.wasm': openjpegUrl,
  'qcms_bg.wasm': qcmsUrl,
};

/**
 * Their licence notices, which ship for the same reason the fonts' do: these
 * are BSD and MIT, both of which ask that the notice travel with a binary
 * redistribution, and a deployed `dist/` is one.
 *
 * Two per binary, because each of these three is upstream code compiled
 * together with a wrapper pdf.js wrote; the `LICENSE_PDFJS_*` half is
 * Mozilla's notice for that wrapper. Between them they are BSD, MIT and
 * Apache-2.0, and each asks that the notice travel with the binary. quickjs
 * has a pair too and neither ships, because the binary does not.
 */
const WASM_LICENCES: Record<string, string> = {
  LICENSE_JBIG2: jbig2LicenceUrl,
  LICENSE_OPENJPEG: openjpegLicenceUrl,
  LICENSE_QCMS: qcmsLicenceUrl,
  LICENSE_PDFJS_JBIG2: jbig2WrapperLicenceUrl,
  LICENSE_PDFJS_OPENJPEG: openjpegWrapperLicenceUrl,
  LICENSE_PDFJS_QCMS: qcmsWrapperLicenceUrl,
};

export const STANDARD_FONT_ASSETS: Record<string, string> = {
  'FoxitDingbats.pfb': dingbatsUrl,
  'FoxitFixed.pfb': fixedUrl,
  'FoxitFixedBold.pfb': fixedBoldUrl,
  'FoxitFixedBoldItalic.pfb': fixedBoldItalicUrl,
  'FoxitFixedItalic.pfb': fixedItalicUrl,
  'FoxitSerif.pfb': serifUrl,
  'FoxitSerifBold.pfb': serifBoldUrl,
  'FoxitSerifBoldItalic.pfb': serifBoldItalicUrl,
  'FoxitSerifItalic.pfb': serifItalicUrl,
  'FoxitSymbol.pfb': symbolUrl,
  'LiberationSans-Bold.ttf': sansBoldUrl,
  'LiberationSans-BoldItalic.ttf': sansBoldItalicUrl,
  'LiberationSans-Italic.ttf': sansItalicUrl,
  'LiberationSans-Regular.ttf': sansRegularUrl,
};

const resolved = new Map<string, string>();

/**
 * The absolute URL of the directory holding pdf.js's wasm, with a trailing
 * slash (pdf.js rejects a base URL without one).
 *
 * Absolute, not relative: pdf.js resolves this inside *its* worker, where a
 * relative URL would be read against that worker's script rather than against
 * the page.
 */
export function pdfjsWasmDirectory(): string {
  return directoryOf('wasm', { ...WASM_ASSETS, ...WASM_LICENCES });
}

/**
 * The licence notices for the fonts above, which are served from the same
 * directory for their licences' benefit rather than for pdf.js's: the Foxit
 * fonts are BSD-style and Liberation Sans is GPL v2 with font exceptions, and
 * both ask that the notice travel with the files.
 */
export const FONT_LICENCES: Record<string, string> = {
  LICENSE_FOXIT: foxitLicenceUrl,
  LICENSE_LIBERATION: liberationLicenceUrl,
};

/** The same, for the fourteen standard fonts and their licences. */
export function pdfjsFontDirectory(): string {
  return directoryOf('standard fonts', { ...STANDARD_FONT_ASSETS, ...FONT_LICENCES });
}

/** The same, for the character maps and their notice. */
export function pdfjsCMapDirectory(): string {
  return directoryOf('character maps', { ...CMAP_ASSETS, ...CMAP_LICENCE });
}

function directoryOf(label: string, assets: Record<string, string>): string {
  const cached = resolved.get(label);
  if (cached) return cached;

  const directory = assertSiblings(label, assets);
  resolved.set(label, directory);
  return directory;
}

function assertSiblings(label: string, assets: Record<string, string>): string {
  const base = typeof self !== 'undefined' ? self.location.href : location.href;
  const directories = new Set<string>();

  for (const [name, url] of Object.entries(assets)) {
    const resolvedUrl = new URL(url, base);
    if (!resolvedUrl.pathname.endsWith(`/${name}`)) {
      throw new Error(
        `pdf.js expects to find ${name} by name, but the build emitted it as ` +
          `${resolvedUrl.pathname}. See the asset naming rule in vite.config.ts.`,
      );
    }
    directories.add(new URL('.', resolvedUrl).href);
  }

  if (directories.size !== 1) {
    throw new Error(
      `pdf.js can only be given one directory of ${label}, but the build ` +
        `spread it across: ${[...directories].join(', ')}.`,
    );
  }
  return [...directories][0]!;
}
