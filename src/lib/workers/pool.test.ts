import { describe, expect, it, vi } from 'vitest';
import { PoolTerminatedError, WorkerCrashedError, WorkerPool } from './pool';

interface Api {
  work: (value: number) => Promise<number>;
}

/** A worker that never answers, which is what a terminated one looks like. */
function silentApi(): Api {
  return { work: () => new Promise<number>(() => {}) };
}

type FakeWorker = Worker & { crash: () => void };

function makePool(api: () => Api, size = 1) {
  const terminated: number[] = [];
  const spawned: FakeWorker[] = [];
  let created = 0;

  const factory = () => {
    const id = created++;
    const listeners = new Map<string, Array<() => void>>();
    const worker = {
      terminate: () => terminated.push(id),
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: () => {},
      /** Simulates the worker dying on its own, e.g. a wasm out-of-memory. */
      crash: () => {
        for (const fn of listeners.get('error') ?? []) fn();
      },
    } as unknown as FakeWorker;
    spawned.push(worker);
    return worker;
  };

  const pool = new WorkerPool<Api>(factory, {
    size,
    wrap: () => api() as unknown as never,
  });
  return { pool, terminated, spawned, created: () => created };
}

const settled = async <T>(promise: Promise<T>) => {
  const marker = Symbol('pending');
  return Promise.race([promise.catch((e) => e), Promise.resolve(marker)]);
};

describe('WorkerPool', () => {
  it('creates no worker until there is work', async () => {
    const { pool, created } = makePool(() => ({ work: async (v) => v }));
    expect(created()).toBe(0);
    const started = pool.run(async (api) => api.work(1));
    expect(created()).toBe(1);
    pool.terminate();
    await expect(started).rejects.toBeInstanceOf(PoolTerminatedError);
  });

  it('reuses one worker for sequential tasks rather than spawning more', async () => {
    const { pool, created } = makePool(() => ({ work: async (v) => v * 2 }), 2);
    expect(await pool.run(async (api) => api.work(1))).toBe(2);
    expect(await pool.run(async (api) => api.work(2))).toBe(4);
    expect(created()).toBe(1);
    pool.terminate();
  });

  it('runs a batch to completion without exceeding the size cap', async () => {
    const { pool, created } = makePool(() => ({ work: async (v) => v }), 2);
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => pool.run(async (api) => api.work(n))),
    );
    expect(results).toEqual([1, 2, 3, 4, 5, 6]);
    expect(created()).toBeLessThanOrEqual(2);
    pool.terminate();
  });

  it('returns a worker to the pool after a task throws', async () => {
    let calls = 0;
    const { pool, created } = makePool(
      () => ({
        work: async (v) => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return v;
        },
      }),
      1,
    );
    await expect(pool.run(async (api) => api.work(1))).rejects.toThrow('boom');
    expect(await pool.run(async (api) => api.work(2))).toBe(2);
    expect(created()).toBe(1);
    pool.terminate();
  });

  it('rejects work that is still in flight when it is terminated', async () => {
    // A Comlink call into a terminated worker never answers. Without this the
    // job's promise hangs forever and its queue row is stuck at "running"
    // with no way out.
    const { pool } = makePool(silentApi, 1);
    const inFlight = pool.run(async (api) => api.work(1));
    await Promise.resolve();
    pool.terminate();
    await expect(inFlight).rejects.toBeInstanceOf(PoolTerminatedError);
  });

  it('rejects work that is still queued when it is terminated', async () => {
    const { pool } = makePool(silentApi, 1);
    const inFlight = pool.run(async (api) => api.work(1));
    const queued = pool.run(async (api) => api.work(2));
    await Promise.resolve();
    pool.terminate();
    await expect(queued).rejects.toBeInstanceOf(PoolTerminatedError);
    await expect(inFlight).rejects.toBeInstanceOf(PoolTerminatedError);
  });

  it('terminates every worker it started', async () => {
    const { pool, terminated } = makePool(() => ({ work: async (v) => v }), 2);
    await Promise.all([1, 2].map((n) => pool.run(async (api) => api.work(n))));
    pool.terminate();
    expect(terminated.length).toBeGreaterThan(0);
  });

  it('refuses new work after termination instead of hanging', async () => {
    const { pool } = makePool(() => ({ work: async (v) => v }));
    pool.terminate();
    await expect(pool.run(async (api) => api.work(1))).rejects.toBeInstanceOf(PoolTerminatedError);
  });

  it('does not hand a dead worker to a later caller', async () => {
    // release() used to push the remote back into the idle list after
    // terminate(), so the next run would reuse an endpoint with no worker.
    const { pool } = makePool(silentApi, 1);
    const inFlight = pool.run(async (api) => api.work(1));
    await Promise.resolve();
    pool.terminate();
    await expect(inFlight).rejects.toBeInstanceOf(PoolTerminatedError);
    await expect(pool.run(async (api) => api.work(2))).rejects.toBeInstanceOf(PoolTerminatedError);
  });

  it('rejects the caller when the worker factory itself throws', async () => {
    const pool = new WorkerPool<Api>(
      () => {
        throw new Error('no workers available');
      },
      { size: 1, wrap: () => ({}) as never },
    );
    await expect(pool.run(async (api) => api.work(1))).rejects.toThrow('no workers available');
  });

  it('settles every promise exactly once', async () => {
    const resolve = vi.fn();
    const { pool } = makePool(() => ({ work: async (v) => v }), 1);
    const promise = pool.run(async (api) => api.work(1)).then(resolve);
    await promise;
    pool.terminate();
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await settled(promise)).not.toBeInstanceOf(Error);
  });
});

