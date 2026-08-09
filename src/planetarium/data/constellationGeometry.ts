/**
 * The 88 constellation figures as drawable geometry — one snap, two skies.
 *
 * The line data names its endpoints by RA/Dec, and those coordinates are close
 * to a bright star without being it. Drawn raw, a figure's corner sits beside
 * the star it is meant to join and the whole shape reads as slightly off. So
 * every unique endpoint is SNAPPED to the nearest catalog star within 3° and
 * the figure is drawn through the stars themselves.
 *
 * That snap is a scan of the whole bright-star catalog per endpoint, and its
 * answer is a direction — radius-free. The planetarium's sky and the system
 * map's chart draw the same figures at different sphere radii, so the snap is
 * memoized here in RA/Dec and each consumer asks for positions at its own
 * radius. Neither sky can drift from the other, and the catalog is scanned
 * once per session rather than once per sky.
 *
 * Positions go through `raDecToVector` like everything else that turns a
 * celestial coordinate into a scene vector — it is the single chirality
 * definition site.
 *
 * The label anchor is the mean DIRECTION of a figure's unique endpoints.
 * Averaging RA numerically breaks on figures that span the 0h wrap (Pisces
 * straddles the vernal equinox: averaging RA 350° and 10° lands at 180° — the
 * opposite sky); summing unit vectors and normalizing is wrap-free by
 * construction. The sum is taken at the CALLER's radius rather than at unit
 * length: the scaling cancels in exact arithmetic but not in floating point,
 * and these anchors are pinned by test.
 */
import * as THREE from 'three';
import { CONSTELLATIONS } from './constellations';
import { BRIGHT_STAR_CATALOG } from './brightStars';
import { raDecToVector } from '../../astronomy/planetary';
import { DEG2RAD, RAD2DEG } from '../../shared/math/angles';

/** How far a figure's endpoint may be from a catalog star and still be taken
 *  to mean it. */
export const CONSTELLATION_SNAP_RADIUS_DEG = 3;

/** One figure's snapped geometry. `segments` is four numbers per line —
 *  ra1, dec1, ra2, dec2 in degrees — and `points` is the same endpoints
 *  de-duplicated, in the order the lines first name them. */
export interface ConstellationFigureSnap {
  name: string;
  segments: Float64Array;
  points: Float64Array;
}

/** A figure's name and where its label belongs, at the requested radius. */
export interface ConstellationAnchor {
  name: string;
  position: THREE.Vector3;
}

/** Angular distance between two RA/Dec pairs, in degrees. */
function angularDistDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * DEG2RAD;
  const d2 = dec2 * DEG2RAD;
  const dRa = (ra2 - ra1) * DEG2RAD;
  const sinD1 = Math.sin(d1), cosD1 = Math.cos(d1);
  const sinD2 = Math.sin(d2), cosD2 = Math.cos(d2);
  const sinDRa = Math.sin(dRa), cosDRa = Math.cos(dRa);
  const a = cosD2 * sinDRa;
  const b = cosD1 * sinD2 - sinD1 * cosD2 * cosDRa;
  const c = sinD1 * sinD2 + cosD1 * cosD2 * cosDRa;
  return Math.atan2(Math.sqrt(a * a + b * b), c) * RAD2DEG;
}

let snapped: ConstellationFigureSnap[] | null = null;

/** Every figure's endpoints, snapped to the catalog. Memoized: the scan costs
 *  one pass over the bright stars per unique endpoint and the answer never
 *  changes. */
export function snapConstellations(): readonly ConstellationFigureSnap[] {
  if (snapped) return snapped;
  const cache = new Map<string, [number, number]>();
  const snap = (ra: number, dec: number): [number, number] => {
    const key = `${ra},${dec}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let bestRa = ra;
    let bestDec = dec;
    let bestDist = CONSTELLATION_SNAP_RADIUS_DEG;
    for (const star of BRIGHT_STAR_CATALOG) {
      const d = angularDistDeg(ra, dec, star.raDeg, star.decDeg);
      if (d < bestDist) {
        bestDist = d;
        bestRa = star.raDeg;
        bestDec = star.decDeg;
      }
    }
    const result: [number, number] = [bestRa, bestDec];
    cache.set(key, result);
    return result;
  };

  snapped = CONSTELLATIONS.map((constellation) => {
    const segments = new Float64Array(constellation.lines.length * 4);
    const points: number[] = [];
    const seen = new Set<string>();
    let at = 0;
    for (const [ra1, dec1, ra2, dec2] of constellation.lines) {
      const [sra1, sdec1] = snap(ra1, dec1);
      const [sra2, sdec2] = snap(ra2, dec2);
      segments[at++] = sra1;
      segments[at++] = sdec1;
      segments[at++] = sra2;
      segments[at++] = sdec2;
      const k1 = `${sra1},${sdec1}`;
      if (!seen.has(k1)) { seen.add(k1); points.push(sra1, sdec1); }
      const k2 = `${sra2},${sdec2}`;
      if (!seen.has(k2)) { seen.add(k2); points.push(sra2, sdec2); }
    }
    return { name: constellation.name, segments, points: Float64Array.from(points) };
  });
  return snapped;
}

/**
 * Every figure's lines as flat LineSegments positions at `radius`: two
 * vertices per segment, all 88 figures in catalog order.
 */
export function constellationSegmentPositions(radius: number): Float32Array {
  const figures = snapConstellations();
  let total = 0;
  for (const figure of figures) total += figure.segments.length / 4;
  const positions = new Float32Array(total * 6);
  const scratch = new THREE.Vector3();
  let at = 0;
  for (const figure of figures) {
    for (let i = 0; i < figure.segments.length; i += 2) {
      scratch.copy(raDecToVector(figure.segments[i], figure.segments[i + 1], radius));
      positions[at++] = scratch.x;
      positions[at++] = scratch.y;
      positions[at++] = scratch.z;
    }
  }
  return positions;
}

/**
 * One anchor per figure that has a meaningful mean direction, at `radius`.
 *
 * A near-zero sum (endpoints spread antipodally) has none — no real figure
 * does this, but an anchor at a garbage direction is worse than none, so such
 * a figure is simply left out and the caller labels what it gets.
 */
export function constellationLabelAnchors(radius: number): ConstellationAnchor[] {
  const anchors: ConstellationAnchor[] = [];
  const scratch = new THREE.Vector3();
  for (const figure of snapConstellations()) {
    const sum = new THREE.Vector3();
    const count = figure.points.length / 2;
    for (let i = 0; i < figure.points.length; i += 2) {
      sum.add(scratch.copy(raDecToVector(figure.points[i], figure.points[i + 1], radius)));
    }
    if (count > 0 && sum.lengthSq() > 1e-6) {
      anchors.push({ name: figure.name, position: sum.normalize().multiplyScalar(radius) });
    }
  }
  return anchors;
}
