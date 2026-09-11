/**
 * Jupiter — two competing pictures of the deep interior. Juno's gravity
 * field is fit best by a "dilute" core, heavy elements mixed outward through
 * nearly half the radius; a compact core with a different envelope cannot be
 * excluded. Both share the same envelope. PROVISIONAL: awaiting review.
 */
import type { InteriorModel, Region } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, qualitative, row, sharp, sourced, UNKNOWN } from '../modelHelpers';

const WAHL = 'Wahl et al. (2017), GRL 44, comparing Jupiter interior structure models to Juno gravity measurements and the role of a dilute core';
const MILITZER = 'Militzer et al. (2022), Planet. Sci. J. 3, Juno spacecraft measurements of Jupiter\'s gravity imply a dilute core';
const DEBRAS = 'Debras & Chabrier (2019), ApJ 872, new models of Jupiter in the context of Juno and Galileo';
const CONNERNEY = 'Connerney et al. (2018), GRL 45, a new model of Jupiter\'s magnetic field from Juno\'s first nine orbits';
const LOUBEYRE = 'Loubeyre et al. (2020), Nature 577, synchrotron infrared spectroscopic evidence of the probable transition to metal hydrogen';
const WEIR = 'Weir, Mitchell & Nellis (1996), PRL 76, metallization of fluid molecular hydrogen at 140 GPa';
const GUILLOT = 'Guillot et al. (2004), in Jupiter (Cambridge), the interior of Jupiter';
const GALILEO = 'Seiff et al. (1998), JGR 103, thermal structure of Jupiter\'s atmosphere near the edge of a 5-μm hot spot (Galileo probe)';
const GAULME = 'Gaulme et al. (2011), A&A 531, detection of Jovian seismic waves';

