/**
 * Mass closure: every model whose regions all carry a density, integrated
 * shell by shell (4π∫ρr²dr over its own radii, each region joined the way it
 * declares, linear or log), must come within MASS_TOLERANCE of its body's
 * measured mass. A density profile that cannot close on its body fails
 * here: Saturn's once came to twice Saturn. A model with an unknown density
 * anywhere says nothing about its mass and is passed over, by name, so a
 * new one is a choice and the test can never pass by weighing nothing.
 *
 * The models known not to close are listed with what is wrong, and each must
 * still miss: the day one is fixed, this test asks for its entry to go.
 *
 * Saturn's pressures are derived from its densities (saturn.ts says how), so
 * they are held here to the hydrostatic balance of them: edit one and the
 * other has to follow.
 */
import { describe, expect, it } from 'vitest';
import { MASSES_KG } from '../../volumeCompare/compareLogic';
import { coverageFor, interiorBodyIds } from './interiorRegistry';
import { coverageModels, type InteriorModel, type Quantity, type Region } from './interiorTypes';
import { endpoints, profile, UNKNOWN } from './modelHelpers';

/** How far a model's mass may stray from its body's. A provisional model of a few
 *  linear shells comes within a few percent (Earth 0.4%, Ganymede 0.1%); the
 *  coarsest that pass today miss by 9–10%. A profile that cannot close misses by more. */
const MASS_TOLERANCE = 0.1;

/** m³ kg⁻¹ s⁻², CODATA 2018: turns a satellite's tracked GM into a mass. */
const GRAVITATIONAL_CONSTANT = 6.6743e-11;

/** GM in km³/s² for the modelled moons MASSES_KG does not list, from JPL Solar System
 *  Dynamics' planetary satellite physical parameters (ephemerides MAR097, JUP365,
 *  SAT441 — Jacobson 2022, AJ 164 — and NEP097). */
const SATELLITE_GM_KM3_S2: Readonly<Record<string, number>> = {
  Phobos: 0.0007087,
  Io: 5959.91547,
  Europa: 3202.7121,
  Ganymede: 9887.83275,
  Callisto: 7179.2834,
  Enceladus: 7.21037,
  Titan: 8978.1371,
  Triton: 1428.49546,
};

function bodyMassKg(bodyId: string): number | null {
  if (Object.prototype.hasOwnProperty.call(MASSES_KG, bodyId)) return MASSES_KG[bodyId];
  const gm = SATELLITE_GM_KM3_S2[bodyId];
  return gm === undefined ? null : (gm * 1e9) / GRAVITATIONAL_CONSTANT;
}

/** The models whose densities are not all known, and so cannot be weighed. */
const UNWEIGHED: readonly string[] = [
  'jupiter-dilute-core', // the dilute core's density is left unknown
  'jupiter-compact-core', // and so is the compact core's
];

/** Models known not to close on their body's mass, with what is wrong. */
const KNOWN_TO_MISS: Readonly<Record<string, string>> = {
  'sun-standard-model': 'The endpoints are the standard model\'s, but each region joins them by a straight line where the Sun\'s density falls about exponentially, sevenfold across the core and a hundredfold across the radiative zone: 2.4 Suns. The same endpoints joined on a log scale come to 0.95.',
  'neptune-layered': 'iceGiants.ts scales each layer\'s radius to the planet but gives Uranus and Neptune the same layer densities, so the two layered models share one mean density, 1347 kg/m³, where Neptune\'s is 1638: 0.82 of Neptune.',
  'neptune-fuzzy': 'As neptune-layered: the two fuzzy models share one mean density, 1386 kg/m³: 0.85 of Neptune.',
  'callisto-fully-differentiated': 'Its rock core (to 1400 km, 3200–3400 kg/m³) and ice mantle (1100–1300 kg/m³) together weigh 0.84 of Callisto.',
  'triton-ocean-illustrative': 'Illustrative, but its layers must still weigh Triton: with a rock core to 950 km at 3000–3200 kg/m³ under the ocean and ice, it weighs 0.82 of Triton.',
};

/** 4π∫ρr²dr over [innerKm, outerKm], ρ running from innerDensity to outerDensity by
 *  radius, linear or log. Simpson's rule: exact for a linear ramp (the integrand is a
 *  cubic), and far inside the tolerance for a log ramp at this many intervals. */
