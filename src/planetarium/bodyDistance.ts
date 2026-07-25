import { KM_PER_AU } from '../astronomy/constants';

/**
 * The one body-distance readout the UI shares — the planet/Sun labels and the
 * system-map card all format a distance the same way: metre-precise kilometres
 * under 0.01 AU (close approaches read in km), two-decimal AU beyond. One
 * definition site so no two surfaces disagree on how far a body is.
 */
export function formatBodyDistance(distAU: number): string {
  return distAU < 0.01
    ? `${(distAU * KM_PER_AU).toFixed(0)} km`
    : `${distAU.toFixed(2)} AU`;
}
