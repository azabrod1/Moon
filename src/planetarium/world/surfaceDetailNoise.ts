/**
 * The close-range surface field: one tileable map, built once at run time, that
 * carries what a body's colour map has stopped saying once it is magnified past
 * a texel a pixel.
 *
 * WHAT IS IN IT. A cratered, grainy height field — a size-frequency mix of
 * impact craters (many small, few large, the distribution every airless surface
 * really wears) over two octaves of fine grain, so a patch never reads as bare
 * craters on a flat plate. It is a HEIGHT field, not a picture: what the shader
 * does with it is tilt the surface normal, which is why it says most at grazing
 * light and nothing at all at noon. That is the honest way round — synthetic
 * relief that draws its own shadows into the albedo reads as fake craters, and
 * that verdict is the reason a previous attempt at synthetic relief on Pluto
 * was dropped.
 *
 * ONE FETCH PER RUNG. R holds the field and G/B its own gradient in the tile's
 * uv, so the shader that grains the albedo and the shader that tilts the normal
 * are one fetch reading one texel.
 *
 * SCALE-FREE ON PURPOSE. Every crater's depth and rim are proportional to its
 * radius, so the field has the same steepness whatever size the shader chooses
 * to draw a tile at. The shader picks the two powers of two that bracket the
 * screen's own resolution and crossfades them, which is what lets one small map
 * stand for every zoom without ever changing a body's face: zooming in reveals
 * finer rungs of the same fixed field rather than a different field.
 *
 * TILEABLE. Craters wrap: a crater's offset is taken modulo the tile, and every
 * radius is under half a tile so no crater can reach its own far side. The
 * grain octaves are periodic lattices whose periods divide the map. What tiles
 * matters more here than for a decorative map: the shader lays this one tile
 * over a body again and again, at every rung and on each of three charts, so a
 * step across the wrap is not one seam somewhere — it is a grid of them across
 * every surface in the system.
 */
import * as THREE from 'three';
import { periodicLattice, periodicValueNoise } from './periodicNoise';
import { applyTextureDefaults } from './texturePolicy';

/** Texels on a side. Small deliberately: it is sampled at whatever scale the
 *  screen wants, so its resolution buys detail at one zoom only, while its
 *  residency is paid at every body drawing a surface. */
export const SURFACE_DETAIL_SIZE = 512;

/** Craters laid down per tile. With the size distribution below this is a few
 *  large basins, a few dozen mid-size craters and a scatter of small ones —
 *  a surface, not a golf ball. */
export const SURFACE_DETAIL_CRATERS = 150;

/** Crater radii, as a fraction of the tile. The largest is under half a tile,
 *  which is what makes the wrap a single modulo rather than a search. */
export const SURFACE_DETAIL_CRATER_MIN = 0.010;
export const SURFACE_DETAIL_CRATER_MAX = 0.130;

/**
 * The size-frequency exponent. Real crater counts go as roughly D^-2 in
 * cumulative number, so a radius drawn as `min * (max/min)^(u^EXPONENT)` with
 * an exponent above 1 puts most of the population at the small end. 2.6 is what
 * lands a handful of large craters in a tile of 150.
 */
export const SURFACE_DETAIL_SIZE_EXPONENT = 2.6;

/** Depth of a crater floor below the plain, as a fraction of its radius — the
 *  ~1:5 depth-to-diameter of a fresh simple crater. */
export const SURFACE_DETAIL_CRATER_DEPTH = 0.20;

/** Height of the raised rim, as a fraction of the radius. */
export const SURFACE_DETAIL_CRATER_RIM = 0.055;

/** Width of the rim ring, in radii. Wide enough that the rim is a swell rather
 *  than a wire, which is the difference between a crater and a ring. */
export const SURFACE_DETAIL_RIM_WIDTH = 0.28;

/**
 * The two grain octaves, authored as SLOPES rather than as heights: a cell is
 * 1/cells of the tile, so an octave's height is its slope times its cell. State
 * an octave's amplitude directly and its steepness runs away with its
 * frequency — 0.05 of a tile across a cell 1/128 of one is a wall six times
 * taller than it is wide, which is what the first build of this map was, and
 * every gradient in it clipped its encoding.
 */
export const SURFACE_DETAIL_GRAIN: readonly { cells: number; slope: number }[] = [
  { cells: 64, slope: 0.22 },
  { cells: 128, slope: 0.16 },
];

/**
 * What the packed gradient channels are divided by before they are stored, in
 * units of NORMALISED field per tile width. The steepest places are where a
 * small crater's wall lands on a grain crest — the walls themselves are a
 * slope of about a half in raw tile units, and the normalisation that spends
 * the whole byte on a range of 0.056 multiplies every gradient by eighteen.
 * 28 holds every texel of the map as seeded, with room to spare; the build
 * reports how many it had to clamp and the test holds that at zero, so a
 * re-seed that pushed past it is caught rather than silently flattened.
 */
export const SURFACE_DETAIL_GRADIENT_SCALE = 28;

