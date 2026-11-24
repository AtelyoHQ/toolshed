import { describe, expect, it, vi } from 'vitest';
import { saveBlob, type SaveEnvironment } from './download';

/**
 * These branches decide whether someone's file is written, lost, or left
 * truncated at a path they chose. None of them is observable from the UI
 * afterwards, which is exactly why they are tested here.
 */
function environment(
  picker: SaveEnvironment['picker'],
): SaveEnvironment & { anchorFallback: ReturnType<typeof vi.fn> } {
  return { picker, anchorFallback: vi.fn() };
}

function writable(overrides: Partial<Record<'write' | 'close' | 'abort', () => Promise<void>>>) {
  const abort = vi.fn(overrides.abort ?? (async () => {}));
  return {
    handle: {
      createWritable: async () => ({
        write: overrides.write ?? (async () => {}),
        close: overrides.close ?? (async () => {}),
        abort,
      }),
    },
    abort,
  };
}

const blob = new Blob(['x'], { type: 'image/jpeg' });

describe('saveBlob', () => {
  it('writes through the picker and reports success', async () => {
    const { handle } = writable({});
    const env = environment(async () => handle);
    expect(await saveBlob(blob, 'a.jpg', env)).toBe(true);
    expect(env.anchorFallback).not.toHaveBeenCalled();
  });

  it('reports a cancelled dialog as not-saved, without a second copy', async () => {
    const env = environment(async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    expect(await saveBlob(blob, 'a.jpg', env)).toBe(false);
    // Dropping a copy into Downloads after someone pressed Cancel is its own
    // small betrayal.
    expect(env.anchorFallback).not.toHaveBeenCalled();
  });

  it('recognises a cancellation from another realm', async () => {
    // `instanceof DOMException` is false across realms; the name is not.
    const env = environment(async () => {
      throw { name: 'AbortError', message: 'cancelled' };
    });
    expect(await saveBlob(blob, 'a.jpg', env)).toBe(false);
  });

  it('falls back to a download when the picker itself is unusable', async () => {
    const env = environment(async () => {
      throw new TypeError('not allowed in this context');
    });
    expect(await saveBlob(blob, 'a.jpg', env)).toBe(true);
    expect(env.anchorFallback).toHaveBeenCalledOnce();
  });

  it('uses a plain download when the browser has no picker', async () => {
    const env = environment(undefined);
    expect(await saveBlob(blob, 'a.jpg', env)).toBe(true);
    expect(env.anchorFallback).toHaveBeenCalledOnce();
  });

  it('aborts the write and reports failure rather than claiming success', async () => {
    // By now the browser has truncated the file at the chosen path. Quietly
    // putting a copy in Downloads would leave an empty file where the real
    // one was asked for, and call it a success.
    const { handle, abort } = writable({
      write: async () => {
        throw new Error('disk full');
      },
    });
    const env = environment(async () => handle);

    await expect(saveBlob(blob, 'a.jpg', env)).rejects.toThrow('disk full');
    expect(abort).toHaveBeenCalledOnce();
    expect(env.anchorFallback).not.toHaveBeenCalled();
  });

  it('aborts when closing fails too', async () => {
    const { handle, abort } = writable({
      close: async () => {
        throw new Error('interrupted');
      },
    });
    await expect(
      saveBlob(
        blob,
        'a.jpg',
        environment(async () => handle),
      ),
    ).rejects.toThrow('interrupted');
    expect(abort).toHaveBeenCalledOnce();
  });

  it('does not mask the original error when abort is missing or fails', async () => {
    const env = environment(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new Error('disk full');
        },
        close: async () => {},
        abort: async () => {
          throw new Error('abort also failed');
        },
      }),
    }));
    await expect(saveBlob(blob, 'a.jpg', env)).rejects.toThrow('disk full');
  });

  it('surfaces a refused write permission instead of silently downloading', async () => {
    const env = environment(async () => ({
      createWritable: async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      },
    }));
    await expect(saveBlob(blob, 'a.jpg', env)).rejects.toThrow('denied');
    expect(env.anchorFallback).not.toHaveBeenCalled();
  });
});
