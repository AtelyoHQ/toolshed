import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, TOOLS, toImageSettings, toolForDrop, toolById } from './tools';

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
    for (const tool of ALL_TOOLS) {
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
    for (const tool of TOOLS) {
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
