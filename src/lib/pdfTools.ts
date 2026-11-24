import type { PdfJob, PdfJobResult } from './pdf/jobs';
import type { PageSelection } from './pdf/request';
import type { Tool } from './tools';
import {
  withExtension,
  withSuffix,
  type JobOutput,
  type QueueItem,
  type ToolSettings,
} from './types';

/**
 * Turns a PDF tool's declared settings into what the PDF worker takes, and
 * what it hands back into what the queue holds.
 *
 * The registry stores flat primitives so a generic panel can render them; the
 * engine takes tagged jobs. This is the one place that knows about both, as
 * `toImageSettings` is for the image engine. It imports the engine's types and
 * nothing else: anything it pulled in at runtime would land in the entry
 * bundle, and the PDF libraries must stay behind the worker.
 */

export interface PdfInput {
  /** The source file's id, which a merge uses to keep its passwords apart. */
  id: string;
  name: string;
  bytes: Uint8Array;
  /** What the person typed to open this file, if it needed one. */
  password?: string;
}

export interface PdfRequest {
  job: PdfJob;
  selection?: PageSelection;
}

/** A failure the person can fix by changing what they typed, not by changing the file. */
export class PdfSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfSettingsError';
  }
}

/**
 * Where the password that opens a source lives in a row's settings.
 *
 * One file has one password, under one key. A merge row holds several files
 * and keeps one per file, keyed by the file's id.
 */
export function openPasswordKey(sourceId?: string): string {
  return sourceId === undefined ? 'openPassword' : `openPassword:${sourceId}`;
}

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };

/**
 * 300 dpi is what a scanner writes and what print assumes, so a scan lands on
 * a sheet its own size. At the engine's default of 72 an ordinary 4000-pixel
 * phone photograph becomes a page 55 inches wide.
 */
const IMAGE_PAGE_DPI = 300;

