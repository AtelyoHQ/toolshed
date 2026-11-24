import { describe, expect, it } from 'vitest';
import { extensionFor, isEncodable, mimeFor, sniffFormat, supportsAlpha } from './format';

function bytes(...parts: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part);
    else for (const char of part) out.push(char.charCodeAt(0));
  }
  // Pad past the 12-byte minimum the sniffer requires.
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
}

describe('sniffFormat', () => {
  it('recognises the raster formats by signature', () => {
    expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffFormat(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(sniffFormat(bytes('GIF89a'))).toBe('gif');
    expect(sniffFormat(bytes('BM'))).toBe('bmp');
    expect(sniffFormat(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp');
  });

  it('tells AVIF and HEIC apart by their ftyp brand', () => {
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'avif'))).toBe('avif');
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBe('heic');
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'mif1'))).toBe('heic');
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'heix'))).toBe('heic');
  });

  it('ignores the file name entirely, so a renamed file still works', () => {
    // A HEIC saved as "photo.jpg" is common after a careless export.
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBe('heic');
  });

  it('returns null for things that are not images it knows', () => {
    expect(sniffFormat(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffFormat(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffFormat(bytes(0, 0, 0, 0x18, 'ftyp', 'qt  '))).toBeNull();
  });
});

describe('format metadata', () => {
  it('maps to MIME types and extensions', () => {
    expect(mimeFor('jpeg')).toBe('image/jpeg');
    expect(extensionFor('jpeg')).toBe('jpg');
    expect(extensionFor('heic')).toBe('heic');
  });

  it('knows which formats it can write', () => {
    expect(isEncodable('jpeg')).toBe(true);
    expect(isEncodable('heic')).toBe(false);
    expect(isEncodable('gif')).toBe(false);
  });

  it('knows JPEG is the only one without alpha', () => {
    expect(supportsAlpha('jpeg')).toBe(false);
    expect(supportsAlpha('png')).toBe(true);
    expect(supportsAlpha('webp')).toBe(true);
    expect(supportsAlpha('avif')).toBe(true);
  });
});
