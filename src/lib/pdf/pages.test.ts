import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPdf,
  buildPdf,
  buildPdfWithMetadata,
  everythingIn,
} from '../../../test/pdfFixtures';
import { loadDocument } from './document';
import { PageSelectionError, PdfOperationError, PasswordRequiredError } from './errors';
import {
  deletePages,
  extractPages,
  mergeDocuments,
  normaliseAngle,
  reorderPages,
  rotatePages,
  splitDocument,
} from './pages';

/**
 * Pages are told apart by their width.
 *
 * A width survives copying, reordering and rotation untouched, so it serves as
 * a label that the operation under test cannot accidentally reproduce — unlike
 * a page's text, which these operations never read, or its index, which is the
 * thing being changed.
 */
async function document(widths: readonly number[]): Promise<Uint8Array> {
  return buildPdf(widths.map((width) => ({ width, height: 400 })));
}

async function widthsOf(bytes: Uint8Array, password?: string): Promise<number[]> {
  const doc = await loadDocument(bytes, { password });
  return doc.getPages().map((page) => page.getSize().width);
}

async function rotationsOf(bytes: Uint8Array): Promise<number[]> {
  const doc = await loadDocument(bytes);
  return doc.getPages().map((page) => page.getRotation().angle);
}

describe('mergeDocuments', () => {
  it('concatenates documents in the order given', async () => {
    const result = await mergeDocuments([
      { bytes: await document([101, 102]) },
      { bytes: await document([201]) },
    ]);

    expect(result.pages).toBe(3);
    expect(await widthsOf(result.bytes)).toEqual([101, 102, 201]);
  });

  it('merges a document that needed a password, into one that does not', async () => {
    const locked = await buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [{ width: 321, height: 400 }],
    });
    const result = await mergeDocuments([
      { bytes: await document([111]) },
      { bytes: locked, password: 'open-me' },
    ]);

    expect(await widthsOf(result.bytes)).toEqual([111, 321]);
  });

  it('warns about a locked document wherever it appears in the list', async () => {
    const locked = await buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [{ width: 321, height: 400 }],
    });
    const result = await mergeDocuments([
      { bytes: await document([111]) },
      { bytes: locked, password: 'open-me' },
    ]);

    expect(result.note).toMatch(/had a password, and the result does not/);
  });

  it('refuses to merge nothing', async () => {
    await expect(mergeDocuments([])).rejects.toThrow(PdfOperationError);
  });

  it('passes the password failure through rather than skipping the document', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(mergeDocuments([{ bytes: locked }])).rejects.toThrow(PasswordRequiredError);
  });
});

describe('splitDocument', () => {
  it('makes one document per page, labelled by page number', async () => {
    const parts = await splitDocument(await document([101, 102, 103]), { mode: 'pages' });

    expect(parts.map((part) => part.label)).toEqual(['1', '2', '3']);
    expect(parts.map((part) => part.pages)).toEqual([1, 1, 1]);
    expect(await widthsOf(parts[1]!.bytes)).toEqual([102]);
  });

  it('splits after each given page, keeping the remainder as the last document', async () => {
    const parts = await splitDocument(await document([101, 102, 103, 104, 105]), {
      mode: 'after',
      points: [2],
    });

    expect(parts.map((part) => part.label)).toEqual(['1-2', '3-5']);
    expect(await widthsOf(parts[0]!.bytes)).toEqual([101, 102]);
    expect(await widthsOf(parts[1]!.bytes)).toEqual([103, 104, 105]);
  });

  it('refuses a split point past the end of the document', async () => {
    await expect(
      splitDocument(await document([101, 102]), { mode: 'after', points: [9] }),
    ).rejects.toThrow(PageSelectionError);
  });

  it('refuses a split point on the last page, which would produce an empty document', async () => {
    await expect(
      splitDocument(await document([101, 102]), { mode: 'after', points: [2] }),
    ).rejects.toThrow(PageSelectionError);
  });
});

