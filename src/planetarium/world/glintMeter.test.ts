import { describe, it, expect } from 'vitest';
import {
  AXIS_BOUND_TAN2_MAX, axisAlong2, axisAlpha, axisLobe, axisLobeBound, windFrameAt,
  HIGHLIGHT_KNOBS, advanceExposureStops, beamRadianceAt, beckmannLobe, beckmannLobeBound, buildColumnDepthTable, buildTransmittanceTable, lookupColumnDepth, coverageOfBeam, createBeamPeak, createBeamPlace, createGlintScratch,
  highlightTarget, lookupTransmittance, meanSquareSlopeOfWind, sunVisibleAt, placeBeamInFrame, scanBeam, shoulder, type BeamPlace,
  type GlintMeterLight, type GlintMeterPose, type GlintMeterSea, type SurfaceSampler,
} from './glintMeter';
import {
  atmosphereParams, opticalDepthToTopBoundary, solarIrradianceScale, transmittanceOverSegment, transmittanceToTopBoundary,
} from './atmosphereModel';
import { OCEAN_BEAM_CAP, OCEAN_BEAM_KNEE, SEA_WATER_F0 } from './surfaceShading';
import { SUN_LIGHT_INTENSITY, SUN_LIGHT_LINEAR } from '../sunLight';
import { SEA_WIND_MAX_MS, axisSlopes, meanSquareSlope, seaWindAxisFromByte } from './seaWind';
import { EarthSurfaceMaps } from './surfaceMaps';
import { readFileSync } from 'node:fs';
import { KM_PER_AU } from '../../astronomy/constants';

const EARTH_KM = 6371;
const DEG = Math.PI / 180;
const params = atmosphereParams('Earth');
const table = buildTransmittanceTable(params);
const scratch = createGlintScratch();

/** The probe's pose (tools/glint-probe.mjs): an altitude over the point where
 *  the Sun has a given elevation, the Sun finite at one AU, in the body's
 *  frame with the sub-camera point on +z and the Sun's azimuth along +x. */
function probePose(altitudeKm: number, sunElevDeg: number): GlintMeterPose {
  const camera: [number, number, number] = [0, 0, 1 + altitudeKm / EARTH_KM];
  const sunDist = KM_PER_AU / EARTH_KM;
  const sun: [number, number, number] = [sunDist * Math.cos(sunElevDeg * DEG), 0, 1 + sunDist * Math.sin(sunElevDeg * DEG)];
  return { camera, sun };
}

/** The cream Sun at 3 the probe's earlier reports were read under. */
const OLD_LIGHT: GlintMeterLight = { intensity: 3, linear: [1, 0.9131, 0.7454], irradianceScale: solarIrradianceScale(1) };
const sea: GlintMeterSea = {
  waterF0: SEA_WATER_F0,
  knee: 3.5, cap: 7.0, hazeClearView: 0.35, airBlend: 1,
};
const openSea = (windMs: number, cloudKeep = 1): SurfaceSampler => (_x, _y, _z, out) => {
  out.windMs = windMs; out.water = 1; out.cloudKeep = cloudKeep;
};

/** The Sun and the beam's shoulder as the app has them now. */
const LIGHT: GlintMeterLight = { intensity: SUN_LIGHT_INTENSITY, linear: SUN_LIGHT_LINEAR, irradianceScale: solarIrradianceScale(1) };
const beamSea: GlintMeterSea = {
  waterF0: SEA_WATER_F0, knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP, hazeClearView: 0.35, airBlend: 1,
};
const drawnMaxOf = (rad: readonly number[], s: GlintMeterSea): number =>
  Math.max(shoulder(rad[0], s.knee, s.cap), shoulder(rad[1], s.knee, s.cap), shoulder(rad[2], s.knee, s.cap));

describe('the transmittance table', () => {
  it('is the CPU atmosphere at the ground, interpolated in the zenith cosine', () => {
    expect(params.bottomRadius).toBeCloseTo(1, 6);
    const out: [number, number, number] = [0, 0, 0];
    for (const mu of [1, 0.5, 0.2, 0.05]) {
      const direct = transmittanceToTopBoundary(params, params.bottomRadius, mu);
      lookupTransmittance(table, mu, out);
      for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(direct[c], 2);
    }
    // Blue goes first, as Rayleigh says, and a low Sun loses most of it.
    lookupTransmittance(table, 0.17, out);
    expect(out[2]).toBeLessThan(out[0]);
    expect(out[0]).toBeLessThan(0.9);
  });
});

