/**
 * GPU precompute of the atmosphere scattering tables (Bruneton's pass
 * structure: transmittance → direct irradiance → single scattering → for each
 * further order, scattering density → indirect irradiance → multiple
 * scattering), and the tier gate that decides whether the tables may be used at
 * all. Nothing in the app draws with them yet.
 *
 * WebGL2 only, and the details below are not stylistic — each one has a silent
 * failure behind it:
 *
 *  - **One output per target, never MRT into a 3D target.** `WebGL3DRenderTarget`
 *    replaces only `textures[0]` with a `Data3DTexture`; with `count > 1` the
 *    rest stay 2D, and `setRenderTarget` calls `framebufferTextureLayer` over
 *    every attachment — which is `INVALID_OPERATION` on a 2D texture. three
 *    never checks framebuffer status, so the symptom is a black table.
 *
 *  - **`magFilter` must be passed explicitly.** A render target only copies the
 *    filter options the caller supplies, and `Data3DTexture` constructs with
 *    NearestFilter on both — the default is a point-sampled LUT, which is 32
 *    hard bands stepping across the limb.
 *
 *  - **No depth, no stencil, no multisampling.** A depth renderbuffer is
 *    allocated per target, and `samples > 0` routes `setRenderTarget` into the
 *    multisample framebuffer BEFORE the 3D branch, so the layer attach lands on
 *    the wrong framebuffer.
 *
 *  - **Validation reads back through an 8-bit blit**, never a half-float
 *    `readRenderTargetPixels`: that call ignores its layer argument for a 3D
 *    target, and its readability gate can refuse a perfectly healthy device.
 *    Fail-closed — anything non-finite, or zero where the reference says it must
 *    not be, marks the tier unavailable for the session.
 *
 * Cost and scheduling. Every 3D pass is one draw per layer (WebGL2 has no
 * layered rendering), so a four-order bake is a few hundred draws and the
 * scattering-density pass alone is ~10⁹ dependent fetches. That is far too much
 * to put behind the load screen, so the bake runs in the boot idle, in slices of
 * a few layer draws per frame, with the analytic shell carrying the look
 * meanwhile — the tier switches on only once every table is written and
 * validated, never by waiting. Scratch targets are disposed between bodies, and
 * the multiple-scattering delta deliberately aliases the single-Rayleigh delta:
 * the order-2 density pass reads Rayleigh and Mie, every later one reads only
 * the multiple-scattering delta, so they never need to be live at once, and the
 * peak drops from five 3D targets to four.
 *
 * A lost context invalidates every render-target texture with no CPU backing:
 * the tables go with it, the tier drops, and the restore re-bakes every body
 * this session has ASKED for — not every body that had finished, which is empty
 * during the first bake and would lose the tier for the rest of the session.
 * Three bakes in a row that produce nothing end the retrying.
 */
import * as THREE from 'three';
import { debugLog, debugWarn } from '../../shared/debug';
import { canGPUDoAtmosphereLut } from '../../app/gpuCapability';
import {
  ATMOSPHERE_SPECS,
  ATMOSPHERE_TABLE_SIZES_FULL,
  ATMOSPHERE_TABLE_SIZES_HALF,
  atmosphereParams,
  bodySolarIrradianceScale,
  computeSingleScattering,
  opticalDepthToTopBoundary,
  scatteringTexture3DCoords,
  scatteringTextureWidth,
  scatteringUvwzFromRMuMuSNu,
  transmittanceUvFromRMu,
  type AtmosphereParams,
  type AtmosphereTableSizes,
  type RGB,
} from './atmosphereModel';

export type AtmosphereLutState = 'unavailable' | 'baking' | 'ready';

export interface AtmosphereTables {
  readonly body: string;
  readonly params: AtmosphereParams;
  readonly sizes: AtmosphereTableSizes;
  /** Multiplies the table's unit-irradiance radiance back up to the body's
   *  place in the scene's authored light falloff. */
  readonly solarIrradianceScale: number;
  readonly transmittance: THREE.Texture;
  readonly scattering: THREE.Texture;
  readonly irradiance: THREE.Texture;
}

export interface AtmosphereBakeStats {
  body: string;
  /** Wall time from the first draw to validation, including the frames the
   *  slicing yielded to. */
  wallMs: number;
  /** Time actually spent submitting draws, summed over the slices. */
  submitMs: number;
  drawCalls: number;
  programsBefore: number;
  programsAfter: number;
  peakBytes: number;
  residentBytes: number;
  orders: number;
  validated: boolean;
  /** True when the bake was abandoned for a reason it could see: the context
   *  already reported lost, or the instance disposed. A context that dies
   *  mid-draw usually throws out of the draw before the event lands, and that
   *  row simply reads `validated: false`. Either way the attempt is recorded,
   *  so a lost context during the first bake is not invisible. */
  aborted: boolean;
  slices: number;
}

export interface AtmosphereLutOptions {
  /** Touch-first devices bake half-size tables at two orders. */
  touch?: boolean;
  orders?: number;
  sizes?: AtmosphereTableSizes;
  /** Layer draws submitted per frame. `Infinity` bakes in one block, which is
   *  what a measurement harness wants and a boot never does. */
  drawsPerSlice?: number;
  /** False for a measurement instance, so it does not become the tier the rest
   *  of the app reads. */
  register?: boolean;
}

/** Scattering orders: four is where the twilight glow stops changing; two is
 *  most of it for a quarter of the work, which is the touch budget. */
const DESKTOP_ORDERS = 4;
const TOUCH_ORDERS = 2;
const DEFAULT_DRAWS_PER_SLICE = 8;
/** Bakes in a row that produce no tables — a failed validation, a throw, or a
 *  context lost mid-flight — after which the session stops trying. Each retry
 *  costs a few hundred draws and 32 MiB of scratch on a device that has already
 *  shown it cannot hold them, and the analytic shell is a complete look. */
const MAX_CONSECUTIVE_BAKE_FAILURES = 3;
/** Submission budget per slice. Submission is not execution, so the draw count
 *  is the real limiter; this only stops a slice running long on a slow driver. */
