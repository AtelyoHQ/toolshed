import {
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  type PDFDict,
  type PDFDocument,
} from '@cantoo/pdf-lib';
import { isJpeg } from '../image/metadata';
import type { RasterImage } from '../image/raster';

/**
 * Re-encoding the photographs inside a PDF, leaving everything else alone.
 *
 * This is the compression strategy for documents that are mostly text with
 * some pictures in them: a 12-page report with four screenshots is nearly all
 * image bytes, and running those four images through a better JPEG encoder
 * takes most of the size out while the text stays text — selectable,
 * searchable, and sharp at any zoom. The alternative strategy, rasterising
 * every page, would throw all of that away.
 *
 * Only JPEG (`DCTDecode`) images are touched, and only where the colour space
 * is one that survives a round trip through an RGB encoder. Everything else is
 * left exactly as it was found: an indexed-palette logo, a CMYK photograph
 * bound for a printer and a JBIG2 scan each have properties that re-encoding
 * would silently destroy, and a tool that quietly ruins a press-ready file is
 * worse than one that says it did nothing.
 */

export interface JpegCodec {
  decode(bytes: Uint8Array): Promise<RasterImage>;
  encode(image: RasterImage, quality: number): Promise<Uint8Array>;
}

export interface RecompressOptions {
  /** 1..100, passed to the JPEG encoder. */
  quality: number;
  /**
   * Images smaller than this are skipped. Re-encoding a 2 KB icon costs a
   * decode and an encode to save a few hundred bytes, and more often than not
   * it grows: the encoder's own tables are a fixed cost.
   */
  minBytes?: number;
}

export interface RecompressReport {
  /** JPEG images whose colour space this strategy can handle. */
  considered: number;
  replaced: number;
  /** Considered, re-encoded, and the result was no smaller. */
  keptLarger: number;
  /** Could not be decoded, so left untouched. */
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}

const DCT_DECODE = PDFName.of('DCTDecode');
const IMAGE = PDFName.of('Image');

/** Colour spaces whose samples an RGB JPEG can represent without a lie. */
const DIRECT_SPACES = new Set(['DeviceRGB', 'DeviceGray', 'CalRGB', 'CalGray']);

export async function recompressJpegStreams(
  doc: PDFDocument,
  options: RecompressOptions,
  jpeg: JpegCodec,
  onProgress?: (fraction: number) => void,
): Promise<RecompressReport> {
  const minBytes = options.minBytes ?? 4096;
  const report: RecompressReport = {
    considered: 0,
    replaced: 0,
    keptLarger: 0,
    failed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };

  const candidates = jpegImageStreams(doc);
  for (const [index, stream] of candidates.entries()) {
    onProgress?.(index / Math.max(1, candidates.length));

    const original = stream.getContents();
    if (original.byteLength < minBytes) continue;
    report.considered += 1;
    report.bytesBefore += original.byteLength;

    let candidate: Uint8Array;
    let decoded: RasterImage;
    try {
      decoded = await jpeg.decode(original);
      candidate = await jpeg.encode(decoded, options.quality);
    } catch {
      // A malformed image inside an otherwise fine document is common enough
      // — generators truncate streams — and is no reason to fail the job.
      report.failed += 1;
      report.bytesAfter += original.byteLength;
      continue;
    }

    if (candidate.byteLength >= original.byteLength) {
      report.keptLarger += 1;
      report.bytesAfter += original.byteLength;
      continue;
    }

    replaceJpeg(stream, candidate, decoded);
    report.replaced += 1;
    report.bytesAfter += candidate.byteLength;
  }

  onProgress?.(1);
  return report;
}

/**
 * The JPEG image XObjects this strategy is willing to touch.
 *
 * Exported for the tests, which assert on *which* images are picked rather
 * than only on the size of the output — the mistakes that matter here are
 * about leaving the wrong image alone, or not leaving the right one.
 */
