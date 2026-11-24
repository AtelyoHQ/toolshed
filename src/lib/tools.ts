import type { EncodableFormat } from './image/format';
import type { ImageSettings } from './image/pipeline';
import type { QuarterTurn } from './image/ops';
import type { FileKind, ToolSettings } from './types';

/**
 * The tool catalogue.
 *
 * Settings are declared as data rather than written as bespoke panels, so a
 * new tool is one entry here plus an engine function. It also means every
 * control gets the same label, keyboard handling and aria wiring for free,
 * which is where hand-built panels usually fall down.
 */

export type ToolGroup = 'image' | 'pdf' | 'convert';

interface FieldBase {
  key: string;
  label: string;
  hint?: string;
  /**
   * Show this control only while another one has one of these values.
   *
   * Without it a tool with two modes lists every control for both, and the
   * ones that do nothing in the chosen mode look like they are being ignored.
   * The value stays in the settings either way; only the control is hidden.
   */
  showWhen?: { key: string; oneOf: string[] };
}

export type SettingField = FieldBase &
  (
    | { type: 'range'; min: number; max: number; step?: number }
    | { type: 'toggle' }
    | { type: 'size' }
    | { type: 'select'; options: Array<{ value: string; label: string }> }
    | {
        type: 'text';
        placeholder?: string;
        /** A password: masked, never offered for autofill, never echoed in a hint. */
        secret?: boolean;
      }
    | { type: 'number'; min: number; max: number }
  );

/** Which worker a tool's jobs go to. */
export type Engine = 'image' | 'pdf';

export interface Tool {
  id: string;
  label: string;
  group: ToolGroup;
  engine: Engine;
  /**
   * This tool's job is to re-encode. Without it the engine cannot tell
   * "compress at quality 75 and strip metadata" from "just strip metadata",
   * and takes the cheaper reading.
   */
  recompress?: boolean;
  /** One line, shown under the name. Say what it does, not how clever it is. */
  summary: string;
  /**
   * A standing fact about this tool that no control can express. Shown in
   * the settings panel.
   */
  note?: string;
  accepts: FileKind;
  defaults: ToolSettings;
  fields: SettingField[];
  /**
   * The tool takes every file given to it as one input and makes one output,
   * which the one-row-per-file queue cannot express. Such a tool owns a single
   * row that lists its files; see `QueueItem.parts`.
   */
  combines?: {
    /** The button that gathers rows already in the queue, e.g. "Merge into one PDF". */
    action: string;
    /** What the single result is called. */
    outputName: string;
    /** Fewest waiting rows worth offering the action for. */
    min: number;
  };
  /**
   * The size of the result is not the point of this tool. Shown as a delta
   * against the original, "-99.9%" for a PDF turned into text reads as a
   * compression claim, and the number on screen is the one thing this
   * application must not get wrong.
   */
  hideDelta?: boolean;
  /** Tools that are declared but whose engine has not landed yet. */
  unavailable?: string;
}

const QUALITY: SettingField = {
  key: 'quality',
  label: 'Quality',
  type: 'range',
  min: 20,
  max: 95,
  hint: 'Higher keeps more detail and makes a bigger file.',
};

function formatField(label = 'Convert to'): SettingField {
  return {
    key: 'format',
    label,
    type: 'select',
    options: [
      { value: 'keep', label: 'Keep original' },
      { value: 'jpeg', label: 'JPEG' },
      { value: 'png', label: 'PNG' },
      { value: 'webp', label: 'WebP' },
      { value: 'avif', label: 'AVIF' },
    ],
  };
}

