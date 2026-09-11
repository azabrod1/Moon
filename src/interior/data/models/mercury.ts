/**
 * Mercury — a planet that is mostly core. MESSENGER's gravity and the
 * librations Earth-based radar measured say the outer core is liquid and
 * reaches 85% of the radius; whether a solid inner core sits inside it, and
 * whether a solid iron-sulphide layer caps it, are the open questions, so
 * two models are drawn. PROVISIONAL.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, endpoints, heat, interval, modelSpread, row, sharp, sourced } from '../modelHelpers';

const MARGOT_2007 = 'Margot et al. (2007), Science 316, large longitude libration of Mercury reveals a molten core';
const MARGOT_2012 = 'Margot et al. (2012), JGR Planets 117, Mercury\'s moment of inertia from spin and gravity data';
const SMITH = 'Smith et al. (2012), Science 336, gravity field and internal structure of Mercury from MESSENGER';
const HAUCK = 'Hauck et al. (2013), JGR Planets 118, the curious case of Mercury\'s internal structure';
const ANDERSON = 'Anderson et al. (2011), Science 333, the global magnetic field of Mercury from MESSENGER orbital observations';
const GENOVA = 'Genova et al. (2019), GRL 46, geodetic evidence that Mercury has a solid inner core';
const PADOVAN = 'Padovan et al. (2015), GRL 42, thickness of the crust of Mercury from geoid-to-topography ratios';
const RIVOLDINI = 'Rivoldini & Van Hoolst (2013), EPSL 377, the interior structure of Mercury constrained by the low-degree gravity field and the rotation of Mercury';
const MEAN_RADIUS = 2439.7;

const CRUST: Region = {
  key: 'crust',
  name: 'Crust',
  family: 'silicate',
  phase: 'solid',
  outerRadiusKm: MEAN_RADIUS,
  boundary: sharp(),
  composition: sourced('Volcanic rock low in iron and rich in magnesium and sulphur', PADOVAN, 'inferred'),
  temperatureK: endpoints(700, 440, HAUCK, 'modelled'),
  pressureGPa: endpoints(0.5, 0, HAUCK, 'modelled'),
  densityKgM3: endpoints(3000, 2900, PADOVAN, 'inferred'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Heat-producing elements in the crust.' }], 'Heat from the mantle', 'conduction'),
  claims: [
    claim('existence', [
      row('gravity', 'supports', PADOVAN, { observed: 'MESSENGER\'s geoid against its topography', inferred: 'A crust about 35 km thick, thinner than once thought', assumed: 'Airy isostasy', uncertain: '±18 km', mission: 'MESSENGER', year: 2015 }),
      row('inSitu', 'supports', SMITH, { observed: 'MESSENGER\'s X-ray and gamma-ray spectra of the surface', inferred: 'A low-iron, sulphur-rich volcanic crust', assumed: '—', uncertain: 'The lower crust', mission: 'MESSENGER', year: 2012 }),
    ]),
  ],
};

const MANTLE: Region = {
  key: 'mantle',
  name: 'Mantle',
  family: 'silicate',
  phase: 'solid',
  outerRadiusKm: MEAN_RADIUS - 35,
  boundary: sharp(interval(MEAN_RADIUS - 53, MEAN_RADIUS - 17, 0.68, PADOVAN)),
  composition: sourced('Silicate rock, only about 400 km of it', SMITH, 'inferred'),
  temperatureK: endpoints(1900, 700, HAUCK, 'modelled'),
  pressureGPa: endpoints(5.5, 0.5, HAUCK, 'modelled'),
  densityKgM3: endpoints(3400, 3200, SMITH, 'inferred'),
  heat: heat([{ kind: 'radiogenicDecay', note: 'Uranium, thorium and potassium.' }], 'Heat from the core', 'convection'),
  claims: [
    claim('existence', [
      row('gravity', 'supports', SMITH, { observed: 'MESSENGER\'s gravity field and Mercury\'s bulk density', inferred: 'A thin silicate shell over a huge core', assumed: 'A layered interior', uncertain: 'Its thickness trades against the core radius', mission: 'MESSENGER', year: 2012 }),
      row('momentOfInertia', 'supports', MARGOT_2012, { observed: 'The moment of inertia, and the fraction of it in the solid outer shell', inferred: 'The mantle plus crust hold about 40% of the moment of inertia', assumed: 'The core is decoupled from the shell', uncertain: 'A few percent', year: 2012 }),
    ]),
  ],
};

const LIQUID_CORE: Region = {
  key: 'outerCore',
  name: 'Liquid core',
  family: 'metal',
  phase: 'liquidMetal',
  outerRadiusKm: 2020,
  boundary: sharp(interval(1990, 2050, 0.68, HAUCK)),
  composition: sourced('Liquid iron with sulphur and perhaps silicon', HAUCK, 'inferred'),
  temperatureK: endpoints(2000, 1900, HAUCK, 'modelled'),
  pressureGPa: endpoints(40, 5.5, HAUCK, 'modelled'),
  densityKgM3: endpoints(7200, 6900, HAUCK, 'inferred'),
  heat: heat([{ kind: 'primordial', note: 'Heat of formation, and latent heat if an inner core is freezing.' }], null, 'convection'),
  claims: [
    claim('existence', [
      row('libration', 'supports', MARGOT_2007, { observed: 'Radar tracking of Mercury\'s spin shows a libration twice too large for a solid planet', inferred: 'The mantle rocks on a liquid core', assumed: 'The solid shell is decoupled from the liquid', uncertain: 'How much of the core is liquid', year: 2007 }),
      row('gravity', 'supports', SMITH, { observed: 'MESSENGER\'s gravity field with the bulk density', inferred: 'A core reaching about 2020 km, 85% of the radius', assumed: 'Two-layer interior', uncertain: '±30 km', mission: 'MESSENGER', year: 2012 }),
      row('magnetic', 'supports', ANDERSON, { observed: 'A weak intrinsic dipole field, offset to the north', inferred: 'A dynamo runs in a convecting liquid core', assumed: 'Dynamo theory', uncertain: 'Why it is so weak', mission: 'MESSENGER', year: 2011 }),
    ]),
    claim('state', [
      row('libration', 'supports', MARGOT_2007, { observed: 'Libration amplitude', inferred: 'Liquid, at least at the top', assumed: 'As above', uncertain: 'As above', year: 2007 }),
    ]),
  ],
};

export const MERCURY_LIQUID_CORE_MODEL: InteriorModel = {
  body: 'Mercury',
  modelId: 'mercury-liquid-core',
  title: 'Liquid core',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A liquid iron core reaching 85% of the radius under a thin mantle and crust: Mercury is a core with a rind. A solid centre is possible but not drawn here.',
  regions: [LIQUID_CORE, MANTLE, CRUST],
  annotations: [
    { name: 'Possible iron-sulphide layer', innerRadiusKm: 2020, outerRadiusKm: 2080, note: 'Some models put a solid FeS layer at the top of the core to fit the density; nothing has seen it.', source: RIVOLDINI },
  ],
  sources: [MARGOT_2007, MARGOT_2012, SMITH, HAUCK, ANDERSON, GENOVA, PADOVAN, RIVOLDINI],
};

const INNER_CORE: Region = {
  key: 'innerCore',
  name: 'Solid inner core',
  family: 'metal',
  phase: 'solid',
  outerRadiusKm: 1000,
  boundary: sharp(modelSpread(600, 1300, ['Genova 2019', 'Rivoldini & Van Hoolst 2013'])),
  composition: sourced('Solid iron, perhaps with silicon', GENOVA, 'modelled'),
  temperatureK: endpoints(2100, 2000, HAUCK, 'modelled'),
  pressureGPa: endpoints(50, 40, HAUCK, 'modelled'),
  densityKgM3: endpoints(8000, 7800, GENOVA, 'modelled'),
  heat: heat([{ kind: 'latentCrystallisation', note: 'Freezing iron releases latent heat that helps drive the dynamo.' }], 'Conduction from the liquid core', 'conduction'),
  claims: [
    claim('existence', [
      row('gravity', 'supports', GENOVA, { observed: 'MESSENGER\'s gravity field together with the spin state', inferred: 'The density distribution fits best with a solid inner core about 1000 km across', assumed: 'A particular core composition', uncertain: 'Model-dependent; a smaller or absent inner core is not excluded', mission: 'MESSENGER', year: 2019 }),
      row('libration', 'supports', MARGOT_2012, { observed: 'The moment of inertia and the shell fraction', inferred: 'Consistent with a partly solid core', assumed: 'Decoupling', uncertain: 'Cannot fix the inner core size alone', year: 2012 }),
    ]),
  ],
};

export const MERCURY_INNER_CORE_MODEL: InteriorModel = {
  ...MERCURY_LIQUID_CORE_MODEL,
  modelId: 'mercury-solid-inner-core',
  title: 'Solid inner core',
  overview: 'The same liquid core with a solid iron centre about 1000 km across, argued from MESSENGER\'s gravity with the spin state; its freezing may be what keeps Mercury\'s weak dynamo alive.',
  regions: [INNER_CORE, { ...LIQUID_CORE, name: 'Liquid outer core' }, MANTLE, CRUST],
};

export const MERCURY_DISTINGUISHED_BY = 'Whether a solid iron centre has frozen inside the liquid core, and whether a solid iron-sulphide layer caps it. Gravity and libration allow both; BepiColombo\'s finer gravity and rotation measurements are the test.';
