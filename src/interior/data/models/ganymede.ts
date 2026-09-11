/**
 * Ganymede — the largest moon, fully differentiated: an iron core with its
 * own magnetic field, a rock mantle, and a hydrosphere hundreds of km deep
 * in which a salty ocean lies between an ice-I shell and dense high-pressure
 * ice. PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, row, sharp, sourced } from '../modelHelpers';

const ANDERSON = 'Anderson et al. (1996), Nature 384, gravitational constraints on the internal structure of Ganymede';
const KIVELSON = 'Kivelson et al. (1996), Nature 384, discovery of Ganymede\'s magnetic field by the Galileo spacecraft';
const SAUR = 'Saur et al. (2015), JGR Space Physics 120, the search for a subsurface ocean in Ganymede with Hubble observations of its auroral ovals';
const SOHL = 'Sohl et al. (2002), Icarus 157, implications from Galileo observations on the interior structure and chemistry of the Galilean satellites';
const VANCE = 'Vance et al. (2014), PSS 96, Ganymede\'s internal structure including thermodynamics of magnesium sulfate oceans';
const SCHUBERT = 'Schubert et al. (2004), in Jupiter (Cambridge), interior composition, structure and dynamics of the Galilean satellites';
const MEAN_RADIUS = 2634.1;

export const GANYMEDE_MODEL: InteriorModel = {
  body: 'Ganymede',
  modelId: 'ganymede-galileo-hubble',
  title: 'Galileo and Hubble',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'An iron core that runs a dynamo, a rock mantle, then a hydrosphere hundreds of km deep: high-pressure ice, a salty ocean, and an ice-I shell on top. The only moon with its own magnetic field.',
  regions: [
    {
      key: 'core',
      name: 'Iron core',
      family: 'metal',
      phase: 'liquidMetal',
      outerRadiusKm: 800,
      boundary: sharp(modelSpread(500, 1000, ['Anderson 1996 (Fe)', 'Anderson 1996 (Fe–FeS)'])),
      composition: sourced('Iron and iron sulphide, at least partly liquid', SOHL, 'modelled'),
      temperatureK: endpoints(1800, 1500, SOHL, 'modelled'),
      pressureGPa: endpoints(10, 7, SOHL, 'modelled'),
      densityKgM3: endpoints(6000, 5500, ANDERSON, 'modelled'),
      heat: heat([{ kind: 'primordial', note: 'Formation heat, leaving slowly through a thick mantle; enough convection remains to run a dynamo.' }], null, 'convection'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Galileo\'s tracking gives a moment of inertia of 0.311, the lowest of any solid body measured', inferred: 'Strongly concentrated mass: a metal core under rock under ice', assumed: 'Hydrostatic equilibrium', uncertain: 'Core radius 400–1300 km depending on composition', mission: 'Galileo', year: 1996 }),
          row('magnetic', 'supports', KIVELSON, { observed: 'Galileo found an intrinsic dipole field of about 720 nT at the equator', inferred: 'A dynamo in a convecting, conducting liquid: an iron core', assumed: 'Dynamo theory', uncertain: 'How such a small core keeps convecting', mission: 'Galileo', year: 1996 }),
        ]),
        claim('state', [
          row('magnetic', 'supports', KIVELSON, { observed: 'The intrinsic field', inferred: 'At least the outer core is liquid and convecting', assumed: 'As above', uncertain: 'Whether a solid centre exists', mission: 'Galileo', year: 1996 }),
        ]),
      ],
    },
    {
      key: 'mantle',
      name: 'Rock mantle',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 1800,
      boundary: sharp(modelSpread(1700, 1900, ['Sohl 2002', 'Vance 2014'])),
      composition: sourced('Silicate rock', SOHL, 'modelled'),
      temperatureK: endpoints(1500, 900, SOHL, 'modelled'),
      pressureGPa: endpoints(7, 1.6, SOHL, 'modelled'),
      densityKgM3: endpoints(3500, 3200, ANDERSON, 'modelled'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium in the rock.' }], 'Heat from the core', 'convection'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Moment of inertia with the density', inferred: 'A rock layer between the metal and the water', assumed: 'Hydrostatic equilibrium', uncertain: 'Its outer radius', mission: 'Galileo', year: 1996 }),
          row('density', 'supports', ANDERSON, { observed: 'Bulk density 1940 kg/m³', inferred: 'About half rock by mass', assumed: '—', uncertain: '—', mission: 'Galileo', year: 1996 }),
        ]),
      ],
    },
    {
      key: 'highPressureIce',
      name: 'High-pressure ice',
      family: 'ice',
      phase: 'solid',
      outerRadiusKm: 2380,
      boundary: sharp(modelSpread(2330, 2430, ['Vance 2014'])),
      composition: sourced('Ice VI and ice V, denser than the ocean above', VANCE, 'modelled'),
      temperatureK: endpoints(900, 270, VANCE, 'modelled'),
      pressureGPa: endpoints(1.6, 0.3, VANCE, 'modelled'),
      densityKgM3: endpoints(1400, 1250, VANCE, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Carries heat upward from the rock.' }], 'Heat from the mantle', 'convection'),
      claims: [
        claim('existence', [
          row('model', 'supports', VANCE, { observed: 'Pressure at the base of an 800 km water layer exceeds 1 GPa', inferred: 'Water there is dense ice, not liquid', assumed: 'The hydrosphere thickness', uncertain: 'Whether pockets of brine sit between ice layers', year: 2014 }),
          row('momentOfInertia', 'constrains', ANDERSON, { observed: 'Moment of inertia', inferred: 'A water layer some 800–900 km thick', assumed: 'Hydrostatic equilibrium', uncertain: 'Cannot see the phases', mission: 'Galileo', year: 1996 }),
        ]),
      ],
    },
    {
      key: 'ocean',
      name: 'Ocean',
      family: 'water',
      phase: 'liquid',
      outerRadiusKm: 2484,
      boundary: distributed(2, VANCE, modelSpread(2450, 2520, ['shell 100 km', 'shell 180 km'])),
      composition: sourced('Salty water, perhaps magnesium sulphate', VANCE, 'modelled'),
      temperatureK: endpoints(270, 255, VANCE, 'modelled'),
      pressureGPa: endpoints(0.3, 0.15, VANCE, 'modelled'),
      densityKgM3: endpoints(1150, 1050, VANCE, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Warmed from below.' }], 'Heat from the ice below', 'convection'),
      claims: [
        claim('existence', [
          row('magnetic', 'supports', SAUR, { observed: 'Hubble watched Ganymede\'s auroral ovals rock by only 2° as Jupiter\'s field swept past, not the 6° a moon without a conductor would show', inferred: 'A conducting layer near the surface: a salty ocean', assumed: 'The conductor is salt water', uncertain: 'Its depth and thickness', mission: 'Hubble', year: 2015 }),
          row('magnetic', 'supports', KIVELSON, { observed: 'An induced component in Galileo\'s magnetometer data beside the intrinsic field', inferred: 'Consistent with a conducting layer', assumed: 'Separating induced from intrinsic', uncertain: 'Harder to isolate than at Europa', mission: 'Galileo', year: 1996 }),
        ]),
        claim('state', [
          row('magnetic', 'supports', SAUR, { observed: 'The damped auroral rocking', inferred: 'Liquid, since ice does not conduct', assumed: 'Salinity', uncertain: 'Salinity', mission: 'Hubble', year: 2015 }),
        ]),
      ],
    },
    {
      key: 'iceShell',
      name: 'Ice shell',
      family: 'ice',
      phase: 'solid',
      outerRadiusKm: MEAN_RADIUS,
      boundary: sharp(),
      composition: sourced('Water ice, dark and old in the grooved terrain, brighter where younger', SCHUBERT, 'measured'),
      temperatureK: endpoints(255, 110, VANCE, 'modelled'),
      pressureGPa: endpoints(0.15, 0, VANCE, 'modelled'),
      densityKgM3: endpoints(930, 920, VANCE, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Cold and rigid.' }], 'Heat from the ocean below', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', SCHUBERT, { observed: 'Spectra and images: water ice across the surface', inferred: 'A solid ice surface', assumed: '—', uncertain: '—', mission: 'Galileo', year: 2004 }),
        ]),
        claim('extent', [
          row('magnetic', 'constrains', SAUR, { observed: 'The auroral rocking fits a conductor at about 150 km depth', inferred: 'A shell of order 150 km', assumed: 'Ocean conductivity', uncertain: '100–180 km', mission: 'Hubble', year: 2015 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [ANDERSON, KIVELSON, SAUR, SOHL, VANCE, SCHUBERT],
};
