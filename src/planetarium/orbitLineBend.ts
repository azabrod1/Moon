/**
 * The corner an orbit line shows from up close, and the minimum bend radius
 * that rounds it.
 *
 * Park a few hundred thousand km beside Pluto's orbit and the line meets
 * itself at a sharp angle: the near stretch runs off to its vanishing point
 * and the far side of the ring lies along the orbit plane's horizon, and the
 * two join at that vanishing point. Nothing is wrong with the geometry — the
 * projection of a smooth circle from a camera that close to it really does
 * turn through 120° inside a dozen pixels. The screen radius of that turn is
 * about focal · h / √(2·R·d) for a camera h above the plane and d from the
 * line (R the orbit radius): for Pluto at d ≈ h ≈ 10⁵ km that is a handful of
 * pixels, under the line's own width, and no tessellation changes it. It
 * grows with √d and is a broad curve again a few million km out.
 *
 * So the line is drawn slightly wrong on purpose, the way a road is built
 * with a minimum curve radius. Once per frame, for the one line the camera is
 * beside (a distance gate leaves every other line untouched, and costs one
 * nearest-vertex search per line):
 *
 * 1. A window of vertices around the camera's nearest one is projected to
 *    the screen — rectilinear, at the display FOV, in CSS px — extending in
 *    each direction until it has passed the corner and gone 8σ of screen arc
 *    beyond it, or a vertex goes behind the camera.
 * 2. Where a joint's local radius (segment length over turn) is under
 *    BEND_DETECT_RADIUS_PX, the polyline is resampled uniformly along its
 *    screen arc length and filtered with a Gaussian of width σ. A straight
 *    stretch is invariant under that filter (an affine combination of
 *    collinear points stays on the line), a gentle curve of radius ρ shifts
 *    inward by σ²/2ρ, and a corner of interior angle φ becomes a bend with
 *    apex radius σ·√(2π)·sin³(φ/2) / (2·cos(φ/2)). σ is chosen from the
 *    measured corner angle so that apex radius is BEND_TARGET_RADIUS_PX,
 *    within [BEND_SIGMA_MIN_PX, BEND_SIGMA_MAX_PX]: an acute corner would
 *    need a kernel wider than the screen, and the cap keeps the far ring's
 *    inward shift under a few px.
 * 3. Each vertex within 4σ of a detected corner takes the filtered curve's
 *    position at its own arc parameter (blended back to its true position
 *    over 2σ→4σ, so the treated stretch joins the untouched line with no
 *    step), and is written back into the line's float32 pair buffer AT ITS
 *    ORIGINAL VIEW DEPTH: the vertex slides sideways in the camera's picture
 *    and nowhere else. The previous frame's writes are restored first, so a
 *    line the camera has left is exact again.
 *
 * Cost when the gate is open: a few thousand projections and a ~300-point FIR,
 * well under a millisecond; when closed, the nearest-vertex search alone. The
 * lens is applied by the GPU on top of this, so the radius is set in
 * pre-lens px and the lens's local magnification (≤ ~1.2×) scales it.
 *
 * DOM-free and three-free: samples, a camera basis and a float buffer in,
 * so the whole thing is testable against a synthetic circle.
 */

import { segmentDistanceSq, type OrbitLineAnchorFrame } from './orbitLineAnchor';

/** A joint whose local radius (CSS px) is under this reads as a corner and
 *  is what the filter is for. About seven line widths. */
export const BEND_DETECT_RADIUS_PX = 15;
/** The apex radius the filter aims for, CSS px: about four line widths, the
 *  point where a bend stops reading as a corner. */
export const BEND_TARGET_RADIUS_PX = 9;
/** Bounds on the filter width. The floor keeps an obtuse corner's bend from
 *  being narrower than the detection scale; the cap bounds the inward shift
 *  a gentle far-ring curve of radius ρ takes, σ²/2ρ. */
