/**
 * Boot shader warm-up probes for the surface material.
 *
 * Moon materials start as bare placeholders; their maps arrive later
 * (procedural paint, streamed photo, measured normal), and each arrival flips
 * USE_MAP/USE_BUMPMAP/USE_NORMALMAP — a different shader program than the
 * placeholder's. Compiling the scene at boot therefore builds the wrong
 * variants, and the real ones would link mid-gesture (the measured
 * surface-view stall). These tiny meshes carry exactly the post-arrival
 * combinations; the augmentation is byte-identical GLSL across bodies
 * (uniforms only), so one compile per combination covers every moon.
 *
 * They are added to the scene before renderer.compileAsync and KEPT there for
 * the session: three destroys a program the moment its last material is
 * disposed, and a combination no live material holds yet at boot (a measured
 * normal before the Moon's arrives, the cloud deck's relief) has the probe as
 * its only holder — disposing the probes after the compile threw those
 * programs away, and the first real draw linked them again mid-flight. The
 * group is invisible for ordinary frames and never raycast; activation
 * briefly makes it visible only for a one-pixel, load-veiled real draw on
 * drivers where compileAsync cannot guarantee a completed link.
 *
 * The deck's probe takes the cloud field's define when the session has the
 * field (world/cloudFieldSlots, settled before these are built), and the cloud
 * light's when the session compiles it (world/surfaceShading), so the program
 * it links is the planetarium deck's own. The cloud shadow's define is never
 * carried: world/surfaceShading keeps it off every probe. Earth's ground needs
 * no probe for its shadow: the globe carries CLOUD_SHADOW — and CLOUD_FIELD
 * beside it, in a session with the field — from its first compile, its
 * sectors share its program, and the boot compile links it through the globe
 * itself.
 */
import * as THREE from 'three';
import { applyTextureDefaults, type MapKind } from './texturePolicy';
import { augmentSurfaceMaterial, setCloudDeckWarmupProbe } from './surfaceShading';
import { enableCloudField } from './cloudFieldSlots';

export interface WarmupProbes {
  group: THREE.Group;
  dispose: () => void;
}

export const SHADER_WARMUP_PROBE_COMBOS: ReadonlyArray<{
  readonly map: true;
  readonly bumpMap?: true;
  readonly normalMap?: true;
  readonly transparent?: true;
  readonly why: string;
}> = [
  { map: true, bumpMap: true, why: 'painted moon, or a photo over the procedural bump' },
  { map: true, normalMap: true, why: 'photo with a measured normal (the Moon)' },
  { map: true, why: 'photo arrived before the paint' },
  { map: true, normalMap: true, transparent: true, why: 'the cloud deck once its relief lands' },
];

export function createShaderWarmupProbes(): WarmupProbes {
  // One mid-grey texel: only a map's presence and its colour space key the
  // program, and a data texture needs no canvas, so the probes build anywhere
  // the material does.
  const makeTex = (kind: MapKind): THREE.Texture => {
    const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    applyTextureDefaults(tex, kind);
    tex.needsUpdate = true;
    return tex;
  };
  const geo = new THREE.SphereGeometry(1e-9, 4, 2);
  const group = new THREE.Group();
  group.visible = false;
  const mats: THREE.MeshStandardMaterial[] = [];
  for (const combo of SHADER_WARMUP_PROBE_COMBOS) {
    const mat = new THREE.MeshStandardMaterial({
      map: makeTex('color'),
      bumpMap: combo.bumpMap ? makeTex('data') : null,
      normalMap: combo.normalMap ? makeTex('normal') : null,
      // Opaque and transparent are two programs in three's cache key.
      transparent: combo.transparent === true,
    });
    // The archetype is uniforms only, so any value keys the same program —
    // except on the deck, whose archetype is a define (world/surfaceShading's
    // SURFACE_ARCHETYPE_MACROS): the transparent combination is the deck's,
    // and the probe has to carry the deck's define or it warms a program the
    // deck never draws with.
    augmentSurfaceMaterial(mat, combo.transparent ? 'cloud' : 'rocky');
    // ...and the cloud field's and the cloud light's, as the session compiles
    // them into the deck: its program after its relief lands carries both
    // (each a no-op where the session has it off, so the probe is the program
    // it was).
    if (combo.transparent) {
      enableCloudField(mat);
      setCloudDeckWarmupProbe(mat);
    }
    mats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    // A probe lives at the origin for the whole session; a scene-wide pick
    // must never land on it.
    mesh.raycast = () => {};
    group.add(mesh);
  }
  return {
    group,
    dispose: () => {
      for (const mat of mats) {
        mat.map?.dispose();
        mat.bumpMap?.dispose();
        mat.normalMap?.dispose();
        mat.dispose();
      }
      geo.dispose();
    },
  };
}
