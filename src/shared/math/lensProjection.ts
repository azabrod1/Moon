/**
 * Lens projection for the planetarium: a rectilinear→stereographic blend.
 *
 * A rectilinear (pinhole) projection maps a sphere seen off-axis to an
 * ellipse — the radial direction stretches by 1/cos(θ), ~17% at 30° off-axis
 * with the 60° camera — which is exactly the "planets look oval near the
 * frame edge" bug. Stereographic projection (r = 2·tan(θ/2)) is conformal:
 * it renders every sphere as a circle from any direction, at the price of
 * gently curving long straight lines (invisible in a star field).
 *
 * The blend maps a view angle θ to the radial screen coordinate
 *   R(θ, s) = (1−s)·tan θ + s·2·tan(θ/2)
 * normalized so the DESIGN vertical FOV lands exactly on the frame's top and
 * bottom edges regardless of strength: framing is preserved, only off-axis
 * shapes change. The scene renders rectilinear at a wider OVERSCAN FOV
 * (computed here so the output frame's corners always have source data), and
 * the lens pass resamples it; projectToScreen applies the same forward map so
 * DOM overlays land on the warped pixels.
 *
 * The strength need not be constant in flight. A body that fills the view has
 * its limb far off-axis, where this map compresses hardest — a centred disc's
 * drawn radius has a ceiling of 3.73 frame half-heights at the 60° design —
 * so the planetarium fades the request out as the largest rendered disc grows past a
 * 45° angular radius and back in as it shrinks (lensProximity.ts; the
 * `proximityFactor` on the camera's lens params, folded into
 * `effectiveStrength` by applyDesignFov below, which is why every consumer
 * reads THAT). Dev poses never ramp: the capture fleet pins pixels close in.
 *
 * Pure math only — no three.js imports — so the shader interpolation sites
 * and the CPU seam share one definition. The inverse map's GLSL comes in two
 * forms: `lensSourceUvGlsl`, one scene position per output pixel, and
 * `lensSourceFootprintGlsl`, the same position with its derivative, which the
 * finishing pass places a supersample's taps along (app/FusedOutputPass.ts);
 * `lensSourceFootprint` is that one's CPU twin.
 */

import { DEG2RAD as DEG } from './angles';

/** Default lens strength: full stereographic. Conformal, so every sphere
 *  renders as a true circle from any direction — a 0.7 blend was tried first
 *  and its ~5% residual stretch still read as "not quite round". The cost is
 *  the overscan render (~75° for a 60° display at 16:9, ~0.7× centre
 *  resolution), mostly invisible at retina pixel ratios. */
export const LENS_DEFAULT_STRENGTH = 1;

/** Radial screen coordinate for view angle theta at blend strength s. */
export function lensRadial(theta: number, strength: number): number {
  return (1 - strength) * Math.tan(theta) + strength * 2 * Math.tan(theta / 2);
}

/** A rectilinear source camera degenerates toward 90° half-angle; keep every
 *  solve safely inside it. */
const MAX_THETA = 88 * DEG;

/** Newton iterations for the radial inverse. The CPU seam (lensRadialInverse)
 *  and the GPU fragment (lensPassFragmentShader) MUST share this budget, or the
 *  overlay projection and the rendered pixels drift at the wide-FOV strength cap
 *  (a 4-iter shader vs 8-iter CPU disagreed by ~2° at a 110° design FOV). */
export const LENS_INVERSE_ITERATIONS = 8;

/** Inverse of lensRadial in theta, by Newton iteration (monotonic, smooth).
 *  Saturates at MAX_THETA for radii beyond the representable range. */
export function lensRadialInverse(r: number, strength: number): number {
  if (r <= 0) return 0;
  if (r >= lensRadial(MAX_THETA, strength)) return MAX_THETA;
  let theta = Math.min(Math.atan(r), MAX_THETA);
  for (let i = 0; i < LENS_INVERSE_ITERATIONS; i++) {
    const t = Math.tan(theta);
    const th = Math.tan(theta / 2);
    const f = (1 - strength) * t + strength * 2 * th - r;
    const df = (1 - strength) * (1 + t * t) + strength * (1 + th * th);
    theta = Math.min(Math.max(theta - f / df, 0), MAX_THETA);
    if (Math.abs(f) < 1e-12) break;
  }
  return theta;
}

