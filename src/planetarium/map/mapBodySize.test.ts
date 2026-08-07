import { describe, it, expect } from 'vitest';
import {
  DOT_GRADIENT_STOPS,
  DOT_PAINTED_EDGE_MUL,
  DOT_PAINTED_FRACTION,
  dotGradientAlpha,
  labelClearanceRadiusPx,
  mapMoonMarkerRadiusAU,
  mapMoonRadiusAU,
  mapBodyRadiusAU,
  mapBodyRadiusPx,
  mapMarkerRadiusPx,
  mapSunRadiusAU,
  mapSunRadiusPx,
  DOT_EXTENT_MUL,
  MAP_BODY_SIZE_DEFAULTS,
  MAP_SUN_SIZE_DEFAULTS,
  type DotGradientStop,
  type MapBodySizeParams,
} from './mapBodySize';
import { mapLabelOffsetPx, LABEL_ANCHOR_OFFSET_PX, LABEL_CLEARANCE_PX } from './mapLabels';
import { MINI_BODY_SIZE_PARAMS, MINI_SUN_SIZE_PARAMS } from './miniChart';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { KM_PER_AU } from '../../astronomy/constants';

const P = MAP_BODY_SIZE_DEFAULTS;
const auOf = (km: number) => km / KM_PER_AU;

// True equatorial radii (km), ascending — the ordering the policy must keep.
const RADIUS_KM = {
  Mercury: 2440,
  Mars: 3390,
  Venus: 6052,
  Earth: 6371,
  Neptune: 24622,
  Uranus: 25362,
  Saturn: 58232,
  Jupiter: 69911,
  Sun: 696340,
};

describe('mapMarkerRadiusPx', () => {
  it('floors every body at the legibility minimum', () => {
    // A grain far below the reference radius, and a degenerate one.
    expect(mapMarkerRadiusPx(auOf(1))).toBe(P.minPx);
    expect(mapMarkerRadiusPx(0)).toBe(P.minPx);
    expect(mapMarkerRadiusPx(-1)).toBe(P.minPx);
    for (const km of Object.values(RADIUS_KM)) {
      expect(mapMarkerRadiusPx(auOf(km))).toBeGreaterThanOrEqual(P.minPx);
    }
  });

  it('draws the reference radius exactly on the floor', () => {
    expect(mapMarkerRadiusPx(P.refRadiusAU)).toBeCloseTo(P.minPx, 12);
  });

  it('keeps the planets size-ordered at the overview', () => {
    const planets = Object.entries(RADIUS_KM).filter(([name]) => name !== 'Sun');
    let prev = 0;
    for (const [, km] of planets) {
      const px = mapMarkerRadiusPx(auOf(km));
      expect(px).toBeGreaterThan(prev);
      prev = px;
    }
  });

  it('holds every planet under the cap, so the orbits stay dominant', () => {
    for (const [name, km] of Object.entries(RADIUS_KM)) {
      if (name === 'Sun') continue;
      expect(mapMarkerRadiusPx(auOf(km))).toBeLessThan(P.maxPx);
    }
    // The Sun is the one body the cap binds for — 33 px of marker otherwise.
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Sun))).toBe(P.maxPx);
  });

  it('compresses the true spread hard — markers, not marbles', () => {
    const trueRatio = RADIUS_KM.Jupiter / RADIUS_KM.Mercury; // ~28.7x
    const drawnRatio =
      mapMarkerRadiusPx(auOf(RADIUS_KM.Jupiter)) / mapMarkerRadiusPx(auOf(RADIUS_KM.Mercury));
    expect(trueRatio).toBeGreaterThan(28);
    expect(drawnRatio).toBeLessThan(3);
    expect(drawnRatio).toBeGreaterThan(1);
  });

  it('retunes from the params it is handed', () => {
    const flatter: MapBodySizeParams = { ...P, gamma: 0 };
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Jupiter), flatter)).toBe(P.minPx);
    const bigger: MapBodySizeParams = { ...P, minPx: 12, maxPx: 40 };
    expect(mapMarkerRadiusPx(auOf(RADIUS_KM.Earth), bigger)).toBeGreaterThan(
      mapMarkerRadiusPx(auOf(RADIUS_KM.Earth)),
    );
  });
});