const ENVELOPE: Region[] = [
  {
    key: 'metallicHydrogen',
    name: 'Metallic hydrogen',
    family: 'metallicHydrogen',
    phase: 'liquidMetal',
    outerRadiusKm: 59_000,
    boundary: distributed(4000, GUILLOT, modelSpread(56_000, 63_000, ['Guillot 2004', 'Debras & Chabrier 2019']), qualitative('The change from molecular to metallic fluid is continuous over thousands of km')),
    composition: sourced('Hydrogen as a liquid metal, with helium and heavier elements', GUILLOT, 'modelled'),
    temperatureK: endpoints(18_000, 8000, DEBRAS, 'modelled'),
    pressureGPa: endpoints(4000, 150, GUILLOT, 'modelled', 'log'),
    densityKgM3: endpoints(4000, 900, GUILLOT, 'modelled'),
    heat: heat([
      { kind: 'gravitationalContraction', note: 'Jupiter still shrinks slowly, releasing gravitational energy.' },
      { kind: 'heliumRain', note: 'Helium droplets separate and sink through the metallic layer, releasing energy.' },
    ], 'Heat from the core', 'convection'),
    claims: [
      claim('existence', [
        row('magnetic', 'supports', CONNERNEY, { observed: 'Jupiter\'s enormous, complex magnetic field, mapped by Juno', inferred: 'A deep, convecting, electrically conducting fluid: metallic hydrogen', assumed: 'Dynamo theory', uncertain: 'The exact depth the dynamo runs at', mission: 'Juno', year: 2018 }),
        row('labHighPressure', 'supports', LOUBEYRE, { observed: 'Hydrogen turns reflective, metal-like, near 425 GPa in a diamond anvil at low temperature; earlier shock experiments saw conduction at 140 GPa when hot', inferred: 'At Jupiter\'s deep pressures and temperatures hydrogen is a fluid metal', assumed: 'Laboratory conditions extrapolate to the planet', uncertain: 'The transition pressure at Jupiter\'s temperatures', year: 2020 }),
        row('gravity', 'supports', WAHL, { observed: 'Juno\'s gravity harmonics', inferred: 'A density profile consistent with metallic hydrogen below ~0.85 of the radius', assumed: 'An equation of state for hydrogen and helium', uncertain: 'The equation of state itself', mission: 'Juno', year: 2017 }),
      ]),
      claim('state', [
        row('labHighPressure', 'supports', WEIR, { observed: 'Shock-compressed fluid hydrogen conducts like a metal above 140 GPa', inferred: 'Fluid metal', assumed: '—', uncertain: '—', year: 1996 }),
      ]),
    ],
  },
  {
    key: 'molecularEnvelope',
    name: 'Molecular hydrogen envelope',
    family: 'hydrogen',
    phase: 'supercriticalFluid',
    outerRadiusKm: 69_000,
    boundary: distributed(500, GALILEO, null, null),
    composition: sourced('Hydrogen and helium as a dense supercritical fluid; helium rains out toward the bottom', GUILLOT, 'modelled'),
    temperatureK: endpoints(8000, 1000, DEBRAS, 'modelled'),
    pressureGPa: endpoints(150, 0.5, GUILLOT, 'modelled', 'log'),
    densityKgM3: endpoints(900, 50, GUILLOT, 'modelled'),
    heat: heat([{ kind: 'gravitationalContraction', note: 'Slow contraction releases heat throughout.' }], 'Heat from below', 'convection'),
    claims: [
      claim('existence', [
        row('gravity', 'supports', WAHL, { observed: 'Gravity harmonics', inferred: 'A low-density outer envelope', assumed: 'Hydrogen–helium equation of state', uncertain: 'Helium distribution', mission: 'Juno', year: 2017 }),
        row('inSitu', 'supports', GALILEO, { observed: 'The Galileo probe measured pressure, temperature and composition to 22 bar', inferred: 'The top of the envelope directly', assumed: 'The probe site was representative (it fell into a dry hot spot)', uncertain: 'Below 22 bar everything is inferred', mission: 'Galileo', year: 1998 }),
        row('normalModes', 'constrains', GAULME, { observed: 'Tentative detection of Jupiter\'s global oscillations', inferred: 'Consistent with standard interior models', assumed: 'The signal is Jovian', uncertain: 'The detection is marginal', year: 2011 }),
      ]),
    ],
  },
  {
    key: 'atmosphere',
    name: 'Outer atmosphere',
    family: 'hydrogen',
    phase: 'gas',
    outerRadiusKm: 69_911,
    boundary: sharp(),
    composition: sourced('Hydrogen and helium with ammonia, ammonium hydrosulphide and water clouds', GALILEO, 'measured'),
    temperatureK: endpoints(1000, 110, GALILEO, 'measured'),
    pressureGPa: endpoints(0.5, 0.00001, GALILEO, 'measured', 'log'),
    densityKgM3: endpoints(50, 0.2, GALILEO, 'inferred'),
    heat: heat([{ kind: 'none', note: 'It radiates the heat that rises from below and the sunlight it absorbs.' }], 'Sunlight from above, heat from below', 'radiation'),
    claims: [
      claim('existence', [
        row('inSitu', 'supports', GALILEO, { observed: 'The Galileo probe\'s descent through the clouds', inferred: 'The atmosphere\'s structure to 22 bar', assumed: '—', uncertain: 'Regional variation', mission: 'Galileo', year: 1998 }),
      ]),
    ],
  },
];

