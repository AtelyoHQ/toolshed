import { useCallback, useState } from 'react';
import { formatBytes, formatDelta } from './lib/bytes';
import { saveBlob } from './lib/download';
import { toolById, toolForDrop, type Tool } from './lib/tools';
import { kindOf, type ToolSettings } from './lib/types';
import { outputFiles } from './lib/outputs';
import { zipFiles } from './lib/zip';
import { DropZone } from './components/DropZone';
import { Header } from './components/Header';
import { QueueRow } from './components/QueueRow';
import { SettingsPanel } from './components/SettingsPanel';
import { ToolGrid } from './components/ToolGrid';
import { outputBytes } from './state/queue';
import { useQueue } from './state/useQueue';
import InstallPrompt from './components/InstallPrompt';
import UpdateNotice from './components/UpdateNotice';

export default function App() {
  const { state, actions, selectors } = useQueue();
  const [toolId, setToolId] = useState('image-compress');
  const tool = toolById(toolId) as Tool;

  // The panel on the first screen is a real control, not a preview: whatever
  // is set here is what the next dropped file starts with. An inert panel
  // that silently discards what you type is worse than no panel.
  const [defaults, setDefaults] = useState<ToolSettings>(tool.defaults);
  const chooseTool = useCallback((id: string) => {
    setToolId(id);
    setDefaults(toolById(id)?.defaults ?? {});
  }, []);

  const [zipping, setZipping] = useState(false);

  const onFiles = useCallback(
    (files: File[]) => {
      // Whatever is selected in the grid wins, as long as it can handle the
      // file. Overriding it unconditionally made choosing a tool there do
      // nothing, which is most of the first screen.
      for (const file of files) {
        const kind = kindOf(file.name, file.type);
        const chosen = toolForDrop(kind, toolId);
        // The settings on the first screen belong to the selected tool. When
        // the file forces a different one — an extension-less JPEG reads as
        // unknown and falls back — carrying them over would apply controls
        // the row does not even render. A hidden longestEdge from Resize
        // would silently throw away resolution on a Compress row.
        actions.add([file], chosen.id, chosen.id === toolId ? defaults : chosen.defaults);
      }
    },
    [actions, defaults, toolId],
  );

  const done = selectors.done(state);
  // Both sides from the finished files only. Summing every queued file
  // against the output of the few that have run reports a saving nobody
  // achieved, and it is wrong for the whole middle of a batch — which is
  // most of the time anyone is looking at it.
  //
  // Only from the tools whose result is meant to be smaller. A PDF turned into
  // text or split into pages would otherwise be averaged in as a saving or a
  // loss that nobody was after.
  const measured = done.filter((item) => !toolById(item.toolId)?.hideDelta);
  const original = measured.reduce((sum, item) => sum + item.source.size, 0);
  const produced = measured.reduce((sum, item) => sum + outputBytes(item), 0);

  // Counted in files, not rows: a split is one row and thirty files, and the
  // button says what ends up in the archive.
  const fileCount = done.reduce(
    (sum, item) => sum + (item.output ? outputFiles(item.output).length : 0),
    0,
  );

  const saveAll = useCallback(async () => {
    setZipping(true);
    try {
      // Every file a job made, not the first: a split row is thirty files.
      const archive = await zipFiles(
        done.flatMap((item) => (item.output ? outputFiles(item.output) : [])),
      );
      await saveBlob(archive, 'toolshed.zip');
    } finally {
      setZipping(false);
    }
  }, [done]);

  const empty = state.items.length === 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* The layout has no room for a banner heading, but a document still
            needs one: it is how a screen reader announces where it has
            landed. */}
        <h1 className="sr-only">Toolshed — private PDF and image tools</h1>
        <div className={empty ? 'space-y-6' : 'space-y-4'}>
          <DropZone onFiles={onFiles} compact={!empty} />

          {empty && (
            <>
              <ToolGrid selected={toolId} onSelect={chooseTool} />
              <section className="border-shell-200 dark:border-shell-700 rounded border p-3">
                <h2 className="mb-2 text-sm font-medium">{tool.label} settings</h2>
                <SettingsPanel
                  tool={tool}
                  settings={defaults}
                  onChange={(patch) => setDefaults((current) => ({ ...current, ...patch }))}
                  idPrefix="default"
                />
                <p className="text-shell-400 mt-2 text-xs">
                  Every file gets its own copy of these once it is in the queue, so you can change
                  one without touching the rest.
                </p>
              </section>
            </>
          )}

          {!empty && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={actions.runAll}
                  disabled={selectors.queued(state).length === 0}
                  className="border-accent-500 bg-accent-500/10 hover:bg-accent-500/20 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                >
                  Run {selectors.queued(state).length || ''}
                </button>

                <button
                  type="button"
                  onClick={() => void saveAll()}
                  disabled={done.length === 0 || zipping}
                  className="border-shell-200 hover:bg-shell-100 dark:border-shell-700 dark:hover:bg-shell-800 rounded border px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  {zipping ? 'Packing…' : `Save all (${fileCount})`}
                </button>

                <button
                  type="button"
                  onClick={actions.clearFinished}
                  className="border-shell-200 hover:bg-shell-100 dark:border-shell-700 dark:hover:bg-shell-800 rounded border px-3 py-1.5 text-sm"
                >
                  Clear finished
                </button>

                {produced > 0 && (
                  <p className="text-shell-400 ml-auto font-mono text-xs">
                    {formatBytes(original)} → {formatBytes(produced)}{' '}
                    <span className={produced <= original ? 'text-good-500' : 'text-warn-500'}>
                      {formatDelta(original, produced)}
                    </span>
                  </p>
                )}
              </div>

              <ul className="space-y-2">
                {state.order.map((id) => {
                  const item = state.items.find((candidate) => candidate.id === id);
                  if (!item) return null;
                  return (
                    <QueueRow
                      key={id}
                      item={item}
                      onRun={() => void actions.run(id)}
                      onCancel={() => actions.cancel(id)}
                      onRequeue={() => actions.requeue(id)}
                      onRemove={() => actions.remove(id)}
                      onPatch={(settings) => actions.patch(id, settings)}
                      onSetTool={(next) => actions.setTool(id, next)}
                    />
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </main>

      <footer className="border-shell-200 dark:border-shell-700 border-t">
        <div className="text-shell-400 mx-auto flex max-w-6xl flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs">
          <span>Everything here runs on your machine. Nothing is uploaded.</span>
          <a className="underline-offset-4 hover:underline" href="./privacy.html">
            How that is enforced
          </a>
        </div>
      </footer>

      {/*
        Both notices are transient and neither belongs in the page flow, so
        they share one corner and stack rather than overlapping. The column
        itself ignores pointer events: an empty one must not swallow clicks on
        whatever the tools put underneath it.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 p-4 sm:items-end">
        <UpdateNotice />
        <InstallPrompt />
      </div>
    </div>
  );
}
