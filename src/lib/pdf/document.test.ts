import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildEncryptedPdf,
  buildPdf,
  buildPdfWithMetadata,
  everythingIn,
  latin1,
} from '../../../test/pdfFixtures';
import {
  createDocument,
  dropStaleEncryption,
  protectionOf,
  loadDocument,
  requirePages,
  saveDocument,
} from './document';
import { PasswordRequiredError, UnreadablePdfError, WrongPasswordError } from './errors';

describe('loading', () => {
  it('reads a document back with its pages and their sizes intact', async () => {
    const doc = await loadDocument(await buildPdf([{ width: 200, height: 300 }]));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 300 });
  });

  it('refuses something that is not a PDF at all', async () => {
    await expect(loadDocument(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(UnreadablePdfError);
  });

  /**
   * pdf-lib is deliberately forgiving: it recovers what objects it can find
   * rather than trusting the cross-reference table, so a file with a PDF
   * header and rubbish after it gets through `load` and only comes apart when
   * something asks about a page.
   */
  it('refuses a file that is a PDF header and nothing else', async () => {
    await expect(
      loadDocument(new TextEncoder().encode('%PDF-1.7\nnot really a PDF')),
    ).rejects.toThrow(UnreadablePdfError);
  });

  it('asks for a password rather than failing obscurely on an encrypted file', async () => {
    const encrypted = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(loadDocument(encrypted)).rejects.toThrow(PasswordRequiredError);
  });

  it('says the password is wrong, which is a different problem', async () => {
    const encrypted = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(loadDocument(encrypted, { password: 'guess' })).rejects.toThrow(
      WrongPasswordError,
    );
  });

  it('opens an encrypted document with its password', async () => {
    const encrypted = await buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [{ width: 123, height: 456 }],
    });
    const doc = await loadDocument(encrypted, { password: 'open-me' });
    expect(doc.getPage(0).getSize()).toEqual({ width: 123, height: 456 });
  });

  /**
   * The commonest kind of protected PDF: encrypted to restrict printing, and
   * open to everyone. It is decrypted with the empty password, and there is no
   * password for a person to type — so asking for one turns away a file that
   * every viewer opens, including files this engine itself produces.
   */
  it('opens a document that is encrypted with an owner password only', async () => {
    const locked = await buildEncryptedPdf({
      ownerPassword: 'owner-only',
      pages: [{ width: 222, height: 333 }],
    });

    const doc = await loadDocument(locked);
    expect(doc.getPage(0).getSize()).toEqual({ width: 222, height: 333 });
  });

  it('still asks for a password when there really is a user one', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(loadDocument(locked)).rejects.toThrow(PasswordRequiredError);
  });

  /**
   * The interface asks this before it can decide whether to prompt, and a
   * plain yes-or-no would have it demand a password for a document that opens
   * for everyone.
   */
  it('tells the two kinds of password apart, without being given either', async () => {
    expect(await protectionOf(await buildPdf([{ width: 10, height: 10 }]))).toBe('none');
    expect(await protectionOf(await buildEncryptedPdf({ userPassword: 'x' }))).toBe('user');
    expect(await protectionOf(await buildEncryptedPdf({ ownerPassword: 'x' }))).toBe('owner');
  });

  /**
   * `loadDocument` refuses this file, so answering "no password needed" would
   * have the interface start a job that cannot finish. The two functions have
   * to agree about the same bytes.
   */
  it('refuses a damaged file rather than reporting it as unprotected', async () => {
    await expect(
      protectionOf(new TextEncoder().encode('%PDF-1.7\nnot really a PDF')),
    ).rejects.toThrow(UnreadablePdfError);
  });

  it('tells them apart for the broken old ciphers too', async () => {
    expect(await protectionOf(await buildEncryptedPdf({ userPassword: 'x', weak: true }))).toBe(
      'user',
    );
    expect(await protectionOf(await buildEncryptedPdf({ ownerPassword: 'x', weak: true }))).toBe(
      'owner',
    );
  });
});

