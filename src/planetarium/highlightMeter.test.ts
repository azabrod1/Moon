import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  HIGHLIGHT_REACH_RADII, HighlightMeter, highlightMeterEnabled, parseGlintMeterParam, setHighlightMeterEnabled,
  type HighlightContext,
} from './highlightMeter';
import { EarthSurfaceMaps } from './world/surfaceMaps';
import { SUN_LIGHT_INTENSITY, SUN_LIGHT_LINEAR } from './sunLight';
import { NIGHT_FILL, OCEAN_BEAM_CAP, OCEAN_BEAM_KNEE, ROUGHNESS_MAP_WATER } from './world/surfaceShading';
import { SEA_WIND_MAX_MS } from './world/seaWind';
import { KM_PER_AU } from '../astronomy/constants';
import { CLOUD_TOP_KM } from './world/cloudDeck';

const EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Maps of an open 7 m/s sea, no cloud, decoded at once: with no axis
 *  unless the axis's two bytes are given. */
function openSeaMaps(axisBytes: [number, number] = [128, 128]): EarthSurfaceMaps {
  const decode = async (url: string, width: number, height: number) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const r = url.includes('rough') ? ROUGHNESS_MAP_WATER * 255 : url.includes('wind') ? (7 / SEA_WIND_MAX_MS) * 255 : 0;
      rgba[i * 4] = r; rgba[i * 4 + 3] = 255;
      // The wind's axis bytes at 128, none: the shipped map's encoding.
      if (url.includes('wind')) { rgba[i * 4 + 1] = axisBytes[0]; rgba[i * 4 + 2] = axisBytes[1]; }
    }
    return { rgba, width, height };
  };
  return new EarthSurfaceMaps({ water: 'rough', wind: 'wind', cloud: 'cloud' }, decode, { width: 36, height: 18 });
}

/** The probe's pose: 400 km over the +z pole, the Sun 10° high toward +x,
 *  the frame aimed at the ground `aimGroundAngleDeg` along the principal
 *  line (about where the beam's peak falls), its up the local vertical. */
