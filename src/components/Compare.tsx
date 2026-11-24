import { useEffect, useMemo, useState } from 'react';
import { formatBytes, formatDelta } from '../lib/bytes';

interface Props {
  original: File;
  result: { bytes: Uint8Array; mime: string };
}

/**
 * Before and after, with a slider.
 *
 * "80% smaller" means nothing on its own — the question is always what it
 * cost. Showing both at the same size, with the real byte counts underneath,
 * is the only honest way to answer that.
 */
export function Compare({ original, result }: Props) {
  const [position, setPosition] = useState(50);

  const beforeUrl = useObjectUrl(original);
  // No copy: Blob already snapshots just this view's bytes.
  const afterBlob = useMemo(
    () => new Blob([result.bytes as BlobPart], { type: result.mime }),
    [result],
  );
  const afterUrl = useObjectUrl(afterBlob);

  if (!beforeUrl || !afterUrl) return null;

  return (
    <div>
      <div className="bg-shell-100 dark:bg-shell-850 relative overflow-hidden rounded border border-shell-200 dark:border-shell-700">
        <img src={beforeUrl} alt="Before" className="block max-h-80 w-full object-contain" />
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 0 0 ${position}%)` }}
        >
          <img src={afterUrl} alt="After" className="block h-full w-full object-contain" />
        </div>
        <div
          className="bg-accent-500 pointer-events-none absolute inset-y-0 w-px"
          style={{ left: `${position}%` }}
        />
      </div>

      <label className="mt-2 block">
        <span className="sr-only">Reveal the compressed image</span>
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
          className="accent-accent-500 w-full"
        />
      </label>

      <div className="text-shell-400 flex justify-between font-mono text-xs">
        <span>before {formatBytes(original.size)}</span>
        <span
          className={result.bytes.byteLength <= original.size ? 'text-good-500' : 'text-warn-500'}
        >
          {formatDelta(original.size, result.bytes.byteLength)}
        </span>
        <span>after {formatBytes(result.bytes.byteLength)}</span>
      </div>
    </div>
  );
}

function useObjectUrl(source: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    const next = URL.createObjectURL(source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);

  return url;
}