describe('saving', () => {
  it('removes the author, the title and the producing application by default', async () => {
    const original = await buildPdfWithMetadata();
    const before = await PDFDocument.load(original, { updateMetadata: false });
    expect(before.getProducer()).toBe('Some Application 4.2');

    const saved = await saveDocument(await loadDocument(original));
    const after = await PDFDocument.load(saved, { updateMetadata: false });
    expect(after.getProducer()).toBeUndefined();
    expect(after.getAuthor()).toBeUndefined();
    expect(after.getTitle()).toBeUndefined();
    expect(after.getCreationDate()).toBeUndefined();
  });

  /**
   * Unlinking the XMP packet is not removing it: pdf-lib writes every object
   * in its context whether anything references it, so the author's name
   * survives in plain text in a file the engine said was scrubbed. Asserted on
   * the bytes rather than through an API, because "is it still in the file" is
   * the question.
   */
  it('removes the XMP packets and the private application data from the bytes', async () => {
    const original = await buildPdfWithMetadata();
    expect(latin1(original)).toContain('dc:creator');

    const saved = await saveDocument(await loadDocument(original));
    // Decompressed, not grepped: the information dictionary and anything else
    // pdf-lib packs into an object stream is invisible in the raw bytes, and
    // that is where a whole Info dictionary hid the first time this was
    // written.
    const text = await everythingIn(saved);
    expect(text).not.toContain('dc:creator');
    expect(text).not.toContain('xmp:CreatorTool');
    expect(text).not.toContain('Page level secret');
    // Two levels down, inside a /PieceInfo application dictionary.
    expect(text).not.toContain('draft-of-Quarterly-figures.docx');
    expect(text).not.toContain('catalog level secret');
    // And on an object that is neither the catalog nor a page.
    expect(text).not.toContain('Photographer');
    // The information dictionary, which pdf-lib's own getters cannot see once
    // the trailer no longer names it.
    expect(text).not.toContain('A Person');
    expect(text).not.toContain('Quarterly figures');
    expect(text).not.toContain('D:20200101');
  });

  /**
   * The residue of an incremental save, and of any tool that "removed"
   * metadata by unlinking it — which is the mistake this engine exists to
   * beat. An orphan is invisible to a reader and perfectly visible to
   * anything that reads the file, so it has to go.
   */
  it('removes an XMP packet that arrived already unlinked', async () => {
    const doc = await loadDocument(await buildPdf([{ width: 10, height: 10 }]));
    doc.context.register(
      doc.context.stream('<x:xmpmeta><dc:creator>Stale Author</dc:creator></x:xmpmeta>', {
        Type: 'Metadata',
        Subtype: 'XML',
      }),
    );

    const saved = await saveDocument(doc);
    expect(await everythingIn(saved)).not.toContain('Stale Author');
    expect((await loadDocument(saved)).getPageCount()).toBe(1);
  });

  /**
   * The reason the walk counts references instead of guessing at depth or at
   * which objects look structural: private data is allowed to name something
   * the document also uses, and deleting that would turn a metadata strip
   * into a corrupted file — a worse outcome than the leak it is fixing.
   */
  it('keeps an object the document still uses, even when metadata points at it', async () => {
    const saved = await saveDocument(await loadDocument(await buildPdfWithMetadata()));
    const text = latin1(saved);
    expect(text).toContain('%shared marker');
    // And everything that object points at, down the whole chain: keeping a
    // font and deleting its descriptor leaves the font pointing at nothing,
    // which is a worse outcome than either answer on its own.
    expect(text).toContain('%shared grandchild marker');

    // The page that uses it is still readable.
    const doc = await loadDocument(saved);
    expect(doc.getPageCount()).toBe(1);
  });

  /**
   * The pathological version of the same thing, and the reason this is worth
   * a test of its own: nothing stops a generator's private data from naming
   * the page object. Deleting it was silent, total content loss.
   */
  it('keeps a page the metadata names, rather than emptying the document', async () => {
    const doc = await loadDocument(await buildPdf([{ width: 123, height: 456 }]));
    const pageRef = doc.context.getObjectRef(doc.getPage(0).node)!;
    doc.catalog.set(
      PDFName.of('PieceInfo'),
      doc.context.obj({ SomeApplication: { Private: pageRef } }),
    );

    const reopened = await loadDocument(await saveDocument(doc));
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 123, height: 456 });
  });

  it('keeps metadata when the operation has no business removing it', async () => {
    const saved = await saveDocument(await loadDocument(await buildPdfWithMetadata()), {
      keepMetadata: true,
    });
    const after = await PDFDocument.load(saved, { updateMetadata: false });
    expect(after.getProducer()).toBe('Some Application 4.2');
    expect(after.getTitle()).toBe('Quarterly figures');
    // The inverse of the test above, so neither can pass by the packet never
    // having been in the fixture in the first place.
    expect(latin1(saved)).toContain('xmp:CreatorTool');
  });

  it('does not stamp its own producer or a modification date onto the result', async () => {
    const saved = await saveDocument(
      await loadDocument(await buildPdf([{ width: 10, height: 10 }])),
    );
    const text = latin1(saved);
    expect(text).not.toContain('pdf-lib');
    expect(text).not.toContain('ModDate');
  });

  /**
   * A flat bookmark list threads its items through `/Next`, so a document with
   * a bookmark per page is one long reference chain. Twenty thousand is past
   * what a recursive walk survives anywhere — see `reachableFromTrailer` for
   * where the limit actually falls — and the symptom was every operation
   * failing with a stack-size RangeError.
   */
  it('saves a document whose references form a chain twenty thousand long', async () => {
    const doc = await loadDocument(await buildPdf([{ width: 10, height: 10 }]));
    const { context } = doc;

    let next = context.register(context.obj({ Title: PDFString.of('last') }));
    for (let index = 0; index < 20_000; index++) {
      next = context.register(context.obj({ Title: PDFString.of(`item ${index}`), Next: next }));
    }
    doc.catalog.set(PDFName.of('Outlines'), next);

    const saved = await saveDocument(doc);
    expect((await loadDocument(saved)).getPageCount()).toBe(1);
  });

  /**
   * And the other way a reference graph defeats a walk: two objects that point
   * at each other, which is what a malformed or hostile file looks like. The
   * visited set is what stops this, and nothing else would.
   */
  it('saves a document whose references point in a circle', async () => {
    const doc = await loadDocument(await buildPdf([{ width: 10, height: 10 }]));
    const { context } = doc;

    const first = context.nextRef();
    const second = context.register(context.obj({ Title: PDFString.of('second'), Next: first }));
    context.assign(first, context.obj({ Title: PDFString.of('first'), Next: second }));
    doc.catalog.set(PDFName.of('Outlines'), first);

    const saved = await saveDocument(doc);
    expect((await loadDocument(saved)).getPageCount()).toBe(1);
  });

  it('writes a file every reader can open again', async () => {
    const saved = await saveDocument(
      await loadDocument(await buildPdf([{ width: 10, height: 10 }])),
    );
    expect(latin1(saved.subarray(0, 8))).toContain('%PDF-');
    await expect(PDFDocument.load(saved)).resolves.toBeDefined();
  });
});

