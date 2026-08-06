/**
 * The chart's above/below crossing — the geometry and the little clock behind
 * it. Pure: no THREE, no DOM, no scene state.
 *
 * The chart is drawn in the J2000 equatorial frame with north up, and the
 * camera is held in a band that never lets it go edge-on or underneath. The
 * crossing is the polar mirror of that view about the plane the pivot sits in:
 * same pivot, same bearing, same distance, opposite side. Only the signed
 * height changes sign.
 *
 * The offset — camera minus pivot — is what gets mirrored, never the pivot
 * itself. That is what makes the move mean the same thing at the whole-system
 * overview (pivot on the chart's origin, or wherever a free zoom parked it) and
 * riding a moon (pivot on the moon, moving under the camera every frame): the
 * subject stays exactly where it was on screen and the viewer swings under it.
 *
 * The intermediate poses interpolate the signed ELEVATION at constant radius
 * rather than lerping the two endpoints as vectors — a straight line between a
 * pose and its mirror passes through the pivot, which would drive the camera
 * into whatever it is looking at and out the other side.
 */

import { mapFocusEase } from './mapCamera';

/** How long the crossing takes. Long enough to read as a move around the
 *  chart, short enough that nothing else has to wait for it. */
export const MAP_FLIP_MS = 400;

/** A vector this module fills or reads. Kept structural so callers can hand it
 *  a THREE.Vector3 without this module knowing what one is. */
export interface MapFlipVec {
  x: number;
  y: number;
  z: number;
}

export interface MapFlipState {
  running: boolean;
  /** Signed elevation (rad) above the chart plane the current leg starts at. */
  fromElevRad: number;
  /** Where it ends. A reversal makes this the elevation the leg began from. */
  toElevRad: number;
  elapsedMs: number;
  /** Distance from the pivot, held constant across the crossing. */
  radiusAU: number;
  /** Unit bearing in the chart plane, held across the crossing. */
  azX: number;
  azZ: number;
}

export function makeMapFlipState(): MapFlipState {
  return {
    running: false,
    fromElevRad: 0,
    toElevRad: 0,
    elapsedMs: 0,
    radiusAU: 0,
    azX: 1,
    azZ: 0,
  };
}

/**
 * The mirror itself, on an offset from the pivot: signed height `h = v·n`,
 * tangential part `p = v − h·n`, mirrored `v′ = p − h·n`. The chart's plane
 * normal `n` is +Y (north), so this negates the height and leaves the bearing
 * and the distance untouched — written out rather than as `y = -y` because the
 * plane is the whole point of the move.
 *
 * Safe to call with `out === v`.
 */
export function mirrorMapOffset(v: MapFlipVec, out: MapFlipVec): MapFlipVec {
  const h = v.y;
  // p = v − h·n, the part of the offset lying in the plane.
  const px = v.x;
  const pz = v.z;
  out.x = px;
  out.y = -h;
  out.z = pz;
  return out;
}

/** Below this the offset has no bearing worth keeping — a camera sitting on its
 *  own pivot. Relative tests are meaningless here: the figure is compared
 *  against a length in AU that can be a whole chart or a moon's shell. */
const FLIP_DEGENERATE_LEN = 1e-12;

/**
 * Begin a crossing from the offset the camera is at right now.
 *
 * `hintX`/`hintZ` supply the bearing for a camera looking straight down the
 * pole, where the offset has no horizontal part to read one from — the band
 * comes within a twelfth of a radian of the pole, so this is reachable. The
 * hint only has to be a direction; it is normalized here, and a degenerate one
 * falls back to +X so a crossing always has somewhere to swing through.
 *
 * False for an offset with no length at all: there is no pose to mirror.
 */
export function mapFlipBegin(
  state: MapFlipState,
  offset: MapFlipVec,
  hintX: number,
  hintZ: number,
): boolean {
  const radius = Math.hypot(offset.x, offset.y, offset.z);
  if (!(radius > FLIP_DEGENERATE_LEN)) return false;
  const horizontal = Math.hypot(offset.x, offset.z);
  if (horizontal > FLIP_DEGENERATE_LEN) {
    state.azX = offset.x / horizontal;
    state.azZ = offset.z / horizontal;
  } else {
    const hintLen = Math.hypot(hintX, hintZ);
    state.azX = hintLen > FLIP_DEGENERATE_LEN ? hintX / hintLen : 1;
    state.azZ = hintLen > FLIP_DEGENERATE_LEN ? hintZ / hintLen : 0;
  }
  state.radiusAU = radius;
  state.fromElevRad = Math.atan2(offset.y, horizontal);
  state.toElevRad = -state.fromElevRad;
  state.elapsedMs = 0;
  state.running = true;
  return true;
}

/** The eased fraction of the current leg that has run. */
function progress(state: MapFlipState): number {
  return mapFocusEase(Math.min(1, Math.max(0, state.elapsedMs / MAP_FLIP_MS)));
}

/** The signed elevation the crossing is at right now. */
export function mapFlipElevationRad(state: MapFlipState): number {
  return state.fromElevRad + (state.toElevRad - state.fromElevRad) * progress(state);
}

/** The offset the camera should sit at right now — bearing and radius as the
 *  crossing began with, at the elevation the ease has reached. */
export function mapFlipOffset(state: MapFlipState, out: MapFlipVec): MapFlipVec {
  const elev = mapFlipElevationRad(state);
  const horizontal = Math.cos(elev) * state.radiusAU;
  out.x = state.azX * horizontal;
  out.y = Math.sin(elev) * state.radiusAU;
  out.z = state.azZ * horizontal;
  return out;
}

/** Advance the crossing by a frame. Returns whether it has finished — the
 *  caller lands it on the true endpoint and hands the camera back. */
export function mapFlipAdvance(state: MapFlipState, dtMs: number): boolean {
  if (!state.running) return true;
  state.elapsedMs = Math.min(state.elapsedMs + Math.max(dtMs, 0), MAP_FLIP_MS);
  if (state.elapsedMs < MAP_FLIP_MS) return false;
  state.running = false;
  return true;
}

/**
 * A second press mid-crossing: turn around and go back to where this leg
 * started, from the pose standing right now.
 *
 * Reversing rather than mirroring the live pose is what keeps every endpoint
 * legal. A mirror taken halfway through targets the negative of an elevation
 * the band does not contain — a pose five degrees above the plane would be
 * asked for five degrees below it, inside the edge-on floor both hemispheres
 * exclude — while the two ends of the original crossing are poses the camera
 * has actually sat at.
 *
 * Which is why the new goal is the OTHER end rather than the elevation this leg
 * happened to start at: after one reversal that would be a sampled mid-pose,
 * and a third press would aim the camera at it. The goal is always ±the
 * elevation the crossing began from, so every press lands somewhere legal.
 *
 * The clock restarts, as the scale blend's own reversal does: a turn made
 * moments after the press has little ground to cover and covers it gently.
 */
export function mapFlipReverse(state: MapFlipState): void {
  if (!state.running) return;
  state.fromElevRad = mapFlipElevationRad(state);
  state.toElevRad = -state.toElevRad;
  state.elapsedMs = 0;
}

/** Jump to the end of the crossing. For the moves that take the camera away
 *  mid-flight (a commit, a new focus): they need a settled, legal pose to
 *  start from, and the endpoint is the one this crossing promised. */
export function mapFlipSettle(state: MapFlipState): void {
  state.elapsedMs = MAP_FLIP_MS;
  state.running = false;
}
