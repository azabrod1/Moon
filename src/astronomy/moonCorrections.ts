/**
 * Corrections to the mean-element moons (satellites.ts), fitted to JPL's
 * satellite ephemerides by tools/moon-corrections (`npm run
 * gen:moon-corrections`) and shipped as public/ephemeris/moon-corrections.v1.bin.
 * world/ephemerisLoader.ts installs them at boot beside the fitted ephemeris,
 * and the test setup installs them in tests.
 *
 * The mean elements drift: across 1900–2100 Titan wanders up to 200,000 km
 * along its orbit and Mimas half an orbit. Each correction is a sum of terms
 * in the model's own frame, radial (r̂ = p/|p|), along-track (t̂ = n̂ × r̂) and
 * normal (n̂, the model's orbit normal):
 *   δc(t) = Σₖ Aₖc(t) cos ψₖ + Bₖc(t) sin ψₖ,   ψₖ = rateₖ · (jd − phaseOriginJd)
 * where Aₖc and Bₖc are uniform cubic B-splines in time and each rate is a
 * line found in the residual's spectrum (forced eccentricities, true nodes,
 * resonance and reflex terms). The worst error on Horizons samples the fit
 * never saw is in the file, per moon (tens of km for most).
 *
 * The fit holds from 1900-01-01 to 2100-06-16 and was fitted to data two
 * years past each end. Across those two years the correction eases out to the
 * bare mean elements: a turn through the in-plane angle and a scaling of the
 * radius, never a straight line, because a straight line from a moon to the
 * far side of its orbit passes through the planet.
 *
 * A file fitted to other elements than the ones in satelliteElements.ts is
 * worse than none, so each moon carries its mean-element position at two
 * epochs; a moon whose elements no longer give those positions installs
 * without its correction (moonCorrections.test.ts fails on it).
 *
 * Format v1 (little-endian), as tools/moon-corrections/encode.py writes it:
 *   header    magic 'MSCR' | version u16 | moonCount u16 | phaseOriginJd f64
 *             | splineStartJd f64 | splineEndJd f64 | windowStartJd f64
 *             | windowEndJd f64 | guardJd f64 ×2
 *   per moon  nameLength u8 | name | termCount u16 | heldOutKm f32
 *             | guard position at each guard date, km, ICRF axes, f64 ×6
 *   per term  rate f64 (rad/day) | knotDays f32 | basisCount u16 | flags u8
 *             (bit 0: the constant term, cosine only; bits 1–3: R, T, N
 *             stored), then per stored component in R, T, N order: scale f32
 *             | basisCount × (1 or 2) int16, basis-major (A0 B0 A1 B1 …)
 */
import * as THREE from 'three';
import { KM_PER_AU } from './constants';

export const MOON_CORRECTIONS_FILE = 'ephemeris/moon-corrections.v1.bin';

/** Days past each end of the window across which a correction eases out. */
export const MOON_CORRECTION_BLEND_DAYS = 730;

const MAGIC = 'MSCR';
const VERSION = 1;
/** How far a guard position may be from the elements' own, km: far above
 *  arithmetic noise, far below any change to an element. */
const GUARD_TOLERANCE_KM = 1e-3;

export interface MoonCorrectionTerm {
  rate: number;
  knotDays: number;
  basisCount: number;
  /** 1 for the constant term (A only), else 2 (A and B). */
  trigCount: 1 | 2;
  /** R, T, N: the decoded coefficients in km, or null where not stored. */
  components: [Float64Array | null, Float64Array | null, Float64Array | null];
}

export interface MoonCorrection {
  name: string;
  /** The fit's worst error on held-out Horizons samples, km. */
  heldOutKm: number;
  /** Mean-element position at each guard date, km, ICRF axes (x, y, z ×2). */
  guardKm: Float64Array;
  terms: MoonCorrectionTerm[];
}

export interface MoonCorrectionSet {
  phaseOriginJd: number;
  splineStartJd: number;
  splineEndJd: number;
  windowStartJd: number;
  windowEndJd: number;
  guardJd: [number, number];
  moons: ReadonlyMap<string, MoonCorrection>;
}

/** Parse the shipped file. Throws on anything that is not a complete v1
 *  file: a truncated download must never install as fewer moons. */
