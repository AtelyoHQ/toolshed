import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { PasswordRequiredError, UnreadablePdfError, WrongPasswordError } from './errors';

/**
 * Opening and saving documents.
 *
 * Every operation in this engine goes through these two functions, so the
 * rules that must hold everywhere — how a bad file is reported, what a saved
 * file is allowed to carry — are stated once.
 */

export interface LoadOptions {
  /** The document's current password, if it has one. */
  password?: string;
}

export interface SaveOptions {
  /**
   * Remove the document information dictionary and the XMP packet.
   *
   * Default. The author, the producing software and the creation timestamp are
   * exactly the kind of thing people do not expect to be publishing when they
   * post a PDF, and this project's whole premise is not leaking what the
   * person did not mean to share.
   */
  keepMetadata?: boolean;
}

/**
 * Opens a document, translating the library's failures into ours.
 *
 * Two settings here are not defaults and both matter.
 *
 * `updateMetadata: false`: left on, pdf-lib stamps its own Producer and a
 * fresh ModDate into every file it saves, which would quietly undo the
 * metadata removal below and put a timestamp into a file someone asked to be
 * anonymous.
 *
 * An empty password rather than none: a document encrypted with an *owner*
 * password only — the kind that restricts printing and opens for everyone — is
 * decrypted with the empty string, and pdf-lib refuses it outright if the
 * option is simply absent. Without this, every operation turns the commonest
 * kind of protected PDF away by asking for a password that does not exist.
 */
export async function loadDocument(
  bytes: Uint8Array,
  options: LoadOptions = {},
): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      password: options.password ?? '',
      updateMetadata: false,
    });
  } catch (error) {
    throw translateLoadError(error);
  }

  // The page tree is touched here, before the document is handed over.
  // pdf-lib recovers what objects it can rather than trusting the
  // cross-reference table, so a file that is a PDF header and then rubbish
  // loads quite happily and throws `Cannot read properties of undefined
  // (reading 'Pages')` from deep inside the library the first time anything
  // asks it about a page. That is not a sentence anyone can act on.
  try {
    doc.getPageCount();
  } catch {
    throw new UnreadablePdfError('its internal structure is damaged beyond repair');
  }

  // Whether the password was actually needed to get this far, which is what
  // the note on the result is about. Not knowable later: by then the document
  // is decrypted either way. A supplied password does not settle it — a
  // caller that has been told the file is owner-protected may well pass the
  // owner password — so the empty one is tried, and only a file that refuses
  // it was really shut.
  if (doc.context.isDecrypted && (options.password ?? '') !== '' && !(await opensFreely(bytes))) {
    hadUserPassword.add(doc);
  }

  // Here, rather than in each operation that saves. Everything in this engine
  // writes an unencrypted result, so everything needs this, and it was a line
  // at the end of each of them until one path — the fallback that returns a
  // document compression decided not to shrink — was added without it and
  // produced files nobody could open.
  dropStaleEncryption(doc);
  return doc;
}

/** Whether a document opens with no password, which is what an owner-only one does. */
async function opensFreely(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    return true;
  } catch {
    return false;
  }
}

/** A new, empty document that will not be stamped with a Producer on save. */
export function createDocument(): Promise<PDFDocument> {
  return PDFDocument.create({ updateMetadata: false });
}

/**
 * Serialises a document.
 *
 * Object streams are on: they pack the small dictionaries that make up most of
 * a PDF into compressed streams, which is a real size win on documents with
 * many pages, and every viewer since Acrobat 6 (2003) reads them.
 */
export async function saveDocument(
  doc: PDFDocument,
  options: SaveOptions = {},
): Promise<Uint8Array> {
  if (!options.keepMetadata) stripDocumentMetadata(doc);
  return doc.save({ useObjectStreams: true });
}

const METADATA_KEYS = [
  // The XMP packet, which carries a second copy of the author and dates, plus
  // whatever the producing application felt like recording.
  PDFName.of('Metadata'),
  // Application-private data; Distiller and Word both park document history
  // and original file names in here.
  PDFName.of('PieceInfo'),
];

