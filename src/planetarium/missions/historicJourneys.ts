/**
 * Catalog of historic interplanetary missions (Voyager, Cassini, New Horizons,
 * Juno) driving the Planetarium's Historic Journeys feature: milestone
 * timelines, per-mission ship profiles, and playback metadata.
 */
import type { ShipProfile } from '../PlayerShip';

export type HistoricTarget =
  | 'Earth'
  | 'Venus'
  | 'Jupiter'
  | 'Saturn'
  | 'Uranus'
  | 'Neptune'
  | 'Pluto'
  | 'Interstellar'
  | 'Custom';

export type HistoricMissionId =
  | 'voyager1'
  | 'voyager2'
  | 'cassini'
  | 'newHorizons'
  | 'juno';

export type HistoricMilestone = {
  id: string;
  title: string;
  dateLabel: string;
  dateUtcMs: number;
  target: HistoricTarget;
  description: string;
  note: string;
  viewDistanceMultiplier?: number;
  imageUrl: string;
  imageAlt: string;
  imageCredit: string;
  imageSourceLabel: string;
  imageSourceUrl?: string;
  fallbackImageUrl: string;
  fallbackImageAlt: string;
  fallbackImageCredit: string;
  fallbackImageSourceLabel: string;
  fallbackImageSourceUrl?: string;
  customScenePosition?: { x: number; y: number; z: number };
  customLookTarget?: { x: number; y: number; z: number };
};

export type HistoricJourney = {
  id: HistoricMissionId;
  label: string;
  readyNotification: string;
  shipProfile: Exclude<ShipProfile, 'default'>;
  milestones: HistoricMilestone[];
};

const TEXTURE_BASE = `${import.meta.env.BASE_URL}textures/`;
const VOYAGER_BASE = `${import.meta.env.BASE_URL}historic/voyager/`;
const CASSINI_BASE = `${import.meta.env.BASE_URL}historic/cassini/`;
const NEW_HORIZONS_BASE = `${import.meta.env.BASE_URL}historic/new-horizons/`;
const JUNO_BASE = `${import.meta.env.BASE_URL}historic/juno/`;
function textureFallback(textureFile: string, label: string) {
  return {
    fallbackImageUrl: `${TEXTURE_BASE}${textureFile}`,
    fallbackImageAlt: `${label} from the simulator texture set.`,
    fallbackImageCredit: 'Simulator texture',
    fallbackImageSourceLabel: label,
  };
}

function textureImage(textureFile: string, label: string) {
  return {
    imageUrl: `${TEXTURE_BASE}${textureFile}`,
    imageAlt: `${label} from the simulator texture set.`,
    imageCredit: 'Simulator texture',
    imageSourceLabel: label,
    ...textureFallback(textureFile, label),
  };
}

