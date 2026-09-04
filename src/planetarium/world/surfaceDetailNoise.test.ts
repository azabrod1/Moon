import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildSurfaceDetailNoise,
  craterField,
  craterProfile,
  SURFACE_DETAIL_CRATER_DEPTH,
  SURFACE_DETAIL_CRATER_MAX,
  SURFACE_DETAIL_CRATER_MIN,
  SURFACE_DETAIL_CRATER_RIM,
  SURFACE_DETAIL_GRADIENT_SCALE,
  SURFACE_DETAIL_RIM_WIDTH,
  SURFACE_DETAIL_SIZE,
} from './surfaceDetailNoise';

describe('one crater of the close-range field', () => {
  it('digs a bowl that reaches the plain exactly at its rim', () => {
    // The bowl's own term is the full depth at the centre and exactly zero at
    // the rim; what is left at the rim is the swell.
    expect(craterProfile(0).h).toBeCloseTo(-SURFACE_DETAIL_CRATER_DEPTH, 12);
    expect(craterProfile(1).h).toBeCloseTo(SURFACE_DETAIL_CRATER_RIM, 12);
    // The swell is cut where it stops being worth an exponential — the build
    // evaluates this three million times and the exponential is most of its
    // cost. What the cut throws away has to be under the byte the field is
    // stored in: a quarter of a millionth of a crater radius, against a field
    // whose whole range is stored in 255 steps.
    const cutAt = 1 + 2.5 * SURFACE_DETAIL_RIM_WIDTH;
    const dropped = SURFACE_DETAIL_CRATER_RIM * Math.exp(-2.5 * 2.5);
    expect(dropped).toBeLessThan(1e-3);
    expect(craterProfile(cutAt + 1e-6).h).toBe(0);
    // Deepest at the centre, rising monotonically to the rim.
    let previous = craterProfile(0).h;
    expect(previous).toBeLessThan(0);
    for (let t = 0.05; t <= 0.95; t += 0.05) {
      const h = craterProfile(t).h;
      expect(h).toBeGreaterThan(previous);
      previous = h;
    }
  });

  it('raises a lip outside the hole rather than filling it in', () => {
    // The rim is above the plain and the floor below it, so the crater is a
    // hole with a wall and not a dent.
    expect(craterProfile(1).h).toBeGreaterThan(0);
    expect(craterProfile(0).h).toBeLessThan(0);
    // And it dies away outside: three rim widths out is flat ground.
    expect(Math.abs(craterProfile(2).h)).toBeLessThan(1e-3);
  });

  it('states a slope its own derivative agrees with', () => {
    for (const t of [0.2, 0.5, 0.9, 1.05, 1.4]) {
      const step = 1e-6;
      const numeric = (craterProfile(t + step).h - craterProfile(t - step).h) / (2 * step);
      expect(craterProfile(t).dh).toBeCloseTo(numeric, 5);
    }
  });
});

describe('the crater population', () => {
  it('is the same population every session', () => {
    const a = craterField();
    const b = craterField();
    expect(a).toEqual(b);
  });

  it('puts most of its craters at the small end, as a real surface does', () => {
    const craters = craterField();
    for (const c of craters) {
      expect(c.radius).toBeGreaterThanOrEqual(SURFACE_DETAIL_CRATER_MIN - 1e-12);
      expect(c.radius).toBeLessThanOrEqual(SURFACE_DETAIL_CRATER_MAX + 1e-12);
      // Nothing may reach its own far side: the wrap is a single modulo, and a
      // crater wider than half a tile would need a search instead.
      expect(c.radius).toBeLessThan(0.5);
    }
    const geometricMid = Math.sqrt(SURFACE_DETAIL_CRATER_MIN * SURFACE_DETAIL_CRATER_MAX);
    const small = craters.filter((c) => c.radius < geometricMid).length;
    expect(small / craters.length).toBeGreaterThan(0.7);
    // And the few large ones are really there — a field of nothing but grit
    // has no craters to read.
    expect(craters.filter((c) => c.radius > 0.04).length).toBeGreaterThan(5);
  });
});

