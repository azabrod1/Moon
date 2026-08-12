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

import {
  lensUnwarpNdc,
  lensWarpNdc,
  lensWarpNdcWithContext,
  makeLensWarpContext,
  type LensWarpContext,
} from '../math/lensProjection';

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

/** How `radiusPx`/bounds were arrived at. `'sampled'` = a real tangent-limb
 * measurement (trust it). `'none'` = the sphere reaches no rendered pixel, so
 * the footprint is a degenerate point at the projected centre. `'covering'` =
 * a conservative viewport-filling guess (camera inside the sphere, or a rim
 * tangent ray crossing the camera plane while the sphere still intersects the
 * frustum) — not a measurement, so consumers that would erase the frame from it
 * (the Sun glare core) should treat it as untrusted. */
export type SphereFootprintKind = 'none' | 'sampled' | 'covering';

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
  footprintKind: SphereFootprintKind;
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
// Projected rim points, kept from the bounds loop so the radius loop reads
// them back instead of re-deriving and re-projecting the identical rays.
const rimXPx = new Float64Array(32);
const rimYPx = new Float64Array(32);
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

/** Per-call constants of the rim-ray projection: the render-frustum tangent
 *  and the lens warp context, both fixed for a given camera pose. Hoisted by
 *  `prepareRimContext` so the 32-ray loops below pay per-point math only —
 *  re-deriving these per ray (two `tan`s, the edge normalization, and a lens
 *  config object) was the hottest line in the whole app near moon systems. */
const rimCtx = {
  tanHalfRender: 0,
  aspect: 1,
  lensActive: false,
  warp: { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 } as LensWarpContext,
};

function prepareRimContext(camera: THREE.PerspectiveCamera): void {
  rimCtx.tanHalfRender = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  rimCtx.aspect = camera.aspect;
  const lens = cameraLensConfig(camera);
  rimCtx.lensActive = !!(lens && lens.strength > 0);
  if (lens && rimCtx.lensActive) {
    makeLensWarpContext(lens.designFovDeg, lens.renderFovDeg, lens.aspect, lens.strength, rimCtx.warp);
  }
}

function projectCameraRayToOutputNdc(
  direction: THREE.Vector3,
  out: { x: number; y: number },
): boolean {
  if (direction.z >= -1e-9) return false;
  out.x = (direction.x / -direction.z) / (rimCtx.aspect * rimCtx.tanHalfRender);
  out.y = (direction.y / -direction.z) / rimCtx.tanHalfRender;
  if (rimCtx.lensActive) {
    lensWarpNdcWithContext(rimCtx.warp, out.x, out.y, warpScratch);
    out.x = warpScratch.x;
    out.y = warpScratch.y;
  }
  return true;
}

/** Zero-size footprint at the projected centre — the truthful answer for a
 *  sphere that cannot reach any rendered pixel. The centre coordinates stay
 *  valid for consumers that edge-clamp toward an off-frame body. */
function setPointFootprint(result: SphereScreenProjection): SphereScreenProjection {
  result.footprintX = result.x;
  result.footprintY = result.y;
  result.radiusPx = 0;
  result.diameterPx = 0;
  result.minX = result.x;
  result.maxX = result.x;
  result.minY = result.y;
  result.maxY = result.y;
  result.footprintKind = 'none';
  return result;
}

/** Conservative viewport-covering footprint at the projected centre — the
 *  fallback when the sphere's tangent geometry can't be sampled but it isn't
 *  provably off-frame. A guess, flagged `'covering'` so consumers can tell it
 *  from a real measurement. */