const SLICE_SUBMIT_BUDGET_MS = 6;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const BAKE_VERTEX = /* glsl */`
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Everything the passes share: the parameters, the geometry, the table
 *  addressing and the integrals. Transcribed from Bruneton's reference model
 *  and kept in step with atmosphereModel.ts, which is what the CPU comparison
 *  checks. */
const BAKE_COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

#define PI 3.141592653589793

// The bake is normalised: one unit of solar irradiance. The render multiplies
// the body's own scale back in, using the scene's authored light falloff.
const vec3 SOLAR_IRRADIANCE = vec3(1.0);

uniform float uBottomRadius;
uniform float uTopRadius;
uniform vec3 uRayleighScattering;
uniform vec3 uMieScattering;
uniform vec3 uMieExtinction;
uniform vec3 uAbsorptionExtinction;
// Two layers per profile, in the order rayleigh, mie, absorption:
// (expTerm, expScale, linearTerm, constantTerm).
uniform vec4 uDensityLayers[6];
uniform vec3 uDensityWidths;
uniform float uMiePhaseG;
uniform float uGroundAlbedo;
uniform float uMuSMin;
uniform float uSunAngularRadius;
uniform float uLayer;

float clampCosine(float mu) { return clamp(mu, -1.0, 1.0); }
float clampDistance(float d) { return max(d, 0.0); }
float clampRadius(float r) { return clamp(r, uBottomRadius, uTopRadius); }
float safeSqrt(float a) { return sqrt(max(a, 0.0)); }

float layerDensity(vec4 l, float altitude) {
  return clamp(l.x * exp(l.y * altitude) + l.z * altitude + l.w, 0.0, 1.0);
}

float profileDensity(int profile, float altitude) {
  vec4 l0 = uDensityLayers[0];
  vec4 l1 = uDensityLayers[1];
  float w = uDensityWidths.x;
  if (profile == 1) { l0 = uDensityLayers[2]; l1 = uDensityLayers[3]; w = uDensityWidths.y; }
  else if (profile == 2) { l0 = uDensityLayers[4]; l1 = uDensityLayers[5]; w = uDensityWidths.z; }
  return altitude < w ? layerDensity(l0, altitude) : layerDensity(l1, altitude);
}

float distanceToTopAtmosphereBoundary(float r, float mu) {
  float discriminant = r * r * (mu * mu - 1.0) + uTopRadius * uTopRadius;
  return clampDistance(-r * mu + safeSqrt(discriminant));
}

float distanceToBottomAtmosphereBoundary(float r, float mu) {
  float discriminant = r * r * (mu * mu - 1.0) + uBottomRadius * uBottomRadius;
  return clampDistance(-r * mu - safeSqrt(discriminant));
}

bool rayIntersectsGround(float r, float mu) {
  return mu < 0.0 && r * r * (mu * mu - 1.0) + uBottomRadius * uBottomRadius >= 0.0;
}

float distanceToNearestAtmosphereBoundary(float r, float mu, bool hitsGround) {
  return hitsGround ? distanceToBottomAtmosphereBoundary(r, mu)
                    : distanceToTopAtmosphereBoundary(r, mu);
}

float getTextureCoordFromUnitRange(float x, int size) {
  return 0.5 / float(size) + x * (1.0 - 1.0 / float(size));
}

float getUnitRangeFromTextureCoord(float u, int size) {
  return (u - 0.5 / float(size)) / (1.0 - 1.0 / float(size));
}

// --- transmittance ---------------------------------------------------------

float computeOpticalLengthToTopAtmosphereBoundary(int profile, float r, float mu) {
  const int SAMPLE_COUNT = 500;
  float dx = distanceToTopAtmosphereBoundary(r, mu) / float(SAMPLE_COUNT);
  float result = 0.0;
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    float d_i = float(i) * dx;
    float r_i = safeSqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r);
    float y_i = profileDensity(profile, r_i - uBottomRadius);
    float w_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
    result += y_i * w_i * dx;
  }
  return result;
}

// The table stores OPTICAL DEPTH, not transmittance. On a horizon path the
// transmittance is ~1e-6 — a half-float subnormal that GPUs flush to zero — and
// the segment transmittance below is a quotient of two of them, so the zero
// arrives as an infinity or a NaN and speckles the horizon and the terminator,
// the two features these tables exist to draw. Optical depth spans 0..~22
// (measured max in Earth's table: 21.7, blue, a horizon path at the ground),
// where half precision has room, and the segment becomes a difference.
vec3 computeOpticalDepthToTopAtmosphereBoundary(float r, float mu) {
  return uRayleighScattering * computeOpticalLengthToTopAtmosphereBoundary(0, r, mu) +
      uMieExtinction * computeOpticalLengthToTopAtmosphereBoundary(1, r, mu) +
      uAbsorptionExtinction * computeOpticalLengthToTopAtmosphereBoundary(2, r, mu);
}

vec2 getTransmittanceTextureUvFromRMu(float r, float mu) {
  float H = safeSqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = safeSqrt(r * r - uBottomRadius * uBottomRadius);
  float d = distanceToTopAtmosphereBoundary(r, mu);
  float d_min = uTopRadius - r;
  float d_max = rho + H;
  float x_mu = (d - d_min) / (d_max - d_min);
  float x_r = rho / H;
  return vec2(getTextureCoordFromUnitRange(x_mu, TRANSMITTANCE_TEXTURE_WIDTH),
              getTextureCoordFromUnitRange(x_r, TRANSMITTANCE_TEXTURE_HEIGHT));
}

void getRMuFromTransmittanceTextureUv(vec2 uv, out float r, out float mu) {
  float x_mu = getUnitRangeFromTextureCoord(uv.x, TRANSMITTANCE_TEXTURE_WIDTH);
  float x_r = getUnitRangeFromTextureCoord(uv.y, TRANSMITTANCE_TEXTURE_HEIGHT);
  float H = safeSqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = H * x_r;
  r = safeSqrt(rho * rho + uBottomRadius * uBottomRadius);
  float d_min = uTopRadius - r;
  float d_max = rho + H;
  float d = d_min + x_mu * (d_max - d_min);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clampCosine(mu);
}

vec3 getOpticalDepthToTopAtmosphereBoundary(sampler2D tex, float r, float mu) {
  return texture(tex, getTransmittanceTextureUvFromRMu(r, mu)).rgb;
}

vec3 getTransmittanceToTopAtmosphereBoundary(sampler2D tex, float r, float mu) {
  return exp(-getOpticalDepthToTopAtmosphereBoundary(tex, r, mu));
}

vec3 getTransmittance(sampler2D tex, float r, float mu, float d, bool hitsGround) {
  float r_d = clampRadius(safeSqrt(d * d + 2.0 * r * mu * d + r * r));
  float mu_d = clampCosine((r * mu + d) / r_d);
  // The segment's optical depth is the difference of the two paths to the top,
  // never the quotient of their transmittances. min() only guards interpolation
  // pushing the difference the wrong side of zero.
  vec3 tau_near = getOpticalDepthToTopAtmosphereBoundary(tex, r, hitsGround ? -mu : mu);
  vec3 tau_far = getOpticalDepthToTopAtmosphereBoundary(tex, r_d, hitsGround ? -mu_d : mu_d);
  return min(exp(hitsGround ? tau_near - tau_far : tau_far - tau_near), vec3(1.0));
}

vec3 getTransmittanceToSun(sampler2D tex, float r, float mu_s) {
  float sin_theta_h = uBottomRadius / r;
  float cos_theta_h = -safeSqrt(1.0 - sin_theta_h * sin_theta_h);
  return getTransmittanceToTopAtmosphereBoundary(tex, r, mu_s) *
      smoothstep(-sin_theta_h * uSunAngularRadius,
                 sin_theta_h * uSunAngularRadius,
                 mu_s - cos_theta_h);
}

// --- phase functions -------------------------------------------------------

float rayleighPhaseFunction(float nu) {
  return (3.0 / (16.0 * PI)) * (1.0 + nu * nu);
}

float miePhaseFunction(float g, float nu) {
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

// The accumulator stores Rayleigh in rgb and only the RED Mie channel in alpha;
// the other two are recovered by assuming Mie and Rayleigh have the same
// spectral shape along the path. The division by the red Rayleigh channel goes
// to zero exactly where the difference form lives — the limb and the far side
// of the terminator — so a non-positive red returns no Mie at all rather than
// coloured speckle there.
vec3 getExtrapolatedSingleMieScattering(vec4 scattering) {
  if (scattering.r <= 0.0) return vec3(0.0);
  return scattering.rgb * (scattering.a / scattering.r)
      * (uRayleighScattering.r / uMieScattering.r)
      * (uMieScattering / uRayleighScattering);
}

// --- scattering table addressing ------------------------------------------

vec4 getScatteringTextureUvwzFromRMuMuSNu(
    float r, float mu, float mu_s, float nu, bool hitsGround) {
  float H = safeSqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = safeSqrt(r * r - uBottomRadius * uBottomRadius);
  float u_r = getTextureCoordFromUnitRange(rho / H, SCATTERING_TEXTURE_R_SIZE);

  float r_mu = r * mu;
  float discriminant = r_mu * r_mu - r * r + uBottomRadius * uBottomRadius;
  float u_mu;
  if (hitsGround) {
    float d = -r_mu - safeSqrt(discriminant);
    float d_min = r - uBottomRadius;
    float d_max = rho;
    u_mu = 0.5 - 0.5 * getTextureCoordFromUnitRange(
        d_max == d_min ? 0.0 : (d - d_min) / (d_max - d_min),
        SCATTERING_TEXTURE_MU_SIZE / 2);
  } else {
    float d = -r_mu + safeSqrt(discriminant + H * H);
    float d_min = uTopRadius - r;
    float d_max = rho + H;
    u_mu = 0.5 + 0.5 * getTextureCoordFromUnitRange(
        (d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
  }

  float d = distanceToTopAtmosphereBoundary(uBottomRadius, mu_s);
  float d_min = uTopRadius - uBottomRadius;
  float d_max = H;
  float a = (d - d_min) / (d_max - d_min);
  float D = distanceToTopAtmosphereBoundary(uBottomRadius, uMuSMin);
  float A = (D - d_min) / (d_max - d_min);
  float u_mu_s = getTextureCoordFromUnitRange(
      max(1.0 - a / A, 0.0) / (1.0 + a), SCATTERING_TEXTURE_MU_S_SIZE);

  return vec4((nu + 1.0) / 2.0, u_mu_s, u_mu, u_r);
}

void getRMuMuSNuFromScatteringTextureUvwz(vec4 uvwz, out float r, out float mu,
    out float mu_s, out float nu, out bool hitsGround) {
  float H = safeSqrt(uTopRadius * uTopRadius - uBottomRadius * uBottomRadius);
  float rho = H * getUnitRangeFromTextureCoord(uvwz.w, SCATTERING_TEXTURE_R_SIZE);
  r = safeSqrt(rho * rho + uBottomRadius * uBottomRadius);

  if (uvwz.z < 0.5) {
    float d_min = r - uBottomRadius;
    float d_max = rho;
    float d = d_min + (d_max - d_min) * getUnitRangeFromTextureCoord(
        1.0 - 2.0 * uvwz.z, SCATTERING_TEXTURE_MU_SIZE / 2);
    mu = d == 0.0 ? -1.0 : clampCosine(-(rho * rho + d * d) / (2.0 * r * d));
    hitsGround = true;
  } else {
    float d_min = uTopRadius - r;
    float d_max = rho + H;
    float d = d_min + (d_max - d_min) * getUnitRangeFromTextureCoord(
        2.0 * uvwz.z - 1.0, SCATTERING_TEXTURE_MU_SIZE / 2);
    mu = d == 0.0 ? 1.0 : clampCosine((H * H - rho * rho - d * d) / (2.0 * r * d));
    hitsGround = false;
  }

  float x_mu_s = getUnitRangeFromTextureCoord(uvwz.y, SCATTERING_TEXTURE_MU_S_SIZE);
  float d_min = uTopRadius - uBottomRadius;
  float d_max = H;
  float D = distanceToTopAtmosphereBoundary(uBottomRadius, uMuSMin);
  float A = (D - d_min) / (d_max - d_min);
  float a = (A - x_mu_s * A) / (1.0 + x_mu_s * A);
  float d = d_min + min(a, A) * (d_max - d_min);
  mu_s = d == 0.0 ? 1.0 : clampCosine((H * H - d * d) / (2.0 * uBottomRadius * d));

  nu = clampCosine(uvwz.x * 2.0 - 1.0);
}

void getRMuMuSNuFromScatteringTextureFragCoord(vec3 fragCoord,
    out float r, out float mu, out float mu_s, out float nu, out bool hitsGround) {
  const vec4 SCATTERING_TEXTURE_SIZE = vec4(
      float(SCATTERING_TEXTURE_NU_SIZE - 1),
      float(SCATTERING_TEXTURE_MU_S_SIZE),
      float(SCATTERING_TEXTURE_MU_SIZE),
      float(SCATTERING_TEXTURE_R_SIZE));
  float frag_coord_nu = floor(fragCoord.x / float(SCATTERING_TEXTURE_MU_S_SIZE));
  float frag_coord_mu_s = mod(fragCoord.x, float(SCATTERING_TEXTURE_MU_S_SIZE));
  vec4 uvwz = vec4(frag_coord_nu, frag_coord_mu_s, fragCoord.y, fragCoord.z)
      / SCATTERING_TEXTURE_SIZE;
  getRMuMuSNuFromScatteringTextureUvwz(uvwz, r, mu, mu_s, nu, hitsGround);
  // nu is not independent of mu and mu_s: outside this range the three angles
  // describe no real geometry, and the integrals below would run on nonsense.
  float s = safeSqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s));
  nu = clamp(nu, mu * mu_s - s, mu * mu_s + s);
}

vec3 texel3D(sampler3D tex, vec3 uvw) { return texture(tex, uvw).rgb; }

vec3 getScattering3D(sampler3D tex, float r, float mu, float mu_s, float nu, bool hitsGround) {
  vec4 uvwz = getScatteringTextureUvwzFromRMuMuSNu(r, mu, mu_s, nu, hitsGround);
  float tex_coord_x = uvwz.x * float(SCATTERING_TEXTURE_NU_SIZE - 1);
  float tex_x = floor(tex_coord_x);
  float lerp = tex_coord_x - tex_x;
  vec3 uvw0 = vec3((tex_x + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  return texel3D(tex, uvw0) * (1.0 - lerp) + texel3D(tex, uvw1) * lerp;
}

// --- irradiance table addressing -------------------------------------------

vec2 getIrradianceTextureUvFromRMuS(float r, float mu_s) {
  float x_r = (r - uBottomRadius) / (uTopRadius - uBottomRadius);
  float x_mu_s = mu_s * 0.5 + 0.5;
  return vec2(getTextureCoordFromUnitRange(x_mu_s, IRRADIANCE_TEXTURE_WIDTH),
              getTextureCoordFromUnitRange(x_r, IRRADIANCE_TEXTURE_HEIGHT));
}

void getRMuSFromIrradianceTextureUv(vec2 uv, out float r, out float mu_s) {
  float x_mu_s = getUnitRangeFromTextureCoord(uv.x, IRRADIANCE_TEXTURE_WIDTH);
  float x_r = getUnitRangeFromTextureCoord(uv.y, IRRADIANCE_TEXTURE_HEIGHT);
  r = uBottomRadius + x_r * (uTopRadius - uBottomRadius);
  mu_s = clampCosine(2.0 * x_mu_s - 1.0);
}

vec3 getIrradiance(sampler2D tex, float r, float mu_s) {
  return texture(tex, getIrradianceTextureUvFromRMuS(r, mu_s)).rgb;
}
`;

