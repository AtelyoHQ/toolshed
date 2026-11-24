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
  type Orientation,
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
  /**
   * The caller is asking for a re-encode, not merely a clean-up.
   *
   * Quality alone cannot say this. "Keep the format, quality 75, strip the
   * metadata" is indistinguishable from "just strip the metadata" by
   * inspection, and the fast path below would take the second reading — so
   * Compress would hand back the input unchanged for every photo that
   * carries EXIF, which is every photo from a phone.
   */
  recompress?: boolean;
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

/**
 * Whether handing back the input bytes is an honest answer.
 *
 * There are two places that want to return the original — the fast path that
 * skips decoding, and the guard that refuses to ship a bigger file — and
 * both have to apply the same conditions. Keeping them in one function is
 * what stops the next one being written with a condition missing.
 */
function canReturnOriginal(
  bytes: Uint8Array,
  settings: ImageSettings,
  orientation: Orientation,
): boolean {
  // An orientation tag still in the file means the pixels are not upright.
  // Returning them with the tag stripped leaves a portrait photo on its side.
  if (orientation !== 1) return false;

  // A multi-picture file hides whole extra images, each with its own EXIF and
  // GPS, after the primary one. The in-place strip walks only the primary
  // image's markers, so the location survives in the hidden copy — and the
  // note would tell the person it had been removed.
  if (settings.stripMetadata !== false && hasTrailingImages(bytes)) return false;

  return true;
}

/** True when nothing about the pixels was asked to change. */
function isPixelPreserving(settings: ImageSettings, source: ImageFormat): boolean {
  if (settings.recompress) return false;
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
  if (pixelPreserving && canReturnOriginal(bytes, settings, orientation)) {
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

  // Snapshot before any geometry, so the guard below can ask what actually
  // happened to the pixels rather than what was requested.
  const sourceWidth = image.width;
  const sourceHeight = image.height;

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

  /**
   * Whether the pixels in this file are genuinely different from the ones
   * that came in. Asked of the work that happened, not of the settings that
   * were requested — the two are not the same thing:
   *
   * - Resize always sets `resize`, but never upscales, so for an image
   *   already under the chosen edge nothing moved. Treating that as a
   *   geometry change meant Resize shipped a bigger, re-encoded file for
   *   every small image, with nothing on screen to explain it.
   * - An EXIF orientation that has been baked into the pixels is a real
   *   change even though no setting asked for it. Handing back the original
   *   bytes there returns an unrotated photo with its orientation tag
   *   deleted, which is a portrait phone photo permanently on its side.
   *
   * Rotate and flip are unconditional because a 180 degree turn and a mirror
   * both keep the dimensions.
   */
  const pixelsMoved =
    Boolean(settings.rotate) ||
    Boolean(settings.flip) ||
    image.width !== sourceWidth ||
    image.height !== sourceHeight;

  // Only meaningful when the format did not change: a bigger PNG that the
  // person explicitly asked for is not a failure.
  if (
    (settings.neverGrow ?? true) &&
    !pixelsMoved &&
    canReturnOriginal(bytes, settings, orientation) &&
    target === source &&
    output.byteLength >= bytes.byteLength
  ) {
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