export function jpegImageStreams(doc: PDFDocument): PDFRawStream[] {
  const streams: PDFRawStream[] = [];

  // Every object, not every page's resources: an image can be referenced from
  // a form XObject, a pattern or an annotation's appearance as easily as from
  // a page. The cost is re-encoding an image no page uses, in a document that
  // carries orphans — wasted work on a file that was already carrying weight.

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    // Looked up rather than read: every one of these entries is allowed to be
    // an indirect reference, and a generator that uses one would otherwise
    // have its images skipped and the person told there was nothing to
    // compress.
    if (dict.lookup(PDFName.of('Subtype')) !== IMAGE) continue;
    if (!isDctDecode(dict)) continue;

    // A `/Decode` array remaps the samples — commonly `[1 0 1 0 1 0]` to
    // invert a scan. The decoder we hand the bytes to knows nothing about it,
    // so re-encoding would bake in the un-inverted pixels and the viewer
    // would invert them a second time.
    if (dict.has(PDFName.of('Decode'))) continue;
    // Three-channel images only. A one-channel JPEG is nearly always a soft
    // mask — the transparency of the image beside it — and an `/SMask` must be
    // DeviceGray: pdf.js refuses a colour one outright ("Reading gray scale
    // from a color image"). Since the encoder here writes three channels,
    // touching a grey image would mean either re-tagging it DeviceRGB, which
    // breaks the mask, or claiming a channel count the bytes do not have.
    // Grey JPEGs also usually *grow* when written as three channels, so this
    // gives up almost nothing.
    if (componentsOf(dict) !== 3) continue;
    // The bytes of a DCTDecode stream are a JPEG file. If they are not, the
    // document is lying about its own filter and the decoder would reject it.
    if (!isJpeg(object.getContents())) continue;

    streams.push(object);
  }
  return streams;
}

function isDctDecode(dict: PDFDict): boolean {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter === DCT_DECODE) return true;
  // A filter chain. Only a lone DCTDecode is safe to replace: anything
  // wrapped around it (an encrypted or Flate-wrapped JPEG) would need
  // unwrapping and re-wrapping to stay valid.
  if (filter instanceof PDFArray) {
    return filter.size() === 1 && dict.context.lookup(filter.get(0)) === DCT_DECODE;
  }
  return false;
}

/**
 * How many components this image's colour space has, or null if it is not one
 * this strategy understands.
 *
 * A number rather than a yes or no because one channel and three mean
 * different things to the caller: three is what the encoder writes, and one is
 * a mask it must not touch.
 */
function componentsOf(dict: PDFDict): 1 | 3 | null {
  const space = dict.lookup(PDFName.of('ColorSpace'));
  if (space instanceof PDFName) {
    const name = space.asString().slice(1);
    if (!DIRECT_SPACES.has(name)) return null;
    return name === 'DeviceGray' || name === 'CalGray' ? 1 : 3;
  }

  const array = space instanceof PDFArray ? space : undefined;
  if (!array || array.size() < 2) return null;

  const family = dict.context.lookup(array.get(0));
  if (!(family instanceof PDFName)) return null;
  const name = family.asString().slice(1);
  if (name === 'CalRGB') return 3;
  if (name === 'CalGray') return 1;
  // ICCBased is the common case for anything produced by Acrobat. Its N tells
  // us how many components the samples have; 4 is CMYK, which an RGB encoder
  // cannot carry, and anything else is not something to guess at.
  if (name !== 'ICCBased') return null;

  const profile = dict.context.lookupMaybe(array.get(1), PDFStream);
  const components = profile?.dict.lookupMaybe(PDFName.of('N'), PDFNumber)?.asNumber();
  return components === 1 || components === 3 ? components : null;
}

/**
 * Points an image XObject at new JPEG bytes.
 *
 * The dictionary is edited rather than rebuilt so that everything the engine
 * does not understand survives: a soft mask, a clipping mask, the rendering
 * intent, optional-content membership. `DecodeParms` has to go, because its
 * `ColorTransform` describes the old bytes' channel layout.
 *
 * `ColorSpace` is left exactly as it was found, which is only safe because
 * the walk takes three-channel images and the encoder writes three channels.
 * Rewriting it would be worse than useless: mozjpeg neither applies nor
 * removes an ICC profile, so the samples come back in whatever space they
 * were in, and stamping `DeviceRGB` over an Adobe RGB or Display P3 profile
 * would leave the pixels alone while telling every reader they mean something
 * else — a visible colour shift in a file this engine claimed only to have
 * recompressed.
 */
function replaceJpeg(stream: PDFRawStream, bytes: Uint8Array, image: RasterImage): void {
  const { dict } = stream;
  stream.updateContents(bytes);
  dict.set(PDFName.of('Width'), PDFNumber.of(image.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(image.height));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(PDFName.of('Filter'), DCT_DECODE);
  dict.delete(PDFName.of('DecodeParms'));
}
