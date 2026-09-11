/**
 * Venus — Earth's twin with no seismometer. Its moment of inertia was only
 * measured in 2021 from Earth-based radar, and its tidal response from
 * Magellan tracking; together they say a core of about half the radius,
 * probably at least partly liquid, but its state is not settled and there
 * is no dynamo to tell. One model, with the core's phase left unresolved.
 * PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, endpoints, heat, modelSpread, row, sharp, sourced } from '../modelHelpers';

const MARGOT = 'Margot et al. (2021), Nature Astronomy 5, spin state and moment of inertia of Venus';
const KONOPLIV = 'Konopliv & Yoder (1996), GRL 23, Venusian k₂ tidal Love number from Magellan and PVO tracking data';
const DUMOULIN = 'Dumoulin et al. (2017), JGR Planets 122, tidal constraints on the interior of Venus';
const JAMES = 'James, Zuber & Phillips (2013), JGR Planets 118, crustal thickness and support of topography on Venus';
const PHILLIPS = 'Phillips & Russell (1987), GRL 14, upper limit on the intrinsic magnetic field of Venus';
const AITTA = 'Aitta (2012), Icarus 218, Venus\' internal structure, temperature and core composition';
const VENERA = 'Surkov et al. (1984), JGR 89, new data on the composition, structure, and properties of Venus rock (Venera 13 and 14)';
const MEAN_RADIUS = 6051.8;

export const VENUS_MODEL: InteriorModel = {
  body: 'Venus',
  modelId: 'venus-radar-moi',
  title: 'Radar and tides',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A core about half the radius under a silicate mantle and a basaltic crust, like Earth\'s in outline. No seismometer has run there, the core\'s state is unmeasured, and no dynamo runs.',
  regions: [
    {
      key: 'core',
      name: 'Core',
      family: 'metal',
      phase: 'unresolved',
      outerRadiusKm: 3100,
      boundary: sharp(modelSpread(2900, 3300, ['Dumoulin 2017', 'Aitta 2012'])),
      composition: sourced('Iron and nickel with light elements, by analogy with Earth', AITTA, 'modelled'),
      temperatureK: endpoints(5000, 4000, AITTA, 'modelled'),
      pressureGPa: endpoints(290, 120, AITTA, 'modelled'),
      densityKgM3: endpoints(12000, 10000, AITTA, 'modelled'),
      heat: heat([{ kind: 'primordial', note: 'Heat of formation; without a dynamo, whether the core convects is unknown.' }], null, 'unresolved'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', MARGOT, { observed: 'Fifteen years of Earth-based radar tracking of Venus\'s spin give a moment of inertia of 0.337 ± 0.024', inferred: 'Mass concentrated toward the centre: a dense core', assumed: 'Hydrostatic equilibrium', uncertain: 'The core radius from this alone spans hundreds of km', year: 2021 }),
          row('density', 'supports', DUMOULIN, { observed: 'Bulk density 5243 kg/m³ in a body Earth\'s size', inferred: 'An iron core of roughly Earth\'s proportion', assumed: 'Earth-like composition', uncertain: '—', year: 2017 }),
          row('tides', 'supports', KONOPLIV, { observed: 'Magellan tracking gives a tidal Love number k₂ of 0.295 ± 0.066', inferred: 'The interior deforms enough that the core is probably at least partly liquid', assumed: 'Mantle viscosity', uncertain: 'A solid core is not excluded at the low end', mission: 'Magellan', year: 1996 }),
        ]),
        claim('state', [
          row('tides', 'constrains', DUMOULIN, { observed: 'k₂ against interior models', inferred: 'Liquid or partly liquid favoured', assumed: 'Mantle rheology', uncertain: 'Open', year: 2017 }),
          row('magnetic', 'constrains', PHILLIPS, { observed: 'No intrinsic magnetic field to the limit of measurement', inferred: 'No dynamo: either the core does not convect, or it is stably stratified, or solid', assumed: '—', uncertain: 'Which', mission: 'Pioneer Venus', year: 1987 }),
        ]),
      ],
    },
    {
      key: 'mantle',
      name: 'Mantle',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: MEAN_RADIUS - 30,
      boundary: sharp(modelSpread(MEAN_RADIUS - 65, MEAN_RADIUS - 20, ['James 2013'])),
      composition: sourced('Peridotite, by analogy with Earth', AITTA, 'modelled'),
      temperatureK: endpoints(4000, 1500, AITTA, 'modelled'),
      pressureGPa: endpoints(120, 1, AITTA, 'modelled'),
      densityKgM3: endpoints(5500, 3300, AITTA, 'modelled'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium; with no plate tectonics the heat leaves in episodes.' }], 'Heat from the core', 'convection'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', MARGOT, { observed: 'Moment of inertia and density', inferred: 'A rocky mantle over the core', assumed: 'Hydrostatic Venus', uncertain: 'Its exact thickness', year: 2021 }),
          row('gravity', 'supports', JAMES, { observed: 'Magellan gravity and topography', inferred: 'A mantle that supports the highlands dynamically', assumed: 'A crust and lithosphere model', uncertain: 'Lithosphere thickness', mission: 'Magellan', year: 2013 }),
        ]),
      ],
    },
    {
      key: 'crust',
      name: 'Crust',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: MEAN_RADIUS,
      boundary: sharp(),
      composition: sourced('Basalt, measured by the Venera landers', VENERA, 'measured'),
      temperatureK: endpoints(1500, 737, AITTA, 'modelled'),
      pressureGPa: endpoints(1, 0, AITTA, 'modelled'),
      densityKgM3: endpoints(2900, 2800, JAMES, 'inferred'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Heat-producing elements in the crust.' }], 'Heat from the mantle, and a surface at 737 K under the atmosphere', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', VENERA, { observed: 'Venera 13 and 14 analysed basaltic rock at the surface', inferred: 'A basaltic crust', assumed: '—', uncertain: 'Its depth', mission: 'Venera', year: 1984 }),
          row('gravity', 'supports', JAMES, { observed: 'Gravity against topography', inferred: 'A crust 20–65 km thick, thickest under the highlands', assumed: 'Isostasy plus dynamic support', uncertain: 'The split between the two', mission: 'Magellan', year: 2013 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [MARGOT, KONOPLIV, DUMOULIN, JAMES, PHILLIPS, AITTA, VENERA],
};
