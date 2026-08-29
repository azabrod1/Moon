import { describe, it, expect } from 'vitest';
import {
  ATMOSPHERE_SPECS,
  ATMOSPHERE_TABLE_SIZES_FULL,
  ATMOSPHERE_TABLE_SIZES_HALF,
  ATMOSPHERE_TOP_SCALES,
  AIRLIGHT_SCALE,
  SOLAR_DISTANCE_DECAY,
  atmosphereParams,
  atmosphereParamsAU,
  bodySolarIrradianceScale,
  computeSingleScattering,
  distanceToTopBoundary,
  extrapolateSingleMieScattering,
  irradianceUvFromRMuS,
  miePhase,
  opticalDepthToTopBoundary,
  opticalLengthToTopBoundary,
  rMuFromTransmittanceUv,
  rMuMuSNuFromScatteringUvwz,
  rMuSFromIrradianceUv,
  rayIntersectsGround,
  rayleighPhase,
  scatteringTexture3DCoords,
  scatteringTextureWidth,
  scatteringUvwzFromRMuMuSNu,
  solarIrradianceScale,
  transmittanceToTopBoundary,
  transmittanceUvFromRMu,
  toRadiusUnits,
} from './atmosphereModel';
import { ATMOSPHERES, SUN_LIGHT_DECAY, SUN_LIGHT_INTENSITY } from '../PlanetFactory';
import { PLANETS } from '../planets/planetData';

const KM_PER_AU = 149_597_870.7;

