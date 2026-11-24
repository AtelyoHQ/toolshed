import { describe, expect, it } from 'vitest';
import { kindOf, withExtension, withSuffix } from './types';

describe('kindOf', () => {
  it('uses the MIME type when it is given', () => {
    expect(kindOf('a.bin', 'application/pdf')).toBe('pdf');
    expect(kindOf('a.bin', 'image/png')).toBe('image');
  });

  it('falls back to the extension when the browser reports no type', () => {
    // Chrome and Firefox report '' for .heic, the format most in need of this.
    expect(kindOf('IMG_0001.HEIC', '')).toBe('image');
    expect(kindOf('scan.PDF', '')).toBe('pdf');
  });

  it('reports anything else as unknown', () => {
    expect(kindOf('notes.txt', 'text/plain')).toBe('unknown');
    expect(kindOf('archive', '')).toBe('unknown');
  });
});

describe('name helpers', () => {
  it('replaces the extension', () => {
    expect(withExtension('photo.heic', 'jpg')).toBe('photo.jpg');
    expect(withExtension('photo', 'jpg')).toBe('photo.jpg');
    expect(withExtension('my.photo.heic', 'webp')).toBe('my.photo.webp');
  });

  it('inserts a suffix before the extension', () => {
    expect(withSuffix('scan.pdf', '-compressed')).toBe('scan-compressed.pdf');
    expect(withSuffix('scan', '-compressed')).toBe('scan-compressed');
  });
});
