/**
 * One allocation, many rungs: the sub-rectangle the scene is drawn into.
 *
 * Dynamic slides over the rungs of app/renderQuality.ts, and re-sizing the
 * composer's scene-sized targets on every step is the expensive part of a
 * step: WebKit spends 19–42 ms at a phone frame and 65–150 ms at a Mac window
 * freeing and allocating them, in both directions, whatever the pixel count.
 * So Dynamic allocates those targets ONCE, at the largest size its ladder can
 * reach, and every rung draws into the bottom-left corner of that allocation.
 * A rung change then writes a viewport, a scissor box and a handful of
 * uniforms, and moves no memory at all.
 *
 * This module is the arithmetic and the shader edit; main.ts owns the
 * targets and is the only writer of their rectangles.
 *
 * **Only Dynamic, and only the planetarium's composer.** A fixed level never
 * steps, so it has nothing to gain and would pay the memory for nothing:
 * Low, Medium and High allocate at their own size exactly as before, which is
 * what keeps Medium today's frame byte for byte by construction rather than by
 * measurement. The other modes' composers (flight, Volume Compare, Look
 * inside) are rebuilt on every entry and never draw at a ratio of their own.
 *
 * **The origin is (0, 0), and that is load-bearing.** Two shaders read
 * `gl_FragCoord` as framebuffer-absolute and divide by a size derived from the
 * CSS box and the scene ratio — the point-sprite kernel every star and moon dot
 * runs (shared/three/lensShader.ts) and the resample shaders (app/fsr1.ts) —
 * so a centred sub-rect would misplace every star sprite and every resample
 * tap. The sub-rect is anchored at the origin everywhere, and the test pins it.
 *
 * **Every reader of a scene-sized target must be scaled.** A full-screen quad's
 * `vUv` runs 0..1 over the sub-rect it is drawn into, but the TEXTURE it reads
 * is the whole allocation, so each sampling site multiplies by `uUvScale` =
 * (drawWidth / allocWidth, drawHeight / allocHeight) and clamps to half a texel
 * inside the sub-rect's far edge, so no bilinear tap reaches the stale region
 * past it. That region is never cleared — a clear would cost the whole
 * allocation every frame — and with every sampler scaled it has no reader.
 *
 * At `uUvScale` = 1 the clamp is free: a fragment centre's `vUv` is at most
 * 1 − 0.5/size on the axis it is drawn across, which is exactly the bound, and
 * `x * 1.0` is exact in IEEE arithmetic. So the same shader text carries the
 * unscaled frame unchanged.
 *
 * **The multisampled resolve.** three resolves a multisampled target with
 * `blitFramebuffer(0, 0, width, height, …)` over the whole allocation at the
 * end of every render, while the target's scissor box and scissor test are
 * still the current GL state. GL ES says the scissor applies to a blit, and on
 * ANGLE Metal and WebKit the driver also does only the clipped work —
 * measured, at 2 and 4 samples, with and without depth/stencil in the mask: a
 * large allocation with a small scissored draw resolves at the small draw's
 * cost. Windows (ANGLE D3D11) and Firefox are unmeasured; ANGLE clips the blit
 * rectangle to the scissor inside libANGLE before any backend, so the same is
 * expected there, not proven.
 */
import * as THREE from 'three';
import type { QualityLadder } from './renderQuality';

/** A target's size in device pixels. */
export interface TargetSize {
  width: number;
  height: number;
}

/** Where the frame is drawn inside the allocation, and what a reader of a
 *  scene-sized target has to multiply its `vUv` by. */
export interface SceneRects {
  /** The size the scene-sized targets are allocated at. */
  alloc: TargetSize;
  /** The sub-rectangle at the origin the frame is drawn into. */
  draw: TargetSize;
  /** draw / alloc per axis: 1 where the frame fills its allocation. */
  uvScale: { x: number; y: number };
  /** True where the draw size had to be clamped into the allocation — a
   *  tripwire, never a normal state: it means a ratio moved without the
   *  allocation being re-derived. */
  clamped: boolean;
}

/**
 * The ratio the scene-sized targets are ALLOCATED at.
 *
 * `fixed` is Dynamic on the planetarium's composer with nothing pinning the
 * scene ratio: the allocation is then the ladder's top rung, so no rung the
 * controller can pick needs more storage than is already there. Everything
 * else — every fixed level, every other composer, a measurement pin that owns
 * the ratio, and the `?alloc=0` kill switch — allocates at the size it draws.
 *
 * Never below the draw ratio: a ladder that somehow does not reach the live
 * ratio must not leave the frame drawing outside its own storage.
 */
export function allocationSceneRatio(drawRatio: number, ladder: QualityLadder, fixed: boolean): number {
  if (!fixed) return drawRatio;
  const top = ladder.rungs.length > 0 ? ladder.rungs[ladder.rungs.length - 1] : drawRatio;
  return Math.max(top, drawRatio);
}

/** The allocation, the sub-rect inside it and the UV scale between them.
 *  The draw size is clamped into the allocation rather than trusted: a
 *  viewport larger than its framebuffer is silently clipped by GL, and the
 *  frame would be drawn short with every resample uniform believing
 *  otherwise. */
