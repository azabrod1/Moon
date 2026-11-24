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
 *
 * TWO FIELDS. The full field above, and a GROUND field: the same two grain
 * octaves, steeper, with a few of the craters. A colour map that is a
 * photograph already carries the body's real craters down to its own texel,
 * so up close the full field's invented craters land on top of the real ones
 * and the surface wears two sets. Turning the craters down cannot be done at sample time — craters
 * and grain are summed into one map — so a body that must keep the grain
 * without most of the craters reads a second map instead. It is stored in the
 * full field's own range and gradient scale, so the one shader reads either
 * through the same uniforms and a byte means the same height in both; only its
 * mean differs. It is built only when a body asks for it; which bodies do is
 * world/PlanetFactory's rule (`wearsGroundField`).
 */
import * as THREE from 'three';
import { periodicLattice, periodicValueNoise } from './periodicNoise';
import { applyTextureDefaults } from './texturePolicy';

/** Texels on a side. Small deliberately: it is sampled at whatever scale the
 *  screen wants, so its resolution buys detail at one zoom only, while its
 *  residency is paid at every body drawing a surface. */
export const SURFACE_DETAIL_SIZE = 512;

/** Craters laid down per tile: a scatter of small ones over a couple of
 *  dozen mid-size, with plain between — a cratered plain, not a golf ball.
 *  The shader lays two rungs of this tile over each other and blends up to
 *  three copies of each, so what the screen shows is about twice as dense as
 *  the tile; the count is chosen for the screen, not for the tile. */
export const SURFACE_DETAIL_CRATERS = 110;

/**
 * Crater radii, as a fraction of the tile.
 *
 * The largest is small on purpose. This field draws what a body's colour map
 * has stopped resolving, and the map already carries every crater big enough
 * to show in it — so a large basin invented here is drawn over ground whose
 * real basins are already in the picture, and a tile whose few big bowls
 * overlap under grazing light reads as bubble wrap rather than as ground. At
 * a twelfth of the tile the biggest crater is forty to eighty pixels across
 * where the tile is drawn at its ordinary size, which is the top of the range
 * the map hands over at. The smallest is what keeps its rim a texel wide.
 */
export const SURFACE_DETAIL_CRATER_MIN = 0.014;
export const SURFACE_DETAIL_CRATER_MAX = 0.080;

/**
 * The size-frequency exponent. Real crater counts go as roughly D^-2 in
 * cumulative number, so a radius drawn as `min * (max/min)^(u^EXPONENT)` with
 * an exponent above 1 puts most of the population at the small end. 3.4 puts
 * about one crater in thirteen above two thirds of the largest radius — enough
 * large ones that the field has sizes in it, few enough that they rarely touch.
 */
export const SURFACE_DETAIL_SIZE_EXPONENT = 3.4;

/** Depth of a crater floor below the plain, as a fraction of its radius — a
 *  little under the ~1:5 depth-to-diameter of a fresh simple crater, because
 *  the floor below is flatter than a paraboloid and puts its depth into a
 *  steeper wall. */
export const SURFACE_DETAIL_CRATER_DEPTH = 0.16;

/**
 * How the bowl falls away from the rim, as the power of the radius its depth
 * follows: `depth * (1 - t^POWER)`. Two is a paraboloid, whose floor is as
 * curved as its walls and which under grazing light shades as a soft dome;
 * higher powers flatten the floor and steepen the wall near the rim, which is
 * the shape a simple crater really has and the difference between a hole and
 * a dimple.
 */
export const SURFACE_DETAIL_BOWL_POWER = 3.6;

/** Height of the raised rim, as a fraction of the radius. */
export const SURFACE_DETAIL_CRATER_RIM = 0.05;

/** Width of the rim ring, in radii. Narrow enough that the rim is a crest
 *  rather than a swell — a swell half a radius wide shades like the shoulder
 *  of a dome — and wide enough not to be a wire at the tile's resolution:
 *  the smallest crater's rim is still a texel wide. */
export const SURFACE_DETAIL_RIM_WIDTH = 0.14;

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
 * the whole byte on a range of 0.03 multiplies every gradient by about
 * thirty-five. 70 holds every texel of the map as seeded with a tenth to spare;
 * the build reports how many it had to clamp and the test holds that at zero,
 * so a re-seed or a reshaped crater that pushed past it is caught rather than
 * silently flattened. The shader multiplies the same number back, so the
 * slope it draws is the slope that was built, whatever the scale.
 */
