import { describe, expect, it } from 'vitest';
import { emptyQueue, queueReducer, selectors, type QueueAction, type QueueState } from './queue';
import type { JobOutput, SourceFile } from '../lib/types';

function source(id: string, size = 1000): SourceFile {
  return {
    id,
    name: `${id}.jpg`,
    size,
    type: 'image/jpeg',
    kind: 'image',
    file: new File([new Uint8Array(size)], `${id}.jpg`, { type: 'image/jpeg' }),
  };
}

const output: JobOutput = {
  bytes: new Uint8Array(250),
  name: 'a.jpg',
  mime: 'image/jpeg',
};

function withItems(...ids: string[]): QueueState {
  return queueReducer(emptyQueue, {
    type: 'add',
    sources: ids.map((id) => source(id)),
    toolId: 'image-compress',
    settings: { quality: 75 },
  });
}

describe('add', () => {
  it('appends items in order and seeds them from the tool defaults', () => {
    const state = withItems('a', 'b');
    expect(state.order).toEqual(['a', 'b']);
    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.settings).toEqual({ quality: 75 });
  });

  it('gives each item its own settings object', () => {
    const state = queueReducer(withItems('a', 'b'), {
      type: 'patchSettings',
      id: 'a',
      settings: { quality: 40 },
    });
    expect(state.items[0]?.settings.quality).toBe(40);
    expect(state.items[1]?.settings.quality).toBe(75);
  });

  it('ignores a file already in the queue', () => {
    const state = withItems('a');
    const again = queueReducer(state, {
      type: 'add',
      sources: [source('a')],
      toolId: 'image-compress',
      settings: {},
    });
    expect(again).toBe(state);
    expect(again.items).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('moves through start, progress and succeed', () => {
    let state = withItems('a');
    state = queueReducer(state, { type: 'start', id: 'a', at: 100, epoch: 0 });
    expect(state.items[0]?.status).toBe('running');

    state = queueReducer(state, { type: 'progress', id: 'a', fraction: 0.5, epoch: 0 });
    expect(state.items[0]?.progress).toBe(0.5);

    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 200, epoch: 0 });
    expect(state.items[0]?.status).toBe('done');
    expect(state.items[0]?.progress).toBe(1);
    expect(state.items[0]?.output?.bytes.byteLength).toBe(250);
  });

  it('never lets progress go backwards', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'progress', id: 'a', fraction: 0.8, epoch: 0 });
    state = queueReducer(state, { type: 'progress', id: 'a', fraction: 0.3, epoch: 0 });
    expect(state.items[0]?.progress).toBe(0.8);
  });

  it('clamps out-of-range progress', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'progress', id: 'a', fraction: 4, epoch: 0 });
    expect(state.items[0]?.progress).toBe(1);
  });

  it('ignores progress arriving after the job finished', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    // A fraction *above* the stored progress, so the guard is what rejects it
    // rather than the never-go-backwards rule doing so incidentally.
    const after = queueReducer(state, { type: 'progress', id: 'a', fraction: 1, epoch: 0 });
    expect(after).toBe(state);
    expect(after.items[0]?.status).toBe('done');
  });

  it('clears a stale result when a job fails on a retry', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'start', id: 'a', at: 2, epoch: 0 });
    state = queueReducer(state, { type: 'fail', id: 'a', error: 'boom', at: 3, epoch: 0 });
    expect(state.items[0]?.output).toBeUndefined();
    expect(state.items[0]?.error).toBe('boom');
  });
});

describe('setTool', () => {
  it('discards a result produced by the previous tool', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    state = queueReducer(state, {
      type: 'setTool',
      id: 'a',
      toolId: 'image-to-webp',
      settings: { quality: 80 },
    });
    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.output).toBeUndefined();
    expect(state.items[0]?.settings).toEqual({ quality: 80 });
  });

  it('is a no-op when the tool is unchanged, keeping the result', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    const same = queueReducer(state, {
      type: 'setTool',
      id: 'a',
      toolId: 'image-compress',
      settings: {},
    });
    expect(same).toBe(state);
  });
});

