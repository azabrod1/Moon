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
import { TITAN_DISTINGUISHED_BY, TITAN_OCEAN_MODEL, TITAN_SLUSH_MODEL } from './models/titan';
import { MERCURY_DISTINGUISHED_BY, MERCURY_INNER_CORE_MODEL, MERCURY_LIQUID_CORE_MODEL } from './models/mercury';
import { VENUS_MODEL } from './models/venus';
import { IO_MODEL } from './models/io';
import { GANYMEDE_MODEL } from './models/ganymede';
import { CALLISTO_DIFFERENTIATED_MODEL, CALLISTO_DISTINGUISHED_BY, CALLISTO_PARTIAL_MODEL } from './models/callisto';
import { ENCELADUS_MODEL } from './models/enceladus';
import { SATURN_MODEL } from './models/saturn';
import { ICE_GIANT_DISTINGUISHED_BY, NEPTUNE_FUZZY_MODEL, NEPTUNE_LAYERED_MODEL, URANUS_FUZZY_MODEL, URANUS_LAYERED_MODEL } from './models/iceGiants';
import { PLUTO_DISTINGUISHED_BY, PLUTO_FROZEN_MODEL, PLUTO_OCEAN_MODEL } from './models/pluto';
import { TRITON_BULK, TRITON_ILLUSTRATIVE_MODEL } from './models/triton';
import { SUN_MODEL } from './models/sun';

