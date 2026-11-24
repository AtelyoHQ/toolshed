/**
 * Types for licences.mjs, which stays plain JavaScript so that both
 * vite.config.ts and the Node build checks can import the same list.
 */
export interface BundledLicence {
  package: string;
  licence: string;
  /** Path to the licence text, relative to the repository root. */
  file: string;
  /** Anything a reader needs beyond the licence name, such as an obligation. */
  note?: string;
}

export declare const BUNDLED_LICENCES: BundledLicence[];
export declare function licencePath(name: string): string;