describe('mapBodyRadiusPx', () => {
  const earth = auOf(RADIUS_KM.Earth);

  it('keeps the marker while the true disc is smaller', () => {
    expect(mapBodyRadiusPx(earth, 0.001)).toBe(mapMarkerRadiusPx(earth));
  });

  it('hands over to true size once the disc overtakes the marker', () => {
    expect(mapBodyRadiusPx(earth, 300)).toBe(300);
  });

  it('meets truth exactly at the crossover — nothing pops', () => {
    const marker = mapMarkerRadiusPx(earth);
    expect(mapBodyRadiusPx(earth, marker)).toBe(marker);
    expect(mapBodyRadiusPx(earth, marker + 1e-9)).toBeCloseTo(marker, 6);
  });

  it('never draws a body smaller than its true projected size', () => {
    for (const km of Object.values(RADIUS_KM)) {
      const r = auOf(km);
      for (const truePx of [0.0001, 1, 5, 17.9, 18.1, 400]) {
        expect(mapBodyRadiusPx(r, truePx)).toBeGreaterThanOrEqual(truePx);
      }
    }
  });
});

describe('mapBodyRadiusAU', () => {
  const earth = auOf(RADIUS_KM.Earth);
  // 50 deg vertical FOV over an 800 px canvas — the map's own framing.
  const worldPerPxAtUnit = (2 * Math.tan((50 * Math.PI) / 180 / 2)) / 800;
  const drawnPx = (depthAU: number) =>
    mapBodyRadiusAU(earth, depthAU, worldPerPxAtUnit) / (worldPerPxAtUnit * depthAU);

  it('grows on screen as the camera closes, never shrinking', () => {
    let prev = 0;
    // 40 AU (whole-system overview) down to 1e-4 AU (a close pass).
    for (const depth of [40, 20, 10, 4, 1, 0.2, 0.02, 0.002, 4e-4, 1e-4]) {
      const px = drawnPx(depth);
      expect(px).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = px;
    }
  });

  it('is the marker at the overview and true size up close', () => {
    expect(drawnPx(40)).toBeCloseTo(mapMarkerRadiusPx(earth), 9);
    // Close enough that Earth's true disc dwarfs the marker: the drawn radius
    // is the real one, in AU.
    expect(mapBodyRadiusAU(earth, 1e-4, worldPerPxAtUnit)).toBeCloseTo(earth, 12);
  });

  it('survives a degenerate camera', () => {
    expect(mapBodyRadiusAU(earth, 0, worldPerPxAtUnit)).toBeGreaterThan(0);
    expect(mapBodyRadiusAU(earth, 10, 0)).toBe(earth);
  });
});