/**
 * Removes the document information dictionary, the XMP packets and the
 * application-private data.
 *
 * The entries are unlinked and then everything a reader can no longer get to
 * is deleted. Both halves are necessary, and the second is the one that is
 * easy to get wrong.
 *
 * pdf-lib serialises every object in its context whether or not anything
 * points at it, so unlinking a packet does not remove it: the file still has
 * `dc:creator` and `xmp:CreatorTool` in it — the author's name, in plain text,
 * in a document this engine said was scrubbed. Every PDF from Word, Acrobat or
 * LaTeX carries that packet.
 *
 * So what is left is swept. The question asked is "can a reader reach this",
 * not "is anything in the context pointing at this", and the difference is not
 * academic: a parsed document still holds the source file's old
 * cross-reference stream as an ordinary object, that stream's dictionary names
 * the information dictionary, and anything reasoning about referrers therefore
 * keeps the author and the title in every PDF written since 2003. Reachability
 * from the trailer is also the only definition that cannot delete something a
 * reader needs, because the trailer is where a reader starts.
 *
 * Two consequences worth knowing. This is a garbage collection, so it also
 * drops orphans that have nothing to do with metadata — which is the right
 * answer for a privacy tool, since an orphaned XMP packet left by whatever
 * "removed" it by unlinking is exactly the thing this engine must not pass on,
 * and smaller files are a free side effect. And it runs only when metadata is
 * being removed: a save that was asked to keep the document as it is keeps all
 * of it.
 */
export function stripDocumentMetadata(doc: PDFDocument): void {
  const { context } = doc;

  // The catalog is an indirect object, so this covers it too.
  for (const [, object] of context.enumerateIndirectObjects()) {
    const dict = dictOf(object);
    if (!dict) continue;
    for (const key of METADATA_KEYS) dict.delete(key);
  }
  delete context.trailerInfo.Info;

  const reachable = reachableFromTrailer(context);
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) context.delete(ref);
  }
}

/**
 * Every object a reader can get to, by `PDFRef` tag.
 *
 * Iterative, with an explicit worklist, because the obvious recursive version
 * costs a stack frame per link in a reference *chain* and PDFs contain long
 * ones: a flat bookmark list threads its items through `/Next`, so a document
 * with per-page bookmarks over a couple of thousand pages — an exhibit bundle,
 * a scanned archive — overflows the stack. Measured in the worker this code
 * actually runs in, that limit is about 2000 links; a hostile file can make
 * the chain as long as it likes. A `RangeError` about stack size would reach
 * the person as the result of asking to rotate a page.
 */
function reachableFromTrailer(context: PDFContext): Set<string> {
  const reachable = new Set<string>();
  const pending: PDFObject[] = Object.values(context.trailerInfo).filter(
    (value): value is PDFObject => !!value,
  );

  while (pending.length > 0) {
    const value = pending.pop()!;
    if (value instanceof PDFRef) {
      // The set is the visited set as well as the answer, so a document that
      // points back at itself terminates here.
      if (reachable.has(value.tag)) continue;
      reachable.add(value.tag);
      const target = context.lookup(value);
      if (target) pending.push(target);
      continue;
    }
    for (const nested of childrenOf(value)) pending.push(nested);
  }
  return reachable;
}

function dictOf(value: PDFObject): PDFDict | null {
  if (value instanceof PDFDict) return value;
  return value instanceof PDFStream ? value.dict : null;
}

function* childrenOf(value: PDFObject): Generator<PDFObject> {
  const dict = dictOf(value);
  if (dict) yield* dict.values();
  if (value instanceof PDFArray) {
    for (let index = 0; index < value.size(); index++) yield value.get(index);
  }
}

/**
 * Documents that would not have opened without the password they were given.
 *
 * Recorded at load, because that is the only place it can be told: a document
 * carrying an owner password only opens for everyone, so the fact that it was
 * encrypted says nothing about whether anyone was shut out of it.
 */
const hadUserPassword = new WeakSet<PDFDocument>();

/**
 * A sentence for when an operation has just taken the lock off a document.
 *
 * Every operation here accepts a password and writes its result unencrypted,
 * which is the only thing pdf-lib can do and is usually what was wanted. It
 * is not something to leave unsaid: someone who rotates a confidential
 * document and passes the result on should know the password did not come
 * with it.
 *
 * Said only for a document that really needed its password. An owner-password
 * file opened just as freely before this engine touched it, and warning about
 * it would be frightening someone about something that did not change.
 */
