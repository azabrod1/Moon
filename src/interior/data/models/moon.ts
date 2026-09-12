/**
 * The Moon — the only other body with seismometers on it (Apollo, 1969–77),
 * a network small and noisy enough that its core was only argued from the
 * data decades later. PROVISIONAL: awaiting scientific review.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, interval, modelSpread, qualitative, row, sharp, sourced } from '../modelHelpers';

const WEBER = 'Weber et al. (2011), Science 331, seismic detection of the lunar core';
const BRIAUD = 'Briaud et al. (2023), Nature 617, the lunar solid inner core and the mantle overturn';
const WILLIAMS = 'Williams et al. (2001), JGR 106, lunar rotational dissipation in solid body and molten core';
const WIECZOREK = 'Wieczorek et al. (2013), Science 339, the crust of the Moon as seen by GRAIL';
const HOOD = 'Hood et al. (1999), GRL 26, initial measurements of the lunar induced magnetic dipole moment (Lunar Prospector)';
const APOLLO = 'Taylor (1982), Planetary Science: A Lunar Perspective (Apollo samples)';
const KHAN = 'Khan et al. (2014), JGR Planets 119, geophysical evidence for melt in the deep lunar interior';

export const MOON_MODEL: InteriorModel = {
  body: 'Moon',
  modelId: 'moon-apollo-grail',
  title: 'Apollo and GRAIL',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: 1737.4,
  overview: 'A small iron core, possibly with a solid centre, under a thick mantle and a crust thinner than once thought. The Apollo seismometers heard it faintly; laser ranging and GRAIL gravity did the rest.',
  regions: [
    {
      key: 'innerCore',
      name: 'Inner core',
      family: 'metal',
      phase: 'solid',
      outerRadiusKm: 240,
      boundary: sharp(modelSpread(200, 280, ['Weber 2011', 'Briaud 2023'])),
      composition: sourced('Iron, probably with some nickel and sulphur', BRIAUD, 'inferred'),
      temperatureK: endpoints(1700, 1650, KHAN, 'modelled'),
      pressureGPa: endpoints(5.2, 5.0, WEBER, 'modelled'),
      densityKgM3: endpoints(7800, 7800, BRIAUD, 'inferred'),
      heat: heat([{ kind: 'latentCrystallisation', note: 'If it is still growing, freezing releases latent heat.' }], 'conduction from the outer core', 'conduction'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', WEBER, { observed: 'Weak reflections in stacked Apollo seismograms at the depth expected for a solid inner core', inferred: 'A solid centre about 240 km across', assumed: 'Array stacking recovers real reflections from noisy records', uncertain: 'The signal is faint; other studies do not require it', mission: 'Apollo', year: 2011 }),
          row('momentOfInertia', 'supports', BRIAUD, { observed: 'The Moon\'s moment of inertia, tidal Love number and density', inferred: 'Interior models with a ~258 km solid inner core fit best', assumed: 'Plausible mantle mineralogy and thermal state', uncertain: 'The inner core is a model preference, not a detection', year: 2023 }),
        ]),
      ],
    },
    {
      key: 'outerCore',
      name: 'Outer core',
      family: 'metal',
      phase: 'liquidMetal',
      outerRadiusKm: 330,
      boundary: sharp(interval(310, 350, 0.68, WEBER)),
      composition: sourced('Liquid iron with sulphur', WEBER, 'inferred'),
      temperatureK: endpoints(1650, 1600, KHAN, 'modelled'),
      pressureGPa: endpoints(5.0, 4.6, WEBER, 'modelled'),
      densityKgM3: endpoints(5100, 5100, WEBER, 'inferred'),
      heat: heat([{ kind: 'primordial', note: 'Residual heat; there is no dynamo today.' }], null, 'convection'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', WEBER, { observed: 'Stacked reflections from the core boundary', inferred: 'A fluid outer core of about 330 km radius', assumed: 'Reflections are real, not stacking artefacts', uncertain: 'Radius by ±20 km or more', mission: 'Apollo', year: 2011 }),
          row('libration', 'supports', WILLIAMS, { observed: 'Lunar laser ranging: dissipation in the Moon\'s rotation', inferred: 'A fluid core sloshing against the mantle', assumed: 'Dissipation is core-mantle friction, not only tidal', uncertain: 'The share from tides', year: 2001 }),
          row('magnetic', 'supports', HOOD, { observed: 'An induced magnetic dipole as the Moon crosses the geomagnetic tail', inferred: 'A conducting core about 340 km in radius', assumed: 'Conductivity is the core\'s, not the mantle\'s', uncertain: 'Radius to within ~90 km', mission: 'Lunar Prospector', year: 1999 }),
          row('momentOfInertia', 'supports', WIECZOREK, { observed: 'Moment of inertia 0.3931 ± 0.0002', inferred: 'A small dense core is required', assumed: 'Mantle density profile', uncertain: 'Core size trades against mantle density', mission: 'GRAIL', year: 2013 }),
        ]),
        claim('state', [
          row('libration', 'supports', WILLIAMS, { observed: 'Rotational dissipation', inferred: 'Fluid', assumed: 'As above', uncertain: 'As above', year: 2001 }),
        ]),
      ],
    },
    {
      key: 'partialMeltLayer',
      name: 'Deep partial melt',
      family: 'silicate',
      phase: 'partialMelt',
      outerRadiusKm: 480,
      boundary: distributed(50, KHAN, qualitative('Whether this layer exists at all is contested; its top is a model boundary'), null),
      composition: sourced('Silicate rock with a few percent melt, possibly enriched in titanium', KHAN, 'modelled'),
      temperatureK: endpoints(1600, 1500, KHAN, 'modelled'),
      pressureGPa: endpoints(4.6, 4.0, WEBER, 'modelled'),
      densityKgM3: endpoints(3400, 3400, WEBER, 'modelled'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Heat-producing elements concentrated in late-crystallising material that sank.' }, { kind: 'tidal', note: 'Tidal flexing by Earth dissipates most where the rock is soft.' }], 'heat from the core', 'mixed'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', WEBER, { observed: 'A low-velocity zone above the core in the stacked data', inferred: 'Partially molten rock at the base of the mantle', assumed: 'Reflections are real', uncertain: 'Thickness and melt fraction', mission: 'Apollo', year: 2011 }),
          row('tides', 'supports', KHAN, { observed: 'The Moon\'s tidal dissipation is frequency-dependent in a way solid rock does not produce', inferred: 'A soft, partially molten layer at depth', assumed: 'Melt is what softens it', uncertain: 'A very hot solid layer can mimic it', year: 2014 }),
          row('model', 'challenges', BRIAUD, { observed: 'Interior models fitting the same geodetic data', inferred: 'They fit without any melt layer', assumed: 'A mantle overturn explains the deep density', uncertain: 'Both families fit within the error bars', year: 2023 }),
        ]),
      ],
    },
    {
      key: 'mantle',
      name: 'Mantle',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 1697,
      boundary: sharp(interval(1690, 1705, 0.68, WIECZOREK)),
      composition: sourced('Olivine and pyroxene, iron-richer than Earth\'s mantle', APOLLO, 'inferred'),
      temperatureK: endpoints(1500, 600, KHAN, 'modelled'),
      pressureGPa: endpoints(4.0, 0.2, WEBER, 'modelled'),
      densityKgM3: endpoints(3400, 3300, WIECZOREK, 'inferred'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium.' }], null, 'conduction'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', WEBER, { observed: 'Moonquake waves travelling through it for decades of records', inferred: 'A thick solid silicate shell', assumed: '—', uncertain: 'Its lower reaches are poorly sampled', mission: 'Apollo', year: 2011 }),
          row('sample', 'supports', APOLLO, { observed: 'Mare basalts, melted from the mantle and brought back', inferred: 'Its composition where they came from', assumed: 'Basalts sample the mantle faithfully', uncertain: 'The deep mantle', mission: 'Apollo' }),
        ]),
      ],
    },
    {
      key: 'crust',
      name: 'Crust',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 1737.4,
      boundary: sharp(),
      composition: sourced('Anorthosite highlands, basalt in the maria', APOLLO, 'measured'),
      temperatureK: endpoints(600, 250, KHAN, 'modelled'),
      pressureGPa: endpoints(0.2, 0, WEBER, 'modelled'),
      densityKgM3: endpoints(2550, 2550, WIECZOREK, 'measured'),
      heat: heat([{ kind: 'radiogenicDecay', note: 'Concentrated in the Procellarum KREEP terrane.' }], 'heat from the mantle', 'conduction'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', WIECZOREK, { observed: 'GRAIL\'s gravity field resolves the crust\'s density and thickness', inferred: 'A crust 34–43 km thick on average, porous', assumed: 'Crustal density from Apollo samples', uncertain: 'Thickness under the far side', mission: 'GRAIL', year: 2013 }),
          row('sample', 'supports', APOLLO, { observed: 'Returned rocks', inferred: 'Composition', assumed: '—', uncertain: '—', mission: 'Apollo' }),
          row('seismology', 'supports', WEBER, { observed: 'Crustal wave speeds under the Apollo sites', inferred: 'A distinct crust', assumed: '—', uncertain: 'Global thickness', mission: 'Apollo', year: 2011 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [WEBER, BRIAUD, WILLIAMS, WIECZOREK, HOOD, APOLLO, KHAN],
};
