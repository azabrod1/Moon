/**
 * The cloud deck's detail noise: one tileable map, built once at run time, that
 * carries everything the deck needs below the resolution of its own colour map.
 * The 8K deck is 5 km per texel at the equator and the ground under it is
 * streamed at sixteen times that, so from orbital altitude the deck is the soft
 * layer — this is what puts a kilometre of structure back on its edges.
 *
 * ONE FETCH. The map holds the finished two-octave field in R and that field's
 * own gradient in G and B, so the shader that erodes the coverage and the
 * shader that perturbs the normal are the same shader reading the same texel.
 * A second octave sampled in the shader would be a second dependent fetch on
 * every deck fragment, which is the whole of the deck's frame-time budget.
 *
 * TILEABLE, INCLUDING THE ROTATED OCTAVE. Two octaves aligned to one lattice
 * read as a grid, so the fine one is rotated — and a rotation that does not map
 * the lattice onto itself destroys the tiling, which is a seam every repeat.
 * The rotation used is therefore the 3-4-5 one, cos 4/5 and sin 3/5, whose
 * integer matrix [[4,3],[-3,4]] takes the lattice into itself: 36.87 degrees,
 * which is the ~37 the eye wants and the only nearby angle that tiles. Its
 * determinant is 25, so the rotated octave necessarily runs five times the
 * lattice's frequency and repeats five times inside the tile — that repeat is
 * in the FINE octave alone, under a coarse one that is unique across the tile.
 *
 * SCALE. The shader multiplies longitude and latitude by one number so that a
 * tile spans 1/40 of the equator — 1002 km, or 0.98 km per texel at 1024. That
 * is the scale the eye reads as cloud texture from orbital altitude, and it is
 * also the scale at which the deck's own map has nothing left to say. The
 * multiplier lands on a whole number of tiles per turn deliberately: the
 * longitude the shader builds has a branch cut at the antimeridian, and an
 * integer number of tile widths across it is what makes that cut invisible.
 */
import * as THREE from 'three';
import { applyTextureDefaults } from './texturePolicy';

/** Texels on a side. */
export const CLOUD_DETAIL_SIZE = 1024;

/** Cells across the tile in the coarse octave — 32 km features at 1002 km. */
export const CLOUD_DETAIL_COARSE_CELLS = 32;

/** The fine octave's lattice period. Its frequency is five times this (the
 *  rotation's determinant), so 25 here is 125 cells across the tile: 8 km
 *  features, and the finest thing the map holds. */
export const CLOUD_DETAIL_FINE_LATTICE = 25;

/** The fine octave's weight against the coarse one's 1. */
export const CLOUD_DETAIL_FINE_WEIGHT = 0.5;

/** The 3-4-5 rotation as its integer matrix: [[4, 3], [-3, 4]], the only
 *  rotation near 37 degrees that takes the integer lattice into itself. */
export const CLOUD_DETAIL_ROTATION: readonly [number, number] = [4, 3];

/** The rotation's angle, degrees — stated so a reader can check it is the ~37
 *  the design asks for rather than taking the matrix on trust. */
export const CLOUD_DETAIL_ROTATION_DEG = (Math.atan2(3, 4) * 180) / Math.PI;

/**
 * What the packed gradient channels are divided by before they are stored, in
 * units of field-per-tile-width. The two octaves reach 77.8 there on the map as
 * seeded — a fifth of the arithmetic worst case, because the octaves' peaks
 * almost never coincide — so 96 spends four fifths of the byte's range on the
 * gradients that actually occur and still clips none of them. A re-seed that
 * pushed past it would clip rather than wrap: the map's own build reports how
 * many texels it had to clamp, and the test holds that at zero.
 */
export const CLOUD_DETAIL_GRADIENT_SCALE = 96;

/** Tiles across a full turn of longitude. 40 makes a tile 1002 km at the
 *  equator (0.98 km per texel) AND is a whole number, which is what keeps the
 *  antimeridian branch cut out of the picture. */
export const CLOUD_DETAIL_TILES_PER_TURN = 40;

/** The one number the shader multiplies longitude and latitude by, in tiles per
 *  radian. Latitude spans half of longitude's range, so the same factor makes
 *  the tile square at the equator. */
export const CLOUD_DETAIL_UV_PER_RADIAN = CLOUD_DETAIL_TILES_PER_TURN / (2 * Math.PI);

/** A lattice of independent values in [0, 1), from one integer seed. The
 *  generator is a plain 32-bit mixer rather than Math.random so the map is the
 *  same map on every device and in every test run. */
