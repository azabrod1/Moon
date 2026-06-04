/**
 * DEPRECATED / UNUSED — the Planetarium's textured Milky Way skybox sphere.
 *
 * This was defined on PlanetariumMode (`createSkybox`) but never called, so the
 * planetarium has always shown only the point starfield (see ./starfield.ts),
 * never this textured sphere. The logic is preserved here for reference in case
 * the skybox is ever restored.
 *
 * IMPORTANT: nothing imports this module, so it is tree-shaken out of the
 * production bundle and `textures/starmap_milkyway.jpg` is NOT downloaded on the
 * planetarium's behalf. (That texture is still a real asset — Moon Flight's
 * SkyScene uses it — so the file itself must stay in public/textures/.)
 *
 * To restore: import `buildPlanetariumSkybox` and call it from
 * PlanetariumMode.activate(), keeping a reference for floating-origin
 * repositioning and disposal.
 */
import * as THREE from 'three';
import { TEXTURES } from '../../shared/assets/textures';

export function buildPlanetariumSkybox(
  scene: THREE.Scene,
  onReady?: (mesh: THREE.Mesh) => void,
): void {
  const loader = new THREE.TextureLoader();
  loader.load(TEXTURES.MILKY_WAY, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(84, 64, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      opacity: 1.0,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    // Solar System Scope texture is in galactic coordinates —
    // rotate so the Milky Way band aligns with the equatorial star catalog
    mesh.rotation.set(
      THREE.MathUtils.degToRad(60.2),
      THREE.MathUtils.degToRad(192.86),
      0,
    );
    scene.add(mesh);
    onReady?.(mesh);
  });
}
