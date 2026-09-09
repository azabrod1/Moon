/**
 * What UnrealBloomPass allocates that its own picture never reads.
 *
 * The pass builds eleven render targets — one bright-pass and five
 * horizontal/vertical blur pairs — and asks three for each of them with a type
 * alone, which leaves `depthBuffer` on its default of true. Every draw into all
 * eleven is a full-screen quad, and every one of its own materials is a plain
 * copy or a blur, so no fragment is ever depth-tested or depth-written: the
 * planes are allocated, cleared, stored and thrown away once a frame, on a
 * device where memory bandwidth is the thing in short supply.
 *
 * Removing them cannot move a pixel. A depth plane that is never tested
 * against and never written to has no reader, and the two full-screen
 * materials that still carried three's default depth state (the bright pass
 * and the blurs) draw a quad the ortho camera puts inside the clear value, so
 * the test they were running passed on every fragment.
 *
 * Reversible on purpose: the switch this sits behind is an A/B against the
 * picture as it was, and a render target's attachments are decided when its GL
 * object is allocated, so putting the planes back means disposing the targets
 * and letting the next bind build them again.
 */
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type * as THREE from 'three';

interface BloomInternals {
  renderTargetBright: THREE.WebGLRenderTarget;
  renderTargetsHorizontal: THREE.WebGLRenderTarget[];
  renderTargetsVertical: THREE.WebGLRenderTarget[];
  materialHighPassFilter: THREE.Material;
  separableBlurMaterials: THREE.Material[];
  compositeMaterial: THREE.Material;
  blendMaterial: THREE.Material;
}

/** Every target the pass renders into, bright pass and both blur chains. */
function bloomTargets(pass: UnrealBloomPass): THREE.WebGLRenderTarget[] {
  const p = pass as unknown as BloomInternals;
  return [p.renderTargetBright, ...p.renderTargetsHorizontal, ...p.renderTargetsVertical];
}

/** Every full-screen material the pass draws with. */
function bloomMaterials(pass: UnrealBloomPass): THREE.Material[] {
  const p = pass as unknown as BloomInternals;
  return [p.materialHighPassFilter, ...p.separableBlurMaterials, p.compositeMaterial, p.blendMaterial];
}

/** What each material's depth state was when the pass built it. The blend
 *  material already came with both off, so "put it back" is not the same
 *  answer for every material and cannot be spelled `true`. */
const asBuilt = new WeakMap<THREE.Material, { test: boolean; write: boolean }>();

/**
 * Give the pass's internal targets a depth plane, or take it away.
 *
 * `depth: false` is what ships. Passing true puts back exactly what the pass
 * built — remembered per material the first time it is touched, so a capture
 * can be taken either way inside one page load and the "before" arm really is
 * the picture as it was.
 */
export function setBloomInternalDepth(pass: UnrealBloomPass | null, depth: boolean): void {
  if (!pass) return;
  for (const target of bloomTargets(pass)) {
    if (target.depthBuffer === depth) continue;
    target.depthBuffer = depth;
    // The attachment list is fixed when the GL framebuffer is built, so the
    // old one has to go before the change means anything.
    target.dispose();
  }
  for (const material of bloomMaterials(pass)) {
    let built = asBuilt.get(material);
    if (!built) {
      built = { test: material.depthTest, write: material.depthWrite };
      asBuilt.set(material, built);
    }
    material.depthTest = depth ? built.test : false;
    material.depthWrite = depth ? built.write : false;
  }
}