describe('the Sun branch', () => {
  const P = MAP_SUN_SIZE_DEFAULTS;
  const SUN_RADIUS_AU = auOf(696_340);

  it('answers zoom: never shrinks closing in, strictly grows once off the floor', () => {
    let prev = 0;
    for (const truePx of [0.02, 0.1, 0.5, 2, 8, 17]) {
      const px = mapSunRadiusPx(truePx);
      expect(px).toBeGreaterThanOrEqual(prev);
      if (prev > P.floorPx) expect(px).toBeGreaterThan(prev);
      prev = px;
    }
    // The responsive band covers the range that matters: a couple of true px
    // (a Jupiter-range view) is already off the floor.
    expect(mapSunRadiusPx(2)).toBeGreaterThan(P.floorPx);
  });

  it('rides the compressive curve between floor and pivot', () => {
    // Well inside the responsive band: the drawn size is the curve exactly.
    const truePx = 8;
    expect(mapSunRadiusPx(truePx)).toBeCloseTo(
      P.pivotPx * Math.pow(truePx / P.pivotPx, P.gamma),
      9,
    );
  });

  it('never draws below the floor, and the overview sits on it', () => {
    // A whole-system frame projects the Sun far below a pixel.
    for (const truePx of [1e-4, 0.01, 0.05]) {
      expect(mapSunRadiusPx(truePx)).toBeGreaterThanOrEqual(P.floorPx);
    }
    expect(mapSunRadiusPx(0.05)).toBe(P.floorPx);
  });

  it('hands over to the true disc exactly at the pivot, continuously', () => {
    // For gamma < 1 the curve sits above truth below the pivot and below it
    // past the pivot, so max() switches branch AT the pivot with equal value.
    expect(mapSunRadiusPx(P.pivotPx)).toBeCloseTo(P.pivotPx, 9);
    expect(mapSunRadiusPx(P.pivotPx * 0.999)).toBeGreaterThan(P.pivotPx * 0.999);
    expect(mapSunRadiusPx(P.pivotPx * 2)).toBeCloseTo(P.pivotPx * 2, 9);
    expect(mapSunRadiusPx(60)).toBe(60); // never shrinks a resolved disc
  });

  it('gamma 0 is the old constant branch — the corner chart look', () => {
    const constant = { gamma: 0, pivotPx: 6, floorPx: 6 };
    for (const truePx of [1e-4, 0.1, 2, 5.9]) {
      expect(mapSunRadiusPx(truePx, constant)).toBe(6);
    }
    expect(mapSunRadiusPx(9, constant)).toBe(9); // truth still overtakes
  });

  it('carries the same camera-factor contract as the body policy', () => {
    const sunAU = 0.00465;
    const worldPerPxAtUnit = (2 * Math.tan((50 * Math.PI) / 180 / 2)) / 800;
    for (const depth of [40, 8, 1.9, 0.2]) {
      const worldPerPx = worldPerPxAtUnit * depth;
      expect(mapSunRadiusAU(sunAU, depth, worldPerPxAtUnit) / worldPerPx)
        .toBeCloseTo(mapSunRadiusPx(sunAU / worldPerPx), 9);
    }
    expect(mapSunRadiusAU(sunAU, 0, worldPerPxAtUnit)).toBeGreaterThan(0);
    expect(mapSunRadiusAU(sunAU, 10, 0)).toBe(sunAU);
  });

  it('reproduces the corner chart\'s old Sun exactly, below and above its crossover', () => {
    // The mini chart's γ=0 config must be byte-identical to what the generic
    // policy used to draw there: the marker pinned to the mini cap (6 px),
    // truth overtaking past it. Sweep both sides of the crossover.
    for (const truePx of [1e-4, 0.5, 3, 5.99, 6, 6.01, 9, 40]) {
      expect(mapSunRadiusPx(truePx, MINI_SUN_SIZE_PARAMS)).toBe(
        mapBodyRadiusPx(SUN_RADIUS_AU, truePx, MINI_BODY_SIZE_PARAMS),
      );
    }
  });

  it('responds where the old cap sat pinned: a Jupiter-range view draws a smaller star', () => {
    // Compressed-map depth from a camera near Jupiter (~1.9 AU) projects the
    // Sun at ~2 px true; the old policy drew 18 px there regardless.
    const worldPerPxAtUnit = (2 * Math.tan((50 * Math.PI) / 180 / 2)) / 800;
    const truePx = 0.00465 / (worldPerPxAtUnit * 1.9);
    const px = mapSunRadiusPx(truePx);
    expect(px).toBeLessThan(12);
    expect(px).toBeGreaterThan(P.floorPx * 0.8);
  });
});