export const TOOLS: Tool[] = [
  {
    id: 'image-compress',
    engine: 'image',
    recompress: true,
    label: 'Compress',
    group: 'image',
    summary: 'Make an image smaller at a quality you choose.',
    note: 'Re-encoding always removes EXIF and GPS: the encoders cannot carry them.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 75, stripMetadata: true },
    fields: [QUALITY],
  },
  {
    id: 'image-target-size',
    engine: 'image',
    recompress: true,
    label: 'Compress to a size',
    group: 'image',
    summary: 'Land under a byte budget, for forms that demand one.',
    note: 'Re-encoding always removes EXIF and GPS: the encoders cannot carry them.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 80, targetSize: '200kb', stripMetadata: true },
    fields: [
      {
        key: 'targetSize',
        label: 'Must be under',
        type: 'size',
        hint: 'For example 200kb or 1.5mb. Quality is searched for you.',
      },
    ],
  },
  {
    id: 'image-resize',
    engine: 'image',
    recompress: true,
    label: 'Resize',
    group: 'image',
    summary: 'Scale down by the longest edge.',
    note: 'Re-encoding always removes EXIF and GPS: the encoders cannot carry them.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 85, longestEdge: 1920, stripMetadata: true },
    fields: [
      {
        key: 'longestEdge',
        label: 'Longest edge',
        type: 'range',
        min: 160,
        max: 6000,
        step: 40,
        hint: 'Never enlarges: that cannot add detail, only bytes.',
      },
      QUALITY,
    ],
  },
  {
    id: 'image-rotate',
    engine: 'image',
    recompress: true,
    label: 'Rotate',
    group: 'image',
    summary: 'Turn or mirror an image.',
    note: 'Re-encoding always removes EXIF and GPS: the encoders cannot carry them.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 90, rotate: 90, flip: '', stripMetadata: true },
    fields: [
      {
        key: 'rotate',
        label: 'Turn',
        type: 'select',
        options: [
          { value: '0', label: 'None' },
          { value: '90', label: '90° right' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° left' },
        ],
      },
      {
        key: 'flip',
        label: 'Mirror',
        type: 'select',
        options: [
          { value: '', label: 'None' },
          { value: 'horizontal', label: 'Left to right' },
          { value: 'vertical', label: 'Top to bottom' },
        ],
      },
      QUALITY,
    ],
  },
  {
    id: 'image-strip-metadata',
    engine: 'image',
    label: 'Remove metadata',
    group: 'image',
    summary: 'Strip GPS and EXIF without touching the pixels.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 90, stripMetadata: true },
    fields: [],
  },
  {
    id: 'image-convert',
    engine: 'image',
    recompress: true,
    label: 'Convert format',
    group: 'convert',
    summary: 'JPEG, PNG, WebP, AVIF — and HEIC from an iPhone.',
    note: 'Re-encoding always removes EXIF and GPS: the encoders cannot carry them.',
    accepts: 'image',
    defaults: { format: 'jpeg', quality: 80, stripMetadata: true },
    fields: [formatField(), QUALITY],
  },
];

/**
 * What every tool that saves a document says about metadata. The engine drops
 * the author, producer and dates on every save, and someone rotating a page
 * has no reason to expect that unless they are told.
 */
const PDF_METADATA_NOTE = 'The author, producer and dates are removed from the result.';

const PAGES_HINT = 'Pages as 1, 4-7, 9- (9 to the end).';
const PAGES_OR_ALL_HINT = `${PAGES_HINT} Leave blank for every page.`;

function pagesField(label: string, hint: string, optional = true): SettingField {
  // "all" is only a placeholder where blank means every page. Where it does
  // not (delete, extract), it would invite the one input that is refused.
  return { key: 'pages', label, type: 'text', ...(optional ? { placeholder: 'all' } : {}), hint };
}

const PLACEMENTS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' },
];

/**
 * The PDF tools, all dispatched to the PDF worker.
 *
 * Order matters in one place: `defaultToolFor` offers the first of these to a
 * dropped PDF, so it is the one that does something useful with no setup.
 */
