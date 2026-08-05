import { describe, it, expect } from 'vitest';
import {
  compressRadius,
  curveRadius,
  defaultMapCurve,
  fitDistanceAU,
  isAtOverviewFit,
  mapCompressedRadius,
  mapExtentAU,
  mapRadius,
  projectMapPoint,
  sanitizeMapCurve,
  diveRestoreDistanceAU,
  MAP_ASINH_S0_DEFAULT,
  MAP_BLEND_COMPRESSED,
  MAP_BLEND_TRUE,
  MAP_GAMMA_DEFAULT,
  MAP_GAMMA_MAX,
  MAP_GAMMA_MIN,
  MAP_S0_MAX,
  MAP_S0_MIN,
  type MapCurve,
} from './mapProjection';

// Real semi-major axes (AU) — the ordering the compression must preserve.
const AU = {
  mercury: 0.387,
  venus: 0.723,
  earth: 1.0,
  mars: 1.524,
  jupiter: 5.203,
  saturn: 9.537,
  uranus: 19.19,
  neptune: 30.07,
  pluto: 39.48,
};

const CURVE = defaultMapCurve();
const LEGACY: MapCurve = { kind: 'power', gamma: MAP_GAMMA_DEFAULT };

describe('mapCompressedRadius', () => {
  it('draws the landmark radii at the shipped softening scale', () => {
    expect(mapCompressedRadius(AU.mercury)).toBeCloseTo(0.3642, 4);
    expect(mapCompressedRadius(AU.earth)).toBeCloseTo(0.7703, 4);
    expect(mapCompressedRadius(AU.pluto)).toBeCloseTo(2.9279, 4);
  });

  it('never expands the inner system, unlike the power law', () => {
    // The whole point of the swap: sub-AU radii stay at or under true, where
    // r^0.45 pushed Mercury's 0.39 AU out past 0.65.
    for (const r of [AU.mercury, AU.venus, AU.earth]) {
      expect(mapCompressedRadius(r)).toBeLessThanOrEqual(r);
    }
    expect(compressRadius(AU.mercury, MAP_GAMMA_DEFAULT)).toBeGreaterThan(AU.mercury);
  });

  it('keeps the inner-system ratios closer to true than the power law does', () => {
    const trueRatio = AU.earth / AU.mercury;
    const asinhRatio = mapCompressedRadius(AU.earth) / mapCompressedRadius(AU.mercury);
    const powerRatio =
      compressRadius(AU.earth, MAP_GAMMA_DEFAULT) / compressRadius(AU.mercury, MAP_GAMMA_DEFAULT);
    expect(Math.abs(asinhRatio - trueRatio)).toBeLessThan(Math.abs(powerRatio - trueRatio));
  });

  it('has a finite slope at the Sun — no runaway magnification at r = 0', () => {
    // The power law's derivative diverges as r -> 0; asinh's tends to 1.
    const h = 1e-6;
    expect(mapCompressedRadius(h) / h).toBeCloseTo(1, 6);
    expect(compressRadius(h, MAP_GAMMA_DEFAULT) / h).toBeGreaterThan(1e3);
  });

  it('maps zero/negative radius to zero', () => {
    expect(mapCompressedRadius(0)).toBe(0);
    expect(mapCompressedRadius(-3)).toBe(0);
  });
});