const voyager1Milestones: HistoricMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'September 5, 1977',
    dateUtcMs: Date.UTC(1977, 8, 5, 12, 56, 0),
    target: 'Earth',
    description: 'Voyager 1 lifted off from Cape Canaveral and began the fastest outward path ever attempted at the time.',
    note: 'This stop frames the mission near Earth so the story starts with a recognizable scale.',
    viewDistanceMultiplier: 1.35,
    imageUrl: `${VOYAGER_BASE}voyager1-launch.jpg`,
    imageAlt: 'Voyager 1 launch vehicle on the pad.',
    imageCredit: 'NASA',
    imageSourceLabel: 'Voyager 1’s Launch Vehicle',
    imageSourceUrl: 'https://science.nasa.gov/image-detail/pia21739/',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'jupiter',
    title: 'Jupiter Flyby',
    dateLabel: 'March 5, 1979',
    dateUtcMs: Date.UTC(1979, 2, 5, 12, 5, 26),
    target: 'Jupiter',
    description: 'Voyager 1 transformed our view of Jupiter, revealing violent cloud dynamics, active volcanoes on Io, and the drama of the giant planet up close.',
    note: 'The gravity assist here bent the mission outward and accelerated the spacecraft toward Saturn.',
    viewDistanceMultiplier: 1.9,
    imageUrl: `${VOYAGER_BASE}voyager-jupiter.jpg`,
    imageAlt: 'Voyager view of Jupiter with the Great Red Spot.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager picture of Jupiter',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia01371-voyager-picture-of-jupiter/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
  {
    id: 'saturn',
    title: 'Saturn Flyby',
    dateLabel: 'November 12, 1980',
    dateUtcMs: Date.UTC(1980, 10, 12, 23, 46, 30),
    target: 'Saturn',
    description: 'Voyager 1 skimmed past Saturn, delivered iconic ring and moon imagery, and then left the plane of the planets for the outer dark.',
    note: 'After Saturn, the mission no longer targeted another planet and became a long outward voyage.',
    viewDistanceMultiplier: 2.1,
    imageUrl: `${VOYAGER_BASE}voyager1-saturn.png`,
    imageAlt: 'Voyager 1 image of Saturn and its rings.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 1 Image of Saturn',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-1-image-of-saturn/',
    ...textureFallback('saturn.jpg', 'Saturn'),
  },
  {
    id: 'interstellar',
    title: 'Into Interstellar Space',
    dateLabel: 'August 25, 2012',
    dateUtcMs: Date.UTC(2012, 7, 25, 0, 0, 0),
    target: 'Interstellar',
    description: 'Voyager 1 crossed into interstellar space, where the Sun still influences the spacecraft but the local environment is no longer dominated by the solar wind.',
    note: 'This scene is intentionally not to the real 2012 distance, but it captures the feeling of the mission heading beyond the planets.',
    imageUrl: `${VOYAGER_BASE}voyager-interstellar.jpg`,
    imageAlt: 'Artist concept of Voyager heading toward the final frontier.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Voyager Approaches Final Frontier',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    fallbackImageUrl: `${VOYAGER_BASE}voyager-interstellar.jpg`,
    fallbackImageAlt: 'Artist concept of Voyager heading beyond the planets.',
    fallbackImageCredit: 'NASA/JPL-Caltech',
    fallbackImageSourceLabel: 'Voyager Approaches Final Frontier',
    fallbackImageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    customScenePosition: { x: 118, y: 6, z: -18 },
    customLookTarget: { x: 0, y: 0, z: 0 },
  },
];

