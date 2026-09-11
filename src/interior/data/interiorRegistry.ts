/**
 * The interior registry (plan §7, §9): body → coverage entry. Every catalog
 * body resolves here, in one of four states, so the picker can badge every
 * row and the tool can open on anything without a special case:
 *
 *   constrained       one model, its history alongside
 *   competing         named alternatives, one default, and the sentence that
 *                     says what would tell them apart
 *   poorlyConstrained the science itself is thin: a bulk density and what it
 *                     implies, an unresolved interior treatment, and, on
 *                     request only, a labelled illustrative scenario
 *   notYetModelled    this app has not authored the body yet, whatever the
 *                     science says. The plan's three states describe
 *                     knowledge; this fourth is about coverage, and exists so
 *                     the badge never calls Mercury "poorly known" because we
 *                     have not got to it. It carries the same bulk line, and
 *                     phase 3 retires entries from it one by one.
 *
 * Bulk densities are the one measurement every large body has: mass from
 * tracking, volume from the shape. They are authored here with their source
 * and rounded to what the source supports; a body whose mass is not usefully
 * measured carries null, and the note says so. Nothing here is a model.
 */
import { PLANETARIUM_BODIES } from '../../planetarium/planets/planetData';
import { MOONS } from '../../planetarium/planets/moonData';
import type { Coverage, CoverageState, InteriorModel, Sourced } from './interiorTypes';
import { coverageModels } from './interiorTypes';
import { sourced } from './modelHelpers';
import { EARTH_MODEL } from './models/earth';
import { MOON_MODEL } from './models/moon';
import { EUROPA_MODEL } from './models/europa';
import { JUPITER_COMPACT_MODEL, JUPITER_DILUTE_MODEL, JUPITER_DISTINGUISHED_BY } from './models/jupiter';
import { MARS_BASAL_LAYER_MODEL, MARS_DISTINGUISHED_BY, MARS_LIQUID_CORE_MODEL } from './models/mars';
import { PHOBOS_BULK, PHOBOS_ILLUSTRATIVE_MODEL } from './models/phobos';

export const INTERIOR_DEFAULT_BODY = 'Earth';

const FACT_SHEET = 'Williams, NASA Planetary Fact Sheets (NASA GSFC), bulk parameters';
const JPL_SATELLITES = 'JPL Solar System Dynamics, planetary satellite physical parameters (Jacobson et al.)';
const THOMAS_2010 = 'Thomas (2010), Icarus 208, sizes, shapes, and derived properties of the saturnian satellites after the Cassini nominal mission';
const ANDERSON_2005 = 'Anderson et al. (2005), Science 308, Amalthea\'s density is less than that of water';
const STERN_2015 = 'Stern et al. (2015), Science 350, the Pluto system: initial results from its exploration by New Horizons';

interface BulkLine {
  densityKgM3: number | null;
  source: string;
  /** What the density says about the inside, in one or two sentences. */
  note: string;
}