export const BEND_SIGMA_MIN_PX = 20;
export const BEND_SIGMA_MAX_PX = 60;
/** Grid spacing of the arc-length resample, as a fraction of σ. */
const GRID_STEP_SIGMA = 1 / 16;
/** Kernel and neighbourhood half-width in σ. */
const KERNEL_HALF_SIGMA = 4;
/** Gate: skip a line whose natural corner radius (h ≈ d) is over this many
 *  detection radii — it cannot hold a joint the filter would touch. */
const GATE_RADIUS_FACTOR = 4;
/** Nearest-vertex search: coarse stride, then a refinement around the hit.
 *  Sound for the smooth, evenly sampled curves orbit lines are. */
const NEAREST_COARSE_STRIDE = 16;

export interface OrbitLineBendView {
  /** Camera position, heliocentric AU. */
  camX: number;
  camY: number;
  camZ: number;
  /** Camera basis, unit vectors in the scene's axes. `forward` is where the
   *  camera looks (three's −Z), `up` its +Y, `right` its +X. */
  rightX: number;
  rightY: number;
  rightZ: number;
  upX: number;
  upY: number;
  upZ: number;
  forwardX: number;
  forwardY: number;
  forwardZ: number;
  /** Rectilinear focal length at the display FOV, CSS px:
   *  (viewport height / 2) / tan(displayFov / 2). */
  focalPx: number;
}

export interface OrbitLineBendState {
  /** Vertex range this pass last wrote into the buffer; first > last when none. */
  writtenFirst: number;
  writtenLast: number;
  /** Diagnostics of the last pass. */
  active: boolean;
  distanceAU: number;
  sigmaPx: number;
  cornerTurnDeg: number;
  windowFirst: number;
  windowLast: number;
  smoothedCount: number;
}

export function createOrbitLineBendState(): OrbitLineBendState {
  return {
    writtenFirst: 1,
    writtenLast: 0,
    active: false,
    distanceAU: Infinity,
    sigmaPx: 0,
    cornerTurnDeg: 0,
    windowFirst: 0,
    windowLast: -1,
    smoothedCount: 0,
  };
}

/** The upload range (float indices into the pair buffer) a pass produced. */
export interface OrbitLineBendWrite {
  start: number;
  count: number;
}

// Scratch, grown on demand; the pass allocates nothing steady-state.
type Scratch = Float64Array<ArrayBuffer>;
let screenX: Scratch = new Float64Array(0);
let screenY: Scratch = new Float64Array(0);
let depthOf: Scratch = new Float64Array(0);
let runX: Scratch = new Float64Array(0);
let runY: Scratch = new Float64Array(0);
let runD: Scratch = new Float64Array(0);
let arcOf: Scratch = new Float64Array(0);
let turnOf: Scratch = new Float64Array(0);
let gridX: Scratch = new Float64Array(0);
let gridY: Scratch = new Float64Array(0);
let gridSX: Scratch = new Float64Array(0);
let gridSY: Scratch = new Float64Array(0);
let kernel: Scratch = new Float64Array(0);
/** Vertex range project() touched in the current pass; see applyOrbitLineBend. */
let projectedFirst = 0;
let projectedLast = -1;

function ensure(array: Scratch, length: number): Scratch {
  return array.length >= length ? array : new Float64Array(Math.max(length, array.length * 2));
}

/** Write vertex k of a segment-pair buffer: the start of segment k and the
 *  end of segment k−1, whichever exist. */
function writePairVertex(pairs: Float32Array, segments: number, k: number, x: number, y: number, z: number): void {
  if (k < segments) {
    const o = k * 6;
    pairs[o] = x;
    pairs[o + 1] = y;
    pairs[o + 2] = z;
  }
  if (k >= 1) {
    const o = (k - 1) * 6 + 3;
    pairs[o] = x;
    pairs[o + 1] = y;
    pairs[o + 2] = z;
  }
}

