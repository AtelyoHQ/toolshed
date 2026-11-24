import * as Comlink from 'comlink';
import type { PdfJob, PdfJobResult } from '../pdf/jobs';
import type { PdfWorkerApi } from './pdf.worker';
import { defaultPoolSize, WorkerPool } from './pool';

/**
 * The PDF engine, off the main thread.
 *
 * Separate from the image pool on purpose. A PDF worker holds pdf.js and its
 * own nested worker, several megabytes that someone who only came to rotate a
 * JPEG should never pay for; keeping the two apart means each is started by
 * the first file that actually needs it.
 */
let pool: WorkerPool<PdfWorkerApi> | null = null;

function pdfPool(): WorkerPool<PdfWorkerApi> {
  pool ??= new WorkerPool<PdfWorkerApi>(
    () => new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' }),
    // Two at most, where the image pool goes up to four. Each of these holds
    // pdf.js twice over — its own copy plus the nested worker's — and a
    // rasterising job keeps a page of decoded pixels in flight, so a batch of
    // large documents runs the tab out of memory long before it runs out of
    // cores. Batches of PDFs are also rarer than batches of photos. The
    // smaller of the two numbers, because on a two-core machine the pool
    // default is already 1 and this ceiling must not raise it.
    { size: Math.min(2, defaultPoolSize()) },
  );
  return pool;
}

/**
 * Runs one PDF operation in a worker.
 *
 * **The bytes in `job` are transferred, not copied.** That avoids a second
 * full-size copy of what can be a 200 MB document, but it detaches the
 * arrays: after this call their `byteLength` is 0. Take any measurements
 * first, or pass a copy — the same contract as `processImageInWorker`.
 *
 * A `signal` aborted before a worker picks the job up drops it without
 * spending anything on it. Once it has started there is nothing to stop: a
 * WebAssembly call and a page render both run to completion. That matters
 * more here than for an image — cancelling a queue of thirty documents is
 * cancelling minutes of work, not seconds.
 */
export function runPdfJobInWorker(
  job: PdfJob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PdfJobResult> {
  const buffers = [...new Set(inputBuffers(job))];
  return pdfPool().run(
    (worker) => worker.run(Comlink.transfer(job, buffers), Comlink.proxy(onProgress ?? (() => {}))),
    signal,
  );
}

/** Every buffer a job carries in, whatever shape that job has. */
function inputBuffers(job: PdfJob): ArrayBuffer[] {
  if (job.op === 'merge') return job.sources.map((source) => source.bytes.buffer as ArrayBuffer);
  if (job.op === 'images-to-pdf')
    return job.images.map((image) => image.bytes.buffer as ArrayBuffer);
  return [job.bytes.buffer as ArrayBuffer];
}

/** Stops the workers. Call when the application is torn down. */
export function shutdownPdfWorkers(): void {
  pool?.terminate();
  pool = null;
}
