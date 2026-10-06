/**
 * Relief normals from a height field, in physical units.
 *
 * The Moon's shipped relief (gen-maps.mjs `normalsFromHeights`) takes a
 * height sample normalised by 65535 and multiplies its two-texel central
 * difference by a hand-picked `strength` — 3 at 1440 wide, 6 at 2880 —
 * which, with NASA's half-metre encoding of the LOLA grid, works out to a
 * rendered slope about 1.39× the real one at the equator, the same at both
 * tiers (that doubling-per-halving is what the generator's comment asks
 * for). The number was never written down anywhere, so here the slope is
 * computed from the geometry — a height difference in km over the texel's
 * own spacing in km, the longitude spacing shrunk by cos(latitude) — and
 * the exaggeration is ONE named factor. `SHIPPED_RELIEF_EXAGGERATION` is
 * what the shipped tiers carry, so a finer rung cut with it is the same
 * relief sharper and the rank-guarded swap (textureLadder) is not a pop;
 * 1 is the physics.
 *
 * Conventions kept from the shipped generator, so a map from here can sit
 * under the same material: tangent-space with +Y north, OpenGL's convention
 * (rows run north to south, so the generator's ny = dh/d(row) is
 * −dh/d(north), the green three expects — never negate it), longitude wraps,
 * latitude clamps at the poles,
 * and the longitude slope's 1/cos(lat) is clamped at 5 so the polar rows
 * do not blow up. Dependency-free on purpose: tools/gen-moon-relief.mjs
 * imports this file through Node's type stripping, and a `.ts` import from
 * a tool can carry no imports of its own.
 */

/** The slope factor the shipped Moon relief tiers carry over the real one. */
export const SHIPPED_RELIEF_EXAGGERATION = 1.39;

/** The shipped generator's clamp on 1/cos(lat): past it the polar rows'
 *  texels are too narrow for a longitude slope to mean anything. */
export const INV_COS_LAT_CLAMP = 5;

/**
 * Area-average resample of a height grid to a new size: every output texel
 * is the mean of the source area it covers, with fractional coverage at its
 * edges, so a non-integer ratio (23040 → 8128 is 2.835) loses no rows and
 * aliases nothing. `scale` converts source units on the way (NASA's
 * half-metre counts to km: 0.0005). Separable — columns first into a
 * (dw × sh) pass, then rows — so the big intermediate is one float a texel.
 */
export function areaResampleHeights(
  src: ArrayLike<number>,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  scale = 1,
): Float32Array {
  const colSpans = coverage(sw, dw);
  const rowSpans = coverage(sh, dh);
  const mid = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const srcRow = y * sw;
    const midRow = y * dw;
    for (let x = 0; x < dw; x++) {
      const span = colSpans[x];
      let sum = 0;
      for (let k = 0; k < span.weights.length; k++) sum += src[srcRow + span.first + k] * span.weights[k];
      mid[midRow + x] = sum;
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const span = rowSpans[y];
    const outRow = y * dw;
    for (let k = 0; k < span.weights.length; k++) {
      const w = span.weights[k] * scale;
      const midRow = (span.first + k) * dw;
      for (let x = 0; x < dw; x++) out[outRow + x] += mid[midRow + x] * w;
    }
  }
  return out;
}

interface Span { first: number; weights: number[] }

/** For each of `dst` output cells over `src` source cells, the source cells it
 *  covers and each one's share of it (the shares sum to 1). */
function coverage(src: number, dst: number): Span[] {
  const ratio = src / dst;
  const spans: Span[] = [];
  for (let i = 0; i < dst; i++) {
    const start = i * ratio;
    const end = (i + 1) * ratio;
    const first = Math.floor(start);
    const last = Math.min(src - 1, Math.ceil(end) - 1);
    const weights: number[] = [];
    for (let k = first; k <= last; k++) {
      const overlap = Math.min(end, k + 1) - Math.max(start, k);
      weights.push(overlap / ratio);
    }
    spans.push({ first, weights });
  }
  return spans;
}

export interface ReliefNormalOptions {
  /** The body's radius, km: with the grid's width it sets the texel spacing. */
  bodyRadiusKm: number;
  /** The slope factor over the real one; 1 is the physics. */
  exaggeration: number;
}

/** Longitude texel spacing at the equator, km, for an equirect `width` wide. */
export function equatorTexelKm(width: number, bodyRadiusKm: number): number {
  return (2 * Math.PI * bodyRadiusKm) / width;
}

/**
 * Tangent-space normals from a whole-globe equirect height grid in km, as
 * RGB bytes (3 a texel, the layout the tile cutter crops). Central
 * differences over two texels; longitude wraps, latitude clamps.
 */
export function encodeReliefNormals(
  heightsKm: Float32Array,
  width: number,
  height: number,
  options: ReliefNormalOptions,
  out: Uint8Array = new Uint8Array(width * height * 3),
): Uint8Array {
  if (heightsKm.length !== width * height) throw new Error(`heights are ${heightsKm.length} samples, not ${width}×${height}`);
  if (out.length !== width * height * 3) throw new Error(`output is ${out.length} bytes, not ${width}×${height}×3`);
  const texelKm = equatorTexelKm(width, options.bodyRadiusKm);
  // Latitude rows: the same spacing as longitude at the equator, since the
  // grid is equirect (height = width / 2 covers 180°).
  const gain = options.exaggeration / (2 * texelKm);
  for (let y = 0; y < height; y++) {
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const invCosLat = Math.min(1 / Math.max(Math.cos(lat), 1e-9), INV_COS_LAT_CLAMP);
    const rowN = Math.max(y - 1, 0) * width;
    const rowS = Math.min(y + 1, height - 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const east = row + (x + 1) % width;
      const west = row + (x - 1 + width) % width;
      const dzdx = (heightsKm[east] - heightsKm[west]) * gain * invCosLat;
      const dzdy = (heightsKm[rowS + x] - heightsKm[rowN + x]) * gain;
      const nx = -dzdx;
      const ny = dzdy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (row + x) * 3;
      out[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

/**
 * What the shipped generator's `strength` means as an exaggeration, for a
 * grid `width` wide cut from NASA's half-metre uint16 heights. Its slope is
 * ΔH/65535 × strength over two texels, with ΔH in half-metres — 2000 a km;
 * the physics is Δh_km over two texels of `equatorTexelKm`. The ratio is
 * strength × (2000 / 65535) × 2 × texelKm. Pinned by the test, so the 1.39
 * above is a derivation and not a memory.
 */
export function shippedStrengthAsExaggeration(strength: number, width: number, bodyRadiusKm: number): number {
  const HALF_METRES_PER_KM = 2000;
  return strength * (HALF_METRES_PER_KM / 65535) * 2 * equatorTexelKm(width, bodyRadiusKm);
}
