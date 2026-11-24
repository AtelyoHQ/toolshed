import * as Comlink from 'comlink';

/**
 * A small pool of workers behind Comlink.
 *
 * Batch work is the case that matters: forty photos should use the machine
 * rather than trickle through one at a time, and the main thread must stay free
 * enough to keep the progress bars moving and the cancel button responsive.
 *
 * Each worker holds its own WebAssembly instances, so the pool is capped well
 * below the core count — more workers would buy little and cost a lot of
 * memory on a laptop.
 */

export class WorkerCrashedError extends Error {
  constructor() {
    super(
      'The worker handling this file stopped unexpectedly, most likely because the file was too large for the available memory',
    );
    this.name = 'WorkerCrashedError';
  }
}

export class PoolTerminatedError extends Error {
  constructor() {
    super('Worker pool has been terminated');
    this.name = 'PoolTerminatedError';
  }
}

export class TaskAbandonedError extends Error {
  constructor() {
    super('This job was cancelled before it started');
    this.name = 'TaskAbandonedError';
  }
}

export interface PoolOptions<Api = unknown> {
  /** Defaults to cores - 1, clamped to 1..4. */
  size?: number;
  /**
   * How a worker is turned into a callable object. Defaults to Comlink.
   * Overridable so the pool's own behaviour — queueing, termination, worker
   * reuse — can be tested without spawning real workers.
   */
  wrap?: (worker: Worker) => Comlink.Remote<Api>;
}

type Task<Api, R> = {
  run: (api: Comlink.Remote<Api>) => Promise<R>;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
};

/**
 * Workers for a pool that does not ask for a size: one per core less one, up
 * to four. Exported so a pool with a lower ceiling of its own can take the
 * smaller of the two rather than restate this.
 */
export function defaultPoolSize(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.min(4, Math.max(1, cores - 1));
}

export class WorkerPool<Api> {
  private readonly workers: Worker[] = [];
  private readonly idle: Array<Comlink.Remote<Api>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly waiting: Array<Task<Api, any>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly inFlight = new Set<Task<Api, any>>();
  private readonly owners = new Map<Comlink.Remote<Api>, Worker>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly assigned = new Map<Comlink.Remote<Api>, Task<Api, any>>();
  private started = 0;
  private terminated = false;

  constructor(
    private readonly factory: () => Worker,
    private readonly options: PoolOptions<Api> = {},
  ) {}

  private get maxSize(): number {
    // Floored at 1: a size of 0 would leave acquire() returning null for ever
    // with nothing in flight to wake the wait list, hanging the whole queue.
    return Math.max(1, Math.floor(this.options.size ?? defaultPoolSize()));
  }

  /** How many workers are currently alive. Exposed for tests. */
  get workerCount(): number {
    return this.workers.length;
  }

  /** Workers are created on demand, so an unused pool costs nothing. */
  private spawn(): Comlink.Remote<Api> {
    const worker = this.factory();
    let api: Comlink.Remote<Api>;
    try {
      api = this.options.wrap ? this.options.wrap(worker) : Comlink.wrap<Api>(worker);
    } catch (error) {
      // The slot must not be consumed by a worker that never became usable,
      // or every later run() waits for a worker that will never free up.
      worker.terminate();
      throw error;
    }

    // A worker can die on its own: a large photo can exhaust the WebAssembly
    // heap, and the request it was handling then never answers. Without this
    // the task stays in flight for ever and everything queued behind it waits
    // on a worker that is gone.
    worker.addEventListener('error', () => this.evict(api, new WorkerCrashedError()));
    worker.addEventListener('messageerror', () => this.evict(api, new WorkerCrashedError()));

    this.workers.push(worker);
    this.owners.set(api, worker);
    this.started += 1;
    return api;
  }

  /** Drops a worker and fails whatever it was doing. */
  private evict(api: Comlink.Remote<Api>, reason: Error): void {
    const task = this.assigned.get(api);
    if (task && this.inFlight.delete(task)) task.reject(reason);
    this.assigned.delete(api);

    const worker = this.owners.get(api);
    if (worker) {
      worker.terminate();
      this.owners.delete(api);
      const index = this.workers.indexOf(worker);
      if (index !== -1) this.workers.splice(index, 1);
      this.started = Math.max(0, this.started - 1);
    }

    const idleIndex = this.idle.indexOf(api);
    if (idleIndex !== -1) this.idle.splice(idleIndex, 1);

    // A replacement is spawned lazily by the next acquire(); pull the wait
    // list forward now so queued work is not stranded behind the dead worker.
    this.pump();
  }