/** Max off-axis view angle the output frame shows (its corner). */
export function lensCornerTheta(designFovDeg: number, aspect: number, strength: number): number {
  const thetaV = (designFovDeg / 2) * DEG;
  const rEdge = lensRadial(thetaV, strength);
  const rCorner = rEdge * Math.hypot(aspect, 1);
  return lensRadialInverse(rCorner, strength);
}

/**
 * The rectilinear FOV the scene must RENDER at so the warped output frame's
 * corners have source data. Identity (design FOV) at strength 0.
 */
export function lensOverscanFovDeg(designFovDeg: number, aspect: number, strength: number): number {
  if (strength <= 0) return designFovDeg;
  const thetaCorner = lensCornerTheta(designFovDeg, aspect, strength);
  // The source rectilinear frame's own corner must reach thetaCorner; its
  // vertical half-tangent follows from the same corner/edge aspect ratio.
  const tanCorner = Math.tan(thetaCorner);
  const tanHalfV = tanCorner / Math.hypot(aspect, 1);
  return 2 * Math.atan(tanHalfV) / DEG;
}

/** Widest source corner the overscan is allowed to require. Past ~80° a
 *  rectilinear render's corner texels are hopelessly stretched, and at 90°
 *  the projection is degenerate — a very wide DESIGN fov (dev poses can ask
 *  for >100°) simply cannot be fully stereographic from a pinhole source. */
const MAX_SOURCE_CORNER = 80 * DEG;

/**
 * The strength the lens can actually honour at this design FOV/aspect: the
 * requested strength, reduced (to zero if need be) until the overscan corner
 * fits inside MAX_SOURCE_CORNER. Everything that consumes the lens — the
 * overscan, the pass uniforms, the projectToScreen warp, display metering —
 * must use THIS, never the raw request, or the seams disagree.
 */
