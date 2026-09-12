/**
 * Saturn — hydrogen and helium nearly all the way down, over a core that
 * Cassini's ring seismology found to be large and diffuse: heavy elements
 * spread through more than half the radius and stably stratified. Helium
 * rains out of the hydrogen part way down, which is why Saturn shines
 * brighter than its age allows. PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, modelSpread, qualitative, row, sharp, sourced } from '../modelHelpers';

const MANKOVICH = 'Mankovich & Fuller (2021), Nature Astronomy 5, a diffuse core in Saturn revealed by ring seismology';
const IESS = 'Iess et al. (2019), Science 364, measurement and implications of Saturn\'s gravity field and ring mass';
const HEDMAN = 'Hedman & Nicholson (2013), AJ 146, kronoseismology: using density waves in Saturn\'s C ring to probe the planet\'s interior';
const FORTNEY = 'Fortney & Nettelmann (2010), Space Sci. Rev. 152, the interior structure, composition, and evolution of giant planets';
const DOUGHERTY = 'Dougherty et al. (2018), Science 362, Saturn\'s magnetic field revealed by the Cassini Grand Finale';
const STEVENSON = 'Stevenson & Salpeter (1977), ApJS 35, the phase diagram and transport properties for hydrogen–helium fluid planets';
const LINDAL = 'Lindal, Sweetnam & Eshleman (1985), AJ 90, the atmosphere of Saturn: an analysis of the Voyager radio occultation measurements';
const WEIR = 'Weir, Mitchell & Nellis (1996), PRL 76, metallization of fluid molecular hydrogen at 140 GPa';
const MEAN_RADIUS = 58_232;

export const SATURN_MODEL: InteriorModel = {
  body: 'Saturn',
  modelId: 'saturn-diffuse-core',
  title: 'Diffuse core',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A diffuse core of rock and ice dissolved into hydrogen out to about 60% of the radius, found by the waves it stirs in the rings; a metallic hydrogen shell where the dynamo runs; a deep molecular envelope; helium raining through it.',
  heatFlowTW: sourced(2.0e3, FORTNEY, 'measured', 'Saturn radiates about 2.3 times what it receives from the Sun'),
  regions: [
    {
      key: 'diffuseCore',
      name: 'Diffuse core',
      family: 'mixed',
      phase: 'unresolved',
      outerRadiusKm: 35_000,
      boundary: distributed(8000, MANKOVICH, modelSpread(30_000, 40_000, ['Mankovich & Fuller 2021']), qualitative('A gradient, not a surface: the heavy-element fraction fades outward')),
      composition: sourced('Rock and ice, about 17 Earth masses of them, dissolved into hydrogen and helium and stably layered', MANKOVICH, 'inferred'),
      temperatureK: endpoints(12_000, 8000, FORTNEY, 'modelled'),
      pressureGPa: endpoints(1000, 400, FORTNEY, 'modelled'),
      densityKgM3: endpoints(8000, 2500, MANKOVICH, 'inferred'),
      heat: heat([{ kind: 'gravitationalContraction', note: 'Heat of formation, leaving slowly through a stably stratified region.' }], null, 'conduction'),
      claims: [
        claim('existence', [
          row('seismology', 'supports', MANKOVICH, { observed: 'Density waves in the C ring at frequencies set by oscillations inside Saturn (kronoseismology)', inferred: 'Gravity modes that need a stably stratified, heavy-element-rich region reaching about 60% of the radius', assumed: 'The waves are driven by the planet\'s normal modes', uncertain: 'The core\'s exact profile and how it formed', mission: 'Cassini', year: 2021 }),
          row('gravity', 'supports', IESS, { observed: 'Cassini\'s Grand Finale orbits measured the gravity harmonics between the rings and the cloud tops', inferred: 'A heavy-element content and deep differential rotation consistent with the diffuse picture', assumed: 'A rotation profile', uncertain: 'Degenerate with the wind depth', mission: 'Cassini', year: 2019 }),
        ]),
      ],
    },
    {
      key: 'metallicHydrogen',
      name: 'Metallic hydrogen',
      family: 'metallicHydrogen',
      phase: 'liquidMetal',
      outerRadiusKm: 42_000,
      boundary: distributed(3000, FORTNEY, modelSpread(40_000, 45_000, ['Fortney & Nettelmann 2010']), qualitative('The change from molecular to metallic fluid is continuous')),
      composition: sourced('Hydrogen as a liquid metal, with less helium than above: the helium has rained out', STEVENSON, 'modelled'),
      temperatureK: endpoints(8000, 6000, FORTNEY, 'modelled'),
      pressureGPa: endpoints(400, 150, FORTNEY, 'modelled'),
      densityKgM3: endpoints(2500, 1000, FORTNEY, 'modelled'),
      heat: heat([{ kind: 'heliumRain', note: 'Helium droplets falling through the hydrogen release gravitational energy, the extra light Saturn gives off.' }], 'heat from the core', 'convection'),
      claims: [
        claim('existence', [
          row('magnetic', 'supports', DOUGHERTY, { observed: 'A dipole field almost perfectly aligned with the spin axis, measured from inside the rings', inferred: 'A dynamo in a conducting fluid shell deep inside: metallic hydrogen', assumed: 'Dynamo theory; a stably stratified layer above smooths the field', uncertain: 'The depth of the dynamo', mission: 'Cassini', year: 2018 }),
          row('labHighPressure', 'supports', WEIR, { observed: 'Fluid hydrogen becomes a metal near 140 GPa in shock experiments', inferred: 'Saturn crosses that pressure about halfway down', assumed: 'Saturn\'s pressure profile', uncertain: 'The transition\'s width', year: 1996 }),
        ]),
      ],
    },
    {
      key: 'molecularEnvelope',
      name: 'Molecular hydrogen envelope',
      family: 'hydrogen',
      phase: 'supercriticalFluid',
      outerRadiusKm: 57_500,
      boundary: distributed(400, LINDAL, null, null),
      composition: sourced('Hydrogen and helium as a dense supercritical fluid, helium-depleted toward the base', FORTNEY, 'modelled'),
      temperatureK: endpoints(6000, 500, FORTNEY, 'modelled'),
      pressureGPa: endpoints(150, 0.1, FORTNEY, 'modelled'),
      densityKgM3: endpoints(1000, 50, FORTNEY, 'modelled'),
      heat: heat([{ kind: 'gravitationalContraction', note: 'Slow contraction since formation.' }], 'heat from below', 'convection'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', IESS, { observed: 'The gravity harmonics with the bulk density of 687 kg/m³', inferred: 'A deep hydrogen–helium envelope', assumed: 'Equations of state', uncertain: 'The helium fraction with depth', mission: 'Cassini', year: 2019 }),
          row('inSitu', 'supports', LINDAL, { observed: 'Voyager radio occultations profiled the upper atmosphere', inferred: 'Hydrogen and helium, continuing down', assumed: '—', uncertain: 'Below the probed pressures', mission: 'Voyager', year: 1985 }),
        ]),
      ],
    },
    {
      key: 'atmosphere',
      name: 'Outer atmosphere',
      family: 'hydrogen',
      phase: 'gas',
      outerRadiusKm: MEAN_RADIUS,
      boundary: sharp(),
      composition: sourced('Hydrogen and helium with ammonia clouds under a haze', LINDAL, 'measured'),
      temperatureK: endpoints(500, 134, LINDAL, 'measured'),
      pressureGPa: endpoints(0.1, 0, LINDAL, 'measured'),
      densityKgM3: endpoints(50, 0.2, LINDAL, 'measured'),
      heat: heat([{ kind: 'none', note: 'Warmed by sunlight and from below.' }], 'sunlight and heat from below', 'convection'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', LINDAL, { observed: 'Radio occultation temperature and pressure profiles', inferred: 'The weather layer', assumed: '—', uncertain: '—', mission: 'Voyager', year: 1985 }),
        ]),
      ],
    },
  ],
  annotations: [
    { name: 'Helium rain region', innerRadiusKm: 32_000, outerRadiusKm: 42_000, note: 'Where helium separates from hydrogen and sinks as droplets, releasing heat.', source: STEVENSON },
  ],
  sources: [MANKOVICH, IESS, HEDMAN, FORTNEY, DOUGHERTY, STEVENSON, LINDAL, WEIR],
};
