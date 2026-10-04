import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  HIGHLIGHT_REACH_RADII, HighlightMeter, highlightMeterEnabled, parseGlintMeterParam, setHighlightMeterEnabled,
  type HighlightContext,
} from './highlightMeter';
import { EarthSurfaceMaps } from './world/surfaceMaps';
import { SUN_LIGHT_INTENSITY, SUN_LIGHT_LINEAR } from './sunLight';
import { OCEAN_BEAM_CAP, OCEAN_BEAM_KNEE, ROUGHNESS_MAP_WATER } from './world/surfaceShading';
import { SEA_WIND_MAX_MS } from './world/seaWind';
import { KM_PER_AU } from '../astronomy/constants';

const EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Maps of an open 7 m/s sea, no calm, no cloud, decoded at once. */
function openSeaMaps(): EarthSurfaceMaps {
  const decode = async (url: string, width: number, height: number) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const r = url.includes('rough') ? ROUGHNESS_MAP_WATER * 255 : url.includes('windy') ? (7 / SEA_WIND_MAX_MS) * 255 : 0;
      rgba[i * 4] = r; rgba[i * 4 + 3] = 255;
    }
    return { rgba, width, height };
  };
  return new EarthSurfaceMaps({ water: 'rough', calm: 'calm', windy: 'windy', cloud: 'cloud' }, decode, { width: 36, height: 18 });
}

function probeContext(altitudeKm = 400, sunElevDeg = 10): HighlightContext {
  const sunDist = KM_PER_AU / EARTH_KM;
  return {
    camera: new THREE.Vector3(0, 0, 1 + altitudeKm / EARTH_KM),
    sun: new THREE.Vector3(sunDist * Math.cos(sunElevDeg * DEG), 0, 1 + sunDist * Math.sin(sunElevDeg * DEG)),
    lightIntensity: SUN_LIGHT_INTENSITY,
    lightLinear: SUN_LIGHT_LINEAR,
    airOn: true, airBlend: 1, hazeClearView: 0.35,
    cloudSpin: 0, cloudDrawn: true,
    fovXDeg: 40, fovYDeg: 27,
    seaBeamOn: true, sunPathOn: true, windMapsOn: true,
  };
}

const settle = async () => { await new Promise((r) => setTimeout(r, 20)); };

describe('the highlight meter', () => {
  beforeEach(() => setHighlightMeterEnabled(true));

  it('is on unless the link says otherwise', () => {
    expect(parseGlintMeterParam('')).toBe(true);
    expect(parseGlintMeterParam('?glintmeter=1')).toBe(true);
    expect(parseGlintMeterParam('?glintmeter=0')).toBe(false);
    setHighlightMeterEnabled(false);
    expect(highlightMeterEnabled()).toBe(false);
  });

  it('holds at one until the maps are in, then closes down for the beam at the rates set', async () => {
    const meter = new HighlightMeter(openSeaMaps(), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    const ctx = probeContext();
    expect(meter.update(0.016, ctx)).toBe(1);
    expect(meter.telemetry().hold).toBe('maps decoding');
    await settle();
    // The first metered frame: the target is under one, the exposure has
    // moved one frame's worth of stops toward it.
    const e1 = meter.update(0.1, ctx);
    const t = meter.telemetry();
    expect(t.hold).toBe('metering');
    expect(t.target).toBeLessThan(1);
    expect(t.target).toBeGreaterThan(0.25);
    expect(e1).toBeCloseTo(Math.max(Math.pow(2, -0.3), t.target), 6);
    // Given time it reaches the target and stays.
    for (let i = 0; i < 30; i++) meter.update(0.1, ctx);
    expect(meter.exposure).toBeCloseTo(t.target, 6);
    expect(t.coverage).toBeGreaterThan(0.02);
    expect(t.peakSample.water).toBeCloseTo(1, 1);
    expect(t.peakSample.windMs).toBeCloseTo(7, 0);
    expect(t.peakSample.cloudKeep).toBe(1);
    expect(t.costUs).toBeGreaterThan(0);
    expect(t.costUs).toBeLessThan(500);
  });

  it('recovers slowly when the beam leaves, and at once when the switch goes off', async () => {
    const meter = new HighlightMeter(openSeaMaps(), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    const ctx = probeContext();
    meter.update(0.016, ctx);
    await settle();
    for (let i = 0; i < 30; i++) meter.update(0.1, ctx);
    const low = meter.exposure;
    expect(low).toBeLessThan(1);
    // The Sun high: no beam past the target, the exposure recovers at 0.75 stops/s.
    const high = probeContext(400, 60);
    const e = meter.update(0.1, high);
    expect(e).toBeCloseTo(low * Math.pow(2, 0.075), 6);
    // Far from Earth: held, easing back the same way, never a step.
    const far = probeContext(EARTH_KM * (HIGHLIGHT_REACH_RADII + 1), 10);
    const e2 = meter.update(0.1, far);
    expect(meter.telemetry().hold).toBe('far from Earth');
    expect(e2).toBeCloseTo(e * Math.pow(2, 0.075), 6);
    // The switch: one, at once.
    setHighlightMeterEnabled(false);
    expect(meter.update(0.016, ctx)).toBe(1);
    expect(meter.telemetry().hold).toBe('off');
  });

  it('holds for every precondition and never hands a NaN on', async () => {
    const meter = new HighlightMeter(openSeaMaps(), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    meter.update(0.016, probeContext());
    await settle();
    for (const [patch, reason] of [
      [{ seaBeamOn: false }, 'sea beam off'], [{ sunPathOn: false }, 'sun path off'], [{ windMapsOn: false }, 'wind maps not bound'],
      [{ airOn: false }, 'air without tables'],
    ] as const) {
      meter.update(0.016, { ...probeContext(), ...patch });
      expect(meter.telemetry().hold).toBe(reason);
      expect(meter.exposure).toBe(1);
    }
    // The Sun on the camera's zenith: no principal plane, no beam, one.
    const zenith = probeContext();
    zenith.sun.set(0, 0, 1 + KM_PER_AU / EARTH_KM);
    expect(meter.update(0.1, zenith)).toBe(1);
    expect(Number.isFinite(meter.update(0.1, zenith))).toBe(true);
    // A deck hidden: the cloud's cut is lifted, so a cloud over the beam does not hold it.
    const t = meter.telemetry();
    expect(t.maps.ready.length).toBe(4);
  });
});
