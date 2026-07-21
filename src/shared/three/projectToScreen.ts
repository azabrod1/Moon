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

import { lensUnwarpNdc, lensWarpNdc } from '../math/lensProjection';

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

/** Projected tangent footprint of a world-space sphere. `x`/`y` remain the
 * projected direction to its geometric centre (the right anchor for labels),
 * while `footprintX`/`footprintY` and `radiusPx` conservatively enclose the
 * rendered limb after the active lens transform. */
export interface SphereScreenProjection extends ScreenProjection {
  footprintX: number;
  footprintY: number;
  radiusPx: number;
  diameterPx: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const scratch = new THREE.Vector3();
const warpScratch = { x: 0, y: 0 };
const unwarpScratch = { x: 0, y: 0 };
const sphereCentreView = new THREE.Vector3();
const sphereDirection = new THREE.Vector3();
const sphereBasisU = new THREE.Vector3();
const sphereBasisV = new THREE.Vector3();
const sphereRimDirection = new THREE.Vector3();
const sphereCentreProjection: ScreenProjection = { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
const worldRayPoint = new THREE.Vector3();
const CAMERA_UP = new THREE.Vector3(0, 1, 0);
const CAMERA_RIGHT = new THREE.Vector3(1, 0, 0);

interface CameraLensConfig {
  strength: number;
  designFovDeg: number;
  renderFovDeg: number;
  aspect: number;
}

function cameraLensConfig(camera: THREE.Camera): CameraLensConfig | null {
  if (!(camera instanceof THREE.PerspectiveCamera)) return null;
  const lens = (camera.userData as {
    lens?: { strength: number; designFovDeg: number; effectiveStrength?: number };
  }).lens;
  if (!lens) return null;
  return {
    strength: lens.effectiveStrength ?? lens.strength,
    designFovDeg: lens.designFovDeg,
    renderFovDeg: camera.fov,
    aspect: camera.aspect,
  };
}

function warpProjectedNdc(camera: THREE.Camera, ndc: { x: number; y: number; z: number }): void {
  const lens = cameraLensConfig(camera);
  if (!lens || lens.strength <= 0 || ndc.z >= 1) return;
  lensWarpNdc(
    ndc.x,
    ndc.y,
    lens.designFovDeg,
    lens.renderFovDeg,
    lens.aspect,
    lens.strength,
    warpScratch,
  );
  ndc.x = warpScratch.x;
  ndc.y = warpScratch.y;
}

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
  warpProjectedNdc(camera, scratch);
  const result = out ?? { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  result.x = (scratch.x * 0.5 + 0.5) * width;
  result.y = (-scratch.y * 0.5 + 0.5) * height;
  result.ndcX = scratch.x;
  result.ndcY = scratch.y;
  result.ndcZ = scratch.z;
  return result;
}

/** Raw rectilinear/overscan projection, before the planetarium lens pass. */
export function projectToSourceScreen(
  pos: { x: number; y: number; z: number },
  camera: THREE.Camera,
  width: number,
  height: number,
  out?: ScreenProjection,
): ScreenProjection {
  scratch.set(pos.x, pos.y, pos.z).project(camera);
  const result = out ?? { x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0 };
  result.x = (scratch.x * 0.5 + 0.5) * width;
  result.y = (-scratch.y * 0.5 + 0.5) * height;
  result.ndcX = scratch.x;
  result.ndcY = scratch.y;
  result.ndcZ = scratch.z;
  return result;
}

function projectCameraRayToOutputNdc(
  direction: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  out: { x: number; y: number },
): boolean {
  if (direction.z >= -1e-9) return false;
  const tanHalfRender = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  out.x = (direction.x / -direction.z) / (camera.aspect * tanHalfRender);
  out.y = (direction.y / -direction.z) / tanHalfRender;
  const lens = cameraLensConfig(camera);
  if (lens && lens.strength > 0) {
    lensWarpNdc(
      out.x,
      out.y,
      lens.designFovDeg,
      lens.renderFovDeg,
      lens.aspect,
      lens.strength,
      warpScratch,
    );
    out.x = warpScratch.x;
    out.y = warpScratch.y;
  }
  return true;
}

/**
 * Project the actual tangent limb of a sphere through the same output lens as
 * the renderer. Sampling the tangent cone is deliberate: replacing the
 * overscan FOV with the design FOV is correct only at frame centre, while the
 * lens scale changes continuously toward the edges and corners.
 */
export function projectSphereToScreen(
  centre: { x: number; y: number; z: number },
  radius: number,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  out?: SphereScreenProjection,
): SphereScreenProjection {
  const result = out ?? {
    x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0,
    footprintX: 0, footprintY: 0, radiusPx: 0, diameterPx: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
  };
  const centreProjection = projectToScreen(centre, camera, width, height, sphereCentreProjection);
  result.x = centreProjection.x;
  result.y = centreProjection.y;
  result.ndcX = centreProjection.ndcX;
  result.ndcY = centreProjection.ndcY;
  result.ndcZ = centreProjection.ndcZ;

  sphereCentreView.set(centre.x, centre.y, centre.z).applyMatrix4(camera.matrixWorldInverse);
  const distance = sphereCentreView.length();
  const safeRadius = Math.max(radius, 0);
  // An entirely behind-camera sphere has no display footprint. Returning the
  // viewport-covering fallback here would make LOD/dot consumers treat a body
  // behind the ship as the largest thing on screen.
  if (sphereCentreView.z >= safeRadius) {
    result.footprintX = result.x;
    result.footprintY = result.y;
    result.radiusPx = 0;
    result.diameterPx = 0;
    result.minX = result.x;
    result.maxX = result.x;
    result.minY = result.y;
    result.maxY = result.y;
    return result;
  }
  if (!(distance > safeRadius) || safeRadius === 0) {
    const coveringRadius = safeRadius === 0 ? 0 : Math.hypot(width, height);
    result.footprintX = result.x;
    result.footprintY = result.y;
    result.radiusPx = coveringRadius;
    result.diameterPx = coveringRadius * 2;
    result.minX = result.x - coveringRadius;
    result.maxX = result.x + coveringRadius;
    result.minY = result.y - coveringRadius;
    result.maxY = result.y + coveringRadius;
    return result;
  }

  sphereDirection.copy(sphereCentreView).multiplyScalar(1 / distance);
  sphereBasisU.crossVectors(
    sphereDirection,
    Math.abs(sphereDirection.y) < 0.9 ? CAMERA_UP : CAMERA_RIGHT,
  ).normalize();
  sphereBasisV.crossVectors(sphereDirection, sphereBasisU).normalize();
  const sinAlpha = THREE.MathUtils.clamp(safeRadius / distance, 0, 0.999999999);
  const cosAlpha = Math.sqrt(Math.max(1 - sinAlpha * sinAlpha, 0));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const rimNdc = warpScratch;
  const samples = 32;
  for (let i = 0; i < samples; i++) {
    const phase = (i / samples) * Math.PI * 2;
    sphereRimDirection
      .copy(sphereDirection)
      .multiplyScalar(cosAlpha)
      .addScaledVector(sphereBasisU, Math.cos(phase) * sinAlpha)
      .addScaledVector(sphereBasisV, Math.sin(phase) * sinAlpha);
    if (!projectCameraRayToOutputNdc(sphereRimDirection, camera, rimNdc)) {
      const coveringRadius = Math.hypot(width, height);
      result.footprintX = result.x;
      result.footprintY = result.y;
      result.radiusPx = coveringRadius;
      result.diameterPx = coveringRadius * 2;
      result.minX = result.x - coveringRadius;
      result.maxX = result.x + coveringRadius;
      result.minY = result.y - coveringRadius;
      result.maxY = result.y + coveringRadius;
      return result;
    }
    const x = (rimNdc.x * 0.5 + 0.5) * width;
    const y = (-rimNdc.y * 0.5 + 0.5) * height;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const footprintX = (minX + maxX) * 0.5;
  const footprintY = (minY + maxY) * 0.5;
  let radiusPx = 0;
  for (let i = 0; i < samples; i++) {
    const phase = (i / samples) * Math.PI * 2;
    sphereRimDirection
      .copy(sphereDirection)
      .multiplyScalar(cosAlpha)
      .addScaledVector(sphereBasisU, Math.cos(phase) * sinAlpha)
      .addScaledVector(sphereBasisV, Math.sin(phase) * sinAlpha);
    projectCameraRayToOutputNdc(sphereRimDirection, camera, rimNdc);
    const x = (rimNdc.x * 0.5 + 0.5) * width;
    const y = (-rimNdc.y * 0.5 + 0.5) * height;
    radiusPx = Math.max(radiusPx, Math.hypot(x - footprintX, y - footprintY));
  }
  // Sampling can miss the true extremum between adjacent rim rays. A secant
  // pad makes the returned radius/bounds conservative for the conformal path
  // (and is a harmless <0.5% guard for the reduced-strength wide-FOV blend).
  const samplePadPx = radiusPx * (1 / Math.cos(Math.PI / samples) - 1);
  radiusPx += samplePadPx;
  minX -= samplePadPx;
  maxX += samplePadPx;
  minY -= samplePadPx;
  maxY += samplePadPx;
  result.footprintX = footprintX;
  result.footprintY = footprintY;
  result.radiusPx = radiusPx;
  result.diameterPx = radiusPx * 2;
  result.minX = minX;
  result.maxX = maxX;
  result.minY = minY;
  result.maxY = maxY;
  return result;
}

/** Build a world-space ray through a displayed screen point. */
export function screenPointToWorldRay(
  screenX: number,
  screenY: number,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  let sourceX = (screenX / Math.max(width, 1)) * 2 - 1;
  let sourceY = 1 - (screenY / Math.max(height, 1)) * 2;
  const lens = cameraLensConfig(camera);
  if (lens && lens.strength > 0) {
    lensUnwarpNdc(
      sourceX,
      sourceY,
      lens.designFovDeg,
      lens.renderFovDeg,
      lens.aspect,
      lens.strength,
      unwarpScratch,
    );
    sourceX = unwarpScratch.x;
    sourceY = unwarpScratch.y;
  }
  worldRayPoint.set(sourceX, sourceY, 0.5).unproject(camera);
  return out.copy(worldRayPoint).sub(camera.position).normalize();
}
