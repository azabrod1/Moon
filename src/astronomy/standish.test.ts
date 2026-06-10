/**
 * JPL Horizons golden fixtures + Standish element-model tests (Milestone 2).
 *
 * Fixture provenance — JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api):
 *   EPHEM_TYPE='VECTORS', CENTER='500@10' (Sun body center → heliocentric),
 *   REF_PLANE='ECLIPTIC', REF_SYSTEM='J2000' (response header: "Ecliptic of
 *   J2000.0"), VEC_TABLE='1', OUT_UNITS='AU-D', TLIST in JD TDB; source DE441.
 *   Moon rows: COMMAND='301', CENTER='500@399' (geocentric Moon).
 * Bodies are body centers except the noted barycenters (Pluto@1750 and all
 * 2500 rows — Horizons body-center ephemerides don't span those epochs;
 * barycenter offsets are ≤ 1.4e-5 AU, far below every tolerance here).
 * Values are byte-verbatim from the responses — never re-round them.
 * CENTER matters: the Horizons default is the solar-system barycenter, whose
 * Sun offset (~0.01 AU) would pass the loose self-checks yet fail every
 * tight golden — re-fetch with CENTER='500@10' if a fixture is ever redone.
 *
 * Epochs are TDB; |TDB − TT| < 2 ms, so fixtures feed the TT-expecting math
 * directly (no ttJDFromUtcMs here).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeBodyState,
  computeEarthPositionEquatorial,
  computeMoonGeocentricEquatorialAU,
  computeKeplerPositionEquatorial,
  eclipticToEquatorial,
  sampleOrbitLinePoints,
} from './planetary';
import { getElementsFromTable, getStandishElements } from './standish';
import { J2000, KM_PER_AU, RAD } from './constants';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';

interface HorizonsFixture {
  body: string;
  jdTdb: number;
  x: number;
  y: number;
  z: number;
}

const HELIO_FIXTURES: HorizonsFixture[] = [
  // JD TDB 2360234.5 = ~1750 (Table-2 era)
  { body: 'Mercury', jdTdb: 2360234.5, x: -9.674271058679408e-2, y: -4.556454574606086e-1, z: -2.813040520458664e-2 },
  { body: 'Venus', jdTdb: 2360234.5, x: 4.651711003554517e-1, y: 5.525922551112626e-1, z: -1.977147759842671e-2 },
  { body: 'EMB', jdTdb: 2360234.5, x: -2.389424354275967e-1, y: 9.537177730565235e-1, z: 5.325118767132519e-4 },
  { body: 'Earth', jdTdb: 2360234.5, x: -2.389110581815954e-1, y: 9.537265796265194e-1, z: 5.355331376024476e-4 },
  { body: 'Mars', jdTdb: 2360234.5, x: 1.186793057278302, y: 8.200144844104185e-1, z: -1.270389944434983e-2 },
  { body: 'Jupiter', jdTdb: 2360234.5, x: 4.914935222137316, y: 5.861625935810386e-1, z: -1.128931871168415e-1 },
  { body: 'Saturn', jdTdb: 2360234.5, x: -5.270840661660373, y: -8.445827940660839, z: 3.592426674046333e-1 },
  { body: 'Uranus', jdTdb: 2360234.5, x: 1.627265895707184e1, y: -1.162243006562434e1, z: -2.563170605786355e-1 },
  { body: 'Neptune', jdTdb: 2360234.5, x: -1.483669948034301e1, y: 2.606320001643612e1, z: -1.949429482848854e-1 },
  { body: 'Pluto', jdTdb: 2360234.5, x: -1.21775487720924e1, y: -2.667868487618559e1, z: 6.380715386764858 }, // Pluto Barycenter
  // JD TDB 2447892.5 = 1990-01-01
  { body: 'Mercury', jdTdb: 2447892.5, x: 1.637134451837396e-1, y: 2.636856341645413e-1, z: 6.505844184760012e-3 },
  { body: 'Venus', jdTdb: 2447892.5, x: 4.258396960427055e-3, y: 7.196022067328847e-1, z: 9.566609331020734e-3 },
  { body: 'EMB', jdTdb: 2447892.5, x: -1.782620844353372e-1, y: 9.670214121725226e-1, z: 2.198836730510611e-5 },
  { body: 'Earth', jdTdb: 2447892.5, x: -1.782879227044152e-1, y: 9.670383943576336e-1, z: 2.151582397591303e-5 },
  { body: 'Mars', jdTdb: 2447892.5, x: -9.763410893697964e-1, y: -1.201258552319641, z: -1.141650860407537e-3 },
  { body: 'Jupiter', jdTdb: 2447892.5, x: -5.671020722326922e-1, y: 5.119448870323565, z: -8.485646595833443e-3 },
  { body: 'Saturn', jdTdb: 2447892.5, x: 2.807663768202421, y: -9.625880689703493, z: 5.623321475324807e-2 },
  { body: 'Uranus', jdTdb: 2447892.5, x: 1.914154719859185, y: -1.928503986577344e1, z: -9.638937919579985e-2 },
  { body: 'Neptune', jdTdb: 2447892.5, x: 6.392820142610288, y: -2.952272241673688e1, z: 4.606478734130216e-1 },
  { body: 'Pluto', jdTdb: 2447892.5, x: -1.997280472068576e1, y: -2.042465416122678e1, z: 7.96300227790505 },
  // JD TDB 2461200.5 = 2026-06-09
  { body: 'Mercury', jdTdb: 2461200.5, x: -3.945681062368527e-1, y: -6.341191208907743e-2, z: 3.100644950348246e-2 },
  { body: 'Venus', jdTdb: 2461200.5, x: -7.110891632405935e-1, y: 1.01690906715175e-1, z: 4.242640611321934e-2 },
  { body: 'EMB', jdTdb: 2461200.5, x: -2.139334904418292e-1, y: -9.922247183777652e-1, z: 6.074733809947022e-5 },
  { body: 'Earth', jdTdb: 2461200.5, x: -2.139643995461386e-1, y: -9.922219510667664e-1, z: 5.970473694422436e-5 },
  { body: 'Mars', jdTdb: 2461200.5, x: 1.309345067067104, y: 5.4696489059683e-1, z: -2.064355527054158e-2 },
  { body: 'Jupiter', jdTdb: 2461200.5, x: -2.789614808707851, y: 4.469251058607579, z: 4.384845796838015e-2 },
  { body: 'Saturn', jdTdb: 2461200.5, x: 9.392414247114571, y: 1.139996228128095, z: -3.937278675270524e-1 },
  { body: 'Uranus', jdTdb: 2461200.5, x: 9.330634839861835, y: 1.707917748103635e1, z: -5.755367484034939e-2 },
  { body: 'Neptune', jdTdb: 2461200.5, x: 2.985495899924951e1, y: 1.02070044733424, z: -7.090114245602073e-1 },
  { body: 'Pluto', jdTdb: 2461200.5, x: 1.965787875002615e1, y: -2.948960708180797e1, z: -2.529623463841208 },
  // JD TDB 2467900.5 = ~2044
  { body: 'Mercury', jdTdb: 2467900.5, x: -2.628120121685791e-1, y: -3.746195062848342e-1, z: -6.5320548904731e-3 },
  { body: 'Venus', jdTdb: 2467900.5, x: -1.8889009557262e-1, y: 6.933661511629219e-1, z: 2.045765206499476e-2 },
  { body: 'EMB', jdTdb: 2467900.5, x: 9.454444403126059e-1, y: 3.198636649701951e-1, z: -4.029933567370114e-5 },
  { body: 'Earth', jdTdb: 2467900.5, x: 9.454410006838856e-1, y: 3.198339400637539e-1, z: -4.2927323453439e-5 },
  { body: 'Mars', jdTdb: 2467900.5, x: 1.861018325632954e-1, y: -1.428162813933567, z: -3.449412389992634e-2 },
  { body: 'Jupiter', jdTdb: 2467900.5, x: 3.156440557068324, y: -4.001273085878233, z: -5.385862788418869e-2 },
  { body: 'Saturn', jdTdb: 2467900.5, x: -4.853290279904497, y: -8.701769714629165, z: 3.440909631687731e-1 },
  { body: 'Uranus', jdTdb: 2467900.5, x: -1.460164363305208e1, y: 1.11537982638963e1, z: 2.305159335942818e-1 },
  { body: 'Neptune', jdTdb: 2467900.5, x: 2.191093076077702e1, y: 2.019033627297035e1, z: -9.207913571638886e-1 },
  { body: 'Pluto', jdTdb: 2467900.5, x: 3.45010510890675e1, y: -1.902964155016812e1, z: -7.943315746596834 },
  // JD TDB 2634166.5 = 2500-01-01 (Table-2 era; the b/c/s/f extras are large here)
  { body: 'Jupiter', jdTdb: 2634166.5, x: -3.759012798981326e-1, y: 5.127914869658286, z: -1.447155847564865e-2 }, // Jupiter Barycenter
  { body: 'Saturn', jdTdb: 2634166.5, x: 7.599650565811811, y: 5.319788543729173, z: -3.954720580078297e-1 }, // Saturn Barycenter
  { body: 'Pluto', jdTdb: 2634166.5, x: -5.472404769220456, y: -2.985453276971838e1, z: 4.772149717521394 }, // Pluto Barycenter
];

// Geocentric Moon (COMMAND='301', CENTER='500@399') — absolute pin for the Moon seam.
const MOON_FIXTURES: HorizonsFixture[] = [
  { body: 'Moon', jdTdb: 2447892.5, x: 2.126504226975829e-3, y: -1.397643484282501e-3, z: 3.889058450195262e-5 },
  { body: 'Moon', jdTdb: 2461200.5, x: 2.543836847885256e-3, y: -2.277512676401544e-4, z: 8.580666750393029e-5 },
];

const FIXTURE_EPOCHS = [2360234.5, 2447892.5, 2461200.5, 2467900.5];

/**
 * Horizons ecliptic-J2000 (x, y, z) → the scene's world (equatorial) frame.
 * Horizons: +x at the equinox, +z ecliptic north, +y at longitude 90°.
 * Scene intermediate ecliptic vector: +X equinox, +Y north, +Z longitude 90°
 * (the convention pinned by planetary.test.ts) — i.e. (x, z, y) — then the
 * production obliquity rotation.
 */