const voyager2Milestones: HistoricMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'August 20, 1977',
    dateUtcMs: Date.UTC(1977, 7, 20, 14, 29, 0),
    target: 'Earth',
    description: 'Voyager 2 launched first, setting off on the grand tour that would ultimately include Jupiter, Saturn, Uranus, and Neptune.',
    note: 'Voyager 2 became the only spacecraft to visit the two ice giants up close.',
    viewDistanceMultiplier: 1.35,
    imageUrl: `${VOYAGER_BASE}voyager2-launch.jpg`,
    imageAlt: 'Voyager 2 spacecraft during prelaunch testing.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 prelaunch view',
    imageSourceUrl: 'https://photojournal.jpl.nasa.gov/catalog/PIA21746',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'jupiter',
    title: 'Jupiter Flyby',
    dateLabel: 'July 9, 1979',
    dateUtcMs: Date.UTC(1979, 6, 9, 22, 29, 0),
    target: 'Jupiter',
    description: 'Voyager 2 built on the first encounter by extending the survey of Jupiter’s atmosphere, moons, and magnetosphere from a new geometry.',
    note: 'Together, the two Voyager flybys turned Jupiter into a dynamic world instead of a distant disk.',
    viewDistanceMultiplier: 1.9,
    imageUrl: `${VOYAGER_BASE}voyager2-jupiter.jpg`,
    imageAlt: 'Voyager image of Jupiter with storms and cloud detail.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager at Jupiter',
    imageSourceUrl: 'https://science.nasa.gov/gallery/voyager-at-jupiter/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
  {
    id: 'saturn',
    title: 'Saturn Flyby',
    dateLabel: 'August 26, 1981',
    dateUtcMs: Date.UTC(1981, 7, 26, 3, 24, 5),
    target: 'Saturn',
    description: 'Voyager 2 refined the Saturn story and then made the critical bend that kept the grand tour alive toward Uranus.',
    note: 'Its Saturn flyby was planned differently from Voyager 1 so the mission could continue outward.',
    viewDistanceMultiplier: 2.1,
    imageUrl: `${VOYAGER_BASE}voyager2-saturn.jpg`,
    imageAlt: 'Voyager 2 image of Saturn with rings in view.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 view of Saturn',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-saturn/',
    ...textureFallback('saturn.jpg', 'Saturn'),
  },
  {
    id: 'uranus',
    title: 'Uranus Encounter',
    dateLabel: 'January 24, 1986',
    dateUtcMs: Date.UTC(1986, 0, 24, 17, 59, 47),
    target: 'Uranus',
    description: 'Voyager 2 revealed Uranus as a strangely calm-looking but deeply unusual world, rotating on its side with a tilted and offset magnetic field.',
    note: 'This remains humanity’s only close visit to Uranus.',
    viewDistanceMultiplier: 2.35,
    imageUrl: `${VOYAGER_BASE}voyager2-uranus.png`,
    imageAlt: 'Voyager 2 era image of Uranus.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 Image of Uranus',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-uranus/',
    ...textureFallback('uranus.jpg', 'Uranus'),
  },
  {
    id: 'neptune',
    title: 'Neptune Encounter',
    dateLabel: 'August 25, 1989',
    dateUtcMs: Date.UTC(1989, 7, 25, 3, 56, 36),
    target: 'Neptune',
    description: 'Voyager 2 completed the planetary grand tour at Neptune, showing a deep blue world with fierce winds, bright methane clouds, and a restless atmosphere.',
    note: 'This was the final planetary encounter of the entire Voyager program.',
    viewDistanceMultiplier: 2.45,
    imageUrl: `${VOYAGER_BASE}voyager2-neptune.png`,
    imageAlt: 'Voyager 2 image of Neptune.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 Image of Neptune',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-neptune/',
    ...textureFallback('neptune.jpg', 'Neptune'),
  },
  {
    id: 'interstellar',
    title: 'Into Interstellar Space',
    dateLabel: 'November 5, 2018',
    dateUtcMs: Date.UTC(2018, 10, 5, 0, 0, 0),
    target: 'Interstellar',
    description: 'Voyager 2 later crossed into interstellar space as well, carrying the long arc of the grand tour into the region beyond the heliosphere.',
    note: 'Voyager 2 followed a different outward direction than Voyager 1, but reached the same profound frontier.',
    imageUrl: `${VOYAGER_BASE}voyager-interstellar.jpg`,
    imageAlt: 'Artist concept of Voyager heading beyond the planets.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Voyager Approaches Final Frontier',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    fallbackImageUrl: `${VOYAGER_BASE}voyager-interstellar.jpg`,
    fallbackImageAlt: 'Artist concept of Voyager heading beyond the planets.',
    fallbackImageCredit: 'NASA/JPL-Caltech',
    fallbackImageSourceLabel: 'Voyager Approaches Final Frontier',
    fallbackImageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    customScenePosition: { x: 104, y: -8, z: 24 },
    customLookTarget: { x: 0, y: 0, z: 0 },
  },
];