export const SURFACE_DETAIL_GRADIENT_SCALE = 70;

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
 * The bowl is a flattened well — depth times one minus a power of the radius —
 * that reaches the plain exactly at the rim, and the rim is a gaussian crest
 * centred on it. Adding a rim to a bowl that already ends at zero is what puts
 * the raised lip a real crater has outside the hole, rather than making the
 * hole shallower.
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
    const wall = Math.pow(t, SURFACE_DETAIL_BOWL_POWER - 1);
    out.h -= SURFACE_DETAIL_CRATER_DEPTH * (1 - wall * t);
    out.dh += SURFACE_DETAIL_CRATER_DEPTH * SURFACE_DETAIL_BOWL_POWER * wall;
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

/**
 * `count` craters of the full field's population, spread evenly through it in
 * order of size, largest first. A sparse field drawn from these is a subset of
 * the full field's craters with the same mix of sizes — mostly small, a few
 * large — rather than whichever craters happened to be drawn first, which
 * keeps the large ones out of proportion and reads as a few big bubbles.
 * At the full count it is the full population itself.
 */
export function thinnedCraterField(count: number): Crater[] {
  const all = craterField(SURFACE_DETAIL_CRATERS);
  const n = Math.max(0, Math.min(count, all.length));
  const kept: Crater[] = [];
  for (let k = 0; k < n; k++) kept.push(all[Math.floor(((k + 0.5) * all.length) / n)]);
  return kept;
}

/** The signed offset from `c` to `p` on a tile that wraps at 1. */
function wrapDelta(p: number, c: number): number {
  const d = p - c;
  return d - Math.round(d);
}


/** What one field is made of: how many craters of the shared population, and
 *  how steep its grain is against the authored octaves. */
export interface SurfaceFieldRecipe {
  craters: number;
  grainGain: number;
}

/** One field before it is stored: height and gradient in raw tile units, and
 *  the range the height reached. */
interface RawSurfaceField {
  height: Float64Array;
  gradU: Float64Array;
  gradV: Float64Array;
  min: number;
  max: number;
}

/** A field as it is uploaded, and what storing it cost. */
export interface BuiltSurfaceField {
  data: Uint8Array;
  /** Texels whose gradient was clamped to fit the encoding. */
  clipped: number;
  /** Texels whose height fell outside the stored range and was clamped. The
   *  first field sets that range from its own heights and never clips; the
   *  ground field is stored in the first field's range and can. */
  heightClipped: number;
  /** The raw height range this field itself reached. */
  range: { min: number; max: number };
  /** The mean of the stored height channel. */
  mean: number;
}