export function lensEffectiveStrength(designFovDeg: number, aspect: number, strength: number): number {
  if (strength <= 0) return 0;
  const clamped = Math.min(strength, 1);
  if (lensCornerTheta(designFovDeg, aspect, clamped) <= MAX_SOURCE_CORNER) return clamped;
  let lo = 0;
  let hi = clamped;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (lensCornerTheta(designFovDeg, aspect, mid) <= MAX_SOURCE_CORNER) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Precomputed constants of the forward warp. Everything in `lensWarpNdc` that
 * depends only on the camera — not on the point being warped — lives here, so
 * hot loops (32 rim rays per sphere, every labelled body, every frame) hoist
 * the two `tan`s and the edge normalization instead of re-deriving them per
 * point. Build with `makeLensWarpContext`; a context is valid for as long as
 * the camera's FOVs/aspect/strength are — one frame, in practice.
 */
export interface LensWarpContext {
  tanHalfRender: number;
  aspect: number;
  strength: number;
  rEdge: number;
}

export function makeLensWarpContext(
  designFovDeg: number,
  renderFovDeg: number,
  aspect: number,
  strength: number,
  out: LensWarpContext,
): LensWarpContext {
  out.aspect = aspect;
  out.strength = strength;
  if (strength <= 0) {
    out.tanHalfRender = 0;
    out.rEdge = 1;
    return out;
  }
  out.tanHalfRender = Math.tan((renderFovDeg / 2) * DEG);
  out.rEdge = lensRadial((designFovDeg / 2) * DEG, strength);
  return out;
}

/** Point half of the forward map: same math as `lensWarpNdc`, constants from
 *  the context. The two must stay value-identical — `lensWarpNdc` delegates
 *  here so there is exactly one definition. */
export function lensWarpNdcWithContext(
  ctx: LensWarpContext,
  ndcX: number,
  ndcY: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  if (ctx.strength <= 0) {
    out.x = ndcX;
    out.y = ndcY;
    return out;
  }
  const dx = ndcX * ctx.aspect * ctx.tanHalfRender;
  const dy = ndcY * ctx.tanHalfRender;
  const tanTheta = Math.hypot(dx, dy);
  if (tanTheta < 1e-9) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const theta = Math.atan(tanTheta);
  const r = lensRadial(theta, ctx.strength) / ctx.rEdge;
  const scale = r / tanTheta;
  out.x = (dx * scale) / ctx.aspect;
  out.y = dy * scale;
  return out;
}

const warpCtxScratch: LensWarpContext = { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 };

/**
 * Forward map: rectilinear NDC under the (overscanned) render camera → output
 * NDC after the lens pass. Identity at strength 0. Used by projectToScreen so
 * DOM overlays match the warped image.
 */
export function lensWarpNdc(
  ndcX: number,
  ndcY: number,
  designFovDeg: number,
  renderFovDeg: number,
  aspect: number,
  strength: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  makeLensWarpContext(designFovDeg, renderFovDeg, aspect, strength, warpCtxScratch);
  return lensWarpNdcWithContext(warpCtxScratch, ndcX, ndcY, out);
}

/**
 * Inverse map: output NDC (what the viewer sees after the lens pass) → the
 * rectilinear NDC under the overscanned render camera that lands there. Exact
 * inverse of `lensWarpNdc`; identity at strength 0. Use it to aim a camera ray
 * at, or read a world position under, a chosen ON-SCREEN point (QA framing,
 * pointer picking) — a raw rectilinear projection would miss by the local lens
 * magnification.
 */
export function lensUnwarpNdc(
  ndcX: number,
  ndcY: number,
  designFovDeg: number,
  renderFovDeg: number,
  aspect: number,
  strength: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  makeLensWarpContext(designFovDeg, renderFovDeg, aspect, strength, warpCtxScratch);
  return lensUnwarpNdcWithContext(warpCtxScratch, ndcX, ndcY, out);
}

/** Point half of the inverse map, constants from the context: the one
 *  definition `lensUnwarpNdc` delegates to. */
export function lensUnwarpNdcWithContext(
  ctx: LensWarpContext,
  ndcX: number,
  ndcY: number,
  out: { x: number; y: number },
): { x: number; y: number } {
  if (ctx.strength <= 0) {
    out.x = ndcX;
    out.y = ndcY;
    return out;
  }
  const dx = ndcX * ctx.aspect;
  const dy = ndcY;
  const mOut = Math.hypot(dx, dy);
  if (mOut < 1e-9) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const theta = lensRadialInverse(mOut * ctx.rEdge, ctx.strength);
  const k = Math.tan(theta) / (mOut * ctx.tanHalfRender);
  out.x = (dx * k) / ctx.aspect;
  out.y = dy * k;
  return out;
}

/** How the lens scales the picture at one view angle, as multiples of its
 *  scale on the axis: radially (along the direction away from the frame
 *  centre) and tangentially (across it). Both are 1 on the axis; at strength
 *  1 they stay equal (the map is conformal) and the picture is simply
 *  magnified off-axis, at strength 0 they are 1/cos²θ and 1/cosθ. The scale
 *  on the axis is `(height / 2) / lensDisplayHalfTan` output px per radian,
 *  so these two times that number convert a small angle at any point of the
 *  frame into output pixels. */
export interface LensLocalScale {
  radial: number;
  tangential: number;
}

export function lensLocalScale(theta: number, strength: number, out: LensLocalScale): LensLocalScale {
  if (!(theta > 1e-9)) {
    out.radial = 1;
    out.tangential = 1;
    return out;
  }
  out.radial = (1 - strength) / Math.cos(theta) ** 2 + strength / Math.cos(theta / 2) ** 2;
  out.tangential = lensRadial(theta, strength) / Math.sin(theta);
  return out;
}

/** An axis-aligned rectangle in NDC (output or source), inclusive. */
export interface NdcRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boundSampleScratch = { x: 0, y: 0 };

/**
 * The rectilinear-source rectangle that covers every output pixel of an
 * output-space rectangle, after clipping it to the displayed frame.
 *
 * A screen-authored primitive that is too large to pre-distort corner by
 * corner (the Sun's glare: a frame-sized wash) draws a source-space quad
 * only to COVER the pixels its fragment then measures in output space. This
 * is that quad. Clipping first is what makes it representable: the overscan
 * is sized so the displayed frame's corners have source data, so the
 * pre-image of anything inside the frame lies inside the source square, and
 * a support reaching past the frame edge wants no pixels there anyway.
 *
 * The bound is exact, not sampled. The inverse map is radial about the frame
 * centre and its radial factor grows with the output radius, so along an
 * edge of fixed x the source x is monotone in |y|: the extremes of the
 * pre-image sit at the rectangle's four corners or at the point of each edge
 * nearest the frame centre. Those eight points, unwarped, bound it; the
 * margin (in source NDC, one texel each way plus float fringe) is added after.
 * Returns false when the clipped rectangle is empty (nothing to draw). Any
 * non-finite input or result falls back to the whole source frame, which the
 * clipping argument above makes always sufficient.
 */
export function lensSourceBoundOfOutputRect(
  ctx: LensWarpContext,
  rect: NdcRect,
  marginX: number,
  marginY: number,
  out: NdcRect,
): boolean {
  const minX = Math.max(rect.minX, -1);
  const maxX = Math.min(rect.maxX, 1);
  const minY = Math.max(rect.minY, -1);
  const maxY = Math.min(rect.maxY, 1);
  if (!(maxX > minX && maxY > minY)) {
    if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
      return false;
    }
    out.minX = -1;
    out.minY = -1;
    out.maxX = 1;
    out.maxY = 1;
    return true;
  }
  // The point of each edge nearest the frame centre, clamped onto the edge.
  const nearX = Math.min(Math.max(0, minX), maxX);
  const nearY = Math.min(Math.max(0, minY), maxY);
  let sMinX = Infinity;
  let sMaxX = -Infinity;
  let sMinY = Infinity;
  let sMaxY = -Infinity;
  const sample = (x: number, y: number) => {
    const p = lensUnwarpNdcWithContext(ctx, x, y, boundSampleScratch);
    sMinX = Math.min(sMinX, p.x);
    sMaxX = Math.max(sMaxX, p.x);
    sMinY = Math.min(sMinY, p.y);
    sMaxY = Math.max(sMaxY, p.y);
  };
  sample(minX, minY);
  sample(maxX, minY);
  sample(minX, maxY);
  sample(maxX, maxY);
  sample(minX, nearY);
  sample(maxX, nearY);
  sample(nearX, minY);
  sample(nearX, maxY);
  if (!(Number.isFinite(sMinX) && Number.isFinite(sMaxX) && Number.isFinite(sMinY) && Number.isFinite(sMaxY))) {
    out.minX = -1;
    out.minY = -1;
    out.maxX = 1;
    out.maxY = 1;
    return true;
  }
  out.minX = sMinX - marginX;
  out.maxX = sMaxX + marginX;
  out.minY = sMinY - marginY;
  out.maxY = sMaxY + marginY;
  return true;
}