const cassiniMilestones: HistoricMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'October 15, 1997',
    dateUtcMs: Date.UTC(1997, 9, 15, 8, 43, 0),
    target: 'Earth',
    description: 'Cassini-Huygens left Earth on a long gravity-assist route designed to deliver a heavy flagship spacecraft all the way to Saturn.',
    note: 'Cassini needed planetary flybys to build the speed required for the outer solar system.',
    viewDistanceMultiplier: 1.35,
    imageUrl: `${CASSINI_BASE}cassini-launch.jpg`,
    imageAlt: 'Cassini launch from Cape Canaveral.',
    imageCredit: 'NASA',
    imageSourceLabel: 'Remembering Cassini’s beautiful launch',
    imageSourceUrl: 'https://science.nasa.gov/missions/cassini/remembering-cassinis-beautiful-launch-19-years-ago/',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'venus-assist',
    title: 'Venus Gravity Assist',
    dateLabel: 'April 26, 1998',
    dateUtcMs: Date.UTC(1998, 3, 26, 13, 45, 0),
    target: 'Venus',
    description: 'Cassini swung past Venus to gain energy, using gravity rather than fuel to reshape the mission toward the outer planets.',
    note: 'The real mission used two Venus flybys; this stop captures that slingshot phase in one beat.',
    viewDistanceMultiplier: 1.7,
    imageUrl: `${CASSINI_BASE}cassini-venus.jpg`,
    imageAlt: 'Venus in high cloud views from NASA/JPL.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Venus: high cloud views',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia00223-venus-multiple-views-of-high-level-clouds/',
    ...textureFallback('venus.jpg', 'Venus'),
  },
  {
    id: 'jupiter',
    title: 'Jupiter Flyby',
    dateLabel: 'December 30, 2000',
    dateUtcMs: Date.UTC(2000, 11, 30, 10, 5, 0),
    target: 'Jupiter',
    description: 'On the way to Saturn, Cassini passed Jupiter and returned a bonus science campaign on the giant planet and its magnetosphere.',
    note: 'That final assist completed the energy buildup for Saturn orbit insertion.',
    viewDistanceMultiplier: 1.9,
    imageUrl: `${CASSINI_BASE}cassini-jupiter.jpg`,
    imageAlt: 'Cassini portrait of Jupiter.',
    imageCredit: 'NASA/JPL/University of Arizona',
    imageSourceLabel: 'Cassini Jupiter portrait',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia04866-cassini-jupiter-portrait/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
  {
    id: 'saturn-arrival',
    title: 'Saturn Orbit Insertion',
    dateLabel: 'July 1, 2004',
    dateUtcMs: Date.UTC(2004, 6, 1, 1, 12, 0),
    target: 'Saturn',
    description: 'Cassini fired its engine and slipped into orbit around Saturn, beginning one of the richest planetary missions ever flown.',
    note: 'This is the moment the mission transforms from cruise to long-term Saturn science.',
    viewDistanceMultiplier: 2.15,
    imageUrl: `${CASSINI_BASE}cassini-saturn.jpg`,
    imageAlt: 'Cassini-era image of Saturn and its rings.',
    imageCredit: 'NASA/JPL/Space Science Institute',
    imageSourceLabel: 'Cassini Saturn view',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia05983-saturn-in-natural-color/',
    ...textureFallback('saturn.jpg', 'Saturn'),
  },
  {
    id: 'huygens',
    title: 'Huygens Reaches Titan',
    dateLabel: 'January 14, 2005',
    dateUtcMs: Date.UTC(2005, 0, 14, 12, 43, 0),
    target: 'Saturn',
    description: 'The European-built Huygens probe descended through Titan’s atmosphere and returned humanity’s first direct view from the surface of a world in the outer solar system.',
    note: 'We keep the view anchored near Saturn while the panel spotlights Titan, the most dramatic moon moment of the mission.',
    viewDistanceMultiplier: 2.3,
    imageUrl: `${CASSINI_BASE}huygens-titan.jpg`,
    imageAlt: 'Huygens mosaic from Titan during descent.',
    imageCredit: 'NASA/JPL/ESA/University of Arizona',
    imageSourceLabel: 'Huygens Titan Mosaic #1',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia07870-huygens-titan-mosaic-1/',
    ...textureFallback('saturn.jpg', 'Saturn'),
  },
  {
    id: 'grand-finale',
    title: 'Grand Finale',
    dateLabel: 'September 15, 2017',
    dateUtcMs: Date.UTC(2017, 8, 15, 10, 31, 0),
    target: 'Saturn',
    description: 'Cassini ended with daring ring-gap dives and a final plunge into Saturn, turning the mission’s last act into one more science campaign.',
    note: 'The closing orbits rewrote what we know about Saturn’s rings, atmosphere, and interior.',
    viewDistanceMultiplier: 2.05,
    imageUrl: `${CASSINI_BASE}cassini-grand-finale.jpg`,
    imageAlt: 'Cassini Grand Finale ringscape of Saturn.',
    imageCredit: 'NASA/JPL/Space Science Institute',
    imageSourceLabel: 'Finale ringscape',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia21891-finale-ringscape/',
    ...textureFallback('saturn.jpg', 'Saturn'),
  },
];

