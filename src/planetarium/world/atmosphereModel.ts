/**
 * Physical atmosphere parameters, the precomputed-table addressing, and a CPU
 * reference integrator — DOM-free and three-free, so every number here is
 * pinned by vitest and the GPU bake has something independent to be wrong
 * against.
 *
 * Three constraints shape the whole module:
 *
 *  - **The physical top is a parameter, never the mesh.** The atmosphere shell
 *    meshes are the collision contract (a ship or camera parked at the solid
 *    radius would sit inside the glow), so their scales are load-bearing for
 *    the ship floor, the camera floor and the near plane. `topScale` here is
 *    strictly smaller than the body's shell scale: the mesh has to cover every
 *    air ray for the BackSide rasterisation to see it, and the gap left over is
 *    where the radiance tapers to zero — it must also exceed the sagitta of the
 *    64-segment silhouette (7.8 km at Earth's shell) or the taper scallops.
 *
 *  - **Lengths are AU, coefficients are per-AU.** The scene's unit is 1 AU and
 *    the floating origin keeps a near-band body at ~4e-5, where a float32 ulp
 *    is half a millimetre. The products that matter (β·H ≈ 0.265) are O(0.1)
 *    and safe, but β ≈ 5e6 and H ≈ 5e-8 in isolation are outside `mediump`
 *    range, and a fragment stage without `highp` is a real device. `toRadiusUnits`
 *    rescales a parameter set so the bottom radius is 1 — β becomes 37..211 and
 *    H becomes 1.3e-3, both comfortably `mediump` — and that is the form the
 *    GPU bake and the shaders use. Every function here is unit-agnostic: it
 *    reads bottom/top out of the parameters it was handed.
 *
 *  - **The bake is normalised to solar irradiance 1.0.** The renderer lights a
 *    globe with a point light whose decay is 0.3, not 2, so a physically baked
 *    table dropped next to that ground would be ~2× too faint at Mars and ~2×
 *    too bright at Venus. `solarIrradianceScale` reproduces the renderer's own
 *    falloff law instead, normalised at Earth, and `AIRLIGHT_SCALE` carries the
 *    rest of the bridge from baked radiance to the display-referred frame — per
 *    channel, because the scene's Sun is warm and the tables are baked white.
 *    Normalising also keeps the single-Mie channel (the smallest number in the
 *    scattering layout) clear of half-float underflow at 6.1e-5.
 *
 * The table parametrisation is Bruneton's 2017 one (r, μ, μ_s, ν). Its μ axis
 * is folded: ground-intersecting rays fill the lower half, sky rays the upper,
 * and each half is addressed through a half-texel-inset unit-range mapping. The
 * fold puts the horizon — the one real discontinuity in the radiance — on the
 * two CLAMPED edges of the axis, where clamp-to-edge stops filtering outright,
 * and leaves the 0.5 seam holding nadir against zenith, where the radiance
 * varies slowly. Get either inset wrong and a bright or dark line runs along the
 * horizon, in exactly the near-band view the tables exist for.
 */
import { KM_PER_AU } from '../../astronomy/constants';
import { PLANETS } from '../planets/planetData';

export type RGB = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Source parameters, in the units their published sources quote
// ---------------------------------------------------------------------------

/** One layer of Bruneton's density profile: `density(h) = clamp(expTerm ·
 *  exp(expScale · h) + linearTerm · h + constantTerm, 0, 1)`, valid for
 *  altitudes below `width`; the second layer covers everything above. A plain
 *  exponential is layer 0 with zero width and the exponential in layer 1. */
export interface DensityProfileLayer {
  /** Altitude below which this layer applies, in the parameter set's unit. */
  readonly width: number;
  readonly expTerm: number;
  /** Per unit length, so `expScale = -1/H` for a scale height H. */
  readonly expScale: number;
  /** Per unit length. */
  readonly linearTerm: number;
  readonly constantTerm: number;
}

/** Exactly two layers, the shape Bruneton's tables assume. */
export type DensityProfile = readonly [DensityProfileLayer, DensityProfileLayer];

/** A body's atmosphere as its sources state it: SI coefficients per metre,
 *  heights in km. Everything the rest of the module uses is derived from this
 *  so there is one place a number can be wrong. */
export interface AtmosphereSpec {
  /** Height of the modelled top above the surface, km. */
  readonly topKm: number;
  readonly rayleighScaleHeightKm: number;
  /** Rayleigh scattering coefficient at the surface, per metre, at
   *  (680, 550, 440) nm. */
  readonly rayleighScatteringPerM: RGB;
  readonly mieScaleHeightKm: number;
  /** Mie/aerosol SCATTERING coefficient at the surface, per metre. */
  readonly mieScatteringPerM: RGB;
  /** Single-scattering albedo; extinction = scattering / albedo. */
  readonly mieSingleScatteringAlbedo: RGB;
  /** Henyey-Greenstein asymmetry. */
  readonly miePhaseG: number;
  /** Absorbing layer with a tent profile (Earth's ozone); omitted where the
   *  body has none. */
  readonly absorption?: {
    readonly bottomKm: number;
    readonly peakKm: number;
    readonly topKm: number;
    readonly extinctionPerM: RGB;
  };
  /** Average ground reflectance feeding the irradiance table. */
  readonly groundAlbedo: number;
}