describe('the built field', () => {
  // Built at the size it really ships at: the finest grain octave has four
  // texels to a cell there, and at a smaller size it would land on the lattice
  // itself and the map would be per-texel hash rather than a surface.
  const size = SURFACE_DETAIL_SIZE;
  const built = buildSurfaceDetailNoise(size);

  it('spends the whole byte on the heights that occur', () => {
    let min = 255;
    let max = 0;
    for (let i = 0; i < built.data.length; i += 4) {
      if (built.data[i] < min) min = built.data[i];
      if (built.data[i] > max) max = built.data[i];
    }
    expect(min).toBe(0);
    expect(max).toBe(255);
  });

  it('reports the mean it really has, which is not the middle of its range', () => {
    // Craters are deep and rare, so the plain between them sits well above the
    // middle of a range the deepest hole in the tile sets. A shader reading
    // this field as a variation has to subtract THIS number: subtracting 0.5
    // instead would make the grain a flat brightening with a variation riding
    // on it, and at coarse mips — where every texel tends to the mean — it
    // would leave the brightening behind on its own.
    let sum = 0;
    let n = 0;
    for (let i = 0; i < built.data.length; i += 4) { sum += built.data[i] / 255; n++; }
    expect(built.mean).toBeCloseTo(sum / n, 6);
    expect(Math.abs(built.mean - 0.5)).toBeGreaterThan(0.1);
  });

  it('holds every gradient it stored without clamping one', () => {
    // The scale is the one number that says whether the encoding still fits
    // the field. A re-seed that pushed past it would flatten the steepest
    // walls silently; this is what catches it instead.
    expect(built.clipped).toBe(0);
  });

  it('tiles: the field wraps in both directions', () => {
    // Column 0 continues column size-1 and row 0 continues row size-1. The
    // shader lays this one tile over a body again and again, at every rung and
    // on each of three charts, so a step across the wrap that is bigger than an
    // ordinary step is a grid of seams across every surface in the system.
    const at = (x: number, y: number) => built.data[(y * size + x) * 4];
    let wrapX = 0;
    let innerX = 0;
    let wrapY = 0;
    let innerY = 0;
    for (let i = 0; i < size; i++) {
      wrapX += Math.abs(at(0, i) - at(size - 1, i));
      innerX += Math.abs(at(1, i) - at(0, i));
      wrapY += Math.abs(at(i, 0) - at(i, size - 1));
      innerY += Math.abs(at(i, 1) - at(i, 0));
    }
    expect(wrapX).toBeLessThan(innerX * 1.5 + size);
    expect(wrapY).toBeLessThan(innerY * 1.5 + size);
  });

  it('packs a gradient the stored heights agree with', () => {
    // The shader tilts the normal from G/B alone, so the packed gradient has
    // to describe the field in R and not the field before it was normalised.
    const h = (x: number, y: number) =>
      built.data[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
    const gu = (x: number, y: number) =>
      ((built.data[(y * size + x) * 4 + 1] / 255) * 2 - 1) * SURFACE_DETAIL_GRADIENT_SCALE;
    let worst = 0;
    let flatSum = 0;
    let flatCount = 0;
    for (let y = 4; y < size - 4; y += 7) {
      for (let x = 4; x < size - 4; x += 7) {
        // Central difference in tile-uv units: one texel is 1/size of a tile.
        const numeric = (h(x + 1, y) - h(x - 1, y)) * (size / 2);
        const gap = Math.abs(numeric - gu(x, y));
        worst = Math.max(worst, gap);
        // Away from the rims the grain is all there is, and its slope is a
        // few units at most: the mean gap there is a byte's rounding, and a
        // build that dropped the grain's slope factor would move it by many.
        if (Math.abs(gu(x, y)) < 15) { flatSum += gap; flatCount++; }
      }
    }
    expect(flatCount).toBeGreaterThan(1000);
    expect(flatSum / flatCount).toBeLessThan(2);
    // A byte of height across the map is a coarse yardstick — the check is
    // that the two describe the same surface, not that they agree to the ulp.
    // The bound scales with the encoding: a central difference over two texels
    // rounds off a rim that is one texel wide, by a fraction of the steepest
    // slope the scale was sized for.
    // Absolute, not a fraction of the scale: a re-seed that raises the scale
    // must not loosen the check with it. The worst gap on this build is 12.5,
    // at the rim crests.
    expect(worst).toBeLessThan(16);
    expect(worst).toBeLessThan(SURFACE_DETAIL_GRADIENT_SCALE * 0.4);
  });

  it('reads without anisotropic filtering', () => {
    // The shader picks the rung so a texel is about a pixel, so anisotropy
    // buys nothing face-on and multiplies every read of the stochastic tiling
    // at a limb — up to eight times the cost for a detail field seen edge-on.
    // Set after the defaults, which would otherwise turn it on.
    const src = readFileSync(resolve(__dirname, 'surfaceDetailNoise.ts'), 'utf8');
    const defaults = src.indexOf("applyTextureDefaults(tex, 'data');");
    const aniso = src.indexOf('tex.anisotropy = 1;');
    expect(defaults).toBeGreaterThan(-1);
    expect(aniso).toBeGreaterThan(defaults);
  });

  it('costs one small upload for every surface in the system', () => {
    // One shared megabyte, whatever the system is drawing: the size is the
    // knob, and a change to it should have to be typed here too.
    expect(SURFACE_DETAIL_SIZE).toBe(512);
    expect(SURFACE_DETAIL_SIZE * SURFACE_DETAIL_SIZE * 4).toBe(1024 * 1024);
  });
});