const TRANSMITTANCE_FRAGMENT = /* glsl */`
out vec4 fragColor;
void main() {
  float r, mu;
  getRMuFromTransmittanceTextureUv(
      gl_FragCoord.xy / vec2(float(TRANSMITTANCE_TEXTURE_WIDTH), float(TRANSMITTANCE_TEXTURE_HEIGHT)),
      r, mu);
  fragColor = vec4(computeOpticalDepthToTopAtmosphereBoundary(r, mu), 1.0);
}
`;

const SINGLE_SCATTERING_FRAGMENT = /* glsl */`
uniform sampler2D uTransmittance;
// 0 = Rayleigh delta, 1 = Mie delta, 2 = the combined accumulator layout
// (Rayleigh in rgb, the red Mie channel in alpha; the other two Mie channels
// are reconstructed at lookup from the spectral shape).
uniform int uMode;
out vec4 fragColor;

void computeSingleScatteringIntegrand(float r, float mu, float mu_s, float nu, float d,
    bool hitsGround, out vec3 rayleigh, out vec3 mie) {
  float r_d = clampRadius(safeSqrt(d * d + 2.0 * r * mu * d + r * r));
  float mu_s_d = clampCosine((r * mu_s + d * nu) / r_d);
  vec3 t = getTransmittance(uTransmittance, r, mu, d, hitsGround)
      * getTransmittanceToSun(uTransmittance, r_d, mu_s_d);
  rayleigh = t * profileDensity(0, r_d - uBottomRadius);
  mie = t * profileDensity(1, r_d - uBottomRadius);
}

void computeSingleScattering(float r, float mu, float mu_s, float nu, bool hitsGround,
    out vec3 rayleigh, out vec3 mie) {
  const int SAMPLE_COUNT = 50;
  float dx = distanceToNearestAtmosphereBoundary(r, mu, hitsGround) / float(SAMPLE_COUNT);
  vec3 rayleigh_sum = vec3(0.0);
  vec3 mie_sum = vec3(0.0);
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    vec3 rayleigh_i, mie_i;
    computeSingleScatteringIntegrand(r, mu, mu_s, nu, float(i) * dx, hitsGround, rayleigh_i, mie_i);
    float w_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
    rayleigh_sum += rayleigh_i * w_i;
    mie_sum += mie_i * w_i;
  }
  rayleigh = rayleigh_sum * dx * SOLAR_IRRADIANCE * uRayleighScattering;
  mie = mie_sum * dx * SOLAR_IRRADIANCE * uMieScattering;
}

void main() {
  float r, mu, mu_s, nu;
  bool hitsGround;
  getRMuMuSNuFromScatteringTextureFragCoord(
      vec3(gl_FragCoord.xy, uLayer + 0.5), r, mu, mu_s, nu, hitsGround);
  vec3 rayleigh, mie;
  computeSingleScattering(r, mu, mu_s, nu, hitsGround, rayleigh, mie);
  if (uMode == 0) fragColor = vec4(rayleigh, 1.0);
  else if (uMode == 1) fragColor = vec4(mie, 1.0);
  else fragColor = vec4(rayleigh, mie.r);
}
`;

