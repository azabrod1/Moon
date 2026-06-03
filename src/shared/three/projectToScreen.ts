/**
 * Project a world position to canvas coordinates.
 *
 * Returns ONLY the geometry of the projection — pixel x/y (the standard
 * `(ndc*0.5+0.5)` mapping with y flipped, top-left origin, NOT rounded) plus
 * the raw NDC x/y/z so callers can box-test in NDC. It makes NO
 * visibility/margin/clamp/offset decisions: those differ at every call site
 * (full NDC-box vs `ndcZ < 1` vs per-site pixel margins vs edge-clamping) and
 * deliberately stay at the call site. Does not mutate `pos`.
 */
import * as THREE from 'three';

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

export function projectToScreen(
  pos: { x: number; y: number; z: number },
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenProjection {
  scratch.set(pos.x, pos.y, pos.z).project(camera);
  return {
    x: (scratch.x * 0.5 + 0.5) * width,
    y: (-scratch.y * 0.5 + 0.5) * height,
    ndcX: scratch.x,
    ndcY: scratch.y,
    ndcZ: scratch.z,
  };
}
