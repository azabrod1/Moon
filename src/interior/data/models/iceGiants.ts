/**
 * Uranus and Neptune — one Voyager flyby each, so the interior is a fit to
 * mass, radius, two gravity harmonics and a strange magnetic field. Two
 * pictures fit: a layered one, rock core under a deep layer of water,
 * ammonia and methane fluids (ionic, superionic at depth) under a
 * hydrogen envelope; and a fuzzy one, the same materials in gradients with
 * no sharp boundaries. Both are drawn for each planet. Neptune is the
 * denser and hotter twin, with a real internal heat flux. PROVISIONAL.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, qualitative, row, sharp, sourced } from '../modelHelpers';

const HELLED_2011 = 'Helled, Anderson, Podolak & Schubert (2011), ApJ 726, interior models of Uranus and Neptune';
const NETTELMANN = 'Nettelmann et al. (2013), PSS 77, new indication for a dichotomy in the interior structure of Uranus and Neptune';
const HELLED_FORTNEY = 'Helled & Fortney (2020), Phil. Trans. R. Soc. A 378, the interiors of Uranus and Neptune: current understanding and open questions';
const MILLOT = 'Millot et al. (2019), Nature 569, nanosecond X-ray diffraction of shock-compressed superionic water ice';
const STANLEY = 'Stanley & Bloxham (2004), Nature 428, convective-region geometry as the cause of Uranus\' and Neptune\'s unusual magnetic fields';
const NESS_URANUS = 'Ness et al. (1986), Science 233, magnetic fields at Uranus (Voyager 2)';
const NESS_NEPTUNE = 'Ness et al. (1989), Science 246, magnetic fields at Neptune (Voyager 2)';
const TYLER_URANUS = 'Tyler et al. (1986), Science 233, Voyager 2 radio science observations of the Uranian system';
const TYLER_NEPTUNE = 'Tyler et al. (1989), Science 246, Voyager radio science observations of Neptune and Triton';
const PEARL = 'Pearl & Conrath (1991), JGR 96, the albedo, effective temperature, and energy balance of Neptune, as determined from Voyager data';
const LINDAL_URANUS = 'Lindal et al. (1987), JGR 92, the atmosphere of Uranus: results of radio occultation measurements with Voyager 2';
const LINDAL_NEPTUNE = 'Lindal (1992), AJ 103, the atmosphere of Neptune: an analysis of radio occultation data acquired with Voyager 2';

interface IceGiantFacts {
  body: 'Uranus' | 'Neptune';
  radiusKm: number;
  gravitySource: string;
  magneticSource: string;
  atmosphereSource: string;
  /** Surface (1-bar) temperature, K. */
  surfaceK: number;
  /** Centre temperature, K, modelled. */
  centreK: number;
  bulkDensity: number;
}

const URANUS: IceGiantFacts = { body: 'Uranus', radiusKm: 25_362, gravitySource: TYLER_URANUS, magneticSource: NESS_URANUS, atmosphereSource: LINDAL_URANUS, surfaceK: 76, centreK: 5500, bulkDensity: 1270 };
const NEPTUNE: IceGiantFacts = { body: 'Neptune', radiusKm: 24_622, gravitySource: TYLER_NEPTUNE, magneticSource: NESS_NEPTUNE, atmosphereSource: LINDAL_NEPTUNE, surfaceK: 72, centreK: 7000, bulkDensity: 1638 };