/**
 * Half-tangent of the DISPLAYED frame in the vertical direction — the number
 * that converts a small central angular radius into an on-screen NDC radius
 * under the lens (reduces to tan(fov/2) at strength 0). Metering that used
 * `tan(camera.fov / 2)` must use this instead: camera.fov is the overscan.
 */
export function lensDisplayHalfTan(designFovDeg: number, strength: number): number {
  return lensRadial((designFovDeg / 2) * DEG, strength);
}

/**
 * The largest local screen scale anywhere in the DISPLAYED frame, as a
 * multiple of its scale at the centre. The blend stretches steadily outward
 * from the axis — radially by dR/dtheta, tangentially by R(theta)/sin theta —
 * so the extreme sits at the frame's corner. Multiply the centre scale
 * ((height/2) / lensDisplayHalfTan, in pixels per radian) by this for a bound
 * that holds wherever in the frame a feature lands.
 */
export function lensMaxFrameScale(designFovDeg: number, aspect: number, strength: number): number {
  const theta = lensCornerTheta(designFovDeg, aspect, strength);
  if (!(theta > 0)) return 1;
  const radial = (1 - strength) / Math.cos(theta) ** 2 + strength / Math.cos(theta / 2) ** 2;
  const tangential = lensRadial(theta, strength) / Math.sin(theta);
  return Math.max(radial, tangential, 1);
}

/**
 * Apply a camera's design FOV: stores it on `userData.lens` and sets the
 * actual render FOV to the overscan the lens warp needs (identity when the
 * lens is off). The ONE way any code should set the planetarium camera's
 * FOV — writing `camera.fov` directly under an active lens would change the
 * displayed framing. Also the one place the proximity ramp's factor meets
 * the requested strength: the product goes through the wide-FOV cap into
 * `effectiveStrength`, so a body filling the view and a design FOV the
 * source cannot feed are read by every consumer through the same number.
 */
