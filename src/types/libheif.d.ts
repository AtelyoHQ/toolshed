/**
 * libheif-js ships no types for its bundler entry point. Only the small part
 * of the decoder API Toolshed uses is declared here.
 */
declare module 'libheif-js/wasm-bundle' {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (result: { data: Uint8ClampedArray } | null) => void,
    ): void;
    free?(): void;
  }

  class HeifDecoder {
    decode(buffer: ArrayBuffer | Uint8Array): HeifImage[];
  }

  const libheif: { HeifDecoder: typeof HeifDecoder };
  export default libheif;
}