/** Bulk densities for bodies without a model here, kg/m³, and the one-line reading of each. */
const BULK: Readonly<Record<string, BulkLine>> = {
  Mercury: { densityKgM3: 5429, source: FACT_SHEET, note: 'Nearly as dense as Earth in a body a third the size, so most of Mercury is metal: a core reaching about 85% of the radius, found liquid by MESSENGER\'s spin and gravity measurements. Not yet modelled here.' },
  Venus: { densityKgM3: 5243, source: FACT_SHEET, note: 'Earth\'s density in Earth\'s size, so a similar iron core and silicate mantle are expected; no seismometer has run on Venus, and its core\'s state is not measured. Not yet modelled here.' },
  Saturn: { densityKgM3: 687, source: FACT_SHEET, note: 'Lighter than water: hydrogen and helium nearly all the way down, over a core that Cassini\'s ring seismology found to be large and diffuse. Not yet modelled here.' },
  Uranus: { densityKgM3: 1270, source: FACT_SHEET, note: 'Too dense for a hydrogen world, too light for rock: a deep layer of water, ammonia and methane fluids, with the proportions of rock and ice inside still open. Not yet modelled here.' },
  Neptune: { densityKgM3: 1638, source: FACT_SHEET, note: 'Denser than Uranus in almost the same size, so more rock and ice inside; the same open question about how they are arranged. Not yet modelled here.' },
  Pluto: { densityKgM3: 1854, source: STERN_2015, note: 'About two-thirds rock by mass under a thick water-ice shell, from New Horizons\' mass and size; a subsurface ocean is argued from the geology. Not yet modelled here.' },
  Deimos: { densityKgM3: 1470, source: JPL_SATELLITES, note: 'A density near Phobos\'s, measured to about ±13%, from Viking and Mars Express flybys. Like Phobos, probably porous; no measurement reaches its interior.' },
  Amalthea: { densityKgM3: 857, source: ANDERSON_2005, note: 'Less dense than water, from Galileo\'s final flyby: a loose pile of ice and rock with much empty space. No measurement reaches its interior.' },
  Io: { densityKgM3: 3528, source: JPL_SATELLITES, note: 'The densest moon in the solar system, rock and iron throughout; Galileo\'s gravity found a metal core, and the tides that power its volcanoes keep the mantle partly molten. Not yet modelled here.' },
  Ganymede: { densityKgM3: 1942, source: JPL_SATELLITES, note: 'Half rock and half ice by mass, fully separated into an iron core (it has its own magnetic field), a rock mantle and thick ice, with a salty ocean inside the ice. Not yet modelled here.' },
  Callisto: { densityKgM3: 1834, source: JPL_SATELLITES, note: 'A rock-and-ice mix that Galileo\'s gravity found only partly separated, with an induced magnetic field pointing to an ocean under the ice. Not yet modelled here.' },
  Himalia: { densityKgM3: null, source: JPL_SATELLITES, note: 'A captured irregular moon; its mass is only roughly known, so the density is not a useful number. No measurement reaches its interior.' },
  Mimas: { densityKgM3: 1149, source: THOMAS_2010, note: 'Mostly water ice with some rock; its wobble, measured by Cassini, argues for an ocean or an oddly shaped core. Not yet modelled here.' },
  Enceladus: { densityKgM3: 1609, source: THOMAS_2010, note: 'Rock and ice; Cassini\'s gravity and libration found a global ocean under the ice shell, feeding the plumes at the south pole. Not yet modelled here.' },
  Tethys: { densityKgM3: 984, source: THOMAS_2010, note: 'Almost pure water ice, lighter than liquid water, so nearly no rock inside. No measurement reaches its interior.' },
  Dione: { densityKgM3: 1478, source: THOMAS_2010, note: 'Ice with a rock fraction near half by mass; Cassini\'s gravity hints at an ocean, unconfirmed. No measurement reaches its interior.' },
  Rhea: { densityKgM3: 1237, source: THOMAS_2010, note: 'About three-quarters ice by mass; Cassini\'s gravity suggests the rock and ice are only partly separated. No measurement reaches its interior.' },
  Titan: { densityKgM3: 1882, source: JPL_SATELLITES, note: 'Rock and ice about equal by mass; Cassini\'s tides and gravity found a liquid layer under the ice, read as a global salty ocean, over a mantle of high-pressure ice and rock. Not yet modelled here.' },
  Hyperion: { densityKgM3: 544, source: THOMAS_2010, note: 'Half the density of water: a sponge of ice with about half its volume empty, seen in Cassini\'s images. No measurement reaches its interior.' },
  Iapetus: { densityKgM3: 1088, source: THOMAS_2010, note: 'Mostly ice with a little rock; its shape froze when it spun far faster than it does now. No measurement reaches its interior.' },
  Phoebe: { densityKgM3: 1638, source: THOMAS_2010, note: 'Denser than Saturn\'s regular moons and darker: a captured body from the outer solar system, rock and ice, possibly once warm enough to settle. No measurement reaches its interior.' },
  Miranda: { densityKgM3: 1200, source: JPL_SATELLITES, note: 'Ice with some rock, its density known only to about ±15% from Voyager 2. The surface says it was once heated hard; the inside is unmeasured.' },
  Ariel: { densityKgM3: 1660, source: JPL_SATELLITES, note: 'Roughly half rock, half ice by mass, from Voyager 2\'s tracking; a young surface, an interior nobody has measured.' },
  Umbriel: { densityKgM3: 1390, source: JPL_SATELLITES, note: 'Ice and rock, from Voyager 2\'s tracking; the darkest of Uranus\'s large moons, and unmeasured inside.' },
  Titania: { densityKgM3: 1710, source: JPL_SATELLITES, note: 'About half rock by mass, from Voyager 2\'s tracking; models allow an ocean if there is enough ammonia, nothing confirms one.' },
  Oberon: { densityKgM3: 1630, source: JPL_SATELLITES, note: 'Rock and ice in similar shares, from Voyager 2\'s tracking; no measurement reaches its interior.' },
  Proteus: { densityKgM3: null, source: JPL_SATELLITES, note: 'Its mass is poorly known, so the density is not a useful number. Irregular in shape; no measurement reaches its interior.' },
  Triton: { densityKgM3: 2061, source: JPL_SATELLITES, note: 'Two-thirds rock by mass under ice, from Voyager 2; a captured world whose geology suggests an ocean kept warm by tides and decay. Not yet modelled here.' },
  Nereid: { densityKgM3: null, source: JPL_SATELLITES, note: 'Its mass has not been measured, so nothing is known of its interior.' },
  Charon: { densityKgM3: 1702, source: STERN_2015, note: 'More ice than Pluto and less rock, from New Horizons; the surface records an ancient ocean freezing and cracking the crust. Not yet modelled here.' },
};