describe('removal', () => {
  it('removes one item from both items and order', () => {
    const state = queueReducer(withItems('a', 'b'), { type: 'remove', id: 'a' });
    expect(state.order).toEqual(['b']);
    expect(state.items).toHaveLength(1);
  });

  it('keeps unfinished work when clearing finished items', () => {
    let state = withItems('a', 'b');
    state = queueReducer(state, { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'clearFinished' });
    expect(state.order).toEqual(['b']);
  });

  it('returns the same state when there is nothing to clear', () => {
    const state = withItems('a');
    expect(queueReducer(state, { type: 'clearFinished' })).toBe(state);
  });
});

describe('selectors', () => {
  it('totals original and output bytes', () => {
    let state = withItems('a', 'b');
    state = queueReducer(state, { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    expect(selectors.totalOriginalBytes(state)).toBe(2000);
    expect(selectors.totalOutputBytes(state)).toBe(250);
    expect(selectors.isBusy(state)).toBe(true);
    expect(selectors.done(state)).toHaveLength(1);
  });
});

describe('settings invalidate a finished result', () => {
  function doneItem(): QueueState {
    const state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    return queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
  }

  it('requeues a done item when its settings change', () => {
    // Otherwise the row says "done" with a size produced by settings that are
    // no longer on screen, and Download hands over the wrong file.
    const state = queueReducer(doneItem(), {
      type: 'patchSettings',
      id: 'a',
      settings: { quality: 20 },
    });
    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.output).toBeUndefined();
    expect(state.items[0]?.settings.quality).toBe(20);
  });

  it('requeues a failed item too, so a retry is possible', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'fail', id: 'a', error: 'boom', at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 50 } });
    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.error).toBeUndefined();
  });

  it('does the same for a batch-wide change', () => {
    const state = queueReducer(doneItem(), {
      type: 'patchSettingsAll',
      settings: { quality: 30 },
    });
    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.output).toBeUndefined();
  });

  it('is identity when the settings are unchanged, so a slider does not rerender everything', () => {
    const state = withItems('a', 'b');
    expect(queueReducer(state, { type: 'patchSettingsAll', settings: { quality: 75 } })).toBe(
      state,
    );
  });

  it('leaves a queued item queued', () => {
    const state = queueReducer(withItems('a'), {
      type: 'patchSettings',
      id: 'a',
      settings: { quality: 10 },
    });
    expect(state.items[0]?.status).toBe('queued');
  });
});

describe('cancel', () => {
  it('moves a running job out of running so the queue stops looking busy', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 5 });
    expect(state.items[0]?.status).toBe('cancelled');
    expect(selectors.isBusy(state)).toBe(false);
  });

  it('does not throw away a result that already arrived', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 2 });
    expect(state.items[0]?.status).toBe('done');
  });

  it('is cleared by clearFinished', () => {
    let state = queueReducer(withItems('a', 'b'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    state = queueReducer(state, { type: 'clearFinished' });
    expect(state.order).toEqual(['b']);
  });
});

describe('totals', () => {
  it('counts the extra files a split produced, not just the first', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, {
      type: 'succeed',
      id: 'a',
      at: 1,
      epoch: 0,
      output: {
        ...output,
        siblings: [
          { bytes: new Uint8Array(300), name: 'b.pdf', mime: 'application/pdf' },
          { bytes: new Uint8Array(100), name: 'c.pdf', mime: 'application/pdf' },
        ],
      },
    });
    expect(selectors.totalOutputBytes(state)).toBe(250 + 300 + 100);
  });

  it('gives a duration even when a result arrives for a job that was never started', () => {
    const state = queueReducer(withItems('a'), {
      type: 'succeed',
      id: 'a',
      output,
      at: 9,
      epoch: 0,
    });
    expect(state.items[0]?.startedAt).toBe(9);
    expect(state.items[0]?.finishedAt).toBe(9);
  });
});