describe('reorderPages', () => {
  it('puts the pages in the order given', async () => {
    const result = await reorderPages(await document([101, 102, 103]), [3, 1, 2]);
    expect(await widthsOf(result.bytes)).toEqual([103, 101, 102]);
  });

  it("keeps a page's own rotation with it", async () => {
    const bytes = await buildPdf([
      { width: 101, height: 400 },
      { width: 102, height: 400, rotate: 90 },
    ]);
    const result = await reorderPages(bytes, [2, 1]);

    expect(await widthsOf(result.bytes)).toEqual([102, 101]);
    expect(await rotationsOf(result.bytes)).toEqual([90, 0]);
  });

  it('refuses an order that does not account for every page', async () => {
    await expect(reorderPages(await document([101, 102, 103]), [2, 1])).rejects.toThrow(
      PageSelectionError,
    );
  });
});

describe('rotatePages', () => {
  /**
   * The engine's promise, checked where a person would meet it rather than
   * only on `saveDocument`: turn a page, and the author, the title and the
   * timestamps are gone from the file — not unlinked, gone, including from
   * inside the compressed object streams where they are easy to miss.
   */
  it('leaves none of the document metadata in the result', async () => {
    const result = await rotatePages(await buildPdfWithMetadata(), { turn: 90 });
    const everything = await everythingIn(result.bytes);

    for (const marker of ['A Person', 'Quarterly figures', 'D:20200101', 'dc:creator']) {
      expect(everything, marker).not.toContain(marker);
    }
  });

  it('turns every page when no pages are named', async () => {
    const result = await rotatePages(await document([101, 102]), { turn: 90 });
    expect(await rotationsOf(result.bytes)).toEqual([90, 90]);
  });

  it('turns only the pages named', async () => {
    const result = await rotatePages(await document([101, 102, 103]), { turn: 180, pages: [2] });
    expect(await rotationsOf(result.bytes)).toEqual([0, 180, 0]);
  });

  /**
   * The case that makes rotation relative rather than absolute: a scanner
   * marked this page 90°, and one more turn belongs at 180°, not back at 90°.
   */
  it('adds to the rotation a page already had', async () => {
    const bytes = await buildPdf([{ width: 101, height: 400, rotate: 90 }]);
    const result = await rotatePages(bytes, { turn: 90 });
    expect(await rotationsOf(result.bytes)).toEqual([180]);
  });

  it('wraps past a full turn and accepts turning anticlockwise', async () => {
    const bytes = await buildPdf([{ width: 101, height: 400, rotate: 270 }]);
    expect(await rotationsOf((await rotatePages(bytes, { turn: 90 })).bytes)).toEqual([0]);
    expect(await rotationsOf((await rotatePages(bytes, { turn: -90 })).bytes)).toEqual([180]);
  });

  it('refuses anything that is not a quarter turn', async () => {
    await expect(rotatePages(await document([101]), { turn: 45 })).rejects.toThrow(
      PdfOperationError,
    );
  });

  it('leaves the page size alone: rotation is a viewing instruction', async () => {
    const result = await rotatePages(await document([101, 102]), { turn: 90 });
    expect(await widthsOf(result.bytes)).toEqual([101, 102]);
  });
});

describe('normaliseAngle', () => {
  it('reduces any multiple of a quarter turn to 0, 90, 180 or 270', () => {
    expect([
      normaliseAngle(360),
      normaliseAngle(450),
      normaliseAngle(-90),
      normaliseAngle(-450),
    ]).toEqual([0, 90, 270, 270]);
  });
});

describe('deletePages', () => {
  it('removes the pages named and keeps the rest in order', async () => {
    const result = await deletePages(await document([101, 102, 103, 104]), [2, 4]);
    expect(result.pages).toBe(2);
    expect(await widthsOf(result.bytes)).toEqual([101, 103]);
  });

  /**
   * Deleting low-to-high renumbers the document under your feet: removing
   * page 2 makes the old page 3 into the new page 2. Named here because it is
   * the mistake this operation exists to not make.
   */
  it('deletes the pages the person meant when several are named', async () => {
    const result = await deletePages(await document([101, 102, 103, 104, 105]), [1, 2, 3]);
    expect(await widthsOf(result.bytes)).toEqual([104, 105]);
  });

  it('refuses to delete every page', async () => {
    await expect(deletePages(await document([101, 102]), [1, 2])).rejects.toThrow(/at least one/);
  });

  it('refuses a page the document does not have', async () => {
    await expect(deletePages(await document([101]), [2])).rejects.toThrow(PageSelectionError);
  });
});