export function applyDesignFov(
  camera: {
    fov: number;
    aspect: number;
    userData: {
      lens?: { strength: number; designFovDeg: number; effectiveStrength?: number; proximityFactor?: number };
    };
    updateProjectionMatrix: () => void;
  },
  designFovDeg: number,
): void {
  const lens = camera.userData.lens;
  if (lens) {
    lens.designFovDeg = designFovDeg;
    const requestedStrength = lens.strength * (lens.proximityFactor ?? 1);
    lens.effectiveStrength = lensEffectiveStrength(designFovDeg, camera.aspect, requestedStrength);
    camera.fov = lensOverscanFovDeg(designFovDeg, camera.aspect, lens.effectiveStrength);
  } else {
    camera.fov = designFovDeg;
  }
  camera.updateProjectionMatrix();
}

/**
 * The FOV the frame actually displays — the read that pairs with
 * applyDesignFov. Under an active lens `camera.fov` holds the wider overscan
 * the warp samples from, so no caller should compare against it; without a
 * lens the two are the same number.
 */
export function displayFovDeg(camera: {
  fov: number;
  userData: { lens?: { designFovDeg: number } };
}): number {
  return camera.userData.lens?.designFovDeg ?? camera.fov;
}

/**
 * GLSL for the inverse map: one output pixel's position → the texel of the
 * rectilinear scene image that lands there (Newton on the same radial blend).
 * Interpolated into every shader that reads a scene image through the lens, so
 * the CPU forward map above and the GPU inverse can't drift, and neither can
 * the readers drift from each other: the lens pass on the no-float path, the
 * bloom bright pass and the finishing pass all sample through this one
 * function.
 *
 * It declares ONLY the four warp uniforms. `uUvScale`/`uUvMax` — the
 * sub-rectangle of the allocation the frame was drawn into
 * (app/sceneSubRect.ts) — are declared by whoever composes this text, exactly
 * once: the lens pass's own text below, or the insertion app/sceneSubRect.ts
 * makes into three's shaders. A second declaration would not compile, and a
 * string check cannot see that.
 */
export const lensSourceUvGlsl = /* glsl */ `
uniform float uStrength;
uniform float uAspect;
uniform float uTanHalfRender;
uniform float uREdge;

float lensRadial(float theta) {
  return (1.0 - uStrength) * tan(theta) + uStrength * 2.0 * tan(theta * 0.5);
}

vec2 lensSourceUv(vec2 vUv) {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 d = vec2(ndc.x * uAspect, ndc.y);
  float rOut = length(d) * uREdge;
  // The optical centre, and a strength of zero: the plain scaled read, which
  // is what the frame is when nothing is warping it.
  if (rOut < 1e-6 || uStrength <= 0.0) return min(vUv * uUvScale, uUvMax);
  // Invert R(theta) by Newton from the rectilinear estimate. Same iteration
  // budget as the CPU seam (LENS_INVERSE_ITERATIONS) so overlay and pixels agree.
  float theta = atan(rOut);
  for (int i = 0; i < ${LENS_INVERSE_ITERATIONS}; i++) {
    float t = tan(theta);
    float th = tan(theta * 0.5);
    float f = (1.0 - uStrength) * t + uStrength * 2.0 * th - rOut;
    float df = (1.0 - uStrength) * (1.0 + t * t) + uStrength * (1.0 + th * th);
    theta -= f / df;
  }
  float srcRadius = tan(theta) / uTanHalfRender;
  vec2 srcNdc = normalize(d) * srcRadius;
  vec2 srcUv = vec2(srcNdc.x / uAspect, srcNdc.y) * 0.5 + 0.5;
  // By construction the overscan covers the frame; clamp guards float fringe.
  return clamp(srcUv * uUvScale, vec2(0.0), uUvMax);
}
`;