function shellMassKg(innerKm: number, outerKm: number, innerDensity: number, outerDensity: number, log: boolean): number {
  if (!(outerKm > innerKm)) return 0;
  const intervals = 256;
  const stepM = ((outerKm - innerKm) * 1000) / intervals;
  const integrand = (index: number): number => {
    const fraction = index / intervals;
    const density = log
      ? Math.exp(Math.log(innerDensity) + (Math.log(outerDensity) - Math.log(innerDensity)) * fraction)
      : innerDensity + (outerDensity - innerDensity) * fraction;
    const radiusM = (innerKm + (outerKm - innerKm) * fraction) * 1000;
    return 4 * Math.PI * radiusM * radiusM * density;
  };
  let sum = integrand(0) + integrand(intervals);
  for (let index = 1; index < intervals; index++) sum += (index % 2 === 1 ? 4 : 2) * integrand(index);
  return (sum * stepM) / 3;
}

/** The density at a radius, as the app reads a quantity (temperatureProfile.ts) but with
 *  no floor: endpoints ramp from the region's inner boundary to its outer, a profile runs
 *  between its samples and holds beyond them, and 'none' reads as linear. */
function densityAt(density: Exclude<Quantity, { kind: 'unknown' }>, radiusKm: number, regionInnerKm: number, regionOuterKm: number): number {
  const log = density.interpolation === 'log';
  const between = (from: number, to: number, fraction: number): number =>
    log ? Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * fraction) : from + (to - from) * fraction;
  if (density.kind === 'endpoints') {
    return between(density.inner.value, density.outer.value, (radiusKm - regionInnerKm) / (regionOuterKm - regionInnerKm));
  }
  const samples = density.samples;
  if (radiusKm <= samples[0].radiusKm) return samples[0].value;
  for (let index = 1; index < samples.length; index++) {
    const lower = samples[index - 1];
    const upper = samples[index];
    if (radiusKm <= upper.radiusKm) return between(lower.value, upper.value, (radiusKm - lower.radiusKm) / (upper.radiusKm - lower.radiusKm));
  }
  return samples[samples.length - 1].value;
}

/** The mass between two radii of a region, from its density; null when the density is
 *  unknown. Integrated piece by piece between the profile's samples, each piece one
 *  linear or log ramp (or a held value), so a piece is exact however the profile bends. */
function regionMassKg(density: Quantity, regionInnerKm: number, regionOuterKm: number, fromKm = regionInnerKm, toKm = regionOuterKm): number | null {
  if (density.kind === 'unknown' || (density.kind === 'profile' && density.samples.length === 0)) return null;
  const inside = density.kind === 'profile' ? density.samples.map((sample) => sample.radiusKm).filter((radiusKm) => radiusKm > fromKm && radiusKm < toKm) : [];
  const breaks = [fromKm, ...inside, toKm];
  const log = density.interpolation === 'log';
  let massKg = 0;
  for (let index = 1; index < breaks.length; index++) {
    const lower = breaks[index - 1];
    const upper = breaks[index];
    massKg += shellMassKg(lower, upper, densityAt(density, lower, regionInnerKm, regionOuterKm), densityAt(density, upper, regionInnerKm, regionOuterKm), log);
  }
  return massKg;
}

/** The model's mass, kg, or null when any region's density is unknown. */
function integratedMassKg(model: InteriorModel): number | null {
  let massKg = 0;
  let innerKm = 0;
  for (const region of model.regions) {
    const regionMass = regionMassKg(region.densityKgM3, innerKm, region.outerRadiusKm);
    if (regionMass === null) return null;
    massKg += regionMass;
    innerKm = region.outerRadiusKm;
  }
  return massKg;
}

/** Saturn's spin: Mankovich & Fuller's baseline period, from ring seismology, 10 h 33 m 38 s. */
const SATURN_SPIN_RAD_S = (2 * Math.PI) / (10 * 3600 + 33 * 60 + 38);

/** The hydrostatic pressure, GPa, at each of `radiiKm`, integrated down from `topKm` where it is
 *  `topGPa`: dP/dl = −ρ (G m/l² − ⅔ω²l) on level surfaces of mean radius l, to first order in the
 *  spin (the level-surface mean of the centrifugal pull is ⅔ω²l). Every density below `topKm` must be known. */