describe('mapRadius blend', () => {
  it('is the pure curve at the compressed end and true distance at the other', () => {
    for (const r of Object.values(AU)) {
      expect(mapRadius(r, MAP_BLEND_COMPRESSED, CURVE)).toBe(mapCompressedRadius(r));
      // Exactly true, not merely close — True scale is true to the last bit.
      expect(mapRadius(r, MAP_BLEND_TRUE, CURVE)).toBe(r);
      expect(mapRadius(r, MAP_BLEND_TRUE, LEGACY)).toBe(r);
    }
  });

  it('is monotonic in radius at every blend, on either curve', () => {
    const ordered = Object.values(AU); // already sorted ascending
    for (const curve of [CURVE, LEGACY]) {
      for (let k = 0; k <= 1.0001; k += 0.05) {
        let prev = 0;
        for (const r of ordered) {
          const drawn = mapRadius(r, Math.min(k, 1), curve);
          expect(drawn).toBeGreaterThan(prev);
          prev = drawn;
        }
      }
    }
  });

  it('never flips the catalog ordering part-way through the animation', () => {
    // Sampled at the eased blend values a 400 ms toggle actually visits.
    const ordered = Object.values(AU);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const k = t * t * (3 - 2 * t); // the smoothstep the toggle animates on
      const drawn = ordered.map((r) => mapRadius(r, k, CURVE));
      for (let j = 1; j < drawn.length; j++) {
        expect(drawn[j]).toBeGreaterThan(drawn[j - 1]);
      }
    }
  });

  it('moves each radius monotonically outward as the blend runs to true', () => {
    for (const r of Object.values(AU)) {
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const drawn = mapRadius(r, i / 20, CURVE);
        expect(drawn).toBeGreaterThanOrEqual(prev);
        prev = drawn;
      }
      expect(prev).toBe(r);
    }
  });

  it('maps zero/negative radius to zero at any blend', () => {
    expect(mapRadius(0, 0.5, CURVE)).toBe(0);
    expect(mapRadius(-3, 0.5, CURVE)).toBe(0);
  });
});

describe('curve selection', () => {
  it('evaluates whichever curve it is handed', () => {
    expect(curveRadius(AU.pluto, CURVE)).toBeCloseTo(mapCompressedRadius(AU.pluto), 12);
    expect(curveRadius(AU.pluto, LEGACY)).toBeCloseTo(
      compressRadius(AU.pluto, MAP_GAMMA_DEFAULT),
      12,
    );
  });

  it('leaves the power law exactly as it was — the comparison is like for like', () => {
    expect(compressRadius(AU.mercury, MAP_GAMMA_DEFAULT)).toBeCloseTo(0.6523, 3);
    expect(compressRadius(AU.pluto, MAP_GAMMA_DEFAULT)).toBeCloseTo(5.2284, 3);
    expect(compressRadius(AU.earth, 1)).toBeCloseTo(AU.earth, 12);
    expect(compressRadius(0, MAP_GAMMA_DEFAULT)).toBe(0);
    expect(compressRadius(-3, MAP_GAMMA_DEFAULT)).toBe(0);
  });

  it('ships the asinh curve at the default softening scale', () => {
    const curve = defaultMapCurve();
    expect(curve.kind).toBe('asinh');
    expect(curve.kind === 'asinh' && curve.s0).toBe(MAP_ASINH_S0_DEFAULT);
    // A factory, not a shared object: retuning one holder can't move another's.
    expect(defaultMapCurve()).not.toBe(curve);
  });

  it('compresses harder at a smaller softening scale', () => {
    const tight = mapCompressedRadius(AU.pluto, 0.3);
    const loose = mapCompressedRadius(AU.pluto, 1.2);
    expect(tight).toBeLessThan(loose);
  });
});