/**
 * Where one output pixel lands in the scene image, and how that point moves
 * as the pixel does: the same inverse map, before the sub-rectangle clamp, with
 * its derivative. Used by the finishing pass when it averages a scene drawn
 * larger than the canvas down onto it (app/FusedOutputPass.ts): the warp is
 * solved once, at the pixel's centre, and every tap of the pixel's footprint is
 * placed along this derivative from there.
 *
 * Unclamped on purpose. A position clamped to the sub-rect stops moving at the
 * clamp, so a derivative taken through the clamp would flatten the footprint
 * of every pixel near the edge; each tap is clamped instead, once it is placed.
 *
 * The derivative is worked out rather than read off `dFdx`: the finishing text
 * is three's output shader, GLSL ES 1.00, where the derivative functions are
 * not part of the language, and a difference across the 2×2 quad would sample
 * the map half a pixel away from the centre in alternate quads besides. The map
 * is radial: a point at distance ρ from the optical centre (in frame
 * half-heights) goes to distance h(ρ) = tan θ / tan(half render FOV) on the
 * same ray, θ the angle the blend puts at ρ·rEdge. Its derivative along a step
 * v is g·v + (h′ − g)(d̂·v)d̂ with g = h/ρ, and h′ = sec²θ · rEdge /
 * (R′(θ) · tan(half render FOV)) by the inverse function rule, R′ the same
 * derivative the Newton steps use. At the centre both g and h′ are
 * rEdge / tan(half render FOV), the map's scale on the axis.
 *
 * `outputSize` is the canvas in pixels; `dUdx`/`dUdy` come back as the
 * scene-uv step per output pixel along x and y. Declares nothing: it reads the
 * four warp uniforms `lensSourceUvGlsl` declares and the sub-rect pair, so it
 * goes in after them.
 */
export const lensSourceFootprintGlsl = /* glsl */ `
vec2 lensSourceFootprint(vec2 vUv, vec2 outputSize, out vec2 dUdx, out vec2 dUdy) {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 d = vec2(ndc.x * uAspect, ndc.y);
  float rho = length(d);
  float rOut = rho * uREdge;
  if (uStrength <= 0.0) {
    dUdx = vec2(uUvScale.x / outputSize.x, 0.0);
    dUdy = vec2(0.0, uUvScale.y / outputSize.y);
    return vUv * uUvScale;
  }
  // One output pixel, as a step of d.
  vec2 stepX = vec2(2.0 * uAspect / outputSize.x, 0.0);
  vec2 stepY = vec2(0.0, 2.0 / outputSize.y);
  // From a step of the source's d to a step of scene uv.
  vec2 toUv = vec2(0.5 / uAspect, 0.5) * uUvScale;
  if (rOut < 1e-6) {
    // The optical centre: the map is its scale on the axis there.
    float g0 = uREdge / uTanHalfRender;
    dUdx = g0 * stepX * toUv;
    dUdy = g0 * stepY * toUv;
    return vUv * uUvScale;
  }
  // The same Newton solve as lensSourceUv, step for step.
  float theta = atan(rOut);
  for (int i = 0; i < ${LENS_INVERSE_ITERATIONS}; i++) {
    float t = tan(theta);
    float th = tan(theta * 0.5);
    float f = (1.0 - uStrength) * t + uStrength * 2.0 * th - rOut;
    float df = (1.0 - uStrength) * (1.0 + t * t) + uStrength * (1.0 + th * th);
    theta -= f / df;
  }
  float tanTheta = tan(theta);
  float tanHalf = tan(theta * 0.5);
  float srcRadius = tanTheta / uTanHalfRender;
  vec2 dir = d / rho;
  float g = srcRadius / rho;
  float dRdTheta = (1.0 - uStrength) * (1.0 + tanTheta * tanTheta) + uStrength * (1.0 + tanHalf * tanHalf);
  float gRadial = (1.0 + tanTheta * tanTheta) * uREdge / (dRdTheta * uTanHalfRender);
  dUdx = (g * stepX + (gRadial - g) * dot(dir, stepX) * dir) * toUv;
  dUdy = (g * stepY + (gRadial - g) * dot(dir, stepY) * dir) * toUv;
  vec2 srcNdc = normalize(d) * srcRadius;
  vec2 srcUv = vec2(srcNdc.x / uAspect, srcNdc.y) * 0.5 + 0.5;
  return srcUv * uUvScale;
}
`;

/** The CPU twin of `lensSourceFootprintGlsl`, line for line, for the tests
 *  that hold its derivative to a finite difference of the inverse map and
 *  its taps to the downsample's texel centres. `uvScale` is the sub-rect's
 *  scale (1 where the frame fills its allocation). */
