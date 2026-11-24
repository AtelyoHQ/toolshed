import {
  extensionFor,
  isEncodable,
  mimeFor,
  sniffFormat,
  supportsAlpha,
  type EncodableFormat,
  type ImageFormat,
} from './format';
import {
  hasTrailingImages,
  orientationTransform,
  readDimensions,
  readOrientation,
  stripMetadata,
} from './metadata';
import {
  crop,
  flip,
  resize,
  rotate,
  type CropRect,
  type QuarterTurn,
  type ResizeTarget,
} from './ops';
import { flatten, hasTransparency, type RasterImage } from './raster';
import { encodeToTargetSize } from './target';

/**
 * Turns a dropped file into a finished one.
 *
 * The codecs are injected rather than imported, so the whole decision tree —
 * which is where the bugs live — is testable in Node without WebAssembly.
 */

export interface ImageSettings {
  /** `keep` writes the format it read, when that format can be written. */
  format: EncodableFormat | 'keep';
  quality: number;
  /** When set, quality is searched for instead of used directly. */
  targetBytes?: number;
  resize?: ResizeTarget;
  rotate?: QuarterTurn;
  flip?: 'horizontal' | 'vertical' | null;
  crop?: CropRect;
  /** On by default. Removes EXIF, GPS and timestamps. */
  stripMetadata?: boolean;
  /** Fill colour behind transparency when writing JPEG. */
  background?: [number, number, number];
  effort?: number;
  lossless?: boolean;
  /**
   * Hand back the original when the "compressed" file came out bigger.
   * An already-optimised JPEG re-encoded at quality 90 routinely grows, and
   * returning that as a success is how these tools lose people's trust.
   */
  neverGrow?: boolean;
  allowUpscale?: boolean;
}

export interface ImageCodecs {
  decode(bytes: Uint8Array, format: ImageFormat): Promise<RasterImage>;
  encode(
    image: RasterImage,
    format: EncodableFormat,
    options: { quality: number; effort?: number; lossless?: boolean },
  ): Promise<Uint8Array>;
}

export interface ImageJobResult {
  bytes: Uint8Array;
  format: EncodableFormat | ImageFormat;
  mime: string;
  extension: string;
  width: number;
  height: number;
  quality?: number;
  /** Set when the result is the input, unchanged. */
  unchanged?: boolean;
  note?: string;
}

export class UnreadableImageError extends Error {
  constructor() {
    super('This file is not an image Toolshed can read');
    this.name = 'UnreadableImageError';
  }
}

/** True when nothing about the pixels was asked to change. */
function isPixelPreserving(settings: ImageSettings, source: ImageFormat): boolean {
  return (
    (settings.format === 'keep' || settings.format === source) &&
    settings.targetBytes === undefined &&
    settings.resize === undefined &&
    settings.crop === undefined &&
    !settings.rotate &&
    !settings.flip
  );
}

