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
 *     body's distance, times cos of incidence;
 *   - the Sun's own path, T(1, μs) / T(1, 1), clamped at 1, blended by the
 *     air's blend;
 *   - water's Fresnel on the half vector, three's exp2 Schlick on SEA_WATER_F0;
 *   - the two Beckmann lobes at the half vector, each with Beckmann's own
 *     Smith visibility (which carries the 1 / (4 cos cos)), mixed by the calm
 *     share: the calm lobe at the calm wind, the windy one at the map's wind;
 *   - the water fraction, which the shader mixes the mirror term by;
 *   - the cloud's keep over the point, which cuts the beam before the deck
 *     covers it;
 *   - the camera leg as the shader applies it: not plain transmittance but
 *     mix(1, T(1, μv), airWeight) with airWeight the air's blend times the
 *     haze grade's weight mix(clearView, 1, (1 − μv)²), the camera taken as
 *     above the air (the leg from the top boundary down to the point);
 *   - then the shoulder, per channel.
 * The air's in-scatter is left out on purpose: the probe's keep-on minus
 * keep-off difference cancels it, so the oracle and the prediction compare
 * like with like, and for a meter that only lowers the exposure the omission
 * sits on the safe side. The relief's geometry roughness, a per-pixel
 * derivative term, is below the meter's resolution and left out too.
 *
 * The brightest drawn point is not the mirror point: the Fresnel, the view
 * cosine and the shadowing move it toward the horizon, so the radiance is
 * scanned along the principal line (the great circle through the sub-camera
 * and sub-Sun points) and the maximum taken, then refined. The beam's extent
 * is fitted from one sample along and one across the line as a Gaussian fall
 * from the peak, and handed back as the angles the half-maximum half-widths
 * subtend at the camera, for the caller to turn into a share of the frame.
 */
import type { AtmosphereParams, RGB } from './atmosphereModel';
import { transmittanceToTopBoundary } from './atmosphereModel';
import { SUN_LIGHT_BASELINE } from '../sunLight';
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
  /** The calm lobe's mean-square slope (the calm wind through Cox-Munk). */
  readonly calmMss: number;
  readonly knee: number;
  readonly cap: number;
  /** The haze grade on a direct view (SURFACE_HAZE_CLEAR_VIEW for Earth). */
  readonly hazeClearView: number;
  /** The air's blend, 1 once the tables are in. */
  readonly airBlend: number;
}

/** What the maps say at a ground point. */
export interface SurfaceSample {
  /** The share of the texel that is glassy, 0..1. */
  calm: number;
  /** The wind of the rest, m/s. */
  windMs: number;
  /** The water fraction, 0..1. */
  water: number;
  /** The share of the Sun's beam the cloud over the point lets through, 0..1. */
  cloudKeep: number;
}

/** Fills `out` with the maps' values at the unit direction (body frame);
 *  three numbers rather than a vector so a frame allocates nothing. */
export type SurfaceSampler = (nx: number, ny: number, nz: number, out: SurfaceSample) => void;

export interface GlintMeterPose {
  /** The camera relative to the body's centre, in radii. */
  readonly camera: Vec3;
  /** The Sun relative to the body's centre, in radii (finite). */
  readonly sun: Vec3;
  /** The Sun's visible fraction at the body (its eclipse), 0..1. */
  readonly sunVisible: number;
}

/** The transmittance to the top of the air from the ground, per channel, as a
 *  function of the cosine of the zenith angle: the one table both legs read. */
export interface TransmittanceTable {
  readonly muMin: number;
  readonly samples: number;
  /** samples × 3, channel-interleaved, μ from muMin to 1. */
  readonly values: Float32Array;
}

export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** Cox-Munk: the sea's mean-square slope for a wind, as world/seaWind has it. */
export function meanSquareSlopeOfWind(windMs: number): number {
  return COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * Math.max(windMs, 0);
}

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
  return { muMin, samples, values };
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

/** The shoulder the shader applies after the air: the term to the knee, then
 *  an exponential approach to the cap, per channel. */
export function shoulder(v: number, knee: number, cap: number): number {
  if (v <= knee) return v;
  const range = cap - knee;
  return knee + range * (1 - Math.exp(-(v - knee) / range));
}

/** Scratch the evaluation reuses, so a frame allocates nothing. */
export interface GlintScratch {
  sample: SurfaceSample;
  t: [number, number, number];
  tz: [number, number, number];
  /** The principal plane's axes (principalAxes) and two frame-angle pairs. */
  axes: Float64Array;
  place0: [number, number];
  place1: [number, number];
}

export function createGlintScratch(): GlintScratch {
  return {
    sample: { calm: 0, windMs: 0, water: 0, cloudKeep: 1 }, t: [0, 0, 0], tz: [0, 0, 0],
    axes: new Float64Array(6), place0: [0, 0], place1: [0, 0],
  };
}

/**
 * The beam's radiance as carried to the camera at the ground point with unit
 * normal (nx, ny, nz), per channel into `out`, before the shoulder. Zero when
 * the point is unlit, below the horizon, or not sea.
 */
