import { describe, expect, it } from 'vitest';
import { KM_PER_AU } from '../astronomy/constants';
import {
  createOrbitLineAnchorFrame,
  setOrbitLineAnchorSamples,
  writeAnchoredSegmentPairs,
  type OrbitLineAnchorFrame,
} from './orbitLineAnchor';
import {
  BEND_DETECT_RADIUS_PX,
  BEND_SIGMA_MAX_PX,
  BEND_SIGMA_MIN_PX,
  BEND_TARGET_RADIUS_PX,
  applyOrbitLineBend,
  bendSigmaPx,
  createOrbitLineBendState,
  nearestVertexIndex,
  type OrbitLineBendView,
} from './orbitLineBend';

// A Pluto-sized circle in the y=0 plane at Pluto's tessellation, sampled as
// the real strip is: open, one lap, vertex 0 and vertex N at the same point.
const ORBIT_RADIUS_AU = 39.5;
const SEGMENTS = 9984;
// A 60° display FOV over an 844 px tall phone viewport.
const FOCAL_PX = 844 / 2 / Math.tan(Math.PI / 6);

function circleFrame(): OrbitLineAnchorFrame {
  const points: { x: number; y: number; z: number }[] = [];
  for (let vertex = 0; vertex <= SEGMENTS; vertex++) {
    // Start the strip opposite the region under test so the seam is far away.
    const angle = Math.PI + (vertex / SEGMENTS) * 2 * Math.PI;
    points.push({ x: ORBIT_RADIUS_AU * Math.cos(angle), y: 0, z: ORBIT_RADIUS_AU * Math.sin(angle) });
  }
  const frame = createOrbitLineAnchorFrame();
  setOrbitLineAnchorSamples(frame, points);
  return frame;
}

/** A camera `lateralKm` outside the circle and `heightKm` above its plane,
 *  beside the vertex at angle 0 (the point (R, 0, 0)), looking along the
 *  tangent there (+z) so that direction's vanishing point is screen-centre
 *  and the plane's horizon runs through it. */
function cameraBeside(lateralKm: number, heightKm: number): OrbitLineBendView {
  return {
    camX: ORBIT_RADIUS_AU + lateralKm / KM_PER_AU,
    camY: heightKm / KM_PER_AU,
    camZ: 0,
    // three's basis: right = up × back for forward = +z, up = +y.
    rightX: -1, rightY: 0, rightZ: 0,
    upX: 0, upY: 1, upZ: 0,
    forwardX: 0, forwardY: 0, forwardZ: 1,
    focalPx: FOCAL_PX,
  };
}

interface Projected { x: number; y: number; depth: number }

/** The same rectilinear projection the pass uses, of a vertex read back
 *  from the pair buffer (anchored float32) or from the double samples. */
function projectPoint(view: OrbitLineBendView, px: number, py: number, pz: number): Projected {
  const dx = px - view.camX;
  const dy = py - view.camY;
  const dz = pz - view.camZ;
  const depth = dx * view.forwardX + dy * view.forwardY + dz * view.forwardZ;
  return {
    x: (view.focalPx * (dx * view.rightX + dy * view.rightY + dz * view.rightZ)) / depth,
    y: (view.focalPx * (dx * view.upX + dy * view.upY + dz * view.upZ)) / depth,
    depth,
  };
}

function bufferVertex(frame: OrbitLineAnchorFrame, pairs: Float32Array, vertex: number): [number, number, number] {
  const offset = vertex < frame.vertexCount - 1 ? vertex * 6 : (vertex - 1) * 6 + 3;
  return [pairs[offset] + frame.anchor.x, pairs[offset + 1] + frame.anchor.y, pairs[offset + 2] + frame.anchor.z];
}

function sampleVertex(frame: OrbitLineAnchorFrame, vertex: number): [number, number, number] {
  const s = vertex * 3;
  return [frame.samples[s], frame.samples[s + 1], frame.samples[s + 2]];
}

/** Circumradius of three points. */
function circumradius(a: Projected, b: Projected, c: Projected): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return cross > 0 ? (ab * bc * ca) / (2 * cross) : Infinity;
}

/**
 * The tightest bend of a projected polyline, read at a fixed screen scale:
 * the polyline is resampled every `stepPx` of arc and the circumradius taken
 * over triplets `spanPx` apart, so a dense polyline and a sparse one read the
 * same. Only the in-front vertices between the given indices are read.
 */
function tightestRadiusPx(
  points: Projected[],
  stepPx = 0.5,
  spanPx = 3,
): { radiusPx: number; at: Projected } {
  // Only what is anywhere near the screen: a vertex just in front of the
  // camera plane projects a million px out, and resampling toward it would
  // never end.
  points = points.filter((p) => Math.abs(p.x) < 4000 && Math.abs(p.y) < 4000);
  const resampled: Projected[] = [];
  let carry = 0;
  resampled.push(points[0]);
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let along = stepPx - carry;
    while (along <= length) {
      const t = along / length;
      resampled.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, depth: 0 });
      along += stepPx;
    }
    carry = length - (along - stepPx);
  }
  const span = Math.round(spanPx / stepPx);
  let best = { radiusPx: Infinity, at: resampled[0] };
  for (let index = span; index + span < resampled.length; index++) {
    const radiusPx = circumradius(resampled[index - span], resampled[index], resampled[index + span]);
    if (radiusPx < best.radiusPx) best = { radiusPx, at: resampled[index] };
  }
  return best;
}

