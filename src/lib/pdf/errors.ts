/**
 * The failures a person can actually cause, as distinct types.
 *
 * The interface has to say something different for each of these — "we cannot
 * read this file", "this one needs a password", "that password is wrong" — and
 * the underlying library reports the last two as bare `Error`s with English
 * messages. Translating them once, here, keeps string matching out of the rest
 * of the engine.
 */

export class UnreadablePdfError extends Error {
  constructor(detail?: string) {
    super(`This file is not a PDF Toolshed can read${detail ? `: ${detail}` : ''}`);
    this.name = 'UnreadablePdfError';
  }
}

/** The document is encrypted and no password was supplied. */
export class PasswordRequiredError extends Error {
  constructor() {
    super('This PDF is password-protected. Enter its password to open it.');
    this.name = 'PasswordRequiredError';
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('That password does not open this PDF.');
    this.name = 'WrongPasswordError';
  }
}

/** A page selection that cannot be applied to this document. */
export class PageSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageSelectionError';
  }
}

/** The settings themselves do not describe a possible operation. */
export class PdfOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfOperationError';
  }
}
