/** What every operation in the PDF engine hands back. */
export interface PdfResult {
  bytes: Uint8Array;
  pages: number;
  /**
   * A short human note, for when the honest answer is not just a number:
   * "compression made it larger, so the original was kept", "4 of 11 images
   * were already smaller than this quality".
   */
  note?: string;
  /** Set when the result is the input, unchanged. */
  unchanged?: boolean;
}

/** One of several documents an operation produced, e.g. from a split. */
export interface PdfPart extends PdfResult {
  /** `3` or `4-7`: the page span, for the file name. */
  label: string;
  firstPage: number;
  lastPage: number;
}

/** A document to read, with its password if it has one. */
export interface PdfSource {
  bytes: Uint8Array;
  password?: string;
  /** Only used to say which document a failure came from. */
  name?: string;
}