export interface LensFootprint {
  /** The scene uv under the pixel's centre, before the sub-rect clamp. */
  x: number;
  y: number;
  /** Scene uv per output pixel along x, and along y. */
  dUdx: [number, number];
  dUdy: [number, number];
}

export function lensSourceFootprint(
  ctx: LensWarpContext,
  uvScale: { x: number; y: number },
  u: number,
  v: number,
  outputWidth: number,
  outputHeight: number,
): LensFootprint {
  const ndcX = u * 2 - 1;
  const ndcY = v * 2 - 1;
  const dx = ndcX * ctx.aspect;
  const dy = ndcY;
  const rho = Math.hypot(dx, dy);
  const rOut = rho * ctx.rEdge;
  if (ctx.strength <= 0) {
    return {
      x: u * uvScale.x,
      y: v * uvScale.y,
      dUdx: [uvScale.x / outputWidth, 0],
      dUdy: [0, uvScale.y / outputHeight],
    };
  }
  const stepX = (2 * ctx.aspect) / outputWidth;
  const stepY = 2 / outputHeight;
  const toUvX = (0.5 / ctx.aspect) * uvScale.x;
  const toUvY = 0.5 * uvScale.y;
  if (rOut < 1e-6) {
    const g0 = ctx.rEdge / ctx.tanHalfRender;
    return { x: u * uvScale.x, y: v * uvScale.y, dUdx: [g0 * stepX * toUvX, 0], dUdy: [0, g0 * stepY * toUvY] };
  }
  let theta = Math.atan(rOut);
  for (let i = 0; i < LENS_INVERSE_ITERATIONS; i++) {
    const t = Math.tan(theta);
    const th = Math.tan(theta * 0.5);
    const f = (1 - ctx.strength) * t + ctx.strength * 2 * th - rOut;
    const df = (1 - ctx.strength) * (1 + t * t) + ctx.strength * (1 + th * th);
    theta -= f / df;
  }
  const tanTheta = Math.tan(theta);
  const tanHalf = Math.tan(theta * 0.5);
  const srcRadius = tanTheta / ctx.tanHalfRender;
  const dirX = dx / rho;
  const dirY = dy / rho;
  const g = srcRadius / rho;
  const dRdTheta = (1 - ctx.strength) * (1 + tanTheta * tanTheta) + ctx.strength * (1 + tanHalf * tanHalf);
  const gRadial = ((1 + tanTheta * tanTheta) * ctx.rEdge) / (dRdTheta * ctx.tanHalfRender);
  // Along x the step is (stepX, 0), along y (0, stepY).
  const kx = (gRadial - g) * dirX * stepX;
  const ky = (gRadial - g) * dirY * stepY;
  return {
    x: ((dirX * srcRadius) / ctx.aspect * 0.5 + 0.5) * uvScale.x,
    y: (dirY * srcRadius * 0.5 + 0.5) * uvScale.y,
    dUdx: [(g * stepX + kx * dirX) * toUvX, kx * dirY * toUvY],
    dUdy: [ky * dirX * toUvX, (g * stepY + ky * dirY) * toUvY],
  };
}

/**
 * The lens pass fragment: the shared inverse map, one sample per output pixel.
 * The pass itself survives for the no-float direct path (where it resamples
 * tone-mapped bytes) and for the `?fused=0` composer chain.
 */
export const lensPassFragmentShader = /* glsl */ `
uniform sampler2D tDiffuse;
// The source may be a sub-rectangle of a larger allocation (app/sceneSubRect.ts):
// every read is scaled into it and stopped half a texel short of its far edge,
// so no bilinear tap reaches the region outside it. Both are 1 where the frame
// fills its target, and the scaled read is then the same texel.
uniform vec2 uUvScale;
uniform vec2 uUvMax;
varying vec2 vUv;
${lensSourceUvGlsl}
void main() {
  gl_FragColor = texture2D(tDiffuse, lensSourceUv(vUv));
  // Opaque, whatever the scene texel's alpha carries (app/outputDither.ts
  // OUTPUT_OPAQUE_WRITE says why): this is a canvas write on the no-composer route.
  gl_FragColor.a = 1.0;
}
`;
