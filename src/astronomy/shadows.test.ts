/**
 * Shadow-engine goldens.
 *
 * Catalog sources (greatest-eclipse instants quoted in TD; UTC = TD − ΔT,
 * ΔT ≈ 69 s in 2025–2028 — immaterial against the ±20 min tolerances):
 * - Lunar: EclipseWise (Espenak), https://www.eclipsewise.com/lunar/LEdecade/LEdecade2021.html
 * - Solar: EclipseWise (Espenak), https://www.eclipsewise.com/solar/SEdecade/SEdecade2021.html
 *
 * Satellite events are pinned against JPL Horizons heliocentric vectors
 * (shadows.goldens.json — provenance in the file): the test re-derives the
 * cone geometry from JPL's positions at the engine-predicted instants, so the
 * classifications and timing are checked against JPL, not our own ephemeris.
 * To regenerate after a deliberate astronomy change: re-run the engine for
 * each event in the goldens' `events` list, refetch Horizons vectors at the
 * new instants (fetch recipe in the goldens provenance), and update both the
 * sample vectors and instants — never hand-edit the engine's outputs in.
 *
 * Timing tolerances follow the measured-tolerance discipline: M3's per-moon
 * residuals (satelliteElements.ts header) convert via each moon's mean motion
 * — Io 1.06° ≈ 7 min, Titan 5.5° ≈ 4 h — and the fixture asserts are sized
 * above the measured drift with margin.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeShadowGeometry,
  computeShadowConeProfileKm,
  computeConeSilhouette,
  classifyEclipse,
  classifyShadowTransit,
  computeMoonShading,
  findShadowEvent,
  searchShadowEvent,
  listShadowEventSpecs,
  upcomingSystemEvents,
  type EclipseCircumstance,
  type ShadowConeProfile,
  type ShadowEventSpec,
  type ShadowGeometry,
  type MoonShadingState,
} from './shadows';
import { findEvent } from './ephemeris';
import { getMoonsByPlanet } from '../planetarium/planets/moonData';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';
import { getSatelliteOrbitMeta } from './satellites';
import { KM_PER_AU } from './constants';
import goldens from './shadows.goldens.json';

const MIN = 60_000;
const HOUR = 3_600_000;

function geometryScratch(): ShadowGeometry {
  return { axialKm: 0, missKm: 0, penumbraRadiusKm: 0, umbraRadiusKm: 0, umbraLengthKm: 0 };
}
function circumstanceScratch(): EclipseCircumstance {
  return { classification: 'none', penumbralMagnitude: 0, umbralMagnitude: 0, antumbralMagnitude: 0 };
}

describe('cone geometry (synthetic, hand-derived values)', () => {
  // Earth-sized occluder at exactly 1 AU, Moon-distance target on the axis.
  // rp = 6371 + 384400·(696340+6371)/149597870.7 = 8176.7 km
  // ru = 6371 − 384400·(696340−6371)/149597870.7 = 4598.1 km
  // umbra length = 6371·149597870.7/(696340−6371) = 1,381,349 km
  const earthPos = new THREE.Vector3(1, 0, 0);
  const onAxis = (dKm: number, rhoKm = 0) =>
    new THREE.Vector3(1 + dKm / KM_PER_AU, rhoKm / KM_PER_AU, 0);

  it('umbra/penumbra radii and umbra length match the closed form', () => {
    const g = computeShadowGeometry(earthPos, 6371, onAxis(384_400), geometryScratch());
    expect(g.axialKm).toBeCloseTo(384_400, 0);
    expect(g.missKm).toBeLessThan(0.001);
    expect(g.penumbraRadiusKm).toBeCloseTo(8176.7, 0);
    expect(g.umbraRadiusKm).toBeCloseTo(4598.1, 0);
    expect(g.umbraLengthKm).toBeCloseTo(1_381_349, -2);
  });

  it('classifies immersion: total / partial / penumbral / none by miss distance', () => {
    const rt = 1737.4;
    const cases: Array<[number, string]> = [
      [0, 'total'], // umag (4598.1+1737.4)/3474.8 = 1.823
      [5500, 'partial'], // umag 0.240
      [9000, 'penumbral'], // penMag 0.263, umag < 0
      [12_000, 'none'], // outside penumbra + disc
    ];
    for (const [rho, expected] of cases) {
      const g = computeShadowGeometry(earthPos, 6371, onAxis(384_400, rho), geometryScratch());
      expect(classifyEclipse(g, rt, circumstanceScratch()).classification, `ρ=${rho}`).toBe(expected);
    }
  });

  it('sunward targets are never eclipsed', () => {
    const g = computeShadowGeometry(earthPos, 6371, onAxis(-384_400), geometryScratch());
    expect(classifyEclipse(g, 1737.4, circumstanceScratch()).classification).toBe('none');
  });

  it('flips to annular past the umbra apex (immersion kind)', () => {
    // Moon-sized occluder: umbra length 1737.4·149597870.7/694602.6 = 374,180 km.
    const moonPos = new THREE.Vector3(1, 0, 0);
    const inside = computeShadowGeometry(moonPos, 1737.4, onAxis(370_000, 0), geometryScratch());
    expect(inside.umbraRadiusKm).toBeGreaterThan(0);
    const past = computeShadowGeometry(moonPos, 1737.4, onAxis(380_000, 0), geometryScratch());
    expect(past.umbraRadiusKm).toBeLessThan(0);
    // A small body fully inside the antumbra is annular-eclipsed.
    const c = classifyEclipse(past, 10, circumstanceScratch());
    expect(c.classification).toBe('annular');
    expect(c.antumbralMagnitude).toBeGreaterThan(1);
    expect(c.umbralMagnitude).toBe(0);
  });

  it('shadow-transit evaluates the cone at the near surface, not the center plane', () => {
    // Moon-sized occluder, Earth-sized target centered 3,000 km PAST the umbra
    // apex: at the center plane the umbra is gone (annular by that account),
    // but the sphere's near surface sits 6,371 km closer, where the umbra is
    // still ~16 km wide → a total eclipse exists somewhere on the body.
    const moonPos = new THREE.Vector3(1, 0, 0);
    const apexKm = 374_180;
    const g = computeShadowGeometry(moonPos, 1737.4, onAxis(apexKm + 3000, 0), geometryScratch());
    expect(g.umbraRadiusKm).toBeLessThan(0); // center plane: past the apex
    expect(classifyShadowTransit(g, 1737.4, 6371, KM_PER_AU)).toBe('total');

    // Push the whole sphere past the apex → annular.
    const g2 = computeShadowGeometry(moonPos, 1737.4, onAxis(apexKm + 20_000, 0), geometryScratch());
    expect(classifyShadowTransit(g2, 1737.4, 6371, KM_PER_AU)).toBe('annular');

    // Far off-axis: only the penumbra touches → partial; beyond it → none.
    const gPartial = computeShadowGeometry(moonPos, 1737.4, onAxis(370_000, 9000), geometryScratch());
    expect(classifyShadowTransit(gPartial, 1737.4, 6371, KM_PER_AU)).toBe('partial');
    const gNone = computeShadowGeometry(moonPos, 1737.4, onAxis(370_000, 25_000), geometryScratch());
    expect(classifyShadowTransit(gNone, 1737.4, 6371, KM_PER_AU)).toBe('none');
  });
});

describe('cone profile + silhouette (the promoted ShadowVisuals seams)', () => {
  it('cone radii at the Moon match independent hand values; the engine routes through the helper', () => {
    // Hand-computed closed forms (independent of the implementation), Earth
    // R = 6371 km at Ds = 1 AU, axial d = 384,400 km, Rs = 696,340 km:
    //   umbra length   R·Ds/(Rs−R)     = 1,381,349 km
    //   umbra radius   R − d·(Rs−R)/Ds = 4,598.1 km (the classic ~4,600 km
    //                                    lunar-eclipse umbra)
    //   penumbra       R + d·(Rs+R)/Ds = 8,176.7 km
    const profile: ShadowConeProfile = { umbraLengthKm: 0, pinchKm: 0, umbraRadiusKm: 0, penumbraRadiusKm: 0 };
    computeShadowConeProfileKm(6371, KM_PER_AU, 384_400, profile);
    expect(profile.umbraLengthKm).toBeCloseTo(1_381_349, -1);
    expect(profile.umbraRadiusKm).toBeCloseTo(4_598.1, 0);
    expect(profile.penumbraRadiusKm).toBeCloseTo(8_176.7, 0);

    // Routing, not algebra (the engine calls this same helper): geometry's
    // radii at its measured axial distance are the profile's radii.
    const occluder = new THREE.Vector3(1, 0, 0);
    const target = new THREE.Vector3(1 + 384_400 / KM_PER_AU, 5_000 / KM_PER_AU, 0);
    const g = computeShadowGeometry(occluder, 6371, target, geometryScratch());
    computeShadowConeProfileKm(6371, KM_PER_AU, g.axialKm, profile);
    expect(profile.penumbraRadiusKm).toBeCloseTo(g.penumbraRadiusKm, 6);
    expect(profile.umbraRadiusKm).toBeCloseTo(g.umbraRadiusKm, 6);
  });

  it('penumbra pinch matches the closed form (hand value)', () => {
    // pinch = R·Ds/(Rs+R) = 6371·149597870.7/(696340+6371) = 1,356,302 km
    const profile: ShadowConeProfile = { umbraLengthKm: 0, pinchKm: 0, umbraRadiusKm: 0, penumbraRadiusKm: 0 };
    computeShadowConeProfileKm(6371, KM_PER_AU, 0, profile);
    expect(profile.pinchKm).toBeCloseTo(1_356_302, -1);
    // At the occluder plane both cones measure the occluder itself.
    expect(profile.penumbraRadiusKm).toBeCloseTo(6371, 9);
    expect(profile.umbraRadiusKm).toBeCloseTo(6371, 9);
  });

  describe('computeConeSilhouette', () => {
    const apex = new THREE.Vector3(2, 1, -3);
    const axis = new THREE.Vector3(0.5, -1, 0.25).normalize();
    const half = 0.18; // rad
    const perp = new THREE.Vector3(1, 0, 0).cross(axis).normalize();
    const outA = new THREE.Vector3();
    const outB = new THREE.Vector3();

    it('returns two distinct unit generatrices, tangent to the view point', () => {
      const camera = apex.clone().addScaledVector(axis, 4).addScaledVector(perp, 7);
      expect(computeConeSilhouette(apex, axis, half, camera, outA, outB)).toBe('edges');
      expect(outA.distanceTo(outB)).toBeGreaterThan(1e-3);
      for (const g of [outA, outB]) {
        expect(g.length()).toBeCloseTo(1, 12);
        // A generatrix lies on the cone: angle to the axis = half-angle.
        expect(g.dot(axis)).toBeCloseTo(Math.cos(half), 12);
        // Tangency: the outward normal along this generatrix
        // (cos α·r̂ − sin α·â) is ⊥ the apex→camera vector.
        const radial = g
          .clone()
          .addScaledVector(axis, -Math.cos(half))
          .divideScalar(Math.sin(half));
        const normal = radial.multiplyScalar(Math.cos(half)).addScaledVector(axis, -Math.sin(half));
        expect(Math.abs(normal.dot(camera.clone().sub(apex)))).toBeLessThan(1e-9);
      }
    });

    it('reports inside from within the cone, hidden from the mirror cone', () => {
      const onAxisInside = apex.clone().addScaledVector(axis, 5);
      expect(computeConeSilhouette(apex, axis, half, onAxisInside, outA, outB)).toBe('inside');
      const offAxisInside = apex
        .clone()
        .addScaledVector(axis, 5)
        .addScaledVector(perp, Math.tan(half) * 5 * 0.5); // half-way to the wall
      expect(computeConeSilhouette(apex, axis, half, offAxisInside, outA, outB)).toBe('inside');
      const mirror = apex.clone().addScaledVector(axis, -5);
      expect(computeConeSilhouette(apex, axis, half, mirror, outA, outB)).toBe('hidden');
      // Just OUTSIDE the wall: edges again.
      const grazing = apex
        .clone()
        .addScaledVector(axis, 5)
        .addScaledVector(perp, Math.tan(half) * 5 * 1.2);
      expect(computeConeSilhouette(apex, axis, half, grazing, outA, outB)).toBe('edges');
    });
  });
});

describe('Earth: lunar eclipses vs EclipseWise', () => {
  // EclipseWise greatest-eclipse TD → UTC (−69 s), umbral magnitudes verbatim.
  const CASES = [
    { from: '2025-02-01', peakUtc: '2025-03-14T06:58:47Z', cls: 'total', umag: 1.178 },
    { from: '2025-08-01', peakUtc: '2025-09-07T18:11:49Z', cls: 'total', umag: 1.362 },
    { from: '2026-02-01', peakUtc: '2026-03-03T11:33:43Z', cls: 'total', umag: 1.151 },
    { from: '2026-08-05', peakUtc: '2026-08-28T04:12:55Z', cls: 'partial', umag: 0.93 },
  ] as const;
  const spec: ShadowEventSpec = { kind: 'eclipse', parentPlanet: 'Earth', moonName: 'Moon' };

  it.each(CASES)('finds $peakUtc as $cls', ({ from, peakUtc, cls, umag }) => {
    const event = findShadowEvent(spec, Date.parse(from), 1);
    expect(event).not.toBeNull();
    expect(Math.abs(event!.peakUtcMs - Date.parse(peakUtc))).toBeLessThan(20 * MIN);
    expect(event!.classification).toBe(cls);
    // Truncated Meeus series + the Danjon 1/85 enlargement (EclipseWise uses
    // its own convention) land within a few hundredths of magnitude.
    expect(Math.abs(event!.umbralMagnitude! - umag)).toBeLessThan(0.1);
  });

  it('finds the 2027 penumbral-only eclipses (Feb 20, Aug 17)', () => {
    // KNOWN LIMITATION, accepted: the 2027-07-18 graze (penumbral mag ≈ 0.11)
    // dips below the contact threshold for less than one scan step and is
    // skipped. Penumbral eclipses are imperceptible below ~0.6 magnitude, so
    // the scanner is not slowed down fourfold to catch catalog-only events.
    const feb = findShadowEvent(spec, Date.parse('2027-02-01'), 1);
    expect(feb).not.toBeNull();
    expect(new Date(feb!.peakUtcMs).toISOString().slice(0, 10)).toBe('2027-02-20');
    expect(feb!.classification).toBe('penumbral');
    expect(feb!.umbralMagnitude).toBe(0);
    expect(feb!.penumbralMagnitude!).toBeGreaterThan(0.6);

    const aug = findShadowEvent(spec, Date.parse('2027-08-01'), 1);
    expect(aug).not.toBeNull();
    expect(new Date(aug!.peakUtcMs).toISOString().slice(0, 10)).toBe('2027-08-17');
    expect(aug!.classification).toBe('penumbral');
  });

  it('handles the barely-partial 2028-01-12 eclipse (catalog umag 0.066)', () => {
    // A genuine boundary case: our ±0.03 magnitude error can legitimately
    // flip partial ↔ penumbral, so only the magnitude is pinned tightly.
    const event = findShadowEvent(spec, Date.parse('2028-01-01'), 1);
    expect(event).not.toBeNull();
    expect(Math.abs(event!.peakUtcMs - Date.parse('2028-01-12T04:13:04Z'))).toBeLessThan(25 * MIN);
    expect(['partial', 'penumbral']).toContain(event!.classification);
    expect(Math.abs((event!.umbralMagnitude ?? 0) - 0.066)).toBeLessThan(0.12);
  });
});

describe('Earth: solar eclipses vs EclipseWise', () => {
  const CASES = [
    { from: '2026-01-15', peakUtc: '2026-02-17T12:11:57Z', cls: 'annular' },
    { from: '2026-07-01', peakUtc: '2026-08-12T17:45:57Z', cls: 'total' },
    { from: '2027-07-01', peakUtc: '2027-08-02T10:06:41Z', cls: 'total' },
    { from: '2028-01-01', peakUtc: '2028-01-26T15:07:50Z', cls: 'annular' },
  ] as const;
  const spec: ShadowEventSpec = { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' };

  it.each(CASES)('finds $peakUtc as $cls', ({ from, peakUtc, cls }) => {
    const event = findShadowEvent(spec, Date.parse(from), 1);
    expect(event).not.toBeNull();
    expect(Math.abs(event!.peakUtcMs - Date.parse(peakUtc))).toBeLessThan(20 * MIN);
    expect(event!.classification).toBe(cls);
  });

  it('agrees with the Meeus-elongation search within 1.5 h', () => {
    // Two models of the same sky: ephemeris.ts finds the syzygy instant, the
    // engine the minimum-separation peak.
    for (const [type, kind] of [
      ['lunar-eclipse', 'eclipse'],
      ['solar-eclipse', 'shadow-transit'],
    ] as const) {
      const from = new Date('2025-02-01');
      const elongation = findEvent(type, from, 1);
      const engine = findShadowEvent(
        { kind, parentPlanet: 'Earth', moonName: 'Moon' },
        from.getTime(),
        1,
      );
      expect(elongation).not.toBeNull();
      expect(engine).not.toBeNull();
      expect(Math.abs(engine!.peakUtcMs - elongation!.getTime())).toBeLessThan(1.5 * HOUR);
    }
  });
});

describe('satellite events vs JPL Horizons vectors', () => {
  const samples = goldens.samples as Record<
    string,
    { utc: string; jdTdb: number; vectors: Record<string, number[]> }
  >;

  function radiusKmOf(parentPlanet: string, name: string): number {
    if (name === parentPlanet) {
      const body = PLANETARIUM_BODIES.find((b) => b.name === name);
      expect(body, name).toBeDefined();
      return body!.radiusKm;
    }
    const moon = getMoonsByPlanet(parentPlanet).find((m) => m.name === name);
    expect(moon, name).toBeDefined();
    return moon!.radiusKm;
  }

  it.each(goldens.provenance.events)(
    '$spec.moonName $spec.kind: JPL geometry confirms $expectedClassification at the engine peak',
    ({ spec, expectedClassification, peakSample, afterSample }) => {
      const typedSpec = spec as ShadowEventSpec;
      const parentName = typedSpec.parentPlanet;
      const moonName = typedSpec.moonName;

      for (const [sampleName, expected] of [
        [peakSample, expectedClassification],
        [afterSample, 'none'],
      ] as const) {
        const sample = samples[sampleName];
        const parentVec = new THREE.Vector3(...(sample.vectors[parentName] as [number, number, number]));
        const moonVec = new THREE.Vector3(...(sample.vectors[moonName] as [number, number, number]));
        const occluder = typedSpec.kind === 'eclipse' ? parentVec : moonVec;
        const target = typedSpec.kind === 'eclipse' ? moonVec : parentVec;
        const occluderR = radiusKmOf(parentName, typedSpec.kind === 'eclipse' ? parentName : moonName);
        const targetR = radiusKmOf(parentName, typedSpec.kind === 'eclipse' ? moonName : parentName);

        const g = computeShadowGeometry(occluder, occluderR, target, geometryScratch());
        const classification =
          typedSpec.kind === 'eclipse'
            ? classifyEclipse(g, targetR, circumstanceScratch()).classification
            : classifyShadowTransit(g, occluderR, targetR, occluder.length() * KM_PER_AU);
        expect(classification, `${sampleName} (JPL vectors)`).toBe(expected);
      }
    },
  );

  it.each(goldens.provenance.events)(
    '$spec.moonName $spec.kind: engine still reproduces the fixture instant',
    ({ spec, searchFromUtc, expectedClassification, peakSample }) => {
      const event = findShadowEvent(spec as ShadowEventSpec, Date.parse(searchFromUtc), 1);
      expect(event).not.toBeNull();
      expect(event!.classification).toBe(expectedClassification);
      // The fixture instant IS a prior engine output verified against JPL —
      // this guards against silent drift; regenerate deliberately (header).
      expect(Math.abs(event!.peakUtcMs - Date.parse(samples[peakSample].utc))).toBeLessThan(10 * MIN);
    },
  );

  it("Titan: engine peak lands inside JPL's eclipse window (±8 h residual bound)", () => {
    // Titan's measured element residual (5.5° ≈ 6 h of orbit, see
    // satelliteElements.ts) exceeds the ~5 h eclipse duration, so unlike the
    // moons above its peak instant can't be pinned directly. Instead the
    // 2 h-grid Horizons scan in the goldens locates JPL's true eclipse window
    // and the engine peak must fall within 8 h (1.3× the residual drift).
    const saturnR = 60_268;
    const titanR = getMoonsByPlanet('Saturn').find((m) => m.name === 'Titan')!.radiusKm;
    const inEclipse: number[] = [];
    for (const row of goldens.titanEclipseScan) {
      const saturn = new THREE.Vector3(...(row.Saturn as [number, number, number]));
      const titan = new THREE.Vector3(...(row.Titan as [number, number, number]));
      const g = computeShadowGeometry(saturn, saturnR, titan, geometryScratch());
      const c = classifyEclipse(g, titanR, circumstanceScratch());
      if (c.classification !== 'none') inEclipse.push(Date.parse(row.utc));
    }
    expect(inEclipse.length).toBeGreaterThan(0); // JPL confirms an eclipse in the ±24 h window
    const jplWindowMid = (inEclipse[0] + inEclipse[inEclipse.length - 1]) / 2;

    const event = findShadowEvent(
      { kind: 'eclipse', parentPlanet: 'Saturn', moonName: 'Titan' },
      Date.parse('2025-01-14T00:00:00Z'),
      1,
    );
    expect(event).not.toBeNull();
    expect(event!.classification).toBe('total');
    expect(Math.abs(event!.peakUtcMs - jplWindowMid)).toBeLessThan(8 * HOUR);
  });
});

describe('physics pins', () => {
  it("the Moon's umbra length straddles the Earth–Moon distance range", () => {
    // Why totality and annularity both exist: umbra ≈ 374,000 km vs
    // Earth–Moon 356,500–406,700 km.
    const g = computeShadowGeometry(
      new THREE.Vector3(1, 0, 0),
      1737.4,
      new THREE.Vector3(1.001, 0, 0),
      geometryScratch(),
    );
    expect(g.umbraLengthKm).toBeGreaterThan(356_500);
    expect(g.umbraLengthKm).toBeLessThan(406_700);
  });

  it("Phobos's umbra physically cannot reach Mars — transits are never total", () => {
    const meta = getSatelliteOrbitMeta('Phobos');
    const phobosR = getMoonsByPlanet('Mars').find((m) => m.name === 'Phobos')!.radiusKm;
    const g = computeShadowGeometry(
      new THREE.Vector3(1.524, 0, 0), // Mars's semi-major axis
      phobosR,
      new THREE.Vector3(1.525, 0, 0),
      geometryScratch(),
    );
    expect(g.umbraLengthKm).toBeLessThan(meta.semiMajorAxisKm * (1 - meta.eccentricity));
  });

  it('Io is totally eclipsed every orbit', () => {
    const spec: ShadowEventSpec = { kind: 'eclipse', parentPlanet: 'Jupiter', moonName: 'Io' };
    const windowStart = Date.parse('2026-06-10T00:00:00Z');
    const events = [];
    let cursor = windowStart;
    while (cursor < windowStart + 10 * 24 * HOUR) {
      const event = findShadowEvent(spec, cursor, 1);
      if (!event || event.peakUtcMs > windowStart + 10 * 24 * HOUR) break;
      events.push(event);
      cursor = event.endUtcMs + MIN;
    }
    // 10 days / 1.77-day period → 5 or 6 eclipses, all total.
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.length).toBeLessThanOrEqual(6);
    for (const e of events) expect(e.classification).toBe('total');
  });

  it('Titan eclipses cluster in Saturn equinox seasons', () => {
    const spec: ShadowEventSpec = { kind: 'eclipse', parentPlanet: 'Saturn', moonName: 'Titan' };
    // In season around the 2025-05-06 equinox…
    const inSeason = findShadowEvent(spec, Date.parse('2025-01-01'), 1);
    expect(inSeason).not.toBeNull();
    expect(inSeason!.peakUtcMs).toBeLessThan(Date.parse('2026-12-31'));
    // …and from 2030 the season prefilter strides straight to the late-2030s
    // season (next equinox ≈ 2039) without a decade of fine-scanning.
    const stats = { evaluations: 0 };
    const offSeason = findShadowEvent(spec, Date.parse('2030-01-01'), 1, { statsOut: stats });
    expect(offSeason).not.toBeNull();
    const peakYear = new Date(offSeason!.peakUtcMs).getUTCFullYear();
    expect(peakYear).toBeGreaterThanOrEqual(2036);
    expect(peakYear).toBeLessThanOrEqual(2041);
    expect(stats.evaluations).toBeLessThan(20_000);
  });

  it('Uranus searches reach the ~2049 equinox season (parent-specific horizon)', () => {
    // From 2026 the next Uranian eclipse season is ~23 years out — a flat
    // 20-year horizon would misreport it as "no event". Element extrapolation
    // that far past the 1990–2040 calibration window is approximate by
    // design, so only the season's existence and rough location are pinned.
    const event = findShadowEvent(
      { kind: 'eclipse', parentPlanet: 'Uranus', moonName: 'Ariel' },
      Date.parse('2026-06-10'),
      1,
    );
    expect(event).not.toBeNull();
    const year = new Date(event!.peakUtcMs).getUTCFullYear();
    expect(year).toBeGreaterThanOrEqual(2040);
    expect(year).toBeLessThanOrEqual(2058);
  });
});

describe('search mechanics', () => {
  const ioSpec: ShadowEventSpec = { kind: 'eclipse', parentPlanet: 'Jupiter', moonName: 'Io' };

  it('a search started mid-event returns that event', () => {
    const event = findShadowEvent(ioSpec, Date.parse('2025-06-01T00:00:00Z'), 1)!;
    const midSearch = findShadowEvent(ioSpec, event.peakUtcMs, 1)!;
    expect(midSearch.startUtcMs).toBeLessThan(event.peakUtcMs);
    expect(midSearch.endUtcMs).toBeGreaterThan(event.peakUtcMs);
    expect(Math.abs(midSearch.peakUtcMs - event.peakUtcMs)).toBeLessThan(MIN);
  });

  it('previous-direction search finds the same event back', () => {
    const next = findShadowEvent(ioSpec, Date.parse('2025-06-01T00:00:00Z'), 1)!;
    const prev = findShadowEvent(ioSpec, next.endUtcMs + HOUR, -1)!;
    expect(Math.abs(prev.peakUtcMs - next.peakUtcMs)).toBeLessThan(MIN);
  });

  it('the evaluation cap is deterministic and respected', () => {
    // Off-season Titan search: the cap trips during the stride scan. (The cap
    // bounds the scan only — a search that starts mid-event, like Io on
    // 2026-06-10 00:00, completes its refinement regardless, by design.)
    const stats = { evaluations: 0 };
    const result = searchShadowEvent(
      { kind: 'eclipse', parentPlanet: 'Saturn', moonName: 'Titan' },
      Date.parse('2030-01-01'),
      1,
      { maxEvaluations: 50, statsOut: stats },
    );
    expect(result.status).toBe('none');
    expect(stats.evaluations).toBeLessThanOrEqual(55);
  });

  it('a time-budgeted search pauses and resumes to the same answer', () => {
    // Deep, unambiguous target (Io eclipses are total every orbit) — at a
    // season EDGE the resumed path's slightly different step phasing may
    // legitimately catch a different sub-step graze, so grazes are the wrong
    // fixture for pause/resume mechanics. searchOriginUtcMs carries the
    // original start so the horizon is anchored (resume contract).
    const from = Date.parse('2026-06-12T00:00:00Z');
    const reference = findShadowEvent(ioSpec, from, 1)!;

    let cursor = from;
    let found = null;
    for (let i = 0; i < 100_000 && !found; i++) {
      const result = searchShadowEvent(ioSpec, cursor, 1, {
        timeBudgetMs: 0.05,
        searchOriginUtcMs: from,
      });
      if (result.status === 'found') found = result.event;
      else if (result.status === 'paused') cursor = result.cursorUtcMs;
      else break;
    }
    expect(found).not.toBeNull();
    expect(Math.abs(found!.peakUtcMs - reference.peakUtcMs)).toBeLessThan(MIN);
  });

  it('a resumed search keeps the horizon anchored at the original origin', () => {
    // Regression (codex review): resuming with the pause cursor as fromUtcMs
    // used to rebuild the window from the cursor, sliding the horizon forward
    // with every slice — a no-event spec chunked by a UI time budget would
    // never terminate. With searchOriginUtcMs anchoring the window, a cursor
    // already beyond origin + horizon must return 'none' without scanning.
    // Ariel is quiet in 2072 (Uranus eclipse seasons ≈ 2049 and ≈ 2091), so
    // the lone mid-event probe at the cursor can't accidentally hit an event.
    const arielSpec = { kind: 'eclipse', parentPlanet: 'Uranus', moonName: 'Ariel' } as const;
    const origin = Date.parse('2026-01-01T00:00:00Z');
    const beyondHorizon = Date.parse('2080-01-01T00:00:00Z'); // 54 yr > max(25, 0.55·84) ≈ 46 yr
    const stats = { evaluations: 0 };
    const result = searchShadowEvent(arielSpec, beyondHorizon, 1, {
      searchOriginUtcMs: origin,
      statsOut: stats,
    });
    expect(result.status).toBe('none');
    expect(stats.evaluations).toBeLessThanOrEqual(2);
  });

  it('lists both kinds for every catalog moon', () => {
    expect(listShadowEventSpecs('Earth')).toHaveLength(2);
    expect(listShadowEventSpecs('Jupiter')).toHaveLength(2 * getMoonsByPlanet('Jupiter').length);
  });

  it('upcomingSystemEvents returns sorted, classified events within a sane eval budget', () => {
    const stats = { evaluations: 0 };
    const events = upcomingSystemEvents('Saturn', Date.parse('2026-06-10'), 6, { statsOut: stats });
    expect(events).toHaveLength(6);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].peakUtcMs).toBeGreaterThanOrEqual(events[i - 1].peakUtcMs);
    }
    for (const e of events) expect(e.classification).not.toBe('none');
    // Deterministic stand-in for a wall-clock budget (measured ~30k for the
    // full 36-pair Saturn burst).
    expect(stats.evaluations).toBeLessThan(150_000);
  });

  it('throws on unknown bodies', () => {
    expect(() =>
      findShadowEvent({ kind: 'eclipse', parentPlanet: 'Jupiter', moonName: 'Vulcan' }, 0, 1),
    ).toThrow(/No moon/);
    expect(() =>
      findShadowEvent({ kind: 'eclipse', parentPlanet: 'Krypton', moonName: 'Io' }, 0, 1),
    ).toThrow(/Unknown parent/);
  });
});

describe('computeMoonShading', () => {
  const out: MoonShadingState = { sunVisibleFraction: 1, inUmbra: false };
  const earthPos = new THREE.Vector3(1, 0, 0);

  it('darkens fully in the umbra, partially in the penumbra, not at all outside', () => {
    const deep = computeMoonShading(
      earthPos, 'Earth', 6371, new THREE.Vector3(384_400 / KM_PER_AU, 0, 0), 1737.4, out,
    );
    expect(deep.sunVisibleFraction).toBe(0);
    expect(deep.inUmbra).toBe(true);

    // ρ ≈ 6,400 km: between umbra (4,598) and penumbra (8,177) at Moon distance.
    const half = computeMoonShading(
      earthPos, 'Earth', 6371,
      new THREE.Vector3(384_400 / KM_PER_AU, 6400 / KM_PER_AU, 0), 1737.4, out,
    );
    expect(half.sunVisibleFraction).toBeGreaterThan(0.2);
    expect(half.sunVisibleFraction).toBeLessThan(0.8);

    const lit = computeMoonShading(
      earthPos, 'Earth', 6371,
      new THREE.Vector3(0, 384_400 / KM_PER_AU, 0), 1737.4, out,
    );
    expect(lit.sunVisibleFraction).toBe(1);
    expect(lit.inUmbra).toBe(false);

    const sunward = computeMoonShading(
      earthPos, 'Earth', 6371, new THREE.Vector3(-384_400 / KM_PER_AU, 0, 0), 1737.4, out,
    );
    expect(sunward.sunVisibleFraction).toBe(1);
  });
});
