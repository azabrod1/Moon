/**
 * Enceladus — a small moon with a global ocean under a thin ice shell over
 * a porous rock core that is hydrothermally active, from Cassini's gravity,
 * its measured libration, and the plume it flew through. PROVISIONAL.
 */
import type { InteriorModel } from '../interiorTypes';
import { claim, distributed, endpoints, heat, interval, row, sharp, sourced } from '../modelHelpers';

const IESS = 'Iess et al. (2014), Science 344, the gravity field and interior structure of Enceladus';
const THOMAS = 'Thomas et al. (2016), Icarus 264, Enceladus\'s measured physical libration requires a global subsurface ocean';
const CADEK = 'Čadek et al. (2016), GRL 43, Enceladus\'s internal ocean and ice shell constrained from Cassini gravity, shape, and libration data';
const HSU = 'Hsu et al. (2015), Nature 519, ongoing hydrothermal activities within Enceladus';
const CHOBLET = 'Choblet et al. (2017), Nature Astronomy 1, powering prolonged hydrothermal activity inside Enceladus';
const WAITE = 'Waite et al. (2017), Science 356, Cassini finds molecular hydrogen in the Enceladus plume: evidence for hydrothermal processes';
const PORCO = 'Porco et al. (2006), Science 311, Cassini observes the active south pole of Enceladus';
const MEAN_RADIUS = 252.1;

export const ENCELADUS_MODEL: InteriorModel = {
  body: 'Enceladus',
  modelId: 'enceladus-cassini',
  title: 'Cassini',
  version: '0.1',
  review: 'provisional',
  reviewedOn: '2026-09-11',
  epoch: 'present',
  radiusConvention: 'volumetricMean',
  referenceRadiusKm: MEAN_RADIUS,
  overview: 'A porous rock core with hot water circulating through it, a global salty ocean, and an ice shell about 20 km thick that thins to a few km at the south pole, where the ocean vents into space.',
  regions: [
    {
      key: 'core',
      name: 'Porous rock core',
      family: 'silicate',
      phase: 'solid',
      outerRadiusKm: 192,
      boundary: sharp(interval(185, 200, 0.68, IESS)),
      composition: sourced('Loose, porous rock with water circulating through it', CHOBLET, 'inferred'),
      temperatureK: endpoints(500, 363, CHOBLET, 'modelled'),
      pressureGPa: endpoints(0.03, 0.01, IESS, 'modelled'),
      densityKgM3: endpoints(2500, 2400, IESS, 'inferred'),
      heat: heat([
        { kind: 'tidal', note: 'Tidal flexing of the porous, water-soaked rock generates 10–30 GW.' },
        { kind: 'radiogenicDecay', note: 'A little decay heat in the rock.' },
      ], null, 'convection'),
      claims: [
        claim('existence', [
          row('gravity', 'supports', IESS, { observed: 'Three Cassini flybys measured the gravity field: a moment of inertia of 0.335 and a south-polar anomaly', inferred: 'A low-density rock core about 190–200 km in radius', assumed: 'Near-hydrostatic shape with a regional ocean or more', uncertain: 'Its porosity', mission: 'Cassini', year: 2014 }),
          row('inSitu', 'supports', HSU, { observed: 'Cassini caught silica nanoparticles streaming from the plume', inferred: 'They form only where water hotter than 90 °C meets rock: hydrothermal vents in the core', assumed: 'The particles come from the ocean floor', uncertain: 'The extent of the activity', mission: 'Cassini', year: 2015 }),
          row('inSitu', 'supports', WAITE, { observed: 'Molecular hydrogen in the plume', inferred: 'Water reacting with rock inside', assumed: '—', uncertain: '—', mission: 'Cassini', year: 2017 }),
        ]),
      ],
    },
    {
      key: 'ocean',
      name: 'Ocean',
      family: 'water',
      phase: 'liquid',
      outerRadiusKm: 229,
      boundary: distributed(1, CADEK, interval(224, 234, 0.68, CADEK)),
      composition: sourced('Salty, slightly alkaline water with organics and silica', HSU, 'measured'),
      temperatureK: endpoints(274, 272, CADEK, 'inferred'),
      pressureGPa: endpoints(0.01, 0.002, CADEK, 'modelled'),
      densityKgM3: endpoints(1030, 1020, CADEK, 'inferred'),
      heat: heat([{ kind: 'none', note: 'Warmed from the core, vented at the south pole.' }], 'heat from the hydrothermal core', 'convection'),
      claims: [
        claim('existence', [
          row('libration', 'supports', THOMAS, { observed: 'Seven years of Cassini images show Enceladus rocking by 0.12° as it orbits', inferred: 'The shell is not attached to the core: a global ocean decouples it', assumed: 'A rigid shell', uncertain: 'The shell\'s mean thickness', mission: 'Cassini', year: 2016 }),
          row('gravity', 'supports', IESS, { observed: 'The gravity field', inferred: 'A sea at least under the south pole', assumed: 'Near-hydrostatic', uncertain: 'Regional or global from gravity alone', mission: 'Cassini', year: 2014 }),
          row('inSitu', 'supports', PORCO, { observed: 'Plumes of water vapour and ice grains erupting from the south polar fractures', inferred: 'Liquid water near the surface', assumed: '—', uncertain: '—', mission: 'Cassini', year: 2006 }),
        ]),
        claim('state', [
          row('inSitu', 'supports', PORCO, { observed: 'Salty ice grains in the plume', inferred: 'Liquid salt water', assumed: '—', uncertain: '—', mission: 'Cassini', year: 2006 }),
        ]),
      ],
    },
    {
      key: 'iceShell',
      name: 'Ice shell',
      family: 'ice',
      phase: 'solid',
      outerRadiusKm: MEAN_RADIUS,
      boundary: sharp(),
      composition: sourced('Clean water ice, the brightest surface in the solar system', PORCO, 'measured'),
      temperatureK: endpoints(272, 75, CADEK, 'inferred'),
      pressureGPa: endpoints(0.002, 0, CADEK, 'modelled'),
      densityKgM3: endpoints(930, 920, CADEK, 'inferred'),
      heat: heat([{ kind: 'tidal', note: 'Tidal flexing in the thin south-polar shell.' }], 'heat from the ocean below', 'conduction'),
      claims: [
        claim('existence', [
          row('inSitu', 'supports', PORCO, { observed: 'Images and spectra of the surface', inferred: 'A water-ice shell', assumed: '—', uncertain: '—', mission: 'Cassini', year: 2006 }),
        ]),
        claim('extent', [
          row('libration', 'supports', THOMAS, { observed: 'The libration amplitude', inferred: 'A shell 21–26 km thick on average', assumed: 'Rigidity', uncertain: 'A few km', mission: 'Cassini', year: 2016 }),
          row('gravity', 'supports', CADEK, { observed: 'Gravity, shape and libration together', inferred: 'About 20 km on average, under 5 km at the south pole', assumed: 'Isostasy', uncertain: 'The polar thickness', mission: 'Cassini', year: 2016 }),
        ]),
      ],
    },
  ],
  annotations: [],
  sources: [IESS, THOMAS, CADEK, HSU, CHOBLET, WAITE, PORCO],
};
