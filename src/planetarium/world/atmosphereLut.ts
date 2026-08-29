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
 * validated, never by waiting.
 *
 * A slice is sized by GPU COST, not by draw count. Submitting a layer draw is
 * 0.0-0.2 ms of main thread whatever the layer costs, so a budget measured on
 * the CPU cannot see the difference between eight transmittance quads and eight
 * scattering-density layers — and eight of the latter is 20 ms of GPU against a
 * 120 Hz frame's 8.33. Each pass therefore carries a relative weight, a timer
 * query measures one layer of each pass on the device before the first real
 * draw, and a slice takes as many draws as fit a share of the measured frame
 * interval. The submission budget stays as the CPU-side guard.
 *
 * The bake's own programs are deliberately outside the boot warm-up set —
 * nothing here draws until the tables exist — so a bake opens with a LINK
 * PHASE that compiles, links and primes ONE of them per frame before the first
 * layer draw. A link on a cold driver shader cache is tens of milliseconds of
 * main thread, and the seven of them landing on the frame that also submits
 * the first slice of draws is a 33 ms frame at the moment the bake arms. The
 * per-slice submission budget below covers draws alone.
 *
 * Scratch targets are disposed between bodies, and
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
  clampCosine,
  clampRadius,
  computeSingleScattering,
  opticalDepthToTopBoundary,
  rayIntersectsGround,
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

/** What one bake program's link cost, split so a frame's share of it is
 *  visible. `submitMs` and `primeMs` are main-thread time inside the link
 *  step's own frame; `readyMs` is wall time from the submission to the driver
 *  reporting the program ready, most of which a driver with
 *  KHR_parallel_shader_compile spends off the main thread. */
export interface AtmosphereLinkTiming {
  program: string;
  submitMs: number;
  primeMs: number;
  readyMs: number;
}

export interface AtmosphereBakeStats {
  body: string;
  /** Wall time from the first link to validation, including the frames the
   *  link phase and the slicing yielded to. */
  wallMs: number;
  /** Time actually spent submitting work, summed over the link steps and the
   *  draw slices. */
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
  /** Layer draws the cost probe ran ahead of the bake proper — two per pass it
   *  had no measurement for, and zero once the session has them all or the
   *  device has no timer query. They are included in `drawCalls`. */
  probeDraws: number;
  /** GPU ms one layer draw of each pass measured at, where a timer query
   *  answered. Empty on a device without EXT_disjoint_timer_query_webgl2. */
  measuredPassMs: Partial<Record<AtmospherePass, number>>;
  /** What the slice budget actually priced each pass at — the measured figure
   *  where there was one, the weight table's where there was not. */
  passCostsMs: Record<AtmospherePass, number>;
  /** One row per program linked before the first layer draw, in link order. A
   *  bake whose programs are all already linked — a second body, a repeat
   *  measurement — reads empty. */
  links: AtmosphereLinkTiming[];
}

/**
 * One unit of bake work, and all a frame may hold of it. A `link` step
 * compiles, links and primes exactly ONE bake program and draws no layers; a
 * `draw` step is one layer of one pass. Every link precedes every draw:
 * a cold driver link is tens of milliseconds of main thread, so the seven of
 * them landing on the frame that also submits the first eight layer draws is
 * one long dropped frame at the moment the bake arms.
 */
interface LinkStep {
  readonly kind: 'link';
  readonly program: string;
  run(): Promise<AtmosphereLinkTiming>;
}

interface DrawStep {
  readonly kind: 'draw';
  readonly pass: AtmospherePass;
  /** Whether running this draw a second time, before the bake proper, leaves
   *  the tables where it found them. The cost probe re-runs one draw per pass
   *  ahead of every real draw, so a probed draw must overwrite its target
   *  rather than add to it — an accumulating fold would count its order twice. */
  readonly probeSafe: boolean;
  run(): void;
}

type BakeStep = LinkStep | DrawStep;

export interface AtmosphereLutOptions {
  /** Touch-first devices bake half-size tables at two orders. */
  touch?: boolean;
  orders?: number;
  sizes?: AtmosphereTableSizes;
  /** Ceiling on the layer draws submitted per frame, above the cost budget's
   *  own limit. `Infinity` turns both off and bakes in one block, which is what
   *  a measurement harness wants and a boot never does. */
  drawsPerSlice?: number;
  /** The frame interval the slice budget is a share of, read once per slice.
   *  The mode passes its own smoothed interval; without one the budget assumes
   *  the fastest display it expects to meet. */
  frameIntervalMs?: () => number;
  /** False for a measurement instance, so it does not become the tier the rest
   *  of the app reads. */
  register?: boolean;
}

/** Scattering orders: four is where the twilight glow stops changing; two is
 *  most of it for a quarter of the work, which is the touch budget. */
const DESKTOP_ORDERS = 4;
const TOUCH_ORDERS = 2;
/** Ceiling on a slice's draw count, whatever the cost budget allows. The
 *  budget is what sizes a slice; this only stops an implausibly cheap cost
 *  estimate from turning one frame into the whole bake. */
const DEFAULT_DRAWS_PER_SLICE = 8;
/** Bakes in a row that produce no tables — a failed validation, a throw, or a
 *  context lost mid-flight — after which the session stops trying. Each retry
 *  costs a few hundred draws and 32 MiB of scratch on a device that has already
 *  shown it cannot hold them, and the analytic shell is a complete look. */
const MAX_CONSECUTIVE_BAKE_FAILURES = 3;
/** Submission budget per draw slice — draws only; a link step is a slice of its
 *  own. This is the CPU guard, and it cannot see the cost that actually sizes a
 *  slice: submitting a layer draw is 0.0-0.2 ms of main thread whether the GPU
 *  then spends 20 µs on it or a millisecond. It only stops a slice running long
 *  on a slow driver; ATMOSPHERE_PASS_WEIGHTS below is what bounds the GPU. */
const SLICE_SUBMIT_BUDGET_MS = 6;

/**
 * The bake's passes, priced one layer draw at a time.
 *
 * The slice budget needs a per-pass cost because the passes differ by two
 * orders of magnitude: the direct irradiance is a 64x16 quad, while one
 * scattering-density layer is a double angular integral over two 3D tables and
 * costs two hundred times as much. A fixed draw count spends the same frame
 * budget on eight of either, which is how the density block came to submit
 * 20 ms of GPU into a 120 Hz frame while the main thread showed 0.2 ms — and
 * the frame that was finally dropped was a later one, because a GPU that falls
 * behind surfaces the backlog downstream of what caused it.
 *
 * `combine` folds one order into the accumulator and `indirectIrradiance` runs
 * the irradiance program in its sky mode; both cost the same whether they
 * overwrite or accumulate, so each is one pass.
 */
