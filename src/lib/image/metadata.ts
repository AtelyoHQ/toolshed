/**
 * Metadata reading and lossless stripping.
 *
 * Stripping matters more than it sounds: a photo straight off a phone carries
 * GPS coordinates, the device serial and a timestamp, and people post those
 * files to the internet without knowing. Toolshed removes them by default.
 *
 * Re-encoding drops metadata for free, so the functions here exist for the
 * case where you want the metadata gone *without* touching the pixels — no
 * generation loss, byte-identical image data.
 */

/** EXIF orientation, 1..8. 1 means "already the right way up". */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface OrientationTransform {
  rotate: 0 | 90 | 180 | 270;
  flip: 'horizontal' | null;
}

/**
 * The pixel transform that puts an image the right way up.
 *
 * This has to be applied *before* the EXIF tag is discarded. Strip the tag and
 * leave the pixels, and every photo taken in portrait comes out on its side —
 * a bug these tools ship with regularly.
 */
export function orientationTransform(orientation: Orientation): OrientationTransform {
  switch (orientation) {
    case 1:
      return { rotate: 0, flip: null };
    case 2:
      return { rotate: 0, flip: 'horizontal' };
    case 3:
      return { rotate: 180, flip: null };
    case 4:
      return { rotate: 180, flip: 'horizontal' };
    case 5:
      return { rotate: 90, flip: 'horizontal' };
    case 6:
      return { rotate: 90, flip: null };
    case 7:
      return { rotate: 270, flip: 'horizontal' };
    case 8:
      return { rotate: 270, flip: null };
  }
}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
/** Markers that carry no payload length. */
const STANDALONE = new Set([0x01, SOI, EOI, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === SOI;
}

export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

interface JpegSegment {
  marker: number;
  start: number;
  end: number;
}

/** Walks the marker segments before the compressed scan data. */
function* jpegSegments(bytes: Uint8Array): Generator<JpegSegment> {
  let i = 2; // past SOI
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return;
    const marker = bytes[i + 1] ?? 0;
    if (marker === SOS || marker === EOI) return;
    if (STANDALONE.has(marker)) {
      i += 2;
      continue;
    }
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (length < 2) return;
    yield { marker, start: i, end: i + 2 + length };
    i += 2 + length;
  }
}

function readUint16(bytes: Uint8Array, at: number, little: boolean): number {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  return little ? (b << 8) | a : (a << 8) | b;
}

function readUint32(bytes: Uint8Array, at: number, little: boolean): number {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  const c = bytes[at + 2] ?? 0;
  const d = bytes[at + 3] ?? 0;
  return little
    ? ((d << 24) | (c << 16) | (b << 8) | a) >>> 0
    : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function isExifSegment(bytes: Uint8Array, segment: JpegSegment): boolean {
  if (segment.marker !== 0xe1) return false;
  return EXIF_HEADER.every((byte, index) => bytes[segment.start + 4 + index] === byte);
}

/**
 * Reads the EXIF orientation tag, returning 1 when there is none.
 * Hand-rolled rather than pulled from a library: it is one tag, and this keeps
 * a parser for untrusted input small enough to read in one sitting.
 */
export function readOrientation(bytes: Uint8Array): Orientation {
  if (!isJpeg(bytes)) return 1;

  for (const segment of jpegSegments(bytes)) {
    if (!isExifSegment(bytes, segment)) continue;

    const tiff = segment.start + 10;
    const byteOrder = readUint16(bytes, tiff, false);
    if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return 1;
    const little = byteOrder === 0x4949;
    if (readUint16(bytes, tiff + 2, little) !== 42) return 1;

    const ifdOffset = readUint32(bytes, tiff + 4, little);
    const ifd = tiff + ifdOffset;
    if (ifd + 2 > segment.end) return 1;

    const entries = readUint16(bytes, ifd, little);
    for (let e = 0; e < entries; e++) {
      const entry = ifd + 2 + e * 12;
      if (entry + 12 > segment.end) break;
      if (readUint16(bytes, entry, little) !== 0x0112) continue;
      const value = readUint16(bytes, entry + 8, little);
      return value >= 1 && value <= 8 ? (value as Orientation) : 1;
    }
    return 1;
  }
  return 1;
}

/** APP1 (EXIF/XMP), APP2 (ICC is kept), APP13 (IPTC/Photoshop), COM. */
const STRIPPABLE_JPEG = new Set([
  0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe,
]);

/**
 * Removes metadata segments from a JPEG without recompressing it.
 *
 * The ICC colour profile (APP2) is kept: dropping it shifts the colours of
 * wide-gamut photos, which is a visible change to the image, not metadata.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpeg(bytes)) return bytes;

  const keep: Array<[number, number]> = [[0, 2]];
  let cursor = 2;
  let removed = 0;

  for (const segment of jpegSegments(bytes)) {
    if (!STRIPPABLE_JPEG.has(segment.marker)) continue;
    if (segment.start > cursor) keep.push([cursor, segment.start]);
    cursor = segment.end;
    removed += segment.end - segment.start;
  }
  if (removed === 0) return bytes;

  keep.push([cursor, bytes.length]);
  const total = keep.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

/** Text, timestamp and EXIF chunks. iCCP is kept, for the reason above. */
const STRIPPABLE_PNG = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);

/** Removes metadata chunks from a PNG without touching the image data. */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (!isPng(bytes)) return bytes;

  const keep: Array<[number, number]> = [[0, 8]];
  let i = 8;
  let removed = 0;

  while (i + 8 <= bytes.length) {
    const length = readUint32(bytes, i, false);
    const type = String.fromCharCode(
      bytes[i + 4] ?? 0,
      bytes[i + 5] ?? 0,
      bytes[i + 6] ?? 0,
      bytes[i + 7] ?? 0,
    );
    const end = i + 12 + length;
    if (end > bytes.length) break;

    if (STRIPPABLE_PNG.has(type)) removed += end - i;
    else keep.push([i, end]);

    i = end;
    if (type === 'IEND') break;
  }
  if (removed === 0) return bytes;

  const total = keep.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of keep) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

/** Strips metadata from whichever of the two formats carries it in-band. */
export function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (isJpeg(bytes)) return stripJpegMetadata(bytes);
  if (isPng(bytes)) return stripPngMetadata(bytes);
  return bytes;
}
