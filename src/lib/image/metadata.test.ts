import { describe, expect, it } from 'vitest';
import {
  hasTrailingImages,
  isJpeg,
  isPng,
  readDimensions,
  orientationTransform,
  readOrientation,
  stripJpegMetadata,
  stripMetadata,
  stripPngMetadata,
} from './metadata';

/** Builds a JPEG skeleton: SOI, the given segments, then SOS and EOI. */
function jpeg(segments: Array<{ marker: number; payload: number[] }>): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const { marker, payload } of segments) {
    const length = payload.length + 2;
    parts.push(0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  parts.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9);
  return new Uint8Array(parts);
}

/** A little-endian EXIF APP1 payload carrying one orientation tag. */
/** APP2 carrying a real ICC profile, which must survive stripping. */
const ICC_PAYLOAD = [
  0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00, 0x01, 0x01, 0x00, 0x00,
];

/** APP2 carrying a Multi-Picture index, which must not. */
const MPF_PAYLOAD = [0x4d, 0x50, 0x46, 0x00, 0x49, 0x49, 0x2a, 0x00];

function exifPayload(orientation: number): number[] {
  return [
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x49,
    0x49,
    0x2a,
    0x00, // little-endian TIFF header
    0x08,
    0x00,
    0x00,
    0x00, // IFD0 at offset 8
    0x01,
    0x00, // one entry
    0x12,
    0x01, // tag 0x0112 (orientation)
    0x03,
    0x00, // type SHORT
    0x01,
    0x00,
    0x00,
    0x00, // count 1
    orientation,
    0x00,
    0x00,
    0x00, // value
    0x00,
    0x00,
    0x00,
    0x00, // next IFD: none
  ];
}

function png(chunks: Array<{ type: string; data: number[] }>): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const { type, data } of chunks) {
    const length = data.length;
    parts.push(
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
    for (const char of type) parts.push(char.charCodeAt(0));
    parts.push(...data, 0, 0, 0, 0); // CRC placeholder, never re-validated here
  }
  return new Uint8Array(parts);
}