function writeOriginalRange(frame: OrbitLineAnchorFrame, pairs: Float32Array, first: number, last: number): void {
  const segments = frame.vertexCount - 1;
  const { samples } = frame;
  const { x: ax, y: ay, z: az } = frame.anchor;
  // A range recorded before a resample to a different vertex count is
  // clamped: whatever it covered was rewritten whole by that resample.
  first = Math.max(0, first);
  last = Math.min(frame.vertexCount - 1, last);
  for (let k = first; k <= last; k++) {
    const s = k * 3;
    writePairVertex(pairs, segments, k, samples[s] - ax, samples[s + 1] - ay, samples[s + 2] - az);
  }
}

/** Restore what the last pass wrote and record the pass as inactive. Returns
 *  the upload range, or null when the buffer was already exact. */
function deactivate(
  frame: OrbitLineAnchorFrame,
  state: OrbitLineBendState,
  pairs: Float32Array,
): OrbitLineBendWrite | null {
  state.active = false;
  state.smoothedCount = 0;
  state.sigmaPx = 0;
  state.cornerTurnDeg = 0;
  if (state.writtenFirst > state.writtenLast) return null;
  const first = state.writtenFirst;
  const last = state.writtenLast;
  writeOriginalRange(frame, pairs, first, last);
  state.writtenFirst = 1;
  state.writtenLast = 0;
  return pairRange(frame.vertexCount - 1, first, last);
}

function pairRange(segments: number, firstVertex: number, lastVertex: number): OrbitLineBendWrite {
  const firstSegment = Math.max(0, firstVertex - 1);
  const lastSegment = Math.min(segments - 1, lastVertex);
  return { start: firstSegment * 6, count: (lastSegment - firstSegment + 1) * 6 };
}

/** Index of the sample nearest (x,y,z): a coarse stride, then the hit's
 *  neighbourhood. */