/**
 * Earth. Rayleigh coefficients are the standard clear-sky set at
 * (680, 550, 440) nm; the 440 nm value closes the sanity check that the whole
 * unit chain rests on — 3.31e-5 /m × 8000 m = 0.265 vertical optical depth,
 * the right number for a blue sky, and the same product must come out of the
 * per-AU form. Mie is the conventional grey 2e-5 /m with a 0.9 single-scattering
 * albedo (extinction = scattering / 0.9) and a 1.2 km scale height. The
 * asymmetry stays at the 0.83 the analytic shell has used, rather than the
 * 0.76-0.80 usually quoted, so the two tiers keep the same forward-scatter
 * character until a side-by-side says otherwise. Ozone is the standard
 * 10-40 km tent peaking at 25 km. Ground albedo 0.1 is the usual global mean.
 *
 * The 100 km top is 12.5 Rayleigh scale heights and sits 27 km inside the
 * shell mesh at scale 1.02 — the taper room the module header requires.
 */
const EARTH_SPEC: AtmosphereSpec = {
  topKm: 100,
  rayleighScaleHeightKm: 8,
  rayleighScatteringPerM: [5.8e-6, 1.35e-5, 3.31e-5],
  mieScaleHeightKm: 1.2,
  mieScatteringPerM: [2.0e-5, 2.0e-5, 2.0e-5],
  mieSingleScatteringAlbedo: [0.9, 0.9, 0.9],
  miePhaseG: 0.83,
  absorption: {
    bottomKm: 10,
    peakKm: 25,
    topKm: 40,
    extinctionPerM: [0.65e-6, 1.881e-6, 0.085e-6],
  },
  groundAlbedo: 0.1,
};

/**
 * Mars — dust-dominated, and the numbers are worth stating because none of them
 * are Earth's scaled down.
 *
 * Gas: 610 Pa at 210 K gives a surface number density of 2.1e23 /m³ against
 * Earth's 2.55e25, i.e. 0.0082×; CO₂'s refractivity (4.49e-4 at STP) against
 * air's (2.93e-4) squares to a 2.35× larger per-molecule cross-section, so
 * Mars' Rayleigh coefficients are Earth's × 0.0194. The scale height is 11 km
 * (g = 3.71 m/s², a ~210 K CO₂ column).
 *
 * Dust: the campaign's Mars is a clear day, background opacity τ ≈ 0.5 at
 * visible wavelengths (Viking, MER and MSL all report 0.3-0.9 outside storm
 * season), mixed to roughly the gas scale height, so β_ext = τ/H =
 * 4.55e-5 /m — over twice Earth's aerosol load, which is why Mars' sky is its
 * dust and not its gas. Extinction is near-grey but the single-scattering
 * albedo is strongly wavelength dependent (Wolff et al. 2009/2010, CRISM and
 * MARCI retrievals: ≈0.94 red, 0.87 green, 0.63 blue) — that asymmetry, not a
 * tinted extinction, is what makes the daytime sky butterscotch and the sunset
 * blue. Asymmetry g = 0.63 from the same retrievals. Ground albedo 0.25 is
 * Mars' Bond albedo.
 *
 * The top is 40 km, not the ~60 km a 5-scale-height convention would pick:
 * Mars' shell mesh is scale 1.014 (47.5 km) and the mesh scale is the collision
 * contract, untouched by this campaign, so the physical top has to fit inside
 * it with taper room to spare (7.5 km against a 4.1 km silhouette sagitta).
 * 40 km is 3.6 scale heights and leaves 2.6 % of the column above it —
 * a smaller error than the day-to-day dust variability the τ is drawn from.
 *
 * That is the column argument, and it is not the limb argument. What a limb
 * shows is the optical depth of a GRAZING ray at the top, where the airmass is
 * ~√(πR/2H): Earth's 100 km top leaves 0.265 · e^(−100/8) · 35 ≈ 3.4e-5 there,
 * i.e. nothing, tapering over 27 km of mesh (3.4 scale heights). Mars' 40 km
 * top leaves 0.5 · e^(−40/11) · 22 ≈ 0.29 — bright enough to read as a ring on
 * the limb where the table stops, and only 7.5 km of mesh (0.68 dust scale
 * heights) to take it to zero in. So Mars' first drawn shell has to settle one
 * of two things: raise the mesh scale (which moves the collision floor by
 * 20 km, with the ship and camera pins re-checked) or put a taller top under a
 * larger shell. That is a decision to make against the picture, with the shell
 * drawing — the parameters here are the ones a limb will expose.
 */
const MARS_SPEC: AtmosphereSpec = {
  topKm: 40,
  rayleighScaleHeightKm: 11,
  rayleighScatteringPerM: [1.124e-7, 2.616e-7, 6.414e-7],
  mieScaleHeightKm: 11,
  mieScatteringPerM: [4.273e-5, 3.955e-5, 2.864e-5],
  mieSingleScatteringAlbedo: [0.94, 0.87, 0.63],
  miePhaseG: 0.63,
  groundAlbedo: 0.25,
};

/** Every body with a precomputed table. Venus and Titan keep the opaque haze
 *  of the surface shading; the gas giants have no surface for a thin layer to
 *  sit above and keep the analytic fringe. */
export const ATMOSPHERE_SPECS: Readonly<Record<string, AtmosphereSpec>> = {
  Earth: EARTH_SPEC,
  Mars: MARS_SPEC,
};

const RADIUS_KM_BY_BODY: Readonly<Record<string, number>> = Object.fromEntries(
  PLANETS.map((p) => [p.name, p.radiusKm]),
);

/** Distance from the Sun used for the per-body solar irradiance scale. The
 *  catalog's semi-major axis, not the live ephemeris: the tables are baked once
 *  and a body's eccentricity moves this by a few per cent at most. */
const SEMI_MAJOR_AU_BY_BODY: Readonly<Record<string, number>> = Object.fromEntries(
  PLANETS.map((p) => [p.name, p.semiMajorAxisAU]),
);