function horizonsToScene(f: HorizonsFixture): THREE.Vector3 {
  return eclipticToEquatorial(new THREE.Vector3(f.x, f.z, f.y));
}

function separationDeg(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.angleTo(b) * RAD;
}

function norm180(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function fixture(body: string, jdTdb: number): HorizonsFixture {
  const found = HELIO_FIXTURES.find((f) => f.body === body && f.jdTdb === jdTdb);
  if (!found) throw new Error(`no fixture for ${body} @ ${jdTdb}`);
  return found;
}

describe('Horizons fixture self-checks', () => {
  it('keeps every fixture near the ecliptic (axis-order tripwire)', () => {
    // An (x, y, z) → (x, z, y) mapping mistake moves heliocentric *longitude*
    // into the scene's north component and blows this up for almost every row;
    // unlike a longitude comparison it cannot be fooled by along-track element
    // error. Max real value: Pluto at 15.6°.
    for (const f of [...HELIO_FIXTURES, ...MOON_FIXTURES]) {
      const scene = new THREE.Vector3(f.x, f.z, f.y); // intermediate ecliptic frame
      const latDeg = Math.asin(scene.y / scene.length()) * RAD;
      expect(Math.abs(latDeg), `${f.body} @ ${f.jdTdb}`).toBeLessThan(18);
    }
  });

  it('keeps EMB at heliocentric distance ~1 AU (center-body tripwire)', () => {
    // A solar-system-barycenter-centered fixture (the Horizons default) is the
    // mistake that would pass the loose self-checks and fail the tight goldens.
    for (const jd of FIXTURE_EPOCHS) {
      const f = fixture('EMB', jd);
      const r = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z);
      expect(r).toBeGreaterThan(0.981);
      expect(r).toBeLessThan(1.019);
    }
  });
});

