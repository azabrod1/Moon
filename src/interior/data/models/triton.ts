/**
 * Triton — a captured world, two-thirds rock by mass, with a young surface
 * and geysers; Voyager 2's one flyby measured its mass, size and geology
 * and nothing of its interior, so it is poorly constrained, with an
 * illustrative rock-ocean-ice scenario that models argue for. PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, row, sharp, sourced } from '../modelHelpers';

const SMITH = 'Smith et al. (1989), Science 246, Voyager 2 at Neptune: imaging science results';
const TYLER = 'Tyler et al. (1989), Science 246, Voyager radio science observations of Neptune and Triton';
const HUSSMANN = 'Hussmann, Sohl & Spohn (2006), Icarus 185, subsurface oceans and deep interiors of medium-sized outer planet satellites and large trans-neptunian objects';
const NIMMO = 'Nimmo & Spencer (2015), Icarus 246, powering Triton\'s recent geological activity by obliquity tides: implications for Pluto geology';
const MEAN_RADIUS = 1353.4;

export const TRITON_ILLUSTRATIVE_MODEL: InteriorModel = {
  body: 'Triton',
  modelId: 'triton-ocean-illustrative',
  title: 'Rock, ocean, ice',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'One way Triton could be built: a rock core, an ocean kept liquid by tides and decay, and an ice shell. Illustrative — models argue for it; nothing has measured it.',
  illustrative: true,
  regions: [
    {
      key: 'core',
      name: 'Rock core',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 950,
      boundary: sharp(modelSpread(900, 1000, ['Hussmann 2006'])),
      composition: sourced('Silicate rock, about two-thirds of the mass', HUSSMANN, 'modelled'),
      temperatureK: endpoints(1000, 300, HUSSMANN, 'modelled'),
      pressureGPa: endpoints(1.8, 0.5, HUSSMANN, 'modelled'),
      densityKgM3: endpoints(3200, 3000, HUSSMANN, 'modelled'),
      heat: heat([
        { kind: 'radiogenicDecay', note: 'Decay in the rock.' },
        { kind: 'tidal', note: 'Obliquity tides from Triton\'s tilted, retrograde orbit.' },
      ], null, 'conduction'),
      claims: [
        claim('existence', [
          row('density', 'supports', TYLER, { observed: 'Voyager 2\'s tracking and imaging give a bulk density of 2061 kg/m³', inferred: 'Two-thirds rock by mass; a separated core if the interior ever warmed', assumed: 'Differentiation', uncertain: 'Nothing has measured the interior', mission: 'Voyager 2', year: 1989 }),
        ]),
      ],
    },
    {
      key: 'ocean',
      name: 'Possible ocean',
      family: 'water',
      phase: 'liquid',
      outerRadiusKm: 1050,
      boundary: distributed(2, HUSSMANN, modelSpread(1000, 1150, ['Hussmann 2006', 'Nimmo & Spencer 2015'])),
      composition: sourced('Water with ammonia, if it exists', HUSSMANN, 'modelled'),
      temperatureK: endpoints(300, 250, HUSSMANN, 'modelled'),
      pressureGPa: endpoints(0.5, 0.35, HUSSMANN, 'modelled'),
      densityKgM3: endpoints(1100, 1000, HUSSMANN, 'modelled'),
      heat: heat([{ kind: 'tidal', note: 'Obliquity tides could keep it liquid.' }], 'Heat from the core', 'convection'),
      claims: [
        claim('existence', [
          row('model', 'supports', NIMMO, { observed: 'Triton\'s young surface and its tilted orbit', inferred: 'Obliquity tides dissipate enough heat to keep an ocean and drive resurfacing', assumed: 'A dissipative ice shell', uncertain: 'Entirely a model; no measurement', year: 2015 }),
          row('model', 'supports', HUSSMANN, { observed: 'Thermal-evolution models of icy satellites this size', inferred: 'An ocean can survive with ammonia', assumed: 'Ammonia content', uncertain: 'As above', year: 2006 }),
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
      composition: sourced('Water ice under nitrogen and methane frosts, with geysers of nitrogen', SMITH, 'measured'),
      temperatureK: endpoints(250, 38, HUSSMANN, 'modelled'),
      pressureGPa: endpoints(0.35, 0, HUSSMANN, 'modelled'),
      densityKgM3: endpoints(950, 920, HUSSMANN, 'modelled'),
      heat: heat([{ kind: 'tidal', note: 'Tidal flexing in the shell.' }], 'Heat from below', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', SMITH, { observed: 'Voyager 2 imaged a young, sparsely cratered surface of ices with active plumes', inferred: 'An ice shell resurfaced recently', assumed: '—', uncertain: 'Its thickness', mission: 'Voyager 2', year: 1989 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [SMITH, TYLER, HUSSMANN, NIMMO],
};

export const TRITON_BULK = {
  densityKgM3: sourced(2061, TYLER, 'measured', '±7 kg/m³'),
  note: 'Two-thirds rock by mass under ice, from Voyager 2\'s one flyby: a captured world whose young surface and geysers suggest an interior kept warm by tides and decay. No measurement reaches it. A rock-ocean-ice scenario can be shown.',
};
