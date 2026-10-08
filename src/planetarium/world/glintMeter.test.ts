import { describe, it, expect } from 'vitest';
import {
  HIGHLIGHT_KNOBS, advanceExposureStops, beamRadianceAt, beckmannLobe, beckmannLobeBound, buildColumnDepthTable, buildTransmittanceTable, lookupColumnDepth, coverageOfBeam, createBeamPeak, createBeamPlace, createGlintScratch,
  highlightTarget, lookupTransmittance, meanSquareSlopeOfWind, sunVisibleAt, placeBeamInFrame, scanBeam, shoulder, type BeamPlace,
  type GlintMeterLight, type GlintMeterPose, type GlintMeterSea, type SurfaceSampler,
} from './glintMeter';
import {
  atmosphereParams, opticalDepthToTopBoundary, solarIrradianceScale, transmittanceOverSegment, transmittanceToTopBoundary,
} from './atmosphereModel';
import { OCEAN_BEAM_CAP, OCEAN_BEAM_KNEE, SEA_WATER_F0 } from './surfaceShading';
import { SUN_LIGHT_INTENSITY, SUN_LIGHT_LINEAR } from '../sunLight';
import { meanSquareSlope } from './seaWind';
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
    // Even over a 7 m/s sea the beam's red channel sits past the target —
    // the white smear the meter is for — so it asks for a little less, well
    // short of the floor.
    const plain = highlightTarget(peak.drawnMax, cov);
    expect(peak.drawnMax).toBeGreaterThan(2.8);
    expect(plain).toBeLessThan(1);
    expect(plain).toBeGreaterThan(0.6);
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

  it('places a peak beside the line beside the line in the frame', () => {
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
    // Both, as a uniform half cover gives them: the review's numbers, the
    // clear beam well past the target and the covered one under it.
    const both = createBeamPeak();
    scanBeam(pose, LIGHT, beamSea, underDeck(0.5, 0.5), table, scratch, both);
    expect(sunSide.drawnMax).toBeCloseTo(4.26, 1);
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
    // nothing; through the segment the same point draws 4.62, and the
    // brightest one more.
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
    expect(oracle).toBeGreaterThan(4.62);
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
