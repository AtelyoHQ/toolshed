/**
 * Saving results to disk.
 *
 * Where the browser supports it, the File System Access API is used so the
 * file goes where the person chose rather than into the downloads folder. The
 * anchor fallback covers Firefox and Safari.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

interface FileSystemWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
  /** Discards the partial write and leaves the original file untouched. */
  abort?: () => Promise<void>;
}

/** `instanceof DOMException` is false across realms; the name is not. */
function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritable>;
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;

type PickerCapableWindow = Window & {
  showSaveFilePicker?: SaveFilePicker;
};

/**
 * The two pieces of the browser this module touches, injectable so the
 * branches below can be tested. There are eight of them and they decide
 * whether someone's file is written, lost, or silently truncated.
 */
export interface SaveEnvironment {
  picker?: SaveFilePicker | undefined;
  anchorFallback: (blob: Blob, name: string) => void;
}

function browserEnvironment(): SaveEnvironment {
  return {
    picker: (window as PickerCapableWindow).showSaveFilePicker,
    anchorFallback: saveViaAnchor,
  };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function saveViaAnchor(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * @returns true when the file was written, false when the person cancelled the
 * save dialog — which is not an error and must not be reported as one.
 */
export async function saveBlob(
  blob: Blob,
  name: string,
  environment?: SaveEnvironment,
): Promise<boolean> {
  const { picker, anchorFallback } = environment ?? browserEnvironment();

  if (typeof picker === 'function') {
    let handle: FileSystemFileHandleLike;
    try {
      handle = await picker({
        suggestedName: name,
        types: [
          {
            description: 'File',
            accept: { [blob.type || 'application/octet-stream']: [extensionOf(name) || '.bin'] },
          },
        ],
      });
    } catch (error) {
      // Cross-realm DOMException fails `instanceof`, and treating a cancelled
      // dialog as a failure would silently drop a second copy in Downloads.
      if (isAbort(error)) return false;
      // Anything else (an unsupported accept type, a sandboxed frame) means
      // the picker is unusable here, so fall back and still deliver the file.
      anchorFallback(blob, name);
      return true;
    }

    // Past this point the person has chosen a path and the browser has very
    // likely already truncated the file there. Falling back to the anchor
    // would leave them with an empty file where they asked for the real one
    // and a second copy in Downloads, so a failure is reported as a failure.
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      await writable.abort?.().catch(() => undefined);
      throw error;
    }
  }

  anchorFallback(blob, name);
  return true;
}

export function saveBytes(
  bytes: Uint8Array,
  name: string,
  mime: string,
  environment?: SaveEnvironment,
): Promise<boolean> {
  // Blob already snapshots just this view's bytes, so there is nothing to gain
  // from copying first and a large output would briefly cost twice the memory.
  // The cast is for SharedArrayBuffer, which the engines never produce.
  return saveBlob(new Blob([bytes as BlobPart], { type: mime }), name, environment);
}
