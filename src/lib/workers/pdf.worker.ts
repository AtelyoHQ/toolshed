import * as Comlink from 'comlink';
import { decodeImage, encodeImage } from '../image/codecs';
import type { JpegCodec } from '../pdf/jpegStreams';
import type { PdfJob, PdfJobResult } from '../pdf/jobs';
import { runPdfRequest, type PageSelection } from '../pdf/request';
import { pdfjsRasterizer, pdfjsTextReader } from '../pdf/pdfjs';
import { installNetGuard } from '../netguard';

// A worker does not inherit the window's patched globals, and this is where
// the file data actually is, so the guard is installed here too. It matters
// more in this worker than in the image one: pdf.js is the only dependency in
// the project that would otherwise resolve part of itself from a URL at
// runtime. See src/lib/pdf/pdfjsAssets.ts and PRIVACY.md.
installNetGuard({ block: import.meta.env.PROD });

/**
 * The PDF engine's own JPEG codec, which is the image engine's.
 *
 * Compression re-encodes the photographs inside a document, and mozjpeg is
 * already here for images. Sharing it means one copy of the encoder in the
 * bundle and the same quality scale in both tools.
 */
const jpeg: JpegCodec = {
  decode: (bytes) => decodeImage(bytes, 'jpeg'),
  // Baseline, not mozjpeg's default progressive: see EncodeOptions.progressive.
  // A PDF's DCTDecode filter is defined over baseline JPEG, and this engine
  // would rather give up a few per cent than write a stream a print workflow
  // is entitled to refuse.
  encode: (image, quality) => encodeImage(image, 'jpeg', { quality, progressive: false }),
};

export interface PdfWorkerApi {
  run(
    job: PdfJob,
    onProgress: (fraction: number) => void,
    selection?: PageSelection,
  ): Promise<PdfJobResult>;
}

const api: PdfWorkerApi = {
  async run(job, onProgress, selection) {
    const result = await runPdfRequest(
      job,
      selection,
      { jpeg, rasterizer: pdfjsRasterizer, textReader: pdfjsTextReader },
      (fraction) => {
        // Comlink proxies the callback; failures reporting progress must not
        // take down the job itself.
        void Promise.resolve(onProgress(fraction)).catch(() => undefined);
      },
    );

    // Hand the results over rather than copying them: splitting a 200 MB
    // document produces 200 MB of outputs, and structured-cloning them back
    // would double that for no reason. De-duplicated because an operation
    // that changed nothing returns the bytes it was given, which may be the
    // buffer behind more than one output.
    const buffers = [...new Set(result.outputs.map((output) => output.bytes.buffer))];
    return Comlink.transfer(result, buffers as ArrayBuffer[]);
  },
};

Comlink.expose(api);
