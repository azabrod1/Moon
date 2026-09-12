/**
 * The Sun — the one body whose interior is measured in three independent
 * ways: its surface rings with sound waves that cross the whole star
 * (helioseismology), neutrinos leave the core directly, and the light says
 * how much fusion there must be. Core, radiative zone, convective zone,
 * photosphere; the tachocline as the annotation where the two great zones
 * shear. PROVISIONAL: authored from the standard solar model literature.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, interval, row, sharp, sourced } from '../modelHelpers';

const CHRISTENSEN = 'Christensen-Dalsgaard et al. (1996), Science 272, the current state of solar modeling';
const BASU = 'Basu & Antia (1997), MNRAS 287, seismic measurement of the depth of the solar convection zone';
const KOSOVICHEV = 'Kosovichev et al. (1997), Solar Physics 170, structure and rotation of the solar interior: initial results from the MDI medium-l program';
const BAHCALL = 'Bahcall, Serenelli & Basu (2005), ApJ 621, new solar opacities, abundances, helioseismology, and neutrino fluxes';
const SNO = 'Ahmad et al. (2002), PRL 89, direct evidence for neutrino flavor transformation from neutral-current interactions in SNO';
const BOREXINO = 'Borexino Collaboration (2020), Nature 587, experimental evidence of neutrinos produced in the CNO fusion cycle in the Sun';
const DAVIS = 'Davis, Harmer & Hoffman (1968), PRL 20, search for neutrinos from the Sun';
const SPIEGEL = 'Spiegel & Zahn (1992), A&A 265, the solar tachocline';
const ASPLUND = 'Asplund et al. (2009), ARA&A 47, the chemical composition of the Sun';
const CHARBONNEAU = 'Charbonneau (2010), Living Reviews in Solar Physics 7, dynamo models of the solar cycle';
const KIRCHHOFF = 'Kirchhoff (1859), Monatsberichte der Berliner Akademie; the Fraunhofer lines read as absorption in the photosphere';
const MEAN_RADIUS = 696_340;

export const SUN_MODEL: InteriorModel = {
  body: 'Sun',
  modelId: 'sun-standard-model',
  title: 'Standard solar model',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A fusion core out to a quarter of the radius, a radiative zone where light takes a hundred thousand years to climb out, a convective zone that boils the surface into granules, and the thin photosphere we see. Sound waves cross all of it and neutrinos leave the core directly, so the profile is measured, not guessed.',
  heatFlowTW: sourced(3.828e14, BAHCALL, 'measured', 'The solar luminosity, 3.828 × 10²⁶ W'),
  regions: [
    {
      key: 'core',
      name: 'Core',
      family: 'plasma',
      phase: 'plasma',
      outerRadiusKm: 174_000,
      boundary: distributed(20_000, BAHCALL, interval(160_000, 190_000, 0.68, BAHCALL), null),
      composition: sourced('Hydrogen fusing to helium; about half the core\'s mass is already helium', BAHCALL, 'modelled'),
      temperatureK: endpoints(15_700_000, 7_000_000, BAHCALL, 'modelled'),
      pressureGPa: endpoints(2.5e7, 1.5e6, BAHCALL, 'modelled'),
      densityKgM3: endpoints(150_000, 20_000, BAHCALL, 'modelled'),
      heat: heat([{ kind: 'fusion', note: 'The proton–proton chain, with about 1% from the CNO cycle, releases 3.8 × 10²⁶ W.' }], null, 'radiation'),
      claims: [
        claim('existence', [
          row('neutrinos', 'supports', SNO, { observed: 'The Sudbury Neutrino Observatory counted all flavours of solar neutrino and found the total flux the standard model predicts', inferred: 'Fusion runs in the core at the modelled rate; the earlier shortfall was neutrinos changing flavour, not the Sun', assumed: 'Neutrino oscillation', uncertain: 'A few percent on the flux', mission: 'SNO', year: 2002 }),
          row('neutrinos', 'supports', BOREXINO, { observed: 'Neutrinos from the CNO cycle detected', inferred: 'The second fusion pathway runs, as the model has it, at about 1%', assumed: '—', uncertain: 'The Sun\'s metallicity, which sets the CNO rate', mission: 'Borexino', year: 2020 }),
          row('neutrinos', 'supports', DAVIS, { observed: 'The first solar neutrinos, caught in a tank of cleaning fluid in a mine', inferred: 'Fusion in the core, though a third of the expected number', assumed: '—', uncertain: 'The shortfall, resolved in 2002', year: 1968 }),
          row('helioseismology', 'supports', CHRISTENSEN, { observed: 'The sound speed through the core, from the frequencies of the Sun\'s oscillations', inferred: 'A core whose sound speed matches the standard model to a fraction of a percent', assumed: 'A spherically symmetric Sun', uncertain: 'The innermost 5%', year: 1996 }),
        ]),
        claim('temperature', [
          row('neutrinos', 'supports', BAHCALL, { observed: 'The boron-8 neutrino flux, which rises as the twentieth power of the core temperature', inferred: 'A central temperature of 15.7 million K', assumed: 'The standard solar model\'s composition', uncertain: 'About 1%', year: 2005 }),
        ]),
      ],
    },
    {
      key: 'radiativeZone',
      name: 'Radiative zone',
      family: 'plasma',
      phase: 'plasma',
      outerRadiusKm: 496_000,
      boundary: distributed(14_000, SPIEGEL, interval(494_000, 498_000, 0.68, BASU), interval(10_000, 30_000, 0.68, SPIEGEL)),
      composition: sourced('Hydrogen and helium plasma, still; the energy crosses it as light, scattered a trillion times', CHRISTENSEN, 'modelled'),
      temperatureK: endpoints(7_000_000, 2_000_000, BAHCALL, 'modelled'),
      pressureGPa: endpoints(1.5e6, 1000, BAHCALL, 'modelled'),
      densityKgM3: endpoints(20_000, 200, BAHCALL, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Carries the core\'s light outward by radiation over about a hundred thousand years.' }], 'the core\'s light', 'radiation'),
      claims: [
        claim('existence', [
          row('helioseismology', 'supports', CHRISTENSEN, { observed: 'Sound speed rising smoothly inward through this zone', inferred: 'A stable, non-convecting region in radiative equilibrium', assumed: 'The equation of state', uncertain: 'Composition details', year: 1996 }),
          row('helioseismology', 'supports', KOSOVICHEV, { observed: 'The interior rotates as a solid body here, unlike the surface\'s differential rotation', inferred: 'No convection to redistribute angular momentum', assumed: '—', uncertain: 'The rotation of the core', mission: 'SOHO', year: 1997 }),
        ]),
      ],
    },
    {
      key: 'convectiveZone',
      name: 'Convective zone',
      family: 'plasma',
      phase: 'plasma',
      outerRadiusKm: 695_800,
      boundary: sharp(interval(695_500, 696_000, 0.68, ASPLUND)),
      composition: sourced('Hydrogen and helium plasma, boiling: hot plasma rises, cools and sinks', BASU, 'modelled'),
      temperatureK: endpoints(2_000_000, 6500, BAHCALL, 'modelled'),
      pressureGPa: endpoints(1000, 1e-5, BAHCALL, 'modelled'),
      densityKgM3: endpoints(200, 0.0003, BAHCALL, 'modelled'),
      heat: heat([{ kind: 'none', note: 'Carries the heat the last third of the way by convection.' }], 'heat from the radiative zone', 'convection'),
      claims: [
        claim('existence', [
          row('helioseismology', 'supports', BASU, { observed: 'A kink in the sound-speed profile at 0.713 of the radius', inferred: 'The base of the convection zone, where the temperature gradient changes', assumed: 'Spherical symmetry', uncertain: '±0.001 of the radius', year: 1997 }),
          row('inSitu', 'supports', ASPLUND, { observed: 'Granulation on the surface: cells a thousand km across, rising bright and sinking dark', inferred: 'Convection reaching the surface', assumed: '—', uncertain: '—', year: 2009 }),
          row('magnetic', 'constrains', CHARBONNEAU, { observed: 'The eleven-year cycle of sunspots and the field\'s reversals', inferred: 'A dynamo driven by convection and the shear at its base', assumed: 'Dynamo theory', uncertain: 'Where exactly the dynamo runs', year: 2010 }),
        ]),
      ],
    },
    {
      key: 'photosphere',
      name: 'Photosphere',
      family: 'plasma',
      phase: 'plasma',
      outerRadiusKm: MEAN_RADIUS,
      boundary: sharp(),
      composition: sourced('The layer light escapes from: 74% hydrogen, 24% helium, 2% everything else by mass, read from its spectrum', ASPLUND, 'measured'),
      temperatureK: endpoints(6500, 4500, ASPLUND, 'measured'),
      pressureGPa: endpoints(1e-5, 1e-7, ASPLUND, 'measured'),
      densityKgM3: endpoints(0.0003, 0.00001, ASPLUND, 'measured'),
      heat: heat([{ kind: 'none', note: 'Radiates the Sun\'s light into space at 5,772 K.' }], 'heat from the convection below', 'radiation'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', KIRCHHOFF, { observed: 'The dark lines in the Sun\'s spectrum', inferred: 'A layer of cooler gas absorbing the light from below: the photosphere', assumed: '—', uncertain: '—', year: 1859 }),
          row('inSitu', 'supports', ASPLUND, { observed: 'The spectrum measured line by line', inferred: 'Its temperature and composition', assumed: 'Model atmospheres', uncertain: 'The oxygen and carbon abundances', year: 2009 }),
        ]),
      ],
    },
  ],
  annotations: [
    { name: 'Tachocline', innerRadiusKm: 486_000, outerRadiusKm: 506_000, note: 'The thin shear layer where the rigidly rotating interior meets the differentially rotating convection zone; where the dynamo is thought to wind its field.', source: SPIEGEL },
  ],
  sources: [CHRISTENSEN, BASU, KOSOVICHEV, BAHCALL, SNO, BOREXINO, DAVIS, SPIEGEL, ASPLUND, CHARBONNEAU, KIRCHHOFF],
};