export function resultNote(doc: PDFDocument, note?: string): string | undefined {
  const unlocked = hadUserPassword.has(doc)
    ? 'This document had a password, and the result does not: anyone with this file can open it.'
    : undefined;
  const sentences = [note, unlocked].filter((part): part is string => !!part);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

/**
 * Removes what is left of a password after a document has been decrypted.
 *
 * pdf-lib drops `/Encrypt` from the trailer it will write, but the standard
 * security handler dictionary stays in the context as an ordinary object, and
 * the *previous* trailer survives as an unparsed blob that still names it.
 * Save without this and the file carries `/Encrypt 5 0 R` again — pdf-lib
 * itself then refuses to open what it just wrote, and so does any reader that
 * takes the first trailer it finds. Verified against @cantoo/pdf-lib 2.11.
 */
export function dropStaleEncryption(doc: PDFDocument): void {
  const { context } = doc;
  if (!context.isDecrypted) return;

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      // Looked up, not read: `/Filter` may be an indirect reference.
      const isSecurityHandler =
        context.lookup(object.get(PDFName.of('Filter'))) === PDFName.of('Standard');
      if (isSecurityHandler || object.has(PDFName.of('Encrypt'))) context.delete(ref);
      continue;
    }
    // An object pdf-lib could not parse. In a decrypted document that is the
    // old cross-reference stream, which was encrypted with a key the parser
    // no longer has; it is dead weight at best and carries the stale
    // `/Encrypt` reference at worst.
    if (object instanceof PDFInvalidObject && namesEncrypt(object)) context.delete(ref);
  }
}

function namesEncrypt(object: PDFInvalidObject): boolean {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  // Latin-1 rather than UTF-8: this is a byte blob, and a decoder that
  // replaces invalid sequences could destroy the very name being looked for.
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return text.includes('/Encrypt');
}

/** Rejects a document with nothing in it, which no operation can act on. */
export function requirePages(doc: PDFDocument): number {
  const pageCount = doc.getPageCount();
  if (pageCount < 1) {
    throw new UnreadablePdfError('it contains no pages');
  }
  return pageCount;
}

/**
 * `'none'`, or which kind of password a document carries.
 *
 * Three answers rather than two, because the two kinds do different things and
 * only one of them is a question for the person. A **user** password has to be
 * typed before the document will open at all. An **owner** password restricts
 * printing and copying and opens for everyone — it is the commonest sort of
 * protected PDF, and prompting for it would be asking for something the person
 * does not have. Anything calling this to decide whether to ask for a password
 * must ask only for `'user'`.
 *
 * Not reachable through the worker: the job surface is for operations that
 * produce files, and this answers a question. The interface imports it
 * directly, which is cheap — it reads the trailer and does not decode a page.
 */
export type PdfProtection = 'none' | 'owner' | 'user';

export async function protectionOf(bytes: Uint8Array): Promise<PdfProtection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (error) {
    throw translateLoadError(error);
  }

  if (doc.isEncrypted) {
    // The empty password is what decrypts an owner-only document, so a load
    // that succeeds without one tells us there is no user password to ask for.
    let readable: PDFDocument;
    try {
      readable = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    } catch (error) {
      const translated = translateLoadError(error);
      // Only a password problem means "ask for a password". Anything else — a
      // handler pdf-lib cannot use at all, such as certificate encryption — is
      // reported as what it is, rather than as a prompt no answer can satisfy.
      if (translated instanceof PasswordRequiredError || translated instanceof WrongPasswordError) {
        return 'user';
      }
      throw translated;
    }
    requireReadablePages(readable);
    return 'owner';
  }

  requireReadablePages(doc);
  return 'none';
}

/**
 * The same check `loadDocument` makes, so the two cannot disagree about the
 * same file: without it this answers "no password needed" for a document that
 * is about to be refused as unreadable, and the interface starts a job it
 * cannot finish. A document behind a user password cannot be checked this way
 * — reading its page tree is what the password is for — so that one answer is
 * taken on trust.
 */
function requireReadablePages(doc: PDFDocument): void {
  try {
    doc.getPageCount();
  } catch {
    throw new UnreadablePdfError('its internal structure is damaged beyond repair');
  }
}

/**
 * pdf-lib reports all three of these as plain `Error`s whose `name` is
 * `"Error"` — its own error classes do not set it — so the message is the only
 * thing left to go on. Matched in one place for that reason: if the wording
 * changes, the symptom is that the interface says "cannot read this file"
 * where it should say "wrong password", and `document.test.ts` fails.
 */
function translateLoadError(error: unknown): Error {
  if (!(error instanceof Error)) return new UnreadablePdfError();

  if (/is encrypted|needs password/i.test(error.message)) return new PasswordRequiredError();
  if (/password (is )?incorrect|incorrect password/i.test(error.message)) {
    return new WrongPasswordError();
  }
  return new UnreadablePdfError(error.message);
}
