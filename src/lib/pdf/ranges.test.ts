import { describe, expect, it } from 'vitest';
import { PageSelectionError } from './errors';
import {
  allPages,
  checkPageOrder,
  checkPages,
  parsePageSelection,
  spanLabel,
  spansForSplitPoints,
  toIndices,
} from './ranges';

describe('parsePageSelection', () => {
  it('reads a single page', () => {
    expect(parsePageSelection('4', 10)).toEqual([4]);
  });

  it('reads a range inclusively at both ends', () => {
    expect(parsePageSelection('4-7', 10)).toEqual([4, 5, 6, 7]);
  });

  it('reads an open-ended range as "to the last page"', () => {
    expect(parsePageSelection('8-', 10)).toEqual([8, 9, 10]);
  });

  it('accepts commas and spaces between terms', () => {
    expect(parsePageSelection('1, 3  5-6', 10)).toEqual([1, 3, 5, 6]);
  });

  it('accepts a range typed with spaces around the hyphen', () => {
    expect(parsePageSelection('1, 4 - 6', 10)).toEqual([1, 4, 5, 6]);
  });

  it('sorts and de-duplicates overlapping selections', () => {
    expect(parsePageSelection('5-7,2,6', 10)).toEqual([2, 5, 6, 7]);
  });

  it('understands "all"', () => {
    expect(parsePageSelection('ALL', 3)).toEqual([1, 2, 3]);
  });

  it('refuses an empty selection rather than selecting nothing', () => {
    expect(() => parsePageSelection('   ', 10)).toThrow(PageSelectionError);
  });

  it('refuses a page past the end of the document, naming its length', () => {
    expect(() => parsePageSelection('11', 10)).toThrow(/10 pages/);
  });

  it('refuses page 0, because pages are counted from 1', () => {
    expect(() => parsePageSelection('0-2', 10)).toThrow(PageSelectionError);
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => parsePageSelection('7-4', 10)).toThrow(/ends before it starts/);
  });

  it('refuses something that is not a page at all', () => {
    expect(() => parsePageSelection('last', 10)).toThrow(/not a page or a range/);
  });

  it('refuses any selection against a document with no pages', () => {
    expect(() => parsePageSelection('1', 0)).toThrow(/no pages/);
  });
});

describe('checkPages', () => {
  it('sorts and de-duplicates', () => {
    expect(checkPages([3, 1, 3], 5)).toEqual([1, 3]);
  });

  it('refuses an empty list', () => {
    expect(() => checkPages([], 5)).toThrow(PageSelectionError);
  });

  it('refuses a page the document does not have', () => {
    expect(() => checkPages([2, 9], 5)).toThrow(PageSelectionError);
  });
});

describe('checkPageOrder', () => {
  it('accepts a complete permutation', () => {
    expect(checkPageOrder([3, 1, 2], 3)).toEqual([3, 1, 2]);
  });

  it('refuses an order that leaves pages out, which would lose them', () => {
    expect(() => checkPageOrder([2, 1], 3)).toThrow(/all 3 pages/);
  });

  it('refuses an order that repeats a page', () => {
    expect(() => checkPageOrder([1, 1, 2], 3)).toThrow(/appears twice/);
  });
});

describe('spansForSplitPoints', () => {
  it('turns one point into the two documents either side of it', () => {
    expect(spansForSplitPoints([3], 10)).toEqual([
      [1, 3],
      [4, 10],
    ]);
  });

  it('handles several points, sorted and de-duplicated', () => {
    expect(spansForSplitPoints([7, 3, 3], 10)).toEqual([
      [1, 3],
      [4, 7],
      [8, 10],
    ]);
  });

  it('refuses a point on the last page, which would make an empty document', () => {
    expect(() => spansForSplitPoints([10], 10)).toThrow(/between 1 and 9/);
  });

  it('refuses a point past the end of the document', () => {
    expect(() => spansForSplitPoints([14], 10)).toThrow(PageSelectionError);
  });

  it('refuses no points at all', () => {
    expect(() => spansForSplitPoints([], 10)).toThrow(/No split points/);
  });
});

describe('labels and index conversion', () => {
  it('labels a single page by its number and a span by both ends', () => {
    expect(spanLabel([4, 4])).toBe('4');
    expect(spanLabel([4, 7])).toBe('4-7');
  });

  it('converts page numbers to the zero-based indices pdf-lib wants', () => {
    expect(toIndices(allPages(3))).toEqual([0, 1, 2]);
  });
});
