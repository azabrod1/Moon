/**
 * Titan — the schema's topology test. Model A: the Cassini picture, a global
 * ocean between an ice shell and high-pressure ice over a rock core, from
 * the tidal Love number. Model B: the reported 2025 reinterpretation of the
 * same measurements, a warm ice mantle with pockets of melt and no global
 * ocean, awaiting review. Both fit the tides; both are drawn. PROVISIONAL.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, qualitative, row, sharp, sourced } from '../modelHelpers';

const IESS_2012 = 'Iess et al. (2012), Science 337, the tides of Titan';
const IESS_2010 = 'Iess et al. (2010), Science 327, gravity field, shape, and moment of inertia of Titan';
const BALAND = 'Baland et al. (2014), Icarus 237, Titan\'s internal structure inferred from its gravity field, shape, and rotation state';
const NIMMO_BILLS = 'Nimmo & Bills (2010), Icarus 208, shell thickness variations and the long-wavelength topography of Titan';
const FORTES = 'Fortes (2012), PSS 60, Titan\'s internal structure and the evolutionary consequences';
const CASTILLO = 'Castillo-Rogez & Lunine (2010), GRL 37, evolution of Titan\'s rocky core constrained by Cassini observations';
const HUYGENS = 'Fulchignoni et al. (2005), Nature 438, in situ measurements of the physical characteristics of Titan\'s environment (Huygens)';
const REANALYSIS_2025 = 'Reported 2025 reanalysis of Cassini\'s tidal and gravity measurements (awaiting peer review; entered here as reported)';
const MEAN_RADIUS = 2574.7;

const CORE: Region = {
  key: 'core',
  name: 'Rock core',
  family: 'silicate',
  phase: 'solid',
  outerRadiusKm: 2100,
  boundary: sharp(modelSpread(2000, 2150, ['Castillo-Rogez & Lunine 2010', 'Baland 2014'])),
  composition: sourced('Hydrated silicate rock, perhaps never fully dried out', CASTILLO, 'modelled'),
  temperatureK: endpoints(1000, 400, CASTILLO, 'modelled'),
  pressureGPa: endpoints(5, 1.5, FORTES, 'modelled'),
  densityKgM3: endpoints(2600, 2500, IESS_2010, 'modelled'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium in the rock; the core stayed cool enough to keep its water of hydration.' }], null, 'conduction'),
  claims: [
    claim('existence', [
      row('momentOfInertia', 'supports', IESS_2010, { observed: 'Cassini flybys give a moment of inertia of about 0.34', inferred: 'Only partly separated: rock concentrated toward the centre, but not a dense iron core', assumed: 'Hydrostatic equilibrium', uncertain: 'How much ice stays mixed into the rock', mission: 'Cassini', year: 2010 }),
      row('density', 'supports', IESS_2010, { observed: 'Bulk density 1880 kg/m³', inferred: 'Roughly half rock, half ice by mass', assumed: '—', uncertain: '—', mission: 'Cassini', year: 2010 }),
    ]),
  ],
};

const HIGH_PRESSURE_ICE: Region = {
  key: 'highPressureIce',
  name: 'High-pressure ice',
  family: 'ice',
  phase: 'solid',
  outerRadiusKm: 2400,
  boundary: sharp(modelSpread(2350, 2450, ['Fortes 2012', 'Baland 2014'])),
  composition: sourced('Dense ice phases (ice VI and V) that form above about 0.6 GPa', FORTES, 'modelled'),
  temperatureK: endpoints(400, 270, FORTES, 'modelled'),
  pressureGPa: endpoints(1.5, 0.6, FORTES, 'modelled'),
  densityKgM3: endpoints(1350, 1250, FORTES, 'modelled'),
  heat: heat([{ kind: 'none', note: 'Carries heat from the core toward the ocean.' }], 'heat from the rock core', 'convection'),
  claims: [
    claim('existence', [
      row('model', 'supports', FORTES, { observed: 'The pressure at the base of a Titan-sized water layer exceeds ice VI\'s stability field', inferred: 'Water below the ocean must be dense ice, not liquid', assumed: 'A water layer several hundred km thick', uncertain: 'Its thickness trades against the core size', year: 2012 }),
      row('momentOfInertia', 'constrains', IESS_2010, { observed: 'Moment of inertia', inferred: 'Consistent with a thick water layer over rock', assumed: 'Hydrostatic equilibrium', uncertain: 'Cannot see the ice phases', mission: 'Cassini', year: 2010 }),
    ]),
  ],
};

const OCEAN: Region = {
  key: 'ocean',
  name: 'Ocean',
  family: 'water',
  phase: 'liquid',
  outerRadiusKm: 2500,
  boundary: distributed(3, NIMMO_BILLS, modelSpread(2475, 2525, ['shell 50 km', 'shell 100 km'])),
  composition: sourced('Salty water, probably with ammonia as antifreeze', FORTES, 'modelled'),
  temperatureK: endpoints(270, 255, FORTES, 'modelled'),
  pressureGPa: endpoints(0.6, 0.1, FORTES, 'modelled'),
  densityKgM3: endpoints(1150, 1050, FORTES, 'modelled'),
  heat: heat([{ kind: 'tidal', note: 'Saturn\'s tides flex Titan on its 16-day orbit.' }], 'heat from below', 'convection'),
  claims: [
    claim('existence', [
      row('tides', 'supports', IESS_2012, { observed: 'Cassini measured Titan\'s gravity changing over its orbit: a tidal Love number k₂ of about 0.6', inferred: 'Titan deforms far more than a solid body would: a global liquid layer decouples the shell', assumed: 'The deformation is elastic and the shell is thin enough to flex', uncertain: 'A partly molten or very soft interior could mimic some of it', mission: 'Cassini', year: 2012 }),
      row('libration', 'supports', BALAND, { observed: 'Titan\'s obliquity and spin state', inferred: 'Best fit when the shell is decoupled from the interior by a liquid layer', assumed: 'A Cassini state', uncertain: 'Model-dependent', mission: 'Cassini', year: 2014 }),
      row('model', 'challenges', REANALYSIS_2025, { observed: 'A reanalysis of the same tidal data', inferred: 'The response can be fit by a warm ice mantle with melt pockets and no global ocean', assumed: 'A different rheology for the ice', uncertain: 'Reported, not yet reviewed', year: 2025 }),
    ]),
    claim('state', [
      row('tides', 'supports', IESS_2012, { observed: 'The size of the tidal response', inferred: 'Liquid', assumed: 'As above', uncertain: 'As above', mission: 'Cassini', year: 2012 }),
    ]),
  ],
};

const ICE_SHELL: Region = {
  key: 'iceShell',
  name: 'Ice shell',
  family: 'ice',
  phase: 'solid',
  outerRadiusKm: MEAN_RADIUS,
  boundary: sharp(),
  composition: sourced('Water ice under an organic haze and hydrocarbon seas', HUYGENS, 'measured'),
  temperatureK: endpoints(255, 94, HUYGENS, 'inferred'),
  pressureGPa: endpoints(0.1, 0, FORTES, 'modelled'),
  densityKgM3: endpoints(950, 930, FORTES, 'modelled'),
  heat: heat([{ kind: 'tidal', note: 'Some tidal flexing warms the shell.' }], 'heat from the ocean below', 'conduction'),
  claims: [
    claim('existence', [
      row('inSitu', 'supports', HUYGENS, { observed: 'Huygens landed on a damp, icy plain at 94 K', inferred: 'A water-ice crust', assumed: '—', uncertain: '—', mission: 'Cassini–Huygens', year: 2005 }),
    ]),
    claim('extent', [
      row('gravity', 'constrains', NIMMO_BILLS, { observed: 'Topography and gravity together', inferred: 'A shell of variable thickness, perhaps 50–150 km', assumed: 'Isostasy', uncertain: 'The mean thickness', mission: 'Cassini', year: 2010 }),
    ]),
  ],
};

export const TITAN_OCEAN_MODEL: InteriorModel = {
  body: 'Titan',
  modelId: 'titan-global-ocean',
  title: 'Global ocean',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'An ice shell over a global salty ocean, on dense high-pressure ice, on a rock core that never fully dried out: the picture Cassini\'s tides gave.',
  regions: [CORE, HIGH_PRESSURE_ICE, OCEAN, ICE_SHELL],
  annotations: [],
  sources: [IESS_2012, IESS_2010, BALAND, NIMMO_BILLS, FORTES, CASTILLO, HUYGENS],
};

const WARM_ICE_MANTLE: Region = {
  key: 'iceMantle',
  name: 'Warm ice mantle',
  family: 'ice',
  phase: 'partialMelt',
  outerRadiusKm: 2500,
  boundary: sharp(qualitative('Where soft ice with melt pockets gives way to the cold rigid shell is a model boundary')),
  composition: sourced('Ice near its melting point, with pockets of salty meltwater rather than a connected ocean', REANALYSIS_2025, 'modelled'),
  temperatureK: endpoints(400, 255, REANALYSIS_2025, 'modelled'),
  pressureGPa: endpoints(1.5, 0.1, FORTES, 'modelled'),
  densityKgM3: endpoints(1300, 1000, FORTES, 'modelled'),
  heat: heat([{ kind: 'tidal', note: 'Tidal flexing, dissipated in soft ice.' }], 'heat from the rock core', 'convection'),
  claims: [
    claim('existence', [
      row('model', 'supports', REANALYSIS_2025, { observed: 'Cassini\'s tidal response, re-fit with a soft, partly molten ice mantle', inferred: 'No global ocean is needed to explain the tides', assumed: 'A warm, dissipative ice rheology', uncertain: 'Reported, not yet reviewed; the original ocean fit stands', year: 2025 }),
      row('tides', 'challenges', IESS_2012, { observed: 'The tidal Love number', inferred: 'Read in 2012 as a global liquid layer', assumed: 'Elastic deformation', uncertain: 'Both readings fit', mission: 'Cassini', year: 2012 }),
    ]),
  ],
};

export const TITAN_SLUSH_MODEL: InteriorModel = {
  ...TITAN_OCEAN_MODEL,
  modelId: 'titan-slush-no-ocean',
  title: 'Slush, no ocean',
  overview: 'The reported 2025 reading of the same Cassini data: a rock core under a warm ice mantle with pockets of meltwater, and no global ocean. Entered as reported, awaiting review.',
  regions: [CORE, WARM_ICE_MANTLE, ICE_SHELL],
};

export const TITAN_DISTINGUISHED_BY = 'Whether Titan\'s tidal response needs a connected global ocean under the shell, or only soft ice with pockets of melt. The 2025 reanalysis is reported, not yet reviewed; Dragonfly\'s seismometer would settle it.';