describe('atmosphere parameters', () => {
  it('converts the published per-metre coefficients to per-AU', () => {
    const earth = atmosphereParamsAU('Earth');
    // The survey's reference set, which every other number here rests on.
    expect(earth.rayleighScattering[0]).toBeCloseTo(8.67668e5, -1);
    expect(earth.rayleighScattering[1]).toBeCloseTo(2.01957e6, -2);
    expect(earth.rayleighScattering[2]).toBeCloseTo(4.95169e6, -2);
    expect(earth.mieScattering[0]).toBeCloseTo(2.99196e6, -2);
    // Mie extinction is scattering over a 0.9 single-scattering albedo.
    expect(earth.mieExtinction[0] / earth.mieScattering[0]).toBeCloseTo(1 / 0.9, 12);
    // The survey's ozone triple is quoted to five figures; compare relatively.
    expect(earth.absorptionExtinction[0] / 9.724e4).toBeCloseTo(1, 4);
    expect(earth.absorptionExtinction[1] / 2.8140e5).toBeCloseTo(1, 4);
    expect(earth.absorptionExtinction[2] / 1.2716e4).toBeCloseTo(1, 4);
    expect(earth.miePhaseG).toBe(0.83);
    expect(earth.groundAlbedo).toBe(0.1);
  });

  it('carries the Rayleigh and Mie scale heights in AU', () => {
    const earth = atmosphereParamsAU('Earth');
    expect(-1 / earth.rayleighDensity[1].expScale).toBeCloseTo(5.34767e-8, 13);
    expect(-1 / earth.mieDensity[1].expScale).toBeCloseTo(8.0215e-9, 14);
  });

  it('closes the unit chain: vertical optical depth at 440 nm is 0.265', () => {
    const earth = atmosphereParamsAU('Earth');
    const H = -1 / earth.rayleighDensity[1].expScale;
    expect(earth.rayleighScattering[2] * H).toBeCloseTo(0.2648, 4);
    // And the same number falls out of the numerical integrator, less the
    // fraction of the column above the modelled top.
    const tau = earth.rayleighScattering[2]
      * opticalLengthToTopBoundary(earth, earth.rayleighDensity, earth.bottomRadius, 1);
    expect(tau).toBeCloseTo(0.2648, 3);
  });

  it('closes the same optical depth in radius units', () => {
    const earth = atmosphereParams('Earth');
    const H = -1 / earth.rayleighDensity[1].expScale;
    expect(earth.rayleighScattering[2] * H).toBeCloseTo(0.2648, 4);
    expect(earth.bottomRadius).toBe(1);
    expect(earth.topRadius).toBeCloseTo(ATMOSPHERE_TOP_SCALES.Earth, 12);
  });

  it('places the ozone tent at 10-40 km peaking at 25 km', () => {
    const earth = atmosphereParamsAU('Earth');
    const alt = (km: number) => km / KM_PER_AU;
    const density = (km: number) => {
      const layer = alt(km) < earth.absorptionDensity[0].width
        ? earth.absorptionDensity[0]
        : earth.absorptionDensity[1];
      return Math.min(1, Math.max(0, layer.linearTerm * alt(km) + layer.constantTerm));
    };
    expect(density(10)).toBeCloseTo(0, 9);
    expect(density(25)).toBeCloseTo(1, 9);
    expect(density(40)).toBeCloseTo(0, 9);
    expect(density(17.5)).toBeCloseTo(0.5, 9);
  });

  it('derives the top scale from the body radius', () => {
    const earthRadiusKm = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;
    expect(ATMOSPHERE_TOP_SCALES.Earth).toBeCloseTo(1 + 100 / earthRadiusKm, 12);
    expect(ATMOSPHERE_TOP_SCALES.Earth).toBeCloseTo(1.015679, 6);
  });

  it('keeps the physical top inside the shell mesh for every body with a table', () => {
    for (const name of Object.keys(ATMOSPHERE_SPECS)) {
      const meshScale = ATMOSPHERES[name]?.scale;
      expect(meshScale, `${name} has no atmosphere shell mesh`).toBeGreaterThan(0);
      // The mesh has to cover every air ray, and the gap above the physical top
      // is where the radiance tapers to zero — it must clear the sagitta of the
      // 64-segment silhouette or the taper scallops around the limb.
      const radiusKm = PLANETS.find((p) => p.name === name)!.radiusKm;
      const sagittaKm = radiusKm * meshScale * (1 - Math.cos(Math.PI / 64));
      const roomKm = (meshScale - ATMOSPHERE_TOP_SCALES[name]) * radiusKm;
      expect(ATMOSPHERE_TOP_SCALES[name]).toBeLessThan(meshScale);
      expect(roomKm).toBeGreaterThan(sagittaKm);
    }
  });

  it('gives Mars a dust-dominated, spectrally absorbing aerosol', () => {
    const mars = atmosphereParamsAU('Mars');
    // Dust extinction exceeds Earth's aerosol load and dwarfs Mars' own gas.
    expect(mars.mieExtinction[0]).toBeGreaterThan(atmosphereParamsAU('Earth').mieExtinction[0]);
    expect(mars.mieExtinction[1]).toBeGreaterThan(mars.rayleighScattering[1] * 50);
    // Blue is absorbed hardest — that asymmetry is the butterscotch sky.
    const albedo = ATMOSPHERE_SPECS.Mars.mieSingleScatteringAlbedo;
    expect(albedo[2]).toBeLessThan(albedo[0]);
    expect(mars.mieExtinction[2] / mars.mieScattering[2]).toBeCloseTo(1 / 0.63, 12);
  });
});