const UNMEASURED_NOTE = 'Too small for a measured mass, so not even a density is known; nothing about the inside is measured.';

function bulkLine(bodyId: string): { densityKgM3: Sourced<number> | null; note: string } {
  const line = BULK[bodyId];
  if (!line) return { densityKgM3: null, note: UNMEASURED_NOTE };
  return {
    densityKgM3: line.densityKgM3 === null ? null : sourced(line.densityKgM3, line.source, 'measured'),
    note: line.note,
  };
}

/** The bodies the app has authored, keyed by catalog name. */
const AUTHORED: Readonly<Record<string, Coverage>> = {
  Earth: {
    state: 'constrained',
    model: EARTH_MODEL,
    history: [
      { modelId: 'earth-prem', status: 'current', note: 'The Preliminary Reference Earth Model radii, with the modern temperature profile.', year: 1981 },
      { modelId: 'earth-jeffreys-bullen', status: 'superseded', note: 'The Jeffreys–Bullen layered Earth of the 1940s: the same shells, less precise boundaries, no solid inner core until Lehmann\'s discovery was accepted.', year: 1940 },
    ],
  },
  Moon: {
    state: 'constrained',
    model: MOON_MODEL,
    history: [
      { modelId: 'moon-apollo-grail', status: 'current', note: 'The Apollo seismic reanalysis of 2011 with GRAIL\'s crust and the 2023 inner-core argument.', year: 2011 },
      { modelId: 'moon-undifferentiated', status: 'superseded', note: 'Before Apollo, a cold, undifferentiated Moon was a live possibility; the samples and the seismometers ended it.', year: 1969 },
    ],
  },
  Europa: {
    state: 'constrained',
    model: EUROPA_MODEL,
    history: [
      { modelId: 'europa-galileo', status: 'current', note: 'Galileo\'s induced magnetic field and gravity: ice, ocean, rock, iron.', year: 2000 },
      { modelId: 'europa-thick-ice', status: 'disfavoured', note: 'An ice layer solid to the rock, with the surface features made by warm ice rather than liquid: geology allowed it, the induced field did not.', year: 1998 },
    ],
  },
  Jupiter: {
    state: 'competing',
    models: [JUPITER_DILUTE_MODEL, JUPITER_COMPACT_MODEL],
    defaultModelId: JUPITER_DILUTE_MODEL.modelId,
    distinguishedBy: JUPITER_DISTINGUISHED_BY,
    history: [
      { modelId: 'jupiter-dilute-core', status: 'current', note: 'Juno\'s gravity field, best fit by heavy elements spread through nearly half the radius.', year: 2017 },
      { modelId: 'jupiter-compact-core', status: 'current', note: 'The classical compact core; not excluded, and the default picture before Juno.', year: 2004 },
    ],
  },
  Mars: {
    state: 'competing',
    models: [MARS_LIQUID_CORE_MODEL, MARS_BASAL_LAYER_MODEL],
    defaultModelId: MARS_LIQUID_CORE_MODEL.modelId,
    distinguishedBy: MARS_DISTINGUISHED_BY,
    history: [
      { modelId: 'mars-large-liquid-core', status: 'current', note: 'InSight\'s first core detection: a large, light liquid core.', year: 2021 },
      { modelId: 'mars-basal-molten-layer', status: 'current', note: 'The 2023 reanalysis: a smaller core under a molten silicate layer.', year: 2023 },
      { modelId: 'mars-solid-inner-core', status: 'disfavoured', note: 'A 2025 report of a solid inner core from InSight\'s later records awaits independent confirmation and is not drawn.', year: 2025 },
    ],
  },
  Phobos: {
    state: 'poorlyConstrained',
    bulk: PHOBOS_BULK,
    illustrative: PHOBOS_ILLUSTRATIVE_MODEL,
    history: [
      { modelId: 'phobos-rubble-pile-illustrative', status: 'current', note: 'One way a body this light could be built; illustrative, never measured.', year: 2010 },
    ],
  },
};