describe('the sea equations', () => {
  it('match the shader: Cox-Munk slopes, the shoulder below the knee and toward the cap', () => {
    expect(meanSquareSlopeOfWind(7.03)).toBeCloseTo(meanSquareSlope(7.03), 12);
    expect(shoulder(2, 3.5, 7)).toBe(2);
    expect(shoulder(3.5, 3.5, 7)).toBe(3.5);
    expect(shoulder(50, 3.5, 7)).toBeLessThan(7);
    expect(shoulder(50, 3.5, 7)).toBeGreaterThan(6.99);
    // Continuous in slope at the knee.
    const eps = 1e-6;
    expect((shoulder(3.5 + eps, 3.5, 7) - shoulder(3.5, 3.5, 7)) / eps).toBeCloseTo(1, 3);
  });

  it('is zero off the sea, under cloud, under the horizon and with the Sun down', () => {
    const pose = probePose(400, 10);
    const out: [number, number, number] = [0, 0, 0];
    const land: SurfaceSampler = (_x, _y, _z, o) => { o.windMs = 7; o.water = 0; o.cloudKeep = 1; };
    beamRadianceAt(Math.sin(8 * DEG), 0, Math.cos(8 * DEG), pose, OLD_LIGHT, sea, land, table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    beamRadianceAt(Math.sin(8 * DEG), 0, Math.cos(8 * DEG), pose, OLD_LIGHT, sea, openSea(7, 0), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    // Behind the horizon from 400 km (the horizon is 19.8° of ground).
    beamRadianceAt(Math.sin(40 * DEG), 0, Math.cos(40 * DEG), pose, OLD_LIGHT, sea, openSea(7), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    // Away from the Sun, past the terminator.
    beamRadianceAt(-Math.sin(100 * DEG), 0, Math.cos(100 * DEG), pose, OLD_LIGHT, sea, openSea(7), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
  });
});

describe('the scan at the probe pose (400 km, Sun 10°, 7.03 m/s)', () => {
  // The probe's own CPU reference read these at the mirror column, under the
  // cream Sun at 3: the reference peak (no air) 4.88 scene units, the Sun's
  // path on it ×0.78, the air on the camera leg ×0.59, the app drawn 2.23;
  // and the reference's maximum anywhere in frame further toward the
  // horizon than the mirror point (5.54 against 4.88), which is why the
  // scan looks for the peak instead of assuming it.
  const pose = probePose(400, 10);
  const peak = createBeamPeak();
  const found = scanBeam(pose, OLD_LIGHT, sea, openSea(7.03), table, scratch, peak);

  it('finds the drawn peak past the mirror point, toward the horizon', () => {
    expect(found).toBe(true);
    // The mirror point is 8.4° along the ground; the drawn peak the probe
    // measured sat at 11.5°, and the reference's at 13.6°.
    expect(peak.groundAngleDeg).toBeGreaterThan(8.4);
    expect(peak.groundAngleDeg).toBeLessThan(16);
    // The surface under it, as the sampler read it there.
    expect(peak.sample.water).toBe(1);
    expect(peak.sample.windMs).toBeCloseTo(7.03, 6);
    expect(peak.sample.cloudKeep).toBe(1);
  });

  it('draws the beam at the level the probe measured, to the air model\'s approximation', () => {
    const lum = 0.2126 * peak.drawn[0] + 0.7152 * peak.drawn[1] + 0.0722 * peak.drawn[2];
    // The probe's 2.23 is the app's own pixel; the prediction leaves out the
    // in-scatter and the relief's roughness, and reads the air through a
    // table of the ground's transmittance. Within a quarter here; the probe's
    // --meter arm is the exact oracle against the app itself.
    expect(lum).toBeGreaterThan(2.23 * 0.75);
    expect(lum).toBeLessThan(2.23 * 1.25);
    expect(peak.drawnMax).toBeGreaterThanOrEqual(lum);
    // Gold: red carries more than blue through a low Sun's air twice over.
    expect(peak.drawn[0]).toBeGreaterThan(peak.drawn[2]);
  });

  it('spans the frame the way the probe measured the beam', () => {
    // The probe: half-maximum 9.5° of view along the beam and 12.9° across
    // (full widths), at a 40° field.
    expect(peak.halfWidthAlongDeg * 2).toBeGreaterThan(5);
    expect(peak.halfWidthAlongDeg * 2).toBeLessThan(16);
    expect(peak.halfWidthAcrossDeg * 2).toBeGreaterThan(7);
    expect(peak.halfWidthAcrossDeg * 2).toBeLessThan(22);
    const coverage = coverageOfBeam(peak.halfWidthAlongDeg, peak.halfWidthAcrossDeg, 40, 27);
    expect(coverage).toBeGreaterThan(0.02);
    expect(coverage).toBeLessThan(0.2);
  });

  it('asks for less exposure there, and for none from geostationary distance', () => {
    const cov = coverageOfBeam(peak.halfWidthAlongDeg, peak.halfWidthAcrossDeg, 40, 27);
    // Over a 7 m/s sea the beam's red channel sits just under the target:
    // it drew 2.8 and more until the ozone's red was corrected (2026-10-09,
    // absorbed at four times the old rate), and the Sun's grazing path in
    // now costs the beam an eighth, so the meter asks for nothing here. The
    // calm sea below is the case that asks for less.
    const plain = highlightTarget(peak.drawnMax, cov);
    expect(peak.drawnMax).toBeGreaterThan(2.3);
    expect(peak.drawnMax).toBeLessThan(2.8);
    expect(plain).toBe(1);
    // A brighter beam (a calm sea under the mirror point) asks for more. A
    // 1.5 m/s sea has the peak a texel half glassy at 7 m/s had when the sea
    // was drawn as two lobes, so the case is the one this pinned before.
    const calmPeak = createBeamPeak();
    expect(scanBeam(pose, OLD_LIGHT, sea, openSea(1.5), table, scratch, calmPeak)).toBe(true);
    expect(calmPeak.drawnMax).toBeGreaterThan(peak.drawnMax);
    const e = highlightTarget(calmPeak.drawnMax, cov);
    expect(e).toBeLessThan(plain);
    expect(e).toBeGreaterThanOrEqual(0.25);
    // From 35 786 km with the Sun 60° high the sheen is faint: factor 1.
    const geo = createBeamPeak();
    expect(scanBeam(probePose(35786, 60), OLD_LIGHT, sea, openSea(1.5), table, scratch, geo)).toBe(true);
    expect(geo.drawnMax).toBeLessThan(2.8);
    expect(highlightTarget(geo.drawnMax, coverageOfBeam(geo.halfWidthAlongDeg, geo.halfWidthAcrossDeg, 20, 14))).toBe(1);
  });

  it('has no beam with the Sun on the camera\'s zenith, or from inside the body', () => {
    const zenith: GlintMeterPose = { camera: [0, 0, 1.06], sun: [0, 0, 23000] };
    expect(scanBeam(zenith, OLD_LIGHT, sea, openSea(7), table, scratch, createBeamPeak())).toBe(false);
    const inside: GlintMeterPose = { camera: [0, 0, 0.5], sun: [23000, 0, 0] };
    expect(scanBeam(inside, OLD_LIGHT, sea, openSea(7), table, scratch, createBeamPeak())).toBe(false);
    // A pure-land sampler finds nothing either.
    const land: SurfaceSampler = (_x, _y, _z, o) => { o.windMs = 7; o.water = 0; o.cloudKeep = 1; };
    expect(scanBeam(pose, OLD_LIGHT, sea, land, table, scratch, createBeamPeak())).toBe(false);
  });
});

describe('a beam beside the principal line', () => {
  // 400 km up, the Sun 5° high, a 4 m/s sea: the case a land strip lying
  // along the principal line hid from a scan of the line alone. In probePose
  // the principal plane is the xz plane, so a ground point's distance across
  // the line is asin(y) radii.
  const pose = probePose(400, 5);
  const acrossKm = (y: number) => Math.asin(y) * EARTH_KM;
  const strip: SurfaceSampler = (_x, y, _z, o) => {
    o.windMs = 4; o.cloudKeep = 1; o.water = Math.abs(acrossKm(y)) < 32 ? 0 : 1;
  };
  /** The brightest drawn point a fine grid over the ground in front of the
   *  camera finds: 0.02° along the line by 2 km across it, out to 300 km. */
  function brightestOnGrid(sampler: SurfaceSampler): number {
    const out: [number, number, number] = [0, 0, 0];
    let best = 0;
    for (let phiDeg = 4; phiDeg <= 19; phiDeg += 0.02) {
      for (let km = -300; km <= 300; km += 2) {
        const a = km / EARTH_KM, phi = phiDeg * DEG;
        beamRadianceAt(Math.cos(a) * Math.sin(phi), Math.sin(a), Math.cos(a) * Math.cos(phi), pose, LIGHT, beamSea, sampler, table, scratch, out);
        best = Math.max(best, drawnMaxOf(out, beamSea));
      }
    }
    return best;
  }

  it('finds the beam when a 64 km land strip covers the whole line, at its own brightness', () => {
    const peak = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, strip, table, scratch, peak)).toBe(true);
    const oracle = brightestOnGrid(strip);
    // The sea just beside the strip carries nearly the whole beam: well past
    // the meter's target, which is what a scan of the line alone left at one.
    expect(oracle).toBeGreaterThan(6);
    expect(peak.drawnMax).toBeGreaterThan(0.95 * oracle);
    expect(peak.drawnMax).toBeLessThan(1.02 * oracle);
    expect(Math.abs(acrossKm(peak.n[1]))).toBeGreaterThan(32);
    expect(Math.abs(peak.acrossAngleDeg) * DEG * EARTH_KM).toBeCloseTo(Math.abs(acrossKm(peak.n[1])), 6);
    expect(peak.sample.water).toBe(1);
    expect(peak.halfWidthAcrossDeg).toBeGreaterThan(0);
  });

  it("places a peak that sits beside the line off the frame's centre column", () => {
    const peak = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, strip, table, scratch, peak);
    // The frame aimed at the line's point at the peak's angle along it, its
    // up the camera's vertical: the peak sits off the centre column by the
    // angle its distance across subtends at the camera.
    const phi = peak.groundAngleDeg * DEG;
    const cam = pose.camera;
    const aim = [Math.sin(phi) - cam[0], -cam[1], Math.cos(phi) - cam[2]];
    const len = Math.hypot(aim[0], aim[1], aim[2]);
    const view: [number, number, number] = [aim[0] / len, aim[1] / len, aim[2] / len];
    const place = createBeamPlace();
    placeBeamInFrame(pose, peak.groundAngleDeg, view, [0, 0, 1], scratch, place, peak.acrossAngleDeg);
    expect(place.inFront).toBe(true);
    const expectDeg = Math.atan(Math.abs(acrossKm(peak.n[1])) / (len * EARTH_KM)) / DEG;
    expect(Math.abs(place.xDeg)).toBeGreaterThan(0.8 * expectDeg);
    expect(Math.abs(place.xDeg)).toBeLessThan(1.2 * expectDeg);
    placeBeamInFrame(pose, peak.groundAngleDeg, view, [0, 0, 1], scratch, place);
    expect(Math.abs(place.xDeg)).toBeLessThan(1e-6);
  });

  it('reads nothing beside the line where open sea could not out-draw what it found', () => {
    // Land on the line between the camera's foot and 6° along the ground,
    // far short of the beam at 12°: every cut step's open-sea bound sits
    // under the beam, so the scan reads exactly as many points as it does
    // over a uniform sea.
    const count = (sampler: SurfaceSampler) => {
      let n = 0;
      const counted: SurfaceSampler = (...a) => { n++; sampler(...a); };
      const peak = createBeamPeak();
      expect(scanBeam(pose, LIGHT, beamSea, counted, table, scratch, peak)).toBe(true);
      return { n, peak };
    };
    const nearLand: SurfaceSampler = (x, y, z, o) => {
      o.windMs = 4; o.cloudKeep = 1;
      o.water = Math.atan2(x, z) < 6 * DEG && Math.abs(acrossKm(y)) < 32 ? 0 : 1;
    };
    const sea = count(openSea(4));
    const land = count(nearLand);
    expect(land.n).toBe(sea.n);
    expect(land.peak.drawnMax).toBe(sea.peak.drawnMax);
    // The strip along the whole line, the beam's own steps among them, is
    // read beside.
    expect(count(strip).n).toBeGreaterThan(sea.n);
  });

  it("looks beside the line only for a beam its caller would act on", () => {
    // The strip's beam beside the line draws 7: a floor under it finds it,
    // a floor over it leaves the line, which is all land, with no beam.
    const under = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, strip, table, scratch, under, { besideFloor: 2.8 })).toBe(true);
    expect(under.drawnMax).toBeGreaterThan(6);
    const over = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, strip, table, scratch, over, { besideFloor: 20 })).toBe(false);
  });

  it("bounds the lobe at every wind the map can hold", () => {
    for (let deg = 0; deg <= 60; deg += 0.5) {
      const cosNH = Math.cos(deg * DEG);
      const bound = beckmannLobeBound(cosNH);
      let most = 0;
      for (let k = 0; k <= 320; k++) most = Math.max(most, beckmannLobe(cosNH, meanSquareSlopeOfWind((16 * k) / 320)));
      expect(bound).toBeGreaterThanOrEqual(most * (1 - 1e-12));
      expect(bound).toBeLessThan(most * 1.01);
    }
  });

  it('keeps the peak on the line over a uniform sea', () => {
    const peak = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, peak)).toBe(true);
    expect(peak.acrossAngleDeg).toBe(0);
    expect(peak.drawnMax).toBeGreaterThan(0.99 * brightestOnGrid(openSea(4)));
  });
});

