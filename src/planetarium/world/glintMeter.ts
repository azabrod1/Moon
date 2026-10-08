/**
 * The highlight meter's predictor: what the sea's beam will draw at the
 * brightest point of the frame, from the shader's own equations, on the CPU,
 * without reading a pixel back.
 *
 * The beam carries its physical range (several whites toward a low Sun, held
 * by the shoulder from OCEAN_BEAM_KNEE to OCEAN_BEAM_CAP), and through the
 * tone curve at exposure 1 that core sits where every channel converges to
 * white. A camera exposed for the glint closes down and the core comes back
 * as gold over dark water; this module says by how much, so the planetarium's
 * exposure can follow — downward only, with a floor, faded in with the beam's
 * share of the frame, so a sparkle from far away never dims a whole disc.
 *
 * Everything here is pure and holds no scratch of its own beyond what the
 * caller hands it. The geometry is in the body's frame with the body's radius
 * as the unit: the camera and the Sun are positions relative to the body's
 * centre, the Sun finite, exactly as the shader's point light sees it.
 *
 * The prediction mirrors the shader term by term (world/surfaceShading, the
 * sea block and the Sun-path block; world/atmosphereLut, the aerial segment):
 *   - the Sun's irradiance, intensity times the authored falloff at the
 *     body's distance, times cos of incidence, times the share of the Sun a
 *     moon's shadow leaves at the point (the shader's eclipse trace, ramped
 *     in over the terminator as it ramps it);
 *   - the Sun's own path, T(1, μs) / T(1, 1), clamped at 1, blended by the
 *     air's blend;
 *   - water's Fresnel on the half vector, three's exp2 Schlick on SEA_WATER_F0;
 *   - the Beckmann lobe at the half vector, at Cox-Munk's mean-square slope
 *     for the map's wind, with Beckmann's own Smith visibility (which
 *     carries the 1 / (4 cos cos));
 *   - the water fraction, which the shader mixes the mirror term by;
 *   - the cloud between the Sun and the point, the share of the beam the
 *     deck lets through on its way down (`cloudKeep`), where the ground
 *     reads it: where the Sun's ray crosses the deck when the ground
 *     compiles cloud shadows, straight over the point when it does not;
 *   - the camera leg as the shader applies it: not plain transmittance but
 *     mix(1, T, airWeight) with airWeight the air's blend times the haze
 *     grade's weight mix(clearView, 1, (1 − μv)²), and T the segment the
 *     shader's aerial perspective reads: the whole column T(1, μv) from the
 *     point up to the top of the air for a camera above it, and for a camera
 *     inside it only the part below the camera, the column above the camera
 *     taken back out as a difference of optical depths;
 *   - then the shoulder, per channel;
 *   - then the deck itself, drawn over the ground and blended by its
 *     coverage where the line of sight crosses it (`deckKeep`): it takes its
 *     share of what the shoulder left, after the shoulder, so a beam under
 *     broken cloud is cut twice, once on the way down and once on the way
 *     up, as the picture cuts it.
 * The air's in-scatter is left out on purpose: the probe's keep-on minus
 * keep-off difference cancels it, so the oracle and the prediction compare
 * like with like, and for a meter that only lowers the exposure the omission
 * sits on the safe side. The relief's geometry roughness, a per-pixel
 * derivative term, is below the meter's resolution and left out too.
 *
 * The brightest drawn point is not the mirror point: the Fresnel, the view
 * cosine and the shadowing move it toward the horizon, so the radiance is
 * scanned along the principal line (the great circle through the sub-camera
 * and sub-Sun points) and the maximum taken, then refined. The line is the
 * beam's axis only over a uniform sea: a coast, an island or a cloud bank
 * lying along it would hide a bright beam on either side, so wherever the
 * maps cut the line's own sample, and open sea there could still draw more
 * than the line has found and more than the caller acts on, the scan also
 * reads one and two of the lobe's expected half-widths either side of it,
 * and the refinement moves across the line as well as along it. Over open, clear sea the line holds the
 * brightest point of every step, and the scan is the line's alone.
 * The beam's extent is fitted from one sample along and one across the line
 * as a Gaussian fall from the peak, and handed back as the angles the
 * half-maximum half-widths subtend at the camera, for the caller to turn
 * into a share of the frame.
 */
import type { AtmosphereParams, RGB } from './atmosphereModel';
import { profileDensity, transmittanceToTopBoundary } from './atmosphereModel';
import { SUN_LIGHT_BASELINE } from '../sunLight';
import { SEA_WIND_MAX_MS } from './seaWind';
import { DEG2RAD as DEG } from '../../shared/math/angles';

/** A position or direction in the body's frame, radii as the unit. */
export type Vec3 = readonly [number, number, number];

/** The Sun as the surfaces receive it at this body: the light's intensity
 *  times the authored falloff at the body's distance from the Sun
 *  (atmosphereModel's solarIrradianceScale, three's decay in scene units),
 *  handed in as one scale because the geometry here is in radii, where that
 *  law cannot be evaluated. */
export interface GlintMeterLight {
  readonly intensity: number;
  readonly linear: RGB;
  /** distance^-decay at the body, 1 at Earth. */
  readonly irradianceScale: number;
}

/** The sea chain's constants in force. */
export interface GlintMeterSea {
  readonly waterF0: number;
  readonly knee: number;
  readonly cap: number;
  /** The haze grade on a direct view (SURFACE_HAZE_CLEAR_VIEW for Earth). */
  readonly hazeClearView: number;
  /** The air's blend, 1 once the tables are in. */
  readonly airBlend: number;
}

/** What the maps say at a ground point. */
export interface SurfaceSample {
  /** The wind over the sea, m/s. */
  windMs: number;
  /** The water fraction, 0..1. */
  water: number;
  /** The share of the Sun's beam the cloud between the Sun and the point
   *  lets through, 0..1: cut before the shoulder. */
  cloudKeep: number;
  /** The share of the drawn beam the deck between the point and the camera
   *  lets through, 0..1: the deck is blended over the ground, so it is cut
   *  after the shoulder. */
  deckKeep: number;
  /** The wind's axis in doubled angle, each in -1..1 (world/seaWind: (0, 0)
   *  is no axis), as the wind map carries it for the glint's ellipse along
   *  the wind. Read here, not used by the meter yet. */
  axisX: number;
  axisY: number;
}

