import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPdf,
  buildPdf,
  buildPdfWithMetadata,
  drawnText,
  pageOperators,
} from '../../../test/pdfFixtures';
import { loadDocument } from './document';
import { PageSelectionError, PdfOperationError } from './errors';
import {
  displayedBox,
  formatPageNumber,
  numberPages,
  placeText,
  rotatedAnchor,
  toPageSpace,
  watermarkPdf,
  type Placement,
} from './stamp';

const PAGE = { width: 200, height: 100 };
const TEXT = { width: 40, height: 10 };

describe('placeText', () => {
  it('puts a corner placement inside its margin', () => {
    expect(placeText('bottom-left', PAGE, TEXT, 5)).toEqual({ x: 5, y: 5 });
    expect(placeText('top-right', PAGE, TEXT, 5)).toEqual({ x: 155, y: 85 });
  });

  /** PDF coordinates grow upwards; getting this backwards hides the stamp. */
  it('places the top above the bottom, because y grows upwards', () => {
    const top = placeText('top-center', PAGE, TEXT, 5);
    const bottom = placeText('bottom-center', PAGE, TEXT, 5);
    expect(top.y).toBeGreaterThan(bottom.y);
  });

  it('centres the text on both axes for the middle placement', () => {
    expect(placeText('center', PAGE, TEXT, 5)).toEqual({ x: 80, y: 45 });
  });

  it('ignores the margin where the placement is centred on that axis', () => {
    const narrow = placeText('bottom-center', PAGE, TEXT, 5);
    const wide = placeText('bottom-center', PAGE, TEXT, 40);
    expect(narrow.x).toBe(wide.x);
    expect(wide.y).toBe(40);
  });

  it('keeps every placement on the page', () => {
    const placements: Placement[] = [
      'center',
      'top-left',
      'top-center',
      'top-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ];
    for (const placement of placements) {
      const at = placeText(placement, PAGE, TEXT, 5);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + TEXT.width).toBeLessThanOrEqual(PAGE.width);
      expect(at.y + TEXT.height).toBeLessThanOrEqual(PAGE.height);
    }
  });
});

describe('displayedBox and toPageSpace', () => {
  it("swaps the page's sides for a quarter turn and leaves them for a half", () => {
    expect(displayedBox({ width: 300, height: 600 }, 90)).toEqual({ width: 600, height: 300 });
    expect(displayedBox({ width: 300, height: 600 }, 270)).toEqual({ width: 600, height: 300 });
    expect(displayedBox({ width: 300, height: 600 }, 180)).toEqual({ width: 300, height: 600 });
    expect(displayedBox({ width: 300, height: 600 }, 0)).toEqual({ width: 300, height: 600 });
  });

  it('leaves a point alone on an unrotated page', () => {
    expect(toPageSpace({ x: 10, y: 20 }, { width: 300, height: 600 }, 0)).toEqual({ x: 10, y: 20 });
  });

  /**
   * The corner this is all for: on a page marked 90, the bottom-left of what
   * the reader sees is the bottom-*right* of the media box.
   */
  it('maps the displayed bottom-left corner to the right corner of the page', () => {
    const page = { width: 300, height: 600 };
    expect(toPageSpace({ x: 0, y: 0 }, page, 90)).toEqual({ x: 300, y: 0 });
    expect(toPageSpace({ x: 0, y: 0 }, page, 180)).toEqual({ x: 300, y: 600 });
    expect(toPageSpace({ x: 0, y: 0 }, page, 270)).toEqual({ x: 0, y: 600 });
  });

  it('keeps a point inside the page for every rotation', () => {
    const page = { width: 300, height: 600 };
    for (const turn of [0, 90, 180, 270]) {
      const displayed = displayedBox(page, turn);
      const at = toPageSpace({ x: displayed.width / 2, y: displayed.height / 2 }, page, turn);
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.x).toBeLessThanOrEqual(page.width);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeLessThanOrEqual(page.height);
    }
  });

  it('is reversible: four quarter turns of the same point agree with the geometry', () => {
    const page = { width: 200, height: 400 };
    // A point in the middle of the displayed page is the middle of the media
    // box whatever the rotation, which pins the maths without restating it.
    for (const turn of [0, 90, 180, 270]) {
      const displayed = displayedBox(page, turn);
      expect(toPageSpace({ x: displayed.width / 2, y: displayed.height / 2 }, page, turn)).toEqual({
        x: 100,
        y: 200,
      });
    }
  });
});