export function sceneRects(alloc: TargetSize, draw: TargetSize): SceneRects {
  const width = Math.max(1, Math.min(alloc.width, draw.width));
  const height = Math.max(1, Math.min(alloc.height, draw.height));
  return {
    alloc: { width: alloc.width, height: alloc.height },
    draw: { width, height },
    uvScale: { x: width / alloc.width, y: height / alloc.height },
    clamped: width !== draw.width || height !== draw.height,
  };
}

/**
 * The `?alloc=0` kill switch, on any build: back to a re-allocation on every
 * rung change, which is what shipped before the fixed allocation. The A/B for
 * "did the sub-rect break a frame on a device I do not have", in the house
 * style of `?ride=0` and `?orbitanchor=0`.
 */
export function parseAllocParam(search: string): boolean {
  return new URLSearchParams(search).get('alloc') !== '0';
}

// --- the sampling sites ------------------------------------------------------

/** The two uniforms every patched sampling site carries. */
export interface SubRectUniforms {
  /** (drawWidth / allocWidth, drawHeight / allocHeight). */
  uUvScale: THREE.IUniform;
  /** That, less half a texel: the far edge a bilinear tap may not cross. */
  uUvMax: THREE.IUniform;
}

/** The uniform declaration both of three's shaders carry, and where the two
 *  above are put in beside it. */
export const UV_UNIFORM_ANCHOR = 'uniform sampler2D tDiffuse;';

/** The read to scale, as it stands in the installed three. `String.replace`
 *  with a missing needle is a silent no-op, so each of these is checked
 *  before it is used and pinned by a test against the installed version —
 *  the idiom shared/three/lensShader.ts uses for its two clip anchors. */
export const UV_READ = 'texture2D( tDiffuse, vUv )';

/** UnrealBloomPass's bright pass (three's LuminosityHighPassShader). */
export const HIGH_PASS_UV_ANCHOR = 'vec4 texel = texture2D( tDiffuse, vUv );';

/** The finishing pass (three's OutputShader, which OutputPass draws with). */
export const OUTPUT_UV_ANCHOR = 'gl_FragColor = texture2D( tDiffuse, vUv );';

const UV_SCALE_DECLARATIONS = '\nuniform vec2 uUvScale;\nuniform vec2 uUvMax;';
const UV_READ_SCALED = 'texture2D( tDiffuse, min( vUv * uUvScale, uUvMax ) )';

/** Whether a material's fragment text carries the scaled read — the check a
 *  pass makes of its own shader after any other edit to it. */
export function uvScaleIsWired(material: THREE.ShaderMaterial): boolean {
  return material.fragmentShader.includes('uniform vec2 uUvScale;')
    && material.fragmentShader.includes(UV_READ_SCALED);
}

/**
 * Scale one sampling site's read of a scene-sized target, and hand back the
 * uniforms that drive it.
 *
 * The one place any of these shaders is edited: three's own text for the
 * bright pass and the finishing pass, patched at construction, with a throw
 * rather than a silent no-op if a three release has reformatted it. Calling it
 * twice on the same material (the fused finishing pass re-applies it after
 * writing its own text) keeps the uniforms already installed, so a reference
 * taken from the first call stays live.
 */
export function patchUvScale(material: THREE.ShaderMaterial, anchor: string): SubRectUniforms {
  const text = material.fragmentShader;
  if (!anchor.includes(UV_READ) || !text.includes(anchor) || !text.includes(UV_UNIFORM_ANCHOR)) {
    throw new Error(`patchUvScale: the installed three no longer carries ${JSON.stringify(anchor)}`);
  }
  material.fragmentShader = text
    .replace(UV_UNIFORM_ANCHOR, UV_UNIFORM_ANCHOR + UV_SCALE_DECLARATIONS)
    .replace(anchor, anchor.replace(UV_READ, UV_READ_SCALED));
  const uniforms = material.uniforms as Record<string, THREE.IUniform>;
  const installed = installSubRectUniforms(uniforms);
  material.needsUpdate = true;
  return installed;
}

/** The pair, made once per material and reused if it is patched again. */
export function installSubRectUniforms(uniforms: Record<string, THREE.IUniform>): SubRectUniforms {
  uniforms.uUvScale ??= { value: new THREE.Vector2(1, 1) };
  uniforms.uUvMax ??= { value: new THREE.Vector2(1, 1) };
  return { uUvScale: uniforms.uUvScale, uUvMax: uniforms.uUvMax };
}

/** Point one sampling site at the sub-rectangle. The far edge is half a texel
 *  of the ALLOCATION inside the sub-rect's own edge, which is where a
 *  bilinear tap stops reading what the rung below drew. */
export function applySubRect(uniforms: SubRectUniforms | null, rects: SceneRects): void {
  if (!uniforms) return;
  const { x, y } = rects.uvScale;
  (uniforms.uUvScale.value as THREE.Vector2).set(x, y);
  (uniforms.uUvMax.value as THREE.Vector2).set(
    x - 0.5 / rects.alloc.width,
    y - 0.5 / rects.alloc.height,
  );
}
