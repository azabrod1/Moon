/**
 * Goldens and consistency tests for the satellite (moon) ephemeris.
 *
 * Fixtures: satellites.goldens.json — verbatim JPL Horizons planetocentric
 * vectors (AU, ecliptic J2000, TDB; query params in its provenance block),
 * regenerated together with satelliteElements.ts by `npm run gen:moons`.
 *
 * Tolerances are MEASURED, never guessed: each record carries the generator's
 * measured residuals (maxCalibrationSeparationDeg / holdoutSeparationDeg) and
 * the tests bound against 1.3× those values. For librators (Mimas's ±44°
 * Mimas–Tethys libration, Janus/Epimetheus co-orbital swaps, trojans,
 * Hyperion) and rate-precision-limited moons the recorded residuals are large
 * — these are honest physical/source limits, and the radial + plane checks
 * below still bind for them. The held-out 2026 epoch was never used for
 * calibration or rate fitting (semi-independent for tier 'fitted', whose rates
 * were fitted on the other epochs; near-epoch for the 2025-epoch URA184 rows).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import goldensJson from './satellites.goldens.json';
import { SATELLITE_ELEMENTS } from './satelliteElements';
import {
  computeSatelliteOffsetEquatorialAU,
  getSatelliteApoapsisAU,
  getSatelliteElements,
} from './satellites';
import { eclipticToEquatorial, raDecToVector } from './planetary';
import { KM_PER_AU, RAD } from './constants';
import { MOONS } from '../planetarium/planets/moonData';

interface MoonGolden {
  center: string;
  anchorJdTdb: number;
  vectorsAuEclipticJ2000: Record<string, [string, string, string]>;
}
const goldens = goldensJson as unknown as {
  provenance: { holdoutJdTdb: number };
  moons: Record<string, MoonGolden>;
};

/** Horizons ecliptic-J2000 → scene equatorial (same convention as standish.test.ts). */
function horizonsToScene(raw: [string, string, string]): THREE.Vector3 {
  return eclipticToEquatorial(new THREE.Vector3(Number(raw[0]), Number(raw[2]), Number(raw[1])));
}

const HOLDOUT_KEY = goldens.provenance.holdoutJdTdb.toFixed(1);
const out = new THREE.Vector3();
const normal = new THREE.Vector3();
const moonNames = Object.keys(SATELLITE_ELEMENTS);

describe('satellite elements coverage', () => {
  it('covers every non-Earth catalog moon, keyed by unique name', () => {
    const catalog = MOONS.filter((m) => m.parentPlanet !== 'Earth');
    expect(moonNames.length).toBe(catalog.length);
    for (const moon of catalog) {
      expect(SATELLITE_ELEMENTS[moon.name], moon.name).toBeDefined();
      expect(SATELLITE_ELEMENTS[moon.name].parentPlanet, moon.name).toBe(moon.parentPlanet);
    }
    expect(SATELLITE_ELEMENTS['Moon']).toBeUndefined();
  });

  it('agrees with the catalog on orbit size (name-mismatch tripwire)', () => {
    for (const moon of MOONS.filter((m) => m.parentPlanet !== 'Earth')) {
      const aAU = SATELLITE_ELEMENTS[moon.name].aKm / KM_PER_AU;
      expect(aAU / moon.orbitalRadiusAU, moon.name).toBeGreaterThan(0.85);
      expect(aAU / moon.orbitalRadiusAU, moon.name).toBeLessThan(1.15);
    }
  });

  it('pins the Uranus equatorial-frame rows to the anti-IAU pole', () => {
    // URA182 'equatorial' rows are referred to the angular-momentum pole
    // (77.311, +15.175), NOT the IAU pole (257.311, −15.175): Miranda anchors
    // at 1.1° with this pole and ~116° with the IAU pole (plan receipts).
    for (const name of ['Miranda', 'Ariel', 'Umbriel', 'Titania', 'Oberon']) {
      expect(SATELLITE_ELEMENTS[name].poleRaDeg, name).toBeCloseTo(77.311, 3);
      expect(SATELLITE_ELEMENTS[name].poleDecDeg, name).toBeCloseTo(15.175, 3);
    }
  });
});