/** The window's in-front vertices projected from the pair buffer. */
function projectedRun(
  frame: OrbitLineAnchorFrame,
  pairs: Float32Array,
  view: OrbitLineBendView,
  first: number,
  last: number,
): Projected[] {
  const out: Projected[] = [];
  for (let vertex = first; vertex <= last; vertex++) {
    const p = projectPoint(view, ...bufferVertex(frame, pairs, vertex));
    if (p.depth > 0) out.push(p);
  }
  return out;
}

function setup(lateralKm: number, heightKm: number) {
  const frame = circleFrame();
  const view = cameraBeside(lateralKm, heightKm);
  // Anchored at the camera, as a line the ship is beside would be.
  frame.anchor.x = view.camX;
  frame.anchor.y = view.camY;
  frame.anchor.z = view.camZ;
  const pairs = new Float32Array(SEGMENTS * 6);
  writeAnchoredSegmentPairs(frame, pairs);
  const original = pairs.slice();
  const state = createOrbitLineBendState();
  return { frame, view, pairs, original, state };
}

describe('orbit line bend: the corner from beside Pluto', () => {
  it('reads as a corner before the pass: a bend tighter than the line width', () => {
    const { frame, view, pairs } = setup(1e5, 1.7e5);
    const nearest = nearestVertexIndex(frame, view.camX, view.camY, view.camZ);
    const before = tightestRadiusPx(projectedRun(frame, pairs, view, nearest, nearest + 2000));
    // The exact projection turns through ~120° inside about a dozen px.
    expect(before.radiusPx).toBeLessThan(4);
  });

  it('rounds it to a smooth bend, keeps the curve in depth, and leaves the straight run alone', () => {
    const { frame, view, pairs, original, state } = setup(1e5, 1.7e5);
    const write = applyOrbitLineBend(frame, view, state, pairs);
    expect(write).not.toBeNull();
    expect(state.active).toBe(true);
    expect(state.smoothedCount).toBeGreaterThan(20);
    expect(state.cornerTurnDeg).toBeGreaterThan(100);
    expect(state.cornerTurnDeg).toBeLessThan(140);

    const drawn = projectedRun(frame, pairs, view, state.windowFirst, state.windowLast);
    const after = tightestRadiusPx(drawn);
    // A bend, not a corner: the tightest radius is above the target (the
    // Gaussian's apex formula is for a perfect V; the far arm's own curve
    // opens it further) and read the same at every measuring span, i.e. the
    // curve is smooth at the line's scale, not a polygon.
    expect(after.radiusPx).toBeGreaterThan(BEND_TARGET_RADIUS_PX);
    expect(after.radiusPx).toBeLessThan(4 * BEND_TARGET_RADIUS_PX);
    expect(tightestRadiusPx(drawn, 0.5, 1).radiusPx).toBeGreaterThan(0.8 * after.radiusPx);
    // No joint of the drawn polyline turns sharply: the treated vertices are
    // re-spaced along the curve, so the chords are short where it bends.
    let maxJointTurnDeg = 0;
    for (let index = 1; index + 1 < drawn.length; index++) {
      const a = drawn[index - 1];
      const b = drawn[index];
      const c = drawn[index + 1];
      if (Math.abs(b.x) > 2000 || Math.abs(b.y) > 2000) continue;
      const turn = Math.abs(
        Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)),
      );
      maxJointTurnDeg = Math.max(maxJointTurnDeg, (turn * 180) / Math.PI);
    }
    expect(maxJointTurnDeg).toBeLessThan(6);

    // Nothing outside the window moved, and the upload range covers the writes.
    let firstChanged = Infinity;
    let lastChanged = -Infinity;
    for (let index = 0; index < pairs.length; index++) {
      if (pairs[index] !== original[index]) {
        firstChanged = Math.min(firstChanged, index);
        lastChanged = Math.max(lastChanged, index);
      }
    }
    expect(firstChanged).toBeGreaterThanOrEqual(write!.start);
    expect(lastChanged).toBeLessThan(write!.start + write!.count);
    expect(Math.floor(firstChanged / 6)).toBeGreaterThanOrEqual(state.windowFirst - 1);
    expect(Math.floor(lastChanged / 6)).toBeLessThanOrEqual(state.windowLast);

    // The drawn curve is the exact one slid sideways in the picture: depth
    // still climbs monotonically away from the camera along the run, stays
    // within the exact run's range, and no vertex is more than a few line
    // widths from the exact polyline — none at all beyond the kernel's reach.
    const exact: Projected[] = [];
    for (let vertex = state.windowFirst; vertex <= state.windowLast; vertex++) {
      const p = projectPoint(view, ...sampleVertex(frame, vertex));
      if (p.depth > 0) exact.push(p);
    }
    const distanceToPolyline = (p: Projected): number => {
      let best = Infinity;
      for (let index = 1; index < exact.length; index++) {
        const a = exact[index - 1];
        const b = exact[index];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
        best = Math.min(best, Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey));
      }
      return best;
    };
    const minExactDepth = Math.min(...exact.map((p) => p.depth));
    const maxExactDepth = Math.max(...exact.map((p) => p.depth));
    let maxShiftPx = 0;
    let maxFarShiftPx = 0;
    let previousDepth = 0;
    for (const p of drawn) {
      expect(p.depth).toBeGreaterThanOrEqual(previousDepth * (1 - 1e-6));
      expect(p.depth).toBeGreaterThanOrEqual(minExactDepth * (1 - 1e-6));
      expect(p.depth).toBeLessThanOrEqual(maxExactDepth * (1 + 1e-6));
      previousDepth = p.depth;
      if (Math.abs(p.x) > 2000 || Math.abs(p.y) > 2000) continue;
      const shift = distanceToPolyline(p);
      maxShiftPx = Math.max(maxShiftPx, shift);
      if (Math.hypot(p.x - after.at.x, p.y - after.at.y) > 5 * state.sigmaPx) maxFarShiftPx = Math.max(maxFarShiftPx, shift);
    }
    expect(maxShiftPx).toBeGreaterThan(BEND_TARGET_RADIUS_PX);
    expect(maxShiftPx).toBeLessThan(BEND_SIGMA_MAX_PX);
    expect(maxFarShiftPx).toBeLessThan(0.05);
  });

  it('is a no-op for a line the camera is not beside, and restores what it wrote once the camera leaves', () => {
    const { frame, view, pairs, original, state } = setup(1e5, 1.7e5);
    expect(applyOrbitLineBend(frame, view, state, pairs)).not.toBeNull();
    expect(state.active).toBe(true);
    // A tenth of the orbit radius away: the natural bend is broad already.
    const far = cameraBeside(0.1 * ORBIT_RADIUS_AU * KM_PER_AU, 0.1 * ORBIT_RADIUS_AU * KM_PER_AU);
    const restore = applyOrbitLineBend(frame, far, state, pairs);
    expect(restore).not.toBeNull();
    expect(state.active).toBe(false);
    expect(pairs).toEqual(original);
    // And with nothing to restore, a far camera writes nothing at all.
    expect(applyOrbitLineBend(frame, far, state, pairs)).toBeNull();
    expect(pairs).toEqual(original);
  });

  it('re-treats from scratch each frame: a camera that moves does not accumulate', () => {
    const { frame, view, pairs, state } = setup(1e5, 1.7e5);
    applyOrbitLineBend(frame, view, state, pairs);
    const firstPass = pairs.slice();
    const moved = cameraBeside(1.3e5, 1.5e5);
    applyOrbitLineBend(frame, moved, state, pairs);
    applyOrbitLineBend(frame, view, state, pairs);
    // Back at the first pose, the buffer is what the first pass wrote.
    expect(pairs).toEqual(firstPass);
  });

  it('a vertex behind the camera does not stop the window on the other side', () => {
    const { frame, pairs, state } = setup(1e5, 1.7e5);
    // Look back along the line: forward = −z. The nearest vertex is now just
    // behind the camera plane or on it; the corner in view is the other way.
    const view = cameraBeside(1e5, 1.7e5);
    view.forwardZ = -1;
    view.rightX = 1;
    const write = applyOrbitLineBend(frame, view, state, pairs);
    expect(write).not.toBeNull();
    expect(state.smoothedCount).toBeGreaterThan(20);
    const after = tightestRadiusPx(projectedRun(frame, pairs, view, state.windowFirst, state.windowLast));
    expect(after.radiusPx).toBeGreaterThan(BEND_TARGET_RADIUS_PX);
  });
});

describe('bendSigmaPx', () => {
  it('gives the target apex radius where the bounds allow', () => {
    const apexRadius = (sigma: number, interior: number) =>
      (sigma * Math.sqrt(2 * Math.PI) * Math.sin(interior / 2) ** 3) / (2 * Math.cos(interior / 2));
    const sixty = bendSigmaPx(Math.PI / 3);
    expect(sixty).toBeGreaterThan(BEND_SIGMA_MIN_PX);
    expect(sixty).toBeLessThan(BEND_SIGMA_MAX_PX);
    expect(apexRadius(sixty, Math.PI / 3)).toBeCloseTo(BEND_TARGET_RADIUS_PX, 6);
    // An obtuse corner hits the floor, an acute one the cap.
    expect(bendSigmaPx(Math.PI / 2)).toBe(BEND_SIGMA_MIN_PX);
    expect(bendSigmaPx(Math.PI / 6)).toBe(BEND_SIGMA_MAX_PX);
    expect(BEND_DETECT_RADIUS_PX).toBeGreaterThan(BEND_TARGET_RADIUS_PX);
  });
});
