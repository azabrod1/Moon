/**
 * The cloud field's shader slots and whether this session has the field
 * (world/cloudField), apart from the pool that fills them
 * (world/cloudFieldPool). Always loaded, and small: the surface shader binds
 * these slots on a program compiled with CLOUD_FIELD, and the deck's factory
 * asks here whether to compile it. The pool — and the worker it starts — is a
 * module of its own, imported only by a session that asked for the field, so
 * a session that did not loads, allocates, fetches and constructs none of it.
 *
 * THE FIELD IS ON once, at boot and under the cover: the session asked
 * (`?cloudtiles=1`), the device's profile gives the pool layers, and the
 * pool's allocation came back with no GL error (PlanetariumMode). That is
 * settled before the solar system is built, so the deck compiles the define
 * the first time it compiles at all. Until then, and for the whole session if
 * any of the three says no, no material carries the define and none of the
 * slots below exists.
 */
import * as THREE from 'three';
import { CLOUD_FIELD_GRID } from './cloudField';

/** The shader's slots, one object each, shared by every program that compiles
 *  CLOUD_FIELD (only the deck does). */
export interface CloudFieldUniforms {
  uCloudPages: { value: THREE.DataArrayTexture };
  uCloudPageTable: { value: THREE.DataTexture };
  /** The scene ratio over the tile ratio: what turns the shader's scene-pixel
   *  derivatives into the tile-ratio pixels the guard and the residency both
   *  measure in (world/cloudField `CLOUD_FIELD_GUARD_TEXELS`). */
  uCloudFieldPixelScale: { value: number };
}

let uniforms: CloudFieldUniforms | null = null;
/** The last scene-over-tile ratio the mode reported, kept so slots created
 *  after it (the deck compiles after boot) start from it. */
let pixelScale = 1;

/** The slots, created on first use with a 1×1×1 stand-in array and an empty
 *  table, so a program can compile and draw before the pool exists. */
export function cloudFieldUniforms(): CloudFieldUniforms {
  if (!uniforms) {
    const standIn = new THREE.DataArrayTexture(new Uint8Array(2), 1, 1, 1);
    standIn.format = THREE.RGFormat;
    standIn.colorSpace = THREE.NoColorSpace;
    standIn.needsUpdate = true;
    const [w, h] = CLOUD_FIELD_GRID;
    const table = new THREE.DataTexture(new Uint8Array(w * h * 2), w, h, THREE.RGFormat, THREE.UnsignedByteType);
    table.colorSpace = THREE.NoColorSpace;
    table.minFilter = THREE.NearestFilter;
    table.magFilter = THREE.NearestFilter;
    table.generateMipmaps = false;
    table.flipY = false;
    table.unpackAlignment = 1;
    table.needsUpdate = true;
    uniforms = {
      uCloudPages: { value: standIn },
      uCloudPageTable: { value: table },
      uCloudFieldPixelScale: { value: pixelScale },
    };
  }
  return uniforms;
}

/** The development build's diagnostic (world/cloudField
 *  `CLOUD_FIELD_DIAGNOSTICS`, `__moon.cloudField({ diag })`). Read only by
 *  development code, so a production build carries none of it. */
export const cloudFieldDiagUniform = { value: 0 };

/** `?cloudtiles=1`, in any build: whether a query asks for the field. */
export function cloudFieldAsked(search: string): boolean {
  return new URLSearchParams(search).get('cloudtiles') === '1';
}

/** `?cloudpoolfail=1`, read by development builds only (world/cloudFieldPool):
 *  whether a query asks for the pool's boot allocation to be reported failed,
 *  so the field's way off can be driven on a machine with room for the pool. */
export function cloudPoolFailAsked(search: string): boolean {
  return new URLSearchParams(search).get('cloudpoolfail') === '1';
}

/** The page's own query, read once at boot: a define is part of three's
 *  program key, so a switch that moved mid-session would relink. */
const fieldByUrl = typeof location !== 'undefined' && cloudFieldAsked(location.search);

/** Whether this session asked for the field. Asking is not having it: the
 *  device's profile may give the pool no layers, and the allocation may fail. */
export function cloudFieldRequested(): boolean {
  return fieldByUrl;
}

let fieldOn = false;

/** Whether this session draws the field. */
export function cloudFieldOn(): boolean {
  return fieldOn;
}

/** The materials compiled with CLOUD_FIELD: the planetarium's deck and the
 *  warm-up probe that stands in for it. */
const fieldMaterials = new Set<THREE.Material>();

/** Settle the session's answer (PlanetariumMode, at boot under the cover; and
 *  off again if a context restore cannot allocate the pool, when every program
 *  relinks anyway). Off takes the define back off every material that had it,
 *  so a pool that is not there is never sampled as one. */
export function setCloudFieldOn(on: boolean): void {
  fieldOn = on;
  if (on) return;
  for (const mat of fieldMaterials) {
    const m = mat as THREE.Material & { defines?: Record<string, string> };
    if (m.defines) delete m.defines.CLOUD_FIELD;
    mat.needsUpdate = true;
  }
  fieldMaterials.clear();
}

/** Compile the field into this material (the deck's), when the session has
 *  it. A define, so it is part of three's program key; set before the first
 *  compile. */
export function enableCloudField(mat: THREE.Material): void {
  if (!fieldOn || fieldMaterials.has(mat)) return;
  const m = mat as THREE.Material & { defines?: Record<string, string> };
  m.defines = { ...(m.defines ?? {}), CLOUD_FIELD: '' };
  fieldMaterials.add(mat);
  mat.addEventListener('dispose', () => fieldMaterials.delete(mat));
  mat.needsUpdate = true;
}

/**
 * Tell the field the scene's pixel ratio and the tile ratio (PlanetariumMode's
 * scene-ratio hook, which every rung, level and pin change already runs). A
 * Dynamic rung step moves the scene ratio alone, so the guard's pixels stay
 * the tile ratio's and no fragment's weight moves with it.
 */
export function setCloudFieldPixelRatios(sceneRatio: number, tileRatio: number): void {
  pixelScale = sceneRatio > 0 && tileRatio > 0 ? sceneRatio / tileRatio : 1;
  if (uniforms) uniforms.uCloudFieldPixelScale.value = pixelScale;
}