describe('anchor epoch (frame + M0 inversion)', () => {
  // At each moon's element epoch the mean anomaly was anchored by inverting
  // this exact Horizons vector — but only the IN-PLANE angle is absorbable:
  // what remains is the out-of-plane misfit between the row's quoted plane
  // (i/node at 0.1° quantization) and the true osculating plane. Measured:
  // ≲0.6° for regular moons (Rhea 0.56°), up to ~15° for the Kozai-perturbed
  // irregulars (Neso 14.7°, Halimede 13.7°) whose mean plane differs from
  // osculating. A frame-basis bug in satellites.ts breaks the clean moons at
  // tens of degrees, far above this floor.
  it('reproduces the anchor vector for every moon', () => {
    for (const name of moonNames) {
      const record = SATELLITE_ELEMENTS[name];
      const golden = goldens.moons[name];
      const raw = golden.vectorsAuEclipticJ2000[golden.anchorJdTdb.toFixed(1)];
      const expected = horizonsToScene(raw);
      computeSatelliteOffsetEquatorialAU(name, golden.anchorJdTdb, out);
      const separationDeg = out.angleTo(expected) * RAD;
      const tolDeg = Math.max(0.7, 1.3 * record.maxCalibrationSeparationDeg);
      expect(separationDeg, `${name} at its anchor epoch`).toBeLessThan(tolDeg);
    }
  });
});

describe('calibration + holdout goldens (measured regression pins)', () => {
  for (const name of moonNames) {
    it(`tracks Horizons for ${name} within its measured residuals`, () => {
      const record = SATELLITE_ELEMENTS[name];
      const golden = goldens.moons[name];
      const calibrationTolDeg = Math.max(record.maxCalibrationSeparationDeg * 1.3, 0.2);
      const holdoutTolDeg = Math.max(record.holdoutSeparationDeg * 1.3, 0.2);
      const anchorKey = golden.anchorJdTdb.toFixed(1);
      for (const [jdKey, raw] of Object.entries(golden.vectorsAuEclipticJ2000)) {
        // the anchor epoch is bounded by its own test above (different floor:
        // out-of-plane misfit isn't part of the calibration residuals)
        if (jdKey === anchorKey) continue;
        const expected = horizonsToScene(raw);
        computeSatelliteOffsetEquatorialAU(name, Number(jdKey), out);
        const separationDeg = out.angleTo(expected) * RAD;
        const tolDeg = jdKey === HOLDOUT_KEY ? holdoutTolDeg : calibrationTolDeg;
        expect(separationDeg, `${name} @ JD ${jdKey}`).toBeLessThan(tolDeg);
      }
    });
  }
});

describe('absolute accuracy backstop (headline moons)', () => {
  // The measured-residual tolerances above are regression pins that move with
  // the generated records — if the math regressed and the table were
  // regenerated, they would move together. These absolute caps break that
  // circularity for the moons players actually visit: a regeneration that
  // degrades them fails here no matter what the records claim.
  const ABSOLUTE_CAP_DEG: Record<string, number> = {
    Io: 3, Europa: 4, Ganymede: 2, Callisto: 2,
    Enceladus: 3, Tethys: 5, Dione: 3, Rhea: 3, Titan: 8, Iapetus: 4,
    Miranda: 4, Ariel: 2, Umbriel: 2, Titania: 2, Oberon: 2,
    Triton: 2, Proteus: 3, Nereid: 2, Charon: 1, Phobos: 6, Deimos: 5,
  };
  it('keeps every headline moon within its absolute cap at every golden epoch', () => {
    for (const [name, capDeg] of Object.entries(ABSOLUTE_CAP_DEG)) {
      const golden = goldens.moons[name];
      for (const [jdKey, raw] of Object.entries(golden.vectorsAuEclipticJ2000)) {
        const expected = horizonsToScene(raw);
        computeSatelliteOffsetEquatorialAU(name, Number(jdKey), out);
        expect(out.angleTo(expected) * RAD, `${name} @ JD ${jdKey}`).toBeLessThan(capDeg);
      }
    }
  });
});

describe('radial consistency (plane + ellipse bind even where phase is loose)', () => {
  // Margins are measured classes, not guesses: solar-perturbed irregulars'
  // mean a/e differ from osculating (Neso +17.5% worst); Pluto's small moons'
  // rows are BARYCENTRIC while Horizons vectors are plutocentric (the ±1–4%
  // radial wobble matches Pluto's ~2100 km motion about the Pluto–Charon
  // barycenter); everything else holds to a few percent.
  // Measured worst exceedances ×~1.4 headroom: Neso 49.2%(!), Pasiphae 9.8%,
  // Ananke 5.3%, Elara 5.1%, Pluto smalls ≤4.8%, rest ≤3.2%.
  const RADIAL_MARGIN_OVERRIDES: Record<string, number> = {
    Neso: 0.7, Halimede: 0.12, Ananke: 0.08, Carme: 0.08, Pasiphae: 0.14,
    Sinope: 0.08, Elara: 0.08, Lysithea: 0.08, Himalia: 0.08, Caliban: 0.12,
    Sycorax: 0.08, Nereid: 0.04, Hyperion: 0.04,
    Styx: 0.07, Nix: 0.07, Kerberos: 0.07, Hydra: 0.07,
  };
  it('keeps |r| within the record ellipse plus the measured class margin', () => {
    for (const name of moonNames) {
      const record = SATELLITE_ELEMENTS[name];
      const golden = goldens.moons[name];
      const margin = RADIAL_MARGIN_OVERRIDES[name] ?? 0.03;
      const aAU = record.aKm / KM_PER_AU;
      const minAU = aAU * (1 - record.eccentricity) * (1 - margin);
      const maxAU = aAU * (1 + record.eccentricity) * (1 + margin);
      for (const [jdKey, raw] of Object.entries(golden.vectorsAuEclipticJ2000)) {
        // the source data itself stays on the record's ellipse...
        const r = horizonsToScene(raw).length();
        expect(r, `${name} golden radius`).toBeGreaterThan(minAU);
        expect(r, `${name} golden radius`).toBeLessThan(maxAU);
        // ...and so does the RUNTIME radius — the angular goldens use
        // angleTo() which a pure scale bug would slip past.
        const runtimeR = computeSatelliteOffsetEquatorialAU(name, Number(jdKey), out).length();
        expect(runtimeR, `${name} runtime radius @ ${jdKey}`).toBeGreaterThan(aAU * (1 - record.eccentricity) * 0.999);
        expect(runtimeR, `${name} runtime radius @ ${jdKey}`).toBeLessThan(aAU * (1 + record.eccentricity) * 1.001);
      }
    }
  });
});

