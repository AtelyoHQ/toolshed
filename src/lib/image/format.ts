/**
 * Format detection from the bytes themselves.
 *
 * The browser's reported MIME type is not reliable here: Chrome and Firefox
 * report an empty type for `.heic`, which is the format people most often need
 * to convert, and a renamed file reports whatever its extension suggests.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp' | 'heic';

/** Formats this application can write. */
export type EncodableFormat = Extract<ImageFormat, 'jpeg' | 'png' | 'webp' | 'avif'>;

export const ENCODABLE: readonly EncodableFormat[] = ['jpeg', 'png', 'webp', 'avif'];

const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
};

const EXTENSION: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  bmp: 'bmp',
  heic: 'heic',
};

export function mimeFor(format: ImageFormat): string {
  return MIME[format];
}

export function extensionFor(format: ImageFormat): string {
  return EXTENSION[format];
}

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * Sniffs the format, or returns null when it is not an image this app knows.
 *
 * HEIC and AVIF are both ISO base media containers, told apart by the brand in
 * the `ftyp` box — getting that wrong sends the file to the wrong decoder.
 */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < 12) return null;

  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (matches(bytes, 0, [0x42, 0x4d])) return 'bmp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';

  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'hevc' ||
      brand === 'heim' ||
      brand === 'heis' ||
      brand === 'hevm' ||
      brand === 'hevs' ||
      brand === 'mif1' ||
      brand === 'msf1'
    ) {
      return 'heic';
    }
  }
  return null;
}

export function isEncodable(format: ImageFormat): format is EncodableFormat {
  return (ENCODABLE as readonly string[]).includes(format);
}

/** Formats with an alpha channel; decides whether flattening is needed. */
export function supportsAlpha(format: EncodableFormat): boolean {
  return format !== 'jpeg';
}