describe('WorkerPool resilience', () => {
  it('fails the task whose worker died instead of waiting for ever', async () => {
    // A large photo can exhaust the WebAssembly heap and take the worker with
    // it. The request it was handling then never answers.
    const { pool, spawned } = makePool(silentApi, 1);
    const job = pool.run(async (api) => api.work(1));
    await Promise.resolve();
    spawned[0]?.crash();
    await expect(job).rejects.toBeInstanceOf(WorkerCrashedError);
    pool.terminate();
  });

  it('does not strand work queued behind a worker that died', async () => {
    let answer: ((value: number) => void) | null = null;
    let call = 0;
    const { pool, spawned } = makePool(
      () => ({
        work: async (v) => {
          call += 1;
          // The first worker never answers; a replacement behaves normally.
          if (call === 1) return new Promise<number>((resolve) => (answer = resolve));
          return v;
        },
      }),
      1,
    );

    const first = pool.run(async (api) => api.work(1));
    await Promise.resolve();
    const second = pool.run(async (api) => api.work(2));

    spawned[0]?.crash();

    await expect(first).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(await second).toBe(2);
    expect(answer).not.toBeNull();
    pool.terminate();
  });

  it('replaces a dead worker rather than running permanently short-handed', async () => {
    const { pool, spawned, created } = makePool(() => ({ work: async (v) => v }), 1);
    expect(await pool.run(async (api) => api.work(1))).toBe(1);
    spawned[0]?.crash();
    expect(await pool.run(async (api) => api.work(2))).toBe(2);
    expect(created()).toBe(2);
    pool.terminate();
  });

  it('terminates the dead worker so it cannot linger', async () => {
    const { pool, spawned, terminated } = makePool(silentApi, 1);
    const job = pool.run(async (api) => api.work(1));
    await Promise.resolve();
    spawned[0]?.crash();
    await expect(job).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(terminated).toContain(0);
    pool.terminate();
  });

  it('does not hang when asked for a pool of size zero', async () => {
    // Math.max(1, ...) or acquire() returns null for ever with nothing in
    // flight to wake the wait list.
    const { pool } = makePool(() => ({ work: async (v) => v }), 0);
    expect(await pool.run(async (api) => api.work(7))).toBe(7);
    pool.terminate();
  });

  it('does not consume a worker slot when wrapping fails', async () => {
    // The slot used to be taken before wrap ran, so one failure left the pool
    // permanently full of a worker that never existed.
    let attempts = 0;
    const pool = new WorkerPool<Api>(
      () => ({ terminate: () => {}, addEventListener: () => {} }) as unknown as Worker,
      {
        size: 1,
        wrap: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('wrap failed');
          return { work: async (v: number) => v } as unknown as never;
        },
      },
    );

    await expect(pool.run(async (api) => api.work(1))).rejects.toThrow('wrap failed');
    expect(await pool.run(async (api) => api.work(2))).toBe(2);
    pool.terminate();
  });
});