/** Physical atmosphere top as a multiple of the body's radius — the shader and
 *  table parameter. Strictly below the body's shell-mesh scale in
 *  ATMOSPHERES (1.02 Earth, 1.014 Mars); a table test pins that. */
export const ATMOSPHERE_TOP_SCALES: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ATMOSPHERE_SPECS).map(([name, spec]) => {
    const radiusKm = RADIUS_KM_BY_BODY[name];
    if (!radiusKm) throw new Error(`atmosphereModel: no radius for ${name}`);
    return [name, 1 + spec.topKm / radiusKm];
  }),
);

// ---------------------------------------------------------------------------
// Photometry bridge
// ---------------------------------------------------------------------------

/**
 * Falloff exponent of the Sun's illumination with distance. This is NOT
 * physical: the scene's Sun is a point light with decay 0.3 (its brightness is
 * authored so the outer planets stay legible), and the tables have to agree
 * with the ground they sit on top of, not with the inverse-square law. It must
 * equal the decay the light is constructed with — a test asserts they match, so
 * changing the light breaks the test rather than silently de-calibrating every
 * atmosphere.
 */
export const SOLAR_DISTANCE_DECAY = 0.3;

/**
 * Solar irradiance at `distanceAU`, relative to Earth's. The bake normalises
 * irradiance to 1.0 (so a table is a body's air, not its orbit), and this is
 * the factor the render multiplies back in.
 */
export function solarIrradianceScale(bodyDistanceAU: number): number {
  if (!(bodyDistanceAU > 0)) return 0;
  return Math.pow(bodyDistanceAU, -SOLAR_DISTANCE_DECAY);
}

/** Solar irradiance scale for a named body, from the catalog's orbit. */
export function bodySolarIrradianceScale(name: string): number {
  const au = SEMI_MAJOR_AU_BY_BODY[name];
  return au === undefined ? 1 : solarIrradianceScale(au);
}

/**
 * The global multiplier between baked radiance (solar irradiance 1.0, WHITE)
 * and the renderer's display-referred frame. It is the SCENE's solar
 * irradiance at Earth, per channel: the globe is lit by a point light of
 * intensity 3 and colour 0xfff5e0, and three's Lambert term makes
 * `intensity * color` the perpendicular irradiance the ground reflects
 * (radiance = intensity * color * cos * albedo / pi). So air baked at an
 * irradiance of 1 next to it would sit three stops of exposure below the disc
 * it hazes — and, scaled by a single number, would be lit by a WHITE Sun while
 * the ground under it is lit by a warm one: +9.5% green and +34% blue on a limb
 * whose whole reading is its blue. The three values are the light's intensity
 * times its colour decoded to the linear working space; the distance law is the
 * other half of the same bridge (SOLAR_DISTANCE_DECAY). A test holds all three
 * against the light's own constants, for the same reason it holds the decay.
 */
export const AIRLIGHT_SCALE: RGB = [3.0, 2.739295955374419, 2.2362126286050854];

/** Angular radius of the Sun as seen from Earth, radians — softens the
 *  transmittance-to-Sun terminator so the ground does not switch on in one
 *  texel. */
export const SUN_ANGULAR_RADIUS_RAD = 0.004675;

// ---------------------------------------------------------------------------
// Derived parameter sets
// ---------------------------------------------------------------------------

/** A body's atmosphere in one consistent length unit. Every function below
 *  reads its geometry out of `bottomRadius`/`topRadius`, so the same code
 *  serves the AU form and the radius-normalised form the GPU uses. */
export interface AtmosphereParams {
  readonly name: string;
  readonly bottomRadius: number;
  readonly topRadius: number;
  readonly rayleighDensity: DensityProfile;
  readonly rayleighScattering: RGB;
  readonly mieDensity: DensityProfile;
  readonly mieScattering: RGB;
  readonly mieExtinction: RGB;
  readonly miePhaseG: number;
  readonly absorptionDensity: DensityProfile;
  readonly absorptionExtinction: RGB;
  readonly groundAlbedo: number;
  /** Cosine of the largest Sun zenith angle the tables resolve — 102°, past
   *  which the twilight the tables carry has run out anyway. */
  readonly muSMin: number;
  readonly sunAngularRadius: number;
}

const MU_S_MIN = Math.cos((102 * Math.PI) / 180);

function exponentialProfile(scaleHeight: number): DensityProfile {
  return [
    { width: 0, expTerm: 0, expScale: 0, linearTerm: 0, constantTerm: 0 },
    { width: 0, expTerm: 1, expScale: -1 / scaleHeight, linearTerm: 0, constantTerm: 0 },
  ];
}

function tentProfile(bottom: number, peak: number, top: number): DensityProfile {
  const rise = peak - bottom;
  const fall = top - peak;
  return [
    { width: peak, expTerm: 0, expScale: 0, linearTerm: 1 / rise, constantTerm: -bottom / rise },
    { width: 0, expTerm: 0, expScale: 0, linearTerm: -1 / fall, constantTerm: top / fall },
  ];
}

const ZERO_PROFILE: DensityProfile = [
  { width: 0, expTerm: 0, expScale: 0, linearTerm: 0, constantTerm: 0 },
  { width: 0, expTerm: 0, expScale: 0, linearTerm: 0, constantTerm: 0 },
];

const paramsCache = new Map<string, AtmosphereParams>();