describe('rotatedAnchor', () => {
  it('is the bottom-left corner when nothing is rotated', () => {
    expect(rotatedAnchor({ x: 100, y: 50 }, TEXT, 0)).toEqual({ x: 80, y: 45 });
  });

  /**
   * pdf-lib rotates text about the point it is drawn from, not about its
   * middle, so without this correction a 45° watermark asked for "centre"
   * hangs off the top-right corner of the page.
   */
  it('shifts the anchor so a rotated string still straddles the centre', () => {
    const centre = { x: 100, y: 50 };
    const anchor = rotatedAnchor(centre, TEXT, 45);
    const radians = Math.PI / 4;
    const middle = {
      x: anchor.x + (TEXT.width / 2) * Math.cos(radians) - (TEXT.height / 2) * Math.sin(radians),
      y: anchor.y + (TEXT.width / 2) * Math.sin(radians) + (TEXT.height / 2) * Math.cos(radians),
    };
    expect(middle.x).toBeCloseTo(centre.x);
    expect(middle.y).toBeCloseTo(centre.y);
  });

  it('puts a quarter-turned string back where it started after four turns', () => {
    const centre = { x: 100, y: 50 };
    for (const rotation of [0, 90, 180, 270, 360]) {
      const anchor = rotatedAnchor(centre, TEXT, rotation);
      const radius = Math.hypot(anchor.x - centre.x, anchor.y - centre.y);
      // The anchor always sits half a diagonal from the centre, whatever the
      // angle: only its direction changes.
      expect(radius).toBeCloseTo(Math.hypot(TEXT.width / 2, TEXT.height / 2));
    }
  });
});

describe('formatPageNumber', () => {
  it('substitutes the page and the total', () => {
    expect(formatPageNumber('{page} of {total}', 3, 9)).toBe('3 of 9');
  });

  it('substitutes every occurrence, and leaves a template with neither alone', () => {
    expect(formatPageNumber('{page}/{page}', 2, 9)).toBe('2/2');
    expect(formatPageNumber('draft', 2, 9)).toBe('draft');
  });
});