describe('solar irradiance scale', () => {
  it('follows the Sun point light\'s own decay law, not inverse square', () => {
    // Read the exponent from the light itself: changing the light must break
    // this test rather than silently de-calibrate every table.
    expect(SOLAR_DISTANCE_DECAY).toBe(SUN_LIGHT_DECAY);
    expect(solarIrradianceScale(2)).toBeCloseTo(Math.pow(2, -SUN_LIGHT_DECAY), 12);
    expect(solarIrradianceScale(2)).not.toBeCloseTo(1 / 4, 3);
  });

  it('carries the light\'s own intensity into the airlight scale', () => {
    // The tables are baked at one unit of irradiance; the ground is lit at the
    // light's intensity. Air and ground have to be at the same exposure, so the
    // bridge is the intensity itself — read from the light, not authored.
    expect(AIRLIGHT_SCALE).toBe(SUN_LIGHT_INTENSITY);
  });

  it('is 1 at Earth and 1.524^-0.3 at Mars', () => {
    expect(bodySolarIrradianceScale('Earth')).toBeCloseTo(1, 12);
    const marsAU = PLANETS.find((p) => p.name === 'Mars')!.semiMajorAxisAU;
    expect(marsAU).toBe(1.524);
    expect(bodySolarIrradianceScale('Mars')).toBeCloseTo(Math.pow(1.524, -0.3), 12);
    expect(bodySolarIrradianceScale('Mars')).toBeCloseTo(0.8813, 4);
  });

  it('is zero for a non-positive distance rather than infinite', () => {
    expect(solarIrradianceScale(0)).toBe(0);
    expect(solarIrradianceScale(-1)).toBe(0);
  });
});