describe('the cloud on both sides of the beam', () => {
  // 400 km up, the Sun 5° high, a 4 m/s sea under a uniform deck.
  const pose = probePose(400, 5);
  const underDeck = (cloudKeep: number, deckKeep: number): SurfaceSampler => (_x, _y, _z, o) => {
    o.windMs = 4; o.water = 1; o.cloudKeep = cloudKeep; o.deckKeep = deckKeep;
  };

  it("takes the deck's share in the line of sight after the shoulder, and the Sun's side before it", () => {
    const clear = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, clear)).toBe(true);
    // The deck drawn over the ground halves what the shoulder made of the
    // beam: the carried radiance is the clear sea's, the drawn half of it.
    const deck = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, underDeck(1, 0.5), table, scratch, deck)).toBe(true);
    for (let c = 0; c < 3; c++) expect(deck.carried[c]).toBeCloseTo(clear.carried[c], 9);
    expect(deck.drawnMax).toBeCloseTo(0.5 * clear.drawnMax, 9);
    expect(deck.sample.deckKeep).toBe(0.5);
    // The same half on the Sun's side is taken before the shoulder, which
    // then holds less of the beam back: more is drawn than half.
    const sunSide = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, underDeck(0.5, 1), table, scratch, sunSide);
    expect(sunSide.drawnMax).toBeGreaterThan(0.5 * clear.drawnMax * 1.05);
    // Both, as a uniform half cover gives them: the review's numbers (4.26
    // and 2.13 at the ozone of the time; the corrected ozone of 2026-10-09
    // takes an eighth more of the Sun's red at 5°), the clear beam well
    // past the target and the covered one under it.
    const both = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, underDeck(0.5, 0.5), table, scratch, both);
    expect(sunSide.drawnMax).toBeCloseTo(3.58, 1);
    expect(both.drawnMax).toBeCloseTo(0.5 * sunSide.drawnMax, 9);
    expect(both.drawnMax).toBeLessThan(HIGHLIGHT_KNOBS.target);
  });

  it('reads a sampler that says nothing of the deck as no deck', () => {
    const peak = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, underDeck(1, 0.25), table, scratch, peak);
    scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, peak);
    expect(peak.sample.deckKeep).toBe(1);
  });
});

