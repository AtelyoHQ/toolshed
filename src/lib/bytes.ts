/**
 * Size formatting and parsing.
 *
 * Everything here is 1024-based, including the `KB`/`MB` labels. That is the
 * convention the forms and mail systems people are fighting with use ("must be
 * under 200 KB" almost always means 204800 bytes), and mixing a 1000-based
 * display with a 1024-based target is how a compressor lands just over budget.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
export const KIB = 1024;

/** Decimal places that keep roughly three significant figures. */
function decimalsFor(value: number, unitIndex: number): number {
  if (unitIndex === 0) return 0;
  if (value < 10) return 2;
  if (value < 100) return 1;
  return 0;
}

/**
 * Formats a byte count for display, e.g. `1.46 MB`.
 *
 * Rounding is applied before the unit is finalised, so 1048570 bytes reads as
 * `1.00 MB` rather than `1024.00 KB`.
 */
export function formatBytes(bytes: number, precision?: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;

  while (value >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit += 1;
  }

  let places = precision ?? decimalsFor(value, unit);
  // Rounding can push the value up into the next unit (1023.7 KB -> 1.00 MB).
  if (Number(value.toFixed(places)) >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit += 1;
    places = precision ?? decimalsFor(value, unit);
  }

  return `${sign}${value.toFixed(places)} ${UNITS[unit]}`;
}

/**
 * Percentage of the original size removed. Negative when the output grew,
 * which the UI needs to be able to say out loud rather than hide.
 *
 * A zero-byte source has no meaningful percentage, so it reports 0 rather
 * than an infinity the UI would have to special-case anyway.
 */
export function percentSaved(originalBytes: number, resultBytes: number): number {
  if (originalBytes <= 0) return 0;
  return ((originalBytes - resultBytes) / originalBytes) * 100;
}

/** `-62.4%` for a reduction, `+3.1%` for growth. */
export function formatDelta(originalBytes: number, resultBytes: number): string {
  const saved = percentSaved(originalBytes, resultBytes);
  const rounded = Math.abs(saved) < 0.05 ? 0 : saved;
  // ASCII on both sides: a typographic minus and an ASCII plus are different
  // widths, and these sit in a column.
  const sign = rounded > 0 ? '-' : rounded < 0 ? '+' : '';
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}

const SIZE_PATTERN = /^\s*([0-9]*\.?[0-9]+)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib|k|m|g|t)?\s*$/i;

/**
 * Parses a user-typed size budget such as `200kb`, `1.5 MB` or `750`.
 * A bare number is read as kilobytes, which is what people mean when a form
 * says "200" next to a KB label. Returns null if it cannot be read.
 */
export function parseSize(input: string): number | null {
  const match = SIZE_PATTERN.exec(input);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const suffix = (match[2] ?? 'kb').toLowerCase();
  const exponent: Record<string, number> = {
    b: 0,
    k: 1,
    kb: 1,
    kib: 1,
    m: 2,
    mb: 2,
    mib: 2,
    g: 3,
    gb: 3,
    gib: 3,
    t: 4,
    tb: 4,
    tib: 4,
  };
  const power = exponent[suffix];
  if (power === undefined) return null;

  // Rounding happens after the positive check, so '0.0001' would otherwise
  // come back as a perfectly valid budget of zero bytes.
  const bytes = Math.round(amount * KIB ** power);
  // Beyond the safe integer range the value is no longer the number typed,
  // and no file is that size anyway.
  if (!Number.isSafeInteger(bytes) || bytes < 1) return null;
  return bytes;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