function probeContext(altitudeKm = 400, sunElevDeg = 10, aimGroundAngleDeg = 10): HighlightContext {
  const sunDist = KM_PER_AU / EARTH_KM;
  const camera = new THREE.Vector3(0, 0, 1 + altitudeKm / EARTH_KM);
  const aim = new THREE.Vector3(Math.sin(aimGroundAngleDeg * DEG), 0, Math.cos(aimGroundAngleDeg * DEG));
  const view = aim.clone().sub(camera).normalize();
  const viewUp = new THREE.Vector3(0, 0, 1).addScaledVector(view, -view.z).normalize();
  return {
    camera,
    sun: new THREE.Vector3(sunDist * Math.cos(sunElevDeg * DEG), 0, 1 + sunDist * Math.sin(sunElevDeg * DEG)),
    lightIntensity: SUN_LIGHT_INTENSITY,
    lightLinear: SUN_LIGHT_LINEAR,
    airOn: true, airBlend: 1, hazeClearView: 0.35,
    cloudSpin: 0, cloudDrawn: true, cloudShadows: true, cloudHeightOverRadius: CLOUD_TOP_KM / EARTH_KM,
    moonShadows: [], moonShadowCount: 0, sunTan: 0, termWidth: NIGHT_FILL.earth.termWidth,
    view, viewUp,
    fovXDeg: 40, fovYDeg: 27,
    seaBeamOn: true, sunPathOn: true, windMapOn: true, seaAxisOn: true,
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
    // The cost as a session pays it, once the frames have settled: the first
    // runs cold, and a loaded test machine can make it milliseconds.
    for (let i = 0; i < 200; i++) meter.update(0.1, ctx);
    const warm = meter.telemetry();
    expect(warm.costUs).toBeGreaterThan(0);
    expect(warm.costUs).toBeLessThan(500);
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
      [{ seaBeamOn: false }, 'sea beam off'], [{ sunPathOn: false }, 'sun path off'], [{ windMapOn: false }, 'wind map not bound'],
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
    expect(t.maps.ready).toEqual(['water', 'wind', 'cloud']);
  });

  it('follows the lobe along the wind with the sea, and with its define off meters exactly the round lobe', async () => {
    // An oblique axis, the shipped map's NE-trades bytes.
    const oblique = new HighlightMeter(openSeaMaps([224, 202]), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    const round = new HighlightMeter(openSeaMaps(), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    expect(oblique.devDrawnAt([0, 0, 1])).toBeNull();
    for (const m of [oblique, round]) m.update(0.016, probeContext());
    await settle();
    const off = { ...probeContext(), seaAxisOn: false };
    oblique.update(0.1, off);
    round.update(0.1, off);
    const a = oblique.telemetry(), b = round.telemetry();
    expect(a.axis).toBe(false);
    expect(a.peakSample.axisX).toBeGreaterThan(0.7);
    expect({ ...a, peakSample: null, costUs: 0 }).toEqual({ ...b, peakSample: null, costUs: 0 });
    // On, the oblique sea's beam is another beam, and the twin reads it.
    oblique.update(0.1, probeContext());
    const on = oblique.telemetry();
    expect(on.axis).toBe(true);
    expect(on.drawnMax).not.toBe(b.drawnMax);
    const twin = oblique.devDrawnAt([Math.sin(0.2), 0, Math.cos(0.2)]);
    expect(twin?.drawn).toHaveLength(1);
    expect(twin!.drawn[0]).toBeGreaterThan(0);
    // Off the line an oblique axis draws the two sides differently, and the
    // mirrored decode swaps them: the line is this pose's plane of symmetry.
    const left = oblique.devDrawnAt([Math.sin(0.2) * Math.cos(0.02), Math.sin(0.02), Math.cos(0.2) * Math.cos(0.02)])!.drawn[0];
    const leftMirrored = oblique.devDrawnAt([Math.sin(0.2) * Math.cos(0.02), Math.sin(0.02), Math.cos(0.2) * Math.cos(0.02)], { mirror: true })!.drawn[0];
    const right = oblique.devDrawnAt([Math.sin(0.2) * Math.cos(0.02), -Math.sin(0.02), Math.cos(0.2) * Math.cos(0.02)])!.drawn[0];
    expect(left).not.toBeCloseTo(right, 6);
    expect(leftMirrored).toBeCloseTo(right, 9);
  });
});

/** Maps of an open sea at one wind under a deck of one coverage, in at once. */
function uniformMaps(windMs: number, coverage: number): EarthSurfaceMaps {
  const maps = new EarthSurfaceMaps({ water: 'rough', wind: 'wind', cloud: 'cloud' }, async () => { throw new Error('installed'); }, { width: 36, height: 18 });
  const fill = (v: number) => ({ width: 36, height: 18, data: new Uint8Array(36 * 18).fill(Math.round(v * 255)) });
  maps.install('water', fill(1));
  maps.install('wind', fill(windMs / SEA_WIND_MAX_MS));
  maps.install('cloud', fill(coverage));
  return maps;
}

/** The same maps, recording each direction the deck is read along. */
class RecordingMaps extends EarthSurfaceMaps {
  readonly toward: [number, number, number][] = [];
  keepToward(nx: number, ny: number, nz: number, dx: number, dy: number, dz: number, hOverR: number, spin: number): number {
    this.toward.push([dx, dy, dz]);
    return super.keepToward(nx, ny, nz, dx, dy, dz, hOverR, spin);
  }
}