describe('a camera inside the air', () => {
  const column = buildColumnDepthTable(params);
  const withColumn = { ...table, column };

  it("holds the columns above a point inside the air to the model's own integral", () => {
    const out: [number, number, number] = [0, 0, 0];
    for (const altKm of [0, 0.5, 1, 5, 20, 60]) {
      for (const mu of [0.03, 0.1, 0.3, 1]) {
        const r = 1 + altKm / EARTH_KM;
        const ref = opticalDepthToTopBoundary(params, r, mu);
        lookupColumnDepth(column, r, mu, out);
        for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - ref[c])).toBeLessThan(Math.max(0.015 * ref[c], 1e-4));
      }
    }
  });

  it('sees the beam from 1 km through the air below the camera, not the whole column (Sun 2°, 4 m/s)', () => {
    const pose = probePose(1, 2);
    const peak = createBeamPeak();
    expect(scanBeam(pose, LIGHT, beamSea, openSea(4), withColumn, scratch, peak)).toBe(true);
    // The same point with the whole column, and the camera leg's
    // transmittance swapped for the model's own integral over the segment
    // from the point to the camera: the shader's aerial segment.
    const n = peak.n;
    const whole: [number, number, number] = [0, 0, 0];
    beamRadianceAt(n[0], n[1], n[2], pose, LIGHT, beamSea, openSea(4), table, scratch, whole);
    const v = [pose.camera[0] - n[0], pose.camera[1] - n[1], pose.camera[2] - n[2]];
    const dist = Math.hypot(v[0], v[1], v[2]);
    const nv = (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / dist;
    const columnT: [number, number, number] = [0, 0, 0];
    lookupTransmittance(table, nv, columnT);
    const segmentT = transmittanceOverSegment(params, 1, nv, dist);
    const weight = 0.35 + 0.65 * (1 - nv) * (1 - nv);
    for (let c = 0; c < 3; c++) {
      const expected = (whole[c] / (1 + (columnT[c] - 1) * weight)) * (1 + (segmentT[c] - 1) * weight);
      expect(Math.abs(peak.carried[c] - expected)).toBeLessThan(0.015 * expected + 1e-6);
    }
    // The brightest point along the line through the segment, every 0.002°
    // of ground, the oracle the scan's peak is held to. The whole column
    // drew 2.36 at its own peak, under the target, and the meter asked for
    // nothing; through the segment the same point drew 4.62, and the
    // brightest one more (at the ozone of the time; the corrected ozone of
    // 2026-10-09 takes an eighth more of a beam under a 2° Sun).
    const at: [number, number, number] = [0, 0, 0];
    let oracle = 0;
    for (let phiDeg = 0.02; phiDeg < 1.0; phiDeg += 0.002) {
      const phi = phiDeg * DEG;
      const q = [Math.sin(phi), 0, Math.cos(phi)];
      beamRadianceAt(q[0], q[1], q[2], pose, LIGHT, beamSea, openSea(4), table, scratch, at);
      const u = [pose.camera[0] - q[0], pose.camera[1] - q[1], pose.camera[2] - q[2]];
      const len = Math.hypot(u[0], u[1], u[2]);
      const mu = (q[0] * u[0] + q[2] * u[2]) / len;
      if (!(mu > 0)) continue;
      const tc: [number, number, number] = [0, 0, 0];
      lookupTransmittance(table, mu, tc);
      const ts = transmittanceOverSegment(params, 1, mu, len);
      const wt = 0.35 + 0.65 * (1 - mu) * (1 - mu);
      const seg = [0, 1, 2].map((c) => (at[c] / (1 + (tc[c] - 1) * wt)) * (1 + (ts[c] - 1) * wt));
      oracle = Math.max(oracle, drawnMaxOf(seg, beamSea));
    }
    expect(oracle).toBeGreaterThan(3.8);
    expect(peak.drawnMax).toBeGreaterThan(0.98 * oracle);
    expect(peak.drawnMax).toBeLessThan(1.02 * oracle);
    expect(peak.drawnMax).toBeGreaterThan(HIGHLIGHT_KNOBS.target);
    const columnPeak = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, columnPeak);
    expect(columnPeak.drawnMax).toBeLessThan(2.5);
  });

  it('leaves a camera above the air exactly where it was (400 km, Sun 5°)', () => {
    const pose = probePose(400, 5);
    const a = createBeamPeak();
    const b = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, a);
    scanBeam(pose, LIGHT, beamSea, openSea(4), withColumn, scratch, b);
    expect(b.drawnMax).toBe(a.drawnMax);
    expect(b.carried).toEqual(a.carried);
    expect(b.groundAngleDeg).toBe(a.groundAngleDeg);
    expect(b.halfWidthAlongDeg).toBe(a.halfWidthAlongDeg);
  });
});