function lattice(period: number, seed: number): Float64Array {
  const out = new Float64Array(period * period);
  for (let i = 0; i < out.length; i++) {
    let h = (i + seed * 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    out[i] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  return out;
}

/** Value noise on a periodic lattice, with its own analytic gradient. `x` and
 *  `y` are in lattice cells; the gradient comes back in field-per-cell. */
function valueNoise(
  table: Float64Array,
  period: number,
  x: number,
  y: number,
): { value: number; dx: number; dy: number } {
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
  // Smoothstep interpolation, so the field is C1 across cell boundaries and its
  // gradient is continuous — a linear interpolation would put a crease on every
  // lattice line, which is exactly the grid the rotation exists to hide.
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

/**
 * Build the detail map's bytes: RGBA, `size` on a side, R the two-octave field
 * in [0, 1] and G/B its gradient with respect to the TILE's own uv, encoded
 * around 0.5 through CLOUD_DETAIL_GRADIENT_SCALE. Alpha is opaque and unused —
 * the map is read as data, and an RGB texture would be padded to four bytes on
 * upload anyway.
 *
 * Returns the bytes and how many of them clipped the gradient encoding, which
 * is the one number that says whether the scale above is still the right one.
 */
export function buildCloudDetailNoise(size = CLOUD_DETAIL_SIZE): {
  data: Uint8Array;
  clipped: number;
} {
  const coarse = lattice(CLOUD_DETAIL_COARSE_CELLS, 1);
  const fine = lattice(CLOUD_DETAIL_FINE_LATTICE, 2);
  const [ra, rb] = CLOUD_DETAIL_ROTATION;
  const norm = 1 / (1 + CLOUD_DETAIL_FINE_WEIGHT);
  const data = new Uint8Array(size * size * 4);
  let clipped = 0;
  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      const c = valueNoise(coarse, CLOUD_DETAIL_COARSE_CELLS, u * CLOUD_DETAIL_COARSE_CELLS, v * CLOUD_DETAIL_COARSE_CELLS);
      // The fine octave in the rotated frame. The integer matrix is what makes
      // this wrap: a step of one tile in u moves the sample by (4, -3) lattice
      // periods, which is no move at all as far as the lattice is concerned.
      const fx = CLOUD_DETAIL_FINE_LATTICE * (ra * u + rb * v);
      const fy = CLOUD_DETAIL_FINE_LATTICE * (-rb * u + ra * v);
      const f = valueNoise(fine, CLOUD_DETAIL_FINE_LATTICE, fx, fy);
      const value = (c.value + CLOUD_DETAIL_FINE_WEIGHT * f.value) * norm;
      // Chain rule back to the tile's own uv: the coarse octave through its
      // cell count, the fine one through the rotation as well.
      const gu = norm * (c.dx * CLOUD_DETAIL_COARSE_CELLS
        + CLOUD_DETAIL_FINE_WEIGHT * CLOUD_DETAIL_FINE_LATTICE * (f.dx * ra - f.dy * rb));
      const gv = norm * (c.dy * CLOUD_DETAIL_COARSE_CELLS
        + CLOUD_DETAIL_FINE_WEIGHT * CLOUD_DETAIL_FINE_LATTICE * (f.dx * rb + f.dy * ra));
      const eu = gu / CLOUD_DETAIL_GRADIENT_SCALE;
      const ev = gv / CLOUD_DETAIL_GRADIENT_SCALE;
      if (Math.abs(eu) > 1 || Math.abs(ev) > 1) clipped++;
      const o = (py * size + px) * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, value)) * 255);
      data[o + 1] = Math.round((Math.min(1, Math.max(-1, eu)) * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((Math.min(1, Math.max(-1, ev)) * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  return { data, clipped };
}

/**
 * The detail map as a texture, built once per session and shared by every
 * material that draws a deck. Repeat-wrapped (the map's whole point is that it
 * tiles), mip-chained and anisotropic, because the deck is looked at edge-on
 * from inside the near band and a detail map without mips is the one thing in
 * the frame that crawls.
 */
export function cloudDetailTexture(): THREE.DataTexture {
  if (!detailTexture) {
    const { data } = buildCloudDetailNoise(CLOUD_DETAIL_SIZE);
    const tex = new THREE.DataTexture(data, CLOUD_DETAIL_SIZE, CLOUD_DETAIL_SIZE);
    // Data, not colour: R is a field and G/B are a gradient. An sRGB decode
    // here would bend both.
    applyTextureDefaults(tex, 'data');
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    detailTexture = tex;
  }
  return detailTexture;
}

let detailTexture: THREE.DataTexture | null = null;

/** Drop the shared map — a lost context frees its upload, and the next call
 *  builds it again rather than binding a dead name. */
export function disposeCloudDetailTexture(): void {
  detailTexture?.dispose();
  detailTexture = null;
}
