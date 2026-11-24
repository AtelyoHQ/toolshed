import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  type PDFDocument,
  type PDFPageLeaf,
} from '@cantoo/pdf-lib';
import {
  createDocument,
  loadDocument,
  requirePages,
  resultNote,
  saveDocument,
  type LoadOptions,
} from './document';
import { PdfOperationError } from './errors';
import { recompressJpegStreams, type JpegCodec, type RecompressReport } from './jpegStreams';
import { allPages } from './ranges';
import { checkDpi, pointsForPixels, type PdfRasterizer } from './render';
import type { PdfResult } from './types';

/**
 * Making a PDF smaller, two ways.
 *
 * There is no single right strategy, because the two kinds of document people
 * bring to these tools are nothing alike.
 *
 * `images` re-encodes the photographs and leaves the text and the vectors
 * where they are. A report with screenshots in it loses most of its weight and
 * stays selectable, searchable and crisp. It has no equivalent of the
 * blank-render guard below because it does not rebuild the document: it
 * rewrites one image stream at a time, counts a stream it could not decode as
 * a failure and leaves it exactly as it was, and never touches the page tree,
 * the text or anything else. So a failed codec here costs the saving on that
 * one image, not the page. The part not guarded is a decoder that returns
 * wrong pixels without raising — this rests on the codec throwing, which is
 * the behaviour the image engine has relied on since it shipped.
 *
 * `rasterize` renders every page and rebuilds the document from those
 * pictures. It destroys the text layer, which sounds unacceptable until you
 * meet the file people actually arrive with: a 40 MB scan from an office
 * multifunction device, which has no text layer to lose and which the other
 * strategy barely dents.
 *
 * Both drop metadata and save with object streams on, and **neither may
 * silently return something bigger than it was given** — see `decideResult`.
 */

export type CompressStrategy = 'images' | 'rasterize';

export interface CompressOptions extends LoadOptions {
  strategy: CompressStrategy;
  /** 1..100, for whichever JPEGs the strategy writes. */
  quality: number;
  /** `rasterize` only: the resolution each page is rendered at. */
  dpi?: number;
  /**
   * Hand back the original when the "compressed" file came out bigger.
   *
   * On by default, and the interface has no reason to turn it off: the issue
   * this engine answers calls the behaviour out by name. It is a setting
   * rather than a constant so that a test can see what a strategy actually
   * produced, which is how the strategies themselves are measured.
   */
  neverGrow?: boolean;
  /** `images` only: see `RecompressOptions.minBytes`. */
  minImageBytes?: number;
}

export interface CompressDeps {
  jpeg: JpegCodec;
  /** Required by `rasterize`, unused by `images`. */
  rasterizer?: PdfRasterizer;
}

export async function compressPdf(
  bytes: Uint8Array,
  options: CompressOptions,
  deps: CompressDeps,
  onProgress?: (fraction: number) => void,
): Promise<PdfResult> {
  if (!Number.isFinite(options.quality) || options.quality < 1 || options.quality > 100) {
    throw new PdfOperationError('Quality must be between 1 and 100.');
  }

  return options.strategy === 'images'
    ? compressImages(bytes, options, deps, onProgress)
    : compressByRasterising(bytes, options, deps, onProgress);
}

async function compressImages(
  bytes: Uint8Array,
  options: CompressOptions,
  deps: CompressDeps,
  onProgress?: (fraction: number) => void,
): Promise<PdfResult> {
  const doc = await loadDocument(bytes, options);
  const pages = requirePages(doc);
  onProgress?.(0.05);

  const report = await recompressJpegStreams(
    doc,
    { quality: options.quality, minBytes: options.minImageBytes },
    deps.jpeg,
    (fraction) => onProgress?.(0.05 + fraction * 0.85),
  );

  const output = await saveDocument(doc);
  onProgress?.(1);
  return decideResult(bytes, output, pages, options, resultNote(doc, imagesNote(report)));
}