export function nearestVertexIndex(frame: OrbitLineAnchorFrame, x: number, y: number, z: number): number {
  const { samples, vertexCount } = frame;
  let best = 0;
  let bestD2 = Infinity;
  for (let k = 0; k < vertexCount; k += NEAREST_COARSE_STRIDE) {
    const s = k * 3;
    const dx = samples[s] - x;
    const dy = samples[s + 1] - y;
    const dz = samples[s + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  const lo = Math.max(0, best - NEAREST_COARSE_STRIDE);
  const hi = Math.min(vertexCount - 1, best + NEAREST_COARSE_STRIDE);
  for (let k = lo; k <= hi; k++) {
    const s = k * 3;
    const dx = samples[s] - x;
    const dy = samples[s + 1] - y;
    const dz = samples[s + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  return best;
}

/** Distance from (x,y,z) to the polyline near vertex `near` — the two
 *  segments that meet there — in the samples' units. */
function distanceNearVertex(frame: OrbitLineAnchorFrame, near: number, x: number, y: number, z: number): number {
  const { samples, vertexCount } = frame;
  let d2 = Infinity;
  for (let seg = Math.max(0, near - 1); seg <= Math.min(vertexCount - 2, near); seg++) {
    const a = seg * 3;
    d2 = Math.min(
      d2,
      segmentDistanceSq(
        x, y, z,
        samples[a], samples[a + 1], samples[a + 2],
        samples[a + 3], samples[a + 4], samples[a + 5],
      ),
    );
  }
  return Math.sqrt(d2);
}

/** Filter width that gives a corner of interior angle φ (radians) an apex
 *  radius of BEND_TARGET_RADIUS_PX, within the bounds. See the header. */
export function bendSigmaPx(interiorAngleRad: number): number {
  const half = Math.min(Math.max(interiorAngleRad, 1e-3), Math.PI - 1e-3) / 2;
  const sinHalf = Math.sin(half);
  const raw = (BEND_TARGET_RADIUS_PX * 2 * Math.cos(half)) / (Math.sqrt(2 * Math.PI) * sinHalf * sinHalf * sinHalf);
  return Math.min(BEND_SIGMA_MAX_PX, Math.max(BEND_SIGMA_MIN_PX, raw));
}

/**
 * The pass. `pairs` is the line's instanced segment-pair buffer, measured
 * from `frame.anchor` (what writeAnchoredSegmentPairs fills). Returns the
 * float range that changed and must be uploaded, or null.
 */
export function applyOrbitLineBend(
  frame: OrbitLineAnchorFrame,
  view: OrbitLineBendView,
  state: OrbitLineBendState,
  pairs: Float32Array,
): OrbitLineBendWrite | null {
  const vertexCount = frame.vertexCount;
  const segments = vertexCount - 1;
  if (vertexCount < 4 || pairs.length !== segments * 6 || !(view.focalPx > 0)) {
    return deactivate(frame, state, pairs);
  }
  const { samples } = frame;
  const { camX, camY, camZ } = view;

  // --- Gate: is the camera close enough to this line for a corner? ---
  const nearest = nearestVertexIndex(frame, camX, camY, camZ);
  const distance = distanceNearVertex(frame, nearest, camX, camY, camZ);
  state.distanceAU = distance;
  const ns = nearest * 3;
  const orbitRadius = Math.hypot(samples[ns], samples[ns + 1], samples[ns + 2]);
  const naturalRadiusPx = view.focalPx * Math.sqrt(distance / (2 * orbitRadius));
  if (!(orbitRadius > 0) || naturalRadiusPx > GATE_RADIUS_FACTOR * BEND_DETECT_RADIUS_PX) {
    return deactivate(frame, state, pairs);
  }
  const segmentEnd = nearest < segments ? nearest + 1 : nearest - 1;
  const segmentLength = Math.hypot(
    samples[segmentEnd * 3] - samples[ns],
    samples[segmentEnd * 3 + 1] - samples[ns + 1],
    samples[segmentEnd * 3 + 2] - samples[ns + 2],
  );
  if (!(segmentLength > 0)) return deactivate(frame, state, pairs);
  // The corner sits about √(2·R·d) along the line from the camera; a window
  // must reach past it before it can decide it has seen no corner.
  const bendDistance = Math.sqrt(2 * orbitRadius * distance);
  const minReach = Math.max(8, Math.ceil((3 * bendDistance) / segmentLength));
  const maxReach = Math.floor(vertexCount / 2) - 1;

  // --- Project outward from the nearest vertex in both directions. ---
  screenX = ensure(screenX, vertexCount);
  screenY = ensure(screenY, vertexCount);
  depthOf = ensure(depthOf, vertexCount);
  const focal = view.focalPx;
  // The vertices projected this pass: depthOf is trustworthy only for them
  // (the scratch is shared across lines and frames).
  projectedFirst = nearest;
  projectedLast = nearest;
  const project = (k: number): boolean => {
    const s = k * 3;
    const dx = samples[s] - camX;
    const dy = samples[s + 1] - camY;
    const dz = samples[s + 2] - camZ;
    const depth = dx * view.forwardX + dy * view.forwardY + dz * view.forwardZ;
    depthOf[k] = depth;
    if (k < projectedFirst) projectedFirst = k;
    if (k > projectedLast) projectedLast = k;
    if (!(depth > 0)) return false;
    screenX[k] = (focal * (dx * view.rightX + dy * view.rightY + dz * view.rightZ)) / depth;
    screenY[k] = (focal * (dx * view.upX + dy * view.upY + dz * view.upZ)) / depth;
    return true;
  };
  // Extension stops once a direction has gone minReach vertices AND
  // 8·σmax of screen arc past its last corner joint, or leaves the frustum's
  // front half, or reaches half the strip.
  const settleArc = 2 * KERNEL_HALF_SIGMA * BEND_SIGMA_MAX_PX;
  const extend = (direction: 1 | -1): number => {
    let k = nearest;
    let count = 0;
    let arcSinceCorner = 0;
    let havePrev = false;
    let prevX = 0;
    let prevY = 0;
    let haveDir = false;
    let dirX = 0;
    let dirY = 0;
    let last = nearest;
    while (count < maxReach) {
      if (!project(k)) {
        // The nearest vertex itself may sit behind the camera (the camera
        // looks away from it along the line): each direction then starts one
        // past it. Anywhere else, a vertex behind the camera ends the run.
        if (k !== nearest) break;
        const next = k + direction;
        if (next < 0 || next >= vertexCount) break;
        k = next;
        count++;
        continue;
      }
      last = k;
      if (havePrev) {
        const ex = screenX[k] - prevX;
        const ey = screenY[k] - prevY;
        const len = Math.hypot(ex, ey);
        if (len > 0) {
          if (haveDir) {
            const turn = Math.abs(Math.atan2(dirX * ey - dirY * ex, dirX * ex + dirY * ey));
            const localRadius = turn > 0 ? len / turn : Infinity;
            if (localRadius < BEND_DETECT_RADIUS_PX) arcSinceCorner = 0;
            else arcSinceCorner += len;
          } else {
            arcSinceCorner += len;
          }
          dirX = ex / len;
          dirY = ey / len;
          haveDir = true;
        }
      }
      prevX = screenX[k];
      prevY = screenY[k];
      havePrev = true;
      if (count >= minReach && arcSinceCorner > settleArc) break;
      const next = k + direction;
      if (next < 0 || next >= vertexCount) break;
      k = next;
      count++;
    }
    return last;
  };
  const forwardEnd = extend(1);
  const backwardEnd = extend(-1);
  const windowFirst = Math.min(backwardEnd, forwardEnd, nearest);
  const windowLast = Math.max(backwardEnd, forwardEnd, nearest);
  state.windowFirst = windowFirst;
  state.windowLast = windowLast;

  // --- Restore last frame's writes, then treat this window's runs. ---
  let uploadFirst = Infinity;
  let uploadLast = -Infinity;
  if (state.writtenFirst <= state.writtenLast) {
    writeOriginalRange(frame, pairs, state.writtenFirst, state.writtenLast);
    uploadFirst = state.writtenFirst;
    uploadLast = state.writtenLast;
    state.writtenFirst = 1;
    state.writtenLast = 0;
  }
  state.active = true;
  state.smoothedCount = 0;
  state.sigmaPx = 0;
  state.cornerTurnDeg = 0;

  let runStart = windowFirst;
  while (runStart <= windowLast) {
    if (!(depthOf[runStart] > 0)) {
      runStart++;
      continue;
    }
    let runEnd = runStart;
    while (runEnd + 1 <= windowLast && depthOf[runEnd + 1] > 0) runEnd++;
    if (runEnd - runStart >= 2) {
      const treated = treatRun(frame, state, pairs, view, runStart, runEnd);
      if (treated) {
        uploadFirst = Math.min(uploadFirst, treated.first);
        uploadLast = Math.max(uploadLast, treated.last);
        if (state.writtenFirst > state.writtenLast) {
          state.writtenFirst = treated.first;
          state.writtenLast = treated.last;
        } else {
          state.writtenFirst = Math.min(state.writtenFirst, treated.first);
          state.writtenLast = Math.max(state.writtenLast, treated.last);
        }
      }
    }
    runStart = runEnd + 1;
  }
  if (!(uploadFirst <= uploadLast)) return null;
  return pairRange(segments, uploadFirst, uploadLast);
}

/**
 * One in-front run of the window, vertices runStart..runEnd with screen
 * positions in screenX/Y. Detects corner joints, filters, writes the treated
 * vertices back. Returns the vertex range written, or null.
 *
 * Works on a local copy of the run with, at either end, the point where the
 * segment to the neighbouring behind-camera vertex crosses the camera plane
 * (clipped at a small positive depth). Without it a run whose previous
 * vertex is behind the camera — the usual case: the vertex the camera is
 * beside — would begin a few dozen px from the corner, the kernel would be
 * truncated there, and the near arm would be pulled toward the far one. The
 * clipped point sits at a screen radius of ~focal·d/ε, far outside any
 * kernel, and is never written: it only makes the arc complete.
 */
function treatRun(
  frame: OrbitLineAnchorFrame,
  state: OrbitLineBendState,
  pairs: Float32Array,
  view: OrbitLineBendView,
  runStart: number,
  runEnd: number,
): { first: number; last: number } | null {
  const { samples, vertexCount } = frame;
  const focal = view.focalPx;
  // Local run: index 0 may be a clipped virtual point, and the last likewise.
  const preVirtual = runStart - 1 >= projectedFirst && !(depthOf[runStart - 1] > 0) ? 1 : 0;
  const postVirtual = runEnd + 1 <= projectedLast && !(depthOf[runEnd + 1] > 0) ? 1 : 0;
  const count = runEnd - runStart + 1 + preVirtual + postVirtual;
  runX = ensure(runX, count);
  runY = ensure(runY, count);
  runD = ensure(runD, count);
  arcOf = ensure(arcOf, count);
  turnOf = ensure(turnOf, count);
  const clipInto = (inFront: number, behind: number, at: number): void => {
    // The point on the 3D segment inFront→behind at depth ε: a fraction
    // of the way that keeps it in front and far out on screen.
    const dIn = depthOf[inFront];
    const dBehind = depthOf[behind];
    const epsilon = dIn * 1e-4;
    const t = (dIn - epsilon) / (dIn - dBehind);
    const a = inFront * 3;
    const b = behind * 3;
    const px = samples[a] + (samples[b] - samples[a]) * t - view.camX;
    const py = samples[a + 1] + (samples[b + 1] - samples[a + 1]) * t - view.camY;
    const pz = samples[a + 2] + (samples[b + 2] - samples[a + 2]) * t - view.camZ;
    const depth = px * view.forwardX + py * view.forwardY + pz * view.forwardZ;
    runD[at] = depth;
    runX[at] = (focal * (px * view.rightX + py * view.rightY + pz * view.rightZ)) / depth;
    runY[at] = (focal * (px * view.upX + py * view.upY + pz * view.upZ)) / depth;
  };
  if (preVirtual) clipInto(runStart, runStart - 1, 0);
  for (let k = runStart; k <= runEnd; k++) {
    const i = k - runStart + preVirtual;
    runX[i] = screenX[k];
    runY[i] = screenY[k];
    runD[i] = depthOf[k];
  }
  if (postVirtual) clipInto(runEnd, runEnd + 1, count - 1);
  const last = count - 1;

  // Arc length and signed cumulative turning along the run; corner joints.
  arcOf[0] = 0;
  turnOf[0] = 0;
  let cornerArcMin = Infinity;
  let cornerArcMax = -Infinity;
  let prevDirX = 0;
  let prevDirY = 0;
  let haveDir = false;
  for (let i = 1; i <= last; i++) {
    const ex = runX[i] - runX[i - 1];
    const ey = runY[i] - runY[i - 1];
    const len = Math.hypot(ex, ey);
    arcOf[i] = arcOf[i - 1] + len;
    turnOf[i] = turnOf[i - 1];
    if (!(len > 0)) continue;
    const dirX = ex / len;
    const dirY = ey / len;
    if (haveDir) {
      const signedTurn = Math.atan2(prevDirX * dirY - prevDirY * dirX, prevDirX * dirX + prevDirY * dirY);
      turnOf[i] = turnOf[i - 1] + signedTurn;
      const turn = Math.abs(signedTurn);
      // Local radius at joint i−1: the mean of its two segments over the turn.
      const prevLen = arcOf[i - 1] - (i >= 2 ? arcOf[i - 2] : 0);
      const localRadius = turn > 0 ? (0.5 * (prevLen + len)) / turn : Infinity;
      if (localRadius < BEND_DETECT_RADIUS_PX) {
        cornerArcMin = Math.min(cornerArcMin, arcOf[i - 1]);
        cornerArcMax = Math.max(cornerArcMax, arcOf[i - 1]);
      }
    }
    prevDirX = dirX;
    prevDirY = dirY;
    haveDir = true;
  }
  if (!(cornerArcMin <= cornerArcMax)) return null;

  // The corner's total turn, read a little outside the tight stretch, sets σ.
  const runArc = arcOf[last];
  const margin = 2 * BEND_DETECT_RADIUS_PX;
  const turnAt = (arc: number): number => {
    // turnOf is stepwise in arc; take the value at the first point past `arc`.
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arcOf[mid] < arc) lo = mid + 1;
      else hi = mid;
    }
    return turnOf[lo];
  };
  const cornerTurn = Math.abs(
    turnAt(Math.min(runArc, cornerArcMax + margin)) - turnAt(Math.max(0, cornerArcMin - margin)),
  );
  const interior = Math.max(0, Math.PI - Math.min(cornerTurn, Math.PI));
  const sigma = bendSigmaPx(interior);
  state.sigmaPx = Math.max(state.sigmaPx, sigma);
  state.cornerTurnDeg = Math.max(state.cornerTurnDeg, (cornerTurn * 180) / Math.PI);

  // --- Resample the run around the corner on a uniform arc grid. ---
  const step = sigma * GRID_STEP_SIGMA;
  const reach = 2 * KERNEL_HALF_SIGMA * sigma;
  const gridArc0 = Math.max(0, cornerArcMin - reach);
  const gridArc1 = Math.min(runArc, cornerArcMax + reach);
  const gridCount = Math.floor((gridArc1 - gridArc0) / step) + 1;
  if (gridCount < 4) return null;
  gridX = ensure(gridX, gridCount);
  gridY = ensure(gridY, gridCount);
  gridSX = ensure(gridSX, gridCount);
  gridSY = ensure(gridSY, gridCount);
  let seg = 0;
  for (let g = 0; g < gridCount; g++) {
    const arc = gridArc0 + g * step;
    while (seg + 1 < last && arcOf[seg + 1] < arc) seg++;
    const span = arcOf[seg + 1] - arcOf[seg];
    const t = span > 0 ? Math.min(1, Math.max(0, (arc - arcOf[seg]) / span)) : 0;
    gridX[g] = runX[seg] + (runX[seg + 1] - runX[seg]) * t;
    gridY[g] = runY[seg] + (runY[seg + 1] - runY[seg]) * t;
  }

  // --- Gaussian FIR on the grid (truncated and renormalised at the ends). ---
  const halfTaps = Math.ceil(KERNEL_HALF_SIGMA / GRID_STEP_SIGMA);
  kernel = ensure(kernel, halfTaps + 1);
  for (let j = 0; j <= halfTaps; j++) {
    const u = j * GRID_STEP_SIGMA;
    kernel[j] = Math.exp(-0.5 * u * u);
  }
  for (let g = 0; g < gridCount; g++) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    const jLo = Math.max(-halfTaps, -g);
    const jHi = Math.min(halfTaps, gridCount - 1 - g);
    for (let j = jLo; j <= jHi; j++) {
      const w = kernel[j < 0 ? -j : j];
      sx += w * gridX[g + j];
      sy += w * gridY[g + j];
      sw += w;
    }
    gridSX[g] = sx / sw;
    gridSY[g] = sy / sw;
  }

  // --- Lay the treated vertices out along the filtered curve. ---
  // The vertices within 4σ of the corner are re-spaced evenly along the
  // curve's arc rather than each kept at its own parameter: on the near arm
  // they sit 10–20 px apart on screen (they are close to the camera), and a
  // bend of the target radius drawn through chords that long is a polygon
  // with a visible kink at every joint. Vertex j takes the parameter
  // s′ = sA + (sB − sA)·j/(M−1); its screen position is the filtered curve
  // there (blended back to the exact curve over 2σ→4σ), and its depth is the
  // exact curve's depth at s′ — perspective-correct along the segment that
  // holds s′ — so the drawn curve is the exact one slid sideways in the
  // picture, resampled. The first and last treated vertices keep their own
  // parameters, so the stretch joins its untouched neighbours exactly.
  // Virtual points are never treated: the range is clamped to real vertices.
  const segments = vertexCount - 1;
  const { x: ax, y: ay, z: az } = frame.anchor;
  const blendIn = 2 * sigma;
  const blendOut = KERNEL_HALF_SIGMA * sigma;
  const treatArc0 = Math.max(cornerArcMin - blendOut, gridArc0 + step);
  const treatArc1 = Math.min(cornerArcMax + blendOut, gridArc0 + (gridCount - 3) * step);
  let firstTreated = preVirtual;
  while (firstTreated <= last && arcOf[firstTreated] < treatArc0) firstTreated++;
  let lastTreated = last - postVirtual;
  while (lastTreated >= 0 && arcOf[lastTreated] > treatArc1) lastTreated--;
  const treatedCount = lastTreated - firstTreated + 1;
  if (treatedCount < 3) return null;
  const arcA = arcOf[firstTreated];
  const arcB = arcOf[lastTreated];
  let hold = firstTreated;
  for (let j = 0; j < treatedCount; j++) {
    const i = firstTreated + j;
    const arc = arcA + ((arcB - arcA) * j) / (treatedCount - 1);
    while (hold + 1 < lastTreated && arcOf[hold + 1] < arc) hold++;
    const span = arcOf[hold + 1] - arcOf[hold];
    const t = span > 0 ? Math.min(1, Math.max(0, (arc - arcOf[hold]) / span)) : 0;
    // The exact curve at this parameter: screen-linear along the segment,
    // depth as perspective interpolates it along a straight 3D segment.
    const exactX = runX[hold] + (runX[hold + 1] - runX[hold]) * t;
    const exactY = runY[hold] + (runY[hold + 1] - runY[hold]) * t;
    const depth = 1 / ((1 - t) / runD[hold] + t / runD[hold + 1]);
    // The filtered curve there: Catmull-Rom through the grid.
    const u = (arc - gridArc0) / step;
    const g = Math.min(gridCount - 3, Math.max(1, Math.floor(u)));
    const tt = u - g;
    const t2 = tt * tt;
    const t3 = t2 * tt;
    const w0 = -0.5 * t3 + t2 - 0.5 * tt;
    const w1 = 1.5 * t3 - 2.5 * t2 + 1;
    const w2 = -1.5 * t3 + 2 * t2 + 0.5 * tt;
    const w3 = 0.5 * t3 - 0.5 * t2;
    const filteredX = w0 * gridSX[g - 1] + w1 * gridSX[g] + w2 * gridSX[g + 1] + w3 * gridSX[g + 2];
    const filteredY = w0 * gridSY[g - 1] + w1 * gridSY[g] + w2 * gridSY[g + 1] + w3 * gridSY[g + 2];
    const away = arc < cornerArcMin ? cornerArcMin - arc : arc > cornerArcMax ? arc - cornerArcMax : 0;
    const ramp = away <= blendIn ? 1 : away >= blendOut ? 0 : 1 - (away - blendIn) / (blendOut - blendIn);
    const blend = ramp * ramp * (3 - 2 * ramp);
    const px = exactX + (filteredX - exactX) * blend;
    const py = exactY + (filteredY - exactY) * blend;
    // Back to the scene at that depth, then into the anchored frame.
    const vx = (px / focal) * depth;
    const vy = (py / focal) * depth;
    const wx = view.camX + vx * view.rightX + vy * view.upX + depth * view.forwardX;
    const wy = view.camY + vx * view.rightY + vy * view.upY + depth * view.forwardY;
    const wz = view.camZ + vx * view.rightZ + vy * view.upZ + depth * view.forwardZ;
    writePairVertex(pairs, segments, runStart + i - preVirtual, wx - ax, wy - ay, wz - az);
  }
  state.smoothedCount += treatedCount;
  return { first: runStart + firstTreated - preVirtual, last: runStart + lastTreated - preVirtual };
}