// Angular tolerances: 2× the paper's quoted per-planet accuracy with a 0.01°
// floor (absorbs DE441-fixture vs fit-era drift and TDB/TT noise). Radial
// tolerances: 2× the quoted distance column, which is in units of 1000 km
// (e.g. Saturn Table-1: 1500 → 3.0e6 km ≈ 0.0201 AU). The historical
// pre-Standish baselines this replaced measured: Mercury 4.4°→9.0° across
// 1990→2044 (rounded-period drift), Venus 1.9°→8.5°, every other body ≤1.7°.
const radialToleranceAU = (thousandKm: number) => (thousandKm * 1000 * 2) / KM_PER_AU;

const TABLE1_TOL: Record<string, { angDeg: number; radAU: number }> = {
  Mercury: { angDeg: 0.01, radAU: radialToleranceAU(1) },
  Venus: { angDeg: 0.011, radAU: radialToleranceAU(4) },
  Earth: { angDeg: 0.011, radAU: radialToleranceAU(6) }, // EMB row vs EMB fixture
  Mars: { angDeg: 0.022, radAU: radialToleranceAU(25) },
  Jupiter: { angDeg: 0.222, radAU: radialToleranceAU(600) },
  Saturn: { angDeg: 0.333, radAU: radialToleranceAU(1500) },
  Uranus: { angDeg: 0.028, radAU: radialToleranceAU(1000) },
  Neptune: { angDeg: 0.01, radAU: radialToleranceAU(200) },
  // Pluto's quoted 300-thousand-km distance accuracy predates DE441; measured
  // |Δr| against the DE441 fixtures: 0.0022 (1990) → 0.0039 (2026) → 0.0057 AU
  // (2044). Angular accuracy holds at the 0.01° floor — bound radius honestly.
  Pluto: { angDeg: 0.01, radAU: 0.008 },
};
const TABLE2_TOL: Record<string, { angDeg: number; radAU: number }> = {
  Mercury: { angDeg: 0.011, radAU: radialToleranceAU(1) },
  Venus: { angDeg: 0.022, radAU: radialToleranceAU(8) },
  Earth: { angDeg: 0.022, radAU: radialToleranceAU(15) },
  Mars: { angDeg: 0.056, radAU: radialToleranceAU(30) },
  Jupiter: { angDeg: 0.333, radAU: radialToleranceAU(1000) },
  Saturn: { angDeg: 0.556, radAU: radialToleranceAU(4000) },
  Uranus: { angDeg: 1.111, radAU: radialToleranceAU(8000) },
  Neptune: { angDeg: 0.222, radAU: radialToleranceAU(4000) },
  Pluto: { angDeg: 0.222, radAU: radialToleranceAU(2500) },
};
const TABLE2_EPOCHS = [2360234.5, 2634166.5];