/**
 * Every operation here accepts a password and writes an unencrypted result,
 * and that only works if the remains of the old encryption are cleared out:
 * leave them and the file carries an `/Encrypt` reference whose key is gone,
 * which pdf-lib and any reader taking the first trailer refuse to open.
 *
 * One test per shape of operation, because the cleanup is a call at the end of
 * each one and nothing else would notice if a single call went missing.
 */
describe('a document that had a password', () => {
  const locked = () =>
    buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [
        { width: 111, height: 400 },
        { width: 222, height: 400 },
      ],
    });

  it('opens without one after being rotated', async () => {
    const result = await rotatePages(await locked(), { turn: 90, password: 'open-me' });
    expect(await rotationsOf(result.bytes)).toEqual([90, 90]);
    expect(result.note).toMatch(/anyone with this file can open it/);
  });

  it('opens without one after a page is deleted', async () => {
    const result = await deletePages(await locked(), [1], { password: 'open-me' });
    expect(await widthsOf(result.bytes)).toEqual([222]);
  });

  it('opens without one after being reordered', async () => {
    const result = await reorderPages(await locked(), [2, 1], { password: 'open-me' });
    expect(await widthsOf(result.bytes)).toEqual([222, 111]);
  });

  it('opens without one after pages are extracted', async () => {
    const result = await extractPages(await locked(), [1], { password: 'open-me' });
    expect(await widthsOf(result.bytes)).toEqual([111]);
  });

  it('says so in the note, because the lock was on it for a reason', async () => {
    const result = await deletePages(await locked(), [1], { password: 'open-me' });
    expect(result.note).toMatch(/had a password, and the result does not/);
  });

  it('says nothing of the sort when there was no password', async () => {
    const result = await deletePages(await document([101, 102]), [1]);
    expect(result.note).toBeUndefined();
  });

  /**
   * An owner-password document opens for everyone already, so nothing was
   * taken away from the reader and there is nothing to warn about. Saying it
   * anyway would frighten people about a change that did not happen.
   */
  it('says nothing about a document that opened for everyone anyway', async () => {
    const restricted = () =>
      buildEncryptedPdf({
        ownerPassword: 'owner-only',
        pages: [
          { width: 111, height: 400 },
          { width: 222, height: 400 },
        ],
      });

    const withoutPassword = await deletePages(await restricted(), [1]);
    expect(await widthsOf(withoutPassword.bytes)).toEqual([222]);
    expect(withoutPassword.note).toBeUndefined();

    // And the same when the caller hands over the owner password, which it
    // will if it asked what kind of protection the file has: the password it
    // supplied was never what kept anyone out.
    const withPassword = await deletePages(await restricted(), [1], { password: 'owner-only' });
    expect(withPassword.note).toBeUndefined();
  });
});

describe('extractPages', () => {
  it('keeps the pages named, in ascending order', async () => {
    const result = await extractPages(await document([101, 102, 103, 104]), [4, 2]);
    expect(result.pages).toBe(2);
    expect(await widthsOf(result.bytes)).toEqual([102, 104]);
  });

  it('refuses an empty selection rather than returning an empty document', async () => {
    await expect(extractPages(await document([101, 102]), [])).rejects.toThrow(PageSelectionError);
  });

  it('extracts from a document that needed a password, and the result needs none', async () => {
    const locked = await buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [
        { width: 111, height: 400 },
        { width: 222, height: 400 },
      ],
    });
    const result = await extractPages(locked, [2], { password: 'open-me' });
    expect(await widthsOf(result.bytes)).toEqual([222]);
  });
});

describe('mergeDocuments failures', () => {
  it('says which document could not be opened', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'secret' });
    const open = await buildPdf([{ width: 100, height: 100 }]);

    const failure = await mergeDocuments([
      { bytes: open, name: 'fine.pdf' },
      { bytes: locked, name: 'locked.pdf' },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PasswordRequiredError);
    expect((failure as Error).message).toMatch(/^locked\.pdf: /);
  });

  it('leaves the message alone when no name was given', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'secret' });
    const failure = await mergeDocuments([{ bytes: locked }]).catch((error: unknown) => error);
    expect((failure as Error).message).toMatch(/^This PDF is password-protected/);
  });
});
