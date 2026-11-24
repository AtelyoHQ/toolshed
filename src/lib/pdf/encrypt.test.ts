import { PDFDict, PDFDocument, PDFName, PDFNumber } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildEncryptedPdf, buildPdf, buildPdfWithMetadata } from '../../../test/pdfFixtures';
import { loadDocument, protectionOf } from './document';
import { removePassword, setPassword } from './encrypt';
import { PasswordRequiredError, PdfOperationError, WrongPasswordError } from './errors';

/** The security handler dictionary of a saved document. */
async function securityHandler(bytes: Uint8Array): Promise<PDFDict> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dict = doc.context.lookup(doc.context.trailerInfo.Encrypt, PDFDict);
  expect(dict).toBeDefined();
  return dict;
}

describe('setPassword', () => {
  it('produces a document that will not open without the password', async () => {
    const result = await setPassword(await buildPdf([{ width: 200, height: 300 }]), {
      userPassword: 'open-me',
    });

    expect(await protectionOf(result.bytes)).toBe('user');
    await expect(loadDocument(result.bytes)).rejects.toThrow(PasswordRequiredError);
    await expect(loadDocument(result.bytes, { password: 'not-it' })).rejects.toThrow(
      WrongPasswordError,
    );

    const doc = await loadDocument(result.bytes, { password: 'open-me' });
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 300 });
  });

  it('uses AES-256, not one of the broken RC4 modes most tools still default to', async () => {
    const result = await setPassword(await buildPdf([{ width: 10, height: 10 }]), {
      userPassword: 'open-me',
    });

    const handler = await securityHandler(result.bytes);
    expect(handler.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber()).toBe(5);
    expect(handler.lookupMaybe(PDFName.of('R'), PDFNumber)?.asNumber()).toBe(6);
    const crypt = handler.lookupMaybe(PDFName.of('CF'), PDFDict);
    const standard = crypt?.lookupMaybe(PDFName.of('StdCF'), PDFDict);
    expect(standard?.get(PDFName.of('CFM'))).toBe(PDFName.of('AESV3'));
  });

  /**
   * An owner password alone leaves the document readable by anyone and only
   * restricts what a reader is asked to allow — which the note has to say,
   * because "password-protected" means something quite different here.
   */
  it('accepts an owner password alone, and the document still opens freely', async () => {
    const result = await setPassword(await buildPdf([{ width: 10, height: 10 }]), {
      ownerPassword: 'owner-only',
    });

    expect(await protectionOf(result.bytes)).toBe('owner');
    // No password at all, the way a person would open it.
    const doc = await loadDocument(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(result.note).toMatch(/opens without a password/);
  });

  it('records the permissions it was given', async () => {
    const permissive = await setPassword(await buildPdf([{ width: 10, height: 10 }]), {
      ownerPassword: 'owner',
      permissions: { printing: 'highResolution', copying: true, modifying: true },
    });
    const restrictive = await setPassword(await buildPdf([{ width: 10, height: 10 }]), {
      ownerPassword: 'owner',
      permissions: { printing: false, copying: false, modifying: false },
    });

    const allowed = (await securityHandler(permissive.bytes))
      .lookupMaybe(PDFName.of('P'), PDFNumber)
      ?.asNumber();
    const denied = (await securityHandler(restrictive.bytes))
      .lookupMaybe(PDFName.of('P'), PDFNumber)
      ?.asNumber();

    // The entry is a bitfield of *allowances*, so fewer permissions must mean
    // fewer bits set, whatever the exact encoding.
    expect(allowed).not.toBe(denied);
    expect(bitsSet(allowed ?? 0)).toBeGreaterThan(bitsSet(denied ?? 0));
  });

  it('re-encrypts a document that already had a password, with the new one', async () => {
    const original = await buildEncryptedPdf({ userPassword: 'first' });
    const result = await setPassword(original, {
      password: 'first',
      userPassword: 'second',
    });

    await expect(loadDocument(result.bytes, { password: 'first' })).rejects.toThrow(
      WrongPasswordError,
    );
    const doc = await loadDocument(result.bytes, { password: 'second' });
    expect(doc.getPageCount()).toBe(1);
  });

  it('refuses to encrypt with no password at all, which would protect nothing', async () => {
    await expect(setPassword(await buildPdf([{ width: 10, height: 10 }]), {})).rejects.toThrow(
      PdfOperationError,
    );
  });

  it('needs the current password to add a new one', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'first' });
    await expect(setPassword(locked, { userPassword: 'second' })).rejects.toThrow(
      PasswordRequiredError,
    );
  });
});

describe('removePassword', () => {
  it('produces a document that opens with no password', async () => {
    const locked = await buildEncryptedPdf({
      userPassword: 'open-me',
      pages: [{ width: 123, height: 456, text: 'secret' }],
    });

    const result = await removePassword(locked, { password: 'open-me' });

    expect(await protectionOf(result.bytes)).toBe('none');
    const doc = await loadDocument(result.bytes);
    expect(doc.getPage(0).getSize()).toEqual({ width: 123, height: 456 });
    expect(result.note).toMatch(/anyone with this file can now open it/);
  });

  it('refuses without the password, because this is decryption and not an attack', async () => {
    const locked = await buildEncryptedPdf({ userPassword: 'open-me' });
    await expect(removePassword(locked, { password: 'guess' })).rejects.toThrow(WrongPasswordError);
  });

  it('says there was nothing to remove rather than rewriting the file', async () => {
    const plain = await buildPdf([{ width: 10, height: 10 }]);
    const result = await removePassword(plain, { password: 'irrelevant' });

    expect(result.unchanged).toBe(true);
    expect(result.bytes).toBe(plain);
    expect(result.note).toMatch(/nothing to remove/);
  });

  /**
   * Not the behaviour anyone would choose, and worth pinning down rather than
   * leaving to be discovered: pdf-lib cannot parse the cross-reference stream
   * of an encrypted file, and that stream holds the reference to the document
   * information dictionary, so the title is gone before this code runs. The
   * pages themselves come through untouched. If a later pdf-lib fixes this,
   * this test fails and the comment on `removePassword` can go.
   */
  it('cannot carry the document title through decryption, a pdf-lib limitation', async () => {
    const locked = await setPassword(await buildPdfWithMetadata(), {
      userPassword: 'x',
      keepMetadata: true,
    });
    const result = await removePassword(locked.bytes, { password: 'x', keepMetadata: true });

    const doc = await loadDocument(result.bytes);
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getPageCount()).toBe(1);
  });
});

function bitsSet(value: number): number {
  let count = 0;
  for (let bit = 0; bit < 32; bit++) if (value & (1 << bit)) count += 1;
  return count;
}