describe('the cloud between the sea and the camera', () => {
  beforeEach(() => setHighlightMeterEnabled(true));
  const shoulder = () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP });
  const settled = (meter: HighlightMeter, ctx: HighlightContext) => {
    for (let i = 0; i < 40; i++) meter.update(0.1, ctx);
    return meter.telemetry();
  };

  it('cuts a beam under half cover on the way down and again on the way up (400 km, Sun 5°, 4 m/s)', () => {
    // Clear, the beam is past the target and the meter closes down.
    const clear = settled(new HighlightMeter(uniformMaps(4, 0), shoulder), probeContext(400, 5, 12));
    expect(clear.hold).toBe('metering');
    expect(clear.drawnMax).toBeGreaterThan(7);
    expect(clear.target).toBeLessThan(0.5);
    // Under half cover the deck takes its half twice: the Sun's ray through
    // it, and the deck drawn over the sea in the line of sight. What is left
    // is drawn under the target, and the meter asks for nothing.
    const covered = settled(new HighlightMeter(uniformMaps(4, 0.5), shoulder), probeContext(400, 5, 12));
    expect(covered.peakSample.cloudKeep).toBeCloseTo(0.5, 2);
    expect(covered.peakSample.deckKeep).toBeCloseTo(0.5, 2);
    expect(covered.drawnMax).toBeGreaterThan(2.0);
    expect(covered.drawnMax).toBeLessThan(2.3);
    expect(covered.drawnMax).toBeLessThan(covered.knobs.target);
    expect(covered.target).toBe(1);
  });

  it("reads the deck where the shader reads it, under the same switches", () => {
    const hOverR = CLOUD_TOP_KM / EARTH_KM;
    const ctx = probeContext(400, 5, 12);
    const sunDir = ctx.sun.clone().normalize();
    const sunward = (d: number[]) => d[0] * sunDir.x + d[1] * sunDir.y + d[2] * sunDir.z > 0.999;
    // Cloud shadows compiled: the Sun's side along the Sun's ray, the
    // camera's along the line of sight.
    let maps = new RecordingMaps({ water: 'rough', wind: 'wind', cloud: 'cloud' });
    for (const [k, v] of [['water', 1], ['wind', 4 / SEA_WIND_MAX_MS], ['cloud', 0.5]] as const) {
      maps.install(k, { width: 36, height: 18, data: new Uint8Array(36 * 18).fill(Math.round(v * 255)) });
    }
    const meter = new HighlightMeter(maps, shoulder);
    meter.update(0.1, ctx);
    expect(maps.toward.some(sunward)).toBe(true);
    expect(maps.toward.some((d) => !sunward(d))).toBe(true);
    // Without them the ground's cut reads straight over the point, as the
    // shader's does: no read along the Sun's ray.
    maps.toward.length = 0;
    meter.update(0.1, { ...ctx, cloudShadows: false });
    expect(maps.toward.some(sunward)).toBe(false);
    expect(meter.telemetry().peakSample.cloudKeep).toBeCloseTo(0.5, 2);
    // The deck hidden: the cut is held clear and nothing stands in the line
    // of sight, so neither side reads the deck at all.
    maps.toward.length = 0;
    meter.update(0.1, { ...ctx, cloudDrawn: false });
    expect(maps.toward.length).toBe(0);
    expect(meter.telemetry().peakSample.cloudKeep).toBe(1);
    expect(meter.telemetry().peakSample.deckKeep).toBe(1);
    // A camera under the deck (5 km, the deck at 10): the deck is above the
    // line of sight, so only the Sun's side is read.
    maps = new RecordingMaps({ water: 'rough', wind: 'wind', cloud: 'cloud' });
    for (const [k, v] of [['water', 1], ['wind', 4 / SEA_WIND_MAX_MS], ['cloud', 0.5]] as const) {
      maps.install(k, { width: 36, height: 18, data: new Uint8Array(36 * 18).fill(Math.round(v * 255)) });
    }
    const low = new HighlightMeter(maps, shoulder);
    const lowCtx = probeContext(5, 5, 0.2);
    expect(lowCtx.camera.length()).toBeLessThan(1 + hOverR);
    low.update(0.1, lowCtx);
    expect(low.telemetry().hold).toBe('metering');
    expect(maps.toward.length).toBeGreaterThan(0);
    expect(maps.toward.every(sunward)).toBe(true);
    expect(low.telemetry().peakSample.deckKeep).toBe(1);
    expect(low.telemetry().peakSample.cloudKeep).toBeCloseTo(0.5, 2);
  });
});