describe('the moon branch', () => {
  const GANYMEDE = 1.761e-5;
  const MIMAS = 1.325e-6;
  const METIS = 1.437e-7;
  // A parent drawn at its chart marker: Jupiter at the overview.
  const PARENT = 1e-4;

  it('puts the largest moon at the top of the band and holds the rest under it', () => {
    expect(mapMoonMarkerRadiusAU(GANYMEDE, PARENT)).toBeCloseTo(PARENT * 0.34, 12);
    for (const r of [GANYMEDE, MIMAS, METIS]) {
      expect(mapMoonMarkerRadiusAU(r, PARENT)).toBeLessThanOrEqual(PARENT * 0.36);
      expect(mapMoonMarkerRadiusAU(r, PARENT)).toBeGreaterThanOrEqual(PARENT * 0.03);
    }
  });

  it('keeps the moons ordered by true size while any of them is above the floor', () => {
    expect(mapMoonMarkerRadiusAU(GANYMEDE, PARENT))
      .toBeGreaterThan(mapMoonMarkerRadiusAU(MIMAS, PARENT));
    expect(mapMoonMarkerRadiusAU(MIMAS, PARENT))
      .toBeGreaterThan(mapMoonMarkerRadiusAU(METIS, PARENT));
  });

  it('scales the whole system with its parent, so it reads the same at any zoom', () => {
    const a = mapMoonMarkerRadiusAU(MIMAS, PARENT);
    const b = mapMoonMarkerRadiusAU(MIMAS, PARENT * 7);
    expect(b / a).toBeCloseTo(7, 9);
  });

  it('never draws a moon smaller than it really is', () => {
    // A camera close enough that Ganymede's true size passes its marker.
    const closeParent = GANYMEDE;
    expect(mapMoonRadiusAU(GANYMEDE, closeParent)).toBe(GANYMEDE);
    expect(mapMoonRadiusAU(GANYMEDE, PARENT)).toBeCloseTo(PARENT * 0.34, 12);
  });

  it('pins Ganymede\'s label clearance at the default marker, by expression', () => {
    // The case the draw-mode rule exists for. Jupiter at the chart's default
    // marker; Ganymede is drawn against it, so its marker is a fraction of
    // that. Every figure here is computed from the modules' own constants: a
    // transcribed decimal would drift the moment a knob moved.
    const jupiter = PLANETARIUM_BODIES.find((p) => p.name === 'Jupiter')!;
    const parentPx = mapMarkerRadiusPx(jupiter.radiusAU);
    expect(parentPx).toBeCloseTo(16.5277, 3);
    // The marker function is linear in the parent's drawn size, so feeding it px
    // answers in px.
    const drawnPx = mapMoonMarkerRadiusAU(GANYMEDE, parentPx);
    expect(drawnPx).toBeCloseTo(parentPx * 0.34, 12);
    expect(drawnPx).toBeCloseTo(5.6194, 3);

    const clearance = labelClearanceRadiusPx(drawnPx, true);
    expect(clearance).toBeCloseTo(drawnPx * DOT_PAINTED_EDGE_MUL, 12);
    expect(clearance).toBeCloseTo(5.6250, 3);
    // Composed: the offset the chart draws the name at. A marker this size
    // paints inside the flat floor, so the floor is what places the name — and
    // it clears the sprite by three px rather than printing inside it, which
    // is the whole of what the clearance rule is for.
    expect(mapLabelOffsetPx(clearance)).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(clearance)).toBeGreaterThan(clearance + LABEL_CLEARANCE_PX);
  });

  it('floors the smallest moons instead of losing them', () => {
    // Metis is a hundredth of Ganymede by radius and would be invisible on a
    // linear scale; the sqrt lands it just above the floor, and anything
    // smaller sits on it.
    expect(mapMoonMarkerRadiusAU(METIS, PARENT)).toBeGreaterThan(PARENT * 0.03);
    expect(mapMoonMarkerRadiusAU(METIS, PARENT)).toBeLessThan(PARENT * 0.032);
    expect(mapMoonMarkerRadiusAU(METIS / 100, PARENT)).toBeCloseTo(PARENT * 0.03, 12);
    expect(mapMoonMarkerRadiusAU(0, PARENT)).toBeCloseTo(PARENT * 0.03, 12);
  });
});

describe('labelClearanceRadiusPx', () => {
  it('gives a globe its disc and nothing more', () => {
    for (const r of [0.5, 6, 16.53, 40]) {
      expect(labelClearanceRadiusPx(r, false)).toBe(r);
    }
  });

  it('gives a dot the radius its gradient actually reaches', () => {
    // Jupiter's marker: the sprite is 2.6 drawn radii across, and the profile
    // paints 0.77 of that half-extent — which lands on the drawn radius.
    expect(labelClearanceRadiusPx(16.5277, true)).toBeCloseTo(16.5442, 4);
    expect(labelClearanceRadiusPx(16.5277, true))
      .toBeCloseTo(16.5277 * (DOT_EXTENT_MUL / 2) * DOT_PAINTED_FRACTION, 12);
    // One definition of each factor: no second literal anywhere.
    expect(DOT_EXTENT_MUL).toBe(2.6);
    expect(DOT_PAINTED_FRACTION).toBe(0.77);
  });

  it('agrees with the globe rule, because both looks paint the same limb', () => {
    for (const r of [0.5, 6, 16.53, 40]) {
      const dot = labelClearanceRadiusPx(r, true);
      const globe = labelClearanceRadiusPx(r, false);
      expect(dot).toBeGreaterThanOrEqual(globe);
      expect(dot / globe).toBeCloseTo(1, 2);
    }
  });

  it('answers zero for a body with no drawn radius', () => {
    expect(labelClearanceRadiusPx(0, true)).toBe(0);
    expect(labelClearanceRadiusPx(-3, true)).toBe(0);
    expect(labelClearanceRadiusPx(Number.NaN, false)).toBe(0);
  });

  it('crosses the flat label floor where the dot rule says it should', () => {
    // Composed with the label offset, the floor binds until the painted radius
    // plus its air overtakes it: 1.001r + 2 > 9 just under r = 7.
    const crossover = (LABEL_ANCHOR_OFFSET_PX - LABEL_CLEARANCE_PX) / DOT_PAINTED_EDGE_MUL;
    expect(crossover).toBeCloseTo(6.9930, 4);
    expect(mapLabelOffsetPx(labelClearanceRadiusPx(crossover - 0.01, true)))
      .toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(labelClearanceRadiusPx(crossover + 0.01, true)))
      .toBeGreaterThan(LABEL_ANCHOR_OFFSET_PX);
  });

  it('clears every planet\'s dot sprite, which the flat floor did not', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const marker = mapMarkerRadiusPx(planet.radiusAU, MAP_BODY_SIZE_DEFAULTS);
      const offset = mapLabelOffsetPx(labelClearanceRadiusPx(marker, true));
      expect(offset, planet.name).toBeGreaterThanOrEqual(marker * DOT_PAINTED_EDGE_MUL);
    }
  });
});