const IRRADIANCE_FRAGMENT = /* glsl */`
uniform sampler2D uTransmittance;
uniform sampler3D uSingleRayleigh;
uniform sampler3D uSingleMie;
uniform sampler3D uMultipleScattering;
uniform int uScatteringOrder;
// 0 = direct (the Sun's own irradiance on the ground), 1 = indirect (the sky's).
uniform int uMode;
out vec4 fragColor;

vec3 getOrderScattering(float r, float mu, float mu_s, float nu, bool hitsGround, int order) {
  if (order == 1) {
    return getScattering3D(uSingleRayleigh, r, mu, mu_s, nu, hitsGround) * rayleighPhaseFunction(nu)
        + getScattering3D(uSingleMie, r, mu, mu_s, nu, hitsGround) * miePhaseFunction(uMiePhaseG, nu);
  }
  return getScattering3D(uMultipleScattering, r, mu, mu_s, nu, hitsGround);
}

vec3 computeDirectIrradiance(float r, float mu_s) {
  float alpha_s = uSunAngularRadius;
  // The Sun is a disc, not a point: near the horizon part of it is already
  // below, and the average cosine over the visible part is what lands.
  float average_cosine_factor = mu_s < -alpha_s ? 0.0
      : (mu_s > alpha_s ? mu_s : (mu_s + alpha_s) * (mu_s + alpha_s) / (4.0 * alpha_s));
  return SOLAR_IRRADIANCE
      * getTransmittanceToTopAtmosphereBoundary(uTransmittance, r, mu_s)
      * average_cosine_factor;
}

vec3 computeIndirectIrradiance(float r, float mu_s, int order) {
  const int SAMPLE_COUNT = 32;
  float dphi = PI / float(SAMPLE_COUNT);
  float dtheta = PI / float(SAMPLE_COUNT);
  vec3 result = vec3(0.0);
  vec3 omega_s = vec3(safeSqrt(1.0 - mu_s * mu_s), 0.0, mu_s);
  for (int j = 0; j < SAMPLE_COUNT / 2; ++j) {
    float theta = (float(j) + 0.5) * dtheta;
    for (int i = 0; i < 2 * SAMPLE_COUNT; ++i) {
      float phi = (float(i) + 0.5) * dphi;
      vec3 omega = vec3(cos(phi) * sin(theta), sin(phi) * sin(theta), cos(theta));
      float domega = dtheta * dphi * sin(theta);
      float nu = dot(omega, omega_s);
      result += getOrderScattering(r, omega.z, mu_s, nu, false, order) * omega.z * domega;
    }
  }
  return result;
}

void main() {
  float r, mu_s;
  getRMuSFromIrradianceTextureUv(
      gl_FragCoord.xy / vec2(float(IRRADIANCE_TEXTURE_WIDTH), float(IRRADIANCE_TEXTURE_HEIGHT)),
      r, mu_s);
  vec3 result = uMode == 0 ? computeDirectIrradiance(r, mu_s)
                           : computeIndirectIrradiance(r, mu_s, uScatteringOrder);
  fragColor = vec4(result, 1.0);
}
`;

const SCATTERING_DENSITY_FRAGMENT = /* glsl */`
uniform sampler2D uTransmittance;
uniform sampler3D uSingleRayleigh;
uniform sampler3D uSingleMie;
uniform sampler3D uMultipleScattering;
uniform sampler2D uIrradiance;
uniform int uScatteringOrder;
out vec4 fragColor;

vec3 getOrderScattering(float r, float mu, float mu_s, float nu, bool hitsGround, int order) {
  if (order == 1) {
    return getScattering3D(uSingleRayleigh, r, mu, mu_s, nu, hitsGround) * rayleighPhaseFunction(nu)
        + getScattering3D(uSingleMie, r, mu, mu_s, nu, hitsGround) * miePhaseFunction(uMiePhaseG, nu);
  }
  return getScattering3D(uMultipleScattering, r, mu, mu_s, nu, hitsGround);
}

vec3 computeScatteringDensity(float r, float mu, float mu_s, float nu, int order) {
  // A frame in which the view zenith angle is mu, the sun zenith angle mu_s and
  // the angle between them nu.
  vec3 zenith_direction = vec3(0.0, 0.0, 1.0);
  vec3 omega = vec3(safeSqrt(1.0 - mu * mu), 0.0, mu);
  float sun_dir_x = omega.x == 0.0 ? 0.0 : (nu - mu * mu_s) / omega.x;
  float sun_dir_y = safeSqrt(max(1.0 - sun_dir_x * sun_dir_x - mu_s * mu_s, 0.0));
  vec3 omega_s = vec3(sun_dir_x, sun_dir_y, mu_s);

  const int SAMPLE_COUNT = 16;
  float dphi = PI / float(SAMPLE_COUNT);
  float dtheta = PI / float(SAMPLE_COUNT);
  vec3 rayleigh_mie = vec3(0.0);

  float rayleigh_density = profileDensity(0, r - uBottomRadius);
  float mie_density = profileDensity(1, r - uBottomRadius);

  for (int l = 0; l < SAMPLE_COUNT; ++l) {
    float theta = (float(l) + 0.5) * dtheta;
    float cos_theta = cos(theta);
    float sin_theta = sin(theta);
    bool hits_ground = rayIntersectsGround(r, cos_theta);

    float distance_to_ground = 0.0;
    vec3 transmittance_to_ground = vec3(0.0);
    float ground_albedo = 0.0;
    if (hits_ground) {
      distance_to_ground = distanceToBottomAtmosphereBoundary(r, cos_theta);
      transmittance_to_ground =
          getTransmittance(uTransmittance, r, cos_theta, distance_to_ground, true);
      ground_albedo = uGroundAlbedo;
    }

    for (int m = 0; m < 2 * SAMPLE_COUNT; ++m) {
      float phi = (float(m) + 0.5) * dphi;
      vec3 omega_i = vec3(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
      float domega_i = dtheta * dphi * sin_theta;

      float nu1 = dot(omega_s, omega_i);
      vec3 incident_radiance =
          getOrderScattering(r, omega_i.z, mu_s, nu1, hits_ground, order - 1);

      vec3 ground_normal = normalize(zenith_direction * r + omega_i * distance_to_ground);
      vec3 ground_irradiance = getIrradiance(uIrradiance, uBottomRadius, dot(ground_normal, omega_s));
      incident_radiance += transmittance_to_ground * ground_albedo * (1.0 / PI) * ground_irradiance;

      float nu2 = dot(omega, omega_i);
      rayleigh_mie += incident_radiance * (
          uRayleighScattering * rayleigh_density * rayleighPhaseFunction(nu2) +
          uMieScattering * mie_density * miePhaseFunction(uMiePhaseG, nu2)) * domega_i;
    }
  }
  return rayleigh_mie;
}

void main() {
  float r, mu, mu_s, nu;
  bool hitsGround;
  getRMuMuSNuFromScatteringTextureFragCoord(
      vec3(gl_FragCoord.xy, uLayer + 0.5), r, mu, mu_s, nu, hitsGround);
  fragColor = vec4(computeScatteringDensity(r, mu, mu_s, nu, uScatteringOrder), 1.0);
}
`;

const MULTIPLE_SCATTERING_FRAGMENT = /* glsl */`
uniform sampler2D uTransmittance;
uniform sampler3D uScatteringDensity;
out vec4 fragColor;

vec3 computeMultipleScattering(float r, float mu, float mu_s, float nu, bool hitsGround) {
  const int SAMPLE_COUNT = 50;
  float dx = distanceToNearestAtmosphereBoundary(r, mu, hitsGround) / float(SAMPLE_COUNT);
  vec3 sum = vec3(0.0);
  for (int i = 0; i <= SAMPLE_COUNT; ++i) {
    float d_i = float(i) * dx;
    float r_i = clampRadius(safeSqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r));
    float mu_i = clampCosine((r * mu + d_i) / r_i);
    float mu_s_i = clampCosine((r * mu_s + d_i * nu) / r_i);
    vec3 term = getScattering3D(uScatteringDensity, r_i, mu_i, mu_s_i, nu, hitsGround)
        * getTransmittance(uTransmittance, r, mu, d_i, hitsGround) * dx;
    float w_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
    sum += term * w_i;
  }
  return sum;
}

void main() {
  float r, mu, mu_s, nu;
  bool hitsGround;
  getRMuMuSNuFromScatteringTextureFragCoord(
      vec3(gl_FragCoord.xy, uLayer + 0.5), r, mu, mu_s, nu, hitsGround);
  fragColor = vec4(computeMultipleScattering(r, mu, mu_s, nu, hitsGround), 1.0);
}
`;

const COMBINE_FRAGMENT = /* glsl */`
uniform sampler3D uSourceA;
uniform sampler3D uSourceB;
// 0 = fold the single Rayleigh and Mie deltas into the accumulator layout.
// 1 = add one further order, divided by the Rayleigh phase function so the
//     lookup's single multiply by that phase recovers every order at once.
uniform int uMode;
out vec4 fragColor;

void main() {
  vec3 uvw = vec3(
      gl_FragCoord.x / float(SCATTERING_TEXTURE_NU_SIZE * SCATTERING_TEXTURE_MU_S_SIZE),
      gl_FragCoord.y / float(SCATTERING_TEXTURE_MU_SIZE),
      (uLayer + 0.5) / float(SCATTERING_TEXTURE_R_SIZE));
  if (uMode == 0) {
    fragColor = vec4(texture(uSourceA, uvw).rgb, texture(uSourceB, uvw).r);
  } else {
    float r, mu, mu_s, nu;
    bool hitsGround;
    getRMuMuSNuFromScatteringTextureFragCoord(
        vec3(gl_FragCoord.xy, uLayer + 0.5), r, mu, mu_s, nu, hitsGround);
    fragColor = vec4(texture(uSourceA, uvw).rgb / rayleighPhaseFunction(nu), 0.0);
  }
}
`;

/** Reads one table sample into an 8-bit target, high byte or low byte, so a
 *  16-bit value survives a readback that is only allowed to be 8-bit. Built on
 *  BAKE_COMMON, so modes 2 and 3 exercise the SHADER's phase functions, Mie
 *  recovery and irradiance addressing — the transcription that has no other
 *  check against the TypeScript reference. */