/** Fills `out` with the maps' values at the unit direction (body frame), the
 *  unit directions from the point to the Sun (l) and to the camera (v)
 *  given after it for the cloud along each; numbers rather than vectors so
 *  a frame allocates nothing. Both keeps read 1 when the sampler sets
 *  neither: no deck. */
export type SurfaceSampler = (
  nx: number, ny: number, nz: number, out: SurfaceSample,
  lx: number, ly: number, lz: number, vx: number, vy: number, vz: number,
) => void;

export interface GlintMeterPose {
  /** The camera relative to the body's centre, in radii. */
  readonly camera: Vec3;
  /** The Sun relative to the body's centre, in radii (finite). */
  readonly sun: Vec3;
  /** The Moon-shadow casters the surfaces trace this frame (the shader's
   *  uMoonShadow), four numbers apiece, a centre in the body frame and a
   *  radius, in radii; `shadowCount` of them, none when absent. */
  readonly shadows?: ArrayLike<number>;
  readonly shadowCount?: number;
  /** The tangent of the Sun's angular radius at the body (uSunTan). */
  readonly sunTan?: number;
  /** The terminator's half-width in N·L (uTermWidth), over which the shader
   *  ramps the eclipse in. */
  readonly termWidth?: number;
}

/**
 * The share of the Sun a moon's shadow leaves at the ground point p, as the
 * surfaces trace it (MOON_SHADOW_TRACE_GLSL in world/surfaceShading): each
 * caster sunward of p takes its umbra-to-penumbra share, ramped in by the
 * day factor at the point's own Sun height, and the shares multiply. One
 * with no casters.
 */
export function sunVisibleAt(
  px: number, py: number, pz: number, lx: number, ly: number, lz: number, nl: number, pose: GlintMeterPose,
): number {
  const count = pose.shadowCount ?? 0;
  const shadows = pose.shadows;
  if (!(count > 0) || !shadows) return 1;
  const tan = pose.sunTan ?? 0;
  const tw = pose.termWidth ?? 0;
  const day = smoothstep(-tw, tw, nl);
  let visible = 1;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const tx = shadows[o] - px, ty = shadows[o + 1] - py, tz = shadows[o + 2] - pz;
    const r = shadows[o + 3];
    const along = tx * lx + ty * ly + tz * lz;
    if (along <= 0) continue;
    const perp = Math.hypot(tx - lx * along, ty - ly * along, tz - lz * along);
    const occ = 1 - smoothstep(Math.max(r - along * tan, 0), r + along * tan, perp);
    visible *= 1 - occ * day;
  }
  return visible;
}

/** The transmittance to the top of the air from the ground, per channel, as a
 *  function of the cosine of the zenith angle: the one table both legs read. */
export interface TransmittanceTable {
  readonly muMin: number;
  readonly samples: number;
  /** samples × 3, channel-interleaved, μ from muMin to 1. */
  readonly values: Float32Array;
  /** The top of the air, in radii. */
  readonly topRadius: number;
  /** The columns above a point inside the air, for a camera there; absent,
   *  the camera is taken as above the air. */
  readonly column?: ColumnDepthTable;
}

/**
 * The optical depth from a radius inside the air up to its top, per channel,
 * over the upper half of the directions: the column a camera inside the air
 * looks out of, which its view leg takes back out of the ground's. Laid out
 * as the GPU's transmittance table lays out its rays, rows in the distance
 * to the horizon (ρ, over its value at the ground) and columns in the
 * distance to the top, from straight up to level, so the steep fall of the
 * near-level rays has its texels; stored as optical depth, as that table
 * stores it, so a segment is the difference of two depths. Built once, the
 * first time a camera is inside the air: a few milliseconds.
 */
export interface ColumnDepthTable {
  readonly rows: number;
  readonly cols: number;
  readonly topRadius: number;
  /** √(top² − 1), the horizon distance at the ground: ρ's unit. */
  readonly chord: number;
  /** rows × cols × 3, channel-interleaved. */
  readonly values: Float32Array;
}

export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** Cox-Munk: the sea's mean-square slope for a wind, as world/seaWind has it. */
export function meanSquareSlopeOfWind(windMs: number): number {
  return COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * Math.max(windMs, 0);
}

/** The wind the scan sizes its reach across the principal line for: 7 m/s,
 *  near the open ocean's mean. Only where the scan looks depends on it, never
 *  what it reads there: a calmer sea's narrower beam is still met inside two
 *  of these half-widths, and the refinement then climbs to its own peak. */
export const SCAN_ACROSS_WIND_MS = 7;

/** The scan's offsets across the principal line at a coarse step whose own
 *  sample the maps cut, in the lobe's expected half-widths there: one and
 *  two out on either side. */
const SCAN_ACROSS_STEPS = [1, -1, 2, -2];

/** The refinement's steps across the line stop after this many halvings,
 *  at an eighth of the half-width they started from: finer than that moves
 *  the drawn peak by about a percent over the shipped maps. */
const SCAN_REFINE_ACROSS_LEVELS = 3;

/** How far over the open-sea bound at the line the points beside it may
 *  draw: the factors besides the lobe change by a few percent across two
 *  half-widths, and a quarter holds them with room. */
const SCAN_BOUND_MARGIN = 1.25;

/** The table, built once per body from the CPU atmosphere; a few milliseconds. */
export function buildTransmittanceTable(params: AtmosphereParams, samples = 256, muMin = -0.25): TransmittanceTable {
  const values = new Float32Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    const mu = muMin + ((1 - muMin) * i) / (samples - 1);
    const t = transmittanceToTopBoundary(params, params.bottomRadius, mu);
    values[i * 3] = t[0];
    values[i * 3 + 1] = t[1];
    values[i * 3 + 2] = t[2];
  }
  return { muMin, samples, values, topRadius: params.topRadius };
}

/** The column table (ColumnDepthTable). Each depth is integrated along its
 *  ray with the samples bunched toward the start, t = d·u² for u uniform,
 *  where the air is thickest: with the table's interpolation, within about
 *  a percent of the module's 500-sample reference, at a tenth of its cost. */