describe('results that arrive too late', () => {
  // Cancellation is cooperative: a WebAssembly call cannot be interrupted, so
  // the worker nearly always finishes *after* Cancel is pressed. Every one of
  // these is the ordering that actually happens, not a contrived one.

  it('does not resurrect a cancelled job when its result arrives', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const epoch = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 2, epoch });

    expect(state.items[0]?.status).toBe('cancelled');
    expect(state.items[0]?.output).toBeUndefined();
  });

  it('does not turn a cancelled job into an error either', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const epoch = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    state = queueReducer(state, { type: 'fail', id: 'a', error: 'boom', at: 2, epoch });

    expect(state.items[0]?.status).toBe('cancelled');
    expect(state.items[0]?.error).toBeUndefined();
  });

  it('discards a result computed with settings the person has already changed', () => {
    // Drag the quality slider mid-batch: the in-flight job was encoded at the
    // old quality, and showing its size next to the new number is the exact
    // lie this reducer exists to prevent.
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const epoch = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 10 } });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 2, epoch });

    expect(state.items[0]?.output).toBeUndefined();
    expect(state.items[0]?.settings.quality).toBe(10);
    // Back to queued, so it gets dispatched again at the new quality. Leaving
    // it at 'running' stranded the row: its in-flight result is dropped on
    // arrival and nothing else would ever move it on.
    expect(state.items[0]?.status).toBe('queued');
  });

  it('accepts a result produced with the settings still on screen', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 10 } });
    const epoch = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'start', id: 'a', at: 2, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 3, epoch });

    expect(state.items[0]?.status).toBe('done');
    expect(state.items[0]?.output).toBeDefined();
  });

  it('ignores progress from a superseded run', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const epoch = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 10 } });
    const after = queueReducer(state, { type: 'progress', id: 'a', fraction: 0.9, epoch });
    expect(after).toBe(state);
  });

  it('moves the epoch on every action that invalidates a run', () => {
    const start = withItems('a');
    const base = start.items[0]?.epoch ?? 0;
    const bump = (action: QueueAction) => queueReducer(start, action).items[0]?.epoch;

    expect(bump({ type: 'patchSettings', id: 'a', settings: { quality: 1 } })).toBe(base + 1);
    expect(bump({ type: 'patchSettingsAll', settings: { quality: 1 } })).toBe(base + 1);
    expect(bump({ type: 'setTool', id: 'a', toolId: 'other', settings: {} })).toBe(base + 1);
    expect(bump({ type: 'cancel', id: 'a', at: 1 })).toBe(base + 1);
    expect(bump({ type: 'requeue', id: 'a' })).toBe(base + 1);
  });

  it('leaves the epoch alone when nothing actually changed', () => {
    const start = withItems('a');
    const same = queueReducer(start, { type: 'patchSettings', id: 'a', settings: { quality: 75 } });
    expect(same.items[0]?.epoch).toBe(start.items[0]?.epoch);
  });
});

describe('epochs are never reused', () => {
  it('does not accept an old result after a row is removed and the file re-added', () => {
    // Ids come from the file, and `add` dedupes on them, so dropping the same
    // file again produces the same id. With a per-item counter the epoch reset
    // to zero and a worker still answering for the removed row was believed.
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const inFlight = state.items[0]?.epoch ?? 0;

    state = queueReducer(state, { type: 'remove', id: 'a' });
    state = queueReducer(state, {
      type: 'add',
      sources: [source('a')],
      toolId: 'image-compress',
      settings: { quality: 10 },
    });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 2, epoch: inFlight });

    expect(state.items[0]?.status).toBe('queued');
    expect(state.items[0]?.output).toBeUndefined();
  });

  it('survives clearing the whole queue', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    const inFlight = state.items[0]?.epoch ?? 0;

    state = queueReducer(state, { type: 'clear' });
    state = queueReducer(state, {
      type: 'add',
      sources: [source('a')],
      toolId: 'image-compress',
      settings: {},
    });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 2, epoch: inFlight });

    expect(state.items[0]?.output).toBeUndefined();
  });

  it('gives every file in one drop a distinct epoch', () => {
    const state = withItems('a', 'b', 'c');
    const epochs = state.items.map((item) => item.epoch);
    expect(new Set(epochs).size).toBe(3);
  });
});

describe('cancelling is respected', () => {
  it('is not undone by a batch-wide settings change', () => {
    // Nudging one global slider must not silently restart every file the
    // person deliberately stopped.
    let state = queueReducer(withItems('a', 'b'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    state = queueReducer(state, { type: 'patchSettingsAll', settings: { quality: 30 } });

    expect(state.items[0]?.status).toBe('cancelled');
    // The new settings still apply, so running it again later uses them.
    expect(state.items[0]?.settings.quality).toBe(30);
    // Only the untouched sibling keeps the queue busy.
    expect(selectors.queued(state).map((item) => item.id)).toEqual(['b']);
  });

  it('keeps the reason a job failed instead of erasing it', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'fail', id: 'a', error: 'boom', at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 2 });

    expect(state.items[0]?.status).toBe('error');
    expect(state.items[0]?.error).toBe('boom');
  });

  it('does not rewrite the finish time when cancelled twice', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    const after = queueReducer(state, { type: 'cancel', id: 'a', at: 99 });

    expect(after).toBe(state);
    expect(after.items[0]?.finishedAt).toBe(1);
  });

  it('can be explicitly requeued, which is the way back', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 1 });
    state = queueReducer(state, { type: 'requeue', id: 'a' });

    expect(state.items[0]?.status).toBe('queued');
  });
});

