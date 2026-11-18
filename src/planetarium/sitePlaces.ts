/**
 * Named places to stand, per body: a short list at published coordinates in
 * the frame the body is drawn in. The ground is flat, so a place is its
 * latitude and longitude, never its terrain; a place whose sky depends on
 * its terrain (a crater floor in permanent shadow) is not offered under a
 * name that promises it.
 *
 * The Moon's are Mean Earth/polar axis coordinates, the frame
 * lunarOrientation.ts turns the Moon by:
 * - the Apollo lunar modules, from LRO images (Wagner et al. 2017, Icarus
 *   283, 92–103), as NASA's NSSDCA lists them;
 * - Chang'e 4, from its descent reconstruction (Liu et al. 2019, Nature
 *   Communications, doi:10.1038/s41467-019-12278-3);
 * - Mare Marginis, the centre the IAU gazetteer gives.
 *
 * A body with places here also needs its ground's albedo
 * (siteGround.ts SITE_GROUND_ALBEDO_LINEAR) before it is offered.
 */
export interface SitePlace {
  name: string;
  latitudeDeg: number;
  /** East-positive. */
  longitudeDeg: number;
  /** What the place is, in a few words ("Apollo 11"). */
  note: string;
}

export const SITE_PLACES: Readonly<Record<string, readonly SitePlace[]>> = {
  Moon: [
    { name: 'Tranquility Base', latitudeDeg: 0.67416, longitudeDeg: 23.47314, note: 'Apollo 11' },
    { name: 'Hadley–Apennine', latitudeDeg: 26.13239, longitudeDeg: 3.6333, note: 'Apollo 15' },
    { name: 'Taurus–Littrow', latitudeDeg: 20.1911, longitudeDeg: 30.7723, note: 'Apollo 17' },
    // Near the eastern limb: libration swings Earth up and down over the
    // horizon through the month.
    { name: 'Mare Marginis', latitudeDeg: 12.7, longitudeDeg: 86.52, note: 'the eastern limb' },
    { name: 'The south pole', latitudeDeg: -90, longitudeDeg: 0, note: 'the Sun skims the horizon' },
    { name: 'Von Kármán crater', latitudeDeg: -45.4446, longitudeDeg: 177.5991, note: 'Chang’e 4, far side' },
  ],
};

/** Eye height at a named place, km: a person standing (assumption A1). */
export const SITE_EYE_HEIGHT_KM = 0.002;