export function buildColumnDepthTable(params: AtmosphereParams, rows = 32, cols = 64, steps = 48): ColumnDepthTable {
  const top = params.topRadius, bottom = params.bottomRadius;
  const chord = Math.sqrt(top * top - bottom * bottom);
  const values = new Float32Array(rows * cols * 3);
  const rs = params.rayleighScattering, me = params.mieExtinction, ae = params.absorptionExtinction;
  for (let j = 0; j < rows; j++) {
    const rho = (chord * j) / (rows - 1);
    const r = Math.sqrt(rho * rho + bottom * bottom);
    const dUp = top - r;
    const dLevel = Math.sqrt(Math.max(top * top - r * r, 0));
    for (let i = 0; i < cols; i++) {
      const d = dUp + ((dLevel - dUp) * i) / (cols - 1);
      const mu = d === 0 ? 1 : Math.min(Math.max((top * top - r * r - d * d) / (2 * r * d), 0), 1);
      let sR = 0, sM = 0, sO = 0;
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const t = d * u * u;
        const w = ((k === 0 || k === steps ? 0.5 : 1) * 2 * d * u) / steps;
        const alt = Math.sqrt(t * t + 2 * r * mu * t + r * r) - bottom;
        sR += profileDensity(params.rayleighDensity, alt) * w;
        sM += profileDensity(params.mieDensity, alt) * w;
        sO += profileDensity(params.absorptionDensity, alt) * w;
      }
      const o = (j * cols + i) * 3;
      for (let c = 0; c < 3; c++) values[o + c] = rs[c] * sR + me[c] * sM + ae[c] * sO;
    }
  }
  return { rows, cols, topRadius: top, chord, values };
}

/** τ(r, μ) per channel into `out`, bilinear in the table's own coordinates;
 *  r is held to the air and μ to the upper half. */
export function lookupColumnDepth(table: ColumnDepthTable, r: number, mu: number, out: [number, number, number]): void {
  const top = table.topRadius;
  const rr = Math.min(Math.max(r, 1), top);
  const rho = Math.sqrt(Math.max(rr * rr - 1, 0));
  const dUp = top - rr;
  const dLevel = Math.sqrt(Math.max(top * top - rr * rr, 0));
  const m = Math.min(Math.max(mu, 0), 1);
  const d = -rr * m + Math.sqrt(Math.max(rr * rr * (m * m - 1) + top * top, 0));
  const xm = dLevel > dUp ? Math.min(Math.max((d - dUp) / (dLevel - dUp), 0), 1) : 0;
  const xr = Math.min(Math.max(rho / table.chord, 0), 1);
  const fx = xm * (table.cols - 1), fy = xr * (table.rows - 1);
  const i = Math.min(Math.floor(fx), table.cols - 2), j = Math.min(Math.floor(fy), table.rows - 2);
  const a = fx - i, b = fy - j;
  const v = table.values;
  const o00 = (j * table.cols + i) * 3, o01 = o00 + table.cols * 3;
  for (let c = 0; c < 3; c++) {
    const lo = v[o00 + c] + (v[o00 + 3 + c] - v[o00 + c]) * a;
    const hi = v[o01 + c] + (v[o01 + 3 + c] - v[o01 + c]) * a;
    out[c] = lo + (hi - lo) * b;
  }
}

/** T(1, μ) per channel into `out`, linearly interpolated; μ under the table's
 *  floor reads the floor (a Sun that far down lights nothing anyway). */
export function lookupTransmittance(table: TransmittanceTable, mu: number, out: [number, number, number]): void {
  const x = Math.min(Math.max((mu - table.muMin) / (1 - table.muMin), 0), 1) * (table.samples - 1);
  const i = Math.min(Math.floor(x), table.samples - 2);
  const f = x - i;
  const v = table.values;
  const a = i * 3;
  const b = a + 3;
  out[0] = v[a] + (v[b] - v[a]) * f;
  out[1] = v[a + 1] + (v[b + 1] - v[a + 1]) * f;
  out[2] = v[a + 2] + (v[b + 2] - v[a + 2]) * f;
}

/** Walter's rational fit of Beckmann's Smith G1 in a = 1 / (α tan θ). */
export function beckmannG1(cosTheta: number, alpha: number): number {
  const sin = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
  if (sin < 1e-9) return 1;
  const a = cosTheta / (alpha * sin);
  if (a >= 1.6) return 1;
  return (3.535 * a + 2.181 * a * a) / (1 + 2.276 * a + 2.577 * a * a);
}

/** The Beckmann lobe at a half-vector cosine, α² the mean-square slope. */
export function beckmannLobe(cosNH: number, mss: number): number {
  const cos2 = Math.max(cosNH * cosNH, 1e-6);
  return Math.exp((cos2 - 1) / (cos2 * mss)) / (Math.PI * mss * cos2 * cos2);
}

const MSS_CALMEST = meanSquareSlopeOfWind(0);
const MSS_ROUGHEST = meanSquareSlopeOfWind(SEA_WIND_MAX_MS);

/** The Beckmann lobe at a half-vector cosine, at whichever mean-square slope
 *  the wind map can hold makes it largest: at a slope tan θ from the mirror
 *  that is tan²θ itself, held between the calm sea's and the strongest
 *  wind's. A bound on the lobe over every sea the maps can draw, which
 *  only falls as θ grows. */
export function beckmannLobeBound(cosNH: number): number {
  const cos2 = Math.max(cosNH * cosNH, 1e-6);
  const tan2 = (1 - cos2) / cos2;
  return beckmannLobe(cosNH, Math.min(Math.max(tan2, MSS_CALMEST), MSS_ROUGHEST));
}

/** The shoulder the shader applies after the air: the term to the knee, then
 *  an exponential approach to the cap, per channel. */
export function shoulder(v: number, knee: number, cap: number): number {
  if (v <= knee) return v;
  const range = cap - knee;
  return knee + range * (1 - Math.exp(-(v - knee) / range));
}

/** The largest channel of a carried radiance once the shoulder holds it. */
function drawnMaxOf(rad: readonly number[], sea: GlintMeterSea): number {
  return Math.max(shoulder(rad[0], sea.knee, sea.cap), shoulder(rad[1], sea.knee, sea.cap), shoulder(rad[2], sea.knee, sea.cap));
}