/** A body's parameters in AU: lengths in AU, coefficients per AU. */
export function atmosphereParamsAU(name: string): AtmosphereParams {
  const cached = paramsCache.get(name);
  if (cached) return cached;
  const spec = ATMOSPHERE_SPECS[name];
  const radiusKm = RADIUS_KM_BY_BODY[name];
  if (!spec || !radiusKm) throw new Error(`atmosphereModel: no atmosphere for ${name}`);

  const kmToAU = (km: number): number => km / KM_PER_AU;
  // A coefficient quoted per metre becomes per AU by multiplying by the number
  // of metres in an AU.
  const perMToPerAU = (v: RGB): RGB => [
    v[0] * KM_PER_AU * 1000,
    v[1] * KM_PER_AU * 1000,
    v[2] * KM_PER_AU * 1000,
  ];

  const bottomRadius = kmToAU(radiusKm);
  const mieScattering = perMToPerAU(spec.mieScatteringPerM);
  const params: AtmosphereParams = {
    name,
    bottomRadius,
    topRadius: kmToAU(radiusKm + spec.topKm),
    rayleighDensity: exponentialProfile(kmToAU(spec.rayleighScaleHeightKm)),
    rayleighScattering: perMToPerAU(spec.rayleighScatteringPerM),
    mieDensity: exponentialProfile(kmToAU(spec.mieScaleHeightKm)),
    mieScattering,
    mieExtinction: [
      mieScattering[0] / spec.mieSingleScatteringAlbedo[0],
      mieScattering[1] / spec.mieSingleScatteringAlbedo[1],
      mieScattering[2] / spec.mieSingleScatteringAlbedo[2],
    ],
    miePhaseG: spec.miePhaseG,
    absorptionDensity: spec.absorption
      ? tentProfile(
        kmToAU(spec.absorption.bottomKm),
        kmToAU(spec.absorption.peakKm),
        kmToAU(spec.absorption.topKm),
      )
      : ZERO_PROFILE,
    absorptionExtinction: spec.absorption ? perMToPerAU(spec.absorption.extinctionPerM) : [0, 0, 0],
    groundAlbedo: spec.groundAlbedo,
    muSMin: MU_S_MIN,
    sunAngularRadius: SUN_ANGULAR_RADIUS_RAD,
  };
  paramsCache.set(name, params);
  return params;
}

function scaleProfile(profile: DensityProfile, lengthScale: number): DensityProfile {
  const scaleLayer = (l: DensityProfileLayer): DensityProfileLayer => ({
    width: l.width * lengthScale,
    expTerm: l.expTerm,
    expScale: l.expScale / lengthScale,
    linearTerm: l.linearTerm / lengthScale,
    constantTerm: l.constantTerm,
  });
  return [scaleLayer(profile[0]), scaleLayer(profile[1])];
}

/**
 * The same atmosphere with the body's radius as the unit of length: bottom
 * radius exactly 1, top `topScale`, coefficients 37..211 per radius. This is
 * the form the bake and the shaders use — see the header on the `mediump`
 * hazard the AU form carries.
 */
export function toRadiusUnits(params: AtmosphereParams): AtmosphereParams {
  const s = 1 / params.bottomRadius;
  const mul = (v: RGB): RGB => [v[0] / s, v[1] / s, v[2] / s];
  return {
    ...params,
    bottomRadius: 1,
    topRadius: params.topRadius * s,
    rayleighDensity: scaleProfile(params.rayleighDensity, s),
    rayleighScattering: mul(params.rayleighScattering),
    mieDensity: scaleProfile(params.mieDensity, s),
    mieScattering: mul(params.mieScattering),
    mieExtinction: mul(params.mieExtinction),
    absorptionDensity: scaleProfile(params.absorptionDensity, s),
    absorptionExtinction: mul(params.absorptionExtinction),
  };
}

/** A body's parameters in radius units — what the bake is handed. */
export function atmosphereParams(name: string): AtmosphereParams {
  return toRadiusUnits(atmosphereParamsAU(name));
}

// ---------------------------------------------------------------------------
// Table dimensions
// ---------------------------------------------------------------------------

export interface AtmosphereTableSizes {
  readonly transmittanceW: number;
  readonly transmittanceH: number;
  /** The scattering table is a 3D texture of
   *  (nu · muS) × mu × r texels: ν and μ_s share the x axis because WebGL2 has
   *  no 4D textures, which is also why ν must be interpolated by hand. */
  readonly scatteringNu: number;
  readonly scatteringMuS: number;
  readonly scatteringMu: number;
  readonly scatteringR: number;
  readonly irradianceW: number;
  readonly irradianceH: number;
}

/** Desktop tables: transmittance 256×64, scattering 256×128×32, irradiance
 *  64×16 — Bruneton's reference sizes. 8 MiB of RGBA16F for the scattering
 *  accumulator. */
export const ATMOSPHERE_TABLE_SIZES_FULL: AtmosphereTableSizes = {
  transmittanceW: 256,
  transmittanceH: 64,
  scatteringNu: 8,
  scatteringMuS: 32,
  scatteringMu: 128,
  scatteringR: 32,
  irradianceW: 64,
  irradianceH: 16,
};

/** Touch tables: the scattering table halves on μ_s and μ to 128×64×32 (2 MiB).
 *  ν stays at 8 — it is the axis the limb bands on, and halving it is visible
 *  where halving μ_s is not. */
export const ATMOSPHERE_TABLE_SIZES_HALF: AtmosphereTableSizes = {
  transmittanceW: 128,
  transmittanceH: 32,
  scatteringNu: 8,
  scatteringMuS: 16,
  scatteringMu: 64,
  scatteringR: 32,
  irradianceW: 32,
  irradianceH: 16,
};