export const PDF_TOOLS: Tool[] = [
  {
    id: 'pdf-compress',
    engine: 'pdf',
    label: 'Compress',
    group: 'pdf',
    summary: 'Shrink a scan or a deck.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    defaults: { strategy: 'images', quality: 75, dpi: 150 },
    fields: [
      {
        key: 'strategy',
        label: 'How',
        type: 'select',
        options: [
          { value: 'images', label: 'Re-encode the images' },
          { value: 'rasterize', label: 'Flatten every page to a picture' },
        ],
        hint: 'Re-encoding keeps text selectable and suits a report with photos. Flattening suits a scan, and turns text into part of the picture: it can no longer be selected or searched.',
      },
      QUALITY,
      {
        key: 'dpi',
        label: 'Resolution',
        type: 'range',
        min: 72,
        max: 300,
        step: 12,
        hint: 'Dots per inch each page is redrawn at. 150 reads well on screen; 300 is for print.',
        showWhen: { key: 'strategy', oneOf: ['rasterize'] },
      },
    ],
  },
  {
    id: 'pdf-merge',
    engine: 'pdf',
    label: 'Merge',
    group: 'pdf',
    summary: 'Join several PDFs into one.',
    note: `Files are joined in the order listed; reorder them in the row. ${PDF_METADATA_NOTE}`,
    accepts: 'pdf',
    combines: { action: 'Merge into one PDF', outputName: 'merged.pdf', min: 2 },
    hideDelta: true,
    defaults: {},
    fields: [],
  },
  {
    id: 'pdf-split',
    engine: 'pdf',
    label: 'Split',
    group: 'pdf',
    summary: 'Break one PDF into pieces.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { mode: 'pages', points: '', every: 5 },
    fields: [
      {
        key: 'mode',
        label: 'Split',
        type: 'select',
        options: [
          { value: 'pages', label: 'Every page on its own' },
          { value: 'every', label: 'Every few pages' },
          { value: 'after', label: 'After the pages I name' },
        ],
      },
      {
        key: 'every',
        label: 'Pages per piece',
        type: 'number',
        min: 1,
        max: 9999,
        showWhen: { key: 'mode', oneOf: ['every'] },
      },
      {
        key: 'points',
        label: 'Split after pages',
        type: 'text',
        placeholder: '3, 7',
        hint: '3, 7 gives pages 1-3, 4-7 and the rest.',
        showWhen: { key: 'mode', oneOf: ['after'] },
      },
    ],
  },
  {
    id: 'pdf-extract',
    engine: 'pdf',
    label: 'Extract pages',
    group: 'pdf',
    summary: 'Keep a range and drop the rest.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { pages: '' },
    fields: [pagesField('Keep pages', PAGES_HINT, false)],
  },
  {
    id: 'pdf-delete',
    engine: 'pdf',
    label: 'Delete pages',
    group: 'pdf',
    summary: 'Remove pages you do not want.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { pages: '' },
    fields: [pagesField('Delete pages', PAGES_HINT, false)],
  },
  {
    id: 'pdf-rotate',
    engine: 'pdf',
    label: 'Rotate pages',
    group: 'pdf',
    summary: 'Turn pages the right way up.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { turn: '90', pages: '' },
    fields: [
      {
        key: 'turn',
        label: 'Turn',
        type: 'select',
        options: [
          { value: '90', label: '90° right' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° left' },
        ],
      },
      pagesField('Pages', PAGES_OR_ALL_HINT),
    ],
  },
  {
    id: 'pdf-reorder',
    engine: 'pdf',
    label: 'Reorder pages',
    group: 'pdf',
    summary: 'Put the pages in a new order.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { mode: 'custom', order: '' },
    fields: [
      {
        key: 'mode',
        label: 'Order',
        type: 'select',
        options: [
          { value: 'custom', label: 'I will type it' },
          { value: 'reverse', label: 'Last page first' },
        ],
      },
      {
        key: 'order',
        label: 'New order',
        type: 'text',
        placeholder: '5, 1-4, 6-',
        hint: 'Every page exactly once, in the order you want them. 9- means 9 to the end.',
        showWhen: { key: 'mode', oneOf: ['custom'] },
      },
    ],
  },
  {
    id: 'pdf-watermark',
    engine: 'pdf',
    label: 'Watermark',
    group: 'pdf',
    summary: 'Stamp text across the pages.',
    note: `Latin letters only: the stamp uses a font every reader has. ${PDF_METADATA_NOTE}`,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { text: 'CONFIDENTIAL', opacity: 15, rotation: '45', placement: 'center', pages: '' },
    fields: [
      { key: 'text', label: 'Text', type: 'text' },
      {
        key: 'opacity',
        label: 'Opacity',
        type: 'range',
        min: 5,
        max: 100,
        step: 5,
        hint: 'Per cent. Low enough to read the page through it.',
      },
      {
        key: 'rotation',
        label: 'Angle',
        type: 'select',
        options: [
          { value: '45', label: 'Diagonal' },
          { value: '0', label: 'Straight' },
        ],
      },
      {
        key: 'placement',
        label: 'Position',
        type: 'select',
        options: [{ value: 'center', label: 'Centre' }, ...PLACEMENTS],
      },
      pagesField('Pages', PAGES_OR_ALL_HINT),
    ],
  },
  {
    id: 'pdf-page-numbers',
    engine: 'pdf',
    label: 'Page numbers',
    group: 'pdf',
    summary: 'Number the pages.',
    note: PDF_METADATA_NOTE,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { placement: 'bottom-center', startAt: 1, template: '{page}', pages: '' },
    fields: [
      { key: 'placement', label: 'Position', type: 'select', options: PLACEMENTS },
      { key: 'startAt', label: 'First number', type: 'number', min: 0, max: 99999 },
      {
        key: 'template',
        label: 'Format',
        type: 'text',
        hint: '{page} is the number and {total} the last one: "Page {page} of {total}".',
      },
      pagesField('Number pages', PAGES_OR_ALL_HINT),
    ],
  },
  {
    id: 'pdf-set-password',
    engine: 'pdf',
    label: 'Add a password',
    group: 'pdf',
    summary: 'Lock a PDF so it needs a password to open.',
    note: `AES-256. There is no recovery: lose the password and the file stays shut. ${PDF_METADATA_NOTE}`,
    accepts: 'pdf',
    hideDelta: true,
    defaults: { userPassword: '', confirmPassword: '' },
    fields: [
      { key: 'userPassword', label: 'Password', type: 'text', secret: true },
      { key: 'confirmPassword', label: 'Type it again', type: 'text', secret: true },
    ],
  },
  {
    id: 'pdf-remove-password',
    engine: 'pdf',
    label: 'Remove a password',
    group: 'pdf',
    summary: 'Save an unlocked copy of a PDF you can open.',
    note: 'You will be asked for the password if the file needs one. The title and author of a locked file cannot be carried over, so the copy has neither.',
    accepts: 'pdf',
    hideDelta: true,
    defaults: {},
    fields: [],
  },
  {
    id: 'pdf-to-images',
    engine: 'pdf',
    label: 'PDF to images',
    group: 'convert',
    summary: 'One image per page.',
    accepts: 'pdf',
    hideDelta: true,
    defaults: { format: 'png', dpi: 150, quality: 85, pages: '' },
    fields: [
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
        ],
      },
      { ...QUALITY, showWhen: { key: 'format', oneOf: ['jpeg', 'webp'] } },
      {
        key: 'dpi',
        label: 'Resolution',
        type: 'range',
        min: 72,
        max: 300,
        step: 12,
        hint: 'Dots per inch. 150 reads well on screen; 300 is for print.',
      },
      pagesField('Pages', PAGES_OR_ALL_HINT),
    ],
  },
  {
    id: 'pdf-to-text',
    engine: 'pdf',
    label: 'PDF to text',
    group: 'convert',
    summary: 'Pull out the text layer.',
    note: 'A scanned document has no text layer, and Toolshed does not do character recognition.',
    accepts: 'pdf',
    hideDelta: true,
    defaults: { pages: '' },
    fields: [pagesField('Pages', PAGES_OR_ALL_HINT)],
  },
  {
    id: 'images-to-pdf',
    engine: 'pdf',
    label: 'Images to PDF',
    group: 'convert',
    summary: 'One page per image.',
    note: 'JPEG and PNG only: convert anything else first. Camera location and device details are removed from every image.',
    accepts: 'image',
    combines: { action: 'Combine into one PDF', outputName: 'images.pdf', min: 1 },
    hideDelta: true,
    defaults: { sizing: 'image', margin: 0 },
    fields: [
      {
        key: 'sizing',
        label: 'Page size',
        type: 'select',
        options: [
          { value: 'image', label: 'As big as each image' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'US Letter' },
        ],
        hint: 'A4 and Letter fit each image inside the page, so a landscape photo on a portrait page leaves margins.',
      },
      { key: 'margin', label: 'Margin', type: 'range', min: 0, max: 72, step: 6, hint: 'Points.' },
    ],
  },
];

