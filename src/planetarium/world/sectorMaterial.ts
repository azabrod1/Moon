/**
 * The material a streamed surface sector draws with. A sector overlays its
 * body's globe with a 2048² tile of a 16K source plus crops of the globe's
 * own relief / roughness maps, and it must shade EXACTLY like the globe under
 * it: same lighting terms, same eclipse and planetshine uniforms, same scalar
 * state — or the sector reads as a rectangle on the surface.
 *
 * Built fresh rather than cloned: Material.copy() drops onBeforeCompile (the
 * surface shading hook) and JSON-clones userData (which can hold a render
 * target), so a clone is silently a different material. Instead the base's
 * augmentation args are read back from surfaceShading's side table and the
 * sector is augmented with the SAME fx objects; the base's scalar state is
 * mirrored here at creation and again every frame by the streamer
 * (`syncSectorMaterial`), which is what carries the Moon's per-frame eclipse
 * tint onto its sectors. The sector never references a base texture — every
 * map it draws is its own tile or crop — so the base's dispose-on-swap seams
 * can never leave it sampling a freed texture.
 */
import * as THREE from 'three';
import { augmentSurfaceMaterial, surfaceShadingArgsOf } from './surfaceShading';

/** The maps a sector owns: its colour tile, and crops of whichever relief /
 *  roughness maps its base material carries. */
export interface SectorMaps {
  map: THREE.Texture;
  bumpMap?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
}

/** Draw order: sectors before the globe, so early-Z rejects the globe's
 *  fragments under a resident sector instead of shading the largest thing on
 *  screen twice. */
export const SECTOR_RENDER_ORDER = -1;

export function createSectorMaterial(
  base: THREE.MeshStandardMaterial,
  maps: SectorMaps,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    bumpMap: maps.bumpMap ?? null,
    normalMap: maps.normalMap ?? null,
    roughnessMap: maps.roughnessMap ?? null,
  });
  syncSectorMaterial(mat, base);
  // The sector's vertices coincide with the globe's (sectorGrid pins it), so
  // depth ties exactly; a units-only offset breaks the tie in the sector's
  // favour without a slope term that could pull it under the shells above.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 0;
  mat.polygonOffsetUnits = -1;
  const args = surfaceShadingArgsOf(base);
  // The same fx objects, so the sector's eclipse spot, its planetshine and the
  // air in front of it are the globe's own values and not a second set; and the
  // same frame spin, because a sector mesh hangs under the mesh this base
  // material draws and inherits whatever rotation that carries.
  if (args) {
    augmentSurfaceMaterial(mat, args.archetype, args.ringShadow, args.sunTan, args.fx, args.uFrameSpin);
  }
  return mat;
}

/**
 * Mirror the base material's scalar state onto a sector (cheap: a handful of
 * fields, no texture swaps — the sector's maps are its own). Called at
 * creation and once per frame per live sector.
 */
export function syncSectorMaterial(mat: THREE.MeshStandardMaterial, base: THREE.MeshStandardMaterial): void {
  mat.color.copy(base.color);
  mat.emissive.copy(base.emissive);
  mat.emissiveIntensity = base.emissiveIntensity;
  mat.roughness = base.roughness;
  mat.metalness = base.metalness;
  mat.bumpScale = base.bumpScale;
  mat.normalScale.copy(base.normalScale);
}