describe('sanitizeMapCurve', () => {
  it('passes a usable curve through', () => {
    expect(sanitizeMapCurve({ kind: 'asinh', s0: 0.6 })).toEqual({ kind: 'asinh', s0: 0.6 });
    expect(sanitizeMapCurve({ kind: 'power', gamma: 0.45 })).toEqual({ kind: 'power', gamma: 0.45 });
    expect(sanitizeMapCurve(defaultMapCurve())).toEqual(defaultMapCurve());
  });

  it('rejects a softening scale the curve cannot be evaluated at', () => {
    // s0 = 0 divides by zero; the rest poison every radius on the map.
    expect(sanitizeMapCurve({ kind: 'asinh', s0: 0 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'asinh', s0: -0.6 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'asinh', s0: NaN })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'asinh', s0: Infinity })).toBeNull();
  });

  it('rejects an exponent that would flatten or reverse the map', () => {
    // gamma = 0 draws every radius at 1; a negative one puts Pluto inside Mercury.
    expect(sanitizeMapCurve({ kind: 'power', gamma: 0 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: -0.45 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: NaN })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: Infinity })).toBeNull();
  });

  it('accepts both ends of the tuning windows', () => {
    expect(sanitizeMapCurve({ kind: 'asinh', s0: MAP_S0_MIN })).toEqual({
      kind: 'asinh',
      s0: MAP_S0_MIN,
    });
    expect(sanitizeMapCurve({ kind: 'asinh', s0: MAP_S0_MAX })).toEqual({
      kind: 'asinh',
      s0: MAP_S0_MAX,
    });
    expect(sanitizeMapCurve({ kind: 'power', gamma: MAP_GAMMA_MIN })).toEqual({
      kind: 'power',
      gamma: MAP_GAMMA_MIN,
    });
    expect(sanitizeMapCurve({ kind: 'power', gamma: MAP_GAMMA_MAX })).toEqual({
      kind: 'power',
      gamma: MAP_GAMMA_MAX,
    });
    // The shipped settings sit inside their windows.
    expect(sanitizeMapCurve(defaultMapCurve())).not.toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: MAP_GAMMA_DEFAULT })).not.toBeNull();
  });

  it('rejects parameters just outside the windows', () => {
    expect(sanitizeMapCurve({ kind: 'asinh', s0: MAP_S0_MIN * 0.9 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'asinh', s0: MAP_S0_MAX * 1.001 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: MAP_GAMMA_MIN * 0.9 })).toBeNull();
    expect(sanitizeMapCurve({ kind: 'power', gamma: MAP_GAMMA_MAX * 1.001 })).toBeNull();
  });

  it('rejects finite parameters whose OUTPUT would blow up', () => {
    // Positive and finite, yet the map they draw is not: r^194 overflows on
    // Pluto, and r / 5e-324 is Infinity for every body.
    expect(compressRadius(AU.pluto, 194)).toBe(Infinity);
    expect(sanitizeMapCurve({ kind: 'power', gamma: 194 })).toBeNull();
    expect(AU.pluto / Number.MIN_VALUE).toBe(Infinity);
    expect(sanitizeMapCurve({ kind: 'asinh', s0: Number.MIN_VALUE })).toBeNull();
  });

  it('returns a copy, so a caller mutating its object cannot move the map', () => {
    const asked: MapCurve = { kind: 'asinh', s0: 0.6 };
    const held = sanitizeMapCurve(asked);
    expect(held).not.toBe(asked);
    asked.s0 = 99;
    expect(held).toEqual({ kind: 'asinh', s0: 0.6 });
  });
});