export function beamRadianceAt(
  nx: number, ny: number, nz: number,
  pose: GlintMeterPose, light: GlintMeterLight, sea: GlintMeterSea,
  sampler: SurfaceSampler, table: TransmittanceTable, scratch: GlintScratch,
  out: [number, number, number],
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
  sampler(nx, ny, nz, scratch.sample);
  const s = scratch.sample;
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
  const mssWindy = meanSquareSlopeOfWind(s.windMs);
  const windy = beckmannLobe(nh, mssWindy)
    * beckmannG1(nl, Math.sqrt(mssWindy)) * beckmannG1(nv, Math.sqrt(mssWindy)) / Math.max(4 * nl * nv, 1e-6);
  const calm = s.calm > 0
    ? beckmannLobe(nh, sea.calmMss)
      * beckmannG1(nl, Math.sqrt(sea.calmMss)) * beckmannG1(nv, Math.sqrt(sea.calmMss)) / Math.max(4 * nl * nv, 1e-6)
    : 0;
  const lobe = windy * (1 - s.calm) + calm * s.calm;
  // The Sun's path, normalised at the zenith, clamped, blended; the camera
  // leg through the haze grade's weight.
  lookupTransmittance(table, nl, scratch.t);
  lookupTransmittance(table, 1, scratch.tz);
  const grazing = 1 - nv;
  const airWeight = sea.airBlend * (sea.hazeClearView + (1 - sea.hazeClearView) * grazing * grazing);
  const irradiance = light.intensity * light.irradianceScale * nl * pose.sunVisible;
  const common = irradiance * fresnel * lobe * s.water * s.cloudKeep;
  const tv = scratch.tz; // reused below for the view leg once the zenith is read
  const tz0 = scratch.tz[0], tz1 = scratch.tz[1], tz2 = scratch.tz[2];
  const sp0 = 1 + (Math.min(scratch.t[0] / Math.max(tz0, 1e-4), 1) - 1) * sea.airBlend;
  const sp1 = 1 + (Math.min(scratch.t[1] / Math.max(tz1, 1e-4), 1) - 1) * sea.airBlend;
  const sp2 = 1 + (Math.min(scratch.t[2] / Math.max(tz2, 1e-4), 1) - 1) * sea.airBlend;
  lookupTransmittance(table, nv, tv);
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
  /** The carried radiance at the peak, per channel. */
  readonly carried: [number, number, number];
  /** The drawn radiance at the peak, per channel, after the shoulder. */
  readonly drawn: [number, number, number];
  /** The drawn maximum channel: what the meter protects. */
  readonly drawnMax: number;
  /** Half-maximum half-widths of the drawn beam as angles subtended at the
   *  camera, degrees: along the principal line and across it. */
  readonly halfWidthAlongDeg: number;
  readonly halfWidthAcrossDeg: number;
  /** The surface at the peak as the sampler read it: the water, the calm
   *  share, the wind and the cloud's keep, so a probe can tell a beam under
   *  cloud from a beam the prediction missed. */
  readonly sample: SurfaceSample;
}

export interface ScanOptions {
  /** Coarse samples along the visible part of the line. */
  readonly coarse?: number;
  /** Refinement steps about the best coarse sample. */
  readonly refine?: number;
}