describe("a moon's shadow over the beam", () => {
  // The Moon's radius and the Sun's angular radius at one AU, as tangent.
  const MOON_R = 1737.4 / EARTH_KM;
  const SUN_TAN = Math.tan((0.2666 * Math.PI) / 180);
  /** moonShadowOcclusion and the day factor as the ground's GLSL states
   *  them, transcribed here as the reference. */
  const glslSmooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const occlusion = (toMoon: number[], r: number, l: number[], tan: number) => {
    const along = toMoon[0] * l[0] + toMoon[1] * l[1] + toMoon[2] * l[2];
    if (along <= 0) return 0;
    const perp = Math.hypot(toMoon[0] - l[0] * along, toMoon[1] - l[1] * along, toMoon[2] - l[2] * along);
    return 1 - glslSmooth(Math.max(r - along * tan, 0), r + along * tan, perp);
  };

  it('traces the umbra and the penumbra as the ground traces them', () => {
    const p = [0, 0, 1];
    const sunEl = 20 * DEG;
    const l = [Math.cos(sunEl), 0, Math.sin(sunEl)];
    const nl = l[2];
    const day = glslSmooth(-0.16, 0.16, nl);
    for (const [along, side] of [[60, 0], [60, 0.1], [60, 0.3], [60, 0.6], [20, 0.05], [-5, 0]]) {
      // A caster `along` radii sunward of the point and `side` radii off the axis.
      const c = [p[0] + l[0] * along, p[1] + side, p[2] + l[2] * along];
      const pose: GlintMeterPose = {
        camera: [0, 0, 1.06], sun: [l[0] * 23000, 0, l[2] * 23000], shadows: [c[0], c[1], c[2], MOON_R], shadowCount: 1, sunTan: SUN_TAN, termWidth: 0.16,
      };
      const expected = 1 - occlusion([c[0] - p[0], c[1] - p[1], c[2] - p[2]], MOON_R, l, SUN_TAN) * day;
      expect(sunVisibleAt(p[0], p[1], p[2], l[0], l[1], l[2], nl, pose)).toBeCloseTo(expected, 12);
    }
    // Two casters multiply; none, or a count of none, is the whole Sun.
    const two: GlintMeterPose = {
      camera: [0, 0, 1.06], sun: [23000, 0, 0],
      shadows: [l[0] * 60, 0.2, 1 + l[2] * 60, MOON_R, l[0] * 30, -0.1, 1 + l[2] * 30, MOON_R / 2], shadowCount: 2, sunTan: SUN_TAN, termWidth: 0.16,
    };
    const one = (o: number) => 1 - occlusion([two.shadows![o] - p[0], two.shadows![o + 1] - p[1], two.shadows![o + 2] - p[2]], two.shadows![o + 3], l, SUN_TAN) * day;
    expect(sunVisibleAt(p[0], p[1], p[2], l[0], l[1], l[2], nl, two)).toBeCloseTo(one(0) * one(4), 12);
    expect(sunVisibleAt(p[0], p[1], p[2], l[0], l[1], l[2], nl, { ...two, shadowCount: 0 })).toBe(1);
    expect(sunVisibleAt(p[0], p[1], p[2], l[0], l[1], l[2], nl, { camera: [0, 0, 1.06], sun: [23000, 0, 0] })).toBe(1);
  });

  it('dims the beam it predicts under the shadow, and asks for nothing the shadow took (400 km, Sun 5°, 4 m/s)', () => {
    const pose = probePose(400, 5);
    const clear = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, openSea(4), table, scratch, clear);
    expect(highlightTarget(clear.drawnMax, 0.05)).toBeLessThan(1);
    // The Moon 60 radii sunward of the clear beam's peak, its shadow's axis
    // through it: the beam stands in the penumbra's dark heart.
    const n = clear.n;
    const toSun = [pose.sun[0] - n[0], pose.sun[1] - n[1], pose.sun[2] - n[2]];
    const len = Math.hypot(toSun[0], toSun[1], toSun[2]);
    const moon = [n[0] + (60 * toSun[0]) / len, n[1] + (60 * toSun[1]) / len, n[2] + (60 * toSun[2]) / len];
    const eclipsed: GlintMeterPose = { ...pose, shadows: [moon[0], moon[1], moon[2], MOON_R], shadowCount: 1, sunTan: SUN_TAN, termWidth: 0.16 };
    const dim = createBeamPeak();
    expect(scanBeam(eclipsed, LIGHT, beamSea, openSea(4), table, scratch, dim)).toBe(true);
    expect(dim.drawnMax).toBeLessThan(0.3 * clear.drawnMax);
    expect(dim.drawnMax).toBeLessThan(HIGHLIGHT_KNOBS.target);
    expect(highlightTarget(dim.drawnMax, 0.05)).toBe(1);
  });
});

describe('the target and the adaptation', () => {
  it('fades in with coverage, holds the floor, and never leaves a NaN', () => {
    expect(highlightTarget(10, 0)).toBe(1);
    expect(highlightTarget(10, 0.001)).toBe(1);
    expect(highlightTarget(10, 0.05)).toBeCloseTo(0.28, 6);
    expect(highlightTarget(100, 0.05)).toBe(0.25);
    expect(highlightTarget(10, 0.011)).toBeGreaterThan(0.28);
    expect(highlightTarget(10, 0.011)).toBeLessThan(1);
    expect(highlightTarget(NaN, 0.05)).toBe(1);
    expect(highlightTarget(10, NaN)).toBe(1);
  });

  it('moves in stops at two rates, and snaps to one', () => {
    // Lowering: 3 stops/s, so a tenth of a second is 0.3 stops.
    expect(advanceExposureStops(1, 0.25, 0.1, 3, 0.75)).toBeCloseTo(Math.pow(2, -0.3), 9);
    // Recovering: 0.75 stops/s.
    expect(advanceExposureStops(0.25, 1, 0.1, 3, 0.75)).toBeCloseTo(Math.pow(2, -2 + 0.075), 9);
    // Reaching the target exactly, then the snap to 1.
    expect(advanceExposureStops(0.5, 0.25, 10, 3, 0.75)).toBeCloseTo(0.25, 12);
    expect(advanceExposureStops(0.9995, 1, 0.001, 3, 0.75)).toBe(1);
    expect(advanceExposureStops(1, 1, 0.016, 3, 0.75)).toBe(1);
  });
});