const CATALOG_BODY_IDS: readonly string[] = [
  ...PLANETARIUM_BODIES.map((planet) => planet.name),
  ...MOONS.map((moon) => moon.name),
];

/** Every body the registry answers for: the planets, Pluto and the catalog moons. */
export function interiorBodyIds(): readonly string[] {
  return CATALOG_BODY_IDS;
}

/** The coverage entry for a catalog body: authored where it is, otherwise the not-yet-modelled entry with its bulk line. */
export function coverageFor(bodyId: string): Coverage {
  const authored = AUTHORED[bodyId];
  if (authored) return authored;
  return { state: 'notYetModelled', bulk: bulkLine(bodyId), history: [] };
}

export function coverageStateFor(bodyId: string): CoverageState {
  return coverageFor(bodyId).state;
}

/** The model drawn by default, or null for a body drawn as an unresolved whole. */
export function defaultModelFor(bodyId: string): InteriorModel | null {
  const coverage = coverageFor(bodyId);
  if (coverage.state === 'poorlyConstrained' || coverage.state === 'notYetModelled') return null;
  return coverageModels(coverage)[0] ?? null;
}

/** A named model of a body, whichever state carries it, or null. */
export function modelFor(bodyId: string, modelId: string): InteriorModel | null {
  return coverageModels(coverageFor(bodyId)).find((model) => model.modelId === modelId) ?? null;
}

/**
 * Whether another model of the body draws a region differently or not at
 * all (the rubric's competingTopology context): true when any other model
 * lacks a region with this key, or places its outer boundary more than 1%
 * of the reference radius away.
 */
export function competingTopology(coverage: Coverage, modelId: string, regionKey: string): boolean {
  if (coverage.state !== 'competing') return false;
  const own = coverage.models.find((model) => model.modelId === modelId);
  const ownRegion = own?.regions.find((region) => region.key === regionKey);
  if (!own || !ownRegion) return false;
  return coverage.models.some((other) => {
    if (other.modelId === modelId) return false;
    const match = other.regions.find((region) => region.key === regionKey);
    if (!match) return true;
    return Math.abs(match.outerRadiusKm - ownRegion.outerRadiusKm) > 0.01 * own.referenceRadiusKm;
  });
}

/** The picker's badge word for a coverage state. */
export const COVERAGE_BADGE: Readonly<Record<CoverageState, string>> = {
  constrained: 'modelled',
  competing: 'two models',
  poorlyConstrained: 'poorly known',
  notYetModelled: 'not yet',
};