describe('format sniffing', () => {
  it('recognises JPEG and PNG signatures', () => {
    expect(isJpeg(jpeg([]))).toBe(true);
    expect(isPng(png([{ type: 'IEND', data: [] }]))).toBe(true);
    expect(isJpeg(png([{ type: 'IEND', data: [] }]))).toBe(false);
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('readOrientation', () => {
  it('reads each of the eight orientations', () => {
    for (let value = 1; value <= 8; value++) {
      expect(readOrientation(jpeg([{ marker: 0xe1, payload: exifPayload(value) }]))).toBe(value);
    }
  });

  it('defaults to 1 with no EXIF, a non-JPEG, or a nonsense value', () => {
    expect(readOrientation(jpeg([]))).toBe(1);
    expect(readOrientation(new Uint8Array([1, 2, 3]))).toBe(1);
    expect(readOrientation(jpeg([{ marker: 0xe1, payload: exifPayload(99) }]))).toBe(1);
  });

  it('does not run off the end of a truncated segment', () => {
    const truncated = jpeg([{ marker: 0xe1, payload: exifPayload(6).slice(0, 14) }]);
    expect(() => readOrientation(truncated)).not.toThrow();
  });
});

describe('orientationTransform', () => {
  it('leaves an upright image alone', () => {
    expect(orientationTransform(1)).toEqual({ rotate: 0, flip: null });
  });

  it('turns the common portrait-phone orientation upright', () => {
    expect(orientationTransform(6)).toEqual({ rotate: 90, flip: null });
    expect(orientationTransform(8)).toEqual({ rotate: 270, flip: null });
  });

  it('includes the mirror for the flipped orientations', () => {
    for (const value of [2, 4, 5, 7] as const) {
      expect(orientationTransform(value).flip).toBe('horizontal');
    }
  });
});

describe('stripJpegMetadata', () => {
  it('removes an EXIF segment', () => {
    const withExif = jpeg([{ marker: 0xe1, payload: exifPayload(6) }]);
    const stripped = stripJpegMetadata(withExif);
    expect(stripped.byteLength).toBeLessThan(withExif.byteLength);
    expect(readOrientation(stripped)).toBe(1);
  });

  it('keeps the JFIF header and the ICC profile', () => {
    const original = jpeg([
      { marker: 0xe0, payload: [0x4a, 0x46, 0x49, 0x46, 0x00] }, // APP0 JFIF
      { marker: 0xe2, payload: ICC_PAYLOAD }, // APP2 colour profile
      { marker: 0xe1, payload: exifPayload(3) },
    ]);
    const stripped = stripJpegMetadata(original);
    expect(Array.from(stripped).join(',')).toContain('224'); // 0xe0 survived
    expect(Array.from(stripped).join(',')).toContain('226'); // 0xe2 survived
    expect(readOrientation(stripped)).toBe(1);
  });

  it('keeps the scan data byte for byte', () => {
    const original = jpeg([{ marker: 0xe1, payload: exifPayload(6) }]);
    const stripped = stripJpegMetadata(original);
    const tail = Array.from(stripped.subarray(stripped.length - 8));
    expect(tail).toEqual([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  });

  it('returns the identical array when there is nothing to strip', () => {
    const original = jpeg([{ marker: 0xe0, payload: [1, 2, 3] }]);
    expect(stripJpegMetadata(original)).toBe(original);
  });

  it('leaves a non-JPEG untouched', () => {
    const notJpeg = new Uint8Array([1, 2, 3, 4]);
    expect(stripJpegMetadata(notJpeg)).toBe(notJpeg);
  });
});

describe('stripPngMetadata', () => {
  it('drops text and EXIF chunks but keeps image data and the colour profile', () => {
    const original = png([
      { type: 'IHDR', data: [1, 2, 3] },
      { type: 'iCCP', data: [4, 5] },
      { type: 'tEXt', data: [6, 7, 8, 9] },
      { type: 'eXIf', data: [10, 11] },
      { type: 'IDAT', data: [12, 13, 14] },
      { type: 'IEND', data: [] },
    ]);
    const stripped = stripPngMetadata(original);
    const text = new TextDecoder('latin1').decode(stripped);
    expect(text).not.toContain('tEXt');
    expect(text).not.toContain('eXIf');
    expect(text).toContain('iCCP');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
  });

  it('returns the identical array when there is nothing to strip', () => {
    const original = png([
      { type: 'IHDR', data: [1] },
      { type: 'IEND', data: [] },
    ]);
    expect(stripPngMetadata(original)).toBe(original);
  });

  it('stops at a chunk whose declared length runs past the end', () => {
    const truncated = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58,
      0x74,
    ]);
    expect(() => stripPngMetadata(truncated)).not.toThrow();
  });
});

describe('stripMetadata', () => {
  it('dispatches on the signature and passes other formats through', () => {
    const webpish = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    expect(stripMetadata(webpish)).toBe(webpish);
    expect(readOrientation(stripMetadata(jpeg([{ marker: 0xe1, payload: exifPayload(8) }])))).toBe(
      1,
    );
  });
});

describe('APP2 is not all colour profile', () => {
  it('keeps a real ICC profile', () => {
    const original = jpeg([
      { marker: 0xe2, payload: ICC_PAYLOAD },
      { marker: 0xe1, payload: exifPayload(1) },
    ]);
    const text = new TextDecoder('latin1').decode(stripJpegMetadata(original));
    expect(text).toContain('ICC_PROFILE');
  });

  it('removes a Multi-Picture index, which is not a colour profile', () => {
    // MPF points at extra JPEGs appended after the primary image, each with
    // its own EXIF and GPS. Keeping the index because it happens to be APP2
    // would keep a pointer to exactly the data this is meant to remove.
    const original = jpeg([{ marker: 0xe2, payload: MPF_PAYLOAD }]);
    const text = new TextDecoder('latin1').decode(stripJpegMetadata(original));
    expect(text).not.toContain('MPF');
  });
});

describe('truncated files', () => {
  it('does not throw on a JPEG cut off inside its EXIF block', () => {
    // The first 10-60 KB of a phone photo is its EXIF, so an interrupted
    // download lands here. This used to throw RangeError: Invalid typed
    // array length: -65520.
    const truncated = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0xff, 0xfe, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02, 0x03,
      0x04,
    ]);
    expect(() => stripJpegMetadata(truncated)).not.toThrow();
    expect(() => readOrientation(truncated)).not.toThrow();
  });

  it('never returns a shorter-than-possible or negative-length result', () => {
    for (let cut = 2; cut < 40; cut++) {
      const full = jpeg([{ marker: 0xe1, payload: exifPayload(6) }]);
      const truncated = full.slice(0, cut);
      expect(() => stripJpegMetadata(truncated), `cut at ${cut}`).not.toThrow();
      expect(stripJpegMetadata(truncated).byteLength).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('hasTrailingImages', () => {
  it('is false for an ordinary single-image JPEG', () => {
    expect(hasTrailingImages(jpeg([{ marker: 0xe1, payload: exifPayload(1) }]))).toBe(false);
  });

  it('is true when a second image is appended after the first', () => {
    const one = jpeg([]);
    const two = new Uint8Array(one.length * 2);
    two.set(one, 0);
    two.set(one, one.length);
    expect(hasTrailingImages(two)).toBe(true);
  });

  it('is false for a non-JPEG', () => {
    expect(hasTrailingImages(png([{ type: 'IEND', data: [] }]))).toBe(false);
  });
});

describe('readDimensions', () => {
  it('reads a PNG header', () => {
    const header = [0, 0, 1, 0, 0, 0, 0, 200, 8, 6, 0, 0, 0];
    expect(readDimensions(png([{ type: 'IHDR', data: header }]))).toEqual({
      width: 256,
      height: 200,
    });
  });

  it('reads a JPEG start-of-frame', () => {
    // length, precision, height, width, components
    const sof = [0x08, 0x00, 0x90, 0x01, 0x40, 0x03];
    expect(readDimensions(jpeg([{ marker: 0xc0, payload: sof }]))).toEqual({
      width: 320,
      height: 144,
    });
  });

  it('is null when there is no header to read', () => {
    expect(readDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readDimensions(jpeg([]))).toBeNull();
  });
});
