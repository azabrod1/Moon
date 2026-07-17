/**
 * The Sun's veiling glare, as an obscuration mask over everything drawn behind
 * it. The glare itself is an additive billboard; stars, the asteroid belt, and
 * the marker/label overlays render under (or above) it and would otherwise read
 * straight *through* the blaze. This is the one definition site for a screen-
 * space mask that fades those consumers inside the glare so nothing shows
 * through it.
 *
 * The signal mirrors the glare shader's own wide veil (a screen-space Moffat
 * wash plus two diffraction arms) plus a small geometric core so the Sun's bare
 * outer-system glint still obscures coincident points when the wash is idle.
 * Everything is a pure function of aspect-correct CSS pixels measured from the
 * Sun's unclamped screen position, so it keeps working when the Sun is off-frame
 * and collapses to a no-op (mask 0) when the Sun is behind the camera or the
 * glare pipeline is ineligible.
 *
 * The GPU consumers (stars, belt) and the CPU consumers (marker sprites, HTML
 * labels, the Sun's own label) share this one formula: the GLSL builder below
 * interpolates the same two shared Moffat constants the shader draws with, so
 * the drawn glare and the mask that fades against it can never drift apart.
 */
import * as THREE from 'three';
import { SUN_VEIL_BETA, SUN_VEIL_SCALE_H } from '../../shared/shaders/sun';

/**
 * One persistent parameter set per frame, filled by the controller after the
 * Sun's exposure/occlusion are final and read by every consumer. All fields are
 * in aspect-correct CSS pixels. When `active` is false the mask is 0 everywhere,
 * so consumers render byte-identically to a build without it.
 */
export interface SunGlareMaskParams {
  /** Sun in front of the camera AND the glare pipeline is eligible this frame. */
  active: boolean;
  /** Sun screen x, CSS px, top-left origin, unclamped (may sit off-frame). */
  sunXPx: number;
  /** Sun screen y, CSS px, top-left origin, unclamped. */
  sunYPx: number;
  /** Wash amplitude `uVeilStrength × veilAmt × exposureScale` (shader veilEnergy
   *  without the flash/atmosphere terms). ~0 in the outer system. */
  peak: number;
  /** Diffraction-arm coefficient (shader uArmCoeff); 0 once the disc resolves. */
  armCoeff: number;
  /** Horizontal arm e-fold length, CSS px. */
  armDecayPx: number;
  /** Vertical arm e-fold length, CSS px. */
  armDecayYPx: number;
  /** Outer radius of the geometric core mask, CSS px; 0 disables the core. */
  coreOuterPx: number;
  /** Viewport height, CSS px — the Moffat's length scale. */
  viewportHeight: number;
}

/** Clamped smoothstep, matching GLSL `smoothstep(edge0, edge1, x)`. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The mask at a point whose signed pixel offset from the Sun is (dx, dy) and
 * whose radial distance is dPx. Shared by the point and rectangle entry points
 * so the wash, the directional arms, and the core are computed once.
 */
function maskFromOffsets(p: SunGlareMaskParams, dx: number, dy: number, dPx: number): number {
  const h = Math.max(p.viewportHeight, 1);
  // Screen-space Moffat wash — the same profile the glare fragment draws.
  const dNorm = dPx / (SUN_VEIL_SCALE_H * h);
  const moffat = 1 / Math.pow(1 + dNorm * dNorm, SUN_VEIL_BETA);
  // Long thin diffraction arms: the horizontal pair reaches farther than the
  // vertical, like an aperture's dominant axis. Symmetric in sign, so the
  // screen/plane y flip is immaterial.
  const ax = dy / 1.7;
  const ay = dx / 1.7;
  const armX = Math.exp(-ax * ax) * Math.exp(-Math.abs(dx) / Math.max(p.armDecayPx, 1));
  const armY = Math.exp(-ay * ay) * Math.exp(-Math.abs(dy) / Math.max(p.armDecayYPx, 1)) * 0.25;
  const localVeil = p.peak * (moffat + p.armCoeff * (armX + armY));
  const wideMask = smoothstep(0.01, 0.08, localVeil);
  // A small geometric core independent of the wash so the bare outer-system
  // glint (wash ~0) still obscures points sitting right on it.
  const coreMask = p.coreOuterPx > 0
    ? 1 - smoothstep(0.45 * p.coreOuterPx, p.coreOuterPx, dPx)
    : 0;
  return Math.max(wideMask, coreMask);
}

