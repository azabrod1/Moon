/**
 * Europa — an ice shell over a global ocean, on rock, on iron: the ocean is
 * inferred from a magnetic field induced in salty water, the rest from
 * gravity. PROVISIONAL: awaiting scientific review.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, row, sharp, sourced, UNKNOWN } from '../modelHelpers';

const KIVELSON = 'Kivelson et al. (2000), Science 289, Galileo magnetometer measurements: a stronger case for a subsurface ocean at Europa';
const ANDERSON = 'Anderson et al. (1998), Science 281, Europa\'s differentiated internal structure: inferences from four Galileo encounters';
const SCHUBERT = 'Schubert, Sohl & Hussmann (2009), in Europa (U. Arizona Press), interior of Europa';
const BILLINGS = 'Billings & Kattenhorn (2005), Icarus 177, the great thickness debate: ice shell thickness models for Europa';
const PAPPALARDO = 'Pappalardo et al. (1999), JGR 104, does Europa have a subsurface ocean? Evaluation of the geological evidence';

export const EUROPA_MODEL: InteriorModel = {
  body: 'Europa',
  modelId: 'europa-galileo',
  title: 'Galileo',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: 1560.8,
  overview: 'An ice shell tens of kilometres thick floating on a salt-water ocean deeper than any of Earth\'s, above a rocky mantle and a small iron core. The ocean was found by the magnetic field it induces; the core is a model preference.',
  regions: [
    {
      key: 'core',
      name: 'Metallic core',
      family: 'metal',
      phase: 'unresolved',
      outerRadiusKm: 500,
      boundary: sharp(modelSpread(300, 700, ['Anderson 1998 (Fe)', 'Anderson 1998 (Fe–FeS)'])),
      composition: sourced('Iron, or iron and iron sulphide', ANDERSON, 'modelled'),
      temperatureK: UNKNOWN,
      pressureGPa: UNKNOWN,
      densityKgM3: endpoints(5150, 5150, ANDERSON, 'modelled', 'none'),
      heat: heat([{ kind: 'primordial', note: 'Whatever formation heat remains; too little is known to say more.' }], null, 'unresolved'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Galileo\'s Doppler tracking gives a moment of inertia of 0.346 ± 0.005', inferred: 'Mass is concentrated toward the centre: a dense core under a rocky mantle', assumed: 'Hydrostatic equilibrium', uncertain: 'Core size trades against mantle density; 0.2 to 0.45 of the radius fits', mission: 'Galileo', year: 1998 }),
          row('density', 'supports', ANDERSON, { observed: 'Bulk density 3013 kg/m³', inferred: 'Mostly rock and metal under the water', assumed: '—', uncertain: '—', mission: 'Galileo', year: 1998 }),
          row('model', 'constrains', SCHUBERT, { observed: 'Thermal-evolution models', inferred: 'A core may or may not have separated from the rock', assumed: 'Europa\'s formation temperature', uncertain: 'Whether the interior ever got hot enough', year: 2009 }),
        ]),
      ],
    },
    {
      key: 'mantle',
      name: 'Rocky mantle',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 1440,
      boundary: sharp(modelSpread(1410, 1480, ['H₂O layer 80 km', 'H₂O layer 150 km'])),
      composition: sourced('Silicate rock, hydrated near the top', SCHUBERT, 'modelled'),
      temperatureK: endpoints(1500, 400, SCHUBERT, 'modelled'),
      pressureGPa: UNKNOWN,
      densityKgM3: endpoints(3500, 3300, ANDERSON, 'modelled'),
      heat: heat([
        { kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium in the rock.' },
        { kind: 'tidal', note: 'Jupiter\'s tides flex Europa on its 3.55-day orbit; how much dissipates in the rock rather than the ice is unknown.' },
      ], null, 'unresolved'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Moment of inertia and density together', inferred: 'A rock layer of roughly this extent beneath the water', assumed: 'Hydrostatic equilibrium', uncertain: 'Its outer radius depends on the water layer\'s thickness', mission: 'Galileo', year: 1998 }),
          row('density', 'supports', ANDERSON, { observed: 'Bulk density', inferred: 'Rock dominates the mass', assumed: '—', uncertain: '—', mission: 'Galileo', year: 1998 }),
        ]),
      ],
    },
    {
      key: 'ocean',
      name: 'Ocean',
      family: 'water',
      phase: 'liquid',
      outerRadiusKm: 1540,
      boundary: distributed(2, BILLINGS, modelSpread(1535, 1546, ['shell 15 km', 'shell 25 km']), null),
      composition: sourced('Liquid water with dissolved salts, probably magnesium sulphate or sodium chloride', KIVELSON, 'inferred'),
      temperatureK: endpoints(273, 271, SCHUBERT, 'inferred'),
      pressureGPa: endpoints(0.15, 0.02, SCHUBERT, 'modelled'),
      densityKgM3: endpoints(1050, 1000, SCHUBERT, 'inferred'),
      heat: heat([{ kind: 'tidal', note: 'Tidal heating in the ice and rock keeps it liquid.' }], 'heat from the rocky mantle', 'convection'),
      claims: [
        claim('existence', [
          row('magnetic', 'supports', KIVELSON, { observed: 'Galileo\'s magnetometer saw Europa\'s induced field flip with Jupiter\'s rotating field on every pass', inferred: 'A conducting layer near the surface: a salty global ocean', assumed: 'The conductor is salt water, not something else', uncertain: 'Its thickness and salinity trade against each other', mission: 'Galileo', year: 2000 }),
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'A water layer 80–170 km thick fits the moment of inertia', inferred: 'Consistent with a thick water layer', assumed: 'Hydrostatic equilibrium', uncertain: 'Cannot tell ice from liquid on its own', mission: 'Galileo', year: 1998 }),
          row('model', 'constrains', PAPPALARDO, { observed: 'Surface geology: chaos terrain, cycloids, few craters', inferred: 'A mobile ice shell over a liquid or ductile layer', assumed: '—', uncertain: 'Geology alone cannot prove a liquid ocean', mission: 'Galileo', year: 1999 }),
        ]),
        claim('state', [
          row('magnetic', 'supports', KIVELSON, { observed: 'Induced field amplitude', inferred: 'Liquid, since ice does not conduct', assumed: 'Salt water conductivity', uncertain: 'Salinity', mission: 'Galileo', year: 2000 }),
        ]),
      ],
    },
    {
      key: 'iceShell',
      name: 'Ice shell',
      family: 'ice',
      phase: 'solid',
      outerRadiusKm: 1560.8,
      boundary: sharp(),
      composition: sourced('Water ice, salts at the surface', PAPPALARDO, 'measured'),
      temperatureK: endpoints(271, 100, SCHUBERT, 'inferred'),
      pressureGPa: endpoints(0.02, 0, SCHUBERT, 'modelled'),
      densityKgM3: endpoints(930, 920, SCHUBERT, 'inferred'),
      heat: heat([{ kind: 'tidal', note: 'Tidal flexing warms the ice, most where it is thick and warm.' }], 'heat from the ocean below', 'mixed'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', PAPPALARDO, { observed: 'Spectra and images of the surface: water ice everywhere', inferred: 'A solid ice surface', assumed: '—', uncertain: '—', mission: 'Galileo', year: 1999 }),
        ]),
        claim('extent', [
          row('model', 'constrains', BILLINGS, { observed: 'Crater shapes, flexure under ridges, thermal models', inferred: 'Thickness anywhere from a few km to ~30 km; ~20 km is common', assumed: 'Different methods sample different things', uncertain: 'The "great thickness debate" is open', year: 2005 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [KIVELSON, ANDERSON, SCHUBERT, BILLINGS, PAPPALARDO],
};