describe("the beam's share of the frame, placed", () => {
  const place = (xDeg: number, yDeg: number, alongX = 0, alongY = 1, inFront = true): BeamPlace => ({ xDeg, yDeg, alongX, alongY, inFront });
  it('counts the whole ellipse in the middle, half at an edge, none past it or behind', () => {
    const whole = coverageOfBeam(6.59, 2.95, 40, 27);
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(0, 0))).toBeCloseTo(whole, 12);
    // Across axis horizontal (along vertical): half the box past the right edge.
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(20, 0))).toBeCloseTo(whole / 2, 6);
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(40, 0))).toBe(0);
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(0, 0, 0, 1, false))).toBe(0);
    // The along axis turned flat: the box is wider than tall, the share the same whole.
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(0, 0, 1, 0))).toBeCloseTo(whole, 12);
    // Half off the top with the along axis flat.
    expect(coverageOfBeam(6.59, 2.95, 40, 27, place(0, 13.5, 1, 0))).toBeCloseTo(whole / 2, 6);
  });

  it('places the peak where a pinhole frame sees it, and the line along it', () => {
    const h = 400 / 6371;
    const pose: GlintMeterPose = { camera: [0, 0, 1 + h], sun: [23000, 0, 1 + 4000] };
    const scratch = createGlintScratch();
    const out = createBeamPlace();
    // Aimed straight at the ground point 10° along the principal line.
    const phi = 10 * Math.PI / 180;
    const aim = [Math.sin(phi) - 0, 0, Math.cos(phi) - (1 + h)];
    const len = Math.hypot(aim[0], aim[1], aim[2]);
    const view: [number, number, number] = [aim[0] / len, aim[1] / len, aim[2] / len];
    placeBeamInFrame(pose, 10, view, [0, 0, 1], scratch, out);
    expect(out.inFront).toBe(true);
    expect(Math.abs(out.xDeg)).toBeLessThan(1e-6);
    expect(Math.abs(out.yDeg)).toBeLessThan(1e-6);
    // Further along the ground is further from the camera's foot: up the frame.
    expect(out.alongY).toBeGreaterThan(0.99);
    expect(Math.abs(out.alongX)).toBeLessThan(0.1);
    // A point 5° further along the ground (556 km) sits above the centre by
    // the angle the slant makes of it, a few degrees; 5° short, below.
    placeBeamInFrame(pose, 15, view, [0, 0, 1], scratch, out);
    expect(out.yDeg).toBeGreaterThan(2);
    expect(out.yDeg).toBeLessThan(5);
    placeBeamInFrame(pose, 5, view, [0, 0, 1], scratch, out);
    expect(out.yDeg).toBeLessThan(-2);
    // Turned away: behind the camera.
    placeBeamInFrame(pose, 10, [-view[0], view[1], view[2]], [0, 0, 1], scratch, out);
    expect(out.inFront).toBe(false);
    // Level and turned 60° about the vertical: the peak is 60° to one side.
    placeBeamInFrame(pose, 10, [0.5, Math.sqrt(0.75), 0], [0, 0, 1], scratch, out);
    expect(out.inFront).toBe(true);
    expect(Math.abs(out.xDeg)).toBeGreaterThan(55);
    expect(Math.abs(out.xDeg)).toBeLessThan(65);
  });
});