describe('Standish propagation vs Horizons goldens', () => {
  // The body named 'Earth' resolves the EMB element row, so it is compared
  // against the EMB fixture (the 'Earth' fixture belongs to the Meeus golden
  // further down). If a body marginally fails here, check the accuracy table and the
  // apparent-vs-geometric systematics before touching any tolerance.
  for (const planet of PLANETARIUM_BODIES) {
    it(`puts ${planet.name} within quoted Standish accuracy at every fixture epoch`, () => {
      const fixtureBody = planet.name === 'Earth' ? 'EMB' : planet.name;
      const epochs =
        planet.name === 'Jupiter' || planet.name === 'Saturn' || planet.name === 'Pluto'
          ? [...FIXTURE_EPOCHS, 2634166.5]
          : FIXTURE_EPOCHS;
      for (const jd of epochs) {
        const tol = (TABLE2_EPOCHS.includes(jd) ? TABLE2_TOL : TABLE1_TOL)[planet.name];
        const el = getStandishElements(planet.name, jd);
        const scene = computeKeplerPositionEquatorial(el);
        const golden = horizonsToScene(fixture(fixtureBody, jd));
        expect(separationDeg(scene, golden), `${planet.name} angle @ JD ${jd}`).toBeLessThan(tol.angDeg);
        expect(Math.abs(scene.length() - golden.length()), `${planet.name} radius @ JD ${jd}`).toBeLessThan(tol.radAU);
      }
    });
  }
});