function hydrostaticPressureGPa(model: InteriorModel, radiiKm: readonly number[], topKm: number, topGPa: number, spinRadS: number): number[] {
  const steps = 200_000;
  const widthKm = topKm / steps;
  const density = new Float64Array(steps);
  const enclosedKg = new Float64Array(steps);
  let massKg = 0;
  let regionIndex = 0;
  for (let step = 0; step < steps; step++) {
    const radiusKm = (step + 0.5) * widthKm;
    while (model.regions[regionIndex].outerRadiusKm < radiusKm) regionIndex++;
    const region = model.regions[regionIndex];
    const quantity = region.densityKgM3;
    if (quantity.kind === 'unknown') throw new Error(`${model.modelId}/${region.key}: no density to balance`);
    density[step] = densityAt(quantity, radiusKm, regionIndex === 0 ? 0 : model.regions[regionIndex - 1].outerRadiusKm, region.outerRadiusKm);
    const shellKg = 4 * Math.PI * (radiusKm * 1000) ** 2 * density[step] * widthKm * 1000;
    enclosedKg[step] = massKg + shellKg / 2;
    massKg += shellKg;
  }
  const pressureAtEdgePa = new Float64Array(steps + 1);
  pressureAtEdgePa[steps] = topGPa * 1e9;
  for (let step = steps - 1; step >= 0; step--) {
    const radiusM = (step + 0.5) * widthKm * 1000;
    const gravity = (GRAVITATIONAL_CONSTANT * enclosedKg[step]) / (radiusM * radiusM) - (2 / 3) * spinRadS * spinRadS * radiusM;
    pressureAtEdgePa[step] = pressureAtEdgePa[step + 1] + density[step] * gravity * widthKm * 1000;
  }
  return radiiKm.map((radiusKm) => pressureAtEdgePa[Math.round(radiusKm / widthKm)] / 1e9);
}

function everyModel(): InteriorModel[] {
  return interiorBodyIds().flatMap((bodyId) => coverageModels(coverageFor(bodyId)));
}

/** A one-region sphere of radius 1000 km with the given density, from a shipped region's other fields. */
function sphere(density: Quantity): InteriorModel {
  const base = coverageModels(coverageFor('Earth'))[0];
  const region: Region = { ...base.regions[0], outerRadiusKm: 1000, densityKgM3: density };
  return { ...base, referenceRadiusKm: 1000, regions: [region] };
}