describe('watermarkPdf', () => {
  it('draws the text on every page without changing the page count or size', async () => {
    const result = await watermarkPdf(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
      {
        text: 'DRAFT',
      },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(await drawnText(result.bytes, 0)).toContain('DRAFT');
    expect(await drawnText(result.bytes, 1)).toContain('DRAFT');
  });

  it('draws only on the pages named', async () => {
    const result = await watermarkPdf(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
      { text: 'DRAFT', pages: [2] },
    );

    expect(await drawnText(result.bytes, 0)).not.toContain('DRAFT');
    expect(await drawnText(result.bytes, 1)).toContain('DRAFT');
    expect(result.note).toMatch(/Stamped 1 of 2 pages/);
  });

  it('keeps what was on the page already', async () => {
    const result = await watermarkPdf(
      await buildPdf([{ width: 300, height: 400, text: 'Original content' }]),
      { text: 'DRAFT' },
    );

    const drawn = await drawnText(result.bytes, 0);
    expect(drawn).toContain('Original content');
    expect(drawn).toContain('DRAFT');
  });

  it('writes the opacity as a transparency group, not as a pale colour', async () => {
    const result = await watermarkPdf(await buildPdf([{ width: 300, height: 400 }]), {
      text: 'DRAFT',
      opacity: 0.2,
    });
    // `gs` selects a graphics state, which is where a fill alpha lives.
    expect(await pageOperators(result.bytes, 0)).toMatch(/\bgs\b/);
  });

  /**
   * Stamping is publishing: the twelve other operations drop the author and
   * the producing application, and there is no reason for these two to be the
   * exception. Asserted so the inconsistency cannot creep back in.
   */
  it('drops the document metadata, like every other operation', async () => {
    const result = await watermarkPdf(await buildPdfWithMetadata(), { text: 'DRAFT' });
    const doc = await loadDocument(result.bytes);
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getProducer()).toBeUndefined();
  });

  /**
   * The cleanup at the end of this function is what makes the result openable
   * at all. Nothing else would notice if that one call went missing.
   */
  it('leaves a document that had a password openable without one', async () => {
    const result = await watermarkPdf(
      await buildEncryptedPdf({ userPassword: 'open-me', pages: [{ width: 300, height: 400 }] }),
      { text: 'DRAFT', password: 'open-me' },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.note).toMatch(/anyone with this file can open it/);
  });

  /**
   * Same correction as for the page numbers, on the other stamp: the matrix
   * has to carry the page's own quarter turn, or a 45 degree watermark on a
   * turned scan comes out at 135.
   */
  it('turns the stamp with the page when the page is rotated', async () => {
    const upright = await watermarkPdf(await buildPdf([{ width: 300, height: 600 }]), {
      text: 'DRAFT',
      rotation: 0,
    });
    const turned = await watermarkPdf(await buildPdf([{ width: 300, height: 600, rotate: 90 }]), {
      text: 'DRAFT',
      rotation: 0,
    });

    expect(await pageOperators(upright.bytes, 0)).toMatch(/1 0 0 1 /);
    expect(await pageOperators(turned.bytes, 0)).toMatch(/ 1 -1 /);
  });

  /**
   * A cropped scan's box does not start at the origin, and `getSize` says
   * nothing about where it starts. Placing against the size alone puts the
   * stamp off the visible page entirely.
   */
  it('places the stamp inside a box that does not start at the origin', async () => {
    const result = await watermarkPdf(
      await buildPdf([{ width: 300, height: 400, offset: { x: 100, y: 100 } }]),
      { text: 'DRAFT', rotation: 0, placement: 'bottom-left', margin: 10 },
    );

    const operators = await pageOperators(result.bytes, 0);
    const matrix = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(operators);
    expect(matrix).not.toBeNull();
    expect(Number(matrix![1])).toBeGreaterThanOrEqual(100);
    expect(Number(matrix![2])).toBeGreaterThanOrEqual(100);
  });

  it('refuses an empty watermark', async () => {
    await expect(
      watermarkPdf(await buildPdf([{ width: 300, height: 400 }]), { text: '  ' }),
    ).rejects.toThrow(PdfOperationError);
  });

  it('refuses an opacity that would make the stamp invisible or opaque nonsense', async () => {
    const bytes = await buildPdf([{ width: 300, height: 400 }]);
    await expect(watermarkPdf(bytes, { text: 'X', opacity: 0 })).rejects.toThrow(PdfOperationError);
    await expect(watermarkPdf(bytes, { text: 'X', opacity: 1.5 })).rejects.toThrow(
      PdfOperationError,
    );
  });

  /**
   * The built-in fonts are Latin-1. Without this translation the person gets
   * pdf-lib's "WinAnsi cannot encode" with a code point in it, which says
   * nothing about what to do next.
   */
  it('explains itself when the text is outside what the built-in fonts cover', async () => {
    await expect(
      watermarkPdf(await buildPdf([{ width: 300, height: 400 }]), { text: 'ЧЕРНОВИК' }),
    ).rejects.toThrow(/Western European/);
  });
});