describe('production resolver golden (computeBodyState wiring)', () => {
  it('routes Jupiter through name-keyed elements and the utcMs→TT clock', () => {
    // The element goldens above call getStandishElements directly; this one
    // exercises the production path — PLANETARIUM_BODIES entry, name keying,
    // utcMs→jdTT conversion — end to end. The naive UTC↔TDB mismatch (~69 s)
    // moves Jupiter ~7e-5°, far inside the tolerance.
    const jupiter = PLANETARIUM_BODIES.find((p) => p.name === 'Jupiter')!;
    const utcMs = (2461200.5 - 2440587.5) * 86_400_000;
    const state = computeBodyState(jupiter, utcMs);
    const golden = horizonsToScene(fixture('Jupiter', 2461200.5));
    expect(separationDeg(state.positionAU, golden)).toBeLessThan(TABLE1_TOL.Jupiter.angDeg);
  });
});

describe('planet sits on its own orbit line', () => {
  it('keeps every body within 1e-3·a of the sampled line through the same elements', () => {
    // Position and line are two code paths from one element set; after the
    // orbit lines became element-sampled this is the invariant the eye checks.
    const line3 = new THREE.Line3();
    const closest = new THREE.Vector3();
    for (const planet of PLANETARIUM_BODIES) {
      const el = getStandishElements(planet.name, 2461200.5);
      const position = computeKeplerPositionEquatorial(el);
      const points = sampleOrbitLinePoints(el, 256);
      let minDistance = Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        line3.set(points[i], points[i + 1]);
        line3.closestPointToPoint(position, true, closest);
        minDistance = Math.min(minDistance, closest.distanceTo(position));
      }
      expect(minDistance, planet.name).toBeLessThan(1e-3 * el.semiMajorAxisAU);
    }
  });
});

describe('Table-1/Table-2 handoff', () => {
  it('keeps both tables within combined tolerance at the 1800 and 2050 boundaries', () => {
    // The tables are independent fits, so a small snap at the boundary is
    // expected (measured worst ~0.27°, Uranus@1800; the boundary IS reachable
    // in normal use — 2050 is 24 sim-years out — and the snap is far below
    // line-visibility). The test's real job: one mistyped rate digit explodes
    // the gap to degrees.
    const boundaries = [J2000 - 2.0 * 36525, J2000 + 0.5 * 36525];
    for (const planet of PLANETARIUM_BODIES) {
      for (const jd of boundaries) {
        const fromT1 = computeKeplerPositionEquatorial(getElementsFromTable(1, planet.name, jd));
        const fromT2 = computeKeplerPositionEquatorial(getElementsFromTable(2, planet.name, jd));
        const tolDeg = TABLE1_TOL[planet.name].angDeg + TABLE2_TOL[planet.name].angDeg;
        expect(separationDeg(fromT1, fromT2), `${planet.name} @ JD ${jd}`).toBeLessThan(tolDeg);
        expect(
          Math.abs(fromT1.length() - fromT2.length()),
          `${planet.name} radius @ JD ${jd}`,
        ).toBeLessThan(TABLE1_TOL[planet.name].radAU + TABLE2_TOL[planet.name].radAU);
      }
    }
  });
});

