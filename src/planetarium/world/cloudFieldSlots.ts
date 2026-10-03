/**
 * The cloud field's shader slots and its switch (world/cloudField, the 1.2 km
 * field's vertical slice), apart from the pool that fills them
 * (world/cloudFieldPool): the surface shader binds these and the deck's
 * factory sets the define, both on the dev server only, while the pool — and
 * the worker it starts — is loaded on demand by the development bridge, so no
 * build reaches it unless `?cloudtiles=1` asks.
 */
import * as THREE from 'three';
import { CLOUD_FIELD_GRID } from './cloudField';

/** The shader's three slots, one object each, shared by every program that
 *  compiles CLOUD_FIELD (only the deck does). */
export interface CloudFieldUniforms {
  uCloudPages: { value: THREE.DataArrayTexture };
  uCloudPageTable: { value: THREE.DataTexture };
  uCloudFieldDiag: { value: number };
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
      uCloudFieldDiag: { value: 0 },
      uCloudFieldPixelScale: { value: pixelScale },
    };
  }
  return uniforms;
}

/** The materials compiled with CLOUD_FIELD: the deck, when `?cloudtiles=1`. */
const fieldMaterials = new Set<THREE.Material>();

/** Those materials, for the bridge's report on the linked program. */
export function cloudFieldMaterials(): ReadonlySet<THREE.Material> {
  return fieldMaterials;
}

/** Compile the field into this material (the deck's). A define, so it is part
 *  of three's program key; set before the first compile. */
export function enableCloudField(mat: THREE.Material): void {
  const m = mat as THREE.Material & { defines?: Record<string, string> };
  m.defines = { ...(m.defines ?? {}), CLOUD_FIELD: '' };
  fieldMaterials.add(mat);
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