/** Scratch the evaluation reuses, so a frame allocates nothing. */
export interface GlintScratch {
  sample: SurfaceSample;
  t: [number, number, number];
  tz: [number, number, number];
  tc: [number, number, number];
  /** The principal plane's axes (principalAxes) and two frame-angle pairs. */
  axes: Float64Array;
  place0: [number, number];
  place1: [number, number];
  /** Per coarse step of the scan, whether the maps cut the line's sample. */
  cut: Uint8Array;
  /** The share of the Sun a moon's shadow left at the last point evaluated. */
  sunVisible: number;
}

export function createGlintScratch(): GlintScratch {
  return {
    sample: { windMs: 0, water: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 }, t: [0, 0, 0], tz: [0, 0, 0], tc: [0, 0, 0],
    axes: new Float64Array(6), place0: [0, 0], place1: [0, 0], cut: new Uint8Array(64), sunVisible: 1,
  };
}

/**
 * The beam's radiance as carried to the camera at the ground point with unit
 * normal (nx, ny, nz), per channel into `out`, before the shoulder and the
 * deck drawn over it (`scratch.sample.deckKeep` holds the deck's share for
 * the caller). Zero when the point is unlit, below the horizon, or not sea.
 * With `bound`, the maps are not read: the point is taken as open sea under
 * a clear sky and a whole Sun at its brightest wind (beckmannLobeBound) with
 * no shadowing, which no sea the maps can draw there exceeds.
 */
export function beamRadianceAt(
  nx: number, ny: number, nz: number,
  pose: GlintMeterPose, light: GlintMeterLight, sea: GlintMeterSea,
  sampler: SurfaceSampler, table: TransmittanceTable, scratch: GlintScratch,
  out: [number, number, number], bound = false,
): void {
  out[0] = 0; out[1] = 0; out[2] = 0;
  // The view: from the point to the camera.
  let vx = pose.camera[0] - nx, vy = pose.camera[1] - ny, vz = pose.camera[2] - nz;
  const vLen = Math.hypot(vx, vy, vz);
  if (vLen < 1e-9) return;
  vx /= vLen; vy /= vLen; vz /= vLen;
  const nv = nx * vx + ny * vy + nz * vz;
  if (nv <= 0) return;
  // The light: from the point to the Sun, finite.
  let lx = pose.sun[0] - nx, ly = pose.sun[1] - ny, lz = pose.sun[2] - nz;
  const sunDist = Math.hypot(lx, ly, lz);
  if (sunDist < 1e-9) return;
  lx /= sunDist; ly /= sunDist; lz /= sunDist;
  const nl = nx * lx + ny * ly + nz * lz;
  if (nl <= 0) return;
  const s = scratch.sample;
  s.cloudKeep = 1; s.deckKeep = 1;
  if (bound) s.water = 1;
  else sampler(nx, ny, nz, s, lx, ly, lz, vx, vy, vz);
  if (s.water <= 0 || s.cloudKeep <= 0) return;
  // The half vector and the lobes.
  let hx = lx + vx, hy = ly + vy, hz = lz + vz;
  const hLen = Math.hypot(hx, hy, hz);
  if (hLen < 1e-9) return;
  hx /= hLen; hy /= hLen; hz /= hLen;
  const nh = Math.max(nx * hx + ny * hy + nz * hz, 0);
  const vh = Math.max(vx * hx + vy * hy + vz * hz, 0);
  const tail = Math.pow(2, (-5.55473 * vh - 6.98316) * vh);
  const fresnel = sea.waterF0 + (1 - sea.waterF0) * tail;
  const mss = meanSquareSlopeOfWind(s.windMs);
  const lobe = (bound
    ? beckmannLobeBound(nh)
    : beckmannLobe(nh, mss) * beckmannG1(nl, Math.sqrt(mss)) * beckmannG1(nv, Math.sqrt(mss))) / Math.max(4 * nl * nv, 1e-6);
  // The Sun's path, normalised at the zenith, clamped, blended; the camera
  // leg through the haze grade's weight.
  lookupTransmittance(table, nl, scratch.t);
  lookupTransmittance(table, 1, scratch.tz);
  const grazing = 1 - nv;
  const airWeight = sea.airBlend * (sea.hazeClearView + (1 - sea.hazeClearView) * grazing * grazing);
  scratch.sunVisible = bound ? 1 : sunVisibleAt(nx, ny, nz, lx, ly, lz, nl, pose);
  const irradiance = light.intensity * light.irradianceScale * nl * scratch.sunVisible;
  const common = irradiance * fresnel * lobe * s.water * s.cloudKeep;
  const tv = scratch.tz; // reused below for the view leg once the zenith is read
  const tz0 = scratch.tz[0], tz1 = scratch.tz[1], tz2 = scratch.tz[2];
  const sp0 = 1 + (Math.min(scratch.t[0] / Math.max(tz0, 1e-4), 1) - 1) * sea.airBlend;
  const sp1 = 1 + (Math.min(scratch.t[1] / Math.max(tz1, 1e-4), 1) - 1) * sea.airBlend;
  const sp2 = 1 + (Math.min(scratch.t[2] / Math.max(tz2, 1e-4), 1) - 1) * sea.airBlend;
  lookupTransmittance(table, nv, tv);
  // A camera inside the air sees the point through the segment that ends at
  // the camera, as the shader's aerial perspective does, not through the
  // whole column: the column above the camera along the same ray is taken
  // back out, T(1, μv) · exp(τ(r, μ)), a difference of optical depths.
  const column = table.column;
  if (column) {
    const camR = Math.hypot(pose.camera[0], pose.camera[1], pose.camera[2]);
    if (camR < table.topRadius) {
      const muC = (pose.camera[0] * vx + pose.camera[1] * vy + pose.camera[2] * vz) / camR;
      const tc = scratch.tc;
      lookupColumnDepth(column, camR, muC, tc);
      tv[0] = Math.min(tv[0] * Math.exp(tc[0]), 1);
      tv[1] = Math.min(tv[1] * Math.exp(tc[1]), 1);
      tv[2] = Math.min(tv[2] * Math.exp(tc[2]), 1);
    }
  }
  out[0] = common * light.linear[0] * sp0 * (1 + (tv[0] - 1) * airWeight);
  out[1] = common * light.linear[1] * sp1 * (1 + (tv[1] - 1) * airWeight);
  out[2] = common * light.linear[2] * sp2 * (1 + (tv[2] - 1) * airWeight);
}