describe('a camera inside the air', () => {
  beforeEach(() => setHighlightMeterEnabled(true));

  it('meters the beam from 1 km through the air below the camera (Sun 2°, 4 m/s)', () => {
    const meter = new HighlightMeter(uniformMaps(4, 0), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    for (let i = 0; i < 40; i++) meter.update(0.1, probeContext(1, 2, 0.12));
    const t = meter.telemetry();
    expect(t.hold).toBe('metering');
    // Through the whole column this read 2.36, under the target, and the
    // meter asked for nothing while the shader drew 4.6 and more.
    expect(t.drawnMax).toBeGreaterThan(4.6);
    expect(t.drawnMax).toBeLessThan(6);
    expect(t.drawnMax).toBeGreaterThan(t.knobs.target);
  });
});

describe("a moon's shadow over the beam", () => {
  beforeEach(() => setHighlightMeterEnabled(true));

  it('asks for nothing for a beam the eclipse has put out (400 km, Sun 5°, 4 m/s)', () => {
    const shoulder = () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP });
    const ctx = probeContext(400, 5, 12);
    const clear = new HighlightMeter(uniformMaps(4, 0), shoulder);
    for (let i = 0; i < 40; i++) clear.update(0.1, ctx);
    const lit = clear.telemetry();
    expect(lit.target).toBeLessThan(0.5);
    // The Moon 60 radii sunward of where the clear beam peaks, its shadow's
    // axis through that point, fed as the ground's casters are fed.
    const phi = lit.groundAngleDeg * DEG;
    const n = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
    const moon = ctx.sun.clone().sub(n).normalize().multiplyScalar(60).add(n);
    const shadowed: HighlightContext = {
      ...ctx, moonShadows: [moon.x, moon.y, moon.z, 1737.4 / EARTH_KM], moonShadowCount: 1, sunTan: Math.tan((0.2666 * Math.PI) / 180),
    };
    const meter = new HighlightMeter(uniformMaps(4, 0), shoulder);
    for (let i = 0; i < 40; i++) meter.update(0.1, shadowed);
    const t = meter.telemetry();
    expect(t.hold).toBe('metering');
    expect(t.drawnMax).toBeLessThan(t.knobs.target);
    expect(t.target).toBe(1);
    expect(meter.exposure).toBe(1);
  });
});

describe("the beam's place in the frame", () => {
  beforeEach(() => setHighlightMeterEnabled(true));

  it('asks nothing for a beam the frame is turned away from, and all of it once the frame holds it', async () => {
    const meter = new HighlightMeter(openSeaMaps(), () => ({ knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP }));
    meter.update(0.016, probeContext());
    await settle();
    // Turned 180° about the vertical: the beam is behind the camera.
    const away = probeContext();
    away.view.x = -away.view.x;
    for (let i = 0; i < 30; i++) meter.update(0.1, away);
    let t = meter.telemetry();
    expect(t.hold).toBe('metering');
    expect(t.drawnMax).toBeGreaterThan(2.8);
    expect(t.peakFrame.inFront).toBe(false);
    expect(t.coverage).toBe(0);
    expect(t.target).toBe(1);
    expect(meter.update(0.1, away)).toBe(1);
    // Aimed at the beam: in the frame's middle, counted whole.
    const at = probeContext();
    for (let i = 0; i < 30; i++) meter.update(0.1, at);
    t = meter.telemetry();
    expect(t.peakFrame.inFront).toBe(true);
    expect(Math.abs(t.peakFrame.xDeg)).toBeLessThan(2);
    expect(Math.abs(t.peakFrame.yDeg)).toBeLessThan(3);
    expect(t.coverage).toBeGreaterThan(0.02);
    // Over this uniform 7 m/s sea the beam's red sits a little past the
    // target, so the ask is a little under one (the older test's bar).
    expect(t.target).toBeLessThan(1);
    expect(t.target).toBeGreaterThan(0.5);
    // Aimed 35° off to the side: the beam sits well past the frame's edge (a
    // 40° frame reaches 20°), nothing of its ellipse inside.
    const aside = probeContext();
    aside.view.applyAxisAngle(new THREE.Vector3(0, 0, 1), 35 * DEG);
    aside.viewUp.applyAxisAngle(new THREE.Vector3(0, 0, 1), 35 * DEG);
    for (let i = 0; i < 30; i++) meter.update(0.1, aside);
    t = meter.telemetry();
    expect(t.peakFrame.inFront).toBe(true);
    expect(Math.abs(t.peakFrame.xDeg)).toBeGreaterThan(28);
    expect(t.coverage).toBeLessThan(0.002);
    expect(t.target).toBe(1);
  });
});
