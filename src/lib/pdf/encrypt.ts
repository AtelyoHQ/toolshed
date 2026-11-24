import { loadDocument, requirePages, saveDocument, type LoadOptions } from './document';
import { PdfOperationError } from './errors';
import type { PdfResult } from './types';

/**
 * Passwords.
 *
 * A PDF has two of them and they do different jobs. The **user** password is
 * the one a reader is asked for before the document will open at all; the
 * **owner** password unlocks the permissions below, and a document can have
 * one without the other. Permissions alone are advisory — they are a request
 * to the reader software, which any reader is free to ignore, and only the
 * user password actually keeps a document shut.
 *
 * The cipher is AES-256 (ISO 32000-2 revision 6). The older RC4 modes that
 * most tools still default to are broken, and pdf-lib will only produce them
 * if explicitly asked, which nothing here does.
 */

export interface PdfPermissions {
  /** `true` is the same as 'highResolution'. */
  printing?: boolean | 'lowResolution' | 'highResolution';
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  /** Text extraction for screen readers. */
  contentAccessibility?: boolean;
  /** Inserting, rotating and deleting pages; bookmarks. */
  documentAssembly?: boolean;
}

export interface SetPasswordOptions extends LoadOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: PdfPermissions;
  /** Keep the document information dictionary and XMP packet. */
  keepMetadata?: boolean;
}

export async function setPassword(
  bytes: Uint8Array,
  options: SetPasswordOptions,
): Promise<PdfResult> {
  const { userPassword, ownerPassword } = options;
  if (!userPassword && !ownerPassword) {
    throw new PdfOperationError('Set a user password, an owner password, or both.');
  }

  const doc = await loadDocument(bytes, options);
  const pages = requirePages(doc);

  doc.encrypt({
    ...(userPassword ? { userPassword } : {}),
    ...(ownerPassword ? { ownerPassword } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    algorithm: 'AES-256',
  });

  return {
    bytes: await saveDocument(doc, { keepMetadata: options.keepMetadata }),
    pages,
    note: userPassword
      ? 'Encrypted with AES-256. Without this password the document cannot be opened — there is no recovery.'
      : 'Encrypted with AES-256. It opens without a password; the owner password is what unlocks the permissions.',
  };
}

export interface RemovePasswordOptions {
  /** The document's current password; either the user or the owner one. */
  password: string;
  keepMetadata?: boolean;
}

/**
 * Takes the encryption off a document the person can already open.
 *
 * This is decryption with the key, not an attack on it: without the password
 * `loadDocument` fails and there is nothing to do here.
 *
 * One thing does not survive, whatever `keepMetadata` says: the document
 * information dictionary. pdf-lib cannot parse the cross-reference stream of
 * an encrypted file — it comes back as an unreadable blob — and that stream is
 * where the reference to the Info dictionary lives, so the title and author of
 * an encrypted document are already gone by the time this function sees it.
 * The pages, their content and everything they reference are unaffected.
 * `encrypt.test.ts` pins this down; if a later pdf-lib fixes it, that test is
 * what will say so.
 */
export async function removePassword(
  bytes: Uint8Array,
  options: RemovePasswordOptions,
): Promise<PdfResult> {
  const doc = await loadDocument(bytes, { password: options.password });
  const pages = requirePages(doc);

  if (!doc.context.isDecrypted) {
    return {
      bytes,
      pages,
      unchanged: true,
      note: 'This PDF has no password on it, so there was nothing to remove and the file is unchanged — metadata included.',
    };
  }

  return {
    bytes: await saveDocument(doc, { keepMetadata: options.keepMetadata }),
    pages,
    note: 'The password has been removed; anyone with this file can now open it.',
  };
}