  /**
   * Gives a task a worker, or parks it until one frees up.
   *
   * Both ways into the pool go through here — a new `run()` and the pumping
   * that follows a completion or a crash — so the policy for "no worker can
   * be created right now" is written once. It used to exist only on the pump
   * path, and a batch submitted through `run()` got the opposite behaviour.
   *
   * @returns the error to report when the task cannot be queued at all.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private place(task: Task<Api, any>): void {
    let api: Comlink.Remote<Api> | null;
    try {
      api = this.acquire();
    } catch (error) {
      // Creating a worker failed. If work is still in flight, one of those
      // tasks will release its worker and pump the queue onward, so the batch
      // drains on the workers that are healthy — failing thirty-six of forty
      // photos because one spawn was refused, while three workers sit idle,
      // would be far worse than waiting for them. Only when nothing is left
      // to do the pumping is the queue genuinely stranded.
      if (this.inFlight.size === 0) {
        task.reject(error);
        for (const queued of this.waiting.splice(0)) queued.reject(error);
        return;
      }
      this.waiting.push(task);
      return;
    }

    if (api) void this.dispatch(api, task);
    else this.waiting.push(task);
  }

  /** Starts as much queued work as there is capacity for. */
  private pump(): void {
    while (!this.terminated && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) return;

      const before = this.waiting.length;
      this.place(next);
      // place() parked it again, so there is no capacity to be had.
      if (this.waiting.length > before) return;
    }
  }

  private acquire(): Comlink.Remote<Api> | null {
    const free = this.idle.pop();
    if (free) return free;
    if (this.started < this.maxSize) return this.spawn();
    return null;
  }

  private release(api: Comlink.Remote<Api>): void {
    // After terminate(), or after this worker was evicted, the endpoint is
    // dead; putting it back in the idle list would hand it to the next caller.
    if (this.terminated || !this.owners.has(api)) return;
    const next = this.waiting.shift();
    if (next) {
      void this.dispatch(api, next);
      return;
    }
    this.idle.push(api);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async dispatch(api: Comlink.Remote<Api>, task: Task<Api, any>): Promise<void> {
    this.inFlight.add(task);
    this.assigned.set(api, task);
    try {
      const value = await task.run(api);
      if (this.inFlight.delete(task)) task.resolve(value);
    } catch (error) {
      if (this.inFlight.delete(task)) task.reject(error);
    } finally {
      if (this.assigned.get(api) === task) this.assigned.delete(api);
      this.release(api);
    }
  }

  /**
   * Runs `fn` on a worker, waiting for one to free up if they are all busy.
   */
  /**
   * Runs `fn` on a worker, waiting for one to free up if they are all busy.
   *
   * A `signal` aborted before the task reaches a worker drops it outright:
   * it never starts, and nothing is spent on it. Once it has started there
   * is nothing to cancel — a WebAssembly call runs to completion — so the
   * signal is ignored from then on and the caller discards the result. That
   * distinction is the whole point: cancelling thirty of forty files used to
   * cost the full batch, because every one of those thirty still took a
   * worker and ran to the end before its answer was thrown away.
   */
  run<R>(fn: (api: Comlink.Remote<Api>) => Promise<R>, signal?: AbortSignal): Promise<R> {
    if (this.terminated) return Promise.reject(new PoolTerminatedError());
    if (signal?.aborted) return Promise.reject(new TaskAbandonedError());

    return new Promise<R>((resolve, reject) => {
      const task: Task<Api, R> = { run: fn, resolve, reject, signal };

      if (signal) {
        const abandon = () => {
          // Only while it is still waiting. A dispatched task owns a worker
          // and must be left to finish or the pool leaks the slot.
          const queued = this.waiting.indexOf(task);
          if (queued === -1) return;
          this.waiting.splice(queued, 1);
          reject(new TaskAbandonedError());
        };
        signal.addEventListener('abort', abandon, { once: true });
      }

      this.place(task);
    });
  }

  /**
   * Stops every worker and rejects everything outstanding.
   *
   * Tasks already dispatched matter most: a Comlink call into a terminated
   * worker never answers, so without rejecting them here a cancel or an
   * unmount would leave those jobs pending forever and their queue rows stuck
   * at "running" with no way out.
   */
  terminate(): void {
    this.terminated = true;
    const stopped = new PoolTerminatedError();
    for (const task of this.waiting.splice(0)) task.reject(stopped);
    for (const task of [...this.inFlight]) {
      this.inFlight.delete(task);
      task.reject(stopped);
    }
    for (const worker of this.workers.splice(0)) worker.terminate();
    this.idle.length = 0;
    this.owners.clear();
    this.assigned.clear();
    this.started = 0;
  }
}