/** Width in texels of the scattering table's packed ν × μ_s axis. */
export function scatteringTextureWidth(sizes: AtmosphereTableSizes): number {
  return sizes.scatteringNu * sizes.scatteringMuS;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function clampCosine(mu: number): number {
  return Math.min(1, Math.max(-1, mu));
}

export function clampRadius(params: AtmosphereParams, r: number): number {
  return Math.min(params.topRadius, Math.max(params.bottomRadius, r));
}

function safeSqrt(a: number): number {
  return Math.sqrt(Math.max(a, 0));
}

/** Distance from (r, μ) to the top of the atmosphere. */
export function distanceToTopBoundary(params: AtmosphereParams, r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + params.topRadius * params.topRadius;
  return Math.max(-r * mu + safeSqrt(disc), 0);
}

/** Distance from (r, μ) to the ground, meaningful only when the ray hits it. */
export function distanceToBottomBoundary(params: AtmosphereParams, r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + params.bottomRadius * params.bottomRadius;
  return Math.max(-r * mu - safeSqrt(disc), 0);
}

export function rayIntersectsGround(params: AtmosphereParams, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + params.bottomRadius * params.bottomRadius >= 0;
}

export function distanceToNearestBoundary(
  params: AtmosphereParams,
  r: number,
  mu: number,
  intersectsGround: boolean,
): number {
  return intersectsGround
    ? distanceToBottomBoundary(params, r, mu)
    : distanceToTopBoundary(params, r, mu);
}

/** Density of a profile at an altitude above the ground, in [0, 1]. */
export function profileDensity(profile: DensityProfile, altitude: number): number {
  const layer = altitude < profile[0].width ? profile[0] : profile[1];
  const d = layer.expTerm * Math.exp(layer.expScale * altitude)
    + layer.linearTerm * altitude + layer.constantTerm;
  return Math.min(1, Math.max(0, d));
}

// ---------------------------------------------------------------------------
// Table addressing (Bruneton 2017)
// ---------------------------------------------------------------------------

/** Map a unit-range value onto texture coordinates inset by half a texel, so
 *  the first and last texel centres carry the endpoints exactly and filtering
 *  never reaches past them. */
export function textureCoordFromUnitRange(x: number, size: number): number {
  return 0.5 / size + x * (1 - 1 / size);
}

export function unitRangeFromTextureCoord(u: number, size: number): number {
  return (u - 0.5 / size) / (1 - 1 / size);
}

/** Half-chord of the atmosphere shell at the ground — the natural length scale
 *  of both the r and μ mappings. */
function boundaryChord(params: AtmosphereParams): number {
  return safeSqrt(params.topRadius * params.topRadius - params.bottomRadius * params.bottomRadius);
}

export interface Uv { readonly u: number; readonly v: number; }

export function transmittanceUvFromRMu(
  params: AtmosphereParams,
  r: number,
  mu: number,
  sizes: AtmosphereTableSizes,
): Uv {
  const H = boundaryChord(params);
  const rho = safeSqrt(r * r - params.bottomRadius * params.bottomRadius);
  const d = distanceToTopBoundary(params, r, mu);
  const dMin = params.topRadius - r;
  const dMax = rho + H;
  const xMu = dMax === dMin ? 0 : (d - dMin) / (dMax - dMin);
  const xR = H === 0 ? 0 : rho / H;
  return {
    u: textureCoordFromUnitRange(xMu, sizes.transmittanceW),
    v: textureCoordFromUnitRange(xR, sizes.transmittanceH),
  };
}

export function rMuFromTransmittanceUv(
  params: AtmosphereParams,
  uv: Uv,
  sizes: AtmosphereTableSizes,
): { r: number; mu: number } {
  const xMu = unitRangeFromTextureCoord(uv.u, sizes.transmittanceW);
  const xR = unitRangeFromTextureCoord(uv.v, sizes.transmittanceH);
  const H = boundaryChord(params);
  const rho = H * xR;
  const r = safeSqrt(rho * rho + params.bottomRadius * params.bottomRadius);
  const dMin = params.topRadius - r;
  const dMax = rho + H;
  const d = dMin + xMu * (dMax - dMin);
  const mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
  return { r, mu: clampCosine(mu) };
}

/** The four table coordinates, before ν and μ_s are packed onto one axis. */
export interface ScatteringUvwz {
  readonly uNu: number;
  readonly uMuS: number;
  readonly uMu: number;
  readonly uR: number;
}

export function scatteringUvwzFromRMuMuSNu(
  params: AtmosphereParams,
  r: number,
  mu: number,
  muS: number,
  nu: number,
  intersectsGround: boolean,
  sizes: AtmosphereTableSizes,
): ScatteringUvwz {
  const H = boundaryChord(params);
  const rho = safeSqrt(r * r - params.bottomRadius * params.bottomRadius);
  const uR = textureCoordFromUnitRange(H === 0 ? 0 : rho / H, sizes.scatteringR);

  const rMu = r * mu;
  const disc = rMu * rMu - r * r + params.bottomRadius * params.bottomRadius;
  let uMu: number;
  // Each half is addressed independently and inset by half a texel of its OWN
  // half, so a ground-intersecting ray and a sky ray can never be filtered
  // together. Within a half, distance to the boundary is the parameter — which
  // is what puts the horizon at the clamped outer edge and the vertical
  // directions at the 0.5 seam.
  if (intersectsGround) {
    const d = -rMu - safeSqrt(disc);
    const dMin = r - params.bottomRadius;
    const dMax = rho;
    const x = dMax === dMin ? 0 : (d - dMin) / (dMax - dMin);
    uMu = 0.5 - 0.5 * textureCoordFromUnitRange(x, sizes.scatteringMu / 2);
  } else {
    const d = -rMu + safeSqrt(disc + H * H);
    const dMin = params.topRadius - r;
    const dMax = rho + H;
    const x = dMax === dMin ? 0 : (d - dMin) / (dMax - dMin);
    uMu = 0.5 + 0.5 * textureCoordFromUnitRange(x, sizes.scatteringMu / 2);
  }

  // μ_s is squeezed towards the horizon so the twilight band, which is a few
  // degrees wide and carries the whole look past the terminator, gets texels.
  const dS = distanceToTopBoundary(params, params.bottomRadius, muS);
  const dSMin = params.topRadius - params.bottomRadius;
  const dSMax = H;
  const a = (dS - dSMin) / (dSMax - dSMin);
  const D = distanceToTopBoundary(params, params.bottomRadius, params.muSMin);
  const A = (D - dSMin) / (dSMax - dSMin);
  const uMuS = textureCoordFromUnitRange(Math.max(1 - a / A, 0) / (1 + a), sizes.scatteringMuS);

  return { uNu: (nu + 1) / 2, uMuS, uMu, uR };
}

export function rMuMuSNuFromScatteringUvwz(
  params: AtmosphereParams,
  uvwz: ScatteringUvwz,
  sizes: AtmosphereTableSizes,
): { r: number; mu: number; muS: number; nu: number; intersectsGround: boolean } {
  const H = boundaryChord(params);
  const rho = H * unitRangeFromTextureCoord(uvwz.uR, sizes.scatteringR);
  const r = safeSqrt(rho * rho + params.bottomRadius * params.bottomRadius);

  let mu: number;
  let intersectsGround: boolean;
  if (uvwz.uMu < 0.5) {
    const dMin = r - params.bottomRadius;
    const dMax = rho;
    const x = unitRangeFromTextureCoord(1 - 2 * uvwz.uMu, sizes.scatteringMu / 2);
    const d = dMin + x * (dMax - dMin);
    mu = d === 0 ? -1 : clampCosine(-(rho * rho + d * d) / (2 * r * d));
    intersectsGround = true;
  } else {
    const dMin = params.topRadius - r;
    const dMax = rho + H;
    const x = unitRangeFromTextureCoord(2 * uvwz.uMu - 1, sizes.scatteringMu / 2);
    const d = dMin + x * (dMax - dMin);
    mu = d === 0 ? 1 : clampCosine((H * H - rho * rho - d * d) / (2 * r * d));
    intersectsGround = false;
  }

  const xMuS = unitRangeFromTextureCoord(uvwz.uMuS, sizes.scatteringMuS);
  const dSMin = params.topRadius - params.bottomRadius;
  const dSMax = H;
  const D = distanceToTopBoundary(params, params.bottomRadius, params.muSMin);
  const A = (D - dSMin) / (dSMax - dSMin);
  const a = (A - xMuS * A) / (1 + xMuS * A);
  const dS = dSMin + Math.min(a, A) * (dSMax - dSMin);
  const muS = dS === 0
    ? 1
    : clampCosine((H * H - dS * dS) / (2 * params.bottomRadius * dS));

  const nu = clampCosine(uvwz.uNu * 2 - 1);
  return { r, mu, muS, nu, intersectsGround };
}

/** The two 3D texture coordinates a scattering lookup fetches and the weight
 *  between them. ν shares the x axis with μ_s, so a hardware trilinear fetch
 *  would interpolate across the seam between two ν slabs and return a value
 *  from the wrong μ_s: the lookup takes two fetches and lerps ν itself. */
export function scatteringTexture3DCoords(
  uvwz: ScatteringUvwz,
  sizes: AtmosphereTableSizes,
): { uvw0: [number, number, number]; uvw1: [number, number, number]; lerp: number } {
  const coordX = uvwz.uNu * (sizes.scatteringNu - 1);
  const texX = Math.floor(coordX);
  const lerp = coordX - texX;
  return {
    uvw0: [(texX + uvwz.uMuS) / sizes.scatteringNu, uvwz.uMu, uvwz.uR],
    uvw1: [(texX + 1 + uvwz.uMuS) / sizes.scatteringNu, uvwz.uMu, uvwz.uR],
    lerp,
  };
}

export function irradianceUvFromRMuS(
  params: AtmosphereParams,
  r: number,
  muS: number,
  sizes: AtmosphereTableSizes,
): Uv {
  const xR = (r - params.bottomRadius) / (params.topRadius - params.bottomRadius);
  const xMuS = muS * 0.5 + 0.5;
  return {
    u: textureCoordFromUnitRange(xMuS, sizes.irradianceW),
    v: textureCoordFromUnitRange(xR, sizes.irradianceH),
  };
}

export function rMuSFromIrradianceUv(
  params: AtmosphereParams,
  uv: Uv,
  sizes: AtmosphereTableSizes,
): { r: number; muS: number } {
  const xMuS = unitRangeFromTextureCoord(uv.u, sizes.irradianceW);
  const xR = unitRangeFromTextureCoord(uv.v, sizes.irradianceH);
  return {
    r: params.bottomRadius + xR * (params.topRadius - params.bottomRadius),
    muS: clampCosine(2 * xMuS - 1),
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers shared with the shaders
// ---------------------------------------------------------------------------

/**
 * Recover the single-Mie term from the scattering texel. The layout stores
 * Rayleigh in RGB and only the red Mie channel in alpha, and reconstructs the
 * other two by assuming Mie and Rayleigh have the same spectral shape along the
 * path. The reconstruction divides by the red Rayleigh channel, which goes to
 * zero exactly where the difference-of-two-lookups regime lives — the limb and
 * the far side of the terminator, in half precision, where the two lookups
 * nearly cancel. Without the guard that is coloured speckle along the two
 * features the tables exist to draw.
 */
export function extrapolateSingleMieScattering(
  params: AtmosphereParams,
  scattering: readonly [number, number, number, number],
): RGB {
  if (scattering[0] <= 0) return [0, 0, 0];
  const rs = params.rayleighScattering;
  const ms = params.mieScattering;
  const k = (scattering[3] / scattering[0]) * (rs[0] / ms[0]);
  return [
    scattering[0] * k * (ms[0] / rs[0]),
    scattering[1] * k * (ms[1] / rs[1]),
    scattering[2] * k * (ms[2] / rs[2]),
  ];
}

export function rayleighPhase(nu: number): number {
  const k = 3 / (16 * Math.PI);
  return k * (1 + nu * nu);
}

export function miePhase(g: number, nu: number): number {
  const k = 3 / (8 * Math.PI) * ((1 - g * g) / (2 + g * g));
  return k * (1 + nu * nu) / Math.pow(1 + g * g - 2 * g * nu, 1.5);
}

// ---------------------------------------------------------------------------
// CPU reference integrator
// ---------------------------------------------------------------------------

/** Samples per integral in the reference. High enough that the reference's own
 *  discretisation error is far below the 2 % the GPU tables are held to. */
export const REFERENCE_TRANSMITTANCE_SAMPLES = 500;
export const REFERENCE_SCATTERING_SAMPLES = 50;

function trapezoidWeight(i: number, n: number): number {
  return i === 0 || i === n ? 0.5 : 1;
}

/**
 * Optical length of one density profile along the ray from (r, μ) to the top of
 * the atmosphere, by trapezoid rule. Numerical, with no table anywhere in the
 * chain — that independence is the whole point of the reference.
 */
export function opticalLengthToTopBoundary(
  params: AtmosphereParams,
  profile: DensityProfile,
  r: number,
  mu: number,
  samples = REFERENCE_TRANSMITTANCE_SAMPLES,
): number {
  const dx = distanceToTopBoundary(params, r, mu) / samples;
  let sum = 0;
  for (let i = 0; i <= samples; i++) {
    const d = i * dx;
    const rD = safeSqrt(d * d + 2 * r * mu * d + r * r);
    sum += profileDensity(profile, rD - params.bottomRadius) * trapezoidWeight(i, samples);
  }
  return sum * dx;
}

/**
 * Optical depth from (r, μ) to the top of the atmosphere — the exponent, not
 * the transmittance. This is what the table stores: transmittance on a long
 * path is ~1e-6, which is a half-float subnormal that GPUs flush to zero, and
 * the segment transmittance is then a division by that zero. Optical depth
 * spans 0..~22 instead (measured max in Earth's table: 21.7, blue, a horizon
 * path at the ground), where half precision is comfortable, and the segment
 * becomes a difference of two depths rather than a ratio of two transmittances.
 */
export function opticalDepthToTopBoundary(
  params: AtmosphereParams,
  r: number,
  mu: number,
  samples = REFERENCE_TRANSMITTANCE_SAMPLES,
): RGB {
  const tR = opticalLengthToTopBoundary(params, params.rayleighDensity, r, mu, samples);
  const tM = opticalLengthToTopBoundary(params, params.mieDensity, r, mu, samples);
  const tO = opticalLengthToTopBoundary(params, params.absorptionDensity, r, mu, samples);
  const rs = params.rayleighScattering;
  const me = params.mieExtinction;
  const ae = params.absorptionExtinction;
  return [
    rs[0] * tR + me[0] * tM + ae[0] * tO,
    rs[1] * tR + me[1] * tM + ae[1] * tO,
    rs[2] * tR + me[2] * tM + ae[2] * tO,
  ];
}

/** Transmittance from (r, μ) to the top of the atmosphere. */
export function transmittanceToTopBoundary(
  params: AtmosphereParams,
  r: number,
  mu: number,
  samples = REFERENCE_TRANSMITTANCE_SAMPLES,
): RGB {
  const tau = opticalDepthToTopBoundary(params, r, mu, samples);
  return [Math.exp(-tau[0]), Math.exp(-tau[1]), Math.exp(-tau[2])];
}

/**
 * Transmittance over the segment of length `d` from (r, μ). Integrated
 * directly rather than taken as the ratio of two transmittances-to-top: the
 * ratio is what the GPU does, and a reference that shares that trick could not
 * catch it cancelling badly.
 */
export function transmittanceOverSegment(
  params: AtmosphereParams,
  r: number,
  mu: number,
  d: number,
  samples = REFERENCE_TRANSMITTANCE_SAMPLES,
): RGB {
  const dx = d / samples;
  let sR = 0;
  let sM = 0;
  let sO = 0;
  for (let i = 0; i <= samples; i++) {
    const s = i * dx;
    const rS = safeSqrt(s * s + 2 * r * mu * s + r * r);
    const alt = rS - params.bottomRadius;
    const w = trapezoidWeight(i, samples);
    sR += profileDensity(params.rayleighDensity, alt) * w;
    sM += profileDensity(params.mieDensity, alt) * w;
    sO += profileDensity(params.absorptionDensity, alt) * w;
  }
  const rs = params.rayleighScattering;
  const me = params.mieExtinction;
  const ae = params.absorptionExtinction;
  return [
    Math.exp(-dx * (rs[0] * sR + me[0] * sM + ae[0] * sO)),
    Math.exp(-dx * (rs[1] * sR + me[1] * sM + ae[1] * sO)),
    Math.exp(-dx * (rs[2] * sR + me[2] * sM + ae[2] * sO)),
  ];
}

/** Transmittance from (r, μ_s) to the Sun, with the disc's angular radius
 *  softening the shadow of the planet's own limb. */
export function transmittanceToSun(
  params: AtmosphereParams,
  r: number,
  muS: number,
  samples = REFERENCE_TRANSMITTANCE_SAMPLES,
): RGB {
  const sinThetaH = params.bottomRadius / r;
  const cosThetaH = -safeSqrt(1 - sinThetaH * sinThetaH);
  const edge = sinThetaH * params.sunAngularRadius;
  const x = edge === 0 ? (muS > cosThetaH ? 1 : 0)
    : Math.min(1, Math.max(0, (muS - cosThetaH + edge) / (2 * edge)));
  const visible = x * x * (3 - 2 * x);
  const t = transmittanceToTopBoundary(params, r, muS, samples);
  return [t[0] * visible, t[1] * visible, t[2] * visible];
}

export interface SingleScattering {
  readonly rayleigh: RGB;
  readonly mie: RGB;
}

/**
 * Single scattering at (r, μ, μ_s, ν), normalised to solar irradiance 1.0 and
 * WITHOUT the phase functions — the same convention the tables store, so a
 * table texel and this can be compared directly.
 */
export function computeSingleScattering(
  params: AtmosphereParams,
  r: number,
  mu: number,
  muS: number,
  nu: number,
  intersectsGround: boolean,
  samples = REFERENCE_SCATTERING_SAMPLES,
  transmittanceSamples = REFERENCE_TRANSMITTANCE_SAMPLES,
): SingleScattering {
  const dx = distanceToNearestBoundary(params, r, mu, intersectsGround) / samples;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let rMieSum = 0;
  let gMieSum = 0;
  let bMieSum = 0;
  for (let i = 0; i <= samples; i++) {
    const d = i * dx;
    const rD = clampRadius(params, safeSqrt(d * d + 2 * r * mu * d + r * r));
    const muSD = clampCosine((r * muS + d * nu) / rD);
    const tView = transmittanceOverSegment(params, r, mu, d, transmittanceSamples);
    const tSun = transmittanceToSun(params, rD, muSD, transmittanceSamples);
    const w = trapezoidWeight(i, samples);
    const alt = rD - params.bottomRadius;
    const dr = profileDensity(params.rayleighDensity, alt) * w;
    const dm = profileDensity(params.mieDensity, alt) * w;
    rSum += tView[0] * tSun[0] * dr;
    gSum += tView[1] * tSun[1] * dr;
    bSum += tView[2] * tSun[2] * dr;
    rMieSum += tView[0] * tSun[0] * dm;
    gMieSum += tView[1] * tSun[1] * dm;
    bMieSum += tView[2] * tSun[2] * dm;
  }
  const rs = params.rayleighScattering;
  const ms = params.mieScattering;
  return {
    rayleigh: [rSum * dx * rs[0], gSum * dx * rs[1], bSum * dx * rs[2]],
    mie: [rMieSum * dx * ms[0], gMieSum * dx * ms[1], bMieSum * dx * ms[2]],
  };
}

/** Single scattering at (r, μ, μ_s, ν) WITH both phase functions applied — the
 *  radiance a lookup returns, as opposed to the phase-free pair the table
 *  stores. This is the form the sky's own irradiance integrates, and the form a
 *  combined table lookup has to reproduce, so it is the one place the two phase
 *  functions are exercised end to end. */
export function singleScatteringRadiance(
  params: AtmosphereParams,
  r: number,
  mu: number,
  muS: number,
  nu: number,
  intersectsGround: boolean,
  samples = REFERENCE_SCATTERING_SAMPLES,
  transmittanceSamples = REFERENCE_TRANSMITTANCE_SAMPLES,
): RGB {
  const s = computeSingleScattering(
    params, r, mu, muS, nu, intersectsGround, samples, transmittanceSamples,
  );
  const pr = rayleighPhase(nu);
  const pm = miePhase(params.miePhaseG, nu);
  return [
    s.rayleigh[0] * pr + s.mie[0] * pm,
    s.rayleigh[1] * pr + s.mie[1] * pm,
    s.rayleigh[2] * pr + s.mie[2] * pm,
  ];
}

/**
 * Irradiance on the horizontal at (r, μ_s) from the sky's FIRST-ORDER
 * scattering — what the bake's indirect-irradiance pass writes into the
 * irradiance table when it runs for order 1, and the only part of that table a
 * table-free reference can reproduce (every later order integrates the
 * multiple-scattering table, which has no closed form here).
 *
 * The hemisphere quadrature is deliberately the bake's own — `directions`
 * midpoint samples in θ over the upper half and twice that in φ — so the two
 * sides differ by the table's interpolation, never by the grid. The inner
 * sample counts default to the reference's own: this runs `directions²/2`
 * single-scattering integrals per call, which is seconds rather than
 * milliseconds, and cutting them is not free — at the ground row a 25/250
 * integration lands 20 % below a 50/500 one.
 */
export function computeIndirectIrradianceOrder1(
  params: AtmosphereParams,
  r: number,
  muS: number,
  samples = REFERENCE_SCATTERING_SAMPLES,
  transmittanceSamples = REFERENCE_TRANSMITTANCE_SAMPLES,
  directions = 32,
): RGB {
  const dphi = Math.PI / directions;
  const dtheta = Math.PI / directions;
  const sunX = safeSqrt(1 - muS * muS);
  const out: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < directions / 2; j++) {
    const theta = (j + 0.5) * dtheta;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    const domega = dtheta * dphi * sinTheta;
    for (let i = 0; i < 2 * directions; i++) {
      const phi = (i + 0.5) * dphi;
      const nu = Math.cos(phi) * sinTheta * sunX + cosTheta * muS;
      const radiance = singleScatteringRadiance(
        params, r, cosTheta, muS, nu, false, samples, transmittanceSamples,
      );
      const w = cosTheta * domega;
      out[0] += radiance[0] * w;
      out[1] += radiance[1] * w;
      out[2] += radiance[2] * w;
    }
  }
  return out;
}
