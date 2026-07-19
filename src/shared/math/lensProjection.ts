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
 * Pure math only — no three.js imports — so the shader interpolation sites
 * and the CPU seam share one definition.
 */

const DEG = Math.PI / 180;

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

/** Inverse of lensRadial in theta, by Newton iteration (monotonic, smooth).
 *  Saturates at MAX_THETA for radii beyond the representable range. */
export function lensRadialInverse(r: number, strength: number): number {
  if (r <= 0) return 0;
  if (r >= lensRadial(MAX_THETA, strength)) return MAX_THETA;
  let theta = Math.min(Math.atan(r), MAX_THETA);
  for (let i = 0; i < 8; i++) {
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
  if (strength <= 0) {
    out.x = ndcX;
    out.y = ndcY;
    return out;
  }
  const tanHalfRender = Math.tan((renderFovDeg / 2) * DEG);
  const dx = ndcX * aspect * tanHalfRender;
  const dy = ndcY * tanHalfRender;
  const tanTheta = Math.hypot(dx, dy);
  if (tanTheta < 1e-9) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const theta = Math.atan(tanTheta);
  const rEdge = lensRadial((designFovDeg / 2) * DEG, strength);
  const r = lensRadial(theta, strength) / rEdge;
  const scale = r / tanTheta;
  out.x = (dx * scale) / aspect;
  out.y = dy * scale;
  return out;
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
 * Apply a camera's design FOV: stores it on `userData.lens` and sets the
 * actual render FOV to the overscan the lens warp needs (identity when the
 * lens is off). The ONE way any code should set the planetarium camera's
 * FOV — writing `camera.fov` directly under an active lens would change the
 * displayed framing.
 */
export function applyDesignFov(
  camera: {
    fov: number;
    aspect: number;
    userData: { lens?: { strength: number; designFovDeg: number; effectiveStrength?: number } };
    updateProjectionMatrix: () => void;
  },
  designFovDeg: number,
): void {
  const lens = camera.userData.lens;
  if (lens) {
    lens.designFovDeg = designFovDeg;
    lens.effectiveStrength = lensEffectiveStrength(designFovDeg, camera.aspect, lens.strength);
    camera.fov = lensOverscanFovDeg(designFovDeg, camera.aspect, lens.effectiveStrength);
  } else {
    camera.fov = designFovDeg;
  }
  camera.updateProjectionMatrix();
}

/**
 * GLSL for the lens pass fragment: inverse map per output pixel (Newton on
 * the same radial blend), sampling the rectilinear source. Interpolated into
 * LensPass so the CPU forward map above and the GPU inverse can't drift.
 */
export const lensPassFragmentShader = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStrength;
uniform float uAspect;
uniform float uTanHalfRender;
uniform float uREdge;
varying vec2 vUv;

float lensRadial(float theta) {
  return (1.0 - uStrength) * tan(theta) + uStrength * 2.0 * tan(theta * 0.5);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 d = vec2(ndc.x * uAspect, ndc.y);
  float rOut = length(d) * uREdge;
  if (rOut < 1e-6 || uStrength <= 0.0) {
    gl_FragColor = texture2D(tDiffuse, vUv);
    return;
  }
  // Invert R(theta) by Newton from the rectilinear estimate.
  float theta = atan(rOut);
  for (int i = 0; i < 4; i++) {
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
  gl_FragColor = texture2D(tDiffuse, clamp(srcUv, 0.0, 1.0));
}
`;