describe('numberPages', () => {
  it('numbers every page from 1', async () => {
    const result = await numberPages(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
    );

    expect(await drawnText(result.bytes, 0)).toContain('1');
    expect(await drawnText(result.bytes, 2)).toContain('3');
  });

  it('starts at the number asked for', async () => {
    const result = await numberPages(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
      { startAt: 97 },
    );

    expect(await drawnText(result.bytes, 0)).toContain('97');
    expect(await drawnText(result.bytes, 1)).toContain('98');
  });

  /**
   * A cover and a contents page that are not part of the numbering: the
   * numbers start on page 3 and the total counts what was numbered, because
   * "1 / 10" on a document numbered 1..8 is simply wrong.
   */
  it('numbers a run of pages, counting the run rather than the document', async () => {
    const result = await numberPages(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
      { pages: [3, 4], template: '{page} / {total}' },
    );

    expect(await drawnText(result.bytes, 0)).not.toContain('/');
    expect(await drawnText(result.bytes, 2)).toContain('1 / 2');
    expect(await drawnText(result.bytes, 3)).toContain('2 / 2');
  });

  it('counts the total up to the highest number it will stamp', async () => {
    const result = await numberPages(
      await buildPdf([
        { width: 300, height: 400 },
        { width: 300, height: 400 },
      ]),
      { startAt: 97, template: '{page} / {total}' },
    );

    expect(await drawnText(result.bytes, 0)).toContain('97 / 98');
    expect(await drawnText(result.bytes, 1)).toContain('98 / 98');
  });

  /**
   * A scan from a phone or an office machine arrives with `/Rotate` set, and
   * so does anything this engine's own rotate tool produced. Placing the
   * number in media-box coordinates there puts it along a side edge, lying on
   * its side. The matrices simply have to differ.
   */
  it('places the number for the page as displayed, not as stored', async () => {
    const upright = await numberPages(await buildPdf([{ width: 300, height: 600 }]));
    const turned = await numberPages(await buildPdf([{ width: 300, height: 600, rotate: 90 }]));

    const uprightOperators = await pageOperators(upright.bytes, 0);
    const turnedOperators = await pageOperators(turned.bytes, 0);
    expect(uprightOperators).not.toBe(turnedOperators);
    // An unrotated text matrix, against one carrying a quarter turn.
    expect(uprightOperators).toMatch(/1 0 0 1 [\d.]+ 24 Tm/);
    expect(turnedOperators).toMatch(/ 1 -1 /);
    // And the number has moved off the media box's bottom edge, because that
    // edge is a side of the page as the reader sees it.
    expect(turnedOperators).not.toMatch(/ 24 Tm/);
  });

  it('leaves a document that had a password openable without one', async () => {
    const result = await numberPages(
      await buildEncryptedPdf({ userPassword: 'open-me', pages: [{ width: 300, height: 400 }] }),
      { password: 'open-me' },
    );

    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('numbers a page whose box does not start at the origin', async () => {
    const result = await numberPages(
      await buildPdf([{ width: 300, height: 600, offset: { x: 100, y: 100 } }]),
    );

    const matrix = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(await pageOperators(result.bytes, 0));
    expect(matrix).not.toBeNull();
    // The bottom edge of this page is y = 100, so a number at y = 24 would be
    // under the sheet.
    expect(Number(matrix![2])).toBe(124);
  });

  it('refuses a fractional starting number', async () => {
    await expect(
      numberPages(await buildPdf([{ width: 300, height: 400 }]), { startAt: 1.5 }),
    ).rejects.toThrow(PdfOperationError);
  });

  it('refuses a page the document does not have', async () => {
    await expect(
      numberPages(await buildPdf([{ width: 300, height: 400 }]), { pages: [4] }),
    ).rejects.toThrow(PageSelectionError);
  });

  it('drops the document metadata, like every other operation', async () => {
    const result = await numberPages(await buildPdfWithMetadata());
    const doc = await loadDocument(result.bytes);
    expect(doc.getAuthor()).toBeUndefined();
  });
});