describe('WorkerPool when a replacement cannot be created', () => {
  /** First worker is handed out, every later one fails to be created. */
  function pooWithOneShotFactory(fail: 'factory' | 'wrap') {
    const spawned: FakeWorker[] = [];
    let created = 0;
    const factory = () => {
      created += 1;
      if (fail === 'factory' && created > 1) throw new Error('cannot create worker');
      const listeners = new Map<string, Array<() => void>>();
      const worker = {
        terminate: () => {},
        addEventListener: (type: string, fn: () => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeEventListener: () => {},
        crash: () => {
          for (const fn of listeners.get('error') ?? []) fn();
        },
      } as unknown as FakeWorker;
      spawned.push(worker);
      return worker;
    };

    let wrapped = 0;
    const pool = new WorkerPool<Api>(factory, {
      size: 1,
      wrap: () => {
        wrapped += 1;
        if (fail === 'wrap' && wrapped > 1) throw new Error('cannot wrap worker');
        return { work: () => new Promise<number>(() => {}) } as unknown as never;
      },
    });
    return { pool, spawned };
  }

  for (const fail of ['factory', 'wrap'] as const) {
    it(`rejects queued work instead of hanging when the ${fail} fails`, async () => {
      // A worker dies because memory ran out, which is also when creating its
      // replacement is most likely to fail. Queued work used to sit pending
      // for ever with no error anywhere.
      const { pool, spawned } = pooWithOneShotFactory(fail);

      const running = pool.run(async (api) => api.work(1));
      await Promise.resolve();
      const queued = pool.run(async (api) => api.work(2));
      await Promise.resolve();

      spawned[0]?.crash();

      await expect(running).rejects.toBeInstanceOf(WorkerCrashedError);
      await expect(queued).rejects.toThrow(/cannot (create|wrap) worker/);
      pool.terminate();
    });
  }

  it('leaves no worker behind when wrapping fails', async () => {
    const pool = new WorkerPool<Api>(
      () => ({ terminate: () => {}, addEventListener: () => {} }) as unknown as Worker,
      {
        size: 1,
        wrap: () => {
          throw new Error('wrap failed');
        },
      },
    );
    await expect(pool.run(async (api) => api.work(1))).rejects.toThrow('wrap failed');
    expect(pool.workerCount).toBe(0);
    pool.terminate();
  });
});

describe('WorkerPool keeps healthy workers working', () => {
  it('does not fail the rest of the batch when one respawn is refused', async () => {
    // Forty photos, four workers, one huge file takes its worker down.
    // Memory is tight so the replacement is refused. Failing the other
    // thirty-six rows in one tick while three workers sit idle would be far
    // worse than waiting for them.
    const spawned: FakeWorker[] = [];
    let created = 0;
    const factory = () => {
      created += 1;
      if (created > 2) throw new Error('cannot create worker');
      const listeners = new Map<string, Array<() => void>>();
      const worker = {
        terminate: () => {},
        addEventListener: (type: string, fn: () => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeEventListener: () => {},
        crash: () => {
          for (const fn of listeners.get('error') ?? []) fn();
        },
      } as unknown as FakeWorker;
      spawned.push(worker);
      return worker;
    };

    let wrapped = 0;
    const pool = new WorkerPool<Api>(factory, {
      size: 2,
      wrap: () => {
        const mine = wrapped++;
        // The first worker hangs; the second behaves normally.
        return {
          work: (v: number) => (mine === 0 ? new Promise<number>(() => {}) : Promise.resolve(v)),
        } as unknown as never;
      },
    });

    const a = pool.run(async (api) => api.work(1));
    const b = pool.run(async (api) => api.work(2));
    await Promise.resolve();
    const c = pool.run(async (api) => api.work(3));
    const d = pool.run(async (api) => api.work(4));
    await Promise.resolve();

    spawned[0]?.crash();

    await expect(a).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(await b).toBe(2);
    expect(await c).toBe(3);
    expect(await d).toBe(4);
    pool.terminate();
  });
});

describe('WorkerPool when spawning starts failing mid-batch', () => {
  /** One usable worker, then every creation is refused. */
  function oneGoodWorker(mode: 'factory' | 'wrap') {
    let created = 0;
    const factory = () => {
      created += 1;
      if (mode === 'factory' && created > 1) throw new Error('cannot create worker');
      return {
        terminate: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as Worker;
    };
    let wrapped = 0;
    return new WorkerPool<Api>(factory, {
      size: 4,
      wrap: () => {
        wrapped += 1;
        if (mode === 'wrap' && wrapped > 1) throw new Error('cannot wrap worker');
        return { work: async (v: number) => v } as unknown as never;
      },
    });
  }

  for (const mode of ['factory', 'wrap'] as const) {
    it(`queues the batch onto the surviving worker when the ${mode} starts failing`, async () => {
      // Submitting forty files to a four-worker pool that can only create one
      // used to reject thirty-nine of them on the spot, while the worker that
      // does exist sat idle. run() went straight to acquire(); only the pump
      // path had been taught to wait.
      const pool = oneGoodWorker(mode);
      const jobs = Array.from({ length: 40 }, (_, n) => pool.run(async (api) => api.work(n)));

      const results = await Promise.allSettled(jobs);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(40);
      pool.terminate();
    });
  }

  it('still fails fast when no worker can be created at all', async () => {
    // Nothing is in flight to drain the queue, so waiting would hang for ever.
    const pool = new WorkerPool<Api>(
      () => {
        throw new Error('no workers available');
      },
      { size: 2 },
    );
    const jobs = [pool.run(async (api) => api.work(1)), pool.run(async (api) => api.work(2))];
    const results = await Promise.allSettled(jobs);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    pool.terminate();
  });
});