export async function processImage(
  bytes: Uint8Array,
  settings: ImageSettings,
  codecs: ImageCodecs,
  onProgress?: (fraction: number) => void,
): Promise<ImageJobResult> {
  const source = sniffFormat(bytes);
  if (!source) throw new UnreadableImageError();
  onProgress?.(0.05);

  const orientation = readOrientation(bytes);
  const pixelPreserving = isPixelPreserving(settings, source);

  // "Keep my metadata and change nothing else" is a no-op. Re-encoding would
  // cost a generation of quality and lose the metadata anyway, since the
  // encoders do not carry it — the opposite of what was asked for.
  if (pixelPreserving && settings.stripMetadata === false) {
    onProgress?.(1);
    const size = readDimensions(bytes);
    return {
      bytes,
      format: source,
      mime: mimeFor(source),
      extension: extensionFor(source),
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      unchanged: true,
      note: 'Nothing to do: metadata was kept and no change to the image was requested.',
    };
  }

  // Stripping metadata alone needs no decode and no re-encode, so the pixels
  // come out bit-for-bit identical. Decoding here would be a generation of
  // quality loss in exchange for nothing.
  //
  // Two cases must not take it. A photo with an orientation tag needs its
  // pixels rotated before the tag goes, or it comes out sideways — which is
  // most phone photos, and exactly the files this feature exists for. And a
  // multi-picture file hides whole extra images, with their own GPS, after
  // the primary one; a marker walk never sees them, so the honest answer
  // there is to re-encode and drop them.
  if (pixelPreserving && orientation === 1 && !hasTrailingImages(bytes)) {
    const stripped = stripMetadata(bytes);
    if (stripped !== bytes) {
      onProgress?.(1);
      const size = readDimensions(bytes);
      return {
        bytes: stripped,
        format: source,
        mime: mimeFor(source),
        extension: extensionFor(source),
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        note: 'Metadata removed without re-encoding the image.',
      };
    }
  }

  let image = await codecs.decode(bytes, source);
  onProgress?.(0.35);

  // Orientation first: the EXIF tag is about to be discarded, and applying it
  // after a crop or resize would apply it to the wrong axes.
  if (orientation !== 1) {
    const transform = orientationTransform(orientation);
    if (transform.rotate !== 0) image = rotate(image, transform.rotate);
    if (transform.flip) image = flip(image, transform.flip);
  }

  if (settings.crop) image = crop(image, settings.crop);
  if (settings.rotate) image = rotate(image, settings.rotate);
  if (settings.flip) image = flip(image, settings.flip);
  if (settings.resize) image = resize(image, settings.resize, settings.allowUpscale ?? false);
  onProgress?.(0.5);

  const target: EncodableFormat =
    settings.format === 'keep' ? (isEncodable(source) ? source : 'jpeg') : settings.format;

  if (!supportsAlpha(target) && hasTransparency(image)) {
    image = flatten(image, settings.background ?? [255, 255, 255]);
  }

  const encodeOptions = {
    effort: settings.effort,
    lossless: settings.lossless,
  };

  let output: Uint8Array;
  let quality = settings.quality;
  // The dimensions actually encoded, which a target-size search may shrink.
  let encodedWidth = image.width;
  let encodedHeight = image.height;
  let scaleNote: string | undefined;

  if (settings.targetBytes !== undefined) {
    const result = await encodeToTargetSize(
      image,
      (candidate, q) => codecs.encode(candidate, target, { ...encodeOptions, quality: q }),
      {
        targetBytes: settings.targetBytes,
        onProgress: (fraction) => onProgress?.(0.5 + fraction * 0.45),
      },
    );
    output = result.bytes;
    quality = result.quality;
    if (result.scale < 1) {
      // Resolution is the most visible thing this engine can take away, and
      // it was taken to meet a budget the person set. Reporting the original
      // dimensions here would be telling them it did not happen.
      encodedWidth = Math.max(1, Math.round(image.width * result.scale));
      encodedHeight = Math.max(1, Math.round(image.height * result.scale));
      scaleNote = `Resized to ${encodedWidth}x${encodedHeight} to fit the target size.`;
    }
    if (!result.withinBudget) {
      onProgress?.(1);
      return {
        bytes: output,
        format: target,
        mime: mimeFor(target),
        extension: extensionFor(target),
        width: encodedWidth,
        height: encodedHeight,
        quality,
        note: `Could not reach the target size; this is the smallest it would go.${
          scaleNote ? ` ${scaleNote}` : ''
        }`,
      };
    }
  } else {
    output = await codecs.encode(image, target, { ...encodeOptions, quality });
  }
  onProgress?.(0.95);

  // Only meaningful when the format did not change: a bigger PNG that the
  // person explicitly asked for is not a failure.
  if ((settings.neverGrow ?? true) && target === source && output.byteLength >= bytes.byteLength) {
    const stripped = settings.stripMetadata === false ? bytes : stripMetadata(bytes);
    onProgress?.(1);
    return {
      bytes: stripped,
      format: source,
      mime: mimeFor(source),
      extension: extensionFor(source),
      width: image.width,
      height: image.height,
      unchanged: true,
      note:
        stripped.byteLength < bytes.byteLength
          ? 'Already well compressed; kept the original pixels and removed the metadata.'
          : 'Already well compressed; re-encoding would have made it larger, so it was left alone.',
    };
  }

  onProgress?.(1);
  return {
    bytes: output,
    format: target,
    mime: mimeFor(target),
    extension: extensionFor(target),
    width: encodedWidth,
    height: encodedHeight,
    quality,
    ...(scaleNote ? { note: scaleNote } : {}),
  };
}
