import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { periodicLattice, periodicValueNoise } from './periodicNoise';
import {
  buildSurfaceDetailNoise,
  buildSurfaceFields,
  buildSurfaceGroundNoise,
  craterField,
  parseGroundParam,
  SURFACE_DETAIL_CRATERS,
  SURFACE_DETAIL_GRAIN,
  SURFACE_GROUND_CRATERS,
  SURFACE_GROUND_GRAIN_GAIN,
  SURFACE_GROUND_RECIPE,
  parseGroundFieldMode,
  thinnedCraterField,
  craterProfile,
  SURFACE_DETAIL_CRATER_DEPTH,
  SURFACE_DETAIL_CRATER_MAX,
  SURFACE_DETAIL_CRATER_MIN,
  SURFACE_DETAIL_CRATER_RIM,
  SURFACE_DETAIL_GRADIENT_SCALE,
  SURFACE_DETAIL_RIM_WIDTH,
  SURFACE_DETAIL_SIZE,
} from './surfaceDetailNoise';

/** The summed byte step across each wrap, and across the first ordinary column
 *  and row, of a packed field's height channel. */
function wrapSteps(data: Uint8Array, size: number) {
  const at = (x: number, y: number) => data[(y * size + x) * 4];
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
  return { wrapX, innerX, wrapY, innerY };
}

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
    const steps = wrapSteps(built.data, size);
    expect(steps.wrapX).toBeLessThan(steps.innerX * 1.5 + size);
    expect(steps.wrapY).toBeLessThan(steps.innerY * 1.5 + size);
  });

  it('stores the bytes it has always stored', () => {
    // A second field was added beside this one; every body that does not ask
    // for it must keep drawing exactly the ground it drew before.
    expect(createHash('sha256').update(built.data).digest('hex'))
      .toBe('09b3c9712e1a77ea9097187e176d4ce021de6e61d9c2fc8d9222af7bee434769');
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

describe('the ground field', () => {
  const size = SURFACE_DETAIL_SIZE;
  const full = buildSurfaceDetailNoise(size);
  // The grain alone, for the checks on what the field is made of; the shipped
  // recipe for the checks on what is uploaded.
  const ground = buildSurfaceGroundNoise({ craters: 0, grainGain: 1 }, size, full.range);
  const shipped = buildSurfaceGroundNoise(
    { craters: SURFACE_GROUND_CRATERS, grainGain: SURFACE_GROUND_GRAIN_GAIN }, size, full.range,
  );

  it('stores the bytes that were judged, built alone or beside the full field', () => {
    // The shipped ground field was chosen by eye; a change to its bytes is a
    // change to what was chosen, and has to be typed here too. Built beside the
    // full field — one pass over the tile, as boot does — both fields are the
    // bytes each makes on its own.
    const pinned = '68db4fbd84b4ff3718c10718c19e59ab6c9a1c39bbc6f9ec9efd2a260e0fd822';
    const hash = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');
    expect(hash(shipped.data)).toBe(pinned);
    const both = buildSurfaceFields({ craters: SURFACE_GROUND_CRATERS, grainGain: SURFACE_GROUND_GRAIN_GAIN }, size);
    expect(hash(both.ground.data)).toBe(pinned);
    expect(hash(both.full.data)).toBe(hash(full.data));
    expect(both.ground.mean).toBe(shipped.mean);
    // And the boot's recipe is the shipped one, with nothing in the URL.
    expect(SURFACE_GROUND_RECIPE).toEqual({ craters: SURFACE_GROUND_CRATERS, grainGain: SURFACE_GROUND_GRAIN_GAIN });
  });

  it('stores the shipped recipe without clamping a height or a gradient', () => {
    // Stored in the full field's range, a steeper grain or a deeper crater
    // would clamp; the shipped recipe must not.
    expect(shipped.clipped).toBe(0);
    expect(shipped.heightClipped).toBe(0);
    expect(shipped.mean - full.mean).toBeGreaterThan(0.02);
  });

  it('chooses which bodies wear it from the URL, the DEV override only in DEV', () => {
    expect(parseGroundFieldMode('', true)).toBe('shipped');
    expect(parseGroundFieldMode('?groundfield=0', false)).toBe('off');
    expect(parseGroundFieldMode('?groundfield=0', true)).toBe('off');
    expect(parseGroundFieldMode('?groundall=1', true)).toBe('all');
    expect(parseGroundFieldMode('?groundall=1', false)).toBe('shipped');
    expect(parseGroundFieldMode('?groundall=1&groundfield=0', true)).toBe('off');
  });

  it('is the grain alone when it has no craters, stored in the full field\'s range', () => {
    // Recomputed here from the octaves alone and stored the way the full field
    // is: if a crater, or the field's own smaller range, had crept in, the
    // bytes would differ.
    const octaves = SURFACE_DETAIL_GRAIN.map((o, i) => ({
      cells: o.cells, amp: o.slope / o.cells, table: periodicLattice(o.cells, 11 + i * 7),
    }));
    const norm = 1 / (full.range.max - full.range.min);
    let checked = 0;
    for (let y = 0; y < size; y += 5) {
      for (let x = 0; x < size; x += 3) {
        let h = 0;
        for (const o of octaves) {
          h += o.amp * (periodicValueNoise(o.table, o.cells, (x / size) * o.cells, (y / size) * o.cells).value - 0.5);
        }
        expect(ground.data[(y * size + x) * 4]).toBe(Math.round((h - full.range.min) * norm * 255));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // So its own range is the grain's, a small part of the full field's.
    const grainReach = octaves.reduce((sum, o) => sum + o.amp / 2, 0);
    expect(ground.range.min).toBeGreaterThanOrEqual(-grainReach);
    expect(ground.range.max).toBeLessThanOrEqual(grainReach);
    expect(full.range.min).toBeLessThan(-4 * grainReach);
  });

  it('thins its sparse craters evenly out of the full field\'s own population', () => {
    // A subset of the craters the full field draws, so a sparse ground is a
    // thinning rather than a different surface — and an EVEN one through the
    // sizes, so it keeps today's mix (mostly small) instead of the few big
    // bowls that read as bubbles over a photograph's real craters.
    const all = craterField(SURFACE_DETAIL_CRATERS);
    const sparse = thinnedCraterField(12);
    expect(sparse).toHaveLength(12);
    for (const c of sparse) expect(all).toContainEqual(c);
    expect(new Set(sparse).size).toBe(12);
    const median = (cs: { radius: number }[]) => {
      const r = cs.map((c) => c.radius).sort((a, b) => a - b);
      return r[Math.floor(r.length / 2)];
    };
    const geometricMid = Math.sqrt(SURFACE_DETAIL_CRATER_MIN * SURFACE_DETAIL_CRATER_MAX);
    const smallShare = (cs: { radius: number }[]) => cs.filter((c) => c.radius < geometricMid).length / cs.length;
    expect(Math.abs(smallShare(sparse) - smallShare(all))).toBeLessThan(0.1);
    expect(median(sparse) / median(all)).toBeGreaterThan(0.8);
    expect(median(sparse) / median(all)).toBeLessThan(1.25);
    // Deterministic, and the whole population at the full count.
    expect(thinnedCraterField(12)).toEqual(sparse);
    expect(thinnedCraterField(SURFACE_DETAIL_CRATERS)).toEqual(all);
    expect(thinnedCraterField(0)).toEqual([]);
  });

  it('holds every height and gradient its default recipe stores', () => {
    expect(ground.clipped).toBe(0);
    expect(ground.heightClipped).toBe(0);
    // And the gradient channels carry the grain's slope, not a flat 0.5: the
    // field is read for its normal, and an encoding that rounded the grain
    // away would be a smooth surface.
    let spread = 0;
    for (let i = 0; i < ground.data.length; i += 4) spread = Math.max(spread, Math.abs(ground.data[i + 1] - 128));
    expect(spread).toBeGreaterThan(20);
  });

  it('reports its own mean, which is not the full field\'s', () => {
    let sum = 0;
    for (let i = 0; i < ground.data.length; i += 4) sum += ground.data[i] / 255;
    expect(ground.mean).toBeCloseTo(sum / (size * size), 6);
    // With the craters gone the plain sits higher in the shared range.
    expect(ground.mean - full.mean).toBeGreaterThan(0.02);
  });

  it('tiles across both wraps as tightly as the full field', () => {
    // Its grain is a small part of the stored range, so its ordinary steps are
    // small too; the wrap must be no bigger a step, relative to them, than the
    // full field's wrap is relative to its own.
    const g = wrapSteps(ground.data, size);
    const f = wrapSteps(full.data, size);
    expect(g.wrapX / g.innerX).toBeLessThan(Math.max(1.5, (f.wrapX / f.innerX) * 1.25));
    expect(g.wrapY / g.innerY).toBeLessThan(Math.max(1.5, (f.wrapY / f.innerY) * 1.25));
    // With craters too: a crater laid across the wrap comes back on the far side.
    const sparse = buildSurfaceGroundNoise({ craters: 30, grainGain: 1 }, size, full.range);
    const s = wrapSteps(sparse.data, size);
    expect(s.wrapX).toBeLessThan(s.innerX * 1.5 + size);
    expect(s.wrapY).toBeLessThan(s.innerY * 1.5 + size);
  });

  it('reads its recipe from the DEV switch, and only in DEV', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The gain left out is the shipped one.
      expect(parseGroundParam('?ground=0', true)).toEqual({ craters: 0, grainGain: SURFACE_GROUND_GRAIN_GAIN });
      expect(parseGroundParam('?ground=12,1.6', true)).toEqual({ craters: 12, grainGain: 1.6 });
      expect(parseGroundParam('?synth=0', true)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // A value it cannot read says so, and leaves the shipped recipe.
      for (const bad of ['-1', '2.5', '0,0', '0,9', 'x']) {
        expect(parseGroundParam(`?ground=${bad}`, true)).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(5);
      // Inert in a production build, whatever the URL says.
      warn.mockClear();
      expect(parseGroundParam('?ground=0', false)).toBeNull();
      expect(parseGroundParam('?ground=x', false)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
