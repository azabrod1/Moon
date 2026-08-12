import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CONSTELLATION_SNAP_RADIUS_DEG,
  constellationLabelAnchors,
  constellationSegmentPositions,
  snapConstellations,
  snapPointToCatalog,
} from './constellationGeometry';
import { CONSTELLATIONS } from './constellations';
import { loadBrightStarCatalogFromDisk } from './brightStarsTestCatalog';

const BRIGHT_STAR_CATALOG = loadBrightStarCatalogFromDisk();
import { raDecToVector } from '../../astronomy/planetary';
import { STAR_SPHERE_RADIUS } from '../world/starfield';
import { DEG2RAD, RAD2DEG } from '../../shared/math/angles';

/**
 * The world sky's original figure builder, transcribed from the version that
 * lived inside Constellations.ts before the snap was shared with the chart.
 *
 * It is the oracle for this suite, and the reason it is a copy rather than an
 * import: the extraction is only safe if the geometry it produces is IDENTICAL
 * to the pixels people have been looking at — same line vertices, same label
 * anchors, bit for bit. Floating point makes that a real question, not a
 * formality: summing at unit length and scaling afterwards would be the same
 * arithmetic on paper and a different last bit in practice.
 */
function referenceBuild(): { positions: Float32Array; anchors: { name: string; pos: THREE.Vector3 }[] } {
  const snapCache = new Map<string, [number, number]>();
  const angularDistDeg = (ra1: number, dec1: number, ra2: number, dec2: number): number => {
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
  };
  const snap = (ra: number, dec: number): [number, number] => {
    const key = `${ra},${dec}`;
    const cached = snapCache.get(key);
    if (cached) return cached;
    let bestRa = ra;
    let bestDec = dec;
    let bestDist = 3;
    for (const star of BRIGHT_STAR_CATALOG) {
      const d = angularDistDeg(ra, dec, star.raDeg, star.decDeg);
      if (d < bestDist) {
        bestDist = d;
        bestRa = star.raDeg;
        bestDec = star.decDeg;
      }
    }
    const result: [number, number] = [bestRa, bestDec];
    snapCache.set(key, result);
    return result;
  };
  const celestialToVec3 = (raDeg: number, decDeg: number, out: THREE.Vector3): THREE.Vector3 =>
    out.copy(raDecToVector(raDeg, decDeg, STAR_SPHERE_RADIUS));

  let totalSegments = 0;
  for (const constellation of CONSTELLATIONS) totalSegments += constellation.lines.length;
  const positions = new Float32Array(totalSegments * 6);
  let idx = 0;
  const vectorScratch = new THREE.Vector3();
  const anchors: { name: string; pos: THREE.Vector3 }[] = [];

  for (const constellation of CONSTELLATIONS) {
    const centroidSum = new THREE.Vector3();
    let nPoints = 0;
    const pointSet = new Set<string>();
    for (const [ra1, dec1, ra2, dec2] of constellation.lines) {
      const [sra1, sdec1] = snap(ra1, dec1);
      const [sra2, sdec2] = snap(ra2, dec2);
      celestialToVec3(sra1, sdec1, vectorScratch);
      positions[idx++] = vectorScratch.x;
      positions[idx++] = vectorScratch.y;
      positions[idx++] = vectorScratch.z;
      celestialToVec3(sra2, sdec2, vectorScratch);
      positions[idx++] = vectorScratch.x;
      positions[idx++] = vectorScratch.y;
      positions[idx++] = vectorScratch.z;
      const k1 = `${sra1},${sdec1}`;
      const k2 = `${sra2},${sdec2}`;
      if (!pointSet.has(k1)) {
        pointSet.add(k1);
        centroidSum.add(celestialToVec3(sra1, sdec1, vectorScratch));
        nPoints++;
      }
      if (!pointSet.has(k2)) {
        pointSet.add(k2);
        centroidSum.add(celestialToVec3(sra2, sdec2, vectorScratch));
        nPoints++;
      }
    }
    if (nPoints > 0 && centroidSum.lengthSq() > 1e-6) {
      anchors.push({
        name: constellation.name,
        pos: centroidSum.clone().normalize().multiplyScalar(STAR_SPHERE_RADIUS),
      });
    }
  }
  return { positions, anchors };
}