export function toPdfRequest(
  tool: Tool,
  settings: ToolSettings,
  inputs: readonly PdfInput[],
): PdfRequest {
  const first = inputs[0];
  if (!first) throw new PdfSettingsError('There is nothing to work on.');
  const load = { password: first.password };
  const text = (key: string) => String(settings[key] ?? '');
  const number = (key: string) => Number(settings[key]);

  // Blank means every page for the tools that can take that. Resolving it
  // here saves the worker a second parse of the document to learn what the
  // answer is; the tools that cannot (delete, extract) pass the blank on and
  // are refused for it, which is the point.
  const optionalPages = (): PageSelection | undefined =>
    text('pages').trim() === '' ? undefined : { kind: 'pages', text: text('pages') };
  const requiredPages = (): PageSelection => ({ kind: 'pages', text: text('pages') });

  switch (tool.id) {
    case 'pdf-compress': {
      const strategy = text('strategy');
      if (strategy !== 'images' && strategy !== 'rasterize') {
        throw new PdfSettingsError('Choose how to compress this PDF.');
      }
      return {
        job: {
          op: 'compress',
          bytes: first.bytes,
          options: {
            strategy,
            quality: number('quality'),
            // Only the strategy that draws pages has a resolution. Sending one
            // to the other would be harmless today and a trap for whoever
            // makes it read the field.
            ...(strategy === 'rasterize' ? { dpi: number('dpi') } : {}),
            ...load,
          },
        },
      };
    }

    case 'pdf-merge': {
      if (inputs.length < 2) throw new PdfSettingsError('Add at least two PDFs to merge.');
      return {
        job: {
          op: 'merge',
          sources: inputs.map((input) => ({
            bytes: input.bytes,
            password: input.password,
            name: input.name,
          })),
        },
      };
    }

    case 'images-to-pdf': {
      const sizing = text('sizing');
      return {
        job: {
          op: 'images-to-pdf',
          images: inputs.map((input) => ({ bytes: input.bytes, name: input.name })),
          options: {
            sizing:
              sizing === 'image'
                ? { mode: 'image' }
                : { mode: 'fixed', ...(sizing === 'letter' ? LETTER : A4), fit: 'contain' },
            margin: number('margin'),
            dpi: IMAGE_PAGE_DPI,
          },
        },
      };
    }

    case 'pdf-split': {
      const mode = text('mode');
      if (mode === 'every') {
        return {
          job: { op: 'split', bytes: first.bytes, options: { mode: 'pages', ...load } },
          selection: { kind: 'every', count: number('every') },
        };
      }
      if (mode === 'after') {
        return {
          job: {
            op: 'split',
            bytes: first.bytes,
            options: { mode: 'after', points: parsePoints(text('points')), ...load },
          },
        };
      }
      return { job: { op: 'split', bytes: first.bytes, options: { mode: 'pages', ...load } } };
    }

    case 'pdf-extract':
      return {
        job: { op: 'extract', bytes: first.bytes, pages: [], options: load },
        selection: requiredPages(),
      };

    case 'pdf-delete':
      return {
        job: { op: 'delete', bytes: first.bytes, pages: [], options: load },
        selection: requiredPages(),
      };

    case 'pdf-rotate': {
      const turn = number('turn');
      if (![90, 180, 270].includes(turn)) throw new PdfSettingsError('Choose how far to turn.');
      const selection = optionalPages();
      return {
        job: { op: 'rotate', bytes: first.bytes, options: { turn, ...load } },
        ...(selection ? { selection } : {}),
      };
    }

    case 'pdf-reorder':
      return {
        job: { op: 'reorder', bytes: first.bytes, order: [], options: load },
        selection:
          text('mode') === 'reverse' ? { kind: 'reverse' } : { kind: 'order', text: text('order') },
      };

    case 'pdf-watermark': {
      const selection = optionalPages();
      return {
        job: {
          op: 'watermark',
          bytes: first.bytes,
          options: {
            text: text('text'),
            opacity: number('opacity') / 100,
            rotation: number('rotation'),
            placement: text('placement') as PlacementOf<'watermark'>,
            ...load,
          },
        },
        ...(selection ? { selection } : {}),
      };
    }

    case 'pdf-page-numbers': {
      // A cleared field is not a request to start at zero, which is what
      // `Number('')` would make of it.
      if (text('startAt').trim() === '' || number('startAt') < 0) {
        throw new PdfSettingsError('Give the number the first page should show, 0 or more.');
      }
      // The engine keeps an empty template rather than defaulting it, and
      // stamps an empty string on every page: a Done row and a file with no
      // numbers in it.
      if (text('template').trim() === '') {
        throw new PdfSettingsError('Give the format the numbers should use, such as {page}.');
      }
      const selection = optionalPages();
      return {
        job: {
          op: 'page-numbers',
          bytes: first.bytes,
          options: {
            placement: text('placement') as PlacementOf<'page-numbers'>,
            startAt: number('startAt'),
            template: text('template'),
            ...load,
          },
        },
        ...(selection ? { selection } : {}),
      };
    }

    case 'pdf-set-password': {
      const password = text('userPassword');
      if (password === '') throw new PdfSettingsError('Type the password to lock this PDF with.');
      // Checked because the alternative is unrecoverable: a mistyped password
      // is encrypted into the file, and nothing afterwards can open it.
      if (password !== text('confirmPassword')) {
        throw new PdfSettingsError('The two passwords are different. Nothing was locked.');
      }
      return {
        job: {
          op: 'set-password',
          bytes: first.bytes,
          options: { userPassword: password, ...load },
        },
      };
    }

    case 'pdf-remove-password':
      return {
        job: {
          op: 'remove-password',
          bytes: first.bytes,
          options: { password: first.password ?? '' },
        },
      };

    case 'pdf-to-images': {
      const format = text('format');
      if (format !== 'png' && format !== 'jpeg' && format !== 'webp') {
        throw new PdfSettingsError('Choose an image format.');
      }
      const selection = optionalPages();
      return {
        job: {
          op: 'pdf-to-images',
          bytes: first.bytes,
          options: { dpi: number('dpi'), format, quality: number('quality'), ...load },
        },
        ...(selection ? { selection } : {}),
      };
    }

    case 'pdf-to-text': {
      const selection = optionalPages();
      return {
        job: { op: 'pdf-to-text', bytes: first.bytes, options: load },
        ...(selection ? { selection } : {}),
      };
    }

    default:
      throw new PdfSettingsError(`${tool.label} is not a PDF tool.`);
  }
}

