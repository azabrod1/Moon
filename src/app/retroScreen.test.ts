import { describe, expect, it } from 'vitest';
import { RETRO_LINES, RETRO_SCENE_SUPERSAMPLE, retroGrid } from './retroScreen';

describe('the retro grid', () => {
  it('makes a 16:10 desktop window a 320 × 200 screen at 1× and 2×', () => {
    const atOne = retroGrid(1280, 800, 1);
    expect(atOne.block).toBe(4);
    expect(atOne.virtual).toEqual({ width: 320, height: 200 });
    expect(atOne.cssPixel).toBe(4);
    const atTwo = retroGrid(2560, 1600, 2);
    expect(atTwo.block).toBe(8);
    expect(atTwo.virtual).toEqual({ width: 320, height: 200 });
    // The same big pixel in CSS px on both displays: the interface is the same size.
    expect(atTwo.cssPixel).toBe(4);
  });

  it('gives a phone held upright about 200 big pixels across', () => {
    const phone = retroGrid(780, 1688, 2);
    expect(phone.block).toBe(4);
    expect(phone.virtual).toEqual({ width: 195, height: 422 });
    expect(phone.cssPixel).toBe(2);
  });

  it('keeps every big pixel whole and lets the last ones hang off the edge', () => {
    for (const [width, height] of [[1366, 768], [1919, 1081], [2880, 1800], [1179, 2556], [333, 201]]) {
      const grid = retroGrid(width, height, 2);
      expect(Number.isInteger(grid.block)).toBe(true);
      expect(grid.block).toBeGreaterThanOrEqual(1);
      expect(grid.virtual.width * grid.block).toBeGreaterThanOrEqual(width);
      expect((grid.virtual.width - 1) * grid.block).toBeLessThan(width);
      expect(grid.virtual.height * grid.block).toBeGreaterThanOrEqual(height);
      expect((grid.virtual.height - 1) * grid.block).toBeLessThan(height);
      // About RETRO_LINES on the short side, within one block's rounding.
      const lines = Math.min(width, height) / grid.block;
      expect(lines).toBeGreaterThan(RETRO_LINES * 0.8);
      expect(lines).toBeLessThan(RETRO_LINES * 1.34);
    }
  });

  it('draws the scene at 1.5 × the grid, or 1:1 where the chain cannot average it', () => {
    expect(retroGrid(2560, 1600, 2).scene).toEqual({ width: 480, height: 300 });
    expect(retroGrid(2560, 1600, 2, 1).scene).toEqual({ width: 320, height: 200 });
    expect(RETRO_SCENE_SUPERSAMPLE).toBe(1.5);
    // An odd grid rounds the scene to whole pixels; the box takes the slightly uneven ratio.
    const odd = retroGrid(780, 1688, 2);
    expect(odd.scene).toEqual({ width: 293, height: 633 });
  });

  it('never makes a block or a screen of zero on a tiny or broken canvas', () => {
    const tiny = retroGrid(0, 0, 0);
    expect(tiny.block).toBe(1);
    expect(tiny.virtual).toEqual({ width: 1, height: 1 });
    expect(tiny.scene.width).toBeGreaterThanOrEqual(1);
    expect(tiny.cssPixel).toBe(1);
  });
});