describe('getStandishElements', () => {
  it('returns Table-1 J2000 values verbatim at T = 0 (oddball-digit spot checks)', () => {
    // These exact digits are the transcription tripwires: negative mean
    // longitudes, the near-zero EMB inclination, the zeroed EMB node.
    const mars = getStandishElements('Mars', J2000);
    expect(mars.lonPerihelionDeg).toBe(-23.94362959);
    expect(mars.meanAnomalyDeg).toBeCloseTo(-4.55343205 - -23.94362959, 10);
    const neptune = getStandishElements('Neptune', J2000);
    expect(neptune.meanAnomalyDeg).toBeCloseTo(-55.12002969 - 44.96476227, 10);
    const emb = getStandishElements('Earth', J2000);
    expect(emb.inclinationDeg).toBe(-0.00001531);
    expect(emb.ascendingNodeDeg).toBe(0);
    const pluto = getStandishElements('Pluto', J2000);
    expect(pluto.eccentricity).toBe(0.2488273);
  });

  it('returns Table-2 values verbatim through the table-2 accessor at T = 0', () => {
    const mercury = getElementsFromTable(2, 'Mercury', J2000);
    expect(mercury.semiMajorAxisAU).toBe(0.38709843); // T2 a; T1 has 0.38709927
    expect(mercury.eccentricity).toBe(0.20563661);
    const emb = getElementsFromTable(2, 'Earth', J2000);
    expect(emb.ascendingNodeDeg).toBe(-5.11260389); // T2 EMB node is NOT zero
  });

  it('selects Table 1 only inside 1800–2050', () => {
    const inside = [J2000, J2000 - 2.0 * 36525, J2000 + 0.5 * 36525]; // 2000, 1800, 2050
    for (const jd of inside) {
      expect(getStandishElements('Mercury', jd)).toEqual(getElementsFromTable(1, 'Mercury', jd));
    }
    const outside = [J2000 - 2.01 * 36525, J2000 + 0.51 * 36525]; // ~1799, ~2051
    for (const jd of outside) {
      expect(getStandishElements('Mercury', jd)).toEqual(getElementsFromTable(2, 'Mercury', jd));
    }
  });

  it('clamps T to Table-2 validity beyond 3000 BC / 3000 AD', () => {
    const atMaxClamp = getStandishElements('Mars', J2000 + 10 * 36525); // 3000 AD
    const pastMaxClamp = getStandishElements('Mars', J2000 + 30 * 36525); // 5000 AD
    expect(pastMaxClamp).toEqual(atMaxClamp);
    const atMinClamp = getStandishElements('Mars', J2000 - 50 * 36525); // 3000 BC
    const pastMinClamp = getStandishElements('Mars', J2000 - 80 * 36525); // 6000 BC
    expect(pastMinClamp).toEqual(atMinClamp);
  });

  it('applies the Table-2b M corrections to Jupiter–Pluto only, Pluto b-only', () => {
    const T = 5; // 2500 AD — extras are degrees-sized here
    const jd = J2000 + T * 36525;
    const linearM = (row: { L: number; LDot: number; lonPeri: number; lonPeriDot: number }) =>
      row.L + row.LDot * T - (row.lonPeri + row.lonPeriDot * T);
    // Mars: pure linear propagation (no extras row).
    const mars = getStandishElements('Mars', jd);
    const marsLinear = linearM({ L: -4.56813164, LDot: 19140.29934243, lonPeri: -23.91744784, lonPeriDot: 0.45223625 });
    expect(Math.abs(norm180(mars.meanAnomalyDeg - marsLinear))).toBeLessThan(1e-9);
    // Jupiter: differs from linear by its b/c/s terms exactly.
    const jupiter = getStandishElements('Jupiter', jd);
    const jupiterLinear = linearM({ L: 34.33479152, LDot: 3034.90371757, lonPeri: 14.27495244, lonPeriDot: 0.18199196 });
    const jupiterExtras =
      -0.00012452 * T * T + 0.0606406 * Math.cos(38.35125 * T * Math.PI / 180) + -0.35635438 * Math.sin(38.35125 * T * Math.PI / 180);
    expect(norm180(jupiter.meanAnomalyDeg - jupiterLinear)).toBeCloseTo(norm180(jupiterExtras), 9);
    // Pluto: b·T² only — no periodic component.
    const pluto = getStandishElements('Pluto', jd);
    const plutoLinear = linearM({ L: 238.96535011, LDot: 145.18042903, lonPeri: 224.09702598, lonPeriDot: -0.00968827 });
    expect(norm180(pluto.meanAnomalyDeg - plutoLinear)).toBeCloseTo(-0.01262724 * T * T, 9);
  });

  it('normalizes meanAnomalyDeg into [−180°, 180°] at far epochs', () => {
    for (const name of ['Mercury', 'Mars', 'Pluto']) {
      for (const T of [-50, -7.3, 4.2, 10]) {
        const el = getStandishElements(name, J2000 + T * 36525);
        expect(el.meanAnomalyDeg).toBeGreaterThanOrEqual(-180);
        expect(el.meanAnomalyDeg).toBeLessThanOrEqual(180);
      }
    }
  });

  it('resolves every PLANETARIUM_BODIES name and throws on unknown ones', () => {
    for (const planet of PLANETARIUM_BODIES) {
      expect(() => getStandishElements(planet.name, J2000)).not.toThrow();
    }
    expect(() => getStandishElements('Vulcan', J2000)).toThrow(/Vulcan/);
  });
});