export function parseMoonCorrections(buffer: ArrayBuffer): MoonCorrectionSet {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  if (buffer.byteLength < 64 || decoder.decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('moon corrections: bad magic');
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`moon corrections: unsupported version ${version}`);
  const moonCount = view.getUint16(6, true);
  const moons = new Map<string, MoonCorrection>();
  const set: MoonCorrectionSet = {
    phaseOriginJd: view.getFloat64(8, true),
    splineStartJd: view.getFloat64(16, true),
    splineEndJd: view.getFloat64(24, true),
    windowStartJd: view.getFloat64(32, true),
    windowEndJd: view.getFloat64(40, true),
    guardJd: [view.getFloat64(48, true), view.getFloat64(56, true)],
    moons,
  };
  let at = 64;
  const need = (byteCount: number) => {
    if (at + byteCount > buffer.byteLength) throw new Error('moon corrections: truncated');
  };
  for (let moonIndex = 0; moonIndex < moonCount; moonIndex++) {
    need(1);
    const nameLength = view.getUint8(at);
    need(1 + nameLength + 6 + 48);
    const name = decoder.decode(bytes.subarray(at + 1, at + 1 + nameLength));
    at += 1 + nameLength;
    const termCount = view.getUint16(at, true);
    const heldOutKm = view.getFloat32(at + 2, true);
    at += 6;
    const guardKm = new Float64Array(6);
    for (let index = 0; index < 6; index++, at += 8) guardKm[index] = view.getFloat64(at, true);
    const terms: MoonCorrectionTerm[] = [];
    for (let termIndex = 0; termIndex < termCount; termIndex++) {
      need(15);
      const rate = view.getFloat64(at, true);
      const knotDays = view.getFloat32(at + 8, true);
      const basisCount = view.getUint16(at + 12, true);
      const flags = view.getUint8(at + 14);
      at += 15;
      if (basisCount < 4 || !(knotDays > 0)) throw new Error(`moon corrections: bad term for ${name}`);
      const trigCount: 1 | 2 = flags & 1 ? 1 : 2;
      const components: MoonCorrectionTerm['components'] = [null, null, null];
      for (let component = 0; component < 3; component++) {
        if (!(flags & (2 << component))) continue;
        const valueCount = basisCount * trigCount;
        need(4 + 2 * valueCount);
        const scale = view.getFloat32(at, true);
        at += 4;
        const values = new Float64Array(valueCount);
        for (let index = 0; index < valueCount; index++, at += 2) values[index] = view.getInt16(at, true) * scale;
        components[component] = values;
      }
      terms.push({ rate, knotDays, basisCount, trigCount, components });
    }
    moons.set(name, { name, heldOutKm, guardKm, terms });
  }
  if (at !== buffer.byteLength) throw new Error('moon corrections: trailing bytes');
  return set;
}

/**
 * The correction in km in the model's R, T, N frame at a TT Julian Date,
 * written into out[0..2]. Valid on the set's spline range; callers go through
 * `correctMoonOffsetAU`, which blends it out beyond the window. Allocates
 * nothing.
 */
export function moonCorrectionRtnKm(
  set: MoonCorrectionSet,
  moon: MoonCorrection,
  jdTT: number,
  out: Float64Array,
): Float64Array {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const sincePhaseOrigin = jdTT - set.phaseOriginJd;
  const sinceSplineStart = jdTT - set.splineStartJd;
  for (const term of moon.terms) {
    const knots = sinceSplineStart / term.knotDays;
    const segment = Math.min(Math.max(Math.floor(knots), 0), term.basisCount - 4);
    const u = knots - segment;
    const uSquared = u * u;
    const uCubed = uSquared * u;
    const oneMinusU = 1 - u;
    const weight0 = (oneMinusU * oneMinusU * oneMinusU) / 6;
    const weight1 = (3 * uCubed - 6 * uSquared + 4) / 6;
    const weight2 = (-3 * uCubed + 3 * uSquared + 3 * u + 1) / 6;
    const weight3 = uCubed / 6;
    const stride = term.trigCount;
    let cosPsi = 1;
    let sinPsi = 0;
    if (stride === 2) {
      const psi = term.rate * sincePhaseOrigin;
      cosPsi = Math.cos(psi);
      sinPsi = Math.sin(psi);
    }
    const base = segment * stride;
    for (let component = 0; component < 3; component++) {
      const values = term.components[component];
      if (!values) continue;
      let value =
        (weight0 * values[base] +
          weight1 * values[base + stride] +
          weight2 * values[base + 2 * stride] +
          weight3 * values[base + 3 * stride]) *
        cosPsi;
      if (stride === 2) {
        value +=
          (weight0 * values[base + 1] +
            weight1 * values[base + stride + 1] +
            weight2 * values[base + 2 * stride + 1] +
            weight3 * values[base + 3 * stride + 1]) *
          sinPsi;
      }
      out[component] += value;
    }
  }
  return out;
}

/** How much of the correction applies at a TT Julian Date: 1 across the
 *  window, easing (smoothstep) to 0 over the blend days past each end. */
export function moonCorrectionWeight(set: MoonCorrectionSet, jdTT: number): number {
  const outsideDays = Math.max(set.windowStartJd - jdTT, jdTT - set.windowEndJd);
  if (outsideDays <= 0) return 1;
  if (!(outsideDays < MOON_CORRECTION_BLEND_DAYS)) return 0;
  const progress = 1 - outsideDays / MOON_CORRECTION_BLEND_DAYS;
  return progress * progress * (3 - 2 * progress);
}

interface InstalledMoon {
  correction: MoonCorrection;
  /** The correction's in-plane angle (radians, from r̂ toward t̂) at each end
   *  of the window: the blend unwraps against it, so a correction near half
   *  an orbit cannot flip sides between frames. */
  startAngle: number;
  endAngle: number;
}

let installedSet: MoonCorrectionSet | null = null;
const installedMoons = new Map<string, InstalledMoon>();

