import { describe, expect, it } from 'vitest';
import {
  markerAlbedoProxy,
  markerMagnitude,
  markerVisual,
  PLANET_MARKER_PARAMS,
  type PlanetMarkerVisual,
} from './planetMarkers';
import { PLANETARIUM_BODIES } from './planets/planetData';

const byName = (name: string) => {
  const p = PLANETARIUM_BODIES.find((b) => b.name === name);
  if (!p) throw new Error(`no catalog body ${name}`);
  return p;
};

const visualFor = (name: string, distAU: number, sunDistAU: number): PlanetMarkerVisual => {
  const p = byName(name);
  const mag = markerMagnitude(p.radiusAU, distAU, sunDistAU, markerAlbedoProxy(p.markerColor));
  return markerVisual(mag);
};

describe('planetMarkers — catalog palette', () => {
  it('every body has a pale marker tint (not a pasted UI color)', () => {
    for (const body of PLANETARIUM_BODIES) {
      expect(body.markerColor, body.name).toBeTypeOf('number');
      // The beacon palette is pale by design — additive blending renders a
      // saturated tint as neon. Raw (pre-clamp) luminance is the honest pin:
      // every palette entry sits ≥ 0.5, while the saturated UI tints this
      // palette replaced (Mars 0x9a4a2a lum ≈ 0.26, Neptune 0x2a4ab8 ≈ 0.19)
      // fail it. The clamped proxy would pass anything, so don't test that.
      const r = ((body.markerColor >> 16) & 0xff) / 255;
      const g = ((body.markerColor >> 8) & 0xff) / 255;
      const b = (body.markerColor & 0xff) / 255;
      const rawLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(rawLum, body.name).toBeGreaterThanOrEqual(0.5);
      expect(markerAlbedoProxy(body.markerColor), body.name).toBeLessThanOrEqual(
        PLANET_MARKER_PARAMS.albedoMax,
      );
    }
  });
});

describe('planetMarkers — magnitude proxy', () => {
  it('lands near real apparent magnitudes at real geometries', () => {
    // Neptune from Earth: real ≈ +7.8. The proxy has no phase/opposition
    // effects, so a loose band is the honest pin.
    const neptune = byName('Neptune');
    const m = markerMagnitude(neptune.radiusAU, 29.1, 30.1, markerAlbedoProxy(neptune.markerColor));
    expect(m).toBeGreaterThan(6);
    expect(m).toBeLessThan(10);
    // Venus from Earth near greatest brilliancy distance: real ≈ −4.5.
    const venus = byName('Venus');
    const mv = markerMagnitude(venus.radiusAU, 0.7, 0.72, markerAlbedoProxy(venus.markerColor));
    expect(mv).toBeGreaterThan(-6.5);
    expect(mv).toBeLessThan(-3);
  });

  it('returns +Infinity on degenerate geometry', () => {
    expect(markerMagnitude(0, 1, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 0, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 1, 0, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 1, 1, 0)).toBe(Infinity);
  });

  it('returns +Infinity on non-finite geometry too — every degenerate input reaches the same floor', () => {
    // NaN would otherwise slip a NaN magnitude through; an infinite radius
    // would come out −Infinity, which markerVisual maps to the FAINT floor —
    // the exact opposite of what "infinitely bright" would suggest. Total
    // inputs → one documented answer.
    expect(markerMagnitude(NaN, 1, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, NaN, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 1, NaN, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 1, 1, NaN)).toBe(Infinity);
    expect(markerMagnitude(Infinity, 1, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, Infinity, 1, 0.5)).toBe(Infinity);
    expect(markerMagnitude(1e-4, 1, Infinity, 0.5)).toBe(Infinity);
    // And the floor renders as the faint end, never an inflated sprite.
    const v = markerVisual(Infinity);
    expect(v.sizeMul).toBeCloseTo(PLANET_MARKER_PARAMS.sizeMinScale, 12);
    expect(v.brightness).toBeCloseTo(PLANET_MARKER_PARAMS.brightnessMin, 12);
  });
});

describe('planetMarkers — visual ramp', () => {
  it('shrinks and dims monotonically with distance', () => {
    let prev = visualFor('Earth', 0.3, 1);
    for (const d of [0.7, 2, 5, 10, 20, 29]) {
      const v = visualFor('Earth', d, 1);
      expect(v.sizeMul, `d=${d}`).toBeLessThanOrEqual(prev.sizeMul + 1e-12);
      expect(v.brightness, `d=${d}`).toBeLessThanOrEqual(prev.brightness + 1e-12);
      prev = { ...v };
    }
  });

  it('Earth seen from Neptune reads clearly smaller and dimmer than from Mars', () => {
    const fromMars = visualFor('Earth', 0.6, 1);
    const fromNeptune = visualFor('Earth', 29.1, 1);
    expect(fromNeptune.sizeMul).toBeLessThan(fromMars.sizeMul * 0.75);
    expect(fromNeptune.brightness).toBeLessThan(fromMars.brightness * 0.85);
  });

  it('Venus stays at full scale from Earth — brightness drives, not distance', () => {
    const v = visualFor('Venus', 0.7, 0.72);
    expect(v.sizeMul).toBeCloseTo(1, 10);
    expect(v.brightness).toBeCloseTo(1, 10);
  });

  it('the faint end sits exactly on the findability floor, never below', () => {
    // Neptune from the inner system — the faintest real case.
    const v = visualFor('Neptune', 29, 30);
    expect(v.sizeMul).toBeCloseTo(PLANET_MARKER_PARAMS.sizeMinScale, 10);
    expect(v.brightness).toBeCloseTo(PLANET_MARKER_PARAMS.brightnessMin, 10);
    // Degenerate geometry (unresolvable flux) also lands on the floor.
    const dead = markerVisual(Infinity);
    expect(dead.sizeMul).toBeCloseTo(v.sizeMul, 10);
    expect(dead.brightness).toBeCloseTo(v.brightness, 10);
  });

  it('fills a caller-supplied out object without allocating', () => {
    const scratch: PlanetMarkerVisual = { sizeMul: -1, brightness: -1 };
    const returned = markerVisual(3, PLANET_MARKER_PARAMS, scratch);
    expect(returned).toBe(scratch);
    expect(returned).toEqual(markerVisual(3));
  });

  it('never re-balloons a marker past the viewport pin — the multiplier is bounded', () => {
    // Sweep magnitudes from far-bright to degenerate. Since the sprite's
    // absolute size is the viewport-pinned base (owned by PlanetLabels) times
    // this multiplier, and sizeMul is always in [sizeMinScale, 1], photometry
    // can shrink a fainter beacon but never grow one past the pin.
    for (const mag of [-30, -2.5, 0, 3, 7, 30, NaN, Infinity, -Infinity]) {
      const v = markerVisual(mag);
      expect(v.sizeMul, `mag=${mag}`).toBeLessThanOrEqual(1);
      expect(v.sizeMul, `mag=${mag}`).toBeGreaterThanOrEqual(PLANET_MARKER_PARAMS.sizeMinScale);
    }
  });
});