/** What the scan found. */
export interface BeamPeak {
  /** The peak's ground direction (unit, body frame). */
  readonly n: [number, number, number];
  /** Ground angle from the sub-camera point along the principal line, degrees. */
  readonly groundAngleDeg: number;
  /** Ground angle from the principal line to the peak, degrees, toward the
   *  plane's normal (the camera's vertical crossed into the Sun's side): zero
   *  over a uniform sea, off it where land or cloud lies along the line. */
  readonly acrossAngleDeg: number;
  /** The carried radiance at the peak, per channel. */
  readonly carried: [number, number, number];
  /** The drawn radiance at the peak, per channel, after the shoulder and the
   *  deck drawn over it. */
  readonly drawn: [number, number, number];
  /** The drawn maximum channel: what the meter protects. */
  readonly drawnMax: number;
  /** Half-maximum half-widths of the drawn beam as angles subtended at the
   *  camera, degrees: along the principal line and across it. */
  readonly halfWidthAlongDeg: number;
  readonly halfWidthAcrossDeg: number;
  /** The surface at the peak as the sampler read it: the water, the wind
   *  and the cloud's two keeps, so a probe can tell a beam under cloud from
   *  a beam the prediction missed. */
  readonly sample: SurfaceSample;
}

export interface ScanOptions {
  /** Coarse samples along the visible part of the line. */
  readonly coarse?: number;
  /** Refinement steps about the best coarse sample. */
  readonly refine?: number;
  /** The drawn level under which a beam beside the line is not looked for:
   *  the scan reads beside it only where open sea could draw more than this
   *  and more than it has already found. The meter passes its target, under
   *  which it asks for nothing whatever the beam; zero looks for any. */
  readonly besideFloor?: number;
}

/** A result holder the caller keeps, so a frame allocates nothing. */
export function createBeamPeak(): BeamPeak {
  return {
    n: [0, 0, 0], groundAngleDeg: 0, acrossAngleDeg: 0, carried: [0, 0, 0], drawn: [0, 0, 0], drawnMax: 0,
    halfWidthAlongDeg: 0, halfWidthAcrossDeg: 0,
    sample: { windMs: 0, water: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 },
  };
}

function angleBetweenFrom(cam: Vec3, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const ux = ax - cam[0], uy = ay - cam[1], uz = az - cam[2];
  const wx = bx - cam[0], wy = by - cam[1], wz = bz - cam[2];
  const d = (ux * wx + uy * wy + uz * wz) / Math.max(Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz), 1e-12);
  return Math.acos(Math.min(Math.max(d, -1), 1)) / DEG;
}

/** The principal plane's axes: e1 up through the camera, e2 toward the Sun
 *  in it, written as six numbers. False when there is no plane: the camera
 *  inside the body, or the Sun on the camera's zenith. */
export function principalAxes(pose: GlintMeterPose, out: Float64Array | number[]): boolean {
  const cam = pose.camera;
  const camDist = Math.hypot(cam[0], cam[1], cam[2]);
  if (!(camDist > 1.000001)) return false;
  const e1x = cam[0] / camDist, e1y = cam[1] / camDist, e1z = cam[2] / camDist;
  const sd = pose.sun[0] * e1x + pose.sun[1] * e1y + pose.sun[2] * e1z;
  const e2x = pose.sun[0] - sd * e1x, e2y = pose.sun[1] - sd * e1y, e2z = pose.sun[2] - sd * e1z;
  const e2Len = Math.hypot(e2x, e2y, e2z);
  if (!(e2Len > 1e-9)) return false;
  out[0] = e1x; out[1] = e1y; out[2] = e1z;
  out[3] = e2x / e2Len; out[4] = e2y / e2Len; out[5] = e2z / e2Len;
  return true;
}

/**
 * How far across the principal line the beam at the ground point p falls to
 * half its height, as a ground angle, for a lobe whose half-maximum is at the
 * angle `lobeHalf` between the normal and the half vector. Moving p across
 * the line by a small ground angle d tilts its normal by d, and turns the
 * view, and with it the half vector, the other way by d / (s |l + v|), s the
 * slant to the camera in radii, l and v the unit vectors to the Sun and the
 * camera: the two add, so the half-maximum sits at
 * d = lobeHalf * s|l + v| / (1 + s|l + v|).
 */
export function acrossHalfWidthAt(px: number, py: number, pz: number, pose: GlintMeterPose, lobeHalf: number): number {
  let vx = pose.camera[0] - px, vy = pose.camera[1] - py, vz = pose.camera[2] - pz;
  const s = Math.hypot(vx, vy, vz);
  let lx = pose.sun[0] - px, ly = pose.sun[1] - py, lz = pose.sun[2] - pz;
  const sunDist = Math.hypot(lx, ly, lz);
  if (!(s > 1e-12) || !(sunDist > 1e-12)) return 0;
  vx /= s; vy /= s; vz /= s;
  lx /= sunDist; ly /= sunDist; lz /= sunDist;
  const g = s * Math.hypot(lx + vx, ly + vy, lz + vz);
  return (lobeHalf * g) / (1 + g);
}

/** Where the beam's peak lands in the frame, as a pinhole sees it: its
 *  angles from the frame's centre toward the right and up, degrees, the
 *  direction of the principal line there as a unit vector in those axes,
 *  and whether it is in front of the camera at all. */
export interface BeamPlace {
  xDeg: number;
  yDeg: number;
  alongX: number;
  alongY: number;
  inFront: boolean;
}

export function createBeamPlace(): BeamPlace {
  return { xDeg: 0, yDeg: 0, alongX: 0, alongY: 1, inFront: false };
}

/**
 * Place the beam's peak in the frame. `view` is the camera's forward and
 * `viewUp` its up, unit vectors in the body frame; the frame's right is their
 * cross product. The peak sits `groundAngleDeg` along the principal line from
 * the sub-camera point and `acrossAngleDeg` across it (the scan's own two
 * angles), and the line's direction in the frame is read from a second point
 * half a degree further along. A point at or behind the camera's plane is not
 * in front, and the place is left at the centre.
 */
