/**
 * The 88 constellation figures as drawable geometry — one snap, two skies.
 *
 * The line data names its endpoints by RA/Dec, and those coordinates are close
 * to a bright star without being it. Drawn raw, a figure's corner sits beside
 * the star it is meant to join and the whole shape reads as slightly off. So
 * every unique endpoint is SNAPPED to the nearest catalog star within 3° and
 * the figure is drawn through the stars themselves.
 *
 * The snap's answer is a direction — radius-free. The planetarium's sky and
 * the system map's chart draw the same figures at different sphere radii, so
 * the snap is memoized here in RA/Dec and each consumer asks for positions at
 * its own radius. Neither sky can drift from the other, and the catalog is
 * scanned once per session rather than once per sky.
 *
 * The nearest-star search compares by cosine over precomputed unit vectors
 * (monotone in angle — no per-pair trig) and walks only a declination band of
 * the catalog: the great-circle distance between two points is never less
 * than their declination difference, so a star more than the snap radius away
 * in declination alone can never win. A naive full-trig scan of all ~26k
 * catalog stars for every endpoint costs ~700ms of main thread — this shape
 * costs single-digit milliseconds and returns identical results (the
 * colocated test pins byte-identity against the naive reference).
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
import { DEG2RAD } from '../../shared/math/angles';

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

let snapped: ConstellationFigureSnap[] | null = null;

/** The catalog prepared for the nearest-star search: unit vectors for the
 *  cosine compare, the RA/Dec each vector answers for, and the original
 *  catalog position for tie-breaking — all in declination order so a search
 *  can binary-search to its band and stop at the band's far edge. Built on
 *  first use; ~1MB retained, noise beside the catalog itself. */
interface CatalogIndex {
  sx: Float64Array; sy: Float64Array; sz: Float64Array;
  sRa: Float64Array; sDec: Float64Array;
  catalogPos: Int32Array;
  minCos: number;
}

let catalogIndex: CatalogIndex | null = null;

function buildCatalogIndex(): CatalogIndex {
  const n = BRIGHT_STAR_CATALOG.length;
  const order = BRIGHT_STAR_CATALOG.map((_, i) => i)
    .sort((a, b) => BRIGHT_STAR_CATALOG[a].decDeg - BRIGHT_STAR_CATALOG[b].decDeg);
  const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
  const sRa = new Float64Array(n), sDec = new Float64Array(n);
  const catalogPos = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const star = BRIGHT_STAR_CATALOG[order[i]];
    const d = star.decDeg * DEG2RAD, r = star.raDeg * DEG2RAD;
    const cosD = Math.cos(d);
    sx[i] = cosD * Math.cos(r);
    sy[i] = cosD * Math.sin(r);
    sz[i] = Math.sin(d);
    sRa[i] = star.raDeg;
    sDec[i] = star.decDeg;
    catalogPos[i] = order[i];
  }
  // Strictly-inside-the-radius, like the trig comparison it replaces: cosine
  // is monotone decreasing in angle, so "distance < radius" is
  // "cosine > cos(radius)".
  const minCos = Math.cos(CONSTELLATION_SNAP_RADIUS_DEG * DEG2RAD);
  return { sx, sy, sz, sRa, sDec, catalogPos, minCos };
}

/**
 * Nearest catalog star strictly within the snap radius of (ra, dec), or the
 * point itself when none is. The per-endpoint engine behind
 * `snapConstellations`, exported so the boundary cases the real figure data
 * never exercises — off-star endpoints, near-ties, the radius edge — stay
 * testable against a naive full-scan reference.
 *
 * An exact cosine tie goes to the star earlier in the catalog, the same
 * winner the full catalog-order scan kept. A near-tie below the rounding
 * disparity between the cosine and trig formulations could in principle pick
 * the other star of the pair; the colocated identity test runs both
 * formulations over the real data and would surface such a pair.
 */
export function snapPointToCatalog(ra: number, dec: number): [number, number] {
  const idx = catalogIndex ??= buildCatalogIndex();
  const { sx, sy, sz, sRa, sDec, catalogPos, minCos } = idx;
  const n = sDec.length;
  const d = dec * DEG2RAD, r = ra * DEG2RAD;
  const cosD = Math.cos(d);
  const ex = cosD * Math.cos(r), ey = cosD * Math.sin(r), ez = Math.sin(d);
  // First catalog entry whose declination could possibly be within radius:
  // great-circle distance is never less than the declination difference.
  const floor = dec - CONSTELLATION_SNAP_RADIUS_DEG;
  const ceil = dec + CONSTELLATION_SNAP_RADIUS_DEG;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sDec[mid] < floor) lo = mid + 1; else hi = mid;
  }
  let bestRa = ra;
  let bestDec = dec;
  let bestCos = minCos;
  let bestPos = -1; // no star inside the radius yet
  for (let i = lo; i < n && sDec[i] <= ceil; i++) {
    const c = ex * sx[i] + ey * sy[i] + ez * sz[i];
    if (c > bestCos || (c === bestCos && bestPos >= 0 && catalogPos[i] < bestPos)) {
      bestCos = c;
      bestPos = catalogPos[i];
      bestRa = sRa[i];
      bestDec = sDec[i];
    }
  }
  return [bestRa, bestDec];
}

/** Every figure's endpoints, snapped to the catalog. Memoized; warmed off
 *  the critical path by PlanetariumMode's activation so no gesture pays even
 *  the banded scan. */
export function snapConstellations(): readonly ConstellationFigureSnap[] {
  if (snapped) return snapped;
  const cache = new Map<string, [number, number]>();
  const snap = (ra: number, dec: number): [number, number] => {
    const key = `${ra},${dec}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const result = snapPointToCatalog(ra, dec);
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