function setCoveringFootprint(
  result: SphereScreenProjection,
  width: number,
  height: number,
): SphereScreenProjection {
  const coveringRadius = Math.hypot(width, height);
  result.footprintX = result.x;
  result.footprintY = result.y;
  result.radiusPx = coveringRadius;
  result.diameterPx = coveringRadius * 2;
  result.minX = result.x - coveringRadius;
  result.maxX = result.x + coveringRadius;
  result.minY = result.y - coveringRadius;
  result.maxY = result.y + coveringRadius;
  result.footprintKind = 'covering';
  return result;
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
    footprintKind: 'none' as SphereFootprintKind,
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
    return setPointFootprint(result);
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
    result.footprintKind = 'covering';
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
  prepareRimContext(camera);
  for (let i = 0; i < samples; i++) {
    const phase = (i / samples) * Math.PI * 2;
    sphereRimDirection
      .copy(sphereDirection)
      .multiplyScalar(cosAlpha)
      .addScaledVector(sphereBasisU, Math.cos(phase) * sinAlpha)
      .addScaledVector(sphereBasisV, Math.sin(phase) * sinAlpha);
    if (!projectCameraRayToOutputNdc(sphereRimDirection, rimNdc)) {
      // A rim ray crossed the camera plane: the rectilinear projection is
      // undefined, so we can't measure the limb. Before taking the conservative
      // viewport-covering guess, rule out the sphere being wholly outside the
      // source render frustum (the overscan frame the lens pass resamples) —
      // none of such a sphere can reach an output pixel, yet an extreme off-axis
      // rim ray still crosses the plane, and reporting it as viewport-filling is
      // exactly the off-frame Sun that once erased the whole starfield (the
      // cruise blackout). The plane tests run only on this rare failure path, so
      // the common case pays nothing. A sphere that DOES project cleanly keeps
      // its ordinary off-screen footprint — those real values keep the Sun's
      // glare terms continuous as it crosses the frustum boundary, so they must
      // not be zeroed here. Plane tests only, so a very close, very large sphere
      // in a corner wedge can still fall through to the covering guess — that
      // errs covering, never invisible. The far plane is untested: nothing
      // rendered sits beyond it.
      const tanHalfY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      const tanHalfX = tanHalfY * camera.aspect;
      const whollyBeforeNear = sphereCentreView.z - safeRadius > -camera.near;
      const outsideSideX = Math.abs(sphereCentreView.x) + sphereCentreView.z * tanHalfX
        > safeRadius * Math.hypot(1, tanHalfX);
      const outsideSideY = Math.abs(sphereCentreView.y) + sphereCentreView.z * tanHalfY
        > safeRadius * Math.hypot(1, tanHalfY);
      if (whollyBeforeNear || outsideSideX || outsideSideY) return setPointFootprint(result);
      return setCoveringFootprint(result, width, height);
    }
    const x = (rimNdc.x * 0.5 + 0.5) * width;
    const y = (-rimNdc.y * 0.5 + 0.5) * height;
    rimXPx[i] = x;
    rimYPx[i] = y;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const footprintX = (minX + maxX) * 0.5;
  const footprintY = (minY + maxY) * 0.5;
  let radiusPx = 0;
  for (let i = 0; i < samples; i++) {
    radiusPx = Math.max(radiusPx, Math.hypot(rimXPx[i] - footprintX, rimYPx[i] - footprintY));
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
  result.footprintKind = 'sampled';
  return result;
}

const estOffAxis = new THREE.Vector3();
const estTangent = new THREE.Vector3();
const estRimA = { x: 0, y: 0 };
const estRimB = { x: 0, y: 0 };

/** Safety factor on the two-axis extent below. The rim projects to a
 *  near-ellipse, but its PIXEL-space major axis need not align with the two
 *  view-space directions sampled here: anisotropic pixel scaling (a portrait
 *  viewport) rotates the ellipse, and two perpendicular central chords can
 *  under-read a major axis by up to 1/sqrt(2) (both sampled at 45° to it).
 *  1.5 covers that bound plus the blend's non-elliptical residue and the
 *  sampling pad; the property sweep in the tests holds the overestimate
 *  contract across FOVs, strengths, aspects, azimuths, and poses. */
const ESTIMATE_MARGIN = 1.5;

/**
 * Cheap conservative OVERestimate of `projectSphereToScreen(...).diameterPx`:
 * the tangent cone's four extreme rim rays (radial and tangential pairs)
 * through the exact same per-ray projection, instead of 32 samples twice.
 *
 * Contract: for any pose where the full function would return a `'sampled'`
 * or `'covering'` footprint, this returns a value (possibly Infinity) that is
 * >= its `diameterPx` — so a threshold the estimate does NOT cross is one the
 * real footprint cannot cross, and per-frame consumers (LOD/upgrade triggers)
 * may skip the full measurement on that basis. Behind-camera spheres return 0,
 * matching the full function's degenerate-point footprint. Near/straddling
 * poses return Infinity (always measure). Never use this where the actual
 * on-screen size is consumed — it is a gate, not a measurement.
 */
export function estimateSphereScreenDiameterPx(
  centre: { x: number; y: number; z: number },
  radius: number,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): number {
  const safeRadius = Math.max(radius, 0);
  if (safeRadius === 0) return 0;
  sphereCentreView.set(centre.x, centre.y, centre.z).applyMatrix4(camera.matrixWorldInverse);
  // Behind the camera: no display footprint (the full path returns a
  // degenerate point there).
  if (sphereCentreView.z >= safeRadius) return 0;
  const distance = sphereCentreView.length();
  // Close, inside, or straddling the camera plane: the tangent-cone geometry
  // degenerates toward the full path's 'covering' cases — always measure.
  if (sphereCentreView.z > -safeRadius) return Infinity;
  if (!(distance > safeRadius * 4)) return Infinity;

  sphereDirection.copy(sphereCentreView).multiplyScalar(1 / distance);
  const sinAlpha = safeRadius / distance;
  const cosAlpha = Math.sqrt(Math.max(1 - sinAlpha * sinAlpha, 0));
  prepareRimContext(camera);
  // The two-chord bound below holds for near-elliptical rims. At full lens
  // strength the projection is conformal, so that is every pose — but any
  // rectilinear component (reduced or zero strength) degenerates toward the
  // 90° pole, and past ~49° off-axis the rim's conic grows lopsided enough to
  // break the bound (measured by the test sweep). Defer those poses to the
  // full measurement; they are far outside every frame that matters.
  const conformal = rimCtx.lensActive && rimCtx.warp.strength >= 1;
  if (!conformal) {
    const rimAngle = Math.acos(THREE.MathUtils.clamp(-sphereCentreView.z / distance, -1, 1))
      + Math.asin(THREE.MathUtils.clamp(sinAlpha, 0, 1));
    if (rimAngle > 45 * (Math.PI / 180)) return Infinity;
  }
  // Radial rim pair: within the plane spanned by the view axis and the centre
  // direction — where every projection in the lens family stretches most.
  estOffAxis.set(sphereDirection.x, sphereDirection.y, 0);
  if (estOffAxis.lengthSq() < 1e-18) estOffAxis.set(1, 0, 0);
  else estOffAxis.normalize();
  sphereRimDirection
    .copy(sphereDirection).multiplyScalar(cosAlpha)
    .addScaledVector(estOffAxis, sinAlpha);
  if (!projectCameraRayToOutputNdc(sphereRimDirection, estRimA)) return Infinity;
  sphereRimDirection
    .copy(sphereDirection).multiplyScalar(cosAlpha)
    .addScaledVector(estOffAxis, -sinAlpha);
  if (!projectCameraRayToOutputNdc(sphereRimDirection, estRimB)) return Infinity;
  const radialExtent = Math.hypot(
    (estRimA.x - estRimB.x) * 0.5 * width,
    (estRimA.y - estRimB.y) * 0.5 * height,
  );
  // Tangential rim pair: perpendicular to the radial plane.
  estTangent.crossVectors(sphereDirection, estOffAxis);
  if (estTangent.lengthSq() < 1e-18) estTangent.set(0, 1, 0);
  else estTangent.normalize();
  sphereRimDirection
    .copy(sphereDirection).multiplyScalar(cosAlpha)
    .addScaledVector(estTangent, sinAlpha);
  if (!projectCameraRayToOutputNdc(sphereRimDirection, estRimA)) return Infinity;
  sphereRimDirection
    .copy(sphereDirection).multiplyScalar(cosAlpha)
    .addScaledVector(estTangent, -sinAlpha);
  if (!projectCameraRayToOutputNdc(sphereRimDirection, estRimB)) return Infinity;
  const tangentialExtent = Math.hypot(
    (estRimA.x - estRimB.x) * 0.5 * width,
    (estRimA.y - estRimB.y) * 0.5 * height,
  );
  return Math.max(radialExtent, tangentialExtent) * ESTIMATE_MARGIN;
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
