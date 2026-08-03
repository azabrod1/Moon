import { describe, it, expect } from 'vitest';
import {
  labelClearanceRadiusPx,
  mapMoonMarkerRadiusAU,
  mapMoonRadiusAU,
  mapBodyRadiusAU,
  mapBodyRadiusPx,
  mapMarkerRadiusPx,
  DOT_EXTENT_MUL,
  MAP_BODY_SIZE_DEFAULTS,
  type MapBodySizeParams,
} from './mapBodySize';
import { mapLabelOffsetPx, LABEL_ANCHOR_OFFSET_PX, LABEL_CLEARANCE_PX } from './mapLabels';
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
    // marker; Ganymede is drawn against it, so its marker is a fraction of that
    // — already past the crossover where the flat label floor stops clearing
    // anything. Every figure here is computed from the modules' own constants:
    // a transcribed decimal would drift the moment a knob moved.
    const jupiter = PLANETARIUM_BODIES.find((p) => p.name === 'Jupiter')!;
    const parentPx = mapMarkerRadiusPx(jupiter.radiusAU);
    expect(parentPx).toBeCloseTo(16.5277, 3);
    // The marker function is linear in the parent's drawn size, so feeding it px
    // answers in px.
    const drawnPx = mapMoonMarkerRadiusAU(GANYMEDE, parentPx);
    expect(drawnPx).toBeCloseTo(parentPx * 0.34, 12);
    expect(drawnPx).toBeCloseTo(5.6194, 3);

    const clearance = labelClearanceRadiusPx(drawnPx, true);
    expect(clearance).toBeCloseTo((drawnPx * DOT_EXTENT_MUL) / 2, 12);
    expect(clearance).toBeCloseTo(7.3052, 3);
    // Composed: the offset the chart actually draws the name at, clear of the
    // sprite rather than inside it, and past the flat floor by construction.
    expect(mapLabelOffsetPx(clearance)).toBeCloseTo(clearance + LABEL_CLEARANCE_PX, 12);
    expect(mapLabelOffsetPx(clearance)).toBeCloseTo(9.3052, 3);
    expect(mapLabelOffsetPx(clearance)).toBeGreaterThan(LABEL_ANCHOR_OFFSET_PX);
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

  it('gives a dot the half-extent its sprite actually paints', () => {
    // Jupiter's marker: the sprite is 2.6 drawn radii across, so it reaches
    // 1.3 of them from the centre — the figure the old disc rule ignored.
    expect(labelClearanceRadiusPx(16.5277, true)).toBeCloseTo(21.4860, 4);
    expect(labelClearanceRadiusPx(16.5277, true))
      .toBeCloseTo((16.5277 * DOT_EXTENT_MUL) / 2, 12);
    // One definition of the factor: no second literal anywhere.
    expect(DOT_EXTENT_MUL).toBe(2.6);
  });

  it('is the larger of the two whenever a body draws at all', () => {
    for (const r of [0.5, 6, 16.53, 40]) {
      expect(labelClearanceRadiusPx(r, true)).toBeGreaterThan(labelClearanceRadiusPx(r, false));
    }
  });

  it('answers zero for a body with no drawn radius', () => {
    expect(labelClearanceRadiusPx(0, true)).toBe(0);
    expect(labelClearanceRadiusPx(-3, true)).toBe(0);
    expect(labelClearanceRadiusPx(Number.NaN, false)).toBe(0);
  });

  it('crosses the flat label floor where the dot rule says it should', () => {
    // Composed with the label offset, the floor binds until the painted skirt
    // plus its air overtakes it: 1.3r + 2 > 9 at r > 5.3846.
    const crossover = (LABEL_ANCHOR_OFFSET_PX - LABEL_CLEARANCE_PX) / (DOT_EXTENT_MUL / 2);
    expect(crossover).toBeCloseTo(5.3846, 4);
    expect(mapLabelOffsetPx(labelClearanceRadiusPx(crossover - 0.01, true)))
      .toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(labelClearanceRadiusPx(crossover + 0.01, true)))
      .toBeGreaterThan(LABEL_ANCHOR_OFFSET_PX);
    // A globe of the same size is still on the floor — the two rules part here.
    expect(mapLabelOffsetPx(labelClearanceRadiusPx(crossover + 0.01, false)))
      .toBe(LABEL_ANCHOR_OFFSET_PX);
  });

  it('clears every planet\'s dot sprite, which the disc rule did not', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const marker = mapMarkerRadiusPx(planet.radiusAU, MAP_BODY_SIZE_DEFAULTS);
      const offset = mapLabelOffsetPx(labelClearanceRadiusPx(marker, true));
      expect(offset, planet.name).toBeGreaterThanOrEqual(marker * (DOT_EXTENT_MUL / 2));
      // What the disc rule gave a body whose skirt outgrew the flat floor: a
      // name inside its own sprite. Jupiter and Saturn are the two.
      if (marker * (DOT_EXTENT_MUL / 2) > LABEL_ANCHOR_OFFSET_PX) {
        expect(mapLabelOffsetPx(marker), planet.name)
          .toBeLessThan(marker * (DOT_EXTENT_MUL / 2));
      }
    }
  });
});
