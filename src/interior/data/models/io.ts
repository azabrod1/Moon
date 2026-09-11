/**
 * Io — a metal core under a hot silicate mantle, from Galileo's gravity;
 * the 2011 reading of a shallow global magma ocean is disfavoured by Juno's
 * tidal measurement, so the default mantle is hot and partly molten rather
 * than a sea of magma, and the magma ocean lives in the history.
 * PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, endpoints, heat, modelSpread, row, sharp, sourced } from '../modelHelpers';

const ANDERSON = 'Anderson et al. (2001), JGR 106, Io\'s gravity field and interior structure';
const KHURANA = 'Khurana et al. (2011), Science 332, evidence of a global magma ocean in Io\'s interior';
const PARK = 'Park et al. (2024), Nature 638, Io\'s tidal response precludes a shallow magma ocean';
const KESZTHELYI = 'Keszthelyi et al. (2004), Icarus 169, a post-Galileo view of Io\'s interior';
const VEEDER = 'Veeder et al. (1994), JGR 99, Io\'s heat flow from infrared radiometry';
const MOORE = 'Moore et al. (2007), in Io After Galileo (Springer), the interior of Io';
const MEAN_RADIUS = 1821.6;

export const IO_MODEL: InteriorModel = {
  body: 'Io',
  modelId: 'io-galileo-juno',
  title: 'Galileo and Juno',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'An iron-sulphide core under a hot silicate mantle that feeds the most active volcanoes in the solar system, with a crust of lava and sulphur. Tides from Jupiter supply the heat; a shallow global magma ocean was proposed and is now disfavoured.',
  regions: [
    {
      key: 'core',
      name: 'Metallic core',
      family: 'metal',
      phase: 'unresolved',
      outerRadiusKm: 800,
      boundary: sharp(modelSpread(650, 950, ['Anderson 2001 (Fe)', 'Anderson 2001 (Fe–FeS)'])),
      composition: sourced('Iron, or iron and iron sulphide', ANDERSON, 'modelled'),
      temperatureK: endpoints(2000, 1800, KESZTHELYI, 'modelled'),
      pressureGPa: endpoints(6, 4, MOORE, 'modelled'),
      densityKgM3: endpoints(6000, 5200, ANDERSON, 'modelled'),
      heat: heat([{ kind: 'primordial', note: 'Whatever formation heat remains; no dynamo runs.' }], null, 'unresolved'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Galileo\'s Doppler tracking gives a moment of inertia of 0.377', inferred: 'A dense core under a rock mantle', assumed: 'Hydrostatic equilibrium', uncertain: 'Its size trades against its sulphur content', mission: 'Galileo', year: 2001 }),
          row('density', 'supports', ANDERSON, { observed: 'Bulk density 3528 kg/m³, the densest moon', inferred: 'Rock and metal throughout', assumed: '—', uncertain: '—', mission: 'Galileo', year: 2001 }),
          row('magnetic', 'constrains', KHURANA, { observed: 'No intrinsic field', inferred: 'No dynamo in the core', assumed: '—', uncertain: 'Whether the core is liquid but not convecting', mission: 'Galileo', year: 2011 }),
        ]),
      ],
    },
    {
      key: 'mantle',
      name: 'Hot mantle',
      family: 'silicate',
      phase: 'partialMelt',
      outerRadiusKm: MEAN_RADIUS - 30,
      boundary: sharp(modelSpread(MEAN_RADIUS - 50, MEAN_RADIUS - 20, ['Keszthelyi 2004'])),
      composition: sourced('Silicate rock, hot and with a few percent melt, more toward the top', KESZTHELYI, 'modelled'),
      temperatureK: endpoints(1800, 1400, KESZTHELYI, 'modelled'),
      pressureGPa: endpoints(4, 0.1, MOORE, 'modelled'),
      densityKgM3: endpoints(3400, 3200, ANDERSON, 'modelled'),
      heat: heat([{ kind: 'tidal', note: 'Jupiter\'s tides, held eccentric by Europa and Ganymede, flex Io and dissipate about 10¹⁴ W in the mantle.' }], null, 'convection'),
      claims: [
        claim('existence', [
          row('momentOfInertia', 'supports', ANDERSON, { observed: 'Moment of inertia and density', inferred: 'A thick silicate mantle', assumed: 'Hydrostatic equilibrium', uncertain: 'Its melt fraction', mission: 'Galileo', year: 2001 }),
          row('inSitu', 'supports', VEEDER, { observed: 'A global heat flow near 2 W/m², measured in the infrared', inferred: 'An interior hot enough to melt rock continuously', assumed: 'The heat is tidal', uncertain: 'Its exact value', year: 1994 }),
        ]),
        claim('state', [
          row('tides', 'supports', PARK, { observed: 'Juno and Galileo tracking give a tidal Love number k₂ near 0.1', inferred: 'The mantle is mostly solid: a shallow magma ocean would deform Io far more', assumed: 'Elastic-viscous response', uncertain: 'A deeper or thinner melt layer is not excluded', mission: 'Juno', year: 2024 }),
          row('magnetic', 'challenges', KHURANA, { observed: 'Galileo\'s magnetometer saw an induced field', inferred: 'Read as a conducting layer of magma near the surface: a global magma ocean', assumed: 'The conductor is melt', uncertain: 'Alternative explanations for the signal', mission: 'Galileo', year: 2011 }),
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
      composition: sourced('Layered lava flows and sulphur, resurfaced faster than anywhere else', MOORE, 'inferred'),
      temperatureK: endpoints(1400, 110, KESZTHELYI, 'modelled'),
      pressureGPa: endpoints(0.1, 0, MOORE, 'modelled'),
      densityKgM3: endpoints(3000, 2800, MOORE, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Heat passes through it in volcanoes.' }], 'Heat from the mantle', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', MOORE, { observed: 'Galileo imaged active lava lakes, plumes and mountains', inferred: 'A solid, mobile crust of lava and sulphur', assumed: '—', uncertain: 'Its thickness, 20–50 km', mission: 'Galileo', year: 2007 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [ANDERSON, KHURANA, PARK, KESZTHELYI, VEEDER, MOORE],
};