function envelope(facts: IceGiantFacts): Region[] {
  const atmosphereBaseKm = facts.radiusKm - 650;
  return [
    {
      key: 'envelope',
      name: 'Hydrogen envelope',
      family: 'hydrogen',
      phase: 'supercriticalFluid',
      outerRadiusKm: atmosphereBaseKm,
      boundary: distributed(300, facts.atmosphereSource, null, null),
      composition: sourced('Hydrogen and helium with methane, a dense fluid below the clouds', HELLED_FORTNEY, 'modelled'),
      temperatureK: endpoints(2500, 350, HELLED_2011, 'modelled'),
      pressureGPa: endpoints(20, 0.1, HELLED_2011, 'modelled'),
      densityKgM3: endpoints(500, 30, HELLED_2011, 'modelled'),
      heat: heat([{ kind: 'gravitationalContraction', note: 'Slow contraction since formation.' }], 'heat from below', 'convection'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', facts.gravitySource, { observed: `Voyager 2's tracking gives the mass and the gravity harmonics J₂ and J₄, with a bulk density of ${facts.bulkDensity} kg/m³`, inferred: 'A light outer envelope of hydrogen and helium over denser material', assumed: 'A rotation rate', uncertain: 'Its mass fraction, 5–20%', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
          row('inSitu', 'supports', facts.atmosphereSource, { observed: 'Radio occultation profiles of the upper atmosphere', inferred: 'Hydrogen, helium and methane', assumed: '—', uncertain: 'Below the probed pressures', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1987 : 1992 }),
        ]),
      ],
    },
    {
      key: 'atmosphere',
      name: 'Outer atmosphere',
      family: 'hydrogen',
      phase: 'gas',
      outerRadiusKm: facts.radiusKm,
      boundary: sharp(),
      composition: sourced('Hydrogen and helium with methane, which paints it blue', facts.atmosphereSource, 'measured'),
      temperatureK: endpoints(350, facts.surfaceK, facts.atmosphereSource, 'measured'),
      pressureGPa: endpoints(0.1, 0, facts.atmosphereSource, 'measured'),
      densityKgM3: endpoints(30, 0.4, facts.atmosphereSource, 'measured'),
      heat: heat([{ kind: 'none', note: facts.body === 'Neptune' ? 'Warmed from below more than by the Sun.' : 'Warmed by faint sunlight; almost no heat from below.' }], 'sunlight and heat from below', 'convection'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', facts.atmosphereSource, { observed: 'Occultation temperature and pressure profiles', inferred: 'The weather layer', assumed: '—', uncertain: '—', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1987 : 1992 }),
        ]),
      ],
    },
  ];
}

function layeredModel(facts: IceGiantFacts): InteriorModel {
  const coreKm = Math.round(facts.radiusKm * 0.2);
  const superionicKm = Math.round(facts.radiusKm * 0.5);
  const fluidKm = Math.round(facts.radiusKm * 0.8);
  const centreK = facts.centreK;
  return {
    body: facts.body,
    modelId: `${facts.body.toLowerCase()}-layered`,
    title: 'Layered',
    version: '0.1',
    review: 'provisional',
    reviewedOn: '2026-09-11',
    epoch: 'present',
    radiusConvention: 'volumetricMean',
    referenceRadiusKm: facts.radiusKm,
    overview: facts.body === 'Uranus'
      ? 'A rock core under a deep layer of water, ammonia and methane fluids, superionic at depth, under a hydrogen envelope: the classical three-layer Uranus, fit to one flyby.'
      : 'The same three layers as Uranus, denser and warmer, with a real flow of internal heat: the classical picture of Neptune, fit to one flyby.',
    regions: [
      {
        key: 'core',
        name: 'Rock core',
        family: 'silicate',
        phase: 'solid',
        outerRadiusKm: coreKm,
        boundary: sharp(modelSpread(Math.round(facts.radiusKm * 0.12), Math.round(facts.radiusKm * 0.28), ['Helled 2011', 'Nettelmann 2013'])),
        composition: sourced('Rock and perhaps iron, about an Earth mass', HELLED_2011, 'modelled'),
        temperatureK: endpoints(centreK, Math.round(centreK * 0.85), HELLED_2011, 'modelled'),
        pressureGPa: endpoints(800, 500, HELLED_2011, 'modelled'),
        densityKgM3: endpoints(10_000, 8000, HELLED_2011, 'modelled'),
        heat: heat([{ kind: 'radiogenicDecay', note: 'Decay in the rock, a small part of the budget.' }], null, 'conduction'),
        claims: [
          claim('existence', [
            row('gravity', 'supports', facts.gravitySource, { observed: 'Mass, radius and the low-order gravity harmonics', inferred: 'Dense material concentrated at the centre; a rock core of order an Earth mass fits', assumed: 'A three-layer structure and equations of state', uncertain: 'The core size trades against the ice layer\'s composition; a core is not required', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
            row('model', 'challenges', HELLED_FORTNEY, { observed: 'The same data fit by gradual composition gradients', inferred: 'No distinct rock core is needed', assumed: 'Mixed, non-adiabatic interiors', uncertain: 'Both fit', year: 2020 }),
          ]),
        ],
      },
      {
        key: 'superionicIce',
        name: 'Superionic water',
        family: 'water',
        phase: 'superionic',
        outerRadiusKm: superionicKm,
        boundary: distributed(2000, MILLOT, modelSpread(Math.round(facts.radiusKm * 0.4), Math.round(facts.radiusKm * 0.6), ['Millot 2019 phase boundary']), qualitative('Where the fluid becomes superionic depends on the temperature profile')),
        composition: sourced('Water with ammonia and methane, its oxygen locked in a lattice while protons flow through it', MILLOT, 'modelled'),
        temperatureK: endpoints(Math.round(centreK * 0.85), 3000, HELLED_2011, 'modelled'),
        pressureGPa: endpoints(500, 100, HELLED_2011, 'modelled'),
        densityKgM3: endpoints(4500, 3000, HELLED_2011, 'modelled'),
        heat: heat([{ kind: 'gravitationalContraction', note: 'Formation heat, leaving slowly.' }], 'heat from the core', 'conduction'),
        claims: [
          claim('existence', [
            row('labHighPressure', 'supports', MILLOT, { observed: 'Shock-compressed water ice X-rayed at 100–400 GPa forms a superionic crystal', inferred: 'The deep ice layer of Uranus and Neptune is superionic', assumed: 'The planets\' pressure and temperature profiles', uncertain: 'The exact boundary', year: 2019 }),
            row('magnetic', 'supports', facts.magneticSource, { observed: 'A magnetic field tilted far from the spin axis and offset from the centre', inferred: 'The dynamo runs in a thin outer shell, not deep: the deep interior does not convect, as a superionic layer would not', assumed: 'Dynamo geometry models', uncertain: 'Alternative geometries', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
          ]),
        ],
      },
      {
        key: 'ionicFluid',
        name: 'Ionic water ocean',
        family: 'ionicFluid',
        phase: 'liquid',
        outerRadiusKm: fluidKm,
        boundary: distributed(1500, HELLED_2011, modelSpread(Math.round(facts.radiusKm * 0.7), Math.round(facts.radiusKm * 0.85), ['Helled 2011', 'Nettelmann 2013'])),
        composition: sourced('Water, ammonia and methane as a hot, electrically conducting fluid', HELLED_2011, 'modelled'),
        temperatureK: endpoints(3000, 2500, HELLED_2011, 'modelled'),
        pressureGPa: endpoints(100, 20, HELLED_2011, 'modelled'),
        densityKgM3: endpoints(3000, 1200, HELLED_2011, 'modelled'),
        heat: heat([{ kind: 'gravitationalContraction', note: 'Formation heat, carried by convection in this shell.' }], 'heat from below', 'convection'),
        claims: [
          claim('existence', [
            row('gravity', 'supports', facts.gravitySource, { observed: 'Gravity harmonics and density', inferred: 'A thick layer of "ice" (water, ammonia, methane) makes up most of the mass', assumed: 'Three layers', uncertain: 'Its rock content', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
            row('magnetic', 'supports', STANLEY, { observed: 'The tilted, offset field', inferred: 'A dynamo in a thin conducting fluid shell: ionic water', assumed: 'Convection confined to this shell', uncertain: 'Shell thickness', year: 2004 }),
          ]),
          claim('state', [
            row('magnetic', 'supports', facts.magneticSource, { observed: 'A dynamo exists', inferred: 'A conducting fluid that convects', assumed: '—', uncertain: '—', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
          ]),
        ],
      },
      ...envelope(facts),
    ],
    annotations: [],
    sources: [HELLED_2011, NETTELMANN, HELLED_FORTNEY, MILLOT, STANLEY, facts.magneticSource, facts.gravitySource, facts.atmosphereSource, ...(facts.body === 'Neptune' ? [PEARL] : [])],
  };
}

function fuzzyModel(facts: IceGiantFacts, layered: InteriorModel): InteriorModel {
  const innerKm = Math.round(facts.radiusKm * 0.35);
  const middleKm = Math.round(facts.radiusKm * 0.8);
  const centreK = facts.centreK;
  return {
    ...layered,
    modelId: `${facts.body.toLowerCase()}-fuzzy`,
    title: 'Gradients',
    overview: 'The same materials with no sharp boundaries: rock-rich at the centre grading into water-rich, grading into hydrogen, the interior never fully separated. It fits the flyby data as well as layers do.',
    regions: [
      {
        key: 'rockRichCentre',
        name: 'Rock-rich centre',
        family: 'mixed',
        phase: 'unresolved',
        outerRadiusKm: innerKm,
        boundary: distributed(Math.round(facts.radiusKm * 0.2), HELLED_FORTNEY, null, qualitative('A gradient, not a surface')),
        composition: sourced('Rock mixed with water, its proportion falling outward', HELLED_FORTNEY, 'modelled'),
        temperatureK: endpoints(centreK, 4000, HELLED_FORTNEY, 'modelled'),
        pressureGPa: endpoints(800, 200, HELLED_FORTNEY, 'modelled'),
        densityKgM3: endpoints(9000, 4000, HELLED_FORTNEY, 'modelled'),
        heat: heat([{ kind: 'gravitationalContraction', note: 'Formation heat trapped by composition gradients that stop convection.' }], null, 'conduction'),
        claims: [
          claim('existence', [
            row('model', 'supports', HELLED_FORTNEY, { observed: 'Interior models with composition gradients fit mass, radius, J₂ and J₄', inferred: 'Layers are not required', assumed: 'Gradients survive the planet\'s history', uncertain: 'Both pictures fit', year: 2020 }),
            row('gravity', 'constrains', facts.gravitySource, { observed: 'Two gravity harmonics', inferred: 'Cannot tell layers from gradients', assumed: '—', uncertain: '—', mission: 'Voyager 2', year: facts.body === 'Uranus' ? 1986 : 1989 }),
          ]),
        ],
      },
      {
        key: 'waterRichMiddle',
        name: 'Water-rich middle',
        family: 'ionicFluid',
        phase: 'liquid',
        outerRadiusKm: middleKm,
        boundary: distributed(Math.round(facts.radiusKm * 0.15), HELLED_FORTNEY, null, qualitative('A gradient, not a surface')),
        composition: sourced('Water, ammonia and methane with hydrogen mixed in, growing hydrogen-rich outward', HELLED_FORTNEY, 'modelled'),
        temperatureK: endpoints(4000, 2500, HELLED_FORTNEY, 'modelled'),
        pressureGPa: endpoints(200, 20, HELLED_FORTNEY, 'modelled'),
        densityKgM3: endpoints(4000, 1200, HELLED_FORTNEY, 'modelled'),
        heat: heat([{ kind: 'gravitationalContraction', note: 'Formation heat.' }], 'heat from below', 'mixed'),
        claims: [
          claim('existence', [
            row('model', 'supports', HELLED_FORTNEY, { observed: 'The same gradient models', inferred: 'A water-dominated middle', assumed: 'As above', uncertain: 'As above', year: 2020 }),
            row('magnetic', 'supports', STANLEY, { observed: 'The tilted, offset field', inferred: 'A dynamo in a thin outer conducting shell', assumed: 'Convection confined near the top', uncertain: 'Depth', year: 2004 }),
          ]),
        ],
      },
      ...envelope(facts),
    ],
  };
}

export const URANUS_LAYERED_MODEL = layeredModel(URANUS);
export const URANUS_FUZZY_MODEL = fuzzyModel(URANUS, URANUS_LAYERED_MODEL);
export const NEPTUNE_LAYERED_MODEL = layeredModel(NEPTUNE);
export const NEPTUNE_FUZZY_MODEL = fuzzyModel(NEPTUNE, NEPTUNE_LAYERED_MODEL);

export const ICE_GIANT_DISTINGUISHED_BY = 'Whether rock, water and hydrogen sit in distinct layers or grade into one another. Two gravity harmonics from a single flyby fit both; an orbiter measuring the higher harmonics, or seismology, would tell.';
