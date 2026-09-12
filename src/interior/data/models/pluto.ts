/**
 * Pluto — a rock core under a thick water-ice shell, from New Horizons'
 * mass and size; whether an ocean lies between them is argued from where
 * Sputnik Planitia sits, so an ocean model and a frozen one are both
 * drawn. PROVISIONAL.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, row, sharp, sourced } from '../modelHelpers';

const STERN = 'Stern et al. (2015), Science 350, the Pluto system: initial results from its exploration by New Horizons';
const NIMMO = 'Nimmo et al. (2016), Nature 540, reorientation of Sputnik Planitia implies a subsurface ocean on Pluto';
const KEANE = 'Keane et al. (2016), Nature 540, reorientation and faulting of Pluto due to volatile loading within Sputnik Planitia';
const KAMATA = 'Kamata et al. (2019), Nature Geoscience 12, Pluto\'s ocean is capped and insulated by gas hydrates';
const ROBUCHON = 'Robuchon & Nimmo (2011), Icarus 216, thermal evolution of Pluto and implications for surface tectonics and a subsurface ocean';
const MCKINNON = 'McKinnon et al. (2016), Nature 534, convection in a volatile nitrogen-ice-rich layer drives Pluto\'s geological vigour';
const MEAN_RADIUS = 1188.3;

const CORE: Region = {
  key: 'core',
  name: 'Rock core',
  family: 'silicate',
  phase: 'solid',
  outerRadiusKm: 850,
  boundary: sharp(modelSpread(800, 900, ['Nimmo 2016', 'Robuchon & Nimmo 2011'])),
  composition: sourced('Hydrated silicate rock, about two-thirds of Pluto\'s mass', STERN, 'inferred'),
  temperatureK: endpoints(900, 300, ROBUCHON, 'modelled'),
  pressureGPa: endpoints(1.2, 0.4, ROBUCHON, 'modelled'),
  densityKgM3: endpoints(3100, 3000, STERN, 'inferred'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium in the rock; the only lasting heat source.' }], null, 'conduction'),
  claims: [
    claim('existence', [
      row('density', 'supports', STERN, { observed: 'New Horizons fixed Pluto\'s radius at 1188 km; with the mass from Charon\'s orbit the density is 1854 kg/m³', inferred: 'About two-thirds rock by mass, which a separated rock core best explains', assumed: 'Differentiation', uncertain: 'An undifferentiated Pluto is disfavoured by the geology', mission: 'New Horizons', year: 2015 }),
      row('model', 'supports', ROBUCHON, { observed: 'Thermal models of a body this size', inferred: 'Radiogenic heat separates rock from ice early', assumed: 'Enough heat-producing elements', uncertain: 'Timing', year: 2011 }),
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
  composition: sourced('Water ice under a skin of nitrogen, methane and carbon monoxide ices', STERN, 'measured'),
  temperatureK: endpoints(260, 40, ROBUCHON, 'modelled'),
  pressureGPa: endpoints(0.15, 0, ROBUCHON, 'modelled'),
  densityKgM3: endpoints(940, 920, ROBUCHON, 'modelled'),
  heat: heat([{ kind: 'none', note: 'Cold and rigid; nitrogen ice convects in Sputnik Planitia on top of it.' }], 'heat from below', 'conduction'),
  claims: [
    claim('existence', [
      row('inSitu', 'supports', STERN, { observed: 'New Horizons imaged water-ice mountains and volatile-ice plains', inferred: 'A water-ice shell with volatile ices on top', assumed: '—', uncertain: 'Its thickness', mission: 'New Horizons', year: 2015 }),
      row('inSitu', 'supports', MCKINNON, { observed: 'Polygonal cells in Sputnik Planitia', inferred: 'Convecting nitrogen ice a few km deep on a water-ice base', assumed: '—', uncertain: '—', mission: 'New Horizons', year: 2016 }),
    ]),
  ],
};

export const PLUTO_OCEAN_MODEL: InteriorModel = {
  body: 'Pluto',
  modelId: 'pluto-ocean',
  title: 'Ocean',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A rock core, a water ocean kept liquid under an insulating lid, and a thick ice shell: the reading of why Sputnik Planitia sits opposite Charon, since a basin that heavy could only reorient Pluto with a dense ocean beneath it.',
  regions: [
    CORE,
    {
      key: 'ocean',
      name: 'Ocean',
      family: 'water',
      phase: 'liquid',
      outerRadiusKm: 1000,
      boundary: distributed(2, KAMATA, modelSpread(950, 1040, ['Nimmo 2016', 'Kamata 2019'])),
      composition: sourced('Water with ammonia, under a layer of gas hydrates that keeps it from freezing', KAMATA, 'modelled'),
      temperatureK: endpoints(300, 260, KAMATA, 'modelled'),
      pressureGPa: endpoints(0.4, 0.15, ROBUCHON, 'modelled'),
      densityKgM3: endpoints(1100, 1000, NIMMO, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Warmed by the rock core, insulated by hydrates above.' }], 'heat from the core', 'convection'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', NIMMO, { observed: 'Sputnik Planitia, a deep basin, lies almost exactly opposite Charon, where a mass excess would migrate', inferred: 'The basin is a mass excess: nitrogen ice above a dense ocean that rose into the thinned shell', assumed: 'Pluto reoriented to put the excess on the tidal axis', uncertain: 'Nitrogen loading alone might suffice', mission: 'New Horizons', year: 2016 }),
          row('model', 'supports', KAMATA, { observed: 'Thermal models with a gas-hydrate lid', inferred: 'An ocean can survive to the present under such a lid', assumed: 'Methane clathrate forms at the ocean\'s top', uncertain: 'Lid thickness', year: 2019 }),
          row('model', 'challenges', KEANE, { observed: 'Volatile loading of nitrogen ice alone', inferred: 'Can reorient Pluto and fault its shell without an ocean', assumed: 'Enough nitrogen', uncertain: 'Whether it is enough', mission: 'New Horizons', year: 2016 }),
        ]),
      ],
    },
    ICE_SHELL,
  ],
  annotations: [],
  sources: [STERN, NIMMO, KEANE, KAMATA, ROBUCHON, MCKINNON],
};

export const PLUTO_FROZEN_MODEL: InteriorModel = {
  ...PLUTO_OCEAN_MODEL,
  modelId: 'pluto-frozen',
  title: 'Frozen through',
  overview: 'The same rock core under ice solid all the way down: Sputnik Planitia\'s position explained by nitrogen ice loading alone, no ocean required.',
  regions: [
    CORE,
    {
      ...ICE_SHELL,
      key: 'iceMantle',
      name: 'Ice, solid throughout',
      composition: sourced('Water ice from the core to the surface', KEANE, 'modelled'),
      temperatureK: endpoints(300, 40, ROBUCHON, 'modelled'),
      pressureGPa: endpoints(0.4, 0, ROBUCHON, 'modelled'),
      claims: [
        claim('existence', [
          row('model', 'supports', KEANE, { observed: 'Loading models with nitrogen ice', inferred: 'Reorientation and faulting without an ocean', assumed: 'Enough nitrogen in the basin', uncertain: 'Both pictures fit', mission: 'New Horizons', year: 2016 }),
          row('gravity', 'challenges', NIMMO, { observed: 'The basin\'s position and the fault pattern', inferred: 'Best fit with a dense ocean beneath', assumed: 'A thinned shell over the basin', uncertain: 'Both fit', mission: 'New Horizons', year: 2016 }),
        ]),
      ],
    },
  ],
};

export const PLUTO_DISTINGUISHED_BY = 'Whether Sputnik Planitia needed a dense ocean beneath it to swing Pluto round to face Charon, or whether nitrogen ice piling into the basin was enough. A gravity measurement from orbit would tell; New Horizons flew past.';