/** Lay a field's craters and grain into raw height and gradient arrays. */
function rawSurfaceField(size: number, recipe: SurfaceFieldRecipe): RawSurfaceField {
  const craters = thinnedCraterField(recipe.craters);
  const grain = SURFACE_DETAIL_GRAIN.map((o, i) => ({
    cells: o.cells,
    // The height that slope reaches across one cell, times the recipe's gain.
    // A gain of exactly one leaves every product bit for bit what it was.
    amp: (o.slope / o.cells) * recipe.grainGain,
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
  return { height, gradU, gradV, min, max };
}

/**
 * Store a raw field as bytes: R the height mapped to [0, 1] across `range`, G/B
 * its gradient with respect to the tile's own uv, encoded around 0.5 through
 * SURFACE_DETAIL_GRADIENT_SCALE. Alpha is opaque and unused — the map is data,
 * and an RGB texture is padded to four bytes on upload anyway.
 *
 * The gradient is scaled by the same factor as the height: it has to describe
 * the field that was stored, not the one before the normalisation.
 */
function encodeSurfaceField(
  raw: RawSurfaceField,
  range: { min: number; max: number },
): BuiltSurfaceField {
  const span = Math.max(range.max - range.min, 1e-9);
  const norm = 1 / span;
  const data = new Uint8Array(raw.height.length * 4);
  // A height past the range by less than half a byte rounds to the end byte
  // it would have had anyway, so only a clamp that changes a byte counts.
  const slack = 0.5 / 255;
  let clipped = 0;
  let heightClipped = 0;
  let stored = 0;
  for (let i = 0; i < raw.height.length; i++) {
    const value = (raw.height[i] - range.min) * norm;
    const eu = (raw.gradU[i] * norm) / SURFACE_DETAIL_GRADIENT_SCALE;
    const ev = (raw.gradV[i] * norm) / SURFACE_DETAIL_GRADIENT_SCALE;
    if (Math.abs(eu) > 1 || Math.abs(ev) > 1) clipped++;
    if (value < -slack || value > 1 + slack) heightClipped++;
    const o = i * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    stored += data[o] / 255;
    data[o + 1] = Math.round((Math.min(1, Math.max(-1, eu)) * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((Math.min(1, Math.max(-1, ev)) * 0.5 + 0.5) * 255);
    data[o + 3] = 255;
  }
  return {
    data, clipped, heightClipped,
    range: { min: raw.min, max: raw.max },
    mean: stored / raw.height.length,
  };
}

/**
 * Build the full field's bytes: every crater and both grain octaves, `size` on
 * a side, normalised by the range the field itself reached so the byte spends
 * its whole precision on the heights that occur.
 *
 * Returns the bytes, how many texels clipped the gradient encoding (the one
 * number that says whether that scale is still right), the raw height range,
 * which is what the normalisation is derived from rather than guessed at, and
 * the MEAN of the stored field, which is not 0.5 and cannot be: craters are
 * deep and rare, so the plain between them sits well above the middle of a
 * range the deepest hole in the tile set.
 */
export function buildSurfaceDetailNoise(size = SURFACE_DETAIL_SIZE): BuiltSurfaceField {
  const raw = rawSurfaceField(size, { craters: SURFACE_DETAIL_CRATERS, grainGain: 1 });
  return encodeSurfaceField(raw, raw);
}

/**
 * Craters in the ground field, thinned evenly out of the full field's own
 * population (thinnedCraterField), so they are a subset of the craters the
 * full field draws, with the same mix of sizes.
 *
 * Judged by eye on Dione, Tethys and Callisto. On a sharp photograph the full
 * field's craters sat over the real ones as a second set. Twelve evenly
 * thinned craters are too small and too rare to show where the photograph
 * still has craters of its own, and they give the closest view, where the
 * photograph has nothing left to say, something to read as ground.
 */
export const SURFACE_GROUND_CRATERS = 12;

/**
 * The ground field's grain, as a gain on the slopes of the full field's
 * octaves. Judged by eye: without the craters' walls the unscaled grain read
 * as blur with a faint grit at about 20 screen pixels per map texel, and three
 * times it read as burnt sandpaper. At this gain and crater count nothing in
 * the stored height or gradient clips.
 */
export const SURFACE_GROUND_GRAIN_GAIN = 1.6;

/** DEV `?ground=<craters>[,<grainGain>]`: a recipe for the ground field this
 *  boot in place of the two constants above, for tuning by eye. It changes
 *  what the ground field is, not which bodies wear it. */
export function parseGroundParam(search: string): SurfaceFieldRecipe | null {
  if (!import.meta.env.DEV) return null;
  const raw = new URLSearchParams(search).get('ground');
  if (raw === null) return null;
  const [cratersText, gainText] = raw.split(',');
  const craters = Number(cratersText);
  const grainGain = gainText === undefined ? SURFACE_GROUND_GRAIN_GAIN : Number(gainText);
  if (!Number.isInteger(craters) || craters < 0 || craters > SURFACE_DETAIL_CRATERS) return null;
  if (!Number.isFinite(grainGain) || grainGain <= 0 || grainGain > 4) return null;
  return { craters, grainGain };
}

/** The recipe the ground field is built with this boot. */
export const SURFACE_GROUND_RECIPE: SurfaceFieldRecipe =
  (typeof location === 'undefined' ? null : parseGroundParam(location.search)) ?? {
    craters: SURFACE_GROUND_CRATERS,
    grainGain: SURFACE_GROUND_GRAIN_GAIN,
  };

/**
 * Which bodies wear the ground field this boot (world/PlanetFactory decides
 * per body):
 * - 'shipped': the bodies the rule there names;
 * - 'off': none — `?groundfield=0`, in any build, puts every body back on the
 *   full crater field, the way it was before there were two;
 * - 'all': DEV `?groundall=1`, every photographed body that draws invented
 *   relief, whatever its map's resolution, for judging bodies outside the
 *   rule by eye. `?groundfield=0` wins over it.
 */
export type GroundFieldMode = 'shipped' | 'off' | 'all';

export function parseGroundFieldMode(search: string, dev: boolean = import.meta.env.DEV): GroundFieldMode {
  const params = new URLSearchParams(search);
  if (params.get('groundfield') === '0') return 'off';
  if (dev && params.get('groundall') === '1') return 'all';
  return 'shipped';
}

/** This boot's mode. */
export const SURFACE_GROUND_MODE: GroundFieldMode =
  typeof location === 'undefined' ? 'shipped' : parseGroundFieldMode(location.search);

/**
 * Build the ground field's bytes, stored in the FULL field's own range.
 *
 * That is what lets the shader read either field through the same uniforms:
 * the height span the relief is scaled by and the gradient scale the slope is
 * decoded with are the full field's, so a byte step in either map is the same
 * height and a stored gradient the same slope. Normalised by its own, smaller
 * range instead, the grain would be stretched over the whole byte and drawn
 * several times as steep. Only the mean differs, and it is reported, because
 * the plain sits at a different place in that range once the craters are gone.
 *
 * A recipe steeper or taller than the full field clamps; the counts say how
 * many texels, and a recipe worth drawing clamps none.
 */
export function buildSurfaceGroundNoise(
  recipe: SurfaceFieldRecipe = SURFACE_GROUND_RECIPE,
  size = SURFACE_DETAIL_SIZE,
  range: { min: number; max: number } = buildSurfaceDetailNoise(size).range,
): BuiltSurfaceField {
  return encodeSurfaceField(rawSurfaceField(size, recipe), range);
}

let detailTexture: THREE.DataTexture | null = null;
let detailSpan = 0;
let detailMean = 0;
let detailRange = { min: 0, max: 0 };
let groundTexture: THREE.DataTexture | null = null;
let groundMean = 0;

/**
 * The height the field's full stored range stands for, as a fraction of one
 * tile's width — the number that turns the normalised bytes back into the
 * geometry that was built. A shader drawing the field at exactly this is
 * drawing craters of the depth-to-diameter they were laid down with; anything
 * else is a deliberate exaggeration, stated as a gain on top. The ground field
 * is stored in the same range, so this is its span too.
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

/** The ground field's stored mean, the zero a shader reading it subtracts.
 *  Builds the map if it is not built yet. */
export function surfaceGroundFieldMean(): number {
  surfaceGroundTexture();
  return groundMean;
}

/**
 * A field's bytes as a texture. Repeat-wrapped (the map's whole point is that
 * it tiles), mip-chained: it is sampled at whatever scale the screen wants, and
 * a detail map without mips is the one thing in a frame that crawls.
 */
function surfaceFieldTexture(data: Uint8Array): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, SURFACE_DETAIL_SIZE, SURFACE_DETAIL_SIZE);
  // Data, not colour: R is a height and G/B are a gradient. An sRGB decode
  // here would bend both.
  applyTextureDefaults(tex, 'data');
  // No anisotropic filtering: the shader chooses the rung so that a texel of
  // this map is about a pixel, so face-on the footprint is already a texel
  // and anisotropy buys nothing; at a limb it multiplies every one of the
  // reads the stochastic tiling makes, and what it would sharpen there is a
  // detail field seen edge-on.
  tex.anisotropy = 1;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** The full field as a texture, built once per session and shared by every
 *  surface that draws it. */
export function surfaceDetailTexture(): THREE.DataTexture {
  if (!detailTexture) {
    const { data, range, mean } = buildSurfaceDetailNoise(SURFACE_DETAIL_SIZE);
    detailSpan = range.max - range.min;
    detailMean = mean;
    detailRange = range;
    detailTexture = surfaceFieldTexture(data);
  }
  return detailTexture;
}

/** The ground field as a texture, built on first use — a session in which no
 *  body wears it never pays for it — with the same settings as the full one. */
export function surfaceGroundTexture(): THREE.DataTexture {
  if (!groundTexture) {
    surfaceDetailTexture();
    const { data, mean } = buildSurfaceGroundNoise(SURFACE_GROUND_RECIPE, SURFACE_DETAIL_SIZE, detailRange);
    groundMean = mean;
    groundTexture = surfaceFieldTexture(data);
  }
  return groundTexture;
}

/** Drop both shared maps — a lost context frees their uploads, and the next
 *  call builds them again rather than binding a dead name. */
export function disposeSurfaceDetailTexture(): void {
  detailTexture?.dispose();
  detailTexture = null;
  detailSpan = 0;
  detailMean = 0;
  detailRange = { min: 0, max: 0 };
  groundTexture?.dispose();
  groundTexture = null;
  groundMean = 0;
}