export type AtmospherePass =
  | 'transmittance'
  | 'directIrradiance'
  | 'singleScattering'
  | 'combine'
  | 'scatteringDensity'
  | 'indirectIrradiance'
  | 'multipleScattering';

/**
 * Relative GPU cost of one layer draw of each pass, used until the device
 * measures itself. A device with EXT_disjoint_timer_query_webgl2 times one
 * layer of every pass before the bake's first real draw and prices the slices
 * from those microseconds instead; this table is what a device without the
 * extension — or one whose queries come back disjoint — plans with.
 *
 * Timed on an Apple GPU the ratios came out near 2 : 0.05 : 1.4 : 1 : 8 : 5 :
 * 1.4 in this order. The density anchor holds and the rest do not, by up to
 * four times either way, which is the whole reason a device that can time
 * itself does rather than trusting this.
 */
export const ATMOSPHERE_PASS_WEIGHTS: Readonly<Record<AtmospherePass, number>> = {
  transmittance: 1,
  directIrradiance: 1,
  singleScattering: 4,
  combine: 1,
  scatteringDensity: 8,
  indirectIrradiance: 2,
  multipleScattering: 6,
};

/** GPU ms one unit of weight is worth before anything has been measured, set so
 *  the table's heaviest pass prices at what one scattering-density layer
 *  measured at (2.0-2.8 ms on an Apple GPU through ANGLE/Metal). Deliberately
 *  not the cheaper reading: a device with no timer query is one nothing can
 *  size for, and guessing low buys bake wall time with dropped frames, while
 *  guessing high spends only wall time, behind a look that is already
 *  complete. */
export const ATMOSPHERE_UNIT_COST_MS = 0.25;

/** Share of the frame the bake's draws may hold on the GPU — the same figure
 *  and the same reasoning as the warm pump's WARM_BUDGET_FRACTION: a budget
 *  stated as a constant is a third of a 60 Hz frame and most of a 120 Hz one. */
export const BAKE_BUDGET_FRACTION = 0.35;
/** Frame intervals outside this band are a stalled tab or a broken sample, not
 *  a refresh rate; the same clamp the mode's own frame-interval EMA applies. */
const BAKE_INTERVAL_MIN_MS = 4;
const BAKE_INTERVAL_MAX_MS = 40;
/** Assumed when no interval is measurable. 120 Hz rather than 60: guessing the
 *  slower display hands a 120 Hz frame twice its share and drops it, while
 *  guessing the faster one costs a 60 Hz machine only bake wall time, spent
 *  behind a look that is already complete. */
export const BAKE_DEFAULT_INTERVAL_MS = 8.33;

/** The GPU time one slice of layer draws may hold, for a frame of this
 *  measured length. */
export function bakeSliceBudgetMs(frameIntervalMs: number): number {
  const interval = Number.isFinite(frameIntervalMs) && frameIntervalMs > 0
    ? Math.min(BAKE_INTERVAL_MAX_MS, Math.max(BAKE_INTERVAL_MIN_MS, frameIntervalMs))
    : BAKE_DEFAULT_INTERVAL_MS;
  return interval * BAKE_BUDGET_FRACTION;
}

/**
 * What one layer draw of each pass costs in ms: the measured figure where a
 * timer query returned one, and the pass's weight priced in ms where it did
 * not.
 *
 * The price of a weight unit comes from the passes that WERE measured — their
 * mean measured-ms-per-weight — so a device that timed only some of them still
 * plans the rest against its own speed rather than against a constant tuned on
 * another GPU. That derived price is never allowed BELOW the constant, though:
 * the queries a disjoint discards are whichever were in flight, so a probe can
 * come back holding the 64x16 irradiance quad and not the density layer, and a
 * unit priced off the quad alone would admit eight density layers to a slice —
 * the 20 ms frame this budget exists to prevent. Under-pricing an unmeasured
 * pass drops frames; over-pricing it costs bake wall time behind a complete
 * look, so the constant is a floor. With nothing measured at all it is the
 * price.
 */
export function bakePassCostsMs(
  measuredMs: Readonly<Partial<Record<AtmospherePass, number>>>,
): Record<AtmospherePass, number> {
  const passes = Object.keys(ATMOSPHERE_PASS_WEIGHTS) as AtmospherePass[];
  const usable = (pass: AtmospherePass): number | null => {
    const ms = measuredMs[pass];
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
  };
  let unit = ATMOSPHERE_UNIT_COST_MS;
  const ratios: number[] = [];
  for (const pass of passes) {
    const ms = usable(pass);
    if (ms !== null) ratios.push(ms / ATMOSPHERE_PASS_WEIGHTS[pass]);
  }
  if (ratios.length > 0) {
    unit = Math.max(ATMOSPHERE_UNIT_COST_MS, ratios.reduce((a, b) => a + b, 0) / ratios.length);
  }
  const costs = {} as Record<AtmospherePass, number>;
  for (const pass of passes) {
    costs[pass] = usable(pass) ?? ATMOSPHERE_PASS_WEIGHTS[pass] * unit;
  }
  return costs;
}

/**
 * How many of the coming layer draws a frame may take: as many as fit the
 * budget, and never fewer than one.
 *
 * The floor is not a rounding convenience. A pass whose single layer already
 * costs more than a whole frame's share would otherwise admit nothing, and the
 * bake would spin on a step it never runs.
 */
