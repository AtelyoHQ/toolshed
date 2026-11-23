import JSZip from 'jszip';

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Packs results into a single archive.
 *
 * The files are already compressed images and PDFs, so the archive is stored
 * rather than deflated: deflate would spend real time to save almost nothing on
 * a batch of JPEGs.
 */
export async function zipFiles(
  entries: ZipEntry[],
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const zip = new JSZip();
  const used = new Map<string, number>();

  for (const entry of entries) {
    zip.file(uniqueName(used, safeName(entry.name)), entry.bytes);
  }

  return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) =>
    onProgress?.(meta.percent / 100),
  );
}

/**
 * Flattens a name to something that cannot escape the archive when extracted.
 * Names here come from the source files people drop in, so they are not
 * trusted input.
 */
export function safeName(name: string): string {
  const flat = name.replace(/\\/g, '/').split('/').pop() ?? '';

  const cleaned = flat
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Bidirectional overrides are the classic extension spoof: a name can be
    // made to display as "report.pdf" while ending in .exe.
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();

  // A name made only of dots is a traversal segment, not a file name. A
  // single leading dot is just a dotfile and is kept.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return 'file';

  // Some filesystems cap a component at 255 bytes; trim the stem, not the
  // extension, so the file still opens in the right application.
  if (cleaned.length <= 200) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0) return cleaned.slice(0, 200);
  const extension = cleaned.slice(dot, dot + 16);
  return cleaned.slice(0, 200 - extension.length) + extension;
}

/** `photo.jpg`, `photo (2).jpg`, ... so a batch never silently loses a file. */
export function uniqueName(used: Map<string, number>, name: string): string {
  const seen = used.get(name);
  if (seen === undefined) {
    used.set(name, 1);
    return name;
  }

  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);

  let count = seen;
  let candidate: string;
  do {
    count += 1;
    candidate = `${stem} (${count})${extension}`;
  } while (used.has(candidate));

  used.set(name, count);
  used.set(candidate, 1);
  return candidate;
}