describe('projectMapPoint', () => {
  it('preserves direction and compresses the radius', () => {
    const out = { x: 0, y: 0, z: 0 };
    // A point 5 AU out along a diagonal.
    const x = 3;
    const y = 0;
    const z = 4; // r = 5
    projectMapPoint(x, y, z, MAP_BLEND_COMPRESSED, CURVE, out);
    const rOut = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    expect(rOut).toBeCloseTo(mapCompressedRadius(5), 10);
    // Same unit direction.
    expect(out.x / rOut).toBeCloseTo(3 / 5, 10);
    expect(out.z / rOut).toBeCloseTo(4 / 5, 10);
  });

  it('is the identity at the true end of the blend', () => {
    const out = { x: 0, y: 0, z: 0 };
    projectMapPoint(2, -1, 2, MAP_BLEND_TRUE, CURVE, out); // r = 3
    expect(out.x).toBeCloseTo(2, 10);
    expect(out.y).toBeCloseTo(-1, 10);
    expect(out.z).toBeCloseTo(2, 10);
  });

  it('collapses the origin to the origin', () => {
    const out = { x: 9, y: 9, z: 9 };
    projectMapPoint(0, 0, 0, MAP_BLEND_COMPRESSED, CURVE, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('mapExtentAU', () => {
  it('returns the largest drawn radius', () => {
    const radii = [AU.earth, AU.jupiter, AU.pluto];
    expect(mapExtentAU(radii, MAP_BLEND_COMPRESSED, CURVE)).toBeCloseTo(
      mapCompressedRadius(AU.pluto),
      12,
    );
  });

  it('lets a ship past Pluto set the extent', () => {
    const shipR = 60; // AU, well beyond Pluto
    const withShip = mapExtentAU([AU.pluto, shipR], MAP_BLEND_COMPRESSED, CURVE);
    const withoutShip = mapExtentAU([AU.pluto], MAP_BLEND_COMPRESSED, CURVE);
    expect(withShip).toBeGreaterThan(withoutShip);
    expect(withShip).toBeCloseTo(mapCompressedRadius(shipR), 12);
  });

  it('is empty-safe', () => {
    expect(mapExtentAU([], MAP_BLEND_COMPRESSED, CURVE)).toBe(0);
  });
});

describe('fitDistanceAU', () => {
  it('frames the extent within the vertical FOV with margin', () => {
    const extent = 5;
    const fov = 50;
    const dist = fitDistanceAU(extent, fov, 1, 1.18);
    // The extent should subtend the margin-inflated half-FOV at that distance.
    const half = (fov * Math.PI) / 180 / 2;
    expect(dist * Math.tan(half)).toBeCloseTo(extent * 1.18, 6);
  });

  it('backs the camera off further on a portrait aspect', () => {
    const landscape = fitDistanceAU(5, 50, 16 / 9);
    const portrait = fitDistanceAU(5, 50, 9 / 16);
    expect(portrait).toBeGreaterThan(landscape);
  });

  it('grows with the extent', () => {
    expect(fitDistanceAU(10, 50, 1)).toBeGreaterThan(fitDistanceAU(5, 50, 1));
  });

  // The phone framing is a decision, not an accident: on portrait the WIDTH
  // binds, so height taken by chrome cannot buy a closer fit and the chart's
  // vertical air is the price of a round system in a tall frame. Pinned so the
  // reasoning in fitDistanceAU's own comment cannot go quietly stale — a change
  // to the FOV or the margin that made the height bind on a phone lands here.
  it('portrait fits the width, with height to spare no chrome band can reach', () => {
    const extent = 3.06; // the live compressed chart's extent, measured
    const fov = 50; // MAP_FOV_DEG
    const aspect = 390 / 844; // the phone the chart is tuned against
    const dist = fitDistanceAU(extent, fov, aspect);
    const halfHeightAU = dist * Math.tan((fov * Math.PI) / 180 / 2);
    const halfWidthAU = halfHeightAU * aspect;
    // The width is what the fit filled: the disc plus its margin, exactly.
    expect(halfWidthAU).toBeCloseTo(extent * 1.18, 6);
    // The height it left is more than twice what the disc needs, so trimming a
    // chrome band off the bottom leaves the width binding either way.
    expect(halfHeightAU / (extent * 1.18)).toBeGreaterThan(2);
  });
});

describe('eccentric-orbit extent', () => {
  // The map's per-orbit reach is the largest projected sample radius (the
  // aphelion), the way recompressOrbits tracks it — NOT the compressed
  // semi-major axis, which an eccentric orbit drawn at true scale overflows.
  const a = AU.pluto; // 39.48 — the case that overflows a semi-major fit
  const e = 0.25; // eccentric enough that the aphelion clears the mean radius

  function sweepOrbit(blend: number, curve: MapCurve) {
    const out = { x: 0, y: 0, z: 0 };
    const N = 180;
    let maxProjected = 0;
    let maxSampleR = 0;
    for (let i = 0; i < N; i++) {
      const theta = (i / N) * Math.PI * 2;
      // Kepler ellipse with the Sun at a focus: r peaks at aphelion (theta=pi).
      const r = (a * (1 - e * e)) / (1 + e * Math.cos(theta));
      projectMapPoint(r * Math.cos(theta), 0, r * Math.sin(theta), blend, curve, out);
      const projR = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
      if (projR > maxProjected) maxProjected = projR;
      if (r > maxSampleR) maxSampleR = r;
    }
    return { maxProjected, maxSampleR };
  }

  it('follows the aphelion sample, not the semi-major axis, at both ends of the blend', () => {
    const aphelion = a * (1 + e);
    for (const blend of [MAP_BLEND_COMPRESSED, MAP_BLEND_TRUE]) {
      const { maxProjected, maxSampleR } = sweepOrbit(blend, CURVE);
      expect(maxSampleR).toBeGreaterThan(a);
      expect(maxSampleR).toBeCloseTo(aphelion, 6);
      // The extent equals the aphelion sample drawn — and exceeds what a
      // semi-major-axis extent would have drawn.
      expect(maxProjected).toBeCloseTo(mapRadius(maxSampleR, blend, CURVE), 6);
      expect(maxProjected).toBeGreaterThan(mapRadius(a, blend, CURVE));
    }
  });

  it('holds on the power-law curve too', () => {
    const { maxProjected, maxSampleR } = sweepOrbit(MAP_BLEND_COMPRESSED, LEGACY);
    expect(maxProjected).toBeCloseTo(compressRadius(maxSampleR, MAP_GAMMA_DEFAULT), 6);
  });
});

describe('diveRestoreDistanceAU', () => {
  it('reduces to the pre-dive distance when the extent did not move', () => {
    const fit = 7.75;
    // A zoomed-in dive: ratio was 0.4 of the fit, so it restores 0.4 of the
    // same fit — the distance it left at.
    expect(diveRestoreDistanceAU(false, 0.4, fit)).toBeCloseTo(0.4 * fit, 12);
    expect(diveRestoreDistanceAU(true, 1, fit)).toBe(fit);
  });

  it('rebuilds the framing against an extent that changed during the dive', () => {
    // Dove from a Compressed overview, the toggle ran to True mid-dive: the
    // restore has to target the NEW fit, not the ~16x smaller old one.
    const freshFit = 124.8;
    expect(diveRestoreDistanceAU(true, 1, freshFit)).toBe(freshFit);
    // A zoomed dive keeps its fraction of the frame instead of its old distance.
    expect(diveRestoreDistanceAU(false, 0.5, freshFit)).toBeCloseTo(62.4, 12);
  });

  it('snaps a parked overview to the exact fit, ignoring damping drift', () => {
    // isAtOverviewFit tolerates ~2% drift, so the captured ratio is only near 1;
    // the overview branch must land on the fit exactly, not on the drift.
    expect(diveRestoreDistanceAU(true, 1.019, 10)).toBe(10);
  });
});

describe('isAtOverviewFit', () => {
  it('accepts the exact fit and small damping drift, rejects a deliberate zoom', () => {
    expect(isAtOverviewFit(10, 10)).toBe(true);
    expect(isAtOverviewFit(10.19, 10)).toBe(true); // 1.9% drift: still parked
    expect(isAtOverviewFit(10.3, 10)).toBe(false); // 3%: the user zoomed
    expect(isAtOverviewFit(4, 10)).toBe(false);
    expect(isAtOverviewFit(25, 10)).toBe(false);
  });

  it('never refits from a degenerate or unset state', () => {
    expect(isAtOverviewFit(10, 0)).toBe(false);
    expect(isAtOverviewFit(10, NaN)).toBe(false);
    expect(isAtOverviewFit(NaN, 10)).toBe(false);
    expect(isAtOverviewFit(Infinity, 10)).toBe(false);
    // An infinite fit would make the tolerance band infinite and accept
    // everything — reject it outright.
    expect(isAtOverviewFit(10, Infinity)).toBe(false);
    expect(isAtOverviewFit(Infinity, Infinity)).toBe(false);
  });
});
