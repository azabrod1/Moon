/**
 * What UnrealBloomPass allocates that its own picture never reads, and who is
 * allowed to re-allocate it.
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
  materialHighPassFilter: THREE.ShaderMaterial;
  separableBlurMaterials: THREE.Material[];
  compositeMaterial: THREE.Material;
  blendMaterial: THREE.Material;
}

/**
 * The bright pass's material — the one material in the chain that reads the
 * buffer the scene was drawn into, so it is the one that has to be told where
 * inside that buffer the frame is (app/sceneSubRect.ts).
 *
 * Everything after it reads the pass's own mips, which are full images of
 * whatever the bright pass took, at the bloom chain's own size: the blurs, the
 * composite and the additive blend need no rectangle and are deliberately left
 * exactly as three wrote them.
 */
export function bloomHighPassMaterial(pass: UnrealBloomPass): THREE.ShaderMaterial {
  return (pass as unknown as BloomInternals).materialHighPassFilter;
}

/**
 * Take the pass's own `setSize` away from the composer and hand it back to
 * its caller.
 *
 * EffectComposer sizes every pass on every `setSize`, and UnrealBloomPass is
 * the only pass in this app's chain that allocates when asked: its
 * `setSize` re-sizes eleven half-float targets, and a render target disposes
 * its GL objects on any dimension change. The bloom chain is deliberately NOT
 * on the scene's ratio — it keeps the renderer's old floor so the glow holds
 * the width and the cost it had on every display — so every composer resize
 * used to size the chain to the scene, dispose it, and then size it back:
 * ~115 MB of allocation churn at 1728x1117 with the chain at 2, ~185 MB with
 * the scene at 3. A dynamic resolution step pays that on every rung.
 *
 * So the instance's method becomes a no-op and the real one is returned. The
 * chain then has exactly one writer of its size, which is the only one that
 * ever wanted to write it.
 */
export function holdBloomSize(pass: UnrealBloomPass): (width: number, height: number) => void {
  const size = pass.setSize.bind(pass);
  pass.setSize = () => {};
  return size;
}

/** Every target the pass renders into, bright pass and both blur chains. */
function bloomTargets(pass: UnrealBloomPass): THREE.WebGLRenderTarget[] {
  const p = pass as unknown as BloomInternals;
  return [p.renderTargetBright, ...p.renderTargetsHorizontal, ...p.renderTargetsVertical];
}

/** Every full-screen material the pass draws with on the composer path. The
 *  pass also owns a plain MeshBasicMaterial it uses only when it renders to
 *  the screen itself, which it never does here (an OutputPass always
 *  follows), so that one is left as built. */
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