describe('a job that starts late', () => {
  // A runner marks a job started when a worker picks it up, which can be long
  // after it was enqueued. By then the person may have moved on.

  it('does not undo a cancellation', () => {
    let state = withItems('a');
    const dispatched = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'cancel', id: 'a', at: 200 });

    // The worker only now picks the job up.
    state = queueReducer(state, { type: 'start', id: 'a', at: 300, epoch: dispatched });

    expect(state.items[0]?.status).toBe('cancelled');
    expect(state.items[0]?.finishedAt).toBe(200);
  });

  it('does not strand a row whose settings changed while it waited', () => {
    // Without an epoch on start, this row went to 'running', its own result
    // was then dropped as stale, and nothing ever moved it on again.
    let state = withItems('a');
    const dispatched = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 20 } });

    state = queueReducer(state, { type: 'start', id: 'a', at: 300, epoch: dispatched });

    expect(state.items[0]?.status).toBe('queued');
    expect(selectors.queued(state).map((item) => item.id)).toEqual(['a']);
  });

  it('still starts a job nobody touched', () => {
    let state = withItems('a');
    const dispatched = state.items[0]?.epoch ?? 0;
    state = queueReducer(state, { type: 'start', id: 'a', at: 300, epoch: dispatched });
    expect(state.items[0]?.status).toBe('running');
  });

  it('allows a deliberate retry of a finished job', () => {
    let state = queueReducer(withItems('a'), { type: 'start', id: 'a', at: 0, epoch: 0 });
    state = queueReducer(state, { type: 'succeed', id: 'a', output, at: 1, epoch: 0 });
    state = queueReducer(state, { type: 'start', id: 'a', at: 2, epoch: 0 });
    expect(state.items[0]?.status).toBe('running');
    expect(state.items[0]?.output).toBeUndefined();
  });
});

describe('the epoch counter itself', () => {
  it('advances when an item is invalidated, so the value cannot come back', () => {
    // Without this the invalidation hands out an epoch, the counter stays put,
    // and the same value is given to the next file added.
    let state = withItems('a');
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 5 } });
    const handedOut = state.items[0]?.epoch ?? -1;

    state = queueReducer(state, { type: 'remove', id: 'a' });
    state = queueReducer(state, {
      type: 'add',
      sources: [source('a')],
      toolId: 'image-compress',
      settings: {},
    });

    expect(state.items[0]?.epoch).not.toBe(handedOut);
  });

  it('gives each changed item its own epoch in a batch-wide change', () => {
    let state = withItems('a', 'b', 'c');
    state = queueReducer(state, { type: 'patchSettingsAll', settings: { quality: 42 } });
    const epochs = state.items.map((item) => item.epoch);
    expect(new Set(epochs).size).toBe(3);
  });

  it('never hands the same value to two items', () => {
    let state = withItems('a', 'b');
    state = queueReducer(state, { type: 'patchSettings', id: 'a', settings: { quality: 1 } });
    state = queueReducer(state, { type: 'patchSettingsAll', settings: { quality: 2 } });
    state = queueReducer(state, { type: 'cancel', id: 'b', at: 1 });
    state = queueReducer(state, { type: 'requeue', id: 'b' });
    const epochs = state.items.map((item) => item.epoch);
    expect(new Set(epochs).size).toBe(epochs.length);
  });

  it('refuses to make two rows out of the same file dropped twice at once', () => {
    const state = queueReducer(emptyQueue, {
      type: 'add',
      sources: [source('a'), source('a'), source('b')],
      toolId: 'image-compress',
      settings: {},
    });
    expect(state.order).toEqual(['a', 'b']);
    expect(state.items).toHaveLength(2);
  });

  it('does not alias the exported empty queue when cleared', () => {
    const state = queueReducer(withItems('a'), { type: 'clear' });
    expect(state.items).not.toBe(emptyQueue.items);
    expect(state.order).not.toBe(emptyQueue.order);
  });
});