const PROBE_FRAGMENT = /* glsl */`
uniform sampler2D uTransmittance;
uniform sampler3D uScattering;
uniform sampler2D uIrradiance;
// 0 = a transmittance texel; 1 = a scattering texel with the nu lerp;
// 2 = the combined radiance a lookup returns, both phases applied and the
//     single-Mie term recovered; 3 = an irradiance texel, addressed by (r, mu_s).
uniform int uMode;
uniform vec2 uUv;
uniform vec3 uUvw0;
uniform vec3 uUvw1;
uniform float uNuLerp;
uniform float uNu;
uniform float uProbeR;
uniform float uProbeMuS;
uniform float uScale;
uniform int uByte;
out vec4 fragColor;
void main() {
  vec4 v;
  if (uMode == 0) {
    v = texture(uTransmittance, uUv);
  } else if (uMode == 3) {
    v = vec4(getIrradiance(uIrradiance, uProbeR, uProbeMuS), 1.0);
  } else {
    vec4 t = mix(texture(uScattering, uUvw0), texture(uScattering, uUvw1), uNuLerp);
    v = uMode == 1 ? t : vec4(
        t.rgb * rayleighPhaseFunction(uNu)
        + getExtrapolatedSingleMieScattering(t) * miePhaseFunction(uMiePhaseG, uNu),
        1.0);
  }
  vec4 s = clamp(v * uScale, 0.0, 1.0);
  fragColor = uByte == 0 ? floor(s * 255.0) / 255.0 : fract(s * 255.0);
}
`;

// ---------------------------------------------------------------------------
// The baker
// ---------------------------------------------------------------------------

interface BakeTargets {
  scratchGone: boolean;
  residentGone: boolean;
  transmittance: THREE.WebGLRenderTarget;
  irradiance: THREE.WebGLRenderTarget;
  deltaIrradiance: THREE.WebGLRenderTarget;
  scattering: THREE.WebGL3DRenderTarget;
  /** Also serves as the multiple-scattering delta once the order-2 density pass
   *  has read it — see the module header. */
  deltaRayleigh: THREE.WebGL3DRenderTarget;
  deltaMie: THREE.WebGL3DRenderTarget;
  deltaScatteringDensity: THREE.WebGL3DRenderTarget;
}

let activeLut: AtmosphereLut | null = null;

/** The tier's state for the session: 'ready' once at least one body's tables
 *  are written and validated, 'baking' while the first one is being made,
 *  'unavailable' when the probe or the validation said no. A later body baking
 *  does not take the tier back down — ask `atmosphereTables(body)` for a
 *  specific body. */
export function atmosphereLutState(): AtmosphereLutState {
  return activeLut?.state ?? 'unavailable';
}

export function atmosphereTables(body: string): AtmosphereTables | undefined {
  return activeLut?.tables(body);
}