/** Deterministic stream of values in [0, 1) — the same map on every device. */
function mixer(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 0x6c078965) + 0x9e3779b9) >>> 0;
    let h = Math.imul(state ^ (state >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

/** How far out, in rim widths, the rim swell is still worth evaluating. Past
 *  this the gaussian is under a fiftieth of a byte of the finished field, and
 *  the exponential it costs is the map's whole build time — a hundred and fifty
 *  craters at a quarter of a million texels. */
const RIM_SUPPORT = 2.5;

/** A crater's height and slope at one point, filled in place: the build asks
 *  three million times and an object apiece is most of its cost. */
export interface CraterHeight {
  h: number;
  dh: number;
}

/**
 * One crater's height at `t` radii from its centre, and the derivative of that
 * height with respect to `t`. Both are in units of the crater's own RADIUS, so
 * a crater of any size has the same walls.
 *
 * The bowl is a paraboloid that reaches the plain exactly at the rim, and the
 * rim is a gaussian swell centred on it. Adding a rim to a bowl that already
 * ends at zero is what puts the raised lip a real crater has outside the hole,
 * rather than making the hole shallower.
 */
export function craterProfile(t: number, out: CraterHeight = { h: 0, dh: 0 }): CraterHeight {
  const e = (t - 1) / SURFACE_DETAIL_RIM_WIDTH;
  if (e > -RIM_SUPPORT && e < RIM_SUPPORT) {
    const rim = SURFACE_DETAIL_CRATER_RIM * Math.exp(-e * e);
    out.h = rim;
    out.dh = (rim * -2 * e) / SURFACE_DETAIL_RIM_WIDTH;
  } else {
    out.h = 0;
    out.dh = 0;
  }
  if (t < 1) {
    out.h -= SURFACE_DETAIL_CRATER_DEPTH * (1 - t * t);
    out.dh += SURFACE_DETAIL_CRATER_DEPTH * 2 * t;
  }
  return out;
}

/** One crater as it is laid into the tile. */
interface Crater {
  cx: number;
  cy: number;
  radius: number;
}

/** The crater population of one tile, largest first so the big basins are laid
 *  down before the small craters that pit them. */
export function craterField(
  count = SURFACE_DETAIL_CRATERS,
  seed = 7,
): Crater[] {
  const rng = mixer(seed);
  const craters: Crater[] = [];
  const ratio = SURFACE_DETAIL_CRATER_MAX / SURFACE_DETAIL_CRATER_MIN;
  for (let i = 0; i < count; i++) {
    const u = rng();
    craters.push({
      cx: rng(),
      cy: rng(),
      radius: SURFACE_DETAIL_CRATER_MIN * ratio ** (u ** SURFACE_DETAIL_SIZE_EXPONENT),
    });
  }
  craters.sort((a, b) => b.radius - a.radius);
  return craters;
}

/** The signed offset from `c` to `p` on a tile that wraps at 1. */
function wrapDelta(p: number, c: number): number {
  const d = p - c;
  return d - Math.round(d);
}

/**
 * Build the field's bytes: RGBA, `size` on a side, R the height field mapped to
 * [0, 1] around a mean of 0.5 and G/B its gradient with respect to the tile's
 * own uv, encoded around 0.5 through SURFACE_DETAIL_GRADIENT_SCALE. Alpha is
 * opaque and unused — the map is data, and an RGB texture is padded to four
 * bytes on upload anyway.
 *
 * Returns the bytes, how many texels clipped the gradient encoding (the one
 * number that says whether that scale is still right), the raw height range,
 * which is what the normalisation is derived from rather than guessed at, and
 * the MEAN of the stored field, which is not 0.5 and cannot be: craters are
 * deep and rare, so the plain between them sits well above the middle of a
 * range the deepest hole in the tile set.
 */
export function buildSurfaceDetailNoise(size = SURFACE_DETAIL_SIZE): {
  data: Uint8Array;
  clipped: number;
  range: { min: number; max: number };
  mean: number;
} {
  const craters = craterField();
  const grain = SURFACE_DETAIL_GRAIN.map((o, i) => ({
    cells: o.cells,
    // The height that slope reaches across one cell.
    amp: o.slope / o.cells,
    table: periodicLattice(o.cells, 11 + i * 7),
  }));
  const height = new Float64Array(size * size);
  const gradU = new Float64Array(size * size);
  const gradV = new Float64Array(size * size);
  let min = Infinity;
  let max = -Infinity;
  // How far outside its own radius a crater still says anything.
  const reachOf = (radius: number) => radius * (1 + RIM_SUPPORT * SURFACE_DETAIL_RIM_WIDTH);
  // Per crater, once: the reach, its square, and the reciprocal radius the
  // distance is measured in.
  const prepared = craters.map((c) => ({
    cx: c.cx, cy: c.cy, invRadius: 1 / c.radius, radius: c.radius, reach: reachOf(c.radius),
  }));
  const rowCraters: typeof prepared = [];
  const profile: CraterHeight = { h: 0, dh: 0 };
  for (let py = 0; py < size; py++) {
    const v = py / size;
    // Which craters can reach this ROW at all, decided once for the row. The
    // map is built at boot, on the main thread, in front of a load screen the
    // user is watching: testing all 150 craters at all 260,000 texels is forty
    // million comparisons and a tenth of a second of it.
    rowCraters.length = 0;
    for (const c of prepared) {
      if (Math.abs(wrapDelta(v, c.cy)) <= c.reach) rowCraters.push(c);
    }
    for (let px = 0; px < size; px++) {
      const u = px / size;
      let h = 0;
      let gu = 0;
      let gv = 0;
      for (const c of rowCraters) {
        const du = wrapDelta(u, c.cx);
        if (du > c.reach || du < -c.reach) continue;
        const dv = wrapDelta(v, c.cy);
        const rSq = du * du + dv * dv;
        if (rSq > c.reach * c.reach) continue;
        const r = Math.sqrt(rSq);
        craterProfile(r * c.invRadius, profile);
        h += profile.h * c.radius;
        // The centre is the one point where the direction is undefined, and it
        // is also where a round crater's slope is zero.
        if (r > 1e-9) {
          gu += profile.dh * (du / r);
          gv += profile.dh * (dv / r);
        }
      }
      for (const o of grain) {
        const n = periodicValueNoise(o.table, o.cells, u * o.cells, v * o.cells);
        h += o.amp * (n.value - 0.5);
        gu += o.amp * n.dx * o.cells;
        gv += o.amp * n.dy * o.cells;
      }
      const i = py * size + px;
      height[i] = h;
      gradU[i] = gu;
      gradV[i] = gv;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  // Normalised to [0, 1] by the range the field actually reached, so the byte
  // spends its whole precision on the heights that occur. The gradient is
  // scaled by the same factor: it has to describe the field that was stored,
  // not the one before the normalisation.
  const span = Math.max(max - min, 1e-9);
  const norm = 1 / span;
  const data = new Uint8Array(size * size * 4);
  let clipped = 0;
  let stored = 0;
  for (let i = 0; i < height.length; i++) {
    const value = (height[i] - min) * norm;
    const eu = (gradU[i] * norm) / SURFACE_DETAIL_GRADIENT_SCALE;
    const ev = (gradV[i] * norm) / SURFACE_DETAIL_GRADIENT_SCALE;
    if (Math.abs(eu) > 1 || Math.abs(ev) > 1) clipped++;
    const o = i * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    stored += data[o] / 255;
    data[o + 1] = Math.round((Math.min(1, Math.max(-1, eu)) * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((Math.min(1, Math.max(-1, ev)) * 0.5 + 0.5) * 255);
    data[o + 3] = 255;
  }
  return { data, clipped, range: { min, max }, mean: stored / height.length };
}

let detailTexture: THREE.DataTexture | null = null;
let detailSpan = 0;
let detailMean = 0;

/**
 * The height the field's full stored range stands for, as a fraction of one
 * tile's width — the number that turns the normalised bytes back into the
 * geometry that was built. A shader drawing the field at exactly this is
 * drawing craters of the depth-to-diameter they were laid down with; anything
 * else is a deliberate exaggeration, stated as a gain on top.
 *
 * Builds the map if it is not built yet, because the two answers have to come
 * from the same bytes.
 */
export function surfaceDetailHeightSpan(): number {
  surfaceDetailTexture();
  return detailSpan;
}

/**
 * The mean of the stored field, which is what a shader reading it as a
 * variation has to subtract to be a variation at all.
 *
 * It is not 0.5. The field is normalised by the range it reached, and its
 * deepest crater is more than twice as far below the plain as its highest rim
 * is above it, so the plain — most of the tile — sits around two thirds of the
 * way up the stored range. Centring on the middle of the range instead would
 * make the grain a three per cent brightening of every magnified surface with a
 * variation riding on top, rather than a variation; and at coarse mips, where
 * every texel tends to the mean, it would leave the brightening alone.
 *
 * Builds the map if it is not built yet, because the two answers have to come
 * from the same bytes.
 */
export function surfaceDetailFieldMean(): number {
  surfaceDetailTexture();
  return detailMean;
}

/**
 * The field as a texture, built once per session and shared by every surface
 * that draws it. Repeat-wrapped (the map's whole point is that it tiles),
 * mip-chained and anisotropic: it is sampled at whatever scale the screen wants
 * and read at grazing incidence on a limb, and a detail map without mips is the
 * one thing in a frame that crawls.
 */
export function surfaceDetailTexture(): THREE.DataTexture {
  if (!detailTexture) {
    const { data, range, mean } = buildSurfaceDetailNoise(SURFACE_DETAIL_SIZE);
    detailSpan = range.max - range.min;
    detailMean = mean;
    const tex = new THREE.DataTexture(data, SURFACE_DETAIL_SIZE, SURFACE_DETAIL_SIZE);
    // Data, not colour: R is a height and G/B are a gradient. An sRGB decode
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

/** Drop the shared map — a lost context frees its upload, and the next call
 *  builds it again rather than binding a dead name. */
export function disposeSurfaceDetailTexture(): void {
  detailTexture?.dispose();
  detailTexture = null;
  detailSpan = 0;
  detailMean = 0;
}
