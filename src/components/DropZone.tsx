import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

/**
 * Drag and drop, a file picker, and paste.
 *
 * Paste matters more than it looks: a screenshot goes to the clipboard, not
 * to disk, and having to save it first before compressing it is the kind of
 * friction that sends people back to an upload site.
 */
export function DropZone({ onFiles, compact = false }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (list: FileList | null | undefined) => {
      const files = Array.from(list ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        onFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFiles]);

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        accept(event.dataTransfer?.files);
      }}
      className={`rounded-lg border-2 border-dashed text-center transition-colors ${
        compact ? 'px-4 py-4' : 'px-4 py-10'
      } ${
        over
          ? 'border-accent-500 bg-accent-500/5'
          : 'border-shell-200 dark:border-shell-700 hover:border-shell-400'
      }`}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,.heic,.heif,application/pdf,.pdf"
        // Visually hidden but still focusable would put an unnamed
        // "Choose File" ahead of the labelled button in the tab order.
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          accept(event.target.files);
          event.target.value = '';
        }}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        className="text-accent-600 dark:text-accent-400 font-medium underline-offset-4 hover:underline"
      >
        Choose files
      </button>
      <span className="text-shell-400"> or drop them here, or paste</span>

      {!compact && (
        <p className="text-shell-400 mt-2 font-mono text-xs">
          jpg · png · webp · avif · heic · gif · bmp · pdf
        </p>
      )}
    </div>
  );
}
