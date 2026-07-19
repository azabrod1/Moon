/**
 * Project a world position to canvas coordinates.
 *
 * Returns ONLY the geometry of the projection — pixel x/y (the standard
 * `(ndc*0.5+0.5)` mapping with y flipped, top-left origin, NOT rounded) plus
 * the raw NDC x/y/z so callers can box-test in NDC. It makes NO
 * visibility/margin/clamp/offset decisions: those differ at every call site
 * (full NDC-box vs `ndcZ < 1` vs per-site pixel margins vs edge-clamping) and
 * deliberately stay at the call site. Does not mutate `pos`.
 *
 * Uses a shared scratch vector internally and returns copied scalars, so each
 * result is independent of the next call — but it is single-threaded /
 * non-reentrant by design (don't nest two calls in one expression expecting
 * separate buffers). Pass a reused `out` object to avoid per-call
 * allocation in hot per-frame loops.
 */
import * as THREE from 'three';

import { lensWarpNdc } from '../math/lensProjection';

export interface ScreenProjection {
  /** Pixel x (CSS px, top-left origin) against `width`. Not rounded. */
  x: number;
  /** Pixel y (CSS px, top-left origin) against `height`. Not rounded. */
  y: number;
  /** Raw NDC x (∈ [-1, 1] when on-screen). */
  ndcX: number;
  /** Raw NDC y (∈ [-1, 1] when on-screen). */
  ndcY: number;
  /** NDC z; the conventional `ndcZ < 1` test means "in front of the far plane". */
  ndcZ: number;
}

const scratch = new THREE.Vector3();
const warpScratch = { x: 0, y: 0 };

export function projectToScreen(
  pos: { x: number; y: number; z: number },
  camera: THREE.Camera,
  width: number,
  height: number,
  out?: ScreenProjection,
): ScreenProjection {
  scratch.set(pos.x, pos.y, pos.z).project(camera);
  // Under the planetarium's lens pass the drawn image is warped; overlays
  // positioned from this seam must land on the warped pixels. Cameras
  // without `userData.lens` (flight, volume-compare) stay rectilinear.
  const lens = (camera.userData as {
    lens?: { strength: number; designFovDeg: number; effectiveStrength?: number };
  }).lens;
  const lensStrength = lens ? (lens.effectiveStrength ?? lens.strength) : 0;
  if (lens && lensStrength > 0 && scratch.z < 1) {
    const perspective = camera as THREE.PerspectiveCamera;
    lensWarpNdc(
      scratch.x, scratch.y,
      lens.designFovDeg, perspective.fov, perspective.aspect, lensStrength,
      warpScratch,
    );
    scratch.x = warpScratch.x;
    scratch.y = warpScratch.y;
  }
  const result = out ?? { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  result.x = (scratch.x * 0.5 + 0.5) * width;
  result.y = (-scratch.y * 0.5 + 0.5) * height;
  result.ndcX = scratch.x;
  result.ndcY = scratch.y;
  result.ndcZ = scratch.z;
  return result;
}