export class AtmosphereLut {
  readonly sizes: AtmosphereTableSizes;
  readonly orders: number;
  private readonly drawsPerSlice: number;
  private readonly ready = new Map<string, AtmosphereTables>();
  /** The render targets behind `ready`'s textures — a texture has no way back
   *  to the target that owns its GPU memory. */
  private readonly residentTargets = new Map<string, THREE.WebGLRenderTarget[]>();
  /** Bakes share one set of materials and one set of uniforms, so they run one
   *  at a time however they are called. */
  private bakeChain: Promise<unknown> = Promise.resolve();
  private drawCount = 0;
  private readonly bakeStats: AtmosphereBakeStats[] = [];
  private materials: {
    transmittance: THREE.ShaderMaterial;
    singleScattering: THREE.ShaderMaterial;
    irradiance: THREE.ShaderMaterial;
    scatteringDensity: THREE.ShaderMaterial;
    multipleScattering: THREE.ShaderMaterial;
    combine: THREE.ShaderMaterial;
    probe: THREE.ShaderMaterial;
  } | null = null;
  private quad: THREE.Mesh | null = null;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.Camera();
  private probeTarget: THREE.WebGLRenderTarget | null = null;
  private capable: boolean | null = null;
  private baking = 0;
  private liveBytes = 0;
  private peakBytes = 0;
  private contextLost = false;
  private generation = 0;
  private disposed = false;
  /** Every body a bake has been asked for this session, whether or not it ever
   *  finished. A context lost during the FIRST bake finds nothing ready, so a
   *  restore that re-baked only what HAD been ready would re-bake nothing —
   *  and the one-shot timer that armed the bake has already fired, so nothing
   *  else would ask again either. */
  private readonly requested = new Set<string>();
  private consecutiveFailures = 0;
  private givenUp = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    options: AtmosphereLutOptions = {},
  ) {
    const profile = atmosphereLutProfile(options.touch === true);
    this.sizes = options.sizes ?? profile.sizes;
    this.orders = Math.max(1, Math.floor(options.orders ?? profile.orders));
    this.drawsPerSlice = options.drawsPerSlice ?? DEFAULT_DRAWS_PER_SLICE;
    if (options.register !== false) activeLut = this;
  }

  get state(): AtmosphereLutState {
    if (this.ready.size > 0) return 'ready';
    if (this.baking > 0) return 'baking';
    return 'unavailable';
  }

  /** Whether the GPU passed the 3D-layer-render probe. Null until first asked. */
  get capability(): boolean | null {
    return this.capable;
  }

  stats(): readonly AtmosphereBakeStats[] {
    return this.bakeStats;
  }

  tables(body: string): AtmosphereTables | undefined {
    return this.ready.get(body);
  }

  /**
   * Bake one body's tables. Resolves true when every table is written and the
   * readback validated. Safe to call for a body that is already baked (no-op)
   * and safe to call while another body bakes (they queue behind the frame
   * slicing, not each other).
   */
  bake(body: string): Promise<boolean> {
    if (ATMOSPHERE_SPECS[body]) this.requested.add(body);
    const run = this.bakeChain.then(() => this.runBake(body));
    // The chain must survive a rejection or every later bake is dropped.
    this.bakeChain = run.catch(() => undefined);
    return run;
  }

  private async runBake(body: string): Promise<boolean> {
    if (this.disposed || this.contextLost) return false;
    if (this.ready.has(body)) return true;
    if (!ATMOSPHERE_SPECS[body] || this.givenUp) return false;
    if (this.capable === null) this.capable = canGPUDoAtmosphereLut(this.renderer);
    if (!this.capable) return false;

    const generation = this.generation;
    const params = atmosphereParams(body);
    const wallStart = performance.now();
    const programsBefore = this.renderer.info.programs?.length ?? 0;
    const drawsBefore = this.drawCount;
    let submitMs = 0;
    let slices = 0;
    this.baking++;
    let targets: BakeTargets | null = null;
    let succeeded = false;
    const record = (validated: boolean, aborted: boolean): void => {
      this.bakeStats.push({
        body,
        wallMs: performance.now() - wallStart,
        submitMs,
        drawCalls: this.drawCount - drawsBefore,
        programsBefore,
        programsAfter: this.renderer.info.programs?.length ?? 0,
        peakBytes: this.peakBytes,
        residentBytes: targets
          ? targetBytes(targets.transmittance, 1) + targetBytes(targets.irradiance, 1)
            + targetBytes(targets.scattering, this.sizes.scatteringR)
          : 0,
        orders: this.orders,
        validated,
        aborted,
        slices,
      });
    };
    try {
      this.ensureMaterials();
      targets = this.createTargets();
      const steps = this.buildSteps(params, targets);
      let i = 0;
      while (i < steps.length) {
        if (this.disposed || this.contextLost || generation !== this.generation) {
          record(false, true);
          return false;
        }
        const sliceStart = performance.now();
        const prevTarget = this.renderer.getRenderTarget();
        const prevAutoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        try {
          let inSlice = 0;
          while (
            i < steps.length
            && inSlice < this.drawsPerSlice
            && performance.now() - sliceStart < SLICE_SUBMIT_BUDGET_MS
          ) {
            steps[i++]();
            inSlice++;
          }
        } finally {
          this.renderer.autoClear = prevAutoClear;
          this.renderer.setRenderTarget(prevTarget);
        }
        submitMs += performance.now() - sliceStart;
        slices++;
        if (i < steps.length) await nextFrame();
      }

      const tables: AtmosphereTables = {
        body,
        params,
        sizes: this.sizes,
        solarIrradianceScale: bodySolarIrradianceScale(body),
        transmittance: targets.transmittance.texture,
        scattering: targets.scattering.texture,
        irradiance: targets.irradiance.texture,
      };
      const validated = this.validate(params, targets);
      record(validated, false);
      if (!validated) {
        // Fail-closed: a table that cannot be read back is a table that cannot
        // be trusted, and the analytic shell is a complete look on its own.
        debugWarn('Atmosphere LUT validation failed; staying on the analytic tier', { body });
        this.disposeResident(targets);
        this.capable = false;
        return false;
      }
      // Only the scratch goes; the three resident tables live on in `tables`.
      this.disposeScratch(targets);
      this.ready.set(body, tables);
      this.residentTargets.set(body, [targets.transmittance, targets.irradiance, targets.scattering]);
      targets = null;
      succeeded = true;
      this.consecutiveFailures = 0;
      debugLog('Atmosphere LUT baked', this.bakeStats[this.bakeStats.length - 1]);
      return true;
    } catch (err) {
      // A draw into a context that has just gone throws out of three before the
      // lost-context event is dispatched, and that throw says nothing about the
      // device — only a failure under a live context marks it incapable.
      const cutShort = this.contextLost || this.disposed || generation !== this.generation;
      debugWarn('Atmosphere LUT bake failed; staying on the analytic tier',
        { body, cutShort, err: String(err) });
      record(false, cutShort);
      if (!cutShort) this.capable = false;
      return false;
    } finally {
      this.baking--;
      // A bake that never reached its hand-off owns everything it made.
      if (targets) this.disposeResident(targets);
      if (!succeeded && !this.disposed) this.noteFailedBake(body);
    }
  }

  /** A bake that produced no tables. Three of those in a row and the session
   *  stops re-baking: a device that keeps losing the context mid-bake would
   *  otherwise retry on every restore, each retry costing the memory that is
   *  making it lose the context. */
  private noteFailedBake(body: string): void {
    this.consecutiveFailures++;
    if (this.givenUp || this.consecutiveFailures < MAX_CONSECUTIVE_BAKE_FAILURES) return;
    this.givenUp = true;
    this.capable = false;
    debugWarn(
      'Atmosphere LUT gave up after repeated failed bakes; staying on the analytic tier',
      { body, attempts: this.consecutiveFailures },
    );
  }

  /** The tables are render-target textures with no CPU backing: a lost context
   *  takes them with it, so they are dropped and the tier goes down until a
   *  re-bake validates. */
  onContextLost(): void {
    this.contextLost = true;
    this.generation++;
    this.dropReady();
    this.liveBytes = 0;
    this.capable = null;
  }

  /** Re-bake every body this session has asked for — the ones that were ready
   *  and the one that was still baking when the context went. The tier stays
   *  down until each validates again: never a stale table over a new context. */
  onContextRestored(): void {
    this.contextLost = false;
    // Programs and targets went with the context; the materials must be rebuilt
    // rather than re-linked against a dead one.
    if (this.materials) for (const m of Object.values(this.materials)) m.dispose();
    this.materials = null;
    this.quad?.geometry.dispose();
    this.quad = null;
    this.quadScene = new THREE.Scene();
    this.probeTarget = null;
    for (const body of [...this.requested]) void this.bake(body);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.dropReady();
    if (this.materials) for (const m of Object.values(this.materials)) m.dispose();
    this.materials = null;
    this.quad?.geometry.dispose();
    this.quad = null;
    this.probeTarget?.dispose();
    this.probeTarget = null;
    if (activeLut === this) activeLut = null;
  }

  // -- internals ------------------------------------------------------------

  private defines(): Record<string, string> {
    const s = this.sizes;
    return {
      TRANSMITTANCE_TEXTURE_WIDTH: String(s.transmittanceW),
      TRANSMITTANCE_TEXTURE_HEIGHT: String(s.transmittanceH),
      SCATTERING_TEXTURE_R_SIZE: String(s.scatteringR),
      SCATTERING_TEXTURE_MU_SIZE: String(s.scatteringMu),
      SCATTERING_TEXTURE_MU_S_SIZE: String(s.scatteringMuS),
      SCATTERING_TEXTURE_NU_SIZE: String(s.scatteringNu),
      IRRADIANCE_TEXTURE_WIDTH: String(s.irradianceW),
      IRRADIANCE_TEXTURE_HEIGHT: String(s.irradianceH),
    };
  }

  private ensureMaterials(): void {
    if (this.materials) return;
    const defines = this.defines();
    const make = (fragment: string, extra: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        vertexShader: BAKE_VERTEX,
        fragmentShader: BAKE_COMMON + fragment,
        glslVersion: THREE.GLSL3,
        precision: 'highp',
        defines: { ...defines },
        depthTest: false,
        depthWrite: false,
        // The default NormalBlending would fold the destination back in through
        // the alpha channel, and alpha carries the single-Mie term.
        blending: THREE.NoBlending,
        uniforms: { ...commonUniforms(), ...extra },
      });

    this.materials = {
      transmittance: make(TRANSMITTANCE_FRAGMENT, {}),
      singleScattering: make(SINGLE_SCATTERING_FRAGMENT, {
        uTransmittance: { value: null },
        uMode: { value: 0 },
      }),
      irradiance: make(IRRADIANCE_FRAGMENT, {
        uTransmittance: { value: null },
        uSingleRayleigh: { value: null },
        uSingleMie: { value: null },
        uMultipleScattering: { value: null },
        uScatteringOrder: { value: 1 },
        uMode: { value: 0 },
      }),
      scatteringDensity: make(SCATTERING_DENSITY_FRAGMENT, {
        uTransmittance: { value: null },
        uSingleRayleigh: { value: null },
        uSingleMie: { value: null },
        uMultipleScattering: { value: null },
        uIrradiance: { value: null },
        uScatteringOrder: { value: 2 },
      }),
      multipleScattering: make(MULTIPLE_SCATTERING_FRAGMENT, {
        uTransmittance: { value: null },
        uScatteringDensity: { value: null },
      }),
      combine: make(COMBINE_FRAGMENT, {
        uSourceA: { value: null },
        uSourceB: { value: null },
        uMode: { value: 0 },
      }),
      probe: make(PROBE_FRAGMENT, {
        uTransmittance: { value: null },
        uScattering: { value: null },
        uIrradiance: { value: null },
        uMode: { value: 0 },
        uUv: { value: new THREE.Vector2() },
        uUvw0: { value: new THREE.Vector3() },
        uUvw1: { value: new THREE.Vector3() },
        uNuLerp: { value: 0 },
        uNu: { value: 0 },
        uProbeR: { value: 0 },
        uProbeMuS: { value: 0 },
        uScale: { value: 1 },
        uByte: { value: 0 },
      }),
    };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private createTargets(): BakeTargets {
    const s = this.sizes;
    const w = scatteringTextureWidth(s);
    const targets: BakeTargets = {
      scratchGone: false,
      residentGone: false,
      transmittance: this.track(make2D(s.transmittanceW, s.transmittanceH)),
      irradiance: this.track(make2D(s.irradianceW, s.irradianceH)),
      deltaIrradiance: this.track(make2D(s.irradianceW, s.irradianceH)),
      scattering: this.track3D(make3D(w, s.scatteringMu, s.scatteringR)),
      deltaRayleigh: this.track3D(make3D(w, s.scatteringMu, s.scatteringR)),
      deltaMie: this.track3D(make3D(w, s.scatteringMu, s.scatteringR)),
      deltaScatteringDensity: this.track3D(make3D(w, s.scatteringMu, s.scatteringR)),
    };
    return targets;
  }

  private track<T extends THREE.WebGLRenderTarget>(t: T): T {
    this.liveBytes += targetBytes(t, 1);
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes);
    return t;
  }

  private track3D(t: THREE.WebGL3DRenderTarget): THREE.WebGL3DRenderTarget {
    this.liveBytes += targetBytes(t, this.sizes.scatteringR);
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes);
    return t;
  }

  private disposeScratch(t: BakeTargets): void {
    if (t.scratchGone) return;
    t.scratchGone = true;
    // The three 3D scratch targets are the same shape by construction.
    this.liveBytes -= targetBytes(t.deltaIrradiance, 1)
      + targetBytes(t.deltaRayleigh, this.sizes.scatteringR) * 3;
    t.deltaIrradiance.dispose();
    t.deltaRayleigh.dispose();
    t.deltaMie.dispose();
    t.deltaScatteringDensity.dispose();
  }

  private disposeResident(t: BakeTargets): void {
    this.disposeScratch(t);
    if (t.residentGone) return;
    t.residentGone = true;
    this.liveBytes -= targetBytes(t.transmittance, 1) + targetBytes(t.irradiance, 1)
      + targetBytes(t.scattering, this.sizes.scatteringR);
    t.transmittance.dispose();
    t.irradiance.dispose();
    t.scattering.dispose();
  }

  private dropReady(): void {
    for (const targets of this.residentTargets.values()) {
      for (const rt of targets) {
        this.liveBytes -= targetBytes(rt, (rt as THREE.WebGL3DRenderTarget).depth ?? 1);
        rt.dispose();
      }
    }
    this.residentTargets.clear();
    this.ready.clear();
  }

  /** One thunk per draw, in Bruneton's order. Each is one layer of one pass, so
   *  the frame slicing has somewhere to cut. */
  private buildSteps(params: AtmosphereParams, t: BakeTargets): Array<() => void> {
    const m = this.materials!;
    const steps: Array<() => void> = [];
    const layers = this.sizes.scatteringR;

    for (const mat of [m.transmittance, m.singleScattering, m.irradiance,
      m.scatteringDensity, m.multipleScattering, m.combine]) {
      setAtmosphereUniforms(mat, params);
    }

    // Transmittance, and a cleared irradiance accumulator: the accumulator holds
    // the SKY's irradiance only, so the direct term never enters it.
    steps.push(() => {
      this.clear(t.irradiance);
      this.draw(m.transmittance, t.transmittance);
    });

    steps.push(() => {
      m.irradiance.uniforms.uMode.value = 0;
      m.irradiance.uniforms.uTransmittance.value = t.transmittance.texture;
      this.draw(m.irradiance, t.deltaIrradiance);
    });

    // Single scattering: the two deltas the density pass needs, then the
    // accumulator's combined layout.
    m.singleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
    for (const [mode, target] of [[0, t.deltaRayleigh], [1, t.deltaMie]] as const) {
      for (let layer = 0; layer < layers; layer++) {
        steps.push(() => {
          m.singleScattering.uniforms.uMode.value = mode;
          m.singleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
          this.draw(m.singleScattering, target, layer);
        });
      }
    }
    for (let layer = 0; layer < layers; layer++) {
      steps.push(() => {
        m.combine.uniforms.uMode.value = 0;
        m.combine.uniforms.uSourceA.value = t.deltaRayleigh.texture;
        m.combine.uniforms.uSourceB.value = t.deltaMie.texture;
        this.draw(m.combine, t.scattering, layer);
      });
    }

    for (let order = 2; order <= this.orders; order++) {
      const k = order;
      // Scattering density from the previous order. At order 2 that is the two
      // single-scattering deltas; from order 3 on it is the multiple-scattering
      // delta, which by then has overwritten the Rayleigh one.
      for (let layer = 0; layer < layers; layer++) {
        steps.push(() => {
          const u = m.scatteringDensity.uniforms;
          u.uTransmittance.value = t.transmittance.texture;
          u.uSingleRayleigh.value = t.deltaRayleigh.texture;
          u.uSingleMie.value = t.deltaMie.texture;
          u.uMultipleScattering.value = t.deltaRayleigh.texture;
          u.uIrradiance.value = t.deltaIrradiance.texture;
          u.uScatteringOrder.value = k;
          this.draw(m.scatteringDensity, t.deltaScatteringDensity, layer);
        });
      }
      // Indirect irradiance for the previous order, into the delta and then
      // added to the accumulator.
      steps.push(() => {
        const u = m.irradiance.uniforms;
        u.uMode.value = 1;
        u.uTransmittance.value = t.transmittance.texture;
        u.uSingleRayleigh.value = t.deltaRayleigh.texture;
        u.uSingleMie.value = t.deltaMie.texture;
        u.uMultipleScattering.value = t.deltaRayleigh.texture;
        u.uScatteringOrder.value = k - 1;
        setAccumulating(m.irradiance, false);
        this.draw(m.irradiance, t.deltaIrradiance);
      });
      steps.push(() => {
        setAccumulating(m.irradiance, true);
        this.draw(m.irradiance, t.irradiance);
        setAccumulating(m.irradiance, false);
      });
      // The order's own scattering, then folded into the accumulator. The
      // multiple-scattering delta writes over the Rayleigh one — nothing reads
      // it again.
      for (let layer = 0; layer < layers; layer++) {
        steps.push(() => {
          m.multipleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
          m.multipleScattering.uniforms.uScatteringDensity.value = t.deltaScatteringDensity.texture;
          this.draw(m.multipleScattering, t.deltaRayleigh, layer);
        });
      }
      for (let layer = 0; layer < layers; layer++) {
        steps.push(() => {
          m.combine.uniforms.uMode.value = 1;
          m.combine.uniforms.uSourceA.value = t.deltaRayleigh.texture;
          setAccumulating(m.combine, true);
          this.draw(m.combine, t.scattering, layer);
          setAccumulating(m.combine, false);
        });
      }
    }

    return steps;
  }

  private draw(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget, layer = 0): void {
    const quad = this.quad!;
    quad.material = material;
    if (material.uniforms.uLayer) material.uniforms.uLayer.value = layer;
    this.renderer.setRenderTarget(target, layer);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.drawCount++;
  }

  private clear(target: THREE.WebGLRenderTarget, layer = 0): void {
    const prevColor = new THREE.Color();
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(prevColor);
    this.renderer.setRenderTarget(target, layer);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setClearColor(prevColor, prevAlpha);
  }

  /**
   * Read one transmittance sample and one scattering sample back through the
   * 8-bit blit and hold every channel against the CPU reference's value for the
   * same coordinate. A non-finite read, or any channel outside its band, fails
   * the whole tier for the session.
   *
   * Comparing against the reference rather than against the sample's own other
   * channels is what makes this a test: "blue exceeds red" is also true of a
   * table where two channels have clipped to the probe's ceiling, and of most
   * ways a parameter can be wrong.
   */
  private validate(params: AtmosphereParams, t: BakeTargets): boolean {
    const check = (
      label: string,
      read: readonly number[],
      expected: RGB,
      band: { min: number; max: number },
    ): boolean => {
      for (let c = 0; c < 3; c++) {
        const v = read[c];
        const ok = Number.isFinite(v) && v >= expected[c] * band.min && v <= expected[c] * band.max;
        if (!ok) {
          debugWarn('Atmosphere LUT sample outside its band', {
            label, channel: c, read: v, expected: expected[c], band,
          });
          return false;
        }
      }
      return true;
    };
    try {
      // Straight up from the ground: a real optical depth, and one the
      // reference integrates in well under a millisecond.
      const uv = transmittanceUvFromRMu(params, params.bottomRadius, 1, this.sizes);
      const tau = this.readSample({
        mode: 0, uv, params, scale: OPTICAL_DEPTH_PROBE_SCALE,
        transmittance: t.transmittance.texture,
      });
      const tauRef = opticalDepthToTopBoundary(
        params, params.bottomRadius, 1, VALIDATION_TRANSMITTANCE_SAMPLES,
      );
      if (!check('opticalDepth', tau, tauRef, OPTICAL_DEPTH_VALIDATION_BAND)) return false;

      // A sunlit sky ray a fifth of the way up the shell.
      const s = SCATTERING_VALIDATION_SAMPLE;
      const r = params.bottomRadius
        + s.altitudeFraction * (params.topRadius - params.bottomRadius);
      const uvwz = scatteringUvwzFromRMuMuSNu(params, r, s.mu, s.muS, s.nu, false, this.sizes);
      const coords = scatteringTexture3DCoords(uvwz, this.sizes);
      const sc = this.readSample({
        mode: 1,
        params,
        scattering: t.scattering.texture,
        uvw0: coords.uvw0,
        uvw1: coords.uvw1,
        nuLerp: coords.lerp,
        scale: SCATTERING_PROBE_SCALE,
      });
      const scRef = computeSingleScattering(
        params, r, s.mu, s.muS, s.nu, false,
        VALIDATION_SCATTERING_SAMPLES, VALIDATION_TRANSMITTANCE_SAMPLES,
      ).rayleigh;
      return check('singleScattering', sc, scRef, SCATTERING_VALIDATION_BAND);
    } catch (err) {
      debugWarn('Atmosphere LUT validation threw', { err: String(err) });
      return false;
    }
  }

  /**
   * One table sample, read back at 16-bit precision through two 8-bit blits.
   * A half-float `readRenderTargetPixels` is not an option: it ignores its
   * layer argument on a 3D target, and its readability gate can refuse a device
   * whose tables are perfectly good.
   */
  readSample(sample: {
    mode: 0 | 1 | 2 | 3;
    uv?: { u: number; v: number };
    transmittance?: THREE.Texture;
    scattering?: THREE.Texture;
    irradiance?: THREE.Texture;
    uvw0?: readonly [number, number, number];
    uvw1?: readonly [number, number, number];
    nuLerp?: number;
    /** Modes 2 and 3 evaluate shader code that reads the body's own
     *  parameters, so they need the same set the bake was given. */
    params?: AtmosphereParams;
    nu?: number;
    r?: number;
    muS?: number;
    scale: number;
  }): [number, number, number, number] {
    this.ensureMaterials();
    const probe = this.materials!.probe;
    if (sample.params) setAtmosphereUniforms(probe, sample.params);
    if (!this.probeTarget) {
      this.probeTarget = new THREE.WebGLRenderTarget(4, 4, {
        depthBuffer: false,
        stencilBuffer: false,
        samples: 0,
      });
    }
    probe.uniforms.uMode.value = sample.mode;
    probe.uniforms.uTransmittance.value = sample.transmittance ?? null;
    probe.uniforms.uScattering.value = sample.scattering ?? null;
    probe.uniforms.uIrradiance.value = sample.irradiance ?? null;
    probe.uniforms.uNu.value = sample.nu ?? 0;
    probe.uniforms.uProbeR.value = sample.r ?? 0;
    probe.uniforms.uProbeMuS.value = sample.muS ?? 0;
    if (sample.uv) (probe.uniforms.uUv.value as THREE.Vector2).set(sample.uv.u, sample.uv.v);
    if (sample.uvw0) {
      (probe.uniforms.uUvw0.value as THREE.Vector3).set(sample.uvw0[0], sample.uvw0[1], sample.uvw0[2]);
    }
    if (sample.uvw1) {
      (probe.uniforms.uUvw1.value as THREE.Vector3).set(sample.uvw1[0], sample.uvw1[1], sample.uvw1[2]);
    }
    probe.uniforms.uNuLerp.value = sample.nuLerp ?? 0;
    probe.uniforms.uScale.value = sample.scale;

    const prevTarget = this.renderer.getRenderTarget();
    const bytes = [new Uint8Array(4 * 16), new Uint8Array(4 * 16)];
    try {
      for (let b = 0; b < 2; b++) {
        probe.uniforms.uByte.value = b;
        this.draw(probe, this.probeTarget);
        this.renderer.readRenderTargetPixels(this.probeTarget, 0, 0, 4, 4, bytes[b]);
      }
    } finally {
      this.renderer.setRenderTarget(prevTarget);
    }
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      out[c] = (bytes[0][c] + bytes[1][c] / 255) / 255 / sample.scale;
    }
    return out;
  }
}