export function bakeSliceDrawCount(
  upcoming: readonly AtmospherePass[],
  costsMs: Readonly<Record<AtmospherePass, number>>,
  budgetMs: number,
  maxDraws: number,
): number {
  let spent = 0;
  let count = 0;
  while (count < upcoming.length && count < maxDraws) {
    const next = spent + costsMs[upcoming[count]];
    if (count > 0 && next > budgetMs) break;
    spent = next;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const BAKE_VERTEX = /* glsl */`
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * The lookup half of the model in GLSL: the parameters, the geometry, the table
 * addressing, the samplers and the phase functions. Transcribed from Bruneton's
 * reference model and kept in step with atmosphereModel.ts, which is what the
 * CPU comparison checks.
 *
 * Exported because every consumer of the tables — the bake's own passes, the
 * atmosphere shell, and anything later that reads air along a ray — must use
 * ONE text. The conventions here are not recoverable from the textures: the
 * transmittance table holds OPTICAL DEPTH (`T = exp(-texel)`, a segment is a
 * DIFFERENCE of two samples), the scattering table holds Rayleigh in rgb with
 * only the red Mie channel in alpha, both without their phase functions, and
 * the packed nu axis has to be interpolated by hand. A second transcription is
 * the one place those can be got wrong with no test noticing.
 *
 * Requires the table sizes as #defines (atmosphereTableDefines) and the uniform
 * block (atmosphereLookupUniforms + applyAtmosphereParams).
 */
const ATMOSPHERE_LOOKUP_PREAMBLE_GLSL = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

#define PI 3.141592653589793
`;

/**
 * The lookup GLSL without its precision block and PI define — the form for a
 * consumer that is INJECTED into a shader three already wrote a header for
 * (`augmentSurfaceMaterial`'s hook, the night-lights shell). Three declares
 * every sampler precision itself and `<common>` defines PI, and a macro
 * redefinition mid-shader is a redefinition however identical the text is.
 * A standalone consumer wants ATMOSPHERE_LOOKUP_GLSL, which is this with the
 * header back on.
 */
export const ATMOSPHERE_LOOKUP_BODY_GLSL = /* glsl */`
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

// --- transmittance table ---------------------------------------------------

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

// The nu axis is packed onto x next to mu_s, so a hardware fetch would filter
// across the seam between two nu slabs and two mu_s cells at once. Two fetches
// one slab apart and a hand lerp instead — the cost the whole layout is chosen
// against, and the reason a lookup is 2 fetches rather than 1.
vec4 getScattering3DRGBA(sampler3D tex, float r, float mu, float mu_s, float nu, bool hitsGround) {
  vec4 uvwz = getScatteringTextureUvwzFromRMuMuSNu(r, mu, mu_s, nu, hitsGround);
  float tex_coord_x = uvwz.x * float(SCATTERING_TEXTURE_NU_SIZE - 1);
  float tex_x = floor(tex_coord_x);
  float lerp = tex_coord_x - tex_x;
  vec3 uvw0 = vec3((tex_x + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  vec3 uvw1 = vec3((tex_x + 1.0 + uvwz.y) / float(SCATTERING_TEXTURE_NU_SIZE), uvwz.z, uvwz.w);
  return texture(tex, uvw0) * (1.0 - lerp) + texture(tex, uvw1) * lerp;
}

vec3 getScattering3D(sampler3D tex, float r, float mu, float mu_s, float nu, bool hitsGround) {
  return getScattering3DRGBA(tex, r, mu, mu_s, nu, hitsGround).rgb;
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

export const ATMOSPHERE_LOOKUP_GLSL = ATMOSPHERE_LOOKUP_PREAMBLE_GLSL + ATMOSPHERE_LOOKUP_BODY_GLSL;

/**
 * Aerial perspective: the air between the camera and a point in front of it,
 * for the surfaces that draw that point — the globe, its streamed sectors, the
 * cloud deck, the night-lights shell. The shell above handles the other half,
 * the rays that miss every surface.
 *
 * The tables hold the whole path from a point to the far boundary, so a SEGMENT
 * is the difference of two lookups, one at each end, with the far one carried
 * back through the segment's own transmittance. `color * T + S` is the whole
 * contract: a multiplicative layer applies both, an ADDITIVE layer over a
 * surface applies T alone, because the surface underneath already added S.
 *
 * Needs ATMOSPHERE_LOOKUP_BODY_GLSL (or ATMOSPHERE_LOOKUP_GLSL) ahead of it,
 * the table sizes as #defines, and the uniform block filled.
 *
 * `aerialSegmentRay` below is `aerialSegment` in TypeScript, so the one part of
 * this a unit test can reach — where the segment starts, how long it is, which
 * half of the folded mu axis it reads — is held against the module's own
 * reference integral rather than against a re-recorded capture.
 */
export const AERIAL_PERSPECTIVE_GLSL = /* glsl */`
struct AerialSegment {
  bool valid;
  bool hitsGround;
  // Where the segment STARTS — the atmosphere entry point, not the camera —
  // and its three angles re-derived there.
  float r;
  float mu;
  float muS;
  float nu;
  float d;        // entry point -> the point being shaded
  // The start point and direction the angles were derived from, kept so a
  // SECOND light can be pointed at the same segment without tracing it again.
  vec3 origin;
  vec3 view;
};

// The segment from the camera to the point, both in the radius units the
// tables are baked in (surface r = 1) about the body's centre, in any frame the
// two and the Sun share.
AerialSegment aerialSegment(vec3 camera, vec3 point, vec3 sunDir) {
  AerialSegment seg = AerialSegment(
      false, false, 0.0, 0.0, 0.0, 0.0, 0.0, vec3(0.0), vec3(0.0));
  vec3 toPoint = point - camera;
  float span = length(toPoint);
  // A degenerate segment has no direction to normalize; normalize(0) is
  // undefined and reads as NaN on Metal.
  if (!(span > 0.0)) return seg;
  vec3 view = toPoint / span;
  float r = length(camera);
  if (!(r > 0.0)) return seg;
  float rmu = dot(camera, view);

  if (r > uTopRadius) {
    // The viewer is in space, which is every pose the app can steer to: the
    // camera floor and the landed eye are both above the modelled top. Look the
    // table up at the camera's own radius and every ray clamps to its top row.
    float disc = rmu * rmu - r * r + uTopRadius * uTopRadius;
    if (disc < 0.0) return seg;                 // the ray misses the air
    float dEntry = -rmu - sqrt(disc);
    if (dEntry <= 0.0 || dEntry >= span) return seg;
    camera += view * dEntry;
    // r*mu at the entry point is exactly -sqrt(disc): written that way it stays
    // a number of size ~0.2 rather than a difference of two of size r.
    rmu = -sqrt(disc);
    r = uTopRadius;
    span -= dEntry;
  } else {
    r = clampRadius(r);
  }

  seg.valid = true;
  seg.origin = camera;
  seg.view = view;
  seg.r = r;
  seg.mu = clampCosine(rmu / r);
  seg.muS = clampCosine(dot(camera, sunDir) / r);
  seg.nu = clampCosine(dot(view, sunDir));
  seg.d = span;
  seg.hitsGround = rayIntersectsGround(r, seg.mu);
  return seg;
}

/** The same segment under a different light. The geometry — where it starts,
 *  how far it runs, which way it faces — belongs to the camera and does not
 *  move; only the two angles that involve the source do. So a second source
 *  costs a second pair of lookups and no second traversal, and the two sources
 *  can never disagree about the path they are lighting. */
AerialSegment aerialForLight(AerialSegment seg, vec3 lightDir) {
  seg.muS = clampCosine(dot(seg.origin, lightDir) / seg.r);
  seg.nu = clampCosine(dot(seg.view, lightDir));
  return seg;
}

/** What survives the segment: the fraction of the surface's own light that
 *  reaches the camera. A difference of two optical depths, never a quotient of
 *  two transmittances. */
vec3 aerialTransmittance(sampler2D tex, AerialSegment seg) {
  return getTransmittance(tex, seg.r, seg.mu, seg.d, seg.hitsGround);
}

/** What the segment adds: sunlight scattered into it, at one unit of solar
 *  irradiance. The caller scales it by the body's own irradiance and by the
 *  bridge to the scene's light. */
vec3 aerialInscatter(sampler3D tex, AerialSegment seg, vec3 transmittance) {
  vec4 nearEnd = getScattering3DRGBA(tex, seg.r, seg.mu, seg.muS, seg.nu, seg.hitsGround);
  float rP = clampRadius(safeSqrt(seg.d * seg.d + 2.0 * seg.r * seg.mu * seg.d + seg.r * seg.r));
  float muP = clampCosine((seg.r * seg.mu + seg.d) / rP);
  float muSP = clampCosine((seg.r * seg.muS + seg.d * seg.nu) / rP);
  vec4 farEnd = getScattering3DRGBA(tex, rP, muP, muSP, seg.nu, seg.hitsGround);
  // Interpolation can push the difference the wrong side of zero where the two
  // ends nearly coincide; the Mie recovery divides by the red channel, so a
  // negative there comes back as coloured speckle rather than as nothing.
  vec4 delta = vec4(max(nearEnd.rgb - transmittance * farEnd.rgb, vec3(0.0)),
                    max(nearEnd.a - transmittance.r * farEnd.a, 0.0));
  vec3 mie = getExtrapolatedSingleMieScattering(delta);
  // Mie's lobe is aimed at the Sun. Below the horizon there is no lobe left to
  // aim, and the difference form's residue reads as a bright seam.
  mie *= smoothstep(0.0, 0.01, seg.muS);
  return delta.rgb * rayleighPhaseFunction(seg.nu)
      + mie * miePhaseFunction(uMiePhaseG, seg.nu);
}
`;

// ---------------------------------------------------------------------------
// The segment setup, in TypeScript
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where a camera-to-point segment lands in the tables. The same fields
 *  `AerialSegment` carries in GLSL, in the same order. */
export interface AerialSegmentRay {
  /** False for a segment the tables describe nothing of: the ray misses the
   *  air, the air is behind the camera, or the two ends coincide. */
  readonly valid: boolean;
  readonly hitsGround: boolean;
  /** The four table coordinates, AT THE ENTRY POINT. */
  readonly r: number;
  readonly mu: number;
  readonly muS: number;
  readonly nu: number;
  /** Entry point -> the point being shaded, in radius units. */
  readonly d: number;
  readonly origin: Vec3;
  readonly view: Vec3;
}

/**
 * Mirrors `aerialSegment` in AERIAL_PERSPECTIVE_GLSL line for line, in the
 * frame the shader works in: the body's own, radius units, origin at its
 * centre. A shader cannot be unit-tested and this can, so the two are kept in
 * step by hand.
 *
 * Three things here exist nowhere else in the app and are what a test can
 * reach: the segment LENGTH (the tables hold whole paths to the boundary, so a
 * segment is a difference and its length is the only thing that says which
 * difference), the `hitsGround` flag that picks which half of the folded mu
 * axis both ends are read from, and the `dEntry >= span` reject for a point
 * the ray reaches before the air does.
 */
export function aerialSegmentRay(
  params: AtmosphereParams,
  camera: Vec3,
  point: Vec3,
  sun: Vec3,
): AerialSegmentRay {
  const miss: AerialSegmentRay = {
    valid: false, hitsGround: false, r: 0, mu: 0, muS: 0, nu: 0, d: 0,
    origin: [0, 0, 0], view: [0, 0, 0],
  };
  const toPoint: Vec3 = [point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]];
  let span = Math.sqrt(dot3(toPoint, toPoint));
  // A degenerate segment has no direction to normalize; normalize(0) is
  // undefined and reads as NaN on Metal.
  if (!(span > 0)) return miss;
  const view: Vec3 = [toPoint[0] / span, toPoint[1] / span, toPoint[2] / span];
  let origin = camera;
  let r = Math.sqrt(dot3(origin, origin));
  if (!(r > 0)) return miss;
  let rmu = dot3(origin, view);

  if (r > params.topRadius) {
    const disc = rmu * rmu - r * r + params.topRadius * params.topRadius;
    if (disc < 0) return miss;                    // the ray misses the air
    const dEntry = -rmu - Math.sqrt(disc);
    if (dEntry <= 0 || dEntry >= span) return miss;
    origin = [
      origin[0] + view[0] * dEntry,
      origin[1] + view[1] * dEntry,
      origin[2] + view[2] * dEntry,
    ];
    // r*mu at the entry point is exactly -sqrt(disc): written that way it stays
    // a number of size ~0.2 rather than a difference of two of size r.
    rmu = -Math.sqrt(disc);
    r = params.topRadius;
    span -= dEntry;
  } else {
    r = clampRadius(params, r);
  }

  const mu = clampCosine(rmu / r);
  return {
    valid: true,
    hitsGround: rayIntersectsGround(params, r, mu),
    r,
    mu,
    muS: clampCosine(dot3(origin, sun) / r),
    nu: clampCosine(dot3(view, sun)),
    d: span,
    origin,
    view,
  };
}

/** The bake's own numerical integrals. Only the passes that WRITE a table need
 *  them; a consumer that reads the tables must never carry a 500-iteration loop
 *  into a per-pixel shader. */
const BAKE_INTEGRALS_GLSL = /* glsl */`
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
`;

const BAKE_COMMON = ATMOSPHERE_LOOKUP_GLSL + BAKE_INTEGRALS_GLSL;

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

/**
 * The table dimensions THIS session addresses. One profile is chosen per
 * session (by device class, in the baker's constructor) and the addressing GLSL
 * takes them as #defines, so every material that can ever sample these tables
 * has to compile with the same set or the program cache forks — and a material
 * that compiled with the other set would read the table at the wrong stride.
 *
 * Read at material-construction time, which is after the baker exists: the
 * Planetarium builds it in its own constructor, before any body is built. The
 * full profile is the answer before then and on a device with no tier at all,
 * where the samplers are dummies and nothing reads them anyway.
 */
export function atmosphereSessionSizes(): AtmosphereTableSizes {
  return activeLut?.sizes ?? ATMOSPHERE_TABLE_SIZES_FULL;
}

export class AtmosphereLut {
  readonly sizes: AtmosphereTableSizes;
  readonly orders: number;
  private readonly drawsPerSlice: number;
  private readonly frameIntervalMs: () => number;
  /** Measured GPU ms for one layer draw of each pass, filled by the cost probe
   *  and kept for the session: the figure describes the device and the table
   *  sizes, so a second body plans against the first body's measurements.
   *  Cleared with the context, whose programs it describes. */
  private measuredPassMs: Partial<Record<AtmospherePass, number>> = {};
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
  /** The 1x1 throwaway the link phase compiles and primes against. Never one
   *  of the tables: the prime draw writes a pixel. */
  private linkTarget: THREE.WebGLRenderTarget | null = null;
  /** Bake materials whose program is linked and primed against the live
   *  context. Cleared when that context goes, because the programs go with it. */
  private readonly linked = new Set<THREE.ShaderMaterial>();
  private capable: boolean | null = null;
  private capableMs: number | null = null;
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
    this.frameIntervalMs = options.frameIntervalMs ?? (() => BAKE_DEFAULT_INTERVAL_MS);
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

  /** Run the probe now, cached for the session. The boot warm-up asks before
   *  any bake: a consumer of the tables has to link its program under the load
   *  screen or pay the link mid-flight, and on a device with no tier that link
   *  would be for a material that can never draw. */
  probeCapability(): boolean {
    if (this.capable === null) {
      const started = performance.now();
      this.capable = canGPUDoAtmosphereLut(this.renderer);
      this.capableMs = performance.now() - started;
    }
    return this.capable;
  }

  /** Main-thread ms the probe cost, or null until it has run. It renders into a
   *  3D layer and reads it straight back, which flushes the pipeline, so the
   *  caller gives it a frame with nothing else in it. */
  get probeMs(): number | null {
    return this.capableMs;
  }

  stats(): readonly AtmosphereBakeStats[] {
    return this.bakeStats;
  }

  /** The step list a bake of `body` would run, as kinds, program names and the
   *  pass each draw belongs to. The ordering contract — every link before every
   *  draw, one program to a step — and the pass tagging the slice budget prices
   *  against are what a test can hold this to without a GPU. Builds and drops
   *  the bake's targets, which allocate nothing until a draw binds them. */
  bakeStepPlan(body: string): Array<{
    kind: 'link' | 'draw';
    program: string;
    pass: AtmospherePass | '';
    probeSafe: boolean;
  }> {
    this.ensureMaterials();
    const targets = this.createTargets();
    try {
      return this.buildSteps(atmosphereParams(body), targets).map((step) => ({
        kind: step.kind,
        program: step.kind === 'link' ? step.program : '',
        pass: step.kind === 'draw' ? step.pass : '',
        probeSafe: step.kind === 'draw' && step.probeSafe,
      }));
    } finally {
      this.disposeResident(targets);
    }
  }

  /**
   * GPU bytes this tier is holding right now, render-target by render-target:
   * the resident tables of every body that has baked (8.1 MiB at the full
   * sizes, 2.0 at the half ones) plus, only while a bake is in flight, the
   * four 3D scratch targets and the one 2D that take the peak to ~32 MiB.
   *
   * It is a live figure rather than a constant because both halves move: the
   * tier may be unavailable for the whole session (0), and a device that
   * refuses a rung during the bake window is refusing it against a real 32 MiB
   * that is really allocated. The mode adds this to the ladder's own weight so
   * the tables, the globe maps and the sector tiles are one envelope — the
   * tables are not releasable, so they are a floor the maps give way to rather
   * than a competitor for the release planner.
   */
  gpuBytes(): number {
    return this.liveBytes;
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
    if (!this.probeCapability()) return false;

    const generation = this.generation;
    const params = atmosphereParams(body);
    const wallStart = performance.now();
    const programsBefore = this.renderer.info.programs?.length ?? 0;
    const drawsBefore = this.drawCount;
    let submitMs = 0;
    let slices = 0;
    let probeDraws = 0;
    const links: AtmosphereLinkTiming[] = [];
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
        probeDraws,
        measuredPassMs: { ...this.measuredPassMs },
        passCostsMs: bakePassCostsMs(this.measuredPassMs),
        links: [...links],
      });
    };
    try {
      this.ensureMaterials();
      targets = this.createTargets();
      const steps = this.buildSteps(params, targets);
      let i = 0;
      // Link phase. One program per frame and nothing else on it: a link on a
      // cold driver shader cache is tens of milliseconds of main thread, and
      // the frame that pays seven of them is the hitch this phase exists to
      // remove. Layer draws only start once every program is linked, so no
      // draw can be the one that waits a link out.
      while (i < steps.length) {
        const step = steps[i];
        if (step.kind !== 'link') break;
        if (this.disposed || this.contextLost || generation !== this.generation) {
          record(false, true);
          return false;
        }
        const timing = await step.run();
        links.push(timing);
        submitMs += timing.submitMs + timing.primeMs;
        i++;
        slices++;
        // A frame of its own for every step, including the last: a warm shader
        // cache answers ready inside the same task, and without this the whole
        // phase collapses back into the one frame it exists to spread.
        await nextFrame();
      }
      // Cost probe. One layer of each pass, timed on the GPU, so the slices
      // below are sized by what this device actually spends.
      probeDraws = await this.measurePassCosts(steps, generation);
      if (this.disposed || this.contextLost || generation !== this.generation) {
        record(false, true);
        return false;
      }
      // Draw phase. The submission budget now covers draws alone, and the cost
      // budget — not the draw count — is what decides how many fit.
      while (i < steps.length) {
        if (this.disposed || this.contextLost || generation !== this.generation) {
          record(false, true);
          return false;
        }
        const allowed = this.sliceDrawCount(steps, i);
        const sliceStart = performance.now();
        const prevTarget = this.renderer.getRenderTarget();
        const prevAutoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        let inSlice = 0;
        try {
          while (
            i < steps.length
            && inSlice < allowed
            && performance.now() - sliceStart < SLICE_SUBMIT_BUDGET_MS
          ) {
            const step = steps[i];
            if (step.kind !== 'draw') break;
            step.run();
            i++;
            inSlice++;
          }
        } finally {
          this.renderer.autoClear = prevAutoClear;
          this.renderer.setRenderTarget(prevTarget);
        }
        submitMs += performance.now() - sliceStart;
        slices++;
        // Links all precede draws, so a slice always takes at least one step.
        // The guard stays because the cost of being wrong is a boot idle that
        // spins on a step it will not run.
        if (inSlice === 0) break;
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
    this.capableMs = null;
    // The measurements describe programs that died with the context, and the
    // restore may land on a different GPU entirely (a driver reset, a switch
    // off the discrete card): the re-bake measures again.
    this.measuredPassMs = {};
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
    this.linked.clear();
    this.quad?.geometry.dispose();
    this.quad = null;
    this.quadScene = new THREE.Scene();
    this.probeTarget = null;
    this.linkTarget = null;
    for (const body of [...this.requested]) void this.bake(body);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.dropReady();
    if (this.materials) for (const m of Object.values(this.materials)) m.dispose();
    this.materials = null;
    this.linked.clear();
    this.quad?.geometry.dispose();
    this.quad = null;
    this.probeTarget?.dispose();
    this.probeTarget = null;
    this.linkTarget?.dispose();
    this.linkTarget = null;
    if (activeLut === this) activeLut = null;
  }

  // -- internals ------------------------------------------------------------

  private defines(): Record<string, string> {
    return atmosphereTableDefines(this.sizes);
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

  /**
   * Time one layer draw of each pass, before the bake's first real draw, so
   * the slice budget prices THIS GPU instead of a weight table measured on
   * another one. Nothing to do once the session has every pass, and nothing to
   * do on a device without the timer query — the weights stand.
   *
   * The probe re-runs real draws rather than synthetic ones, so every pass is
   * timed with the tables it will really sample: bind a 1x1 placeholder instead
   * and the density pass's billion dependent fetches all hit cache, which is
   * the one number that must not be optimistic. Re-running is safe because the
   * probe precedes every real draw and each of those overwrites the layer it
   * lands on — which is also why only `probeSafe` draws are eligible: a draw
   * that accumulates would fold its order in twice.
   *
   * Each pass is drawn twice and only the second draw is timed. The first is
   * where the driver builds the pipeline state for this program against a
   * half-float table — the link phase primes against a 1x1 8-bit target, which
   * does not key the same — and it measures two to eight times the steady-state
   * cost. Believing that reading would price every later slice of the pass off
   * a cost that is paid once.
   *
   * A timed draw gets a frame to itself and nothing else on it. Two draws in
   * one frame read wrong in both directions on a tile GPU — a repeat of the
   * same draw waits out its predecessor behind a write-after-write barrier and
   * the query times the wait too, while a different draw after the query closes
   * still lands in the same command encoder and leaks into its result. So the
   * probe is two rounds of one draw per frame: every pass warmed, then every
   * pass timed, the same one-cost-to-a-frame shape as the link phase.
   */
  private async measurePassCosts(
    steps: readonly BakeStep[],
    generation: number,
  ): Promise<number> {
    if (!Number.isFinite(this.drawsPerSlice)) return 0;
    const probes = new Map<AtmospherePass, DrawStep>();
    for (const step of steps) {
      if (step.kind !== 'draw' || !step.probeSafe) continue;
      if (this.measuredPassMs[step.pass] !== undefined || probes.has(step.pass)) continue;
      probes.set(step.pass, step);
    }
    if (probes.size === 0) return 0;
    const timer = GpuPassTimer.create(this.renderer);
    if (!timer) return 0;
    const measured = new Map<string, number>();
    let drawn = 0;
    for (const round of ['warm', 'time'] as const) {
      for (const [pass, step] of probes) {
        if (this.disposed || this.contextLost || generation !== this.generation) break;
        const timing = round === 'time' && timer.begin(pass);
        const prevTarget = this.renderer.getRenderTarget();
        const prevAutoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        try {
          step.run();
        } finally {
          if (timing) timer.end();
          this.renderer.autoClear = prevAutoClear;
          this.renderer.setRenderTarget(prevTarget);
        }
        drawn++;
        await nextFrame();
        timer.poll(measured);
      }
    }
    await timer.drain(measured);
    for (const [pass, ms] of measured) {
      this.measuredPassMs[pass as AtmospherePass] = ms;
    }
    return drawn;
  }

  /** How many of the draws from `from` this frame may submit: the cost budget's
   *  answer, under the draw-count ceiling. A non-finite ceiling is the
   *  measurement harness asking for the whole bake in one block, and turns the
   *  budget off with it. */
  private sliceDrawCount(steps: readonly BakeStep[], from: number): number {
    if (!Number.isFinite(this.drawsPerSlice)) return steps.length - from;
    const maxDraws = Math.max(1, Math.floor(this.drawsPerSlice));
    const upcoming: AtmospherePass[] = [];
    for (let j = from; j < steps.length && upcoming.length < maxDraws; j++) {
      const step = steps[j];
      if (step.kind !== 'draw') break;
      upcoming.push(step.pass);
    }
    return bakeSliceDrawCount(
      upcoming,
      bakePassCostsMs(this.measuredPassMs),
      bakeSliceBudgetMs(this.frameIntervalMs()),
      maxDraws,
    );
  }

  /** The link steps, then one thunk per draw in Bruneton's order. Each draw is
   *  one layer of one pass, so the frame slicing has somewhere to cut. */
  private buildSteps(params: AtmosphereParams, t: BakeTargets): BakeStep[] {
    const m = this.materials!;
    const steps: BakeStep[] = [];
    const draws: DrawStep[] = [];
    const layers = this.sizes.scatteringR;
    const push = (pass: AtmospherePass, probeSafe: boolean, run: () => void): void => {
      draws.push({ kind: 'draw', pass, probeSafe, run });
    };

    for (const mat of [m.transmittance, m.singleScattering, m.irradiance,
      m.scatteringDensity, m.multipleScattering, m.combine]) {
      setAtmosphereUniforms(mat, params);
    }

    // Every program this bake will draw with, in first-use order, plus the
    // probe its validation reads back through. A program already linked
    // against the live context — a second body, a re-bake — has nothing left
    // to pay and gets no step.
    const programs: Array<[string, THREE.ShaderMaterial]> = [
      ['transmittance', m.transmittance],
      ['irradiance', m.irradiance],
      ['singleScattering', m.singleScattering],
      ['combine', m.combine],
    ];
    if (this.orders >= 2) {
      programs.push(['scatteringDensity', m.scatteringDensity]);
      programs.push(['multipleScattering', m.multipleScattering]);
    }
    programs.push(['probe', m.probe]);
    for (const [program, material] of programs) {
      if (!this.linked.has(material)) steps.push(this.linkStep(program, material));
    }

    // Transmittance, and a cleared irradiance accumulator: the accumulator holds
    // the SKY's irradiance only, so the direct term never enters it.
    push('transmittance', true, () => {
      this.clear(t.irradiance);
      this.draw(m.transmittance, t.transmittance);
    });

    push('directIrradiance', true, () => {
      m.irradiance.uniforms.uMode.value = 0;
      m.irradiance.uniforms.uTransmittance.value = t.transmittance.texture;
      this.draw(m.irradiance, t.deltaIrradiance);
    });

    // Single scattering: the two deltas the density pass needs, then the
    // accumulator's combined layout.
    m.singleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
    for (const [mode, target] of [[0, t.deltaRayleigh], [1, t.deltaMie]] as const) {
      for (let layer = 0; layer < layers; layer++) {
        push('singleScattering', true, () => {
          m.singleScattering.uniforms.uMode.value = mode;
          m.singleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
          this.draw(m.singleScattering, target, layer);
        });
      }
    }
    for (let layer = 0; layer < layers; layer++) {
      push('combine', true, () => {
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
        push('scatteringDensity', true, () => {
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
      push('indirectIrradiance', true, () => {
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
      push('indirectIrradiance', false, () => {
        setAccumulating(m.irradiance, true);
        this.draw(m.irradiance, t.irradiance);
        setAccumulating(m.irradiance, false);
      });
      // The order's own scattering, then folded into the accumulator. The
      // multiple-scattering delta writes over the Rayleigh one — nothing reads
      // it again.
      for (let layer = 0; layer < layers; layer++) {
        push('multipleScattering', true, () => {
          m.multipleScattering.uniforms.uTransmittance.value = t.transmittance.texture;
          m.multipleScattering.uniforms.uScatteringDensity.value = t.deltaScatteringDensity.texture;
          this.draw(m.multipleScattering, t.deltaRayleigh, layer);
        });
      }
      for (let layer = 0; layer < layers; layer++) {
        push('combine', false, () => {
          m.combine.uniforms.uMode.value = 1;
          m.combine.uniforms.uSourceA.value = t.deltaRayleigh.texture;
          setAccumulating(m.combine, true);
          this.draw(m.combine, t.scattering, layer);
          setAccumulating(m.combine, false);
        });
      }
    }

    steps.push(...draws);
    return steps;
  }

  /**
   * Compile, link and prime ONE bake program, against a 1x1 throwaway target.
   *
   * A render target must be bound for it: bound-versus-canvas is part of
   * three's program key and every bake pass draws into a target, so a compile
   * with the canvas bound would link a program no bake draw can use. Only
   * bound-versus-canvas enters the key — not the target's size or format — so
   * one 1x1 8-bit target keys like every table.
   *
   * Then a 1-pixel draw. The compile only submits the link; three fetches the
   * program's uniform locations on the program's first draw, and on a driver
   * without KHR_parallel_shader_compile that first draw is also where the link
   * itself is waited out. Paying both here keeps them off the layer draws.
   */
  private linkStep(program: string, material: THREE.ShaderMaterial): LinkStep {
    return {
      kind: 'link',
      program,
      run: async (): Promise<AtmosphereLinkTiming> => {
        const started = performance.now();
        const target = this.ensureLinkTarget();
        this.quad!.material = material;
        const prevSubmit = this.renderer.getRenderTarget();
        let ready: Promise<unknown>;
        try {
          this.renderer.setRenderTarget(target);
          ready = this.renderer.compileAsync(this.quadScene, this.quadCamera);
        } finally {
          this.renderer.setRenderTarget(prevSubmit);
        }
        const submitMs = performance.now() - started;
        // Off the main thread where the parallel-compile extension exists;
        // where it does not, three reports ready at once and the prime draw
        // below is what actually waits the link out.
        await ready;
        const readyMs = performance.now() - started;
        const primeStart = performance.now();
        // Frames ran during the await, so the bound target is read again here
        // rather than carried across it.
        const prevPrime = this.renderer.getRenderTarget();
        try {
          this.quad!.material = material;
          this.renderer.setRenderTarget(target);
          this.renderer.render(this.quadScene, this.quadCamera);
        } finally {
          this.renderer.setRenderTarget(prevPrime);
        }
        this.linked.add(material);
        return { program, submitMs, primeMs: performance.now() - primeStart, readyMs };
      },
    };
  }

  private ensureLinkTarget(): THREE.WebGLRenderTarget {
    if (!this.linkTarget) {
      this.linkTarget = new THREE.WebGLRenderTarget(1, 1, {
        depthBuffer: false,
        stencilBuffer: false,
        samples: 0,
      });
    }
    return this.linkTarget;
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

/** Frames a finished query is given to become readable before the pass is
 *  written off as unmeasurable. A retired draw normally answers on the next
 *  one; anything still pending after this is a driver that will not be waited
 *  for on the boot idle. */
const GPU_QUERY_POLL_FRAMES = 4;

/**
 * GPU timer queries through EXT_disjoint_timer_query_webgl2, one open at a
 * time and any number in flight.
 *
 * The extension is optional — some drivers never expose it and Chrome withdraws
 * it on others — so every caller must have an answer for a missing reading. A
 * result may also come back DISJOINT, which does not mean the draw was slow:
 * the GPU was interrupted while the query ran and the number describes the
 * interruption. Those are discarded rather than believed, because one wrong
 * large reading would size every later slice from it.
 *
 * Only one query may be OPEN at a time, but a closed one may be read whenever
 * the GPU has retired its work, so the probe opens one per frame and collects
 * them all afterwards rather than waiting out each in turn.
 */
class GpuPassTimer {
  private open: WebGLQuery | null = null;
  private readonly inFlight: Array<{ key: string; query: WebGLQuery }> = [];

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly timeElapsed: number,
    private readonly gpuDisjoint: number,
  ) {}

  static create(renderer: THREE.WebGLRenderer): GpuPassTimer | null {
    const gl = renderer.getContext() as WebGL2RenderingContext | null;
    if (!gl || typeof gl.createQuery !== 'function' || gl.isContextLost()) return null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
      { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext) return null;
    return new GpuPassTimer(gl, ext.TIME_ELAPSED_EXT, ext.GPU_DISJOINT_EXT);
  }

  /** Open a query around the draws that follow. False when the driver would
   *  not give one, in which case `end` must not be called. */
  begin(key: string): boolean {
    if (this.open) return false;
    const query = this.gl.createQuery();
    if (!query) return false;
    this.gl.beginQuery(this.timeElapsed, query);
    this.open = query;
    this.inFlight.push({ key, query });
    return true;
  }

  end(): void {
    if (!this.open) return;
    this.gl.endQuery(this.timeElapsed);
    this.open = null;
  }

  /**
   * Read whatever has become readable since the last call, keyed as it was
   * opened. Must be called every frame the probe runs: reading GPU_DISJOINT_EXT
   * CLEARS it, so the flag only means "a disjoint since you last looked" — poll
   * it once at the end of a seven-frame probe and one interruption anywhere in
   * those frames voids every reading taken.
   *
   * A disjoint therefore discards the queries still in flight, which are the
   * only ones it could have spanned, and keeps the results already banked.
   */
  poll(into: Map<string, number>): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (gl.getParameter(this.gpuDisjoint)) {
      for (const { query } of this.inFlight) gl.deleteQuery(query);
      this.inFlight.length = 0;
      return;
    }
    for (let i = this.inFlight.length - 1; i >= 0; i--) {
      const { key, query } = this.inFlight[i];
      if (query === this.open) continue;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      this.inFlight.splice(i, 1);
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      gl.deleteQuery(query);
      if (Number.isFinite(ns) && ns > 0) into.set(key, ns / 1e6);
    }
  }

  /**
   * Poll across a few more frames for the queries still outstanding, then give
   * up on them. Never blocks: the answer exists only once the GPU has retired
   * the work, and waiting for it on the main thread would cost the frame this
   * whole mechanism exists to protect. A pass left unread keeps the weight
   * table's estimate.
   */
  async drain(into: Map<string, number>): Promise<void> {
    try {
      for (let frame = 0; frame < GPU_QUERY_POLL_FRAMES && this.inFlight.length > 0; frame++) {
        await nextFrame();
        this.poll(into);
      }
    } finally {
      if (!this.gl.isContextLost()) {
        for (const { query } of this.inFlight) this.gl.deleteQuery(query);
      }
      this.inFlight.length = 0;
    }
  }
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

/**
 * What one profile's tier costs in GPU memory: `resident`, the three tables a
 * baked body keeps for the session, and `bakePeak`, what is allocated while a
 * bake runs — the resident three plus the four scratch targets Bruneton's
 * recurrence needs live at once.
 *
 * Arithmetic only, from the sizes. The live figure the memory envelope reads
 * is `AtmosphereLut.gpuBytes()`, which counts the render targets that actually
 * exist; this is the same number stated ahead of time, for a budget written
 * down before a device has baked anything. atmosphereLut.test.ts pins the two
 * against the targets the bake really creates.
 */
export function atmosphereTierGpuBytes(
  sizes: AtmosphereTableSizes,
): { resident: number; bakePeak: number } {
  const HALF_FLOAT_RGBA = 8;
  const table2D = (w: number, h: number): number => w * h * HALF_FLOAT_RGBA;
  const table3D = (): number =>
    scatteringTextureWidth(sizes) * sizes.scatteringMu * sizes.scatteringR * HALF_FLOAT_RGBA;
  const resident = table2D(sizes.transmittanceW, sizes.transmittanceH)
    + table2D(sizes.irradianceW, sizes.irradianceH)
    + table3D();
  // deltaIrradiance (2D) + deltaRayleigh, deltaMie, deltaScatteringDensity (3D).
  const scratch = table2D(sizes.irradianceW, sizes.irradianceH) + table3D() * 3;
  return { resident, bakePeak: resident + scratch };
}

/** The table sizes as #defines. ATMOSPHERE_LOOKUP_GLSL addresses the tables
 *  through them, so every material that samples one profile's tables compiles
 *  with the same set — and one profile is chosen per session, so the program
 *  cache never forks over it. */
export function atmosphereTableDefines(sizes: AtmosphereTableSizes): Record<string, string> {
  return {
    TRANSMITTANCE_TEXTURE_WIDTH: String(sizes.transmittanceW),
    TRANSMITTANCE_TEXTURE_HEIGHT: String(sizes.transmittanceH),
    SCATTERING_TEXTURE_R_SIZE: String(sizes.scatteringR),
    SCATTERING_TEXTURE_MU_SIZE: String(sizes.scatteringMu),
    SCATTERING_TEXTURE_MU_S_SIZE: String(sizes.scatteringMuS),
    SCATTERING_TEXTURE_NU_SIZE: String(sizes.scatteringNu),
    IRRADIANCE_TEXTURE_WIDTH: String(sizes.irradianceW),
    IRRADIANCE_TEXTURE_HEIGHT: String(sizes.irradianceH),
  };
}

/** The uniform block ATMOSPHERE_LOOKUP_GLSL declares, samplers included. A
 *  consumer merges this into its own uniforms and fills it with
 *  applyAtmosphereParams + the three table textures. */
export function atmosphereLookupUniforms(): Record<string, THREE.IUniform> {
  return {
    ...commonUniforms(),
    uTransmittance: { value: null },
    uScattering: { value: null },
    uIrradiance: { value: null },
  };
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
  applyAtmosphereParams(material.uniforms, p);
}

/** Write one body's parameters into a uniform block from
 *  atmosphereLookupUniforms(). Radius units (bottom radius 1) — the form the
 *  tables were baked in, and the only form the GLSL is safe in. */
export function applyAtmosphereParams(
  u: Record<string, THREE.IUniform>,
  p: AtmosphereParams,
): void {
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