describe('mass closure', () => {
  it('integrates exactly: a uniform sphere, a linear ramp, the same ramp as a profile, a flat log ramp, a profile held past its samples or cut short', () => {
    const volumeM3 = (4 / 3) * Math.PI * 1e18; // a 1000 km sphere
    expect(integratedMassKg(sphere(endpoints(3000, 3000, 's', 'modelled')))! / (volumeM3 * 3000)).toBeCloseTo(1, 12);
    // ρ falling linearly from ρc at the centre to ρs at the surface: (4π/3)R³(ρc/4 + 3ρs/4).
    const rampKg = volumeM3 * (8000 / 4 + (3 * 2000) / 4);
    expect(integratedMassKg(sphere(endpoints(8000, 2000, 's', 'modelled')))! / rampKg).toBeCloseTo(1, 12);
    expect(integratedMassKg(sphere(profile([[0, 8000], [1000, 2000]], 's', 'modelled')))! / rampKg).toBeCloseTo(1, 12);
    expect(integratedMassKg(sphere(endpoints(3000, 3000, 's', 'modelled', 'log')))! / (volumeM3 * 3000)).toBeCloseTo(1, 12);
    // Samples only out to 500 km: the last is held to the surface, the region's whole volume weighed.
    const heldKg = (volumeM3 / 8) * (8000 / 4 + (3 * 2000) / 4) + (volumeM3 * 7 / 8) * 2000;
    expect(integratedMassKg(sphere(profile([[0, 8000], [500, 2000]], 's', 'modelled')))! / heldKg).toBeCloseTo(1, 12);
    // Weighed only to 500 km, the full ramp stops where it reads 5000: (4π/3)(R/2)³(8000/4 + 3·5000/4).
    const clippedKg = (volumeM3 / 8) * (8000 / 4 + (3 * 5000) / 4);
    expect(regionMassKg(profile([[0, 8000], [1000, 2000]], 's', 'modelled'), 0, 1000, 0, 500)! / clippedKg).toBeCloseTo(1, 12);
    expect(regionMassKg(endpoints(8000, 2000, 's', 'modelled'), 0, 1000, 0, 500)! / clippedKg).toBeCloseTo(1, 12);
    expect(integratedMassKg(sphere(UNKNOWN))).toBeNull();
  });

  it('passes over only the models it names, and has a measured mass for every body it weighs', () => {
    const unweighed = everyModel().filter((model) => integratedMassKg(model) === null).map((model) => model.modelId);
    expect(unweighed).toEqual(UNWEIGHED);
    for (const model of everyModel()) {
      if (integratedMassKg(model) === null) continue;
      expect(bodyMassKg(model.body), `${model.body} has a model to weigh but no measured mass here`).not.toBeNull();
    }
  });

  it(`brings every model with known densities within ${MASS_TOLERANCE * 100}% of its body's mass`, () => {
    const misses: string[] = [];
    for (const model of everyModel()) {
      const massKg = integratedMassKg(model);
      const bodyKg = bodyMassKg(model.body);
      if (massKg === null || bodyKg === null || model.modelId in KNOWN_TO_MISS) continue;
      const ratio = massKg / bodyKg;
      // Written so a mass that came out NaN counts as a miss, not a pass.
      if (!(Math.abs(ratio - 1) <= MASS_TOLERANCE)) misses.push(`${model.body}/${model.modelId}: ${massKg.toExponential(3)} kg is ${ratio.toFixed(3)} of ${bodyKg.toExponential(3)} kg`);
    }
    expect(misses).toEqual([]);
  });

  it('still finds every model it excuses outside the tolerance, so a fixed one comes off the list', () => {
    const modelIds = new Set(everyModel().map((model) => model.modelId));
    for (const [modelId, reason] of Object.entries(KNOWN_TO_MISS)) {
      expect(modelIds.has(modelId), `${modelId} is listed but no such model ships`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
      const model = everyModel().find((candidate) => candidate.modelId === modelId)!;
      const ratio = integratedMassKg(model)! / bodyMassKg(model.body)!;
      expect(Math.abs(ratio - 1), `${modelId} now closes (${ratio.toFixed(3)}): take it off KNOWN_TO_MISS`).toBeGreaterThan(MASS_TOLERANCE);
    }
  });

  it('weighs Saturn at its mass, and its diffuse core near the 55 Earth masses ring seismology finds inside 0.59 of the radius', () => {
    // Read off a figure of models fitted to Saturn's mass, the profile can miss it only by the
    // reading: about ±40 kg/m³, some 5% of the mass. Tighter than the general tolerance.
    const saturn = coverageModels(coverageFor('Saturn'))[0];
    expect(Math.abs(integratedMassKg(saturn)! / MASSES_KG.Saturn - 1)).toBeLessThan(0.07);
    // Mankovich & Fuller (2021): 55.1 ± 1.7 Earth masses inside r_out = 0.59 ± 0.01 of the radius.
    const core = saturn.regions[0];
    const earthMassKg = MASSES_KG.Earth;
    const insideRout = regionMassKg(core.densityKgM3, 0, core.outerRadiusKm, 0, 0.59 * saturn.referenceRadiusKm)! / earthMassKg;
    expect(insideRout).toBeGreaterThan(55.1 - 2 * 1.7);
    expect(insideRout).toBeLessThan(55.1 + 2 * 1.7);
  });

  it("holds Saturn's pressures within 5% of the hydrostatic balance of its own densities", () => {
    const saturn = coverageModels(coverageFor('Saturn'))[0];
    const atmosphere = saturn.regions[saturn.regions.length - 1];
    const envelope = saturn.regions[saturn.regions.length - 2];
    if (envelope.pressureGPa.kind !== 'endpoints' || atmosphere.pressureGPa.kind !== 'endpoints') throw new Error('Saturn\'s pressures are endpoints');
    // The envelope's top is the atmosphere's base: one pressure there, where the integral starts.
    const topGPa = envelope.pressureGPa.outer.value;
    expect(atmosphere.pressureGPa.inner.value).toBe(topGPa);
    const unbalanced: string[] = [];
    let innerKm = 0;
    for (const region of saturn.regions.slice(0, -1)) {
      const pressure = region.pressureGPa;
      if (pressure.kind !== 'endpoints') throw new Error(`Saturn/${region.key}: pressures are endpoints`);
      const [atInner, atOuter] = hydrostaticPressureGPa(saturn, [innerKm, region.outerRadiusKm], envelope.outerRadiusKm, topGPa, SATURN_SPIN_RAD_S);
      for (const [end, stated, balanced] of [['inner', pressure.inner.value, atInner], ['outer', pressure.outer.value, atOuter]] as const) {
        if (!(Math.abs(stated / balanced - 1) <= 0.05)) unbalanced.push(`${region.key} ${end}: ${stated} GPa stated, ${balanced.toFixed(1)} GPa holds the densities up`);
      }
      innerKm = region.outerRadiusKm;
    }
    expect(unbalanced).toEqual([]);
  });
});
