import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { parseSize } from '../lib/bytes';
import { processImageInWorker, shutdownImageWorkers } from '../lib/workers/imageClient';
import { runPdfJobInWorker, shutdownPdfWorkers } from '../lib/workers/pdfClient';
import type { ImageSettings } from '../lib/image/pipeline';
import {
  openPasswordKey,
  passwordProblem,
  toJobOutput,
  toPdfRequest,
  type PdfInput,
} from '../lib/pdfTools';
import { toImageSettings, toolById, type Tool } from '../lib/tools';
import {
  kindOf,
  type JobOutput,
  type QueueItem,
  type SourceFile,
  type ToolSettings,
} from '../lib/types';
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

  // Rows that were handed a password and should run once it has landed in
  // state. Running straight after the dispatch would read the row as it was
  // before the password reached it.
  const afterPassword = useRef(new Set<string>());

  useEffect(
    () => () => {
      shutdownImageWorkers();
      shutdownPdfWorkers();
    },
    [],
  );

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
    const chosen = settings ?? tool.defaults;

    // A tool that makes one result from many files takes them into its one
    // row, whatever the gesture that brought them.
    if (tool.combines) {
      dispatch({
        type: 'combine',
        toolId,
        kind: tool.accepts,
        settings: chosen,
        sources,
        absorb: [],
        outputName: tool.combines.outputName,
      });
      return;
    }

    dispatch({ type: 'add', sources, toolId, settings: chosen });
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
      const report = (fraction: number) => dispatch({ type: 'progress', id, fraction, epoch });
      const output =
        tool.engine === 'pdf'
          ? await runPdf(item, tool, report, controller.signal)
          : await runImage(item, tool, report, controller.signal);

      dispatch({ type: 'succeed', id, at: Date.now(), epoch, output });
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
          needsPassword: passwordProblem(error),
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

  // After `run`, which it calls: declared earlier it would be a use before
  // definition, and the effect has to see the `run` that reads `latest`.
  useEffect(() => {
    for (const id of afterPassword.current) {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) afterPassword.current.delete(id);
      else if (item.status === 'queued') {
        afterPassword.current.delete(id);
        void run(id);
      }
    }
  }, [state, run]);

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
      // Sets the password a file opens with and runs it again. The requeue
      // is not redundant: typing the same password twice changes nothing, the
      // reducer ignores a settings patch that changes nothing, and a row left
      // in `error` would never run.
      unlock: (id: string, password: string) => {
        dispatch({ type: 'patchSettings', id, settings: { [openPasswordKey()]: password } });
        dispatch({ type: 'requeue', id });
        afterPassword.current.add(id);
      },
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

async function runImage(
  item: QueueItem,
  tool: Tool,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<JobOutput> {
  // Read from the File every time: the worker takes ownership of the
  // buffer it is given, so a retry cannot reuse the previous one.
  const bytes = new Uint8Array(await item.source.file.arrayBuffer());
  const settings = buildSettings(item.settings, tool);

  const result = await processImageInWorker(bytes, settings, onProgress, signal);
  return {
    bytes: result.bytes,
    name: renameFor(item.source.name, result.extension),
    mime: result.mime,
    width: result.width,
    height: result.height,
    ...(result.note ? { note: result.note } : {}),
  };
}

async function runPdf(
  item: QueueItem,
  tool: Tool,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<JobOutput> {
  const sources = item.parts ?? [item.source];
  const inputs: PdfInput[] = await Promise.all(
    sources.map(async (source) => {
      // A row of one file keeps its password under one key; a row of several
      // keeps one per file, or the second file would be tried with the first
      // one's password.
      const typed = item.settings[openPasswordKey(item.parts ? source.id : undefined)];
      return {
        id: source.id,
        name: source.name,
        // Read every time, for the same reason as the image path: the worker
        // takes the buffer.
        bytes: new Uint8Array(await source.file.arrayBuffer()),
        ...(typeof typed === 'string' && typed !== '' ? { password: typed } : {}),
      };
    }),
  );

  const { job, selection } = toPdfRequest(tool, item.settings, inputs);
  const result = await runPdfJobInWorker(job, onProgress, signal, selection);
  return toJobOutput(tool, item.source.name, result);
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