export function placeBeamInFrame(
  pose: GlintMeterPose, groundAngleDeg: number, view: Vec3, viewUp: Vec3, scratch: GlintScratch, out: BeamPlace,
  acrossAngleDeg = 0,
): void {
  out.xDeg = 0; out.yDeg = 0; out.alongX = 0; out.alongY = 1; out.inFront = false;
  const axes = scratch.axes;
  if (!principalAxes(pose, axes)) return;
  const fx = view[0], fy = view[1], fz = view[2];
  // The frame's up, orthogonal to the forward, and its right.
  const fu = viewUp[0] * fx + viewUp[1] * fy + viewUp[2] * fz;
  let ux = viewUp[0] - fu * fx, uy = viewUp[1] - fu * fy, uz = viewUp[2] - fu * fz;
  const uLen = Math.hypot(ux, uy, uz);
  if (!(uLen > 1e-9)) return;
  ux /= uLen; uy /= uLen; uz /= uLen;
  const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
  const cam = pose.camera;
  // The plane's normal, and the across angle's share of the point.
  const nx = axes[1] * axes[5] - axes[2] * axes[4];
  const ny = axes[2] * axes[3] - axes[0] * axes[5];
  const nz = axes[0] * axes[4] - axes[1] * axes[3];
  const ca = Math.cos(acrossAngleDeg * DEG), sa = Math.sin(acrossAngleDeg * DEG);
  const frameAngles = (phi: number, o: [number, number]): boolean => {
    const c = Math.cos(phi), s = Math.sin(phi);
    const dx = ca * (c * axes[0] + s * axes[3]) + sa * nx - cam[0];
    const dy = ca * (c * axes[1] + s * axes[4]) + sa * ny - cam[1];
    const dz = ca * (c * axes[2] + s * axes[5]) + sa * nz - cam[2];
    const depth = dx * fx + dy * fy + dz * fz;
    if (!(depth > 1e-9)) return false;
    o[0] = Math.atan2(dx * rx + dy * ry + dz * rz, depth) / DEG;
    o[1] = Math.atan2(dx * ux + dy * uy + dz * uz, depth) / DEG;
    return true;
  };
  const phi = groundAngleDeg * DEG;
  const at = scratch.place0, ahead = scratch.place1;
  if (!frameAngles(phi, at)) return;
  out.inFront = true;
  out.xDeg = at[0]; out.yDeg = at[1];
  if (frameAngles(phi + 0.5 * DEG, ahead)) {
    const ax = ahead[0] - at[0], ay = ahead[1] - at[1];
    const len = Math.hypot(ax, ay);
    if (len > 1e-9) { out.alongX = ax / len; out.alongY = ay / len; }
  }
}

/**
 * Scan the principal line, and a band either side of it, for the brightest
 * drawn point of the beam and fit its extent. Returns false, with `out`
 * zeroed, when there is no beam: the camera inside the body, the Sun on the
 * camera's zenith (no principal plane), the Sun under the horizon of every
 * visible point, or no sea in it.
 */
