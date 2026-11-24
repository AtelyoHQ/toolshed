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

export type SettingField =
  | {
      key: string;
      label: string;
      type: 'range';
      min: number;
      max: number;
      step?: number;
      hint?: string;
    }
  | { key: string; label: string; type: 'toggle'; hint?: string }
  | { key: string; label: string; type: 'size'; hint?: string }
  | {
      key: string;
      label: string;
      type: 'select';
      options: Array<{ value: string; label: string }>;
      hint?: string;
    };

export interface Tool {
  id: string;
  label: string;
  group: ToolGroup;
  /**
   * This tool's job is to re-encode. Without it the engine cannot tell
   * "compress at quality 75 and strip metadata" from "just strip metadata",
   * and takes the cheaper reading.
   */
  recompress?: boolean;
  /** One line, shown under the name. Say what it does, not how clever it is. */
  summary: string;
  accepts: FileKind;
  defaults: ToolSettings;
  fields: SettingField[];
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

const STRIP: SettingField = {
  key: 'stripMetadata',
  label: 'Remove metadata',
  type: 'toggle',
  hint: 'Takes out EXIF, GPS coordinates and timestamps.',
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
    recompress: true,
    label: 'Compress',
    group: 'image',
    summary: 'Make an image smaller at a quality you choose.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 75, stripMetadata: true },
    fields: [QUALITY, STRIP],
  },
  {
    id: 'image-target-size',
    recompress: true,
    label: 'Compress to a size',
    group: 'image',
    summary: 'Land under a byte budget, for forms that demand one.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 80, targetSize: '200kb', stripMetadata: true },
    fields: [
      {
        key: 'targetSize',
        label: 'Must be under',
        type: 'size',
        hint: 'For example 200kb or 1.5mb. Quality is searched for you.',
      },
      STRIP,
    ],
  },
  {
    id: 'image-resize',
    recompress: true,
    label: 'Resize',
    group: 'image',
    summary: 'Scale down by the longest edge.',
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
      STRIP,
    ],
  },
  {
    id: 'image-rotate',
    recompress: true,
    label: 'Rotate',
    group: 'image',
    summary: 'Turn or mirror an image.',
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
      STRIP,
    ],
  },
  {
    id: 'image-strip-metadata',
    label: 'Remove metadata',
    group: 'image',
    summary: 'Strip GPS and EXIF without touching the pixels.',
    accepts: 'image',
    defaults: { format: 'keep', quality: 90, stripMetadata: true },
    fields: [],
  },
  {
    id: 'image-convert',
    recompress: true,
    label: 'Convert format',
    group: 'convert',
    summary: 'JPEG, PNG, WebP, AVIF — and HEIC from an iPhone.',
    accepts: 'image',
    defaults: { format: 'jpeg', quality: 80, stripMetadata: true },
    fields: [formatField(), QUALITY, STRIP],
  },
];

const PLANNED: Array<Pick<Tool, 'id' | 'label' | 'group' | 'summary' | 'accepts'>> = [
  {
    id: 'pdf-compress',
    label: 'Compress',
    group: 'pdf',
    summary: 'Shrink a scan or a deck.',
    accepts: 'pdf',
  },
  {
    id: 'pdf-merge',
    label: 'Merge',
    group: 'pdf',
    summary: 'Join several PDFs into one.',
    accepts: 'pdf',
  },
  {
    id: 'pdf-split',
    label: 'Split',
    group: 'pdf',
    summary: 'Break one PDF into pieces.',
    accepts: 'pdf',
  },
  {
    id: 'pdf-pages',
    label: 'Reorder pages',
    group: 'pdf',
    summary: 'Move, rotate or delete pages.',
    accepts: 'pdf',
  },
  {
    id: 'pdf-protect',
    label: 'Password',
    group: 'pdf',
    summary: 'Add or remove a password.',
    accepts: 'pdf',
  },
  {
    id: 'pdf-to-images',
    label: 'PDF to images',
    group: 'convert',
    summary: 'One image per page.',
    accepts: 'pdf',
  },
  {
    id: 'images-to-pdf',
    label: 'Images to PDF',
    group: 'convert',
    summary: 'One page per image.',
    accepts: 'image',
  },
];

/**
 * Declared but not yet built. Shown greyed rather than hidden: a tool that
 * silently does not exist sends people back to the search engine, while
 * "coming" at least answers the question they came with.
 */
export const PLANNED_TOOLS: Tool[] = PLANNED.map((tool) => ({
  ...tool,
  defaults: {},
  fields: [],
  unavailable: 'Not built yet',
}));

export const ALL_TOOLS: Tool[] = [...TOOLS, ...PLANNED_TOOLS];

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
  if (kind === 'pdf') return PLANNED_TOOLS[0] as Tool;
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
