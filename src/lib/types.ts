/** Shared vocabulary for the queue, the workers and the UI. */

export type FileKind = 'image' | 'pdf' | 'unknown';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Values a settings panel can produce. Each tool narrows these for itself. */
export type SettingValue = string | number | boolean;
export type ToolSettings = Record<string, SettingValue>;

export interface SourceFile {
  id: string;
  name: string;
  size: number;
  /** The browser's MIME guess, which is frequently wrong or empty for HEIC. */
  type: string;
  kind: FileKind;
  file: File;
}

export interface JobOutput {
  bytes: Uint8Array;
  name: string;
  mime: string;
  /** Set when a tool produced several files, e.g. splitting a PDF. */
  siblings?: Array<{ bytes: Uint8Array; name: string; mime: string }>;
  width?: number;
  height?: number;
  pages?: number;
  /**
   * A short human note shown next to the result, used when the honest answer
   * is not just a number: "already smaller than the target", "kept original,
   * compression made it larger".
   */
  note?: string;
}

export interface QueueItem {
  id: string;
  source: SourceFile;
  toolId: string;
  settings: ToolSettings;
  /**
   * Identifies one attempt at this file, and changes whenever anything
   * invalidates that attempt: new settings, a new tool, cancel, requeue.
   *
   * A running job cannot be interrupted — a WebAssembly call runs to
   * completion — so a worker usually finishes after Cancel was pressed or
   * after the quality slider moved on. Results carry the epoch they were
   * started with, and a stale one is discarded rather than landing on
   * settings that did not produce it.
   *
   * The value is drawn from a counter on the queue, not from the item, so it
   * cannot repeat. Keeping it per item meant removing a row and dropping the
   * same file again reset it to zero, and a result still coming back for the
   * old row was then accepted for the new one.
   *
   * **Contract for whatever dispatches jobs**: capture `epoch` when the job is
   * handed to the pool, and send that same value back with `start`,
   * `progress`, `succeed` and `fail` — never read it from current state at
   * report time, which is the bug this prevents.
   *
   * Dispatch each `(id, epoch)` pair **at most once**. A second `start` at an
   * epoch whose job already finished would clear that result and move the row
   * back to running, and no second answer is coming for it. A deliberate
   * retry is a `start` at the same epoch for a job that did not finish, which
   * is why this is a rule for the caller rather than a guard in the reducer.
   *
   * `start` is included deliberately. A worker may pick a job up long after it
   * was enqueued, by which time the person may have cancelled it or changed
   * its settings; a `start` without an epoch would undo that and leave the row
   * running for ever, since the result that follows is itself dropped as
   * stale. An item invalidated while running returns to `queued` and is
   * expected to be dispatched again.
   */
  epoch: number;
  status: JobStatus;
  /** 0..1, or null when the job cannot report granular progress. */
  progress: number | null;
  output?: JobOutput;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type ProgressReporter = (fraction: number) => void;

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'avif',
  'gif',
  'bmp',
  'heic',
  'heif',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Classifies a file by MIME type, falling back to the extension.
 *
 * The fallback is not a nicety: Chrome and Firefox report an empty `type` for
 * `.heic` files, which is exactly the format most in need of converting.
 */
export function kindOf(name: string, mimeType: string): FileKind {
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';

  const extension = extensionOf(name);
  if (extension === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'unknown';
}

/** Replaces a file's extension, keeping the rest of the name intact. */
export function withExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  return `${stem}.${extension}`;
}

/** Adds a suffix before the extension: `scan.pdf` -> `scan-compressed.pdf`. */
export function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return `${name}${suffix}`;
  return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
}