export function scanBeam(
  pose: GlintMeterPose, light: GlintMeterLight, sea: GlintMeterSea,
  sampler: SurfaceSampler, table: TransmittanceTable, scratch: GlintScratch,
  out: BeamPeak, opts?: ScanOptions,
): boolean {
  const o = out as { -readonly [K in keyof BeamPeak]: BeamPeak[K] };
  o.drawnMax = 0; o.groundAngleDeg = 0; o.acrossAngleDeg = 0; o.halfWidthAlongDeg = 0; o.halfWidthAcrossDeg = 0;
  o.carried[0] = o.carried[1] = o.carried[2] = 0;
  o.drawn[0] = o.drawn[1] = o.drawn[2] = 0;
  o.sample.windMs = 0; o.sample.water = 0; o.sample.cloudKeep = 1; o.sample.deckKeep = 1;
  o.sample.axisX = 0; o.sample.axisY = 0;
  const cam = pose.camera;
  const camDist = Math.hypot(cam[0], cam[1], cam[2]);
  if (!(camDist > 1.000001)) return false;
  const axes = scratch.axes;
  if (!principalAxes(pose, axes)) return false;
  const e1x = axes[0], e1y = axes[1], e1z = axes[2];
  const e2x = axes[3], e2y = axes[4], e2z = axes[5];
  // The plane's normal: the direction across the line.
  const ax = e1y * e2z - e1z * e2y, ay = e1z * e2x - e1x * e2z, az = e1x * e2y - e1y * e2x;
  const horizon = Math.acos(1 / camDist);
  const coarse = opts?.coarse ?? 24;
  const refine = opts?.refine ?? 6;
  const besideFloor = opts?.besideFloor ?? 0;
  const lobeHalf = Math.atan(Math.sqrt(meanSquareSlopeOfWind(SCAN_ACROSS_WIND_MS) * Math.LN2));
  const rad = scratch.t; // a free triple while beamRadianceAt is not running
  // A ground point by its angle phi along the line and a across it:
  // cos a (cos phi e1 + sin phi e2) + sin a times the plane's normal.
  const drawnAt = (phi: number, a: number): number => {
    const c = Math.cos(phi), s = Math.sin(phi);
    const ca = Math.cos(a), sa = Math.sin(a);
    beamRadianceAt(
      ca * (c * e1x + s * e2x) + sa * ax, ca * (c * e1y + s * e2y) + sa * ay, ca * (c * e1z + s * e2z) + sa * az,
      pose, light, sea, sampler, table, scratch, rad,
    );
    return drawnMaxOf(rad, sea) * scratch.sample.deckKeep;
  };
  // Whether the sample just read is open sea under a clear sky and a whole
  // Sun, nothing taken from it that the points beside it might keep. Read
  // only after a sample that drew something, which is one that reached the
  // sampler.
  const open = (q: SurfaceSample): boolean =>
    q.water >= 1 && q.cloudKeep >= 1 && q.deckKeep >= 1 && scratch.sunVisible >= 1;
  const halfWidthAcrossAt = (phi: number): number => {
    const c = Math.cos(phi), s = Math.sin(phi);
    return acrossHalfWidthAt(c * e1x + s * e2x, c * e1y + s * e2y, c * e1z + s * e2z, pose, lobeHalf);
  };
  // What open, clear sea at its brightest wind would draw on the line at φ:
  // the points beside it at that step stand further from the mirror, where
  // that bound is lower still, give or take the few percent the Fresnel, the
  // cosines and the air move across two half-widths, which the margin holds.
  const boundAt = (phi: number): number => {
    const c = Math.cos(phi), s = Math.sin(phi);
    beamRadianceAt(c * e1x + s * e2x, c * e1y + s * e2y, c * e1z + s * e2z, pose, light, sea, sampler, table, scratch, rad, true);
    return SCAN_BOUND_MARGIN * drawnMaxOf(rad, sea);
  };
  // Coarse, first along the line, from just inside the sub-camera point to
  // just inside the horizon, noting where the maps cut the line's sample.
  let bestPhi = 0, bestA = 0, best = 0, bestOpen = false;
  const step = horizon / (coarse + 1);
  if (scratch.cut.length <= coarse) scratch.cut = new Uint8Array(coarse + 1);
  const cut = scratch.cut;
  for (let i = 1; i <= coarse; i++) {
    const phi = i * step;
    const d = drawnAt(phi, 0);
    const lineOpen = d > 0 && open(scratch.sample);
    cut[i] = lineOpen ? 0 : 1;
    if (d > best) { best = d; bestPhi = phi; bestA = 0; bestOpen = lineOpen; }
  }
  // Then beside it, at one and two expected half-widths either side, only at
  // a step the maps cut where open sea could still draw more than the scan
  // has found and more than the caller's floor. Where the line reads open
  // sea under a clear sky the beam beside it can only be dimmer at that
  // step, so a uniform sea is scanned exactly as the line alone scanned it;
  // where the line is land, a coast or cloud near the beam, the offsets find
  // the beam beside it. Along a run of such steps every other one is read: a
  // beam is several steps long, so a read beside it still meets it, and the
  // refinement, which reaches a whole step either way, finds its peak; a
  // step on its own is always read.
  let skip = false;
  for (let i = 1; i <= coarse; i++) {
    const phi = i * step;
    if (!cut[i] || !(boundAt(phi) > Math.max(best, besideFloor))) { skip = false; continue; }
    if (skip) { skip = false; continue; }
    skip = true;
    const w = halfWidthAcrossAt(phi);
    for (let j = 0; j < SCAN_ACROSS_STEPS.length; j++) {
      const a = SCAN_ACROSS_STEPS[j] * w;
      const dA = drawnAt(phi, a);
      if (dA > best) { best = dA; bestPhi = phi; bestA = a; bestOpen = false; }
    }
  }
  if (!(best > 0)) return false;
  // Refine by halving both steps about the best, keeping the best of its
  // neighbours when it is better still: along the line always, across it only
  // from a point off the line or one the maps cut, since on the line over
  // open, clear sea both sides are dimmer, and only for the first few
  // halvings (SCAN_REFINE_ACROSS_LEVELS).
  let h = step, hA = halfWidthAcrossAt(bestPhi);
  for (let k = 0; k < refine; k++) {
    h *= 0.5; hA *= 0.5;
    const lo = Math.max(bestPhi - h, step * 0.5), hi = Math.min(bestPhi + h, horizon - step * 0.5);
    let nextPhi = bestPhi, nextA = bestA, next = best, nextOpen = bestOpen;
    const dLo = drawnAt(lo, bestA);
    if (dLo > next) { next = dLo; nextPhi = lo; nextOpen = bestA === 0 && open(scratch.sample); }
    const dHi = drawnAt(hi, bestA);
    if (dHi > next) { next = dHi; nextPhi = hi; nextOpen = bestA === 0 && open(scratch.sample); }
    if ((bestA !== 0 || !bestOpen) && k < SCAN_REFINE_ACROSS_LEVELS) {
      const dNeg = drawnAt(bestPhi, bestA - hA);
      if (dNeg > next) { next = dNeg; nextPhi = bestPhi; nextA = bestA - hA; nextOpen = false; }
      const dPos = drawnAt(bestPhi, bestA + hA);
      if (dPos > next) { next = dPos; nextPhi = bestPhi; nextA = bestA + hA; nextOpen = false; }
    }
    best = next; bestPhi = nextPhi; bestA = nextA; bestOpen = nextOpen;
  }
  // The peak itself, per channel.
  const c = Math.cos(bestPhi), s = Math.sin(bestPhi);
  const ca = Math.cos(bestA), sa = Math.sin(bestA);
  const lineX = c * e1x + s * e2x, lineY = c * e1y + s * e2y, lineZ = c * e1z + s * e2z;
  const px = ca * lineX + sa * ax, py = ca * lineY + sa * ay, pz = ca * lineZ + sa * az;
  beamRadianceAt(px, py, pz, pose, light, sea, sampler, table, scratch, o.carried);
  // The sampler ran for the peak inside that call; keep its reading before
  // the extent's samples overwrite the scratch.
  o.sample.windMs = scratch.sample.windMs;
  o.sample.water = scratch.sample.water; o.sample.cloudKeep = scratch.sample.cloudKeep;
  o.sample.deckKeep = scratch.sample.deckKeep;
  o.sample.axisX = scratch.sample.axisX; o.sample.axisY = scratch.sample.axisY;
  const deck = scratch.sample.deckKeep;
  o.drawn[0] = shoulder(o.carried[0], sea.knee, sea.cap) * deck;
  o.drawn[1] = shoulder(o.carried[1], sea.knee, sea.cap) * deck;
  o.drawn[2] = shoulder(o.carried[2], sea.knee, sea.cap) * deck;
  o.drawnMax = Math.max(o.drawn[0], o.drawn[1], o.drawn[2]);
  o.n[0] = px; o.n[1] = py; o.n[2] = pz;
  o.groundAngleDeg = bestPhi / DEG;
  o.acrossAngleDeg = bestA / DEG;
  // The extent: a Gaussian fall fitted from one sample a small ground angle
  // away, the angle widened until the sample has fallen enough to read.
  const peak = o.drawnMax;
  const halfWidthFrom = (dirX: number, dirY: number, dirZ: number): number => {
    let delta = 0.3 * DEG;
    for (let tries = 0; tries < 4; tries++) {
      const cd = Math.cos(delta), sdl = Math.sin(delta);
      const qx = cd * px + sdl * dirX, qy = cd * py + sdl * dirY, qz = cd * pz + sdl * dirZ;
      beamRadianceAt(qx, qy, qz, pose, light, sea, sampler, table, scratch, rad);
      const v = drawnMaxOf(rad, sea) * scratch.sample.deckKeep;
      const ratio = v / peak;
      if (ratio < 0.9 && ratio > 1e-3) {
        const halfGround = delta * Math.sqrt(Math.LN2 / Math.log(peak / v));
        const ch = Math.cos(halfGround), sh = Math.sin(halfGround);
        return angleBetweenFrom(cam, px, py, pz, ch * px + sh * dirX, ch * py + sh * dirY, ch * pz + sh * dirZ);
      }
      if (ratio <= 1e-3) return angleBetweenFrom(cam, px, py, pz, qx, qy, qz);
      delta *= 3;
    }
    // Still within a tenth of the peak three degrees out: a broad sheen; report that span.
    const cd = Math.cos(delta), sdl = Math.sin(delta);
    return angleBetweenFrom(cam, px, py, pz, cd * px + sdl * dirX, cd * py + sdl * dirY, cd * pz + sdl * dirZ);
  };
  // Along the line the beam is asymmetric: it falls slowly toward the camera
  // and fast toward the horizon, so both sides are read and averaged. The
  // tangent of the circle at the peak in the e1/e2 plane points to higher φ,
  // and is square to the peak wherever across the line it sits.
  const tx = -s * e1x + c * e2x, ty = -s * e1y + c * e2y, tz = -s * e1z + c * e2z;
  o.halfWidthAlongDeg = 0.5 * (halfWidthFrom(-tx, -ty, -tz) + halfWidthFrom(tx, ty, tz));
  // Across: the plane's normal, turned with the peak when it sits off the line.
  o.halfWidthAcrossDeg = halfWidthFrom(ca * ax - sa * lineX, ca * ay - sa * lineY, ca * az - sa * lineZ);
  return true;
}

