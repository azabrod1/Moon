/**
 * Mars — InSight's seismometer heard the core in 2021; the reanalysis of
 * 2023 argues a layer of molten rock sits between mantle and a smaller
 * core. Both fit the data; both are drawn. PROVISIONAL: awaiting review.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, endpoints, heat, interval, row, sharp, sourced } from '../modelHelpers';

const STAHLER = 'Stähler et al. (2021), Science 373, seismic detection of the martian core';
const KHAN = 'Khan et al. (2023), Nature 622, evidence for a liquid silicate layer atop the martian core';
const SAMUEL = 'Samuel et al. (2023), Nature 622, geophysical evidence for an enriched molten silicate layer above Mars\'s core';
const KNAPMEYER = 'Knapmeyer-Endrun et al. (2021), Science 373, thickness and structure of the martian crust from InSight seismic data';
const FOLKNER = 'Folkner et al. (1997), Science 278, interior structure and seasonal mass redistribution of Mars from radio tracking of Mars Pathfinder';
const KONOPLIV = 'Konopliv et al. (2016), Icarus 274, an improved JPL Mars gravity field and orientation from Mars orbiter and lander tracking data';
const ACUNA = 'Acuña et al. (1999), Science 284, global distribution of crustal magnetization discovered by the Mars Global Surveyor MAG/ER experiment';
const STEWART = 'Stewart et al. (2007), Science 316, Mars: a new core-crystallization regime';
const MEAN_RADIUS = 3389.5;

const CRUST: Region = {
  key: 'crust',
  name: 'Crust',
  family: 'silicate',
  phase: 'solid',
  outerRadiusKm: MEAN_RADIUS,
  boundary: sharp(),
  composition: sourced('Basaltic rock, possibly layered', KNAPMEYER, 'inferred'),
  temperatureK: endpoints(500, 210, KNAPMEYER, 'modelled'),
  pressureGPa: endpoints(0.6, 0, KNAPMEYER, 'modelled'),
  densityKgM3: endpoints(2900, 2700, KNAPMEYER, 'inferred'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Heat-producing elements concentrated in the crust.' }], 'Heat from the mantle', 'conduction'),
  claims: [
    claim('existence', [
      row('seismology', 'supports', KNAPMEYER, { observed: 'Receiver functions under the InSight lander show two or three crustal layers', inferred: 'A crust 24–72 km thick, thinner under the lander', assumed: 'The lander site is representative of the north', uncertain: 'Whether the deeper layer is crust or mantle', mission: 'InSight', year: 2021 }),
      row('gravity', 'supports', KONOPLIV, { observed: 'Gravity and topography together', inferred: 'Crustal thickness variations across the planet', assumed: 'A crustal density', uncertain: 'Absolute thickness without the seismic anchor', year: 2016 }),
    ]),
  ],
};

function mantle(outerRadiusKm: number, innerRadiusNote: string): Region {
  return {
    key: 'mantle',
    name: 'Mantle',
    family: 'silicate',
    phase: 'solid',
    outerRadiusKm,
    boundary: sharp(interval(outerRadiusKm - 40, outerRadiusKm + 40, 0.68, KNAPMEYER)),
    composition: sourced('Olivine and pyroxene, more iron-rich than Earth\'s', STAHLER, 'inferred', innerRadiusNote),
    temperatureK: endpoints(1900, 500, KHAN, 'modelled'),
    pressureGPa: endpoints(19, 0.6, STAHLER, 'modelled'),
    densityKgM3: endpoints(4100, 3400, STAHLER, 'inferred'),
    heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium.' }], 'Heat from the core', 'convection'),
    claims: [
      claim('existence', [
        row('seismology', 'supports', STAHLER, { observed: 'Marsquake waves crossing it, including those turning above the core', inferred: 'A thick solid silicate mantle', assumed: '—', uncertain: 'Its lowest part is the open question', mission: 'InSight', year: 2021 }),
        row('momentOfInertia', 'supports', FOLKNER, { observed: 'Mars\'s moment of inertia from Pathfinder and Viking tracking', inferred: 'A rocky mantle over a dense core', assumed: 'Hydrostatic equilibrium plus Tharsis', uncertain: 'The core size alone from this', mission: 'Mars Pathfinder', year: 1997 }),
      ]),
    ],
  };
}

const LIQUID_CORE_LARGE: Region = {
  key: 'core',
  name: 'Liquid core',
  family: 'metal',
  phase: 'liquidMetal',
  outerRadiusKm: 1830,
  boundary: sharp(interval(1790, 1870, 0.68, STAHLER)),
  composition: sourced('Liquid iron with a large share of sulphur and other light elements', STAHLER, 'inferred'),
  temperatureK: endpoints(2000, 1900, STAHLER, 'modelled'),
  pressureGPa: endpoints(40, 19, STAHLER, 'modelled'),
  densityKgM3: endpoints(6000, 5800, STAHLER, 'inferred'),
  heat: heat([{ kind: 'primordial', note: 'Heat of formation; no dynamo runs today.' }], null, 'convection'),
  claims: [
    claim('existence', [
      row('seismology', 'supports', STAHLER, { observed: 'Shear waves reflected off the core boundary (ScS) in InSight records', inferred: 'A core of 1830 ± 40 km radius', assumed: 'A one-dimensional mantle above it', uncertain: 'The reflector could be the top of a molten layer rather than the metal core', mission: 'InSight', year: 2021 }),
      row('tides', 'supports', KONOPLIV, { observed: 'Mars\'s tidal response to the Sun, the Love number k2', inferred: 'A liquid core; a solid one would respond less', assumed: 'Mantle rigidity', uncertain: 'Core radius from k2 alone spans hundreds of km', year: 2016 }),
      row('momentOfInertia', 'supports', FOLKNER, { observed: 'Moment of inertia', inferred: 'A dense core of this general size', assumed: 'Hydrostatic Mars', uncertain: 'Trades against mantle density', mission: 'Mars Pathfinder', year: 1997 }),
      row('labHighPressure', 'supports', STEWART, { observed: 'Iron–sulphur melting at martian core pressures', inferred: 'A sulphur-rich core is fully liquid at these temperatures', assumed: 'Enough sulphur', uncertain: 'The light-element mix', year: 2007 }),
      row('seismology', 'challenges', KHAN, { observed: 'Reanalysis with waves that dive deeper', inferred: 'The 2021 reflector is the top of a molten silicate layer; the metal core is smaller', assumed: 'A deep mantle enriched in heat-producing elements', uncertain: 'Both pictures fit the sparse data', mission: 'InSight', year: 2023 }),
    ]),
    claim('state', [
      row('tides', 'supports', KONOPLIV, { observed: 'Love number k2', inferred: 'Liquid', assumed: 'As above', uncertain: 'As above', year: 2016 }),
      row('magnetic', 'constrains', ACUNA, { observed: 'Strong crustal magnetisation, no global field', inferred: 'A dynamo ran early and stopped', assumed: 'Remanence records an ancient field', uncertain: 'When and why it stopped', mission: 'Mars Global Surveyor', year: 1999 }),
    ]),
  ],
};

export const MARS_LIQUID_CORE_MODEL: InteriorModel = {
  body: 'Mars',
  modelId: 'mars-large-liquid-core',
  title: 'Large liquid core',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A large, low-density liquid core of iron and sulphur, its top heard by InSight in 2021, under a solid mantle and a thin crust.',
  regions: [LIQUID_CORE_LARGE, mantle(3339.5, 'Down to the core boundary at 1830 km'), CRUST],
  annotations: [],
  sources: [STAHLER, KHAN, SAMUEL, KNAPMEYER, FOLKNER, KONOPLIV, ACUNA, STEWART],
};

const LIQUID_CORE_SMALL: Region = {
  ...LIQUID_CORE_LARGE,
  outerRadiusKm: 1650,
  boundary: sharp(interval(1600, 1700, 0.68, KHAN)),
  composition: sourced('Liquid iron with less sulphur than the large-core picture needs', KHAN, 'inferred'),
  // Under a hot enriched layer the core's top sits at the layer's base temperature.
  temperatureK: endpoints(2200, 2100, KHAN, 'modelled'),
  pressureGPa: endpoints(40, 21, KHAN, 'modelled'),
  densityKgM3: endpoints(6500, 6300, KHAN, 'inferred'),
  claims: [
    claim('existence', [
      row('seismology', 'supports', KHAN, { observed: 'Waves that graze the deep interior, and the 2021 reflections reinterpreted', inferred: 'A metal core of ~1650 km under a molten silicate layer', assumed: 'A stably stratified, enriched basal layer', uncertain: 'Both models fit', mission: 'InSight', year: 2023 }),
      row('tides', 'supports', SAMUEL, { observed: 'Tidal response and moment of inertia', inferred: 'Fit as well by a smaller core plus a molten layer', assumed: 'Layer density and thickness', uncertain: 'As above', year: 2023 }),
      row('labHighPressure', 'supports', STEWART, { observed: 'Iron–sulphur melting', inferred: 'Liquid at these conditions', assumed: '—', uncertain: '—', year: 2007 }),
    ]),
    LIQUID_CORE_LARGE.claims[1],
  ],
};

const BASAL_MOLTEN_LAYER: Region = {
  key: 'basalMoltenLayer',
  name: 'Molten silicate layer',
  family: 'silicate',
  phase: 'liquid',
  outerRadiusKm: 1800,
  boundary: sharp(interval(1770, 1830, 0.68, KHAN)),
  composition: sourced('Molten iron-rich silicate, enriched in heat-producing elements', SAMUEL, 'modelled'),
  temperatureK: endpoints(2100, 2000, KHAN, 'modelled'),
  pressureGPa: endpoints(21, 19, KHAN, 'modelled'),
  densityKgM3: endpoints(4400, 4300, KHAN, 'modelled'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Enriched in uranium, thorium and potassium: a hot blanket over the core.' }], 'Heat from the core', 'convection'),
  claims: [
    claim('existence', [
      row('seismology', 'supports', KHAN, { observed: 'Deep-diving wave arrivals and the reflector depth', inferred: 'A ~150 km molten silicate layer between mantle and core', assumed: 'The reflector is the layer\'s top, not the metal', uncertain: 'Its thickness and whether it is fully molten', mission: 'InSight', year: 2023 }),
      row('seismology', 'supports', SAMUEL, { observed: 'Independent analysis of the same InSight data', inferred: 'The same layer', assumed: 'Similar', uncertain: 'Similar', mission: 'InSight', year: 2023 }),
      row('model', 'challenges', STAHLER, { observed: 'The 2021 core model', inferred: 'Fits without any molten layer', assumed: 'The reflector is the metal core', uncertain: 'Both fit', mission: 'InSight', year: 2021 }),
    ]),
  ],
};

export const MARS_BASAL_LAYER_MODEL: InteriorModel = {
  ...MARS_LIQUID_CORE_MODEL,
  modelId: 'mars-basal-molten-layer',
  title: 'Basal molten layer',
  overview: 'A smaller, denser liquid core under a layer of molten silicate rock about 150 km thick: the 2023 reinterpretation of InSight\'s data, which explains the core\'s apparent low density.',
  regions: [LIQUID_CORE_SMALL, BASAL_MOLTEN_LAYER, mantle(3339.5, 'Down to the molten layer at 1800 km'), CRUST],
};

/** What separates the two pictures, for the coverage entry. */
export const MARS_DISTINGUISHED_BY = 'Whether a layer of molten rock lies between the mantle and a smaller metal core. InSight\'s core-grazing waves and Mars\'s tidal response fit either arrangement; a second seismometer would settle it.';
