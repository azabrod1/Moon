import { describe, it, expect } from 'vitest';
import {
  advanceExposureStops, beamRadianceAt, buildTransmittanceTable, coverageOfBeam, createBeamPeak, createGlintScratch,
  highlightTarget, lookupTransmittance, meanSquareSlopeOfWind, scanBeam, shoulder,
  type GlintMeterLight, type GlintMeterPose, type GlintMeterSea, type SurfaceSampler,
} from './glintMeter';
import { atmosphereParams, solarIrradianceScale, transmittanceToTopBoundary } from './atmosphereModel';
import { SEA_WATER_F0 } from './surfaceShading';
import { SEA_CALM_LOBE_WIND_MS, meanSquareSlope } from './seaWind';
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
  return { camera, sun, sunVisible: 1 };
}

/** The cream Sun at 3 the probe's earlier reports were read under. */
const OLD_LIGHT: GlintMeterLight = { intensity: 3, linear: [1, 0.9131, 0.7454], irradianceScale: solarIrradianceScale(1) };
const sea: GlintMeterSea = {
  waterF0: SEA_WATER_F0, calmMss: meanSquareSlope(SEA_CALM_LOBE_WIND_MS),
  knee: 3.5, cap: 7.0, hazeClearView: 0.35, airBlend: 1,
};
const openSea = (windMs: number, calm = 0, cloudKeep = 1): SurfaceSampler => (_x, _y, _z, out) => {
  out.calm = calm; out.windMs = windMs; out.water = 1; out.cloudKeep = cloudKeep;
};

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
    const land: SurfaceSampler = (_x, _y, _z, o) => { o.calm = 0; o.windMs = 7; o.water = 0; o.cloudKeep = 1; };
    beamRadianceAt(Math.sin(8 * DEG), 0, Math.cos(8 * DEG), pose, OLD_LIGHT, sea, land, table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    beamRadianceAt(Math.sin(8 * DEG), 0, Math.cos(8 * DEG), pose, OLD_LIGHT, sea, openSea(7, 0, 0), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    // Behind the horizon from 400 km (the horizon is 19.8° of ground).
    beamRadianceAt(Math.sin(40 * DEG), 0, Math.cos(40 * DEG), pose, OLD_LIGHT, sea, openSea(7), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
    // Away from the Sun, past the terminator.
    beamRadianceAt(-Math.sin(100 * DEG), 0, Math.cos(100 * DEG), pose, OLD_LIGHT, sea, openSea(7), table, scratch, out);
    expect(out).toEqual([0, 0, 0]);
  });
});

describe('the scan at the probe pose (400 km, Sun 10°, 7.03 m/s, no calm)', () => {
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
    expect(peak.sample.calm).toBe(0);
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
    // A brighter beam (a calm patch under the mirror point) asks for more.
    const calmPeak = createBeamPeak();
    expect(scanBeam(pose, OLD_LIGHT, sea, openSea(7.03, 0.5), table, scratch, calmPeak)).toBe(true);
    expect(calmPeak.drawnMax).toBeGreaterThan(peak.drawnMax);
    const e = highlightTarget(calmPeak.drawnMax, cov);
    expect(e).toBeLessThan(plain);
    expect(e).toBeGreaterThanOrEqual(0.25);
    // From 35 786 km with the Sun 60° high the sheen is faint: factor 1.
    const geo = createBeamPeak();
    expect(scanBeam(probePose(35786, 60), OLD_LIGHT, sea, openSea(7.03, 0.5), table, scratch, geo)).toBe(true);
    expect(geo.drawnMax).toBeLessThan(2.8);
    expect(highlightTarget(geo.drawnMax, coverageOfBeam(geo.halfWidthAlongDeg, geo.halfWidthAcrossDeg, 20, 14))).toBe(1);
  });

  it('has no beam with the Sun on the camera\'s zenith, or from inside the body', () => {
    const zenith: GlintMeterPose = { camera: [0, 0, 1.06], sun: [0, 0, 23000], sunVisible: 1 };
    expect(scanBeam(zenith, OLD_LIGHT, sea, openSea(7), table, scratch, createBeamPeak())).toBe(false);
    const inside: GlintMeterPose = { camera: [0, 0, 0.5], sun: [23000, 0, 0], sunVisible: 1 };
    expect(scanBeam(inside, OLD_LIGHT, sea, openSea(7), table, scratch, createBeamPeak())).toBe(false);
    // A pure-land sampler finds nothing either.
    const land: SurfaceSampler = (_x, _y, _z, o) => { o.calm = 0; o.windMs = 7; o.water = 0; o.cloudKeep = 1; };
    expect(scanBeam(pose, OLD_LIGHT, sea, land, table, scratch, createBeamPeak())).toBe(false);
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
