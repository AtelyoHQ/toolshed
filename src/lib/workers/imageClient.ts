import * as Comlink from 'comlink';
import type { ImageJobResult, ImageSettings } from '../image/pipeline';
import type { ImageWorkerApi } from './image.worker';
import { WorkerPool } from './pool';

/**
 * The image engine, off the main thread.
 *
 * One pool for the whole application: every tool that touches an image goes
 * through it, so a batch cannot spawn a second set of workers each holding
 * their own copies of the codecs.
 */
let pool: WorkerPool<ImageWorkerApi> | null = null;

function imagePool(): WorkerPool<ImageWorkerApi> {
  pool ??= new WorkerPool<ImageWorkerApi>(
    () => new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' }),
  );
  return pool;
}

export function processImageInWorker(
  bytes: Uint8Array,
  settings: ImageSettings,
  onProgress?: (fraction: number) => void,
): Promise<ImageJobResult> {
  return imagePool().run((worker) =>
    worker.process(
      // Transferred, not copied: the caller must not use these bytes again.
      Comlink.transfer(bytes, [bytes.buffer as ArrayBuffer]),
      settings,
      Comlink.proxy(onProgress ?? (() => {})),
    ),
  );
}

/** Stops the workers. Call when the application is torn down. */
export function shutdownImageWorkers(): void {
  pool?.terminate();
  pool = null;
}