describe('the lobe along the wind', () => {
  // 400 km up, the Sun 10° high: probePose's principal line runs along the
  // equator from the sub-camera point (longitude -90°) toward +x, east.
  const pose = probePose(400, 10);
  const axisSea: GlintMeterSea = { ...beamSea, axis: true };
  const steady = (windMs: number, axisX: number, axisY: number): SurfaceSampler => (_x, _y, _z, out) => {
    out.windMs = windMs; out.water = 1; out.cloudKeep = 1; out.axisX = axisX; out.axisY = axisY;
  };

  it('is the round lobe where the two slopes are equal, to float precision', () => {
    for (const mss of [0.003, 0.0389, 0.0849]) {
      for (let deg = 0; deg <= 70; deg += 2.5) {
        const cosNH = Math.cos(deg * DEG);
        const round = beckmannLobe(cosNH, mss);
        for (let az = 0; az < 360; az += 30) {
          const along2 = Math.cos(az * DEG) ** 2;
          expect(Math.abs(axisLobe(cosNH, mss, mss, along2) - round)).toBeLessThanOrEqual(1e-12 * round);
          expect(Math.abs(axisAlpha(mss, mss, along2) / Math.sqrt(mss) - 1)).toBeLessThan(1e-12);
        }
      }
    }
    // A direction with no tangent part, or a frame collapsed at a pole, reads
    // halfway between the two slopes, never a flat lobe.
    expect(axisAlong2(0.6, 0.8, 0, 0)).toBe(0.5);
  });

  it('is the shader\'s ellipse: the along slope along the axis and the across slope across it', () => {
    const along = 0.05, across = 0.03, deg = 12;
    const cosNH = Math.cos(deg * DEG), tan2 = Math.tan(deg * DEG) ** 2;
    const cos4 = cosNH ** 4;
    expect(axisLobe(cosNH, along, across, 1))
      .toBeCloseTo(Math.exp(-tan2 / along) / (Math.PI * Math.sqrt(along * across) * cos4), 10);
    expect(axisLobe(cosNH, along, across, 0))
      .toBeCloseTo(Math.exp(-tan2 / across) / (Math.PI * Math.sqrt(along * across) * cos4), 10);
    // Smith's alpha on a direction's azimuth: along, across, and between.
    expect(axisAlpha(along, across, 1)).toBeCloseTo(Math.sqrt(along), 15);
    expect(axisAlpha(along, across, 0)).toBeCloseTo(Math.sqrt(across), 15);
    expect(axisAlpha(along, across, 0.5)).toBeCloseTo(Math.sqrt((along + across) / 2), 15);
    // The azimuth from the axis without an angle: an axis toward east (doubled
    // (1, 0)) has east wholly along it and north wholly across; one 45° north
    // of east (doubled (0, 1)) has north-east along and south-east across; and
    // a direction's length does not matter.
    expect(axisAlong2(1, 0, 1, 0)).toBeCloseTo(1, 15);
    expect(axisAlong2(1, 0, 0, 3)).toBeCloseTo(0, 15);
    expect(axisAlong2(0, 1, 2, 2)).toBeCloseTo(1, 15);
    expect(axisAlong2(0, 1, 1, -1)).toBeCloseTo(0, 15);
    for (let theta = -90; theta < 90; theta += 7.5) {
      const d2 = 2 * theta * DEG;
      for (let phi = 0; phi < 360; phi += 11) {
        const w = 0.37;
        expect(axisAlong2(Math.cos(d2), Math.sin(d2), w * Math.cos(phi * DEG), w * Math.sin(phi * DEG)))
          .toBeCloseTo(Math.cos((phi - theta) * DEG) ** 2, 12);
      }
    }
  });

  it('draws the round beam where the map has no axis, and with the switch off exactly the round one whatever the axis', () => {
    const out: [number, number, number] = [0, 0, 0];
    const round: [number, number, number] = [0, 0, 0];
    for (let deg = 4; deg <= 18; deg += 0.5) {
      for (const across of [0, 0.5, -1]) {
        const a = across * DEG, phi = deg * DEG;
        const n: [number, number, number] = [Math.cos(a) * Math.sin(phi), Math.sin(a), Math.cos(a) * Math.cos(phi)];
        beamRadianceAt(n[0], n[1], n[2], pose, LIGHT, axisSea, steady(7, 0, 0), table, scratch, out);
        beamRadianceAt(n[0], n[1], n[2], pose, LIGHT, beamSea, steady(7, 0, 0), table, scratch, round);
        for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - round[c])).toBeLessThanOrEqual(1e-12 * round[c]);
        // Off: bit for bit the round lobe, an oblique axis or not.
        beamRadianceAt(n[0], n[1], n[2], pose, LIGHT, { ...beamSea, axis: false }, steady(7, 0.6, 0.7), table, scratch, out);
        expect(out).toEqual(round);
      }
    }
    // And the whole scan, its sampling and its bound included.
    const off = createBeamPeak(), before = createBeamPeak();
    expect(scanBeam(pose, LIGHT, { ...beamSea, axis: false }, steady(4, 0.6, 0.7), table, scratch, off)).toBe(true);
    expect(scanBeam(pose, LIGHT, beamSea, steady(4, 0.6, 0.7), table, scratch, before)).toBe(true);
    expect(off).toEqual(before);
  });

  it('stretches the beam along an axis that lies along the line and squeezes it across', () => {
    // An east-west axis (doubled angle (1, 0)) lies along this pose's line, a
    // north-south one ((-1, 0)) across it. The carried beam, before the
    // shoulder, falls from the mirror point (where the half vector is the
    // normal and the lobe is at its height) more slowly along the axis and
    // faster across it; over a uniform sea the scan's peak stays on the line
    // either way.
    const nhAt = (phi: number): number => {
      const n = [Math.sin(phi), 0, Math.cos(phi)];
      const v = [pose.camera[0] - n[0], pose.camera[1] - n[1], pose.camera[2] - n[2]];
      const l = [pose.sun[0] - n[0], pose.sun[1] - n[1], pose.sun[2] - n[2]];
      const lv = Math.hypot(v[0], v[1], v[2]), ll = Math.hypot(l[0], l[1], l[2]);
      const h = [v[0] / lv + l[0] / ll, v[1] / lv + l[1] / ll, v[2] / lv + l[2] / ll];
      return (h[0] * n[0] + h[1] * n[1] + h[2] * n[2]) / Math.hypot(h[0], h[1], h[2]);
    };
    let lo = 2 * DEG, hi = 16 * DEG;
    for (let i = 0; i < 80; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (nhAt(a) < nhAt(b)) lo = a; else hi = b;
    }
    const mirror = (lo + hi) / 2;
    expect(mirror / DEG).toBeCloseTo(8.37, 1);
    const at = (sea: GlintMeterSea, sampler: SurfaceSampler, alongDeg: number, acrossDeg: number): number => {
      const out: [number, number, number] = [0, 0, 0];
      const phi = mirror + alongDeg * DEG, a = acrossDeg * DEG;
      beamRadianceAt(Math.cos(a) * Math.sin(phi), Math.sin(a), Math.cos(a) * Math.cos(phi), pose, LIGHT, sea, sampler, table, scratch, out);
      return out[0];
    };
    const fall = (sea: GlintMeterSea, sampler: SurfaceSampler, alongDeg: number, acrossDeg: number) =>
      at(sea, sampler, alongDeg, acrossDeg) / at(sea, sampler, 0, 0);
    const roundSea = steady(9, 0, 0), eastWest = steady(9, 1, 0), northSouth = steady(9, -1, 0);
    for (const step of [-0.75, 0.75]) {
      expect(fall(axisSea, eastWest, step, 0)).toBeGreaterThan(fall(beamSea, roundSea, step, 0));
      expect(fall(axisSea, northSouth, step, 0)).toBeLessThan(fall(beamSea, roundSea, step, 0));
      expect(fall(axisSea, eastWest, 0, step)).toBeLessThan(fall(beamSea, roundSea, 0, step));
      expect(fall(axisSea, northSouth, 0, step)).toBeGreaterThan(fall(beamSea, roundSea, 0, step));
    }
    for (const sampler of [eastWest, northSouth]) {
      const peak = createBeamPeak();
      expect(scanBeam(pose, LIGHT, axisSea, sampler, table, scratch, peak)).toBe(true);
      expect(peak.acrossAngleDeg).toBe(0);
    }
  });

  it('turns the axis from east toward north as the map\'s own u and v grow, and a mirrored decode fails that', () => {
    // The shipped map's bytes at the NE trades (15° N 150° W), x2 > 0: an axis
    // about 19° north of east (a wind toward the west-south-west).
    const points = JSON.parse(readFileSync(new URL('../../../tools/goldens/seawind/earth-seawind.v2.points.json', import.meta.url), 'utf8'));
    const ne = points.points.find((p: { name: string }) => p.name === 'ne-trades');
    expect(ne.map.bytes.slice(0, 3)).toEqual([136, 224, 202]);
    const x1 = seaWindAxisFromByte(ne.map.bytes[1]), x2 = seaWindAxisFromByte(ne.map.bytes[2]);
    expect(x2).toBeGreaterThan(0);
    expect(Math.atan2(x2, x1) / 2 / DEG).toBeCloseTo(18.8, 0);
    // The sampler's own (u, v), read off coarse maps whose bytes ARE u and v:
    // the wind's grows a byte a column east, the water's a byte a row north.
    const maps = new EarthSurfaceMaps({ water: 'water', wind: 'wind', cloud: 'cloud' });
    const size = 256;
    const byColumn = new Uint8Array(size * size), byRow = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) { byColumn[row * size + column] = column; byRow[row * size + column] = row; }
    }
    maps.install('wind', { width: size, height: size, data: byColumn });
    maps.install('water', { width: size, height: size, data: byRow });
    maps.install('cloud', { width: size, height: size, data: new Uint8Array(size * size) });
    const uv = (n: readonly number[]): [number, number] => {
      const s = { windMs: 0, water: 0, cloudKeep: 1, deckKeep: 1, axisX: 0, axisY: 0 };
      maps.sampleAt(n[0], n[1], n[2], 0, s, false);
      return [s.windMs, s.water];
    };
    // The point from its latitude and its longitude as the map's u.
    const lat = 15 * DEG, u = (-150 + 180) / 360;
    const p = [-Math.cos(lat) * Math.cos(2 * Math.PI * u), Math.sin(lat), Math.cos(lat) * Math.sin(2 * Math.PI * u)];
    // The twin's own along-wind direction there, u_b: the tangent direction
    // its lobe reads wholly along the axis (axisAlong2 = 1), found by search
    // over the twin's east and north rather than from the angle's formula,
    // on the eastward half (an axis has no sign).
    const nudged = (axisY: number): [number, number] => {
      const f = new Float64Array(6);
      windFrameAt(p[0], p[1], p[2], f);
      const length = Math.hypot(x1, axisY);
      let bestPhi = 0, best = -1;
      for (let phi = -90; phi < 90; phi += 0.005) {
        const a = axisAlong2(x1 / length, axisY / length, Math.cos(phi * DEG), Math.sin(phi * DEG));
        if (a > best) { best = a; bestPhi = phi * DEG; }
      }
      expect(best).toBeCloseTo(1, 8);
      const ub = [0, 1, 2].map((k) => Math.cos(bestPhi) * f[k] + Math.sin(bestPhi) * f[3 + k]);
      const e = 1e-3;
      const q = [p[0] + e * ub[0], p[1] + e * ub[1], p[2] + e * ub[2]];
      const len = Math.hypot(q[0], q[1], q[2]);
      const [u0, v0] = uv(p);
      const [u1, v1] = uv([q[0] / len, q[1] / len, q[2] / len]);
      return [u1 - u0, v1 - v0];
    };
    const [du, dv] = nudged(x2);
    expect(du).toBeGreaterThan(0);
    expect(dv).toBeGreaterThan(0);
    // The mirrored decode (the doubled sine negated) turns the axis south of
    // east, and the check above fails on it.
    const [mu, mv] = nudged(-x2);
    expect(mu).toBeGreaterThan(0);
    expect(mv).toBeLessThan(0);
    expect(mu > 0 && mv > 0).toBe(false);
  });

  it('bounds the lobe over every wind, axis length and azimuth, light winds under 2.42 m/s at a full axis among them', () => {
    const slopes: [number, number] = [0, 0];
    // The largest the lobe reaches over its bound anywhere on the grid, and
    // the loosest the bound is over the grid's own largest at a tilt.
    let over = 0, loosest = 0;
    for (let deg = 0; deg <= 60; deg += 0.5) {
      const cosNH = Math.cos(deg * DEG);
      const bound = axisLobeBound(cosNH);
      let most = 0;
      // Winds halfway between the build's 1024 steps, and both ends: the
      // margin is for exactly these.
      for (let step = 0; step <= 2048; step++) {
        const wind = step === 2048 ? SEA_WIND_MAX_MS : (SEA_WIND_MAX_MS * (step + 0.5)) / 2048;
        for (const k of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
          axisSlopes(wind, k, 0, slopes);
          for (let az = 0; az <= 90; az += 7.5) {
            most = Math.max(most, axisLobe(cosNH, slopes[0], slopes[1], Math.cos(az * DEG) ** 2));
          }
        }
      }
      over = Math.max(over, most / bound);
      loosest = Math.max(loosest, bound / most);
    }
    // Never under, and not loose: within a few percent of the grid's largest.
    expect(over).toBeLessThanOrEqual(1);
    expect(loosest).toBeLessThan(1.03);
    // At the mirror it is the round bound's, the calm sea's 1 / (pi 0.003),
    // and it only falls as the tilt grows.
    expect(axisLobeBound(1) / beckmannLobeBound(1)).toBeCloseTo(1.002, 9);
    expect(axisLobeBound(1)).toBeCloseTo(1.002 / (Math.PI * 0.003), 6);
    let last = Infinity;
    for (let deg = 0; deg <= 89; deg += 0.25) {
      const b = axisLobeBound(Math.cos(deg * DEG));
      expect(b).toBeLessThanOrEqual(last);
      last = b;
    }
    // The round bound is not one: a light, steady wind's ellipse beats it.
    const tilt = Math.atan(Math.sqrt(0.006));
    axisSlopes(0, 1, 0, slopes);
    expect(axisLobe(Math.cos(tilt), slopes[0], slopes[1], 0)).toBeGreaterThan(1.3 * beckmannLobeBound(Math.cos(tilt)));
    // Past the last node the roughest wind's whole axis is the largest, in
    // closed form; at the node itself the table already says so.
    const atLast = Math.cos(Math.atan(Math.sqrt(AXIS_BOUND_TAN2_MAX)));
    axisSlopes(SEA_WIND_MAX_MS, 1, 0, slopes);
    const roughest = axisLobe(atLast, slopes[0], slopes[1], 1);
    expect(axisLobeBound(atLast) / roughest).toBeCloseTo(1.002, 9);
  });

  it('reads beside the line no more often for the ellipse: its bound at the mirror is the round one\'s', () => {
    const near = probePose(400, 5);
    const acrossKm = (y: number) => Math.asin(y) * EARTH_KM;
    const count = (sea: GlintMeterSea, sampler: SurfaceSampler) => {
      let n = 0;
      const counted: SurfaceSampler = (...a) => { n++; sampler(...a); };
      const peak = createBeamPeak();
      expect(scanBeam(near, LIGHT, sea, counted, table, scratch, peak)).toBe(true);
      return n;
    };
    const nearLand: SurfaceSampler = (x, y, z, o) => {
      o.windMs = 4; o.cloudKeep = 1; o.axisX = 0.6; o.axisY = 0.7;
      o.water = Math.atan2(x, z) < 6 * DEG && Math.abs(acrossKm(y)) < 32 ? 0 : 1;
    };
    expect(count(axisSea, nearLand)).toBe(count(axisSea, steady(4, 0.6, 0.7)));
  });
});
