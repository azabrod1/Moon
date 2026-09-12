/**
 * Callisto — the odd one out: its moment of inertia says rock and ice are
 * only partly separated, if Callisto is in hydrostatic equilibrium; if it
 * is not, a fully separated interior fits too. Both carry the ocean the
 * induced magnetic field asks for. Two models. PROVISIONAL.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, qualitative, row, sharp, sourced } from '../modelHelpers';

const ANDERSON = 'Anderson et al. (2001), Icarus 153, shape, mean radius, gravity field, and interior structure of Callisto';
const ZIMMER = 'Zimmer, Khurana & Kivelson (2000), Icarus 147, subsurface oceans on Europa and Callisto: constraints from Galileo magnetometer observations';
const GAO = 'Gao & Stevenson (2013), Icarus 226, nonhydrostatic effects and the determination of icy satellites\' moment of inertia';
const SCHUBERT = 'Schubert et al. (2004), in Jupiter (Cambridge), interior composition, structure and dynamics of the Galilean satellites';
const MEAN_RADIUS = 2410.3;

const OCEAN: Region = {
  key: 'ocean',
  name: 'Ocean',
  family: 'water',
  phase: 'liquid',
  outerRadiusKm: 2260,
  boundary: distributed(2, ZIMMER, modelSpread(2210, 2310, ['Zimmer 2000'])),
  composition: sourced('Salty water, perhaps with ammonia keeping it liquid', ZIMMER, 'inferred'),
  temperatureK: endpoints(260, 250, SCHUBERT, 'modelled'),
  pressureGPa: endpoints(0.2, 0.15, SCHUBERT, 'modelled'),
  densityKgM3: endpoints(1100, 1050, SCHUBERT, 'modelled'),
  heat: heat([{ kind: 'none', note: 'Kept liquid by a little radiogenic heat and antifreeze.' }], 'heat from the interior', 'conduction'),
  claims: [
    claim('existence', [
      row('magnetic', 'supports', ZIMMER, { observed: 'Galileo\'s magnetometer saw an induced dipole responding to Jupiter\'s rotating field', inferred: 'A conducting layer near the surface: a salty ocean', assumed: 'The conductor is salt water', uncertain: 'An ionosphere was proposed instead and disfavoured', mission: 'Galileo', year: 2000 }),
    ]),
    claim('state', [
      row('magnetic', 'supports', ZIMMER, { observed: 'The induced field\'s amplitude', inferred: 'Liquid', assumed: 'Conductivity of brine', uncertain: 'Salinity', mission: 'Galileo', year: 2000 }),
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
  composition: sourced('Dirty water ice, the most cratered surface known', SCHUBERT, 'measured'),
  temperatureK: endpoints(250, 120, SCHUBERT, 'modelled'),
  pressureGPa: endpoints(0.15, 0, SCHUBERT, 'modelled'),
  densityKgM3: endpoints(930, 920, SCHUBERT, 'modelled'),
  heat: heat([{ kind: 'none', note: 'Cold and rigid.' }], 'heat from the ocean below', 'conduction'),
  claims: [
    claim('existence', [
      row('inSitu', 'supports', SCHUBERT, { observed: 'Images and spectra of an ice-and-dust surface', inferred: 'A solid ice shell', assumed: '—', uncertain: 'Its thickness, ~150 km', mission: 'Galileo', year: 2004 }),
    ]),
  ],
};

export const CALLISTO_PARTIAL_MODEL: InteriorModel = {
  body: 'Callisto',
  modelId: 'callisto-partially-differentiated',
  title: 'Partly separated',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'Rock and ice only partly separated, rock-richer toward the centre, with a thin salty ocean under the ice shell: the reading of Galileo\'s gravity if Callisto is in hydrostatic equilibrium.',
  regions: [
    {
      key: 'interior',
      name: 'Mixed rock and ice',
      family: 'mixed',
      phase: 'solid',
      outerRadiusKm: 2200,
      boundary: distributed(100, ANDERSON, qualitative('Rock content rises inward with no sharp boundary')),
      composition: sourced('Ice and rock mixed, rock-richer with depth, never fully separated', ANDERSON, 'modelled'),
      temperatureK: endpoints(1000, 260, SCHUBERT, 'modelled'),
      pressureGPa: endpoints(3, 0.2, SCHUBERT, 'modelled'),
      densityKgM3: endpoints(3000, 1500, ANDERSON, 'modelled'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Decay in the rock, leaving slowly.' }], null, 'conduction'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Galileo\'s tracking gives a moment of inertia of 0.3549 ± 0.0042', inferred: 'Too high for a separated rock core under ice: rock and ice are still partly mixed', assumed: 'Hydrostatic equilibrium', uncertain: 'The hydrostatic assumption itself', mission: 'Galileo', year: 2001 }),
          row('density', 'supports', ANDERSON, { observed: 'Bulk density 1834 kg/m³', inferred: 'Roughly half rock, half ice', assumed: '—', uncertain: '—', mission: 'Galileo', year: 2001 }),
          row('model', 'challenges', GAO, { observed: 'If Callisto is not hydrostatic, the same gravity allows a fully separated interior', inferred: 'Partial differentiation is not required', assumed: 'A non-hydrostatic shape', uncertain: 'Which assumption is right', year: 2013 }),
        ]),
      ],
    },
    OCEAN,
    ICE_SHELL,
  ],
  annotations: [],
  sources: [ANDERSON, ZIMMER, GAO, SCHUBERT],
};

export const CALLISTO_DIFFERENTIATED_MODEL: InteriorModel = {
  ...CALLISTO_PARTIAL_MODEL,
  modelId: 'callisto-fully-differentiated',
  title: 'Fully separated',
  overview: 'A rock core under an ice mantle, with the same ocean and shell: allowed if Callisto\'s shape is not hydrostatic, so the moment of inertia does not mean what it seems to.',
  regions: [
    {
      key: 'core',
      name: 'Rock core',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 1400,
      boundary: sharp(modelSpread(1200, 1600, ['Gao & Stevenson 2013'])),
      composition: sourced('Silicate rock, perhaps with metal', GAO, 'modelled'),
      temperatureK: endpoints(1200, 600, SCHUBERT, 'modelled'),
      pressureGPa: endpoints(3, 1.5, SCHUBERT, 'modelled'),
      densityKgM3: endpoints(3400, 3200, GAO, 'modelled'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Decay in the rock.' }], null, 'conduction'),
      claims: [
        claim('existence', [
          row('model', 'supports', GAO, { observed: 'Gravity re-fit without the hydrostatic assumption', inferred: 'A separated rock core fits', assumed: 'A non-hydrostatic Callisto', uncertain: 'Both pictures fit', year: 2013 }),
          row('momentOfInertia', 'challenges', ANDERSON, { observed: 'The hydrostatic moment of inertia', inferred: 'Too high for a rock core under pure ice', assumed: 'Hydrostatic equilibrium', uncertain: 'The assumption', mission: 'Galileo', year: 2001 }),
        ]),
      ],
    },
    {
      key: 'iceMantle',
      name: 'Ice mantle',
      family: 'ice',
      phase: 'solid',
      outerRadiusKm: 2200,
      boundary: sharp(modelSpread(2150, 2250, ['Gao & Stevenson 2013'])),
      composition: sourced('High-pressure ices over the rock', GAO, 'modelled'),
      temperatureK: endpoints(600, 260, SCHUBERT, 'modelled'),
      pressureGPa: endpoints(1.5, 0.2, SCHUBERT, 'modelled'),
      densityKgM3: endpoints(1300, 1100, GAO, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Carries heat from the rock.' }], 'heat from the core', 'conduction'),
      claims: [
        claim('existence', [
          row('model', 'supports', GAO, { observed: 'The same re-fit', inferred: 'An ice mantle above the core', assumed: 'As above', uncertain: 'As above', year: 2013 }),
        ]),
      ],
    },
    OCEAN,
    ICE_SHELL,
  ],
};

export const CALLISTO_DISTINGUISHED_BY = 'Whether Callisto\'s shape is hydrostatic. If it is, the moment of inertia says rock and ice never fully separated; if not, a rock core under ice fits the same gravity. JUICE\'s flybys will measure the shape and gravity well enough to tell.';