const newHorizonsMilestones: HistoricMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'January 19, 2006',
    dateUtcMs: Date.UTC(2006, 0, 19, 19, 0, 0),
    target: 'Earth',
    description: 'New Horizons blasted away from Earth on the fastest planetary launch at the time, aimed at the distant Kuiper Belt.',
    note: 'This mission was designed to cross the entire solar system and reach Pluto before its atmosphere froze out for the season.',
    viewDistanceMultiplier: 1.35,
    imageUrl: `${NEW_HORIZONS_BASE}new-horizons-launch.jpg`,
    imageAlt: 'New Horizons launch from Cape Canaveral.',
    imageCredit: 'NASA',
    imageSourceLabel: 'January 2006: New Horizons launched',
    imageSourceUrl: 'https://www.nasa.gov/image-article/january-2006-new-horizons-launched/',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'jupiter-assist',
    title: 'Jupiter Gravity Assist',
    dateLabel: 'February 28, 2007',
    dateUtcMs: Date.UTC(2007, 1, 28, 5, 43, 0),
    target: 'Jupiter',
    description: 'A fast pass by Jupiter sharpened the trajectory, added speed, and gave New Horizons a science rehearsal before Pluto.',
    note: 'The assist cut years off the total travel time.',
    viewDistanceMultiplier: 1.9,
    imageUrl: `${NEW_HORIZONS_BASE}new-horizons-jupiter.jpg`,
    imageAlt: 'New Horizons full Jupiter mosaic.',
    imageCredit: 'NASA/Johns Hopkins University Applied Physics Laboratory/Southwest Research Institute',
    imageSourceLabel: 'Full Jupiter mosaic',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/full-jupiter-mosaic/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
  {
    id: 'pluto',
    title: 'Pluto Flyby',
    dateLabel: 'July 14, 2015',
    dateUtcMs: Date.UTC(2015, 6, 14, 11, 49, 0),
    target: 'Pluto',
    description: 'New Horizons transformed Pluto from a tiny disk into a complex world with nitrogen plains, mountains of water ice, haze layers, and active geology.',
    note: 'This is the signature encounter of the mission and the first close exploration of Pluto and Charon.',
    viewDistanceMultiplier: 2.05,
    imageUrl: `${NEW_HORIZONS_BASE}new-horizons-pluto.jpg`,
    imageAlt: 'Color image of Pluto from New Horizons.',
    imageCredit: 'NASA/JHUAPL/SwRI',
    imageSourceLabel: 'Color image of Pluto',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia20291-color-image-of-pluto/',
    ...textureFallback('pluto.jpg', 'Pluto'),
  },
  {
    id: 'kuiper-belt',
    title: 'Beyond Pluto to Arrokoth',
    dateLabel: 'January 1, 2019',
    dateUtcMs: Date.UTC(2019, 0, 1, 5, 33, 0),
    target: 'Custom',
    description: 'After Pluto, New Horizons pushed deeper into the Kuiper Belt and flew past Arrokoth, a pristine relic from the solar system’s formation era.',
    note: 'This final stop is placed beyond Pluto to capture the feeling of the mission continuing into the distant frontier.',
    imageUrl: `${NEW_HORIZONS_BASE}new-horizons-arrokoth.png`,
    imageAlt: 'First images of Arrokoth from New Horizons.',
    imageCredit: 'NASA/Johns Hopkins University Applied Physics Laboratory/Southwest Research Institute',
    imageSourceLabel: 'First images of Arrokoth',
    imageSourceUrl: 'https://science.nasa.gov/resource/first-images-of-arrokoth-2014-mu69/',
    ...textureFallback('pluto.jpg', 'Pluto'),
    customScenePosition: { x: 46.5, y: 2.8, z: -10.5 },
    customLookTarget: { x: 39.2, y: 0.4, z: -5.8 },
  },
];

