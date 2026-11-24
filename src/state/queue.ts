import { openPasswordKey } from '../lib/pdfTools';
import type { FileKind, JobOutput, QueueItem, SourceFile, ToolSettings } from '../lib/types';

export interface QueueState {
  items: QueueItem[];
  /** Ids in the order they were added; the UI renders in this order. */
  order: string[];
  /**
   * Source of the next epoch. It lives here rather than on the item so a value
   * is never handed out twice: an item's own counter died with the item, and
   * re-adding the same file reset it to zero while a worker was still coming
   * back with a result stamped zero.
   */
  nextEpoch: number;
}

export const emptyQueue: QueueState = { items: [], order: [], nextEpoch: 0 };

export type QueueAction =
  | { type: 'add'; sources: SourceFile[]; toolId: string; settings: ToolSettings }
  | { type: 'remove'; id: string }
  | {
      type: 'combine';
      toolId: string;
      /** What the parts are, so the row's stand-in source reads as the right kind. */
      kind: FileKind;
      settings: ToolSettings;
      /** Files to add. */
      sources: SourceFile[];
      /** Waiting rows to fold in, in the order the queue shows them. */
      absorb: string[];
      outputName: string;
    }
  | { type: 'moveSource'; id: string; sourceId: string; by: -1 | 1 }
  | { type: 'removeSource'; id: string; sourceId: string }
  | { type: 'clear' }
  | { type: 'clearFinished' }
  | { type: 'setTool'; id: string; toolId: string; settings: ToolSettings }
  | { type: 'patchSettings'; id: string; settings: ToolSettings }
  | { type: 'patchSettingsAll'; settings: ToolSettings }
  | { type: 'start'; id: string; at: number; epoch: number }
  | { type: 'progress'; id: string; fraction: number; epoch: number }
  | { type: 'succeed'; id: string; output: JobOutput; at: number; epoch: number }
  | {
      type: 'fail';
      id: string;
      error: string;
      at: number;
      epoch: number;
      needsPassword?: 'missing' | 'wrong';
    }
  | { type: 'requeue'; id: string }
  | { type: 'cancel'; id: string; at: number };

/** The reset a finished item needs before it can be run again. */
const PENDING = {
  status: 'queued',
  progress: null,
  output: undefined,
  error: undefined,
  // A password prompt belongs to the attempt that asked for it. Kept through
  // a settings change it would sit above a row that is about to run again.
  needsPassword: undefined,
  startedAt: undefined,
  finishedAt: undefined,
} satisfies Partial<QueueItem>;

/**
 * Changing settings invalidates whatever the old settings produced.
 *
 * Without this the row keeps saying "done" with the previous output attached,
 * so the size and the percentage on screen belong to settings the person can
 * no longer see — and Download hands over the wrong file. That number is the
 * one thing this application exists to get right.
 */
function applySettings(item: QueueItem, settings: ToolSettings, epoch: number): QueueItem {
  const merged = { ...item.settings, ...settings };
  const sameSize = Object.keys(merged).length === Object.keys(item.settings).length;
  const unchanged =
    sameSize && Object.keys(merged).every((key) => Object.is(merged[key], item.settings[key]));
  if (unchanged) return item;

  // The epoch always moves, so a result already in flight for the old
  // settings is discarded when it arrives rather than landing on the new ones.
  const next: QueueItem = { ...item, settings: merged, epoch };

  // A cancelled row stays cancelled. Nudging a batch-wide slider must not
  // quietly restart every file the person deliberately stopped.
  if (item.status === 'cancelled') return next;

  // Everything else goes back to queued, running included — the same rule as
  // setTool and requeue. Leaving a running item at 'running' with a bumped
  // epoch stranded it: its in-flight result is dropped on arrival and no
  // action ever moved it on, so the row span for ever.
  return { ...next, ...PENDING };
}

/**
 * The stand-in source of a row that owns several files.
 *
 * Its size is what the totals and the saving are measured against, so it is
 * recomputed whenever the parts change and never stored twice.
 */
function standIn(
  id: string,
  name: string,
  kind: FileKind,
  parts: readonly SourceFile[],
): SourceFile {
  return {
    id,
    name,
    size: parts.reduce((sum, part) => sum + part.size, 0),
    type: kind === 'pdf' ? 'application/pdf' : '',
    kind,
    file: new File([], name),
  };
}

/**
 * A row's files changed. Same rule as changing its settings: whatever the old
 * files produced no longer describes the row, a result in flight for them is
 * discarded, and a cancelled row stays cancelled.
 */
function withParts(item: QueueItem, parts: SourceFile[], epoch: number): QueueItem {
  const next: QueueItem = {
    ...item,
    parts,
    source: standIn(item.source.id, item.source.name, item.source.kind, parts),
    epoch,
  };
  return item.status === 'cancelled' ? next : { ...next, ...PENDING };
}

/**
 * Applies `fn` to one item, handing it a fresh epoch from the queue's counter.
 * If `fn` returns the item unchanged, the epoch is not consumed.
 */