/**
 * The beam's share of a frame from its half-maximum ellipse, as angles.
 * Given its place, the ellipse sits where the peak lands, turned to the
 * principal line's direction there, and only the part inside the frame
 * counts: the ellipse's bounding box is cut by the frame's edges and the
 * ellipse takes the same share of the cut box as it does of the whole one,
 * so a beam wholly in view is exactly its area over the frame's, a beam
 * half off the side is about half, and a beam behind the camera or past
 * the edge is nothing — which is what keeps the meter from darkening a
 * frame the beam is not in. Without a place the whole ellipse counts.
 */
export function coverageOfBeam(
  halfWidthAlongDeg: number, halfWidthAcrossDeg: number, fovXDeg: number, fovYDeg: number, place?: BeamPlace,
): number {
  const area = Math.PI * halfWidthAlongDeg * halfWidthAcrossDeg;
  const frame = Math.max(fovXDeg * fovYDeg, 1e-6);
  if (!place) return Math.min(Math.max(area / frame, 0), 1);
  if (!place.inFront) return 0;
  const hx = Math.hypot(halfWidthAlongDeg * place.alongX, halfWidthAcrossDeg * place.alongY);
  const hy = Math.hypot(halfWidthAlongDeg * place.alongY, halfWidthAcrossDeg * place.alongX);
  const box = 4 * hx * hy;
  if (!(box > 0)) return 0;
  const ix = Math.max(0, Math.min(place.xDeg + hx, fovXDeg / 2) - Math.max(place.xDeg - hx, -fovXDeg / 2));
  const iy = Math.max(0, Math.min(place.yDeg + hy, fovYDeg / 2) - Math.max(place.yDeg - hy, -fovYDeg / 2));
  return Math.min(Math.max((area * ((ix * iy) / box)) / frame, 0), 1);
}

export interface HighlightKnobs {
  /** Where the brightest drawn pixel should land after exposure, in scene
   *  units: two at baseline 1, riding SUN_LIGHT_BASELINE like every threshold
   *  authored in scene units, so it stays the same number of whites. */
  readonly target: number;
  /** The most the meter may lower the exposure (0.25 = two stops). */
  readonly floor: number;
  /** The coverage the meter starts to act at, and where it acts in full. */
  readonly fadeLo: number;
  readonly fadeHi: number;
}

export const HIGHLIGHT_KNOBS: HighlightKnobs = { target: 2 * SUN_LIGHT_BASELINE, floor: 0.25, fadeLo: 0.002, fadeHi: 0.02 };

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(Math.max((x - lo) / Math.max(hi - lo, 1e-9), 0), 1);
  return t * t * (3 - 2 * t);
}

/** The exposure the beam asks for: 1 unless its drawn maximum is over the
 *  target, never under the floor, faded in with its share of the frame. */
export function highlightTarget(drawnMax: number, coverage: number, knobs: HighlightKnobs = HIGHLIGHT_KNOBS): number {
  if (!(drawnMax > knobs.target) || !(coverage > 0)) return 1;
  const raw = Math.max(knobs.target / drawnMax, knobs.floor);
  const e = 1 + (raw - 1) * smoothstep(knobs.fadeLo, knobs.fadeHi, coverage);
  return Number.isFinite(e) ? Math.min(Math.max(e, knobs.floor), 1) : 1;
}

/** One step of the adaptation, in stops: toward the target at `downStopsPerS`
 *  when lowering and `upStopsPerS` when recovering, snapped to exactly 1 when
 *  within a thousandth of a stop of it, so a far pose reads 1 and not 0.9999. */
export function advanceExposureStops(current: number, target: number, dt: number, downStopsPerS: number, upStopsPerS: number): number {
  const cur = Math.log2(Math.max(current, 1e-6));
  const tgt = Math.log2(Math.max(target, 1e-6));
  const delta = tgt - cur;
  const rate = delta < 0 ? downStopsPerS : upStopsPerS;
  const stepped = cur + Math.sign(delta) * Math.min(Math.abs(delta), rate * Math.max(dt, 0));
  if (Math.abs(stepped) < 1e-3) return 1;
  return Math.pow(2, stepped);
}