async function compressByRasterising(
  bytes: Uint8Array,
  options: CompressOptions,
  deps: CompressDeps,
  onProgress?: (fraction: number) => void,
): Promise<PdfResult> {
  const { rasterizer } = deps;
  if (!rasterizer) {
    throw new PdfOperationError('Rasterising needs a renderer, which this context has none of.');
  }

  const source = await loadDocument(bytes, options);
  const pageCount = requirePages(source);
  const dpi = checkDpi(options.dpi ?? 150);
  onProgress?.(0.02);

  const rebuilt = await createDocument();
  let done = 0;
  let inked = 0;
  await rasterizer.rasterize(
    {
      bytes,
      password: options.password,
      pages: allPages(pageCount),
      dpi,
      format: 'jpeg',
      quality: options.quality,
      measureInk: true,
    },
    async (rendered) => {
      const image = await rebuilt.embedJpg(rendered.bytes);
      // The page keeps the size it had: the render is a picture *of* that
      // page, so its pixels are converted back to points at the resolution
      // they were drawn at. Any page rotation is already baked into the
      // render, which is why the rebuilt page carries none.
      const width = pointsForPixels(rendered.width, dpi);
      const height = pointsForPixels(rendered.height, dpi);
      const page = rebuilt.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });

      done += 1;
      // Anything but an explicit `false`: a renderer that was not asked, or
      // one that cannot tell, must not be able to trigger a refusal.
      if (rendered.ink !== false) inked += 1;
      onProgress?.(0.02 + (done / pageCount) * 0.93);
    },
  );

  if (rebuilt.getPageCount() !== pageCount) {
    throw new PdfOperationError(
      `Rendered ${rebuilt.getPageCount()} of ${pageCount} pages; refusing to return a document with pages missing.`,
    );
  }

  // Every page came out blank from a document that has something on it.
  //
  // Every page, not any page: the blank back of a duplex scan is a real page
  // and refusing a document for having one would make this guard worse than
  // the thing it prevents. The cost of that choice is that a document which
  // loses *some* of its pages — a Japanese report with a Latin cover — is
  // still accepted, which is the known limit of this guard rather than a
  // reason to widen it.
  //
  // This is the failure that makes rasterising dangerous rather than lossy:
  // pdf.js degrades by drawing nothing — a font it cannot translate, an image
  // whose codec would not load — and the result is a smaller file of empty
  // pages that every other check here would call a success. It has happened
  // once already, to CJK documents, when the character maps were not bundled.
  if (inked === 0 && hasDrawableContent(source)) {
    throw new PdfOperationError(
      'Every page rendered blank, so something failed to draw. Refusing to hand back an empty document; try the other compression strategy.',
    );
  }

  const output = await saveDocument(rebuilt);
  onProgress?.(1);
  return decideResult(
    bytes,
    output,
    pageCount,
    options,
    resultNote(
      source,
      `Every page was redrawn at ${dpi} dpi, so the text in it is now part of the picture: it cannot be selected, searched or copied.`,
    ),
  );
}

/**
 * Whether the document has anything to draw at all.
 *
 * So that a document with nothing on it is not refused for rendering as the
 * blank pages it has: a PDF of empty sheets is a real thing to compress.
 *
 * It is narrower than "the pages look blank", and deliberately. A scanner's
 * blank separator sheet still paints a full-page image of a blank sheet, so it
 * names an XObject and a blank render of it *is* refused. That is the trade:
 * nothing here can tell the scan of an empty page from the scan of a full one
 * whose codec failed to load, and of the two mistakes, refusing a document
 * that was empty anyway is the one that costs nobody their file.
 *
 * The question is therefore what a page *names*, not how big its content
 * stream is.
 *
 * The first version of this asked for 32 bytes of content and so switched
 * itself off for the one document rasterising exists for: a scanned page
 * paints one full-page image with `q 612 0 0 792 0 0 cm /Im0 Do Q`, which is
 * about 30 bytes once compressed. A 40 MB scan whose JBIG2 codec failed to
 * load would have come back as blank pages and been called a saving — the
 * exact catastrophe the guard is for, through the exact cause its own comment
 * claimed to cover.
 *
 * A page that paints text names a font; a page that paints an image or a form
 * names an XObject; a gradient names a shading or a pattern. What is left is
 * a page drawn with nothing but inline vector operators, which is why the
 * decoded content length is still consulted as a second signal — but as an
 * *extra* reason to protect a page, never as a precondition.
 */
