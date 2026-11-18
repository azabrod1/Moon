import { describe, expect, it } from 'vitest';
import { bracketBox } from './brackets';
import { retroGrid, retroInterfacePixel } from './grid';
import { RETRO_LOOKUP_STEPS, hexToRgb, retroLookup, retroPalette } from './palette';
import { resolveBootLook } from './setting';
import { retroTypographyCss } from './typography';

describe('the Retro look', () => {
  it('makes a 16:10 window a 320 × 200 screen, and an interface pixel a whole number of device pixels', () => {
    expect(retroGrid(1280, 800, 1)).toEqual({ block: 4, virtual: { width: 320, height: 200 }, cssPixel: 4 });
    expect(retroGrid(2560, 1600, 2)).toEqual({ block: 8, virtual: { width: 320, height: 200 }, cssPixel: 4 });
    // The last big pixels hang off an edge rather than leave a gap.
    const odd = retroGrid(1366, 768, 1);
    expect(odd.virtual.width * odd.block).toBeGreaterThanOrEqual(1366);
    for (const ratio of [1, 1.25, 2, 3]) expect(Number.isInteger(retroInterfacePixel(ratio) * ratio)).toBe(true);
  });

  it('takes the URL, then the saved look, then Modern', () => {
    const storage = { getItem: () => 'retro', setItem: () => {} };
    expect(resolveBootLook('?retro=0', storage)).toBe('modern');
    expect(resolveBootLook('', storage)).toBe('retro');
    expect(resolveBootLook('?retro=1', null)).toBe('retro');
  });

  it('cuts to 256 colours, keeping black, white and the interface yellow exact', () => {
    const palette = retroPalette();
    expect(palette).toHaveLength(256);
    const lookup = retroLookup(palette);
    const steps = RETRO_LOOKUP_STEPS;
    const at = (red: number, green: number, blue: number) => Array.from(lookup.subarray(4 * (green * steps * steps + red + steps * blue)).slice(0, 3));
    expect(at(0, 0, 0)).toEqual([0, 0, 0]);
    expect(at(31, 31, 31)).toEqual([255, 255, 255]);
    const [red, green, blue] = hexToRgb('#ffdd22').map((channel) => Math.round((channel / 255) * (steps - 1)));
    expect(at(red, green, blue)).toEqual([255, 221, 34]);
  });

  it('maps type sizes to bitmap faces, family and size together', () => {
    const css = retroTypographyCss([
      { selector: '.note, .a:is(.b, .c)', fontSize: '9.5px', setsFamily: false, media: null },
      { selector: '.mono', fontSize: '', setsFamily: true, media: null },
      { selector: '.tr-clock .t', fontSize: '10.5px', setsFamily: false, media: null },
    ]);
    expect(css).toContain("html.retro .note, html.retro .a:is(.b, .c) { font-family: 'Retro Sans 8', monospace !important; font-size: calc(8 * var(--ui-px)) !important; }");
    expect(css).toContain('html.retro .mono { font-family: inherit !important; }');
    // A region retro.css sets a face for itself is left alone.
    expect(css).not.toContain('.tr-clock');
  });

  it('puts the target brackets on the big-pixel grid, inside the viewport', () => {
    expect(bracketBox({ left: 401.3, top: 150.9, right: 702.2, bottom: 449.5 }, 4, 1280, 800)).toEqual({ left: 392, top: 140, right: 712, bottom: 460 });
    expect(bracketBox({ left: 100, top: 100, right: 110, bottom: 110 }, 4, 1280, 800)).toBeNull();
  });
});