describe('the marker gradient profile', () => {
  it('is a monotone alpha ramp that reaches zero inside the quad', () => {
    expect(DOT_GRADIENT_STOPS[0]).toEqual({ at: 0, alpha: 1 });
    let prevAt = -1;
    let prevAlpha = Infinity;
    for (const stop of DOT_GRADIENT_STOPS) {
      expect(stop.at).toBeGreaterThan(prevAt);
      expect(stop.at).toBeLessThanOrEqual(1);
      expect(stop.alpha).toBeLessThanOrEqual(prevAlpha);
      prevAt = stop.at;
      prevAlpha = stop.alpha;
    }
    expect(DOT_GRADIENT_STOPS[DOT_GRADIENT_STOPS.length - 1].alpha).toBe(0);
    expect(DOT_PAINTED_FRACTION).toBeLessThan(1);
  });

  it('paints exactly to the drawn radius, so the two looks share one limb', () => {
    // The whole point of the extent and the profile being tuned together: a
    // marker's gradient dies where the globe it stands in for would end.
    expect(DOT_PAINTED_EDGE_MUL).toBeCloseTo(1, 2);
  });

  it('carries the same ink as the profile it replaced, so nothing resized', () => {
    // The mark's readable size is its alpha-weighted equivalent disc — the
    // radius a solid dot of the same total coverage would have. The rim retune
    // spent the old profile's ink differently (coverage instead of skirt); it
    // did not add or remove any, which is what let the size policy and the
    // label clearance keep their calibration. The profile that was replaced is
    // quoted here because it is the thing being held to.
    const LEGACY: readonly DotGradientStop[] = [
      { at: 0, alpha: 1 },
      { at: 0.55, alpha: 0.85 },
      { at: 0.7, alpha: 0.18 },
      { at: 1, alpha: 0 },
    ];
    const ink = (stops: readonly DotGradientStop[]): number => {
      // ∫ alpha(t) 2t dt over the quad's half-extent, sampled finely — the
      // equivalent-disc radius is its square root.
      let area = 0;
      const dt = 1e-4;
      for (let t = dt / 2; t < 1; t += dt) {
        let alpha = 0;
        for (let i = 1; i < stops.length; i++) {
          const a = stops[i - 1];
          const b = stops[i];
          if (t >= a.at && t <= b.at) {
            alpha = a.alpha + ((t - a.at) / (b.at - a.at)) * (b.alpha - a.alpha);
            break;
          }
        }
        area += alpha * 2 * t * dt;
      }
      return Math.sqrt(area);
    };
    const before = ink(LEGACY);
    const after = ink(DOT_GRADIENT_STOPS);
    expect(before).toBeCloseTo(0.6399, 3);
    expect(Math.abs(after - before) / before).toBeLessThan(0.03);
  });

  it('samples as the gradient the stops describe, zero past the painted edge', () => {
    // The sampler is what the marker texture is authored from, pixel by pixel;
    // it must reproduce what a canvas radial gradient would have painted from
    // the same stops — exact at every stop, linear between them, and nothing
    // outside the profile.
    for (const stop of DOT_GRADIENT_STOPS) {
      expect(dotGradientAlpha(stop.at)).toBeCloseTo(stop.alpha, 10);
    }
    for (let i = 1; i < DOT_GRADIENT_STOPS.length; i++) {
      const a = DOT_GRADIENT_STOPS[i - 1];
      const b = DOT_GRADIENT_STOPS[i];
      const mid = (a.at + b.at) / 2;
      expect(dotGradientAlpha(mid)).toBeCloseTo((a.alpha + b.alpha) / 2, 10);
    }
    expect(dotGradientAlpha(DOT_PAINTED_FRACTION)).toBe(0);
    expect(dotGradientAlpha(0.9)).toBe(0);
    expect(dotGradientAlpha(2)).toBe(0);
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const alpha = dotGradientAlpha(t);
      expect(alpha).toBeLessThanOrEqual(prev + 1e-12);
      prev = alpha;
    }
  });
});
