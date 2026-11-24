import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { SaveEnvironment } from './download';
import { outputFiles, saveOutput } from './outputs';
import type { JobOutput } from './types';

const file = (name: string, fill: number, size = 4) => ({
  name,
  bytes: new Uint8Array(size).fill(fill),
  mime: 'application/pdf',
});

const split: JobOutput = {
  ...file('a-page-1.pdf', 1),
  siblings: [file('a-page-2.pdf', 2), file('a-page-3.pdf', 3)],
};

/** Captures what would have been written instead of touching the browser. */
function capture() {
  const saved: Array<{ blob: Blob; name: string }> = [];
  const environment: SaveEnvironment = {
    anchorFallback: (blob, name) => saved.push({ blob, name }),
  };
  return { saved, environment };
}

describe('outputFiles', () => {
  it('lists the row own file first and then every sibling, in order', () => {
    expect(outputFiles(split).map((entry) => entry.name)).toEqual([
      'a-page-1.pdf',
      'a-page-2.pdf',
      'a-page-3.pdf',
    ]);
  });

  it('is just the one file for an ordinary result', () => {
    expect(outputFiles(file('a.pdf', 1))).toHaveLength(1);
  });
});

describe('saveOutput', () => {
  it('writes a single result as the file itself, not an archive of one', async () => {
    const { saved, environment } = capture();
    await saveOutput(file('a.pdf', 9), 'a.zip', environment);

    expect(saved.map((entry) => entry.name)).toEqual(['a.pdf']);
    expect(saved[0]?.blob.type).toBe('application/pdf');
  });

  it('packs the parts of a split together, so none is left behind', async () => {
    const { saved, environment } = capture();
    await saveOutput(split, 'a.zip', environment);

    expect(saved.map((entry) => entry.name)).toEqual(['a.zip']);
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['a-page-1.pdf', 'a-page-2.pdf', 'a-page-3.pdf']);
    // The contents, not just the names: the first file must not stand in for
    // the others.
    expect([...(await zip.file('a-page-2.pdf')!.async('uint8array'))]).toEqual([2, 2, 2, 2]);
    expect([...(await zip.file('a-page-3.pdf')!.async('uint8array'))]).toEqual([3, 3, 3, 3]);
  });
});