const rtnScratch = new Float64Array(3);
const radialScratch = new THREE.Vector3();
const alongScratch = new THREE.Vector3();
const guardScratch = new THREE.Vector3();
const guardNormalScratch = new THREE.Vector3();

/** The mean-element model, as satellites.ts provides it: position (AU, scene
 *  frame) and its orbit normal at a TT Julian Date. */
export type MeanElementModel = (name: string, jdTT: number, out: THREE.Vector3, outNormal: THREE.Vector3) => void;

function inPlaneAngle(
  set: MoonCorrectionSet,
  correction: MoonCorrection,
  model: MeanElementModel,
  jdTT: number,
): number {
  model(correction.name, jdTT, guardScratch, guardNormalScratch);
  moonCorrectionRtnKm(set, correction, jdTT, rtnScratch);
  return Math.atan2(rtnScratch[1], guardScratch.length() * KM_PER_AU + rtnScratch[0]);
}

/**
 * Install a parsed set (null clears it). Each moon is checked against the
 * mean elements it was fitted to; the names of moons that fail are returned
 * and install without a correction.
 */
export function setMoonCorrections(set: MoonCorrectionSet | null, model: MeanElementModel): string[] {
  installedSet = null;
  installedMoons.clear();
  if (!set) return [];
  const rejected: string[] = [];
  for (const correction of set.moons.values()) {
    let matches = true;
    for (let guardIndex = 0; guardIndex < 2; guardIndex++) {
      try {
        model(correction.name, set.guardJd[guardIndex], guardScratch, guardNormalScratch);
      } catch {
        matches = false;
        break;
      }
      // Scene (x, y, z) is ICRF (x, z, −y).
      const at = guardIndex * 3;
      const offsetKm = Math.hypot(
        guardScratch.x * KM_PER_AU - correction.guardKm[at],
        -guardScratch.z * KM_PER_AU - correction.guardKm[at + 1],
        guardScratch.y * KM_PER_AU - correction.guardKm[at + 2],
      );
      if (!(offsetKm <= GUARD_TOLERANCE_KM)) matches = false;
    }
    if (!matches) {
      rejected.push(correction.name);
      continue;
    }
    installedMoons.set(correction.name, {
      correction,
      startAngle: inPlaneAngle(set, correction, model, set.windowStartJd),
      endAngle: inPlaneAngle(set, correction, model, set.windowEndJd),
    });
  }
  installedSet = set;
  return rejected;
}

/** Whether a correction is installed for this moon. */
export function moonCorrectionInstalled(name: string): boolean {
  return installedMoons.has(name);
}

/** Every moon with an installed correction. */
export function correctedMoonNames(): string[] {
  return [...installedMoons.keys()];
}

/**
 * Correct a mean-element offset in place: `offsetAU` is the model's position
 * (AU, any frame) and `orbitNormal` its unit orbit normal in the same frame,
 * both at `jdTT`. Moons without a correction, and dates past the blend, come
 * back untouched. Allocates nothing.
 */
export function correctMoonOffsetAU(
  name: string,
  jdTT: number,
  offsetAU: THREE.Vector3,
  orbitNormal: THREE.Vector3,
): THREE.Vector3 {
  const set = installedSet;
  const installed = installedMoons.get(name);
  if (!set || !installed) return offsetAU;
  const weight = moonCorrectionWeight(set, jdTT);
  if (weight <= 0) return offsetAU;
  const radiusAU = offsetAU.length();
  if (!(radiusAU > 0)) return offsetAU;
  moonCorrectionRtnKm(set, installed.correction, jdTT, rtnScratch);
  const radial = radialScratch.copy(offsetAU).divideScalar(radiusAU);
  const along = alongScratch.crossVectors(orbitNormal, radial);
  if (weight >= 1) {
    return offsetAU
      .addScaledVector(radial, rtnScratch[0] / KM_PER_AU)
      .addScaledVector(along, rtnScratch[1] / KM_PER_AU)
      .addScaledVector(orbitNormal, rtnScratch[2] / KM_PER_AU);
  }
  // Past the window: turn through a share of the in-plane angle and scale the
  // radius by the same share, unwrapped against the angle at the nearer end.
  const radiusKm = radiusAU * KM_PER_AU;
  const correctedX = radiusKm + rtnScratch[0];
  const correctedY = rtnScratch[1];
  const edgeAngle = jdTT < set.windowStartJd ? installed.startAngle : installed.endAngle;
  let angle = Math.atan2(correctedY, correctedX) - edgeAngle;
  angle -= 2 * Math.PI * Math.round(angle / (2 * Math.PI));
  angle = (angle + edgeAngle) * weight;
  const blendedRadiusAU = (radiusKm + (Math.hypot(correctedX, correctedY) - radiusKm) * weight) / KM_PER_AU;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  return offsetAU
    .set(0, 0, 0)
    .addScaledVector(radial, blendedRadiusAU * cosAngle)
    .addScaledVector(along, blendedRadiusAU * sinAngle)
    .addScaledVector(orbitNormal, (rtnScratch[2] * weight) / KM_PER_AU);
}