/** Range selector for the scattering probe. The readback window is [0, 1], and
 *  a channel that clips at the top is then compared against the ceiling rather
 *  than against the table: at 64 the validated sample's green and blue both
 *  read exactly 1/64 and the comparison silently became "red is below 1/64".
 *  Earth's sample is 0.012 / 0.028 / 0.079, so 8 leaves all three inside the
 *  window with room for the band around them. */
export const SCATTERING_PROBE_SCALE = 8;

/** Optical depth runs to ~22 on a horizon path, which this scale would clip.
 *  It is chosen for the ZENITH texel the validation reads (tau_red 0.083); a
 *  horizon sample needs the ranging ladder the check tool carries. */
export const OPTICAL_DEPTH_PROBE_SCALE = 1 / 16;

/** The one scattering texel the tier is validated on: a sunlit sky ray a fifth
 *  of the way up the shell, where every channel is clear of half-float's
 *  subnormals. Exported so a test can hold the probe scale against the value
 *  the CPU reference says will be read there. */
export const SCATTERING_VALIDATION_SAMPLE = {
  altitudeFraction: 0.2,
  mu: 0.4,
  muS: 0.8,
  nu: 0.3,
} as const;

/** How far a validated channel may sit from the CPU reference. The table
 *  carries every scattering order and the reference carries one, so the ceiling
 *  is generous by construction — Earth's four-order table reads 1.3-1.5x the
 *  reference here, and a brighter ground or thicker aerosol raises that — while
 *  the floor is what a black, clipped, half-written or wrongly scaled table
 *  falls through. The blue channel can reach the probe's ceiling before the
 *  band's top; red, an eighth of the way up the window, is what carries the
 *  upper test. */
