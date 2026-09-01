/**
 * Periodic value noise with its own analytic gradient — the lattice both of
 * the app's runtime-built detail maps are drawn on (the cloud deck's, and the
 * surface's close-range field).
 *
 * Everything here is CPU-side and build-time-for-the-session: a map is baked
 * once into a DataTexture and the shader reads texels, so the cost of a smooth
 * interpolant and an exact gradient is paid once per session rather than per
 * fragment. Both consumers pack a field in one channel and its gradient in two
 * more, which is what lets a shader erode a coverage and perturb a normal off
 * a single fetch.
 *
 * The generator is a plain 32-bit mixer rather than Math.random, so a map is
 * the same map on every device and in every test run.
 */

/** A lattice of independent values in [0, 1), from one integer seed. */
export function periodicLattice(period: number, seed: number): Float64Array {
  const out = new Float64Array(period * period);
  for (let i = 0; i < out.length; i++) {
    let h = (i + seed * 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  return out;
}

/** One value of a periodic lattice noise and its gradient. `x`/`y` are in
 *  lattice cells and the gradient comes back in field-per-cell. */
export interface NoiseSample {
  value: number;
  dx: number;
  dy: number;
}

/**
 * Value noise on a periodic lattice. Smoothstep interpolation, so the field is
 * C1 across cell boundaries and its gradient is continuous — linear
 * interpolation would put a crease on every lattice line, and a crease in a
 * height field is a line of light in whatever reads it.
 */
export function periodicValueNoise(
  table: Float64Array,
  period: number,
  x: number,
  y: number,
): NoiseSample {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = table[y0 * period + x0];
  const b = table[y0 * period + x1];
  const c = table[y1 * period + x0];
  const d = table[y1 * period + x1];
  const wx = fx * fx * (3 - 2 * fx);
  const wy = fy * fy * (3 - 2 * fy);
  const dwx = 6 * fx * (1 - fx);
  const dwy = 6 * fy * (1 - fy);
  const top = a + (b - a) * wx;
  const bottom = c + (d - c) * wx;
  return {
    value: top + (bottom - top) * wy,
    dx: ((b - a) * (1 - wy) + (d - c) * wy) * dwx,
    dy: (bottom - top) * dwy,
  };
}
