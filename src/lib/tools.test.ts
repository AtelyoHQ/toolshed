import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  PDF_TOOLS,
  TOOLS,
  defaultToolFor,
  toImageSettings,
  toolForDrop,
  toolById,
} from './tools';

describe('the tool registry', () => {
  it('marks every re-encoding tool as such', () => {
    // A tool that compresses, resizes, rotates or converts must say so, or
    // the engine takes it for a metadata clean-up and returns the input.
    for (const tool of TOOLS) {
      const reencodes = tool.id !== 'image-strip-metadata';
      expect(Boolean(tool.recompress), tool.id).toBe(reencodes);
    }
  });

  it('leaves no buildable tool with settings but no declared intent', () => {
    // Walks every tool, not just the array above, so one added elsewhere
    // cannot quietly be handed its own input back at a 0% saving.
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.engine === 'image')) {
      if (tool.unavailable || tool.fields.length === 0) continue;
      expect(Boolean(tool.recompress), tool.id).toBe(true);
    }
  });

  it('passes that intent through to the engine settings', () => {
    const compress = toolById('image-compress');
    const strip = toolById('image-strip-metadata');
    expect(toImageSettings(compress?.defaults ?? {}, compress).recompress).toBe(true);
    expect(toImageSettings(strip?.defaults ?? {}, strip).recompress).toBeUndefined();
  });

  it('gives every tool defaults its own panel can render', () => {
    for (const tool of ALL_TOOLS) {
      for (const field of tool.fields) {
        expect(tool.defaults[field.key], `${tool.id}.${field.key}`).toBeDefined();
      }
    }
  });
});

describe('choosing a tool for a dropped file', () => {
  it('keeps the tool the person selected when it fits the file', () => {
    // The grid is the main navigation. Overriding it unconditionally meant
    // picking a tool there did nothing at all.
    expect(toolForDrop('image', 'image-resize').id).toBe('image-resize');
  });

  it('falls back when the selected tool cannot take that kind of file', () => {
    expect(toolForDrop('pdf', 'image-resize').group).toBe('pdf');
    expect(toolForDrop('image', 'pdf-merge').accepts).toBe('image');
  });

  it('never returns a tool that is not built yet for an image', () => {
    expect(toolForDrop('image', 'image-compress').unavailable).toBeUndefined();
  });
});

describe('the metadata toggle is only offered where it is true', () => {
  it('is gone from every tool that re-encodes', () => {
    // The encoders carry no EXIF, so on a re-encoding tool the toggle
    // promised something impossible: turning it off changed nothing, and
    // whether metadata survived came down to the accident of whether the
    // re-encode happened to grow the file.
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.recompress)) {
      const keys = tool.fields.map((field) => field.key);
      expect(keys, tool.id).not.toContain('stripMetadata');
    }
  });

  it('says so, rather than leaving it unexplained', () => {
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.recompress)) {
      expect(tool.note, tool.id).toMatch(/removes EXIF/i);
    }
  });

  it('still strips, which is what the absent control would have said', () => {
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.recompress)) {
      expect(toImageSettings(tool.defaults, tool).stripMetadata, tool.id).toBe(true);
    }
  });

  it('leaves the dedicated tool alone, where the toggle would be honest', () => {
    const strip = toolById('image-strip-metadata');
    expect(strip?.recompress).toBeUndefined();
    expect(strip?.note).toBeUndefined();
  });
});

describe('the PDF tools', () => {
  const selects = (tool: (typeof PDF_TOOLS)[number]) =>
    tool.fields.flatMap((field) => (field.type === 'select' ? [field] : []));

  it('sends every one of them to the PDF worker, and no image tool', () => {
    expect(PDF_TOOLS.length).toBeGreaterThan(0);
    for (const tool of PDF_TOOLS) expect(tool.engine, tool.id).toBe('pdf');
    for (const tool of TOOLS) expect(tool.engine, tool.id).toBe('image');
  });

  it('has no two tools with the same id', () => {
    const ids = ALL_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves nothing greyed out as "soon"', () => {
    // The point of wiring the engine in: a tool that is listed works.
    for (const tool of ALL_TOOLS) expect(tool.unavailable, tool.id).toBeUndefined();
  });

  it('starts every select on one of its own options', () => {
    // A default of '90' against options of 90 would render the first option
    // while the settings said something else, and run what the screen did not show.
    for (const tool of PDF_TOOLS) {
      for (const field of selects(tool)) {
        const values = field.options.map((option) => option.value);
        expect(values, `${tool.id}.${field.key}`).toContain(String(tool.defaults[field.key]));
      }
    }
  });

  it('only hides a control behind a control that exists, with values it can take', () => {
    for (const tool of PDF_TOOLS) {
      for (const field of tool.fields) {
        if (!field.showWhen) continue;
        const gate = tool.fields.find((candidate) => candidate.key === field.showWhen?.key);
        expect(gate?.type, `${tool.id}.${field.key} gate`).toBe('select');
        if (gate?.type !== 'select') continue;
        const values = gate.options.map((option) => option.value);
        for (const value of field.showWhen.oneOf) expect(values, tool.id).toContain(value);
      }
    }
  });

  it('keeps passwords out of anything a person reads back', () => {
    for (const tool of PDF_TOOLS) {
      for (const field of tool.fields) {
        if (field.type !== 'text' || !field.secret) continue;
        expect(field.hint, `${tool.id}.${field.key}`).toBeUndefined();
        expect(field.placeholder, `${tool.id}.${field.key}`).toBeUndefined();
      }
    }
  });

  it('marks as combining only the tools that make one file from many', () => {
    const combining = PDF_TOOLS.filter((tool) => tool.combines).map((tool) => tool.id);
    expect(combining.sort()).toEqual(['images-to-pdf', 'pdf-merge']);
  });

  it('offers the gather button for one image but not for one PDF', () => {
    // A single photograph turned into a PDF is a real request; a "merge" of
    // one file is not.
    expect(toolById('images-to-pdf')?.combines?.min).toBe(1);
    expect(toolById('pdf-merge')?.combines?.min).toBe(2);
  });

  it('offers a dropped PDF a tool that works on one file with no setup', () => {
    const tool = defaultToolFor('pdf');
    expect(tool.id).toBe('pdf-compress');
    expect(tool.combines).toBeUndefined();
  });

  it('keeps the tool chosen in the grid for a PDF', () => {
    expect(toolForDrop('pdf', 'pdf-rotate').id).toBe('pdf-rotate');
  });

  it('does not offer an image tool a PDF', () => {
    expect(toolForDrop('pdf', 'image-resize').id).toBe('pdf-compress');
  });

  it('does not show a size change for tools whose result is not smaller by design', () => {
    expect(toolById('pdf-compress')?.hideDelta).toBeUndefined();
    expect(toolById('pdf-to-text')?.hideDelta).toBe(true);
    expect(toolById('pdf-split')?.hideDelta).toBe(true);
  });
});