/** Obscuration mask [0, 1] at a screen point (CSS px). 0 when inactive. */
export function sunGlareMaskAt(p: SunGlareMaskParams, xPx: number, yPx: number): number {
  if (!p.active) return 0;
  const dx = xPx - p.sunXPx;
  const dy = yPx - p.sunYPx;
  return maskFromOffsets(p, dx, dy, Math.hypot(dx, dy));
}

/**
 * Obscuration mask [0, 1] for an axis-aligned rectangle (CSS px), measured from
 * the nearest point of the rectangle to the Sun — so a label fades only when its
 * body actually enters the glare, not when its distant anchor does. Degenerates
 * to `sunGlareMaskAt` when the rectangle collapses to a point.
 */
export function sunGlareMaskForRect(
  p: SunGlareMaskParams,
  leftPx: number,
  topPx: number,
  rightPx: number,
  bottomPx: number,
): number {
  if (!p.active) return 0;
  const nearestX = Math.min(Math.max(p.sunXPx, leftPx), rightPx);
  const nearestY = Math.min(Math.max(p.sunYPx, topPx), bottomPx);
  const dx = nearestX - p.sunXPx;
  const dy = nearestY - p.sunYPx;
  return maskFromOffsets(p, dx, dy, Math.hypot(dx, dy));
}

/** L value the Sun's own label parks just past, plus the pixel pad below. */
const SUN_LABEL_CLEAR_L = 0.02;
const SUN_LABEL_CLEAR_PAD_PX = 12;

/**
 * Radius (CSS px) the Sun's own label must sit past so it never lands in its own
 * glare. Solves the wash Moffat for the `L = 0.02` isophote the same way the
 * shader's support solver inverts the profile, then adds a small pad. 0 when
 * inactive; the pad alone when the wash is idle (outer system). Monotone
 * non-decreasing in `peak`.
 */
export function sunLabelClearRadiusPx(p: SunGlareMaskParams): number {
  if (!p.active) return 0;
  if (p.peak <= SUN_LABEL_CLEAR_L) return SUN_LABEL_CLEAR_PAD_PX;
  const h = Math.max(p.viewportHeight, 1);
  // peak · (1 + dNorm²)^(-β) = L  ->  dNorm² = (peak / L)^(1/β) − 1
  const ratio = Math.pow(p.peak / SUN_LABEL_CLEAR_L, 1 / SUN_VEIL_BETA);
  const dNorm = Math.sqrt(Math.max(ratio - 1, 0));
  return dNorm * SUN_VEIL_SCALE_H * h + SUN_LABEL_CLEAR_PAD_PX;
}

/** Emit a numeric literal GLSL can parse as a float (guaranteed decimal point). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * GLSL declarations + `sunGlareMask(vec4 clip)` for GPU point consumers. The two
 * Moffat constants are interpolated from the shared shader source, so the mask
 * and the drawn glare stay in lockstep. The point projects once (vertex stage):
 * feed it `gl_Position` and multiply `1.0 − 0.98 × mask` into the alpha varying.
 * Returns exactly 0.0 when inactive, so the alpha scale is exactly 1.0 and the
 * consumer renders byte-identically to a build without the mask.
 */
