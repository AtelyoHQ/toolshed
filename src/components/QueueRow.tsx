import { useState } from 'react';
import { formatBytes, formatDelta } from '../lib/bytes';
import { outputFiles, saveOutput } from '../lib/outputs';
import { ALL_TOOLS, toolById } from '../lib/tools';
import { withExtension, type QueueItem, type ToolSettings } from '../lib/types';
import { outputBytes } from '../state/queue';
import { Compare } from './Compare';
import { SettingsPanel } from './SettingsPanel';

interface Props {
  item: QueueItem;
  onRun: () => void;
  onCancel: () => void;
  onRequeue: () => void;
  onRemove: () => void;
  onPatch: (settings: ToolSettings) => void;
  onSetTool: (toolId: string) => void;
}

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  queued: 'Waiting',
  running: 'Working',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Stopped',
};

export function QueueRow({
  item,
  onRun,
  onCancel,
  onRequeue,
  onRemove,
  onPatch,
  onSetTool,
}: Props) {
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const tool = toolById(item.toolId);
  const output = item.output;
  // Every file the job made. The size beside the name is all of them, or a
  // split of a 10 MB document would read as 400 KB because only its first
  // page was counted.
  const fileCount = output ? outputFiles(output).length : 0;
  const producedBytes = output ? outputBytes(item) : 0;

  return (
    <li className="border-shell-200 dark:border-shell-700 rounded border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium">{item.source.name}</span>
          <span className="text-shell-400 font-mono text-xs">
            {formatBytes(item.source.size)}
            {output && (
              <>
                {' → '}
                <span className="text-shell-200 dark:text-shell-100">
                  {fileCount > 1 && `${fileCount} files, `}
                  {formatBytes(producedBytes)}
                </span>{' '}
                {!tool?.hideDelta && (
                  <span
                    className={
                      producedBytes <= item.source.size ? 'text-good-500' : 'text-warn-500'
                    }
                  >
                    {formatDelta(item.source.size, producedBytes)}
                  </span>
                )}
              </>
            )}
          </span>
        </button>

        <span
          className="text-shell-400 w-20 shrink-0 font-mono text-xs"
          aria-live="polite"
          aria-atomic="true"
        >
          {STATUS_LABEL[item.status]}
          {item.status === 'running' && item.progress !== null
            ? ` ${Math.round(item.progress * 100)}%`
            : ''}
        </span>

        <div className="flex shrink-0 gap-1">
          {item.status === 'queued' && <Action onClick={onRun}>Run</Action>}
          {item.status === 'running' && <Action onClick={onCancel}>Stop</Action>}
          {(item.status === 'error' || item.status === 'cancelled') && (
            <Action onClick={onRequeue}>Retry</Action>
          )}
          {output && (
            <Action
              onClick={() => {
                setSaveError(null);
                // A failed write must not vanish into an unhandled rejection:
                // the row says Done, and the person has no file.
                saveOutput(output, withExtension(item.source.name, 'zip')).catch((error: unknown) =>
                  setSaveError(error instanceof Error ? error.message : 'Could not save.'),
                );
              }}
              primary
            >
              {fileCount > 1 ? `Save ${fileCount}` : 'Save'}
            </Action>
          )}
          <Action onClick={onRemove} label={`Remove ${item.source.name}`}>
            ✕
          </Action>
        </div>
      </div>

      {item.status === 'running' && (
        <div className="bg-shell-200 dark:bg-shell-800 h-0.5 w-full">
          <div
            className="bg-accent-500 h-full transition-[width]"
            style={{ width: `${Math.round((item.progress ?? 0) * 100)}%` }}
          />
        </div>
      )}

      {item.error && <p className="text-bad-500 px-3 pb-2 text-xs">{item.error}</p>}
      {saveError && <p className="text-bad-500 px-3 pb-2 text-xs">{saveError}</p>}
      {output?.note && <p className="text-shell-400 px-3 pb-2 text-xs">{output.note}</p>}

      {open && (
        <div className="border-shell-200 dark:border-shell-700 space-y-3 border-t px-3 py-3">
          <label className="block">
            <span className="text-xs font-medium">Tool</span>
            <select
              value={item.toolId}
              onChange={(event) => onSetTool(event.target.value)}
              className="border-shell-200 dark:border-shell-700 dark:bg-shell-850 mt-1 w-full rounded border px-2 py-1 text-xs"
            >
              {/* The current tool stays listed even when it is not built
                  yet. Filtering it out leaves the select with no matching
                  option, so Chrome shows the first one and the row claims to
                  be on a tool it is not. */}
              {ALL_TOOLS.filter(
                (candidate) => !candidate.unavailable || candidate.id === item.toolId,
              ).map((candidate) => (
                <option key={candidate.id} value={candidate.id} disabled={!!candidate.unavailable}>
                  {candidate.label}
                  {candidate.unavailable ? ' (not built yet)' : ''}
                </option>
              ))}
            </select>
          </label>

          {tool && (
            <SettingsPanel
              tool={tool}
              settings={item.settings}
              onChange={onPatch}
              idPrefix={`item-${item.id}`}
            />
          )}

          {output && item.source.kind === 'image' && (
            <Compare original={item.source.file} result={output} />
          )}
        </div>
      )}
    </li>
  );
}

function Action({
  onClick,
  children,
  primary = false,
  label,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`rounded border px-2 py-1 text-xs ${
        primary
          ? 'border-accent-500 bg-accent-500/10 hover:bg-accent-500/20'
          : 'border-shell-200 hover:bg-shell-100 dark:border-shell-700 dark:hover:bg-shell-800'
      }`}
    >
      {children}
    </button>
  );
}