const junoMilestones: HistoricMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'August 5, 2011',
    dateUtcMs: Date.UTC(2011, 7, 5, 16, 25, 0),
    target: 'Earth',
    description: 'Juno launched on a solar-powered journey to Jupiter, carrying instruments built to probe the giant planet beneath its clouds.',
    note: 'Its huge solar arrays made Juno visually distinct from earlier outer-planet missions.',
    viewDistanceMultiplier: 1.35,
    imageUrl: `${JUNO_BASE}juno-launch.jpg`,
    imageAlt: 'Juno lifts off on its way to Jupiter.',
    imageCredit: 'NASA',
    imageSourceLabel: 'Juno lifts off',
    imageSourceUrl: 'https://www.nasa.gov/image-article/juno-lifts-off/',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'earth-flyby',
    title: 'Earth Flyby Boost',
    dateLabel: 'October 9, 2013',
    dateUtcMs: Date.UTC(2013, 9, 9, 19, 21, 0),
    target: 'Earth',
    description: 'Juno looped back for an Earth gravity assist that bent the spacecraft outward toward Jupiter without a major fuel cost.',
    note: 'That swingby was the mission’s last big step before the long cruise to Jupiter.',
    viewDistanceMultiplier: 1.45,
    imageUrl: `${JUNO_BASE}juno-earth-flyby.jpg`,
    imageAlt: 'Juno approaching the Earth-Moon system.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Juno’s approach to the Earth-Moon system',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/junos-approach-to-the-earth-moon-system/',
    ...textureFallback('earth-day.jpg', 'Earth'),
  },
  {
    id: 'jupiter-arrival',
    title: 'Jupiter Orbit Insertion',
    dateLabel: 'July 5, 2016',
    dateUtcMs: Date.UTC(2016, 6, 5, 3, 18, 0),
    target: 'Jupiter',
    description: 'Juno arrived at Jupiter and entered a polar orbit designed to skim close over the cloud tops while staying clear of the harshest radiation as much as possible.',
    note: 'The mission’s science begins once those sweeping polar passes start.',
    viewDistanceMultiplier: 2.05,
    imageUrl: `${JUNO_BASE}juno-arrival.jpg`,
    imageAlt: 'Juno enters orbit around Jupiter.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Juno enters orbit around Jupiter',
    imageSourceUrl: 'https://www.jpl.nasa.gov/news/juno-enters-orbit-around-jupiter/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
  {
    id: 'polar-passes',
    title: 'Close Polar Science Passes',
    dateLabel: 'February 17, 2020',
    dateUtcMs: Date.UTC(2020, 1, 17, 18, 0, 0),
    target: 'Jupiter',
    description: 'Juno’s repeated close passes turned Jupiter into a dynamic, turbulent world of storms, deep weather systems, auroras, and hidden structure.',
    note: 'This phase captures the mission at its scientific peak rather than a single one-day event.',
    viewDistanceMultiplier: 1.95,
    imageUrl: `${JUNO_BASE}juno-polar.jpg`,
    imageAlt: 'Juno close-up of polar storms on Jupiter.',
    imageCredit: 'NASA/JPL-Caltech/SwRI/MSSS',
    imageSourceLabel: 'Close-ups of polar storms on Jupiter',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia25730-nasas-juno-mission-captures-close-ups-of-polar-storms-on-jupiter/',
    ...textureFallback('jupiter.jpg', 'Jupiter'),
  },
];

export const HISTORIC_JOURNEYS: Record<HistoricMissionId, HistoricJourney> = {
  voyager1: {
    id: 'voyager1',
    label: 'Voyager 1 (1977) Journey',
    readyNotification: 'Voyager 1 (1977) journey ready',
    shipProfile: 'voyager',
    milestones: voyager1Milestones,
  },
  voyager2: {
    id: 'voyager2',
    label: 'Voyager 2 (1977) Journey',
    readyNotification: 'Voyager 2 (1977) journey ready',
    shipProfile: 'voyager',
    milestones: voyager2Milestones,
  },
  cassini: {
    id: 'cassini',
    label: 'Cassini-Huygens (1997) Journey',
    readyNotification: 'Cassini-Huygens (1997) journey ready',
    shipProfile: 'cassini',
    milestones: cassiniMilestones,
  },
  newHorizons: {
    id: 'newHorizons',
    label: 'New Horizons (2006) Journey',
    readyNotification: 'New Horizons (2006) journey ready',
    shipProfile: 'newHorizons',
    milestones: newHorizonsMilestones,
  },
  juno: {
    id: 'juno',
    label: 'Juno (2011) Journey',
    readyNotification: 'Juno (2011) journey ready',
    shipProfile: 'juno',
    milestones: junoMilestones,
  },
};