export const ALL_TOOLS: Tool[] = [...TOOLS, ...PDF_TOOLS];

export function toolById(id: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.id === id);
}

export const GROUP_LABELS: Record<ToolGroup, string> = {
  image: 'Image',
  pdf: 'PDF',
  convert: 'Convert',
};

/** The tool offered first for a dropped file, by what the file actually is. */
export function defaultToolFor(kind: FileKind): Tool {
  if (kind === 'pdf') return PDF_TOOLS[0] as Tool;
  return TOOLS[0] as Tool;
}

/**
 * The tool a dropped file should land on.
 *
 * Whatever is selected in the grid wins, as long as it can handle the file —
 * the grid is the app's main navigation, and overriding it unconditionally
 * means choosing a tool there does nothing at all.
 */
export function toolForDrop(kind: FileKind, selectedId: string): Tool {
  const selected = toolById(selectedId);
  if (selected && !selected.unavailable && selected.accepts === kind) return selected;
  return defaultToolFor(kind);
}

/**
 * Turns the declared settings into what the image engine expects.
 *
 * The registry stores flat primitives so a generic panel can render them;
 * the engine takes a structured object. This is the one place that knows
 * about both.
 */
export function toImageSettings(settings: ToolSettings, tool?: Tool): ImageSettings {
  const out: ImageSettings = {
    ...(tool?.recompress ? { recompress: true } : {}),
    format: (settings.format as EncodableFormat | 'keep') ?? 'keep',
    quality: Number(settings.quality ?? 80),
    stripMetadata: settings.stripMetadata !== false,
  };

  const rotate = Number(settings.rotate ?? 0);
  if (rotate === 90 || rotate === 180 || rotate === 270) out.rotate = rotate as QuarterTurn;
  if (settings.flip === 'horizontal' || settings.flip === 'vertical') out.flip = settings.flip;
  if (settings.longestEdge) out.resize = { longestEdge: Number(settings.longestEdge) };
  return out;
}