/** A result holder the caller keeps, so a frame allocates nothing. */
export function createBeamPeak(): BeamPeak {
  return {
    n: [0, 0, 0], groundAngleDeg: 0, carried: [0, 0, 0], drawn: [0, 0, 0], drawnMax: 0,
    halfWidthAlongDeg: 0, halfWidthAcrossDeg: 0,
    sample: { calm: 0, windMs: 0, water: 0, cloudKeep: 1 },
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
 * cross product. The peak sits on the principal line at `groundAngleDeg`
 * from the sub-camera point, and the line's direction in the frame is read
 * from a second point half a degree further along it. A point at or behind
 * the camera's plane is not in front, and the place is left at the centre.
 */
export function placeBeamInFrame(
  pose: GlintMeterPose, groundAngleDeg: number, view: Vec3, viewUp: Vec3, scratch: GlintScratch, out: BeamPlace,
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
  const frameAngles = (phi: number, o: [number, number]): boolean => {
    const c = Math.cos(phi), s = Math.sin(phi);
    const dx = c * axes[0] + s * axes[3] - cam[0];
    const dy = c * axes[1] + s * axes[4] - cam[1];
    const dz = c * axes[2] + s * axes[5] - cam[2];
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
 * Scan the principal line for the brightest drawn point of the beam and fit
 * its extent. Returns false, with `out` zeroed, when there is no beam: the
 * camera inside the body, the Sun on the camera's zenith (no principal
 * plane), the Sun under the horizon of every visible point, or no sea in it.
 */
export function scanBeam(
  pose: GlintMeterPose, light: GlintMeterLight, sea: GlintMeterSea,
  sampler: SurfaceSampler, table: TransmittanceTable, scratch: GlintScratch,
  out: BeamPeak, opts?: ScanOptions,
): boolean {
  const o = out as { -readonly [K in keyof BeamPeak]: BeamPeak[K] };
  o.drawnMax = 0; o.groundAngleDeg = 0; o.halfWidthAlongDeg = 0; o.halfWidthAcrossDeg = 0;
  o.carried[0] = o.carried[1] = o.carried[2] = 0;
  o.drawn[0] = o.drawn[1] = o.drawn[2] = 0;
  o.sample.calm = 0; o.sample.windMs = 0; o.sample.water = 0; o.sample.cloudKeep = 1;
  const cam = pose.camera;
  const camDist = Math.hypot(cam[0], cam[1], cam[2]);
  if (!(camDist > 1.000001)) return false;
  const axes = scratch.axes;
  if (!principalAxes(pose, axes)) return false;
  const e1x = axes[0], e1y = axes[1], e1z = axes[2];
  const e2x = axes[3], e2y = axes[4], e2z = axes[5];
  const horizon = Math.acos(1 / camDist);
  const coarse = opts?.coarse ?? 24;
  const refine = opts?.refine ?? 6;
  const rad = scratch.t; // a free triple while beamRadianceAt is not running
  const drawnAt = (phi: number): number => {
    const c = Math.cos(phi), s = Math.sin(phi);
    beamRadianceAt(c * e1x + s * e2x, c * e1y + s * e2y, c * e1z + s * e2z, pose, light, sea, sampler, table, scratch, rad);
    return Math.max(shoulder(rad[0], sea.knee, sea.cap), shoulder(rad[1], sea.knee, sea.cap), shoulder(rad[2], sea.knee, sea.cap));
  };
  // Coarse: from just inside the sub-camera point to just inside the horizon.
  let bestPhi = 0, best = 0;
  const step = horizon / (coarse + 1);
  for (let i = 1; i <= coarse; i++) {
    const phi = i * step;
    const d = drawnAt(phi);
    if (d > best) { best = d; bestPhi = phi; }
  }
  if (!(best > 0)) return false;
  // Refine by halving the step about the best, keeping the better neighbour.
  let h = step;
  for (let k = 0; k < refine; k++) {
    h *= 0.5;
    const lo = Math.max(bestPhi - h, step * 0.5), hi = Math.min(bestPhi + h, horizon - step * 0.5);
    const dLo = drawnAt(lo), dHi = drawnAt(hi);
    if (dLo > best && dLo >= dHi) { best = dLo; bestPhi = lo; } else if (dHi > best) { best = dHi; bestPhi = hi; }
  }
  // The peak itself, per channel.
  const c = Math.cos(bestPhi), s = Math.sin(bestPhi);
  const px = c * e1x + s * e2x, py = c * e1y + s * e2y, pz = c * e1z + s * e2z;
  beamRadianceAt(px, py, pz, pose, light, sea, sampler, table, scratch, o.carried);
  // The sampler ran for the peak inside that call; keep its reading before
  // the extent's samples overwrite the scratch.
  o.sample.calm = scratch.sample.calm; o.sample.windMs = scratch.sample.windMs;
  o.sample.water = scratch.sample.water; o.sample.cloudKeep = scratch.sample.cloudKeep;
  o.drawn[0] = shoulder(o.carried[0], sea.knee, sea.cap);
  o.drawn[1] = shoulder(o.carried[1], sea.knee, sea.cap);
  o.drawn[2] = shoulder(o.carried[2], sea.knee, sea.cap);
  o.drawnMax = Math.max(o.drawn[0], o.drawn[1], o.drawn[2]);
  o.n[0] = px; o.n[1] = py; o.n[2] = pz;
  o.groundAngleDeg = bestPhi / DEG;
  // The extent: a Gaussian fall fitted from one sample a small ground angle
  // away, the angle widened until the sample has fallen enough to read.
  const peak = o.drawnMax;
  const halfWidthFrom = (dirX: number, dirY: number, dirZ: number): number => {
    let delta = 0.3 * DEG;
    for (let tries = 0; tries < 4; tries++) {
      const cd = Math.cos(delta), sdl = Math.sin(delta);
      const qx = cd * px + sdl * dirX, qy = cd * py + sdl * dirY, qz = cd * pz + sdl * dirZ;
      beamRadianceAt(qx, qy, qz, pose, light, sea, sampler, table, scratch, rad);
      const v = Math.max(shoulder(rad[0], sea.knee, sea.cap), shoulder(rad[1], sea.knee, sea.cap), shoulder(rad[2], sea.knee, sea.cap));
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
  // tangent of the circle at the peak in the e1/e2 plane points to higher φ.
  const tx = -s * e1x + c * e2x, ty = -s * e1y + c * e2y, tz = -s * e1z + c * e2z;
  o.halfWidthAlongDeg = 0.5 * (halfWidthFrom(-tx, -ty, -tz) + halfWidthFrom(tx, ty, tz));
  // Across: the plane's normal.
  const ax = e1y * e2z - e1z * e2y, ay = e1z * e2x - e1x * e2z, az = e1x * e2y - e1y * e2x;
  o.halfWidthAcrossDeg = halfWidthFrom(ax, ay, az);
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