describe('orbit normal', () => {
  const testJds = [2451545.0, 2458849.5, 2461202.5];

  it('is unit length and perpendicular to the offset for every moon', () => {
    for (const name of moonNames) {
      for (const jd of testJds) {
        computeSatelliteOffsetEquatorialAU(name, jd, out, normal);
        expect(Math.abs(normal.length() - 1), `${name} |n|`).toBeLessThan(1e-9);
        expect(Math.abs(normal.dot(out) / out.length()), `${name} n⊥r @ ${jd}`).toBeLessThan(1e-9);
      }
    }
  });

  it('points opposite the reference pole for retrograde moons (Triton i≈157°)', () => {
    const record = SATELLITE_ELEMENTS['Triton'];
    const pole = raDecToVector(record.poleRaDeg!, record.poleDecDeg!);
    computeSatelliteOffsetEquatorialAU('Triton', 2461202.5, out, normal);
    const tiltDeg = normal.angleTo(pole) * RAD;
    expect(tiltDeg).toBeCloseTo(record.inclinationDeg, 0);
    expect(normal.dot(pole)).toBeLessThan(0);
  });
});

describe('getSatelliteElements adapter', () => {
  it('builds ϖ from the same propagated node it returns (ω recoverable)', () => {
    const jd = 2461202.5;
    for (const name of ['Io', 'Triton', 'Iapetus', 'Nereid']) {
      const record = SATELLITE_ELEMENTS[name];
      const el = getSatelliteElements(name, jd);
      const dt = jd - record.epochJdTdb;
      const expectedOmega = record.argPeriapsisAtEpochDeg + record.argPeriapsisRateDegPerDay * dt;
      expect(el.lonPerihelionDeg - el.ascendingNodeDeg, name).toBeCloseTo(expectedOmega, 9);
      expect(el.meanAnomalyDeg, name).toBeGreaterThanOrEqual(0);
      expect(el.meanAnomalyDeg, name).toBeLessThan(360);
      expect(el.semiMajorAxisAU, name).toBeCloseTo(record.aKm / KM_PER_AU, 12);
    }
  });
});

describe('edge cases', () => {
  it('throws on unknown moon', () => {
    expect(() => computeSatelliteOffsetEquatorialAU('Endor', 2451545.0, out)).toThrow(/Endor/);
    expect(() => getSatelliteElements('Endor', 2451545.0)).toThrow(/Endor/);
  });

  it('handles Nereid (e=0.751) without Kepler divergence across an orbit', () => {
    const record = SATELLITE_ELEMENTS['Nereid'];
    expect(record.eccentricity).toBeGreaterThan(0.7);
    const periodDays = 360 / record.meanAnomalyRateDegPerDay;
    for (let k = 0; k <= 20; k++) {
      const jd = 2461202.5 + (k / 20) * periodDays;
      computeSatelliteOffsetEquatorialAU('Nereid', jd, out);
      expect(Number.isFinite(out.length())).toBe(true);
      expect(out.length()).toBeGreaterThan((record.aKm / KM_PER_AU) * (1 - record.eccentricity) * 0.99);
      expect(out.length()).toBeLessThan((record.aKm / KM_PER_AU) * (1 + record.eccentricity) * 1.01);
    }
  });

  it('reports apoapsis for threshold sizing (Neso reaches ~0.49 AU)', () => {
    expect(getSatelliteApoapsisAU('Neso')).toBeGreaterThan(0.45);
    expect(getSatelliteApoapsisAU('Io')).toBeCloseTo((421800 / KM_PER_AU) * 1.004, 5);
  });
});