export const SCATTERING_VALIDATION_BAND = { min: 0.5, max: 3.0 } as const;

/** Optical depth has no order structure — both sides integrate the same
 *  quantity — so the band is only the readback's own precision and the coarser
 *  sample count below. */
export const OPTICAL_DEPTH_VALIDATION_BAND = { min: 0.85, max: 1.15 } as const;

/** Sample counts for the reference integrals inside `validate()`. This runs on
 *  the device at the end of every bake, so it is coarser than the reference's
 *  own defaults — still far inside the bands above, and about a millisecond. */
const VALIDATION_TRANSMITTANCE_SAMPLES = 200;
const VALIDATION_SCATTERING_SAMPLES = 20;

/** Add the pass's output to whatever the target already holds. NOT three's
 *  AdditiveBlending: that is `blendFunc(SRC_ALPHA, ONE)` unless the material is
 *  premultiplied, and these passes write alpha 0 (the accumulator's alpha
 *  carries the single-Mie term and must not move), which would multiply every
 *  order past the first away to nothing. */
function setAccumulating(material: THREE.ShaderMaterial, on: boolean): void {
  if (!on) {
    material.blending = THREE.NoBlending;
    return;
  }
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Table profile by device class: full tables at four orders on a desktop,
 *  half tables at two on a touch device — most of the twilight for a quarter of
 *  the work and a quarter of the bytes. */
export function atmosphereLutProfile(touch: boolean): { sizes: AtmosphereTableSizes; orders: number } {
  return {
    sizes: touch ? ATMOSPHERE_TABLE_SIZES_HALF : ATMOSPHERE_TABLE_SIZES_FULL,
    orders: touch ? TOUCH_ORDERS : DESKTOP_ORDERS,
  };
}

/** A 2D table target. Exported so its configuration is pinned by a test: the
 *  wrong filter or a stray depth buffer is invisible until the limb bands. */
export function createTableTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return make2D(width, height);
}

/** A 3D table target — one output only. `WebGL3DRenderTarget` gives a
 *  `Data3DTexture` to slot 0 alone, so a `count > 1` target would attach a 2D
 *  texture with `framebufferTextureLayer` and write nothing. */
export function createScatteringTarget(sizes: AtmosphereTableSizes): THREE.WebGL3DRenderTarget {
  return make3D(scatteringTextureWidth(sizes), sizes.scatteringMu, sizes.scatteringR);
}

function make2D(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
  });
}

function make3D(width: number, height: number, depth: number): THREE.WebGL3DRenderTarget {
  return new THREE.WebGL3DRenderTarget(width, height, depth, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    // Both filters are passed explicitly: a render target only copies the ones
    // it is given, and a Data3DTexture is born Nearest on both.
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    wrapR: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 0,
  });
}

function targetBytes(target: THREE.WebGLRenderTarget, depth: number): number {
  const bytesPerTexel = target.texture.type === THREE.HalfFloatType ? 8 : 4;
  return target.width * target.height * depth * bytesPerTexel;
}

function commonUniforms(): Record<string, THREE.IUniform> {
  return {
    uBottomRadius: { value: 1 },
    uTopRadius: { value: 1 },
    uRayleighScattering: { value: new THREE.Vector3() },
    uMieScattering: { value: new THREE.Vector3() },
    uMieExtinction: { value: new THREE.Vector3() },
    uAbsorptionExtinction: { value: new THREE.Vector3() },
    uDensityLayers: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
    uDensityWidths: { value: new THREE.Vector3() },
    uMiePhaseG: { value: 0 },
    uGroundAlbedo: { value: 0 },
    uMuSMin: { value: -1 },
    uSunAngularRadius: { value: 0 },
    uLayer: { value: 0 },
  };
}

function setAtmosphereUniforms(material: THREE.ShaderMaterial, p: AtmosphereParams): void {
  const u = material.uniforms;
  u.uBottomRadius.value = p.bottomRadius;
  u.uTopRadius.value = p.topRadius;
  const setRGB = (v: THREE.Vector3, rgb: readonly [number, number, number]): void => {
    v.set(rgb[0], rgb[1], rgb[2]);
  };
  setRGB(u.uRayleighScattering.value as THREE.Vector3, p.rayleighScattering);
  setRGB(u.uMieScattering.value as THREE.Vector3, p.mieScattering);
  setRGB(u.uMieExtinction.value as THREE.Vector3, p.mieExtinction);
  setRGB(u.uAbsorptionExtinction.value as THREE.Vector3, p.absorptionExtinction);
  const layers = u.uDensityLayers.value as THREE.Vector4[];
  const profiles = [p.rayleighDensity, p.mieDensity, p.absorptionDensity];
  for (let i = 0; i < 3; i++) {
    for (let l = 0; l < 2; l++) {
      const layer = profiles[i][l];
      layers[i * 2 + l].set(layer.expTerm, layer.expScale, layer.linearTerm, layer.constantTerm);
    }
  }
  (u.uDensityWidths.value as THREE.Vector3).set(
    p.rayleighDensity[0].width, p.mieDensity[0].width, p.absorptionDensity[0].width,
  );
  u.uMiePhaseG.value = p.miePhaseG;
  u.uGroundAlbedo.value = p.groundAlbedo;
  u.uMuSMin.value = p.muSMin;
  u.uSunAngularRadius.value = p.sunAngularRadius;
}