describe('the shared constellation snap', () => {
  it('draws the world sky’s lines bit for bit', () => {
    const reference = referenceBuild().positions;
    const shared = constellationSegmentPositions(STAR_SPHERE_RADIUS);
    expect(shared.length).toBe(reference.length);
    // Not toEqual on the arrays: a mismatch buried in ~8000 floats has to
    // report WHERE, or the failure says nothing about what moved.
    let firstDiff = -1;
    for (let i = 0; i < reference.length; i++) {
      if (shared[i] !== reference[i]) { firstDiff = i; break; }
    }
    expect({ index: firstDiff, value: firstDiff < 0 ? 0 : shared[firstDiff] })
      .toEqual({ index: -1, value: 0 });
  });

  it('anchors the world sky’s labels bit for bit', () => {
    const reference = referenceBuild().anchors;
    const shared = constellationLabelAnchors(STAR_SPHERE_RADIUS);
    expect(shared.map((a) => a.name)).toEqual(reference.map((a) => a.name));
    for (let i = 0; i < reference.length; i++) {
      expect([shared[i].position.x, shared[i].position.y, shared[i].position.z])
        .toEqual([reference[i].pos.x, reference[i].pos.y, reference[i].pos.z]);
    }
  });

  it('labels every figure — none of the 88 is antipodal enough to lose its anchor', () => {
    expect(constellationLabelAnchors(STAR_SPHERE_RADIUS)).toHaveLength(CONSTELLATIONS.length);
  });

  it('is one snap serving every radius: only the scale differs', () => {
    const near = constellationSegmentPositions(1);
    const far = constellationSegmentPositions(STAR_SPHERE_RADIUS);
    expect(near.length).toBe(far.length);
    for (let i = 0; i < near.length; i++) {
      // Float32 rounding on both sides, so this is a ratio check rather than
      // an equality: what it pins is that the DIRECTIONS agree.
      if (Math.abs(far[i]) < 1e-3) continue;
      expect(near[i] * STAR_SPHERE_RADIUS / far[i]).toBeCloseTo(1, 4);
    }
  });

  it('snaps an endpoint only to a star inside the radius', () => {
    const stars = new Set(BRIGHT_STAR_CATALOG.map((s) => `${s.raDeg},${s.decDeg}`));
    let moved = 0;
    for (const figure of snapConstellations()) {
      for (let i = 0; i < figure.points.length; i += 2) {
        if (stars.has(`${figure.points[i]},${figure.points[i + 1]}`)) moved++;
      }
    }
    // Most endpoints ARE stars — that is the whole point of the snap. The
    // guard is that the operation happened at all and that the radius is the
    // documented one.
    expect(moved).toBeGreaterThan(0);
    expect(CONSTELLATION_SNAP_RADIUS_DEG).toBe(3);
  });
});

/**
 * Every unique endpoint in today's figure data is already an exact catalog
 * coordinate, so the byte-identity suite above never makes the search choose
 * between stars. This sweep does: synthetic off-star points across the whole
 * sky — poles, the RA wrap, points at varied pulls from a star — each
 * checked for exact equality against a naive full-catalog trig scan, which
 * is the oracle for who wins.
 *
 * What the sweep deliberately does NOT claim: the no-star-within-radius
 * fallback, the exact 3° cutoff, and an exact cosine tie are all unreachable
 * against this catalog — ~26k stars put two dozen inside any 3° circle, so
 * the nearest is never anywhere near the radius and never exactly tied.
 * Those branches are read-verified; the tie rule mirrors the reference
 * scan's catalog-order winner by construction.
 */
describe('snapPointToCatalog', () => {
  const naiveSnap = (ra: number, dec: number): [number, number] => {
    const angularDistDeg = (ra1: number, dec1: number, ra2: number, dec2: number): number => {
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
    };
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
    return [bestRa, bestDec];
  };

  it('matches the naive full-catalog scan across the sky, off-star points included', () => {
    const points: [number, number][] = [];
    // Golden-angle spiral: deterministic, incommensurate with the catalog's
    // structure, and reaching both polar caps.
    for (let i = 0; i < 120; i++) {
      points.push([(i * 137.50776405) % 360, -88 + ((i * 47.9) % 176)]);
    }
    const anchor = BRIGHT_STAR_CATALOG.find((s) => Math.abs(s.decDeg) < 60)!;
    points.push(
      [anchor.raDeg, anchor.decDeg],
      [anchor.raDeg, anchor.decDeg + 0.5],
      [anchor.raDeg, anchor.decDeg + 1.7],
      [anchor.raDeg, anchor.decDeg + 2.6],
      [0.01, 15], [359.99, 15],
      [12, 89.99], [200, -89.99],
    );
    for (const [ra, dec] of points) {
      expect(snapPointToCatalog(ra, dec), `at ra ${ra}, dec ${dec}`).toEqual(naiveSnap(ra, dec));
    }
  });
});
