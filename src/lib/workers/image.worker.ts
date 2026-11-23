import * as Comlink from 'comlink';
import { decodeImage, encodeImage } from '../image/codecs';
import { processImage, type ImageJobResult, type ImageSettings } from '../image/pipeline';
import { installNetGuard } from '../netguard';

// A worker does not inherit the window's patched globals, and this is where
// the file data actually is, so the guard is installed here too. On a host
// that cannot send response headers this is the only egress check a worker
// has; see PRIVACY.md.
installNetGuard({ block: import.meta.env.PROD });

export interface ImageWorkerApi {
  process(
    bytes: Uint8Array,
    settings: ImageSettings,
    onProgress: (fraction: number) => void,
  ): Promise<ImageJobResult>;
}

const api: ImageWorkerApi = {
  async process(bytes, settings, onProgress) {
    const result = await processImage(
      bytes,
      settings,
      { decode: decodeImage, encode: encodeImage },
      (fraction) => {
        // Comlink proxies the callback; failures reporting progress must not
        // take down the job itself.
        void Promise.resolve(onProgress(fraction)).catch(() => undefined);
      },
    );

    // Hand the pixels over rather than copying them: a 50 MP photo is 200 MB
    // of RGBA and structured-cloning it would double that for no reason.
    return Comlink.transfer(result, [result.bytes.buffer as ArrayBuffer]);
  },
};

Comlink.expose(api);