export function sunGlareMaskGLSL(): string {
  const scaleH = glslFloat(SUN_VEIL_SCALE_H);
  const beta = glslFloat(SUN_VEIL_BETA);
  return /* glsl */ `
uniform float uSunMaskActive;
uniform vec2 uSunMaskScreenPx;
uniform vec2 uSunMaskViewportPx;
uniform float uSunMaskPeak;
uniform float uSunMaskArmCoeff;
uniform float uSunMaskArmDecayPx;
uniform float uSunMaskArmDecayYPx;
uniform float uSunMaskCoreOuterPx;

float sunGlareMask(vec4 clip) {
  if (uSunMaskActive < 0.5 || clip.w <= 0.0) return 0.0;
  vec2 ndc = clip.xy / clip.w;
  vec2 px = vec2(
    (ndc.x * 0.5 + 0.5) * uSunMaskViewportPx.x,
    (0.5 - ndc.y * 0.5) * uSunMaskViewportPx.y
  );
  vec2 d = px - uSunMaskScreenPx;
  float dPx = length(d);
  float H = max(uSunMaskViewportPx.y, 1.0);
  float dNorm = dPx / (${scaleH} * H);
  float moffat = 1.0 / pow(1.0 + dNorm * dNorm, ${beta});
  float ax = d.y / 1.7;
  float ay = d.x / 1.7;
  float armX = exp(-ax * ax) * exp(-abs(d.x) / max(uSunMaskArmDecayPx, 1.0));
  float armY = exp(-ay * ay) * exp(-abs(d.y) / max(uSunMaskArmDecayYPx, 1.0)) * 0.25;
  float localVeil = uSunMaskPeak * (moffat + uSunMaskArmCoeff * (armX + armY));
  float wideMask = smoothstep(0.01, 0.08, localVeil);
  float coreMask = uSunMaskCoreOuterPx > 0.5
    ? 1.0 - smoothstep(0.45 * uSunMaskCoreOuterPx, uSunMaskCoreOuterPx, dPx)
    : 0.0;
  return max(wideMask, coreMask);
}
`;
}

/** The uniform block the GLSL above declares, as live THREE uniform refs. */
export interface SunGlareMaskUniforms {
  uSunMaskActive: { value: number };
  uSunMaskScreenPx: { value: THREE.Vector2 };
  uSunMaskViewportPx: { value: THREE.Vector2 };
  uSunMaskPeak: { value: number };
  uSunMaskArmCoeff: { value: number };
  uSunMaskArmDecayPx: { value: number };
  uSunMaskArmDecayYPx: { value: number };
  uSunMaskCoreOuterPx: { value: number };
}

/** Fresh, inactive uniform set — spread into a material's uniforms. */
export function createSunGlareMaskUniforms(): SunGlareMaskUniforms {
  return {
    uSunMaskActive: { value: 0 },
    uSunMaskScreenPx: { value: new THREE.Vector2() },
    uSunMaskViewportPx: { value: new THREE.Vector2(1, 1) },
    uSunMaskPeak: { value: 0 },
    uSunMaskArmCoeff: { value: 0 },
    uSunMaskArmDecayPx: { value: 0 },
    uSunMaskArmDecayYPx: { value: 0 },
    uSunMaskCoreOuterPx: { value: 0 },
  };
}

/** Push this frame's params into a consumer's uniform set (zero-alloc). */
export function applySunGlareMaskParams(
  u: SunGlareMaskUniforms,
  p: SunGlareMaskParams,
  viewportWidth: number,
): void {
  u.uSunMaskActive.value = p.active ? 1 : 0;
  u.uSunMaskScreenPx.value.set(p.sunXPx, p.sunYPx);
  u.uSunMaskViewportPx.value.set(viewportWidth, p.viewportHeight);
  u.uSunMaskPeak.value = p.peak;
  u.uSunMaskArmCoeff.value = p.armCoeff;
  u.uSunMaskArmDecayPx.value = p.armDecayPx;
  u.uSunMaskArmDecayYPx.value = p.armDecayYPx;
  u.uSunMaskCoreOuterPx.value = p.coreOuterPx;
}

/**
 * Inject the mask into a stock PointsMaterial (the asteroid belt) via the shared
 * onBeforeCompile pattern: the point projects once, the vertex writes an alpha
 * scale varying, and the fragment multiplies it into the point's alpha. The
 * returned uniform refs are updated per frame by the controller. Byte-identical
 * to the untouched material while the mask is inactive.
 */
export function augmentPointsMaterialWithSunGlareMask(mat: THREE.PointsMaterial): SunGlareMaskUniforms {
  const u = createSunGlareMaskUniforms();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${sunGlareMaskGLSL()}\nvarying float vSunGlareMaskAlpha;`,
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvSunGlareMaskAlpha = 1.0 - 0.98 * sunGlareMask(gl_Position);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSunGlareMaskAlpha;')
      .replace('#include <opaque_fragment>', 'diffuseColor.a *= vSunGlareMaskAlpha;\n\t#include <opaque_fragment>');
  };
  mat.needsUpdate = true;
  return u;
}
