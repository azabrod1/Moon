/**
 * Earth — the reference case: the one body whose interior is measured from
 * the inside. PREM radii; the temperatures are the textbook profile with
 * its known range at the core. PROVISIONAL: authored from the standard
 * literature, awaiting scientific review.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, interval, modelSpread, row, sharp, sourced } from '../modelHelpers';

const PREM = 'Dziewonski & Anderson (1981), Preliminary Reference Earth Model, PEPI 25';
const LEHMANN = 'Lehmann (1936), "P′", Publ. Bur. Centr. Seism. Int. A 14';
const OLDHAM = 'Oldham (1906), QJGS 62; Gutenberg (1914), Nachr. Ges. Wiss. Göttingen';
const ANZELLINI = 'Anzellini et al. (2013), Science 340, melting of iron at Earth\'s inner core boundary';
const DAVIES = 'Davies & Davies (2010), Solid Earth 1, Earth\'s surface heat flux';
const GLATZMAIER = 'Glatzmaier & Roberts (1995), Nature 377, a three-dimensional self-consistent computer simulation of a geomagnetic field reversal';
const HIROSE = 'Hirose, Labrosse & Hernlund (2013), Annu. Rev. Earth Planet. Sci. 41, composition and state of the core';
const RINGWOOD = 'Ringwood (1975), Composition and Petrology of the Earth\'s Mantle';
const KATSURA = 'Katsura et al. (2010), PEPI 183, adiabatic temperature profile in the mantle';
const WATTS = 'Watts (2001), Isostasy and Flexure of the Lithosphere (Cambridge)';

export const EARTH_MODEL: InteriorModel = {
  body: 'Earth',
  modelId: 'earth-prem',
  title: 'PREM',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: 6371,
  overview: 'A solid iron inner core inside a liquid iron outer core, wrapped in a thick silicate mantle under a thin crust. Earthquake waves cross every layer, so the boundaries are measured, not modelled.',
  heatFlowTW: sourced(47, DAVIES, 'measured', '±2 TW'),
  regions: [
    {
      key: 'innerCore',
      name: 'Inner core',
      family: 'metal',
      phase: 'solid',
      outerRadiusKm: 1221.5,
      boundary: sharp(interval(1215, 1225, 0.9, PREM)),
      composition: sourced('Iron and nickel, a few percent light elements', HIROSE, 'inferred'),
      temperatureK: endpoints(5700, 5400, ANZELLINI, 'inferred'),
      pressureGPa: endpoints(364, 329, PREM, 'inferred'),
      densityKgM3: endpoints(13090, 12760, PREM, 'inferred'),
      heat: heat([{ kind: 'latentCrystallisation', note: 'The inner core grows as the outer core freezes onto it, releasing latent heat and light elements.' }], 'Conduction from the outer core', 'conduction'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', LEHMANN, { observed: 'Faint P-wave arrivals inside the core shadow zone', inferred: 'A boundary deep in the core reflects and refracts them', assumed: 'A spherically symmetric core', uncertain: 'Nothing about its size from this alone', year: 1936 }),
          row('normalModes', 'supports', PREM, { observed: 'The periods of Earth\'s free oscillations after great earthquakes', inferred: 'A solid core of this radius and rigidity fits them', assumed: 'Elastic, self-gravitating Earth', uncertain: 'Anisotropy and fine structure' }),
          row('labHighPressure', 'supports', ANZELLINI, { observed: 'Iron\'s melting temperature at core pressures in a laser-heated diamond anvil', inferred: 'Iron is solid at the inner-core boundary temperature', assumed: 'Light elements change the melting point modestly', uncertain: 'The exact composition, hence the exact melting point', year: 2013 }),
        ]),
        claim('state', [
          row('seismology', 'supports', PREM, { observed: 'Shear waves that cross the inner core (PKJKP), and its shear-mode oscillations', inferred: 'It is solid', assumed: 'Shear waves need rigidity', uncertain: 'Its viscosity and whether it convects' }),
        ]),
        claim('temperature', [
          row('labHighPressure', 'supports', ANZELLINI, { observed: 'Iron melts near 6230 ± 500 K at 330 GPa', inferred: 'The boundary sits near the melting point, a little below it with light elements', assumed: 'Light elements depress melting by a few hundred kelvin', uncertain: 'Several hundred kelvin', year: 2013 }),
        ]),
      ],
    },
    {
      key: 'outerCore',
      name: 'Outer core',
      family: 'metal',
      phase: 'liquidMetal',
      outerRadiusKm: 3480,
      boundary: sharp(interval(3478, 3482, 0.9, PREM)),
      composition: sourced('Liquid iron and nickel with about a tenth light elements (S, Si, O, H)', HIROSE, 'inferred'),
      temperatureK: endpoints(5400, 4000, HIROSE, 'inferred'),
      pressureGPa: endpoints(329, 136, PREM, 'inferred'),
      densityKgM3: endpoints(12170, 9900, PREM, 'inferred'),
      heat: heat([
        { kind: 'primordial', note: 'Heat of formation still leaving the core.' },
        { kind: 'latentCrystallisation', note: 'Freezing onto the inner core releases latent heat and buoyant light elements that stir the fluid.' },
      ], null, 'convection'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', OLDHAM, { observed: 'No direct S waves beyond 104° from an earthquake, and P waves bent into a shadow zone', inferred: 'A fluid region at this depth that shear waves cannot cross', assumed: 'Shear waves need a solid', uncertain: 'The precise radius from this alone', year: 1914 }),
          row('normalModes', 'supports', PREM, { observed: 'Free-oscillation periods', inferred: 'A fluid shell of this radius and density', assumed: 'Elastic Earth', uncertain: 'Fine structure at its top and bottom' }),
          row('magnetic', 'supports', GLATZMAIER, { observed: 'Earth\'s dipole field and its secular variation and reversals', inferred: 'A convecting conducting fluid deep inside sustains a dynamo', assumed: 'Dynamo theory', uncertain: 'The details of the flow', year: 1995 }),
          row('labHighPressure', 'supports', ANZELLINI, { observed: 'Iron\'s melting curve to core pressures', inferred: 'Iron is molten at outer-core conditions', assumed: 'A modest depression from light elements', uncertain: 'Composition', year: 2013 }),
        ]),
        claim('state', [
          row('seismology', 'supports', OLDHAM, { observed: 'The S-wave shadow', inferred: 'Liquid', assumed: 'Shear waves need rigidity', uncertain: 'Nothing material' }),
        ]),
        claim('temperature', [
          row('labHighPressure', 'supports', ANZELLINI, { observed: 'Iron\'s melting temperature at the inner-core boundary pressure', inferred: 'The temperature at the bottom of the outer core, a little below iron\'s melting point', assumed: 'Light elements depress melting by a few hundred kelvin', uncertain: '±500 K', year: 2013 }),
          row('model', 'supports', HIROSE, { observed: 'The inner-core boundary temperature and the core adiabat', inferred: 'About 4000 K at the top of the core', assumed: 'An adiabatic, well-mixed outer core', uncertain: '±500 K' }),
        ]),
      ],
    },
    {
      key: 'lowerMantle',
      name: 'Lower mantle',
      family: 'silicate',
      phase: 'solid',
      rheology: 'Solid, but creeping: it convects over millions of years',
      outerRadiusKm: 5711,
      boundary: sharp(interval(5705, 5716, 0.9, PREM)),
      composition: sourced('Bridgmanite and ferropericlase (magnesium-iron silicate and oxide)', RINGWOOD, 'inferred'),
      temperatureK: endpoints(3700, 1900, KATSURA, 'inferred'),
      pressureGPa: endpoints(136, 24, PREM, 'inferred'),
      densityKgM3: endpoints(5570, 4380, PREM, 'inferred'),
      heat: heat([
        { kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium decaying throughout the mantle.' },
        { kind: 'primordial', note: 'Heat of formation and of core separation, still escaping.' },
      ], 'Heat from the core below', 'convection'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', PREM, { observed: 'Smoothly rising wave speeds from 660 km down to 2891 km, with a sharp drop at the core', inferred: 'One thick solid shell above the core', assumed: 'Spherical symmetry to first order', uncertain: 'Lateral structure; the D″ layer at its base' }),
          row('labHighPressure', 'supports', RINGWOOD, { observed: 'Olivine and pyroxene transform to denser perovskite-structured minerals at 660-km pressures', inferred: 'The lower mantle is bridgmanite-dominated', assumed: 'A peridotitic bulk composition', uncertain: 'The iron content and the amount of subducted crust mixed in' }),
        ]),
        claim('temperature', [
          row('labHighPressure', 'supports', KATSURA, { observed: 'The pressures at which olivine transforms in the laboratory, against the seismic depths of the 410 and 660 km discontinuities', inferred: 'An adiabat near 1900 K at 660 km', assumed: 'Whole-mantle convection', uncertain: 'The steep thermal boundary layer at the core', year: 2010 }),
        ]),
      ],
    },
    {
      key: 'upperMantle',
      name: 'Upper mantle',
      family: 'silicate',
      phase: 'solid',
      rheology: 'Solid; the top ~100 km is rigid lithosphere, below that it creeps',
      outerRadiusKm: 6336,
      boundary: distributed(20, PREM, modelSpread(6301, 6364, ['oceanic crust 7 km', 'continental crust 70 km']), null),
      composition: sourced('Peridotite: olivine, pyroxene and garnet', RINGWOOD, 'inferred'),
      temperatureK: endpoints(1900, 800, KATSURA, 'inferred'),
      pressureGPa: endpoints(24, 1, PREM, 'inferred'),
      densityKgM3: endpoints(3990, 3380, PREM, 'inferred'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium.' }], 'Heat from the lower mantle', 'convection'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', PREM, { observed: 'Wave speeds between the Moho and the 660-km discontinuity, with a jump at 410 km', inferred: 'A distinct shell whose minerals change phase with depth', assumed: 'Spherical symmetry', uncertain: 'Lateral variation is large here' }),
          row('sample', 'supports', RINGWOOD, { observed: 'Mantle rock brought up in kimberlites and ophiolites', inferred: 'Peridotite composition', assumed: 'Samples are representative', uncertain: 'Below ~200 km nothing is sampled' }),
        ]),
      ],
    },
    {
      key: 'crust',
      name: 'Crust',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 6371,
      boundary: sharp(),
      composition: sourced('Basalt under the oceans, granite-dominated continents', RINGWOOD, 'measured'),
      temperatureK: endpoints(800, 288, KATSURA, 'inferred'),
      pressureGPa: endpoints(1, 0, PREM, 'inferred'),
      densityKgM3: endpoints(2900, 2600, PREM, 'measured'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Continental crust is rich in uranium, thorium and potassium.' }], 'Heat from the mantle', 'conduction'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', PREM, { observed: 'The Mohorovičić discontinuity: a jump in wave speed a few tens of km down', inferred: 'A distinct outer shell', assumed: '—', uncertain: 'Its thickness varies from 7 km to 70 km' }),
          row('sample', 'supports', RINGWOOD, { observed: 'Rock at the surface and in boreholes to 12 km', inferred: 'Its composition', assumed: '—', uncertain: 'The lower crust is inferred' }),
          row('gravity', 'supports', WATTS, { observed: 'Mountains are not as heavy as they look: gravity over ranges falls short of their topography', inferred: 'A light crust floating on a denser mantle, thick under mountains (isostasy)', assumed: 'Airy or Pratt compensation', uncertain: 'The exact root depths' }),
        ]),
      ],
    },
  ],
  annotations: [
    { name: 'Lithosphere', innerRadiusKm: 6271, outerRadiusKm: 6371, note: 'The rigid plate: crust plus the cold top of the mantle, about 100 km.', source: RINGWOOD },
    { name: 'Transition zone', innerRadiusKm: 5711, outerRadiusKm: 5961, note: 'Between the 410 and 660 km discontinuities, where olivine transforms to denser phases.', source: PREM },
    { name: 'D″ layer', innerRadiusKm: 3480, outerRadiusKm: 3680, note: 'The lowest ~200 km of the mantle, hot and heterogeneous, above the core.', source: PREM },
  ],
  sources: [PREM, LEHMANN, OLDHAM, ANZELLINI, DAVIES, GLATZMAIER, HIROSE, RINGWOOD, KATSURA, WATTS],
};