function invalidate(
  state: QueueState,
  id: string,
  fn: (item: QueueItem, epoch: number) => QueueItem,
): QueueState {
  let consumed = false;
  const next = mapItem(state, id, (item) => {
    const updated = fn(item, state.nextEpoch);
    if (updated !== item) consumed = true;
    return updated;
  });
  return consumed ? { ...next, nextEpoch: state.nextEpoch + 1 } : next;
}

function mapItem(state: QueueState, id: string, fn: (item: QueueItem) => QueueItem): QueueState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    const next = fn(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...state, items } : state;
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'add': {
      const existing = new Set(state.order);
      const fresh = action.sources
        // Dedupe within this batch too, not only against the queue: ids come
        // from the file, so picking the same file twice in one gesture
        // otherwise makes two rows that share an id and later an epoch.
        .filter((source) => {
          if (existing.has(source.id)) return false;
          existing.add(source.id);
          return true;
        })
        .map<QueueItem>((source, index) => ({
          id: source.id,
          source,
          toolId: action.toolId,
          settings: { ...action.settings },
          status: 'queued',
          progress: null,
          epoch: state.nextEpoch + index,
        }));
      if (fresh.length === 0) return state;
      return {
        items: [...state.items, ...fresh],
        order: [...state.order, ...fresh.map((item) => item.id)],
        nextEpoch: state.nextEpoch + fresh.length,
      };
    }

    case 'remove':
      if (!state.order.includes(action.id)) return state;
      return {
        ...state,
        items: state.items.filter((item) => item.id !== action.id),
        order: state.order.filter((id) => id !== action.id),
      };

    case 'combine': {
      const gone = new Set(action.absorb);
      const absorbed = state.items.filter(
        // Only rows that have not started: folding in a finished one would
        // throw away a result that may not have been saved.
        (item) => gone.has(item.id) && !item.parts && item.status === 'queued',
      );
      // A row still waiting, or one that failed and is about to be tried
      // again, is added to rather than duplicated, so that dropping files one
      // gesture at a time still makes one merge. A finished one is left alone:
      // its result may not have been saved.
      const target = state.items.find(
        (item) =>
          item.toolId === action.toolId &&
          item.parts &&
          (item.status === 'queued' || item.status === 'error'),
      );

      const seen = new Set(target?.parts?.map((part) => part.id));
      const fresh = [...absorbed.map((item) => item.source), ...action.sources].filter((source) => {
        if (seen.has(source.id)) return false;
        seen.add(source.id);
        return true;
      });
      if (fresh.length === 0) return state;

      // Each folded-in file takes the password it was already given with it.
      const passwords: ToolSettings = {};
      for (const item of absorbed) {
        const typed = item.settings[openPasswordKey()];
        if (typeof typed === 'string' && typed !== '') {
          passwords[openPasswordKey(item.source.id)] = typed;
        }
      }

      const absorbedIds = new Set(absorbed.map((item) => item.id));
      const epoch = state.nextEpoch;
      const kept = state.items.filter((item) => !absorbedIds.has(item.id));
      const keptOrder = state.order.filter((id) => !absorbedIds.has(id));

      if (target?.parts) {
        const items = kept.map((item) =>
          item.id === target.id
            ? {
                ...withParts(item, [...(target.parts ?? []), ...fresh], epoch),
                settings: { ...item.settings, ...passwords },
              }
            : item,
        );
        return { items, order: keptOrder, nextEpoch: epoch + 1 };
      }

      const id = `combined:${action.toolId}:${epoch}`;
      const row: QueueItem = {
        id,
        source: standIn(id, action.outputName, action.kind, fresh),
        parts: fresh,
        toolId: action.toolId,
        settings: { ...action.settings, ...passwords },
        status: 'queued',
        progress: null,
        epoch,
      };
      return { items: [...kept, row], order: [...keptOrder, id], nextEpoch: epoch + 1 };
    }

    case 'moveSource':
      return invalidate(state, action.id, (item, epoch) => {
        const parts = item.parts;
        const from = parts?.findIndex((part) => part.id === action.sourceId) ?? -1;
        const to = from + action.by;
        if (!parts || from === -1 || to < 0 || to >= parts.length) return item;
        const moved = [...parts];
        [moved[from], moved[to]] = [moved[to] as SourceFile, moved[from] as SourceFile];
        return withParts(item, moved, epoch);
      });

    case 'removeSource': {
      const item = state.items.find((candidate) => candidate.id === action.id);
      const remaining = item?.parts?.filter((part) => part.id !== action.sourceId);
      if (!item?.parts || !remaining || remaining.length === item.parts.length) return state;
      // The last file going leaves a row with nothing to run.
      if (remaining.length === 0) return queueReducer(state, { type: 'remove', id: action.id });
      return invalidate(state, action.id, (current, epoch) => withParts(current, remaining, epoch));
    }

    case 'clear':
      // nextEpoch survives, so a file cleared and dropped again cannot be
      // given an epoch a worker is still carrying.
      return state.items.length === 0
        ? state
        : { items: [], order: [], nextEpoch: state.nextEpoch };

    case 'clearFinished': {
      const keep = state.items.filter(
        (item) => item.status !== 'done' && item.status !== 'error' && item.status !== 'cancelled',
      );
      if (keep.length === state.items.length) return state;
      const keepIds = new Set(keep.map((item) => item.id));
      return { ...state, items: keep, order: state.order.filter((id) => keepIds.has(id)) };
    }

    case 'setTool':
      return invalidate(state, action.id, (item, epoch) =>
        // A row of several files belongs to its tool: they were gathered for
        // it, and no other tool would know what to do with them.
        item.toolId === action.toolId || item.parts
          ? item
          : {
              ...item,
              toolId: action.toolId,
              settings: { ...action.settings },
              // A different tool invalidates whatever the last one produced,
              // including a result still on its way back from a worker.
              epoch,
              ...PENDING,
            },
      );

    case 'patchSettings':
      return invalidate(state, action.id, (item, epoch) =>
        applySettings(item, action.settings, epoch),
      );

    case 'patchSettingsAll': {
      let epoch = state.nextEpoch;
      let changed = false;
      const items = state.items.map((item) => {
        const next = applySettings(item, action.settings, epoch);
        if (next === item) return item;
        changed = true;
        epoch += 1;
        return next;
      });
      return changed ? { ...state, items, nextEpoch: epoch } : state;
    }

    case 'start':
      return mapItem(state, action.id, (item) => {
        // A runner marks a job started when a worker actually picks it up,
        // which can be long after it was enqueued. By then the person may
        // have cancelled it or changed its settings, and forcing 'running'
        // would undo that and leave the row spinning: the result that
        // eventually arrives carries the old epoch and is dropped, and
        // nothing else moves it on.
        if (item.epoch !== action.epoch) return item;
        return {
          ...item,
          status: 'running',
          progress: 0,
          error: undefined,
          needsPassword: undefined,
          output: undefined,
          startedAt: action.at,
          finishedAt: undefined,
        };
      });

    case 'progress':
      return mapItem(state, action.id, (item) => {
        // Late progress from a job that already finished, was cancelled, or
        // belongs to superseded settings must not revive it.
        if (item.status !== 'running' || item.epoch !== action.epoch) return item;
        const fraction = Math.min(Math.max(action.fraction, 0), 1);
        // Progress never goes backwards; workers report per-stage.
        const progress = Math.max(fraction, item.progress ?? 0);
        return progress === item.progress ? item : { ...item, progress };
      });

    case 'succeed':
      return mapItem(state, action.id, (item) => {
        // The job finished, but for settings that are no longer current, or
        // after the person pressed Cancel. Keeping it would make the Cancel
        // button a lie and show a size nobody asked for.
        if (item.epoch !== action.epoch || item.status === 'cancelled') return item;
        return {
          ...item,
          status: 'done',
          progress: 1,
          output: action.output,
          error: undefined,
          // A result for a job that was never started would otherwise give a
          // duration display NaN to render.
          startedAt: item.startedAt ?? action.at,
          finishedAt: action.at,
        };
      });

    case 'fail':
      return mapItem(state, action.id, (item) => {
        if (item.epoch !== action.epoch || item.status === 'cancelled') return item;
        return {
          ...item,
          status: 'error',
          progress: null,
          output: undefined,
          error: action.error,
          needsPassword: action.needsPassword,
          startedAt: item.startedAt ?? action.at,
          finishedAt: action.at,
        };
      });

    case 'cancel':
      return invalidate(state, action.id, (item, epoch) =>
        // A finished row has nothing left to stop, and cancelling an errored
        // one would throw away the reason it failed.
        item.status === 'done' || item.status === 'error' || item.status === 'cancelled'
          ? item
          : {
              ...item,
              status: 'cancelled',
              progress: null,
              // Moves the epoch so a result still coming back from the worker
              // is discarded rather than flipping the row to Done.
              epoch,
              finishedAt: action.at,
            },
      );

    case 'requeue':
      return invalidate(state, action.id, (item, epoch) => ({
        ...item,
        epoch,
        ...PENDING,
      }));

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Every byte a job produced, including the extra files a split emits. */
export function outputBytes(item: QueueItem): number {
  if (!item.output) return 0;
  const siblings = item.output.siblings ?? [];
  return siblings.reduce((sum, file) => sum + file.bytes.byteLength, item.output.bytes.byteLength);
}

export const selectors = {
  queued: (state: QueueState) => state.items.filter((item) => item.status === 'queued'),
  running: (state: QueueState) => state.items.filter((item) => item.status === 'running'),
  done: (state: QueueState) => state.items.filter((item) => item.status === 'done'),
  failed: (state: QueueState) => state.items.filter((item) => item.status === 'error'),
  totalOriginalBytes: (state: QueueState) =>
    state.items.reduce((sum, item) => sum + item.source.size, 0),
  totalOutputBytes: (state: QueueState) =>
    state.items.reduce((sum, item) => sum + outputBytes(item), 0),
  isBusy: (state: QueueState) =>
    state.items.some((item) => item.status === 'running' || item.status === 'queued'),
};
