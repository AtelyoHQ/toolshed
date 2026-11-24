import { compressPdf, type CompressOptions } from './compress';
import {
  imagesToPdf,
  pdfToImages,
  pdfToText,
  type ImageInput,
  type ImagesToPdfOptions,
  type PdfToImagesOptions,
  type PdfToTextOptions,
} from './convert';
import type { LoadOptions } from './document';
import {
  removePassword,
  setPassword,
  type RemovePasswordOptions,
  type SetPasswordOptions,
} from './encrypt';
import type { JpegCodec } from './jpegStreams';
import {
  deletePages,
  extractPages,
  mergeDocuments,
  reorderPages,
  rotatePages,
  splitDocument,
  type RotateOptions,
  type SplitMode,
} from './pages';
import type { PdfRasterizer, PdfTextReader } from './render';
import { numberPages, watermarkPdf, type PageNumberOptions, type WatermarkOptions } from './stamp';
import type { PdfResult, PdfSource } from './types';

/**
 * One entry point for every PDF operation.
 *
 * The worker exposes this single function rather than fourteen, so the message
 * surface between the main thread and the worker is one tagged union that
 * TypeScript checks on both sides. Dependencies are passed in, which is also
 * what lets the whole dispatcher be tested in Node with a fake renderer.
 */

export type PdfJob =
  | { op: 'merge'; sources: readonly PdfSource[] }
  | { op: 'split'; bytes: Uint8Array; options: SplitMode & LoadOptions }
  | { op: 'reorder'; bytes: Uint8Array; order: readonly number[]; options?: LoadOptions }
  | { op: 'rotate'; bytes: Uint8Array; options: RotateOptions }
  | { op: 'delete'; bytes: Uint8Array; pages: readonly number[]; options?: LoadOptions }
  | { op: 'extract'; bytes: Uint8Array; pages: readonly number[]; options?: LoadOptions }
  | { op: 'images-to-pdf'; images: readonly ImageInput[]; options: ImagesToPdfOptions }
  | { op: 'pdf-to-images'; bytes: Uint8Array; options: PdfToImagesOptions }
  | { op: 'pdf-to-text'; bytes: Uint8Array; options: PdfToTextOptions }
  | { op: 'compress'; bytes: Uint8Array; options: CompressOptions }
  | { op: 'set-password'; bytes: Uint8Array; options: SetPasswordOptions }
  | { op: 'remove-password'; bytes: Uint8Array; options: RemovePasswordOptions }
  | { op: 'watermark'; bytes: Uint8Array; options: WatermarkOptions }
  | { op: 'page-numbers'; bytes: Uint8Array; options: PageNumberOptions };

export interface PdfOutput {
  bytes: Uint8Array;
  mime: string;
  /** Distinguishes several outputs from one job: `3`, `4-7`, `page-2`. */
  label?: string;
  pages?: number;
  /** Pixels, for a rendered image. */
  width?: number;
  height?: number;
}

export interface PdfJobResult {
  outputs: PdfOutput[];
  note?: string;
  /** Set when the single output is the input, unchanged. */
  unchanged?: boolean;
}

export interface PdfJobDeps {
  jpeg: JpegCodec;
  rasterizer: PdfRasterizer;
  textReader: PdfTextReader;
}

export const PDF_MIME = 'application/pdf';

export async function runPdfJob(
  job: PdfJob,
  deps: PdfJobDeps,
  onProgress?: (fraction: number) => void,
): Promise<PdfJobResult> {
  switch (job.op) {
    case 'merge':
      return single(await mergeDocuments(job.sources));

    case 'split': {
      const parts = await splitDocument(job.bytes, job.options);
      return {
        outputs: parts.map((part) => ({
          bytes: part.bytes,
          mime: PDF_MIME,
          label: part.label,
          pages: part.pages,
        })),
        // The first part's note as well: when the source was locked, every part
        // is not, and that is the one thing a person sending them on needs told.
        note: [
          parts.find((part) => part.note)?.note,
          `Split into ${parts.length} ${parts.length === 1 ? 'document' : 'documents'}.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    case 'reorder':
      return single(await reorderPages(job.bytes, job.order, job.options));
    case 'rotate':
      return single(await rotatePages(job.bytes, job.options));
    case 'delete':
      return single(await deletePages(job.bytes, job.pages, job.options));
    case 'extract':
      return single(await extractPages(job.bytes, job.pages, job.options));
    case 'images-to-pdf':
      return single(await imagesToPdf(job.images, job.options));

    case 'pdf-to-images': {
      const rendered = await pdfToImages(job.bytes, job.options, deps.rasterizer, onProgress);
      return {
        outputs: rendered.map((image) => ({
          bytes: image.bytes,
          mime: image.mime,
          label: `page-${image.page}`,
          width: image.width,
          height: image.height,
        })),
        note: `Rendered ${rendered.length} page${rendered.length === 1 ? '' : 's'} at ${job.options.dpi} dpi.`,
      };
    }

    case 'pdf-to-text': {
      const result = await pdfToText(job.bytes, job.options, deps.textReader);
      return {
        outputs: [
          {
            bytes: new TextEncoder().encode(result.text),
            mime: 'text/plain',
            pages: result.pages,
          },
        ],
        note: result.note,
      };
    }

    case 'compress':
      return single(await compressPdf(job.bytes, job.options, deps, onProgress));
    case 'set-password':
      return single(await setPassword(job.bytes, job.options));
    case 'remove-password':
      return single(await removePassword(job.bytes, job.options));
    case 'watermark':
      return single(await watermarkPdf(job.bytes, job.options));
    case 'page-numbers':
      return single(await numberPages(job.bytes, job.options));
  }
}

function single(result: PdfResult): PdfJobResult {
  return {
    outputs: [{ bytes: result.bytes, mime: PDF_MIME, pages: result.pages }],
    ...(result.note ? { note: result.note } : {}),
    ...(result.unchanged ? { unchanged: true } : {}),
  };
}