function hasDrawableContent(doc: PDFDocument): boolean {
  return doc
    .getPages()
    .some((page) => namesSomethingToPaint(page.node) || paintsVectors(page.node));
}

const PAINTING_RESOURCES = [
  PDFName.of('Font'),
  PDFName.of('XObject'),
  PDFName.of('Shading'),
  PDFName.of('Pattern'),
];

function namesSomethingToPaint(page: PDFPageLeaf): boolean {
  // Inherited, because `/Resources` may live on an ancestor of the page.
  const resources = page.Resources();
  if (!resources) return false;

  return PAINTING_RESOURCES.some((key) => {
    const named = resources.lookupMaybe(key, PDFDict);
    return !!named && named.keys().length > 0;
  });
}

/**
 * Content that is long enough to be drawing something by itself.
 *
 * Decoded, not stored: whether a generator compressed a short stream says
 * nothing about what is on the page. Only reached for a page that names no
 * resources, and only when every page came out blank, so this never runs on
 * the happy path.
 */
function paintsVectors(page: PDFPageLeaf): boolean {
  const contents = page.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((entry) => page.context.lookup(entry))
      : [contents];

  let total = 0;
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) continue;
    try {
      total += stream.dict.has(PDFName.of('Filter'))
        ? decodePDFRawStream(stream).decode().length
        : stream.getContentsSize();
    } catch {
      // A content stream this engine cannot decode is one it also cannot
      // judge, so it counts as content rather than as nothing.
      return true;
    }
  }
  return total > 64;
}

function imagesNote(report: RecompressReport): string {
  if (report.considered === 0) {
    return 'No photographs this strategy could re-encode; only the metadata and the file structure were tightened. A document that is all text has nothing here to give.';
  }

  const parts = [
    `Re-encoded ${report.replaced} of ${report.considered} image${report.considered === 1 ? '' : 's'}; text and vector graphics were left alone.`,
  ];
  if (report.keptLarger > 0) {
    parts.push(
      `${report.keptLarger} ${report.keptLarger === 1 ? 'was' : 'were'} already smaller than this quality would make them and ${report.keptLarger === 1 ? 'was' : 'were'} kept as found.`,
    );
  }
  if (report.failed > 0) {
    parts.push(
      `${report.failed} could not be decoded and ${report.failed === 1 ? 'was' : 'were'} left untouched.`,
    );
  }
  return parts.join(' ');
}

/**
 * The promise that holds this whole feature together: a compressor never
 * hands back something bigger than what it was given.
 *
 * An already-optimised PDF — one Acrobat has been through, or one that is all
 * text — comes out larger from either strategy, and returning that as a
 * success is how these tools lose people's trust.
 *
 * What goes back instead is not quite the input. Compression here also means
 * dropping the metadata, and that part worked: the fallback is therefore the
 * same document with its author, producer and XMP packets removed and nothing
 * else touched, which is both smaller than the input and what was asked for.
 * The image engine's equivalent branch does the same, for the same reason.
 * Only if even that is larger does the original come back untouched.
 */
export async function decideResult(
  original: Uint8Array,
  compressed: Uint8Array,
  pages: number,
  options: Pick<CompressOptions, 'neverGrow' | 'password'>,
  note: string | undefined,
): Promise<PdfResult> {
  if (!(options.neverGrow ?? true) || compressed.byteLength < original.byteLength) {
    return { bytes: compressed, pages, note };
  }

  const doc = await loadDocument(original, options);
  const stripped = await saveDocument(doc);
  if (stripped.byteLength < original.byteLength) {
    return {
      bytes: stripped,
      pages,
      unchanged: true,
      // Through `resultNote`, because this document may have had a password:
      // the result does not, and that sentence must not be the one casualty
      // of taking a different branch.
      note: resultNote(
        doc,
        'This PDF is already as small as this strategy can make it, so its content was left exactly as it was; the metadata was still removed.',
      ),
    };
  }

  // The input, byte for byte. Still encrypted if it arrived that way, so there
  // is nothing to warn about here.
  return {
    bytes: original,
    pages,
    unchanged: true,
    note: 'This PDF is already as small as this strategy can make it; compressing it would have made it larger, so it was left alone.',
  };
}
