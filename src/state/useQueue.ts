import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { parseSize } from '../lib/bytes';
import { processImageInWorker, shutdownImageWorkers } from '../lib/workers/imageClient';
import type { ImageSettings } from '../lib/image/pipeline';
import { toImageSettings, toolById, type Tool } from '../lib/tools';
import { kindOf, type SourceFile, type ToolSettings } from '../lib/types';
import { emptyQueue, queueReducer, selectors } from './queue';

/**
 * Drives the queue.
 *
 * The one rule that matters here is the epoch contract on `QueueItem`: the
 * epoch is captured when a job is handed to the worker and sent back with
 * every message about it, and each (id, epoch) pair is dispatched at most
 * once. Reading the epoch from current state at report time instead is how a
 * cancelled job comes back as finished, or a result lands on settings that
 * did not produce it.
 */
export function useQueue() {
  const [state, dispatch] = useReducer(queueReducer, emptyQueue);
  const dispatched = useRef(new Set<string>());
  // One controller per dispatched job, so cancelling a file that has not
  // reached a worker drops it instead of letting it run to completion and
  // throwing the answer away. Cancelling thirty of forty files otherwise
  // still costs the whole batch.
  const running = useRef(new Map<string, AbortController>());
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => () => shutdownImageWorkers(), []);

  const add = useCallback((files: File[], toolId: string, settings?: ToolSettings) => {
    const tool = toolById(toolId);
    if (!tool) return;

    const sources: SourceFile[] = files.map((file) => ({
      // Name, size and modified time together identify a file well enough to
      // stop the same drop queueing twice, without reading it.
      id: `${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      size: file.size,
      type: file.type,
      kind: kindOf(file.name, file.type),
      file,
    }));

    // Settings chosen on the first screen travel with the file; otherwise
    // the tool's own defaults.
    dispatch({ type: 'add', sources, toolId, settings: settings ?? tool.defaults });
  }, []);

  const run = useCallback(async (id: string) => {
    const item = latest.current.items.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'queued') return;

    const key = `${item.id}:${item.epoch}`;
    if (dispatched.current.has(key)) return;
    dispatched.current.add(key);

    const epoch = item.epoch;
    const tool = toolById(item.toolId);
    if (!tool || tool.unavailable) {
      dispatch({ type: 'fail', id, error: 'That tool is not built yet.', at: Date.now(), epoch });
      return;
    }

    const controller = new AbortController();
    running.current.set(key, controller);

    dispatch({ type: 'start', id, at: Date.now(), epoch });

    try {
      // Read from the File every time: the worker takes ownership of the
      // buffer it is given, so a retry cannot reuse the previous one.
      const bytes = new Uint8Array(await item.source.file.arrayBuffer());
      const settings = buildSettings(item.settings, tool);

      const result = await processImageInWorker(
        bytes,
        settings,
        (fraction) => dispatch({ type: 'progress', id, fraction, epoch }),
        controller.signal,
      );

      dispatch({
        type: 'succeed',
        id,
        at: Date.now(),
        epoch,
        output: {
          bytes: result.bytes,
          name: renameFor(item.source.name, result.extension),
          mime: result.mime,
          width: result.width,
          height: result.height,
          ...(result.note ? { note: result.note } : {}),
        },
      });
    } catch (error) {
      // A job the person cancelled is not a failure, and the reducer has
      // already marked it cancelled; saying so again would overwrite that.
      if (!controller.signal.aborted) {
        dispatch({
          type: 'fail',
          id,
          at: Date.now(),
          epoch,
          error: error instanceof Error ? error.message : 'Something went wrong with this file.',
        });
      }
    } finally {
      running.current.delete(key);
    }
  }, []);

  const runAll = useCallback(() => {
    for (const item of latest.current.items) {
      if (item.status === 'queued') void run(item.id);
    }
  }, [run]);

  const actions = useMemo(
    () => ({
      add,
      run,
      runAll,
      remove: (id: string) => dispatch({ type: 'remove', id }),
      clear: () => dispatch({ type: 'clear' }),
      clearFinished: () => dispatch({ type: 'clearFinished' }),
      cancel: (id: string) => {
        const item = latest.current.items.find((candidate) => candidate.id === id);
        if (item) running.current.get(`${item.id}:${item.epoch}`)?.abort();
        dispatch({ type: 'cancel', id, at: Date.now() });
      },
      requeue: (id: string) => dispatch({ type: 'requeue', id }),
      setTool: (id: string, toolId: string) => {
        const tool = toolById(toolId);
        if (tool) dispatch({ type: 'setTool', id, toolId, settings: tool.defaults });
      },
      patch: (id: string, settings: ToolSettings) =>
        dispatch({ type: 'patchSettings', id, settings }),
      patchAll: (settings: ToolSettings) => dispatch({ type: 'patchSettingsAll', settings }),
    }),
    [add, run, runAll],
  );

  return { state, actions, selectors } as const;
}

function buildSettings(settings: ToolSettings, tool: Tool): ImageSettings {
  const built = toImageSettings(settings, tool);

  if (typeof settings.targetSize === 'string') {
    const target = parseSize(settings.targetSize);
    // Running anyway would silently ignore the budget and hand back a file
    // of some other size, with nothing on screen explaining why.
    if (target === null) {
      throw new Error(`"${settings.targetSize}" is not a size. Try something like 200kb or 1.5mb.`);
    }
    built.targetBytes = target;
  }
  return built;
}

function renameFor(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  return `${stem}.${extension}`;
}
