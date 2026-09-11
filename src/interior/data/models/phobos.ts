/**
 * Phobos — a poorly constrained body: a bulk density that says it is
 * porous, a surface we know, and an interior nobody has measured. The
 * illustrative rubble-pile scenario is labelled and never the default.
 * PROVISIONAL: awaiting review.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, endpoints, heat, row, sharp, sourced, UNKNOWN, unknownBoundary } from '../modelHelpers';

const WILLNER = 'Willner, Shi & Oberst (2014), PSS 102, Phobos\' shape and topography models';
const ANDERT = 'Andert et al. (2010), GRL 37, precise mass determination and the nature of Phobos (Mars Express)';
const MURCHIE = 'Murchie et al. (2015), in Asteroids IV, the value of Phobos sample return';

export const PHOBOS_ILLUSTRATIVE_MODEL: InteriorModel = {
  body: 'Phobos',
  modelId: 'phobos-rubble-pile-illustrative',
  title: 'Rubble pile',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: 11.1,
  overview: 'One way Phobos could be put together: loose regolith over fractured, porous rock. Illustrative — nothing has measured its interior.',
  illustrative: true,
  regions: [
    {
      key: 'interior',
      name: 'Fractured interior',
      family: 'unresolved',
      phase: 'unresolved',
      outerRadiusKm: 11.0,
      boundary: unknownBoundary('The regolith depth is estimated from crater shapes'),
      composition: sourced('Porous rock, perhaps a quarter to a third empty space; carbonaceous or Mars-like, unknown', ANDERT, 'modelled'),
      temperatureK: UNKNOWN,
      pressureGPa: UNKNOWN,
      densityKgM3: endpoints(1860, 1860, ANDERT, 'measured', 'none'),
      heat: heat([{ kind: 'none', note: 'Too small to keep any heat of its own.' }], 'Sunlight and Mars-shine at the surface', 'conduction'),
      claims: [
        claim('existence', [
          row('density', 'supports', ANDERT, { observed: 'Mars Express flyby tracking gives a mass; the shape model gives a volume; bulk density 1860 ± 13 kg/m³', inferred: 'Far less dense than solid rock: the interior holds a great deal of empty space or ice', assumed: 'The shape model\'s volume', uncertain: 'Whether the porosity is macro (rubble) or micro, and whether ice contributes', mission: 'Mars Express', year: 2010 }),
          row('model', 'constrains', MURCHIE, { observed: 'Spectra resemble D-type asteroids or heavily processed Mars ejecta', inferred: 'Either a captured body or reaccreted impact debris', assumed: '—', uncertain: 'Origin is open until a sample returns', year: 2015 }),
        ]),
      ],
    },
    {
      key: 'regolith',
      name: 'Regolith',
      family: 'mixed',
      phase: 'solid',
      outerRadiusKm: 11.1,
      boundary: sharp(),
      composition: sourced('Loose dust and rubble, perhaps 100 m deep', WILLNER, 'inferred'),
      temperatureK: endpoints(240, 230, WILLNER, 'inferred'),
      pressureGPa: UNKNOWN,
      densityKgM3: endpoints(1600, 1600, WILLNER, 'modelled', 'none'),
      heat: heat([{ kind: 'none', note: 'Warmed by the Sun and by Mars.' }], 'Sunlight', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', WILLNER, { observed: 'Images of grooves, craters and a dusty surface', inferred: 'A loose regolith layer', assumed: '—', uncertain: 'Its depth', mission: 'Mars Express', year: 2014 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [WILLNER, ANDERT, MURCHIE],
};

export const PHOBOS_BULK = {
  densityKgM3: sourced(1860, ANDERT, 'measured', '±13 kg/m³'),
  note: 'Phobos is far too light to be solid rock: a quarter or more of it is empty space, ice, or both. No measurement has reached its interior, and its shape is not a sphere, so no layering is implied. An illustrative rubble-pile scenario can be shown.',
};