describe('Meeus Earth golden vs Horizons — the absolute J2000 frame pin', () => {
  // Every coherent-set test is *relative* (both seams rotating together with
  // the wrong precession sign stays green); this golden is absolute and does
  // not forgive that. Error budget: Meeus ch. 25 truncation ~0.01°, aberration
  // (sunPosition returns apparent λ; Horizons is geometric) −20.5″ systematic,
  // nutation ±18″ periodic, plus — at 1750 only — the neglected ecliptic-plane
  // tilt ~47″/cy·|T| ≈ 0.031° in latitude (see precession.ts). If an epoch
  // goes marginal, suspect these systematics before the precession constant.
  const TOLERANCE_DEG: Record<number, number> = {
    2360234.5: 0.05, // measured 0.0317° — dominated by the neglected β tilt
    2447892.5: 0.02, // measured 0.0013°
    2461200.5: 0.02, // measured 0.0054°
    2467900.5: 0.02, // measured 0.0028°
  };

  it('puts the Meeus-derived Earth on the Horizons J2000 Earth at all epochs', () => {
    for (const jd of FIXTURE_EPOCHS) {
      const sep = separationDeg(
        computeEarthPositionEquatorial(jd),
        horizonsToScene(fixture('Earth', jd)),
      );
      expect(sep, `JD ${jd}`).toBeLessThan(TOLERANCE_DEG[jd]);
    }
  });
});

describe('Meeus Moon golden vs Horizons — absolute pin for the Moon seam', () => {
  it('puts the geocentric Moon on the Horizons J2000 Moon', () => {
    // Pins computeMoonGeocentricEquatorialAU independently of the Earth seam:
    // precessing one seam but not the other slips past the relative eclipse
    // tests (the 2027 bound computes to ~0.39° vs its 0.4° limit) but fails
    // here by the full ~0.37°. Measured: 0.0132° (1990), 0.0254° (2026) —
    // truncated ch. 47 series, ≪ the 0.1° bound.
    for (const f of MOON_FIXTURES) {
      const moon = computeMoonGeocentricEquatorialAU(f.jdTdb, new THREE.Vector3());
      expect(separationDeg(moon, horizonsToScene(f)), `JD ${f.jdTdb}`).toBeLessThan(0.1);
    }
  });
});