export const JUPITER_DILUTE_MODEL: InteriorModel = {
  body: 'Jupiter',
  modelId: 'jupiter-dilute-core',
  title: 'Dilute core',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: 69_911,
  overview: 'Heavy elements are not gathered in a compact core but smeared outward through nearly half the radius, mixed into the metallic hydrogen: the picture Juno\'s gravity field prefers.',
  regions: [
    {
      key: 'diluteCore',
      name: 'Dilute core',
      family: 'mixed',
      phase: 'unresolved',
      outerRadiusKm: 31_500,
      boundary: distributed(15_000, MILITZER, modelSpread(25_000, 40_000, ['Wahl 2017', 'Militzer 2022']), qualitative('There is no boundary in the usual sense; the heavy-element fraction fades outward')),
      composition: sourced('Rock and ice (heavy elements) dissolved in metallic hydrogen, perhaps 10–20 Earth masses of them', MILITZER, 'modelled'),
      temperatureK: endpoints(24_000, 18_000, DEBRAS, 'modelled'),
      pressureGPa: endpoints(7000, 4000, GUILLOT, 'modelled', 'log'),
      densityKgM3: UNKNOWN,
      heat: heat([{ kind: 'primordial', note: 'Heat of formation, leaving slowly through the convecting envelope.' }], null, 'unresolved'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', WAHL, { observed: 'Juno\'s J4 and J6 gravity harmonics are lower than compact-core models predict', inferred: 'The heavy elements extend outward through a large fraction of the radius', assumed: 'A hydrogen–helium equation of state and an adiabatic envelope', uncertain: 'Different equations of state shift the fit', mission: 'Juno', year: 2017 }),
          row('model', 'supports', MILITZER, { observed: 'Interior models spanning the plausible equations of state', inferred: 'A dilute core out to ~0.4–0.5 of the radius fits best', assumed: 'Convective, adiabatic envelope', uncertain: 'A compact core with a modified envelope is not excluded', mission: 'Juno', year: 2022 }),
        ]),
      ],
    },
    ...ENVELOPE,
  ],
  annotations: [
    { name: 'Helium rain region', innerRadiusKm: 56_000, outerRadiusKm: 63_000, note: 'Where helium separates from hydrogen and sinks as droplets.', source: GUILLOT },
  ],
  sources: [WAHL, MILITZER, DEBRAS, CONNERNEY, LOUBEYRE, WEIR, GUILLOT, GALILEO, GAULME],
};

const COMPACT_CORE: Region = {
  key: 'compactCore',
  name: 'Compact core',
  family: 'mixed',
  phase: 'unresolved',
  outerRadiusKm: 10_000,
  boundary: sharp(modelSpread(7000, 14_000, ['Guillot 2004'])),
  composition: sourced('Rock and ice, roughly 10 Earth masses', GUILLOT, 'modelled'),
  temperatureK: endpoints(22_000, 18_000, GUILLOT, 'modelled'),
  pressureGPa: endpoints(7000, 5500, GUILLOT, 'modelled', 'log'),
  densityKgM3: UNKNOWN,
  heat: heat([{ kind: 'primordial', note: 'Heat of formation.' }], null, 'unresolved'),
  claims: [
    claim('existence', [
      row('model', 'supports', GUILLOT, { observed: 'Pre-Juno interior models', inferred: 'A compact core of a few to ~10 Earth masses fits Jupiter\'s mass, radius and older gravity data', assumed: 'Heavy elements settled to the centre at formation', uncertain: 'Juno\'s harmonics are harder to fit this way', year: 2004 }),
      row('gravity', 'challenges', WAHL, { observed: 'Juno\'s gravity harmonics', inferred: 'A compact core needs an unusually structured envelope to fit them', assumed: 'Standard equations of state', uncertain: 'Not excluded, but disfavoured', mission: 'Juno', year: 2017 }),
    ]),
  ],
};

export const JUPITER_COMPACT_MODEL: InteriorModel = {
  ...JUPITER_DILUTE_MODEL,
  modelId: 'jupiter-compact-core',
  title: 'Compact core',
  overview: 'The classical picture: a compact core of rock and ice about ten Earth masses, with the heavy elements settled at the centre and a metallic hydrogen envelope above it.',
  regions: [
    COMPACT_CORE,
    { ...ENVELOPE[0], outerRadiusKm: 59_000 },
    ENVELOPE[1],
    ENVELOPE[2],
  ],
};

/** What separates the two pictures, for the coverage entry. */
export const JUPITER_DISTINGUISHED_BY = 'Whether the heavy elements sit in a compact core or are spread through nearly half the radius. Juno\'s gravity harmonics favour the dilute picture; the compact core survives only with an unusual envelope, and Jupiter\'s faint seismic ringing, if it can be measured, would settle it.';
