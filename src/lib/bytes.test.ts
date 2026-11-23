import { describe, expect, it } from 'vitest';
import { clamp, formatBytes, formatDelta, KIB, parseSize, percentSaved } from './bytes';

describe('formatBytes', () => {
  it('shows plain bytes without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('switches unit at the 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
  });

  it('carries into the next unit when rounding would otherwise read as 1024', () => {
    // 1048570 B is 1023.99.. KB; showing "1024.00 KB" would be wrong.
    expect(formatBytes(1048570)).toBe('1.00 MB');
  });

  it('keeps about three significant figures', () => {
    expect(formatBytes(12 * KIB)).toBe('12.0 KB');
    expect(formatBytes(123 * KIB)).toBe('123 KB');
  });

  it('handles negatives and non-finite input', () => {
    expect(formatBytes(-2048)).toBe('-2.00 KB');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('honours an explicit precision', () => {
    expect(formatBytes(1536, 0)).toBe('2 KB');
  });
});

describe('percentSaved', () => {
  it('reports the fraction removed', () => {
    expect(percentSaved(1000, 250)).toBe(75);
  });

  it('goes negative when the output grew', () => {
    expect(percentSaved(100, 150)).toBe(-50);
  });

  it('does not divide by zero', () => {
    expect(percentSaved(0, 10)).toBe(0);
  });
});

describe('formatDelta', () => {
  it('marks a reduction with a minus and growth with a plus', () => {
    expect(formatDelta(1000, 250)).toBe('-75.0%');
    expect(formatDelta(100, 150)).toBe('+50.0%');
  });

  it('shows no sign when nothing changed', () => {
    expect(formatDelta(1000, 1000)).toBe('0.0%');
  });
});

describe('parseSize', () => {
  it('reads a bare number as kilobytes', () => {
    expect(parseSize('200')).toBe(200 * KIB);
  });

  it('reads explicit units, case and spacing insensitively', () => {
    expect(parseSize('200kb')).toBe(200 * KIB);
    expect(parseSize('  1.5 MB ')).toBe(Math.round(1.5 * KIB ** 2));
    expect(parseSize('500B')).toBe(500);
    expect(parseSize('2g')).toBe(2 * KIB ** 3);
  });

  it('treats KB and KiB alike, because the UI only shows one of them', () => {
    expect(parseSize('200kib')).toBe(parseSize('200kb'));
  });

  it('rejects junk, zero and negatives', () => {
    for (const bad of ['', 'abc', '0', '-5', '200 tons', '1.2.3']) {
      expect(parseSize(bad), bad).toBeNull();
    }
  });
});

describe('clamp', () => {
  it('bounds a value on both sides', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('parseSize edge cases', () => {
  it('rejects a budget that rounds away to nothing', () => {
    // Rounding happens after the positive check, so this used to come back as
    // a perfectly valid target of zero bytes.
    expect(parseSize('0.0001')).toBeNull();
    expect(parseSize('0.4b')).toBeNull();
  });

  it('accepts the smallest real budget', () => {
    expect(parseSize('1b')).toBe(1);
  });

  it('reads back every unit formatBytes can print', () => {
    for (const size of [900, 2 * KIB, 5 * KIB ** 2, 3 * KIB ** 3, 2 * KIB ** 4]) {
      const printed = formatBytes(size);
      expect(parseSize(printed), printed).not.toBeNull();
    }
  });
});

describe('parseSize bounds', () => {
  it('refuses a number too large to be exact', () => {
    expect(parseSize('999999999999999999999 tb')).toBeNull();
  });

  it('still accepts a plausibly large budget', () => {
    expect(parseSize('8gb')).toBe(8 * KIB ** 3);
  });
});
