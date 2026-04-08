export type VoyagerTarget = 'Earth' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune' | 'Interstellar';
export type VoyagerMissionId = 'voyager1' | 'voyager2';

export type VoyagerMilestone = {
  id: string;
  title: string;
  dateLabel: string;
  dateUtcMs: number;
  target: VoyagerTarget;
  description: string;
  note: string;
  viewDistanceMultiplier?: number;
  imageUrl: string;
  imageAlt: string;
  imageCredit: string;
  imageSourceLabel: string;
  imageSourceUrl: string;
  customScenePosition?: { x: number; y: number; z: number };
  customLookTarget?: { x: number; y: number; z: number };
};

export type VoyagerJourney = {
  id: VoyagerMissionId;
  label: string;
  readyNotification: string;
  milestones: VoyagerMilestone[];
};

const voyager1Milestones: VoyagerMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'September 5, 1977',
    dateUtcMs: Date.UTC(1977, 8, 5, 12, 56, 0),
    target: 'Earth',
    description: 'Voyager 1 lifted off from Cape Canaveral and began the fastest outward path ever attempted at the time.',
    note: 'This stop frames the mission near Earth so the story starts with a recognizable scale.',
    viewDistanceMultiplier: 1.35,
    imageUrl: 'https://science.nasa.gov/wp-content/uploads/2024/04/pia21739.jpg',
    imageAlt: 'Voyager 1 launch vehicle on the pad.',
    imageCredit: 'NASA',
    imageSourceLabel: 'Voyager 1’s Launch Vehicle',
    imageSourceUrl: 'https://science.nasa.gov/image-detail/pia21739/',
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
    imageUrl: 'https://d2pn8kiwq2w21t.cloudfront.net/original_images/jpegPIA01371.jpg',
    imageAlt: 'Voyager view of Jupiter with the Great Red Spot.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager picture of Jupiter',
    imageSourceUrl: 'https://www.jpl.nasa.gov/images/pia01371-voyager-picture-of-jupiter/',
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
    imageUrl: 'https://www.nasa.gov/wp-content/uploads/2023/03/pia01969-saturn-voyager1.png',
    imageAlt: 'Voyager 1 image of Saturn and its rings.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 1 Image of Saturn',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-1-image-of-saturn/',
  },
  {
    id: 'interstellar',
    title: 'Into Interstellar Space',
    dateLabel: 'August 25, 2012',
    dateUtcMs: Date.UTC(2012, 7, 25, 0, 0, 0),
    target: 'Interstellar',
    description: 'Voyager 1 crossed into interstellar space, where the Sun still influences the spacecraft but the local environment is no longer dominated by the solar wind.',
    note: 'This scene is intentionally not to the real 2012 distance, but it captures the feeling of the mission heading beyond the planets.',
    imageUrl: 'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia04/pia04927/PIA04927.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg',
    imageAlt: 'Artist concept of Voyager heading toward the final frontier.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Voyager Approaches Final Frontier',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    customScenePosition: { x: 118, y: 6, z: -18 },
    customLookTarget: { x: 0, y: 0, z: 0 },
  },
];

const voyager2Milestones: VoyagerMilestone[] = [
  {
    id: 'launch',
    title: 'Launch From Earth',
    dateLabel: 'August 20, 1977',
    dateUtcMs: Date.UTC(1977, 7, 20, 14, 29, 0),
    target: 'Earth',
    description: 'Voyager 2 launched first, setting off on the grand tour that would ultimately include Jupiter, Saturn, Uranus, and Neptune.',
    note: 'Voyager 2 became the only spacecraft to visit the two ice giants up close.',
    viewDistanceMultiplier: 1.35,
    imageUrl: 'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia21/pia21746/PIA21746.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg',
    imageAlt: 'Voyager 2 spacecraft during prelaunch testing.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 prelaunch view',
    imageSourceUrl: 'https://photojournal.jpl.nasa.gov/catalog/PIA21746',
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
    imageUrl: 'https://science.nasa.gov/wp-content/uploads/2024/04/pia00459.jpg',
    imageAlt: 'Voyager image of Jupiter with storms and cloud detail.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager at Jupiter',
    imageSourceUrl: 'https://science.nasa.gov/gallery/voyager-at-jupiter/',
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
    imageUrl: 'https://www.nasa.gov/wp-content/uploads/2023/03/pia01929-saturn-voyager2.jpg',
    imageAlt: 'Voyager 2 image of Saturn with rings in view.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 view of Saturn',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-saturn/',
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
    imageUrl: 'https://www.nasa.gov/wp-content/uploads/2023/03/pia18182-uranus-voyager1.png',
    imageAlt: 'Voyager 2 era image of Uranus.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 Image of Uranus',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-uranus/',
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
    imageUrl: 'https://www.nasa.gov/wp-content/uploads/2023/03/neptune1.png',
    imageAlt: 'Voyager 2 image of Neptune.',
    imageCredit: 'NASA/JPL',
    imageSourceLabel: 'Voyager 2 Image of Neptune',
    imageSourceUrl: 'https://www.nasa.gov/image-article/voyager-2-image-of-neptune/',
  },
  {
    id: 'interstellar',
    title: 'Into Interstellar Space',
    dateLabel: 'November 5, 2018',
    dateUtcMs: Date.UTC(2018, 10, 5, 0, 0, 0),
    target: 'Interstellar',
    description: 'Voyager 2 later crossed into interstellar space as well, carrying the long arc of the grand tour into the region beyond the heliosphere.',
    note: 'Voyager 2 followed a different outward direction than Voyager 1, but reached the same profound frontier.',
    imageUrl: 'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia04/pia04927/PIA04927.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg',
    imageAlt: 'Artist concept of Voyager heading beyond the planets.',
    imageCredit: 'NASA/JPL-Caltech',
    imageSourceLabel: 'Voyager Approaches Final Frontier',
    imageSourceUrl: 'https://science.nasa.gov/photojournal/voyager-approaches-final-frontier-artists-concept/',
    customScenePosition: { x: 104, y: -8, z: 24 },
    customLookTarget: { x: 0, y: 0, z: 0 },
  },
];

export const VOYAGER_JOURNEYS: Record<VoyagerMissionId, VoyagerJourney> = {
  voyager1: {
    id: 'voyager1',
    label: 'Voyager 1 Journey',
    readyNotification: 'Voyager 1 journey ready',
    milestones: voyager1Milestones,
  },
  voyager2: {
    id: 'voyager2',
    label: 'Voyager 2 Journey',
    readyNotification: 'Voyager 2 journey ready',
    milestones: voyager2Milestones,
  },
};