describe('table addressing', () => {
  const earth = atmosphereParams('Earth');
  const sizes = ATMOSPHERE_TABLE_SIZES_FULL;

  it('round-trips the transmittance mapping', () => {
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const uv = {
          u: 0.5 / sizes.transmittanceW + (i / 8) * (1 - 1 / sizes.transmittanceW),
          v: 0.5 / sizes.transmittanceH + (j / 8) * (1 - 1 / sizes.transmittanceH),
        };
        const { r, mu } = rMuFromTransmittanceUv(earth, uv, sizes);
        expect(r).toBeGreaterThanOrEqual(earth.bottomRadius - 1e-12);
        expect(r).toBeLessThanOrEqual(earth.topRadius + 1e-12);
        const back = transmittanceUvFromRMu(earth, r, mu, sizes);
        expect(back.u).toBeCloseTo(uv.u, 6);
        expect(back.v).toBeCloseTo(uv.v, 6);
      }
    }
  });

  it('round-trips the scattering mapping on both sides of the horizon', () => {
    for (const uMuBase of [0.12, 0.37, 0.63, 0.91]) {
      for (const uR of [0.02, 0.5, 0.98]) {
        for (const uMuS of [0.05, 0.5, 0.95]) {
          const uvwz = { uNu: 0.3, uMuS, uMu: uMuBase, uR };
          const s = rMuMuSNuFromScatteringUvwz(earth, uvwz, sizes);
          expect(s.intersectsGround).toBe(uMuBase < 0.5);
          expect(rayIntersectsGround(earth, s.r, s.mu)).toBe(s.intersectsGround);
          const back = scatteringUvwzFromRMuMuSNu(
            earth, s.r, s.mu, s.muS, s.nu, s.intersectsGround, sizes,
          );
          expect(back.uR).toBeCloseTo(uvwz.uR, 6);
          expect(back.uMu).toBeCloseTo(uvwz.uMu, 6);
          expect(back.uMuS).toBeCloseTo(uvwz.uMuS, 6);
          expect(back.uNu).toBeCloseTo(uvwz.uNu, 12);
        }
      }
    }
  });

  it('round-trips the irradiance mapping', () => {
    for (const u of [0.1, 0.5, 0.9]) {
      for (const v of [0.1, 0.5, 0.9]) {
        const { r, muS } = rMuSFromIrradianceUv(earth, { u, v }, sizes);
        const back = irradianceUvFromRMuS(earth, r, muS, sizes);
        expect(back.u).toBeCloseTo(u, 9);
        expect(back.v).toBeCloseTo(v, 9);
      }
    }
  });

  it('splits the mu axis at the horizon with a half-texel clamp on each half', () => {
    const r = earth.bottomRadius + 0.5 * (earth.topRadius - earth.bottomRadius);
    const muHorizon = -Math.sqrt(1 - (earth.bottomRadius / r) ** 2);
    const halfTexel = 0.5 / sizes.scatteringMu;
    // Both branches evaluated AT the horizon: it is the boundary they share.
    const sky = scatteringUvwzFromRMuMuSNu(earth, r, muHorizon, 0.5, 0.3, false, sizes);
    const ground = scatteringUvwzFromRMuMuSNu(earth, r, muHorizon, 0.5, 0.3, true, sizes);
    // The horizon is the discontinuity, and the mapping puts it on the two
    // CLAMPED edges of the axis — the outermost texel centre of each half —
    // where clamp-to-edge stops filtering rather than merely slowing it.
    expect(ground.uMu).toBeCloseTo(halfTexel, 7);
    expect(sky.uMu).toBeCloseTo(1 - halfTexel, 7);
    // The 0.5 seam holds nadir against zenith, each inset by the same half
    // texel, so a ground ray and a sky ray can never land in one texel.
    const nadir = scatteringUvwzFromRMuMuSNu(earth, r, -1, 0.5, 0.3, true, sizes);
    const zenith = scatteringUvwzFromRMuMuSNu(earth, r, 1, 0.5, 0.3, false, sizes);
    expect(nadir.uMu).toBeCloseTo(0.5 - halfTexel, 9);
    expect(zenith.uMu).toBeCloseTo(0.5 + halfTexel, 9);
    // Every addressable coordinate stays inside its own half.
    for (let i = 0; i <= 16; i++) {
      const mu = -1 + (2 * i) / 16;
      const hits = rayIntersectsGround(earth, r, mu);
      const uvwz = scatteringUvwzFromRMuMuSNu(earth, r, mu, 0.5, 0.3, hits, sizes);
      if (hits) {
        expect(uvwz.uMu).toBeGreaterThanOrEqual(halfTexel - 1e-12);
        expect(uvwz.uMu).toBeLessThanOrEqual(0.5 - halfTexel + 1e-12);
      } else {
        expect(uvwz.uMu).toBeGreaterThanOrEqual(0.5 + halfTexel - 1e-12);
        expect(uvwz.uMu).toBeLessThanOrEqual(1 - halfTexel + 1e-12);
      }
    }
  });

  it('packs nu and mu_s onto one axis and lerps nu by hand', () => {
    expect(scatteringTextureWidth(sizes)).toBe(256);
    expect(scatteringTextureWidth(ATMOSPHERE_TABLE_SIZES_HALF)).toBe(128);
    const uvwz = { uNu: 0.5, uMuS: 0.25, uMu: 0.7, uR: 0.4 };
    const { uvw0, uvw1, lerp } = scatteringTexture3DCoords(uvwz, sizes);
    // The two fetches are one nu slab apart, and they differ ONLY on x — a
    // trilinear fetch across that seam would blend two different mu_s.
    expect(uvw1[0] - uvw0[0]).toBeCloseTo(1 / sizes.scatteringNu, 12);
    expect(uvw0[1]).toBe(uvwz.uMu);
    expect(uvw0[2]).toBe(uvwz.uR);
    expect(lerp).toBeGreaterThanOrEqual(0);
    expect(lerp).toBeLessThanOrEqual(1);
    // At the top of the nu range the second fetch runs off the end of the
    // axis; it carries zero weight there, so nothing off-table is ever read.
    const top = scatteringTexture3DCoords({ ...uvwz, uNu: 1 }, sizes);
    expect(top.lerp).toBe(0);
    expect(top.uvw0[0]).toBeLessThan(1);
  });

  it('keeps the half-size tables addressable by the same functions', () => {
    const half = ATMOSPHERE_TABLE_SIZES_HALF;
    const uvwz = { uNu: 0.3, uMuS: 0.4, uMu: 0.8, uR: 0.6 };
    const s = rMuMuSNuFromScatteringUvwz(earth, uvwz, half);
    const back = scatteringUvwzFromRMuMuSNu(earth, s.r, s.mu, s.muS, s.nu, s.intersectsGround, half);
    expect(back.uMu).toBeCloseTo(uvwz.uMu, 6);
    expect(back.uMuS).toBeCloseTo(uvwz.uMuS, 6);
  });
});