type PlacementOf<Op extends 'watermark' | 'page-numbers'> = NonNullable<
  Extract<PdfJob, { op: Op }>['options']['placement']
>;

/** `3, 7 12` as page numbers. Anything else is named rather than skipped. */
function parsePoints(spec: string): number[] {
  const terms = spec.split(/[,\s]+/).filter((term) => term !== '');
  if (terms.length === 0) {
    throw new PdfSettingsError('Name the pages to split after, such as 3, 7.');
  }
  return terms.map((term) => {
    if (!/^\d+$/.test(term)) {
      throw new PdfSettingsError(`"${term}" is not a page number. Use something like 3, 7.`);
    }
    return Number(term);
  });
}

/** What each tool's result is called, beside the file it came from. */
const SUFFIX: Record<string, string> = {
  'pdf-compress': '-compressed',
  'pdf-split': '-split',
  'pdf-extract': '-extract',
  'pdf-delete': '-edited',
  'pdf-rotate': '-rotated',
  'pdf-reorder': '-reordered',
  'pdf-watermark': '-watermarked',
  'pdf-page-numbers': '-numbered',
  'pdf-set-password': '-locked',
  'pdf-remove-password': '-unlocked',
};

const EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'text/plain': 'txt',
};

/**
 * The queue's view of what the worker returned.
 *
 * Every output is named from the source and a label that tells them apart,
 * because the zip a split goes into is flat and `report-3.pdf` beside
 * `report-4-7.pdf` is the only thing that says what each part is. The first
 * output is the row's own and the rest are its siblings.
 */
export function toJobOutput(tool: Tool, sourceName: string, result: PdfJobResult): JobOutput {
  const [head, ...rest] = result.outputs.map((output) => ({
    bytes: output.bytes,
    mime: output.mime,
    name: nameOf(tool, sourceName, output.mime, output.label, result.outputs.length),
    ...(output.pages !== undefined ? { pages: output.pages } : {}),
    ...(output.width !== undefined ? { width: output.width } : {}),
    ...(output.height !== undefined ? { height: output.height } : {}),
  }));
  if (!head) throw new PdfSettingsError('The PDF engine returned nothing.');

  // A document with no text layer comes back as a file of newlines. A row that
  // says Done and offers Save for it sends the person to open an empty file to
  // find out; the engine's own note says why, so that becomes the failure.
  if (tool.id === 'pdf-to-text' && new TextDecoder().decode(head.bytes).trim() === '') {
    throw new PdfSettingsError(result.note ?? 'No text was found in this PDF.');
  }

  return {
    ...head,
    ...(rest.length > 0
      ? { siblings: rest.map(({ bytes, name, mime }) => ({ bytes, name, mime })) }
      : {}),
    ...(result.note ? { note: result.note } : {}),
  };
}

function nameOf(
  tool: Tool,
  sourceName: string,
  mime: string,
  label: string | undefined,
  count: number,
): string {
  const extension = EXTENSION[mime] ?? 'bin';
  if (label !== undefined && count > 1) {
    // `3` and `4-7` are page spans from a split; `page-3` is already a name.
    const part = label.startsWith('page-')
      ? label
      : label.includes('-')
        ? `pages-${label}`
        : `page-${label}`;
    return withExtension(withSuffix(sourceName, `-${part}`), extension);
  }
  return withExtension(withSuffix(sourceName, SUFFIX[tool.id] ?? ''), extension);
}

/**
 * Whether a failure is the PDF asking for a password, and which kind of ask.
 *
 * By class name, because that is all that survives the trip back from the
 * worker: Comlink rebuilds an error from its message and name, so
 * `instanceof` is false on this side.
 */
export function passwordProblem(error: unknown): QueueItem['needsPassword'] {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordRequiredError') return 'missing';
  if (name === 'WrongPasswordError') return 'wrong';
  return undefined;
}