export const INTERIOR_DEFAULT_BODY = 'Earth';

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
  Deimos: { densityKgM3: 1470, source: JPL_SATELLITES, note: 'A density near Phobos\'s, measured to about ±13%, from Viking and Mars Express flybys. Like Phobos, probably porous; no measurement reaches its interior.' },
  Amalthea: { densityKgM3: 857, source: ANDERSON_2005, note: 'Less dense than water, from Galileo\'s final flyby: a loose pile of ice and rock with much empty space. No measurement reaches its interior.' },
  Himalia: { densityKgM3: null, source: JPL_SATELLITES, note: 'A captured irregular moon; its mass is only roughly known, so the density is not a useful number. No measurement reaches its interior.' },
  Mimas: { densityKgM3: 1149, source: THOMAS_2010, note: 'Mostly water ice with some rock; its wobble, measured by Cassini, argues for an ocean or an oddly shaped core. Not yet modelled here.' },
  Tethys: { densityKgM3: 984, source: THOMAS_2010, note: 'Almost pure water ice, lighter than liquid water, so nearly no rock inside. No measurement reaches its interior.' },
  Dione: { densityKgM3: 1478, source: THOMAS_2010, note: 'Ice with a rock fraction near half by mass; Cassini\'s gravity hints at an ocean, unconfirmed. No measurement reaches its interior.' },
  Rhea: { densityKgM3: 1237, source: THOMAS_2010, note: 'About three-quarters ice by mass; Cassini\'s gravity suggests the rock and ice are only partly separated. No measurement reaches its interior.' },
  Hyperion: { densityKgM3: 544, source: THOMAS_2010, note: 'Half the density of water: a sponge of ice with about half its volume empty, seen in Cassini\'s images. No measurement reaches its interior.' },
  Iapetus: { densityKgM3: 1088, source: THOMAS_2010, note: 'Mostly ice with a little rock; its shape froze when it spun far faster than it does now. No measurement reaches its interior.' },
  Phoebe: { densityKgM3: 1638, source: THOMAS_2010, note: 'Denser than Saturn\'s regular moons and darker: a captured body from the outer solar system, rock and ice, possibly once warm enough to settle. No measurement reaches its interior.' },
  Miranda: { densityKgM3: 1200, source: JPL_SATELLITES, note: 'Ice with some rock, its density known only to about ±15% from Voyager 2. The surface says it was once heated hard; the inside is unmeasured.' },
  Ariel: { densityKgM3: 1660, source: JPL_SATELLITES, note: 'Roughly half rock, half ice by mass, from Voyager 2\'s tracking; a young surface, an interior nobody has measured.' },
  Umbriel: { densityKgM3: 1390, source: JPL_SATELLITES, note: 'Ice and rock, from Voyager 2\'s tracking; the darkest of Uranus\'s large moons, and unmeasured inside.' },
  Titania: { densityKgM3: 1710, source: JPL_SATELLITES, note: 'About half rock by mass, from Voyager 2\'s tracking; models allow an ocean if there is enough ammonia, nothing confirms one.' },
  Oberon: { densityKgM3: 1630, source: JPL_SATELLITES, note: 'Rock and ice in similar shares, from Voyager 2\'s tracking; no measurement reaches its interior.' },
  Proteus: { densityKgM3: null, source: JPL_SATELLITES, note: 'Its mass is poorly known, so the density is not a useful number. Irregular in shape; no measurement reaches its interior.' },
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
  Sun: {
    state: 'constrained',
    model: SUN_MODEL,
    history: [
      { modelId: 'sun-standard-model', status: 'current', note: 'The standard solar model, checked by helioseismology to a fraction of a percent and by the full neutrino flux since 2002.', year: 2005 },
      { modelId: 'sun-solar-neutrino-problem', status: 'superseded', note: 'From 1968 to 2002 the core seemed to make a third of the neutrinos it should; the neutrinos were changing flavour, and the model stood.', year: 1968 },
    ],
  },
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
  Mercury: {
    state: 'competing',
    models: [MERCURY_LIQUID_CORE_MODEL, MERCURY_INNER_CORE_MODEL],
    defaultModelId: MERCURY_LIQUID_CORE_MODEL.modelId,
    distinguishedBy: MERCURY_DISTINGUISHED_BY,
    history: [
      { modelId: 'mercury-liquid-core', status: 'current', note: 'The libration of 2007 and MESSENGER\'s gravity: a liquid core to 85% of the radius.', year: 2012 },
      { modelId: 'mercury-solid-inner-core', status: 'current', note: 'A solid iron centre argued from gravity with the spin state in 2019; not excluded, not confirmed.', year: 2019 },
      { modelId: 'mercury-solid-throughout', status: 'superseded', note: 'Before the libration was measured, a core frozen solid was the expectation for so small a planet.', year: 2000 },
    ],
  },
  Venus: {
    state: 'constrained',
    model: VENUS_MODEL,
    history: [
      { modelId: 'venus-radar-moi', status: 'current', note: 'The 2021 radar measurement of the moment of inertia with Magellan\'s tidal Love number.', year: 2021 },
      { modelId: 'venus-earth-analogue', status: 'superseded', note: 'Until 2021 the core size was pure analogy with Earth, scaled by density.', year: 1996 },
    ],
  },
  Io: {
    state: 'constrained',
    model: IO_MODEL,
    history: [
      { modelId: 'io-galileo-juno', status: 'current', note: 'Galileo\'s gravity for the core, Juno\'s tides for a mostly solid mantle.', year: 2024 },
      { modelId: 'io-shallow-magma-ocean', status: 'disfavoured', note: 'A global magma ocean tens of km down, read from Galileo\'s induced field in 2011; Juno\'s tidal Love number in 2024 says the mantle is too stiff for one.', year: 2011 },
    ],
  },
  Ganymede: {
    state: 'constrained',
    model: GANYMEDE_MODEL,
    history: [
      { modelId: 'ganymede-galileo-hubble', status: 'current', note: 'Galileo\'s gravity and intrinsic field, Hubble\'s auroral rocking for the ocean.', year: 2015 },
    ],
  },
  Callisto: {
    state: 'competing',
    models: [CALLISTO_PARTIAL_MODEL, CALLISTO_DIFFERENTIATED_MODEL],
    defaultModelId: CALLISTO_PARTIAL_MODEL.modelId,
    distinguishedBy: CALLISTO_DISTINGUISHED_BY,
    history: [
      { modelId: 'callisto-partially-differentiated', status: 'current', note: 'Galileo\'s moment of inertia read with a hydrostatic Callisto.', year: 2001 },
      { modelId: 'callisto-fully-differentiated', status: 'current', note: 'The same gravity without the hydrostatic assumption allows a rock core.', year: 2013 },
    ],
  },
  Enceladus: {
    state: 'constrained',
    model: ENCELADUS_MODEL,
    history: [
      { modelId: 'enceladus-cassini', status: 'current', note: 'Cassini\'s gravity, the measured libration and the plume\'s chemistry.', year: 2016 },
      { modelId: 'enceladus-regional-sea', status: 'superseded', note: 'Gravity alone (2014) needed only a sea under the south pole; the libration made it global.', year: 2014 },
    ],
  },
  Saturn: {
    state: 'constrained',
    model: SATURN_MODEL,
    history: [
      { modelId: 'saturn-diffuse-core', status: 'current', note: 'Ring seismology (2021) and the Grand Finale gravity: a diffuse, stably stratified core to 60% of the radius.', year: 2021 },
      { modelId: 'saturn-compact-core', status: 'superseded', note: 'A compact rock-ice core of 10–20 Earth masses, the picture before the rings were read as a seismograph.', year: 2010 },
    ],
  },
  Uranus: {
    state: 'competing',
    models: [URANUS_LAYERED_MODEL, URANUS_FUZZY_MODEL],
    defaultModelId: URANUS_LAYERED_MODEL.modelId,
    distinguishedBy: ICE_GIANT_DISTINGUISHED_BY,
    history: [
      { modelId: 'uranus-layered', status: 'current', note: 'The three-layer fit to Voyager 2\'s flyby.', year: 2011 },
      { modelId: 'uranus-fuzzy', status: 'current', note: 'Composition gradients with no distinct layers fit the same data.', year: 2020 },
    ],
  },
  Neptune: {
    state: 'competing',
    models: [NEPTUNE_LAYERED_MODEL, NEPTUNE_FUZZY_MODEL],
    defaultModelId: NEPTUNE_LAYERED_MODEL.modelId,
    distinguishedBy: ICE_GIANT_DISTINGUISHED_BY,
    history: [
      { modelId: 'neptune-layered', status: 'current', note: 'The three-layer fit to Voyager 2\'s flyby, with Neptune\'s real internal heat.', year: 2011 },
      { modelId: 'neptune-fuzzy', status: 'current', note: 'Composition gradients with no distinct layers fit the same data.', year: 2020 },
      { modelId: 'neptune-diamond-rain', status: 'current', note: 'A hypothesis, not a region: methane at these depths can split into carbon, and the laboratory has made diamond under Neptune\'s conditions (Kraus 2017); whether diamonds fall inside Neptune is unobserved.', year: 2017 },
    ],
  },
  Pluto: {
    state: 'competing',
    models: [PLUTO_OCEAN_MODEL, PLUTO_FROZEN_MODEL],
    defaultModelId: PLUTO_OCEAN_MODEL.modelId,
    distinguishedBy: PLUTO_DISTINGUISHED_BY,
    history: [
      { modelId: 'pluto-ocean', status: 'current', note: 'Sputnik Planitia\'s position read as an ocean beneath (2016), kept liquid under a hydrate lid (2019).', year: 2016 },
      { modelId: 'pluto-frozen', status: 'current', note: 'Nitrogen loading alone reorients Pluto; no ocean needed.', year: 2016 },
    ],
  },
  Triton: {
    state: 'poorlyConstrained',
    bulk: TRITON_BULK,
    illustrative: TRITON_ILLUSTRATIVE_MODEL,
    history: [
      { modelId: 'triton-ocean-illustrative', status: 'current', note: 'A rock core, an ocean warmed by obliquity tides and decay, an ice shell: what models argue for; illustrative, never measured.', year: 2015 },
    ],
  },
  Titan: {
    state: 'competing',
    models: [TITAN_OCEAN_MODEL, TITAN_SLUSH_MODEL],
    defaultModelId: TITAN_OCEAN_MODEL.modelId,
    distinguishedBy: TITAN_DISTINGUISHED_BY,
    history: [
      { modelId: 'titan-global-ocean', status: 'current', note: 'Cassini\'s tidal Love number (2012) read as a global ocean.', year: 2012 },
      { modelId: 'titan-slush-no-ocean', status: 'current', note: 'A reported 2025 reanalysis with a warm ice mantle and melt pockets; entered as reported, awaiting review.', year: 2025 },
    ],
  },
};

const CATALOG_BODY_IDS: readonly string[] = [
  'Sun',
  ...PLANETARIUM_BODIES.map((planet) => planet.name),
  ...MOONS.map((moon) => moon.name),
];

/** Every body the registry answers for: the Sun, the planets, Pluto and the catalog moons. */
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

const COUNT_WORD: readonly string[] = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];

/** The picker's badge for a coverage entry: a competing entry counts its models. */
export function coverageBadge(coverage: Coverage): string {
  switch (coverage.state) {
    case 'constrained':
      return 'modelled';
    case 'competing': {
      const count = coverage.models.length;
      return `${COUNT_WORD[count] ?? String(count)} models`;
    }
    case 'poorlyConstrained':
      return 'little known';
    case 'notYetModelled':
      return 'no model yet';
  }
}