describe('single-Mie recovery', () => {
  const earth = atmosphereParams('Earth');

  it('returns zero rather than dividing by a vanished red channel', () => {
    expect(extrapolateSingleMieScattering(earth, [0, 0, 0, 0])).toEqual([0, 0, 0]);
    expect(extrapolateSingleMieScattering(earth, [-1e-9, 2e-9, 3e-9, 1e-9])).toEqual([0, 0, 0]);
    expect(extrapolateSingleMieScattering(earth, [0, 1e-6, 1e-6, 1e-6])).toEqual([0, 0, 0]);
  });

  it('reproduces the red Mie channel it was given', () => {
    const mie = extrapolateSingleMieScattering(earth, [0.4, 0.6, 0.9, 0.05]);
    expect(mie[0]).toBeCloseTo(0.05, 12);
    expect(mie.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('CPU reference', () => {
  const earth = atmosphereParams('Earth');

  it('gives full transmittance straight up from the top and none through the planet', () => {
    const top = transmittanceToTopBoundary(earth, earth.topRadius, 1);
    expect(top[0]).toBeCloseTo(1, 6);
    const groundUp = transmittanceToTopBoundary(earth, earth.bottomRadius, 1);
    // Blue is extinguished hardest: exp(-0.265) plus Mie and ozone.
    expect(groundUp[2]).toBeLessThan(groundUp[0]);
    expect(groundUp[2]).toBeGreaterThan(0.6);
    expect(groundUp[2]).toBeLessThan(0.78);
  });

  it('extinguishes a horizon ray far harder than a zenith one', () => {
    const zenith = transmittanceToTopBoundary(earth, earth.bottomRadius, 1);
    const horizon = transmittanceToTopBoundary(earth, earth.bottomRadius, 0);
    expect(horizon[2]).toBeLessThan(zenith[2] * 0.1);
  });

  it('scatters more blue than red for a sunlit sky ray', () => {
    const r = earth.bottomRadius + 1e-5;
    const s = computeSingleScattering(earth, r, 0.5, 1, 0.5, false, 32, 128);
    expect(s.rayleigh[2]).toBeGreaterThan(s.rayleigh[0]);
    expect(s.rayleigh.every((v) => v > 0 && Number.isFinite(v))).toBe(true);
    expect(s.mie.every((v) => v > 0 && Number.isFinite(v))).toBe(true);
  });

  it('scatters nothing along a ray that never sees the Sun', () => {
    const r = earth.bottomRadius + 1e-5;
    const s = computeSingleScattering(earth, r, 0.5, -1, -0.5, false, 32, 128);
    expect(s.rayleigh[0]).toBeCloseTo(0, 12);
    expect(s.mie[0]).toBeCloseTo(0, 12);
  });

  it('agrees with itself in AU and in radius units', () => {
    const au = atmosphereParamsAU('Earth');
    const rad = toRadiusUnits(au);
    const tAU = transmittanceToTopBoundary(au, au.bottomRadius, 0.3);
    const tRad = transmittanceToTopBoundary(rad, rad.bottomRadius, 0.3);
    expect(tRad[0]).toBeCloseTo(tAU[0], 9);
    expect(tRad[2]).toBeCloseTo(tAU[2], 9);
  });

  it('keeps optical depth and transmittance one relation apart', () => {
    // The table stores optical depth, not transmittance, because a horizon
    // transmittance is a half-float subnormal; this is the relation the shader
    // uses to get back.
    for (const mu of [1, 0.3, 0, -0.2]) {
      const tau = opticalDepthToTopBoundary(earth, earth.bottomRadius + 1e-4, mu);
      const t = transmittanceToTopBoundary(earth, earth.bottomRadius + 1e-4, mu);
      for (let c = 0; c < 3; c++) expect(Math.exp(-tau[c])).toBeCloseTo(t[c], 12);
    }
    // And the horizon depth is large enough that exp(-tau) is not representable
    // in half precision — the reason for the storage choice.
    const horizon = opticalDepthToTopBoundary(earth, earth.bottomRadius, 0);
    expect(horizon[2]).toBeGreaterThan(10);
    expect(Math.exp(-horizon[2])).toBeLessThan(6.1e-5);
  });

  it('measures the distance to the top boundary the way the geometry says', () => {
    // Straight up from the ground: exactly the shell thickness.
    expect(distanceToTopBoundary(earth, earth.bottomRadius, 1))
      .toBeCloseTo(earth.topRadius - earth.bottomRadius, 12);
    // Along the horizon: the half-chord of the shell.
    const chord = Math.sqrt(earth.topRadius ** 2 - earth.bottomRadius ** 2);
    expect(distanceToTopBoundary(earth, earth.bottomRadius, 0)).toBeCloseTo(chord, 12);
  });
});

describe('phase functions', () => {
  /** The whole solid angle, by Simpson over nu: 2*PI * integral(-1..1) p dnu. */
  const sphereIntegral = (p: (nu: number) => number): number => {
    const n = 20000;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const w = i === 0 || i === n ? 1 : (i % 2 === 1 ? 4 : 2);
      sum += w * p(-1 + (2 * i) / n);
    }
    return 2 * Math.PI * ((sum * (2 / n)) / 3);
  };

  it('pins the Rayleigh constant and integrates to one over the sphere', () => {
    expect(rayleighPhase(0)).toBeCloseTo(3 / (16 * Math.PI), 15);
    expect(rayleighPhase(1)).toBeCloseTo(3 / (8 * Math.PI), 15);
    expect(rayleighPhase(-1)).toBeCloseTo(3 / (8 * Math.PI), 15);
    // A phase function that does not integrate to 1 is an energy scale hiding
    // inside every order past the first.
    expect(sphereIntegral(rayleighPhase)).toBeCloseTo(1, 9);
  });

  it('stays bounded away from zero, which the order accumulation divides by', () => {
    // Orders past the first are stored divided by the Rayleigh phase, so one
    // multiply at lookup recovers them all; the division is only safe because
    // the minimum is 3/16pi, at nu = 0.
    let min = Infinity;
    for (let i = 0; i <= 2000; i++) min = Math.min(min, rayleighPhase(-1 + i / 1000));
    expect(min).toBeCloseTo(3 / (16 * Math.PI), 12);
    expect(min).toBeGreaterThan(0.059);
  });

  it('normalises Mie and holds its forward-to-back ratio at g = 0.83', () => {
    const g = ATMOSPHERE_SPECS.Earth.miePhaseG;
    expect(g).toBe(0.83);
    expect(sphereIntegral((nu) => miePhase(g, nu))).toBeCloseTo(1, 6);
    // Analytic for this phase function: ((1+g)/(1-g))^3, i.e. 1248x forward.
    expect(miePhase(g, 1) / miePhase(g, -1)).toBeCloseTo(((1 + g) / (1 - g)) ** 3, 4);
    expect(miePhase(g, 1) / miePhase(g, -1)).toBeGreaterThan(1000);
    // At g = 0 the Henyey-Greenstein form IS the Rayleigh phase, which pins
    // both constants against each other.
    for (const nu of [-1, -0.3, 0, 0.25, 1]) {
      expect(miePhase(0, nu)).toBeCloseTo(rayleighPhase(nu), 12);
    }
  });

  it('scatters Mars\' dust less forward than Earth\'s aerosol', () => {
    const mars = ATMOSPHERE_SPECS.Mars.miePhaseG;
    expect(mars).toBe(0.63);
    expect(miePhase(mars, 1)).toBeLessThan(miePhase(ATMOSPHERE_SPECS.Earth.miePhaseG, 1));
  });
});