describe('dropStaleEncryption', () => {
  /**
   * Loaded through pdf-lib directly, because `loadDocument` calls this
   * function itself: going through it would leave these two passing whatever
   * the function did.
   */
  const raw = (bytes: Uint8Array, password?: string) =>
    PDFDocument.load(bytes, { password, updateMetadata: false });

  it('leaves a document that was never encrypted alone', async () => {
    const doc = await raw(await buildPdf([{ width: 10, height: 10 }]));
    dropStaleEncryption(doc);
    expect(doc.getPageCount()).toBe(1);
  });

  /**
   * The regression this function exists for. Without it the file keeps an
   * `/Encrypt` reference it no longer has a key for, and the next reader to
   * open it — pdf-lib included — asks for a password that no longer exists.
   */
  it('lets a decrypted document be saved as a file that opens without a password', async () => {
    const encrypted = await buildEncryptedPdf({ userPassword: 'open-me' });
    const doc = await raw(encrypted, 'open-me');
    expect(latin1(await doc.save({ useObjectStreams: true }))).toContain('/Encrypt');

    dropStaleEncryption(doc);
    const saved = await doc.save({ useObjectStreams: true });
    expect(latin1(saved)).not.toContain('/Encrypt');
    expect((await loadDocument(saved)).getPageCount()).toBe(1);
  });
});

describe('requirePages', () => {
  it('refuses a document with no pages, which nothing can be done to', async () => {
    const empty = await createDocument();
    expect(() => requirePages(empty)).toThrow(UnreadablePdfError);
  });

  it('returns the page count for a document that has pages', async () => {
    const doc = await loadDocument(
      await buildPdf([
        { width: 1, height: 1 },
        { width: 2, height: 2 },
      ]),
    );
    expect(requirePages(doc)).toBe(2);
  });
});
