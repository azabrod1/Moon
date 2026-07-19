/**
 * Planetarium Sun shaders.
 *
 * The photosphere deliberately lives in HDR linear light. Tone mapping and
 * eye adaptation decide how much detail survives; the source itself is never
 * authored as a flat display-white disc. Object-space noise keeps the sphere
 * seamless at the longitude wrap and poles.
 */

/** Where the whiteout's final act begins, as a fraction of the whiteout
 *  itself: below this the bleach is contrast-lift only; above it the radiance
 *  slam (both photosphere shader branches) and the DOM chrome flood ramp to
 *  full together. One definition site — the GLSL interpolates it. */
export const SUN_WHITEOUT_SLAM_EDGE = 0.85;

/** Active-region catalog — one definition site shared by the photosphere GLSL
 *  (spot groups, faculae, flare ribbons), the prominence shell (loop anchors),
 *  and the controller's flare scheduler (sunFlareEnvelope reads the
 *  period/seed pairs). Axes are object-space directions at activity latitudes,
 *  spread in longitude so any approach hemisphere carries at least one group
 *  without tiling spots over the star. At most three sites may carry a flare
 *  period — the shader packs their envelopes into one vec3 uniform. */
export const SUN_ACTIVE_REGIONS = [
  { axis: [0.38, -0.37, 0.85], scale: 1.0, flarePeriodSec: 47, flareSeed: 0.0 },
  { axis: [-0.85, 0.3, 0.43], scale: 0.75, flarePeriodSec: 61, flareSeed: 0.41 },
  { axis: [-0.2, -0.25, -0.95], scale: 0.9, flarePeriodSec: 53, flareSeed: 0.73 },
  { axis: [0.8, 0.33, -0.52], scale: 0.55, flarePeriodSec: 0, flareSeed: 0 },
] as const;

/** Prominence shell height: the shell mesh's geometry radius (PlanetFactory)
 *  and the shader's height-above-limb normalization derive from this one
 *  scale, in photosphere radii. */
export const SUN_PROMINENCE_SHELL_SCALE = 1.16;

/** Loop-prominence tube geometry, in photosphere radii. Each is a REAL torus
 *  arc mesh (PlanetFactory) anchored on a SUN_ACTIVE_REGIONS entry — painted
 *  shell ridges were tried first and contour into rings from any view that
 *  isn't perfectly side-on; solid tubes read from every angle, including
 *  head-on. footSpread is the half-angle to each foot along the east-west
 *  line; height is the quiescent crown height; tubeRadius the tube's
 *  cross-section radius. weight scales the emission. */
export const SUN_LOOP_PROMINENCES = [
  { regionIndex: 0, footSpread: 0.10, height: 0.105, tubeRadius: 0.030, weight: 1.0 },
  { regionIndex: 2, footSpread: 0.075, height: 0.070, tubeRadius: 0.023, weight: 0.8 },
] as const;

/** What fraction of the photosphere's light the fully-engaged study filter
 *  passes. One definition site: the photosphere GLSL dims its radiance by it,
 *  and the controller dims the veil by the same factor — the filter sits
 *  ahead of the whole optical stack, so PSF energy must fall with it or the
 *  additive glare re-floods the disc the filter just tamed. 0.18 parks even
 *  the brightest granule tops (detail 1.3 × convection 1.08 ≈ 5.3 HDR) under
 *  the bloom threshold: UnrealBloom's high-pass is near-binary, so a pixel
 *  a few percent over dumps its FULL color into the blur — there is no
 *  "gentle" over-threshold sparkle, only flood. */
export const SUN_STUDY_FILTER_FLOOR = 0.18;

/** How much of the lens-glare core survives the engaged study filter. Cut
 *  harder than the photosphere: the PSF wash is what re-greys the sunspot
 *  umbrae, and a filtered solar photo shows essentially no veiling glare. */
export const SUN_STUDY_GLARE_KEEP = 0.06;

/** How much of the wide veil survives the filter — deliberately more than
 *  the core: a soft tinted halo hugging the filtered disc keeps the close
 *  approach continuous with the blaze instead of snapping to a stark disc
 *  floating in black. The glare shader tints it to the filtergram hue by
 *  uStudyFilter, so the remnant can't put a broadband floor under the
 *  palette's near-zero blue. */
export const SUN_STUDY_VEIL_KEEP = 0.16;

const glslVec3 = (v: readonly [number, number, number]) =>
  `vec3(${v.map((x) => x.toFixed(4)).join(', ')})`;

/** GLSL: accumulate every catalog group's spot/faculae masks (into main()). */
const activeRegionCallsGlsl = SUN_ACTIVE_REGIONS
  .map((r) => `activeRegion(p, ${glslVec3(r.axis)}, ${r.scale.toFixed(3)}, umbra, penumbra, facRing);`)
  .join('\n  ');

/** GLSL: per-site flare ribbons weighted by the scheduled envelopes. */
const flareRibbonTermsGlsl = SUN_ACTIVE_REGIONS
  .filter((r) => r.flarePeriodSec > 0)
  .map((r, i) => `flare += uFlares${['.x', '.y', '.z'][i]} * flareRibbon(p, ${glslVec3(r.axis)}, ${r.scale.toFixed(3)});`)
  .join('\n  ');

export const sunPhotosphereVertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vObjectDirection;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  vObjectDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const sunPhotosphereFragmentShader = /* glsl */ `
uniform float time;
uniform float uAtmosphereMix;
uniform vec3 uAtmosphereColor;
uniform float uInteriorFade;
uniform float uWhiteout;
uniform float uStudyFilter;
uniform vec3 uFlares;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vObjectDirection;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(
      mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

float fbm3(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise3(p);
    p = p * 2.03 + vec3(13.1, 7.7, 5.3);
    amplitude *= 0.5;
  }
  return value;
}

// Byte-identical twin of the prominence shell's prominenceFbm (same lacunarity
// and offsets): sampling it at the same anchor coordinates makes the dark
// disc filaments and the limb prominences one structure — the same arcs read
// in absorption on the disc and in emission past the limb, like real Hα.
float anchorFbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 3; i++) {
    value += amplitude * noise3(p);
    p = p * 2.11 + vec3(9.2, 4.1, 6.6);
    amplitude *= 0.5;
  }
  return value;
}

// Sinless Hoskins hash: the Voronoi loop below runs it 27× per fragment, so
// the classic fract(sin(dot))·43758 form would cost three transcendentals a
// call (and carries this app's documented Metal precision baggage).
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float cellular3(vec3 p, float t) {
  vec3 cell = floor(p);
  vec3 local = fract(p);
  float minDistance2 = 10.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 neighbour = vec3(float(x), float(y), float(z));
        vec3 seed = hash33(cell + neighbour);
        // Each convection centre breathes around its own anchor (one scalar
        // sin per neighbour — the loop's only transcendental). The topology
        // evolves without a texture sheet visibly translating over the sphere.
        float breathe = sin((seed.x + seed.y + seed.z) * 6.28318 + t * 0.16) * 0.065;
        vec3 delta = neighbour + seed + breathe - local;
        minDistance2 = min(minDistance2, dot(delta, delta));
      }
    }
  }
  return sqrt(minDistance2);
}

float spotDisc(vec3 p, vec3 direction, float innerRadius, float outerRadius) {
  return smoothstep(cos(outerRadius), cos(innerRadius), dot(p, normalize(direction)));
}

// One bipolar active-region group from the shared catalog: a large leading
// spot and a smaller ragged follower separated along the east-west line
// (object +Y is the rotation axis), plus a plage ring for the limb faculae.
// Sizes are calibrated against the stylized granulation, not the real Sun:
// SDO/HMI groups span ~2% of the disc, but here a spot must clearly dominate
// a granulation cell (~0.028 rad) or it reads as one more dark lane.
void activeRegion(vec3 p, vec3 axis, float scale,
                  inout float umbra, inout float penumbra, inout float facRing) {
  vec3 a = normalize(axis);
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), a));
  vec3 lead = normalize(a + east * (0.095 * scale));
  vec3 trail = normalize(a - east * (0.120 * scale) + vec3(0.0, 0.045 * scale, 0.0));
  penumbra = max(penumbra, spotDisc(p, lead, 0.022 * scale, 0.090 * scale));
  penumbra = max(penumbra, spotDisc(p, trail, 0.016 * scale, 0.065 * scale));
  umbra = max(umbra, spotDisc(p, lead, 0.011 * scale, 0.042 * scale));
  umbra = max(umbra, spotDisc(p, trail, 0.008 * scale, 0.028 * scale));
  facRing = max(facRing, spotDisc(p, a, 0.10 * scale, 0.26 * scale));
}

// A flare's two-ribbon shape: a thin band along the group's neutral line
// (between the bipolar pair), confined to the group's core.
float flareRibbon(vec3 p, vec3 axis, float scale) {
  vec3 a = normalize(axis);
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), a));
  vec3 northish = cross(a, east);
  float band = 1.0 - smoothstep(0.006, 0.028 * scale, abs(dot(p, northish)));
  return band * spotDisc(p, a, 0.05 * scale, 0.14 * scale);
}

void main() {
  // The interior fog shell compiles this same source with SUN_INTERIOR
  // defined (a compile-time switch, not gl_FrontFacing: three flips the GL
  // front-face state for BackSide materials, so a facing test would read true
  // on the very fragments the cull keeps). It renders a flat molten fog
  // scaled by submersion depth (uInteriorFade: 1 at the surface, ember-dark
  // past mid-depth) instead of a telescope view of the far wall: diving in
  // reads as sinking into glowing plasma that closes over you.
  #ifdef SUN_INTERIOR
    vec3 fogDir = normalize(vObjectDirection);
    // A slow broad current keeps the fog from reading as a dead flat card
    // while staying far below granulation contrast.
    float current = fbm3(fogDir * 9.0 + vec3(time * 0.01, -time * 0.007, time * 0.005));
    vec3 fog = mix(vec3(1.0, 0.62, 0.20), vec3(1.0, 0.985, 0.94), 0.72);
    fog *= mix(0.88, 1.14, current);
    // Whiteout continuity: just below the photosphere the view is still the
    // saturated white wall of the crossing (the controller drives uWhiteout
    // from submersion here, mirroring the exterior proximity bleach); the
    // molten current only emerges as depth pulls it back down. The slam gate
    // matches the exterior's: the white target is so hot that an ungated mix
    // would pin the frame at even a third of the whiteout band.
    float interiorSlam = smoothstep(${SUN_WHITEOUT_SLAM_EDGE}, 1.0, uWhiteout);
    vec3 interiorGlow = mix(fog * 2.8 * uInteriorFade, vec3(26.0, 25.6, 24.4), interiorSlam);
    gl_FragColor = vec4(interiorGlow, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  #endif

  vec3 viewDir = normalize(-vPosition);
  float mu = clamp(dot(viewDir, normalize(vNormal)), 0.0, 1.0);
  vec3 p = normalize(vObjectDirection);

  // A low-frequency volume bends the cellular convection underneath it. The
  // cells themselves deform around fixed anchors rather than sliding over UVs.
  vec3 driftA = vec3(time * 0.025, -time * 0.018, time * 0.012);
  float broad = fbm3(p * 18.0 + driftA * 0.25);
  float cellDistance = cellular3(p * 36.0 + broad * 0.85, time);
  float cells = 1.0 - smoothstep(0.27, 0.69, cellDistance);
  float micro = fbm3(p * 104.0 + driftA * 0.8);
  float granules = clamp(cells + (micro - 0.5) * 0.11, 0.0, 1.0);

  // Dark intergranular lanes with a quiet large-scale convection modulation.
  float lanes = smoothstep(0.08, 0.90, granules);
  float convection = mix(0.92, 1.08, broad);
  float detail = mix(0.16, 1.30, pow(lanes, 0.72)) * convection;
  // The unfiltered range is authored for the blaze, where saturation eats
  // most of it; seen through the study filter it reads as polka dots. SDO
  // continuum granulation spans ~15% photometrically — compress to that.
  detail = mix(detail, mix(0.84, 1.12, pow(lanes, 0.72)) * convection, uStudyFilter);
  // Proximity whiteout: granulation contrast is the first casualty of the
  // final approach — lanes, cells, spots, and the limb all lift toward one
  // blinding level long before the energy slam at the end pins the frame.
  detail = mix(detail, 1.05, uWhiteout);
  float structureKeep = 1.0 - uWhiteout;

  // Sunspot groups from the shared active-region catalog, plus a few lone
  // pores trailing them. Umbra/penumbra accumulate as separate masks so the
  // two-tone (and the filament striation between them) composes below.
  float umbra = 0.0;
  float penumbra = 0.0;
  float facRing = 0.0;
  ${activeRegionCallsGlsl}
  umbra = max(umbra, spotDisc(p, normalize(vec3(0.29, -0.30, 0.91)), 0.006, 0.018));
  umbra = max(umbra, spotDisc(p, normalize(vec3(-0.78, 0.24, 0.55)), 0.005, 0.015));
  umbra = max(umbra, spotDisc(p, normalize(vec3(-0.28, -0.16, -0.94)), 0.006, 0.016));

  // Penumbral filaments: fine striation confined to the annulus between
  // penumbra and umbra. Faculae ride the plage ring and, like the real
  // thing, only brighten against the darkened limb.
  float annulus = clamp(penumbra - umbra, 0.0, 1.0);
  float filaments = (fbm3(p * 300.0) - 0.5) * 0.36;
  float faculae = facRing * (0.4 + 0.6 * granules) * pow(1.0 - mu, 1.6);

  // Broadband sunlight from space is white. Warmth is restricted to the last
  // sliver of the limb/chromosphere rather than baked through the whole disc.
  vec3 whiteHot = vec3(1.0, 0.985, 0.94);
  vec3 laneColor = vec3(1.0, 0.62, 0.20);
  vec3 warmLimb = vec3(1.0, 0.73, 0.36);
  float limbWarmth = pow(1.0 - mu, 3.5) * 0.5;
  vec3 color = mix(laneColor, whiteHot, smoothstep(0.12, 0.82, lanes));
  color = mix(color, warmLimb, limbWarmth);

  // Through the study filter the disc takes the filter's passband, not the
  // Sun's broadband white — an SDO/HMI-style orange-gold filtergram
  // (measured off the reference stills: red pinned near max across the
  // disc, green carrying the limb darkening, blue nearly zero). The
  // per-channel limb terms counteract the scalar limb darkening on red and
  // deepen it on green so the limb goes deep orange instead of grey.
  // Values are pre-compensated for ACES Filmic's desaturating channel
  // crosstalk: authored more saturated and dimmer than the target so the
  // tonemapped output lands on the reference palette.
  vec3 filtergram = vec3(2.6, 0.48, 0.004);
  filtergram.r *= mix(1.0, 2.1, pow(1.0 - mu, 1.1));
  filtergram.g *= mix(1.0, 0.80, pow(1.0 - mu, 1.4));
  color = mix(color, filtergram, uStudyFilter);

  float limbDarkening = mix(0.40 + 0.60 * pow(mu, 0.62), 1.0, uWhiteout);
  float radiance = 3.8 * limbDarkening * detail;
  // Spot two-tone: penumbra ~60% photospheric intensity with filament
  // texture, umbra a near-black ~8% — deep enough to survive the tonemapper
  // at the close-study exposure tier.
  float spotTone = mix(1.0, 0.60 + filaments, annulus);
  spotTone = mix(spotTone, 0.08, umbra);
  radiance *= mix(1.0, spotTone, structureKeep);
  radiance *= 1.0 + faculae * 0.55 * structureKeep;

  // Dark filaments (uStudyFilter-gated): prominences seen against the disc
  // absorb instead of emit, so the SAME anchor field the shell reads (same
  // fbm, same drift) is contoured into thin snaking dark threads here. Where
  // a thread crosses the limb it hands off to the shell's pink flames.
  float filamentAnchor = anchorFbm(p * 3.6 + vec3(time * 0.006, 0.0, -time * 0.0045));
  float filament = smoothstep(0.60, 0.665, filamentAnchor)
    * (1.0 - smoothstep(0.665, 0.73, filamentAnchor));
  filament *= 0.55 + 0.45 * noise3(p * 40.0);
  radiance *= 1.0 - 0.38 * filament * uStudyFilter * structureKeep;

  // The study filter (sunStudyFilterFraction in the controller): dims the
  // photosphere itself below the bloom knee for the close-up study view —
  // scene exposure can't do it, the bloom pass reads this raw value. The
  // floor parks the brightest granule tops (detail 1.3 × convection 1.08 ≈
  // 5.3 HDR) just over the bloom threshold, so the disc keeps a breath of
  // sparkle while lanes, spots, and prominences stay legible. Applied
  // BEFORE the flare term so a flare pierces the filter and blooms the way
  // real flares saturate filtered solar cameras.
  radiance *= mix(1.0, ${SUN_STUDY_FILTER_FLOOR.toFixed(4)}, uStudyFilter);

  // Flares: the controller schedules each site's envelope (sunFlareEnvelope
  // in sunAppearance.ts) into uFlares; the two-ribbon shape slams HDR
  // radiance so exposure and bloom sell the event, never a painted white
  // patch outside the star's tonemap response.
  float flare = 0.0;
  ${flareRibbonTermsGlsl}
  radiance += flare * 8.0 * structureKeep;

  // When the camera→Sun sightline skims a planet's atmosphere, extinguish the
  // white source and pull it toward that atmosphere's sunset colour. This is
  // driven by geometry in the controller, not by camera position alone.
  color = mix(color, uAtmosphereColor, uAtmosphereMix * 0.82);
  radiance *= mix(1.0, 0.62, uAtmosphereMix);

  // The whiteout bleaches by ENERGY, never by painting display white: colour
  // lifts to the broadband white-hot and the last stretch slams the HDR
  // radiance so the tonemapper itself saturates every channel — the overwhelm
  // stays inside the same exposure/tonemap response as the rest of the star.
  // The colour lift is gated deep into the whiteout so the approach stays
  // one monotonic ramp — white star, warming gold, orange filtergram — and
  // white returns exactly once, as the blinding wall at contact, instead of
  // a puzzling white band between the orange disc and the blaze.
  color = mix(color, whiteHot, smoothstep(0.55, 0.95, uWhiteout));
  radiance = mix(radiance, 26.0, smoothstep(${SUN_WHITEOUT_SLAM_EDGE}, 1.0, uWhiteout));

  gl_FragColor = vec4(color * radiance, 1.0);
  // No-ops into the composer's render target (the OutputPass grades there);
  // on the direct-to-canvas fallback they keep the photosphere inside the
  // same exposure/tonemap/colour response as every built-in material.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Glare plane extent in photosphere radii — geometry size, uExtent uniform,
 *  and the controller's screen-coverage gate all derive from this one value. */
export const SUN_GLARE_EXTENT_SOLAR_RADII = 8;

/** Prominence / chromosphere shell for close-approach limb detail: a spicule
 *  fringe hugging the limb, ragged flame prominences anchored to fixed surface
 *  locations, and two explicit loop prominences arching off the limb at the
 *  photosphere's active regions. The fragment computes true height above the
 *  limb (perpendicular distance from the Sun's centre to the view ray), so
 *  structure tapers with altitude instead of reading as a uniform glow ring. */
export const sunProminenceVertexShader = /* glsl */ `
varying vec3 vPosition;
varying vec3 vObjectDirection;
varying vec3 vCentreView;
varying float vPhotoRadiusView;

void main() {
  vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  vObjectDirection = normalize(position);
  vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vCentreView = centre.xyz;
  vPhotoRadiusView = length(vPosition - centre.xyz) / ${SUN_PROMINENCE_SHELL_SCALE.toFixed(4)};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const sunProminenceFragmentShader = /* glsl */ `
uniform float time;
uniform float uCloseVisibility;
uniform float uWhiteout;
uniform float uEruption;
uniform float uRain;
varying vec3 vPosition;
varying vec3 vObjectDirection;
varying vec3 vCentreView;
varying float vPhotoRadiusView;

float prominenceHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float prominenceNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(prominenceHash(i), prominenceHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(prominenceHash(i + vec3(0.0, 1.0, 0.0)), prominenceHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(prominenceHash(i + vec3(0.0, 0.0, 1.0)), prominenceHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(prominenceHash(i + vec3(0.0, 1.0, 1.0)), prominenceHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

float prominenceFbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 3; i++) {
    value += amplitude * prominenceNoise(p);
    p = p * 2.11 + vec3(9.2, 4.1, 6.6);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  // Beyond close approach the whole shell is invisible; skip the noise work.
  if (uCloseVisibility < 0.004) discard;

  vec3 rayDir = normalize(vPosition);
  float along = dot(vCentreView, rayDir);
  float impact = length(vCentreView - rayDir * along);
  // Apparent height above the photosphere limb, in photosphere radii.
  float h = impact / max(vPhotoRadiusView, 1e-9) - 1.0;
  vec3 p = vObjectDirection;

  // Chromosphere fringe: a thin spiky rim hugging both sides of the limb.
  float spic = prominenceNoise(p * 46.0 - vec3(0.0, time * 0.14, 0.0));
  float fringe = exp(-abs(h + 0.004) * 160.0) * (0.35 + 0.65 * spic);

  // Flame prominences: sparse arcs anchored in object space (fixed surface
  // locations, not the screen limb), with ragged tops that taper toward the
  // shell ceiling. The anchor field drifts on an hours-long scale.
  // Anchors drift on an hours scale (they are surface structures); the flame
  // bodies and fine detail churn visibly at 1x so the limb reads alive.
  float anchor = prominenceFbm(p * 3.6 + vec3(time * 0.006, 0.0, -time * 0.0045));
  float act = smoothstep(0.52, 0.74, anchor);
  float flame = prominenceFbm(p * 16.0 + vec3(0.0, time * 0.2, 0.0));
  float fine = prominenceNoise(p * 44.0 + vec3(time * 0.16, 0.0, 0.0));
  float hn = clamp(h / ${(SUN_PROMINENCE_SHELL_SCALE - 1).toFixed(4)}, 0.0, 1.0);
  // The eruption cycle (sunProminenceEruption in the controller) swells every
  // flame's reach a little; the loop arches are real tube meshes
  // (sunLoopFragmentShader) sharing this material's uniforms.
  float reach = act * (0.25 + 0.75 * flame) * (1.0 + 0.35 * uEruption);
  float flames = act * smoothstep(reach, reach * 0.3, hn) * (0.55 + 0.45 * fine);

  // Off-limb structure only: over the disc the photosphere owns the view and
  // prominences would read as smudges, so everything but the fringe fades
  // out a breath inside the limb. The whiteout bleaches the shell with the
  // rest of the star on final approach.
  float aboveLimb = smoothstep(-0.015, 0.01, h);
  float structure = fringe * 0.5 + flames * 0.65 * aboveLimb;
  float alpha = structure * uCloseVisibility * (1.0 - uWhiteout);
  if (alpha < 0.004) discard;
  alpha = min(alpha, 1.0);

  // Hα colour evolution with height: bright pink at the chromospheric
  // footpoints, the classic pink-red through the body, cooling to a dim
  // crimson at the ragged tops — and an erupting mass cools further as it
  // lifts and thins.
  vec3 footpoint = vec3(3.4, 0.44, 0.22);
  vec3 body = vec3(2.6, 0.26, 0.10);
  vec3 tops = vec3(1.15, 0.06, 0.04);
  vec3 color = mix(footpoint, body, smoothstep(0.02, 0.35, hn));
  color = mix(color, tops, smoothstep(0.40, 1.0, hn));
  color = mix(color, tops, uEruption * smoothstep(0.30, 0.90, hn) * 0.7);
  color *= 0.9 + 0.25 * fine;
  gl_FragColor = vec4(color * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Loop-prominence tube shaders. The mesh is a torus arc (foot → crown →
 *  foot; uv.x runs along the arc, uv.y around the tube), so the arch is true
 *  geometry and survives every viewing angle. The material shares the
 *  prominence shell's uniforms object — time, close visibility, whiteout,
 *  eruption, and rain arrive for free — and SUN_LOOP_WEIGHT is a per-mesh
 *  define. */
export const sunLoopVertexShader = /* glsl */ `
uniform float time;
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vPositionView;

float loopVHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float loopVNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(loopVHash(i), loopVHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(loopVHash(i + vec3(0.0, 1.0, 0.0)), loopVHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(loopVHash(i + vec3(0.0, 0.0, 1.0)), loopVHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(loopVHash(i + vec3(0.0, 1.0, 1.0)), loopVHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  vUv = uv;
  // The arch is a plasma rope, not a bent pipe: a slow out-of-plane sway,
  // an in-plane crown breath, and a faster small ripple, all growing toward
  // the crown so the chromospheric feet stay anchored. Periods are tens of
  // seconds — massive, not fluttery. Geometry space is the canonical torus
  // (arc in XY around the origin), so local +Z is out-of-plane and the
  // radial direction points along the arch's local "up".
  float s = uv.x;
  float hn = 4.0 * s * (1.0 - s);
  vec3 pos = position;
  float sway = loopVNoise(vec3(s * 2.6 + SUN_LOOP_SEED, time * 0.09, 3.7)) - 0.5;
  float breathe = loopVNoise(vec3(s * 4.2 + SUN_LOOP_SEED, time * 0.06, 8.9)) - 0.5;
  float ripple = loopVNoise(vec3(s * 9.0 + SUN_LOOP_SEED, time * 0.22, 5.1)) - 0.5;
  // Mid-frequency kinks so the silhouette never reads as a clean bent pipe,
  // plus per-vertex cross-section lumps so the tube profile is never a
  // perfect circle anywhere along the arc.
  float kink = loopVNoise(vec3(s * 14.0 + SUN_LOOP_SEED, time * 0.12, 2.2)) - 0.5;
  float kinkZ = loopVNoise(vec3(s * 16.0 + SUN_LOOP_SEED, time * 0.11, 9.4)) - 0.5;
  float lumpy = loopVNoise(vec3(s * 30.0 + SUN_LOOP_SEED, uv.y * 4.0, time * 0.16)) - 0.5;
  vec3 radialDir = normalize(vec3(pos.x, pos.y, 0.0));
  pos.z += hn * (sway * 5.0 + kinkZ * 2.4) * SUN_LOOP_TUBE;
  pos += radialDir * hn * (breathe * 3.2 + ripple * 1.1 + kink * 2.2) * SUN_LOOP_TUBE;
  pos += normal * lumpy * (0.5 + 0.4 * hn) * SUN_LOOP_TUBE;
  // Normals are left undisplaced: the material is additive emission and the
  // silhouette-brightening term only needs an approximate normal.
  vNormalView = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vPositionView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const sunLoopFragmentShader = /* glsl */ `
uniform float time;
uniform float uCloseVisibility;
uniform float uWhiteout;
uniform float uEruption;
uniform float uRain;
varying vec2 vUv;
varying vec3 vNormalView;
varying vec3 vPositionView;

float loopHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float loopNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(loopHash(i), loopHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(loopHash(i + vec3(0.0, 1.0, 0.0)), loopHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(loopHash(i + vec3(0.0, 0.0, 1.0)), loopHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(loopHash(i + vec3(0.0, 1.0, 1.0)), loopHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  if (uCloseVisibility < 0.004) discard;

  // Arc coordinate: 0 at one foot, 1 at the other, crown at 0.5. The crown
  // height fraction stands in for the shell shader's height-above-limb.
  float s = vUv.x;
  float hn = 4.0 * s * (1.0 - s);

  // Fibre field (calibrated against SDO 304 close-ups: everything off-limb
  // is translucent bundles of thin strands, never a solid surface). The
  // threads wind helically around the tube and STREAM along it — the
  // field-aligned flows real prominences show. Two scales: coarse ropes and
  // fine threads, both elongated along the arc.
  float w = vUv.y + s * 3.0;
  // Fast enough that the streaming reads within a couple of seconds of
  // watching — flow you have to wait a minute to notice is flow that
  // doesn't exist.
  float flow = time * 0.55;
  float ropes = loopNoise(vec3(w * 4.0, s * 9.0 - flow, SUN_LOOP_SEED));
  float threads = loopNoise(vec3(w * 9.0, s * 26.0 - flow * 2.0, SUN_LOOP_SEED + 4.2));
  float fibre = ropes * 0.6 + threads * 0.4;
  // Gaps between strands keep the bundle translucent — but over a base haze
  // floor: the additive output is premultiplied, so contribution scales as
  // alpha squared and an unfloored strand field fades the whole arch out.
  float strands = 0.18 + 0.82 * smoothstep(0.32, 0.78, fibre);

  // Volumetric density, not solid-body shading: slightly denser through the
  // middle (longer path), and a FRAYED silhouette — the fibre noise gates
  // the rim so the outline breaks into wisps instead of a clean curve.
  float nv = abs(dot(normalize(vNormalView), normalize(-vPositionView)));
  float chord = mix(0.5, 1.0, nv);
  float rim = smoothstep(0.02, 0.32, nv + (fibre - 0.5) * 0.6);

  // Coronal rain: condensed knots streaming from the crown down both legs
  // (the pattern coordinate advances toward the feet with time).
  float q = (0.5 - abs(s - 0.5)) * 30.0 - time * 2.2;
  float beads = smoothstep(0.55, 0.9, loopNoise(vec3(q, vUv.y * 2.0, 3.3)));
  float rain = uRain * beads * 0.9;

  // Thin out toward peak lift-off; the feet anchor hotter than the crown.
  // A slow presence drift keeps the quiescent arch from reading as a
  // permanent fixture — it thickens and thins like the real thing
  // reorganising.
  float eruptionFade = 1.0 - 0.5 * smoothstep(0.65, 1.0, uEruption);
  float presence = 0.72 + 0.28 * loopNoise(vec3(time * 0.05, SUN_LOOP_SEED, 1.7));
  float alpha = strands * chord * rim * (1.0 + rain) * mix(1.2, 0.8, hn)
    * eruptionFade * presence * float(SUN_LOOP_WEIGHT)
    * uCloseVisibility * (1.0 - uWhiteout) * 1.5;
  if (alpha < 0.004) discard;
  alpha = min(alpha, 1.0);

  // Same Hα ramp as the shell: pink feet, red body, crimson crown; an
  // erupting mass cools further as it lifts.
  vec3 footpoint = vec3(3.4, 0.44, 0.22);
  vec3 body = vec3(2.6, 0.26, 0.10);
  vec3 tops = vec3(1.15, 0.06, 0.04);
  vec3 color = mix(footpoint, body, smoothstep(0.02, 0.35, hn));
  color = mix(color, tops, smoothstep(0.40, 1.0, hn));
  color = mix(color, tops, uEruption * smoothstep(0.30, 0.90, hn) * 0.7);
  // Individual strands catch their own light.
  color *= 0.75 + 0.5 * threads;
  gl_FragColor = vec4(color * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Ejecta shaders: the plasma mass that leaves during an eruption's release
 *  (sunProminenceEjecta). A stretched sphere shell whose alpha is streaked
 *  noise elongated along the travel axis — an expanding, cooling, fraying
 *  cloud that detaches from the arch and recedes until it fades out. */
export const sunEjectaVertexShader = /* glsl */ `
uniform float time;
uniform float uEjectaTravel;
varying vec3 vDir;
varying vec3 vNormalView;
varying vec3 vPositionView;

float ejectaVHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float ejectaVNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(ejectaVHash(i), ejectaVHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(ejectaVHash(i + vec3(0.0, 1.0, 0.0)), ejectaVHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(ejectaVHash(i + vec3(0.0, 0.0, 1.0)), ejectaVHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(ejectaVHash(i + vec3(0.0, 1.0, 1.0)), ejectaVHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  vDir = normalize(position);
  // No perfect shapes: coarse lumps and finer bulges knead the sphere into
  // an irregular cloud, roughening further as the mass expands. The
  // silhouette must never read as an ellipse.
  float lump = ejectaVNoise(vDir * 2.6 + vec3(0.0, -time * 0.09, 0.0)) - 0.5;
  float bulge = ejectaVNoise(vDir * 6.5 + vec3(time * 0.07, 0.0, 0.0)) - 0.5;
  float knead = 1.0 + (lump * 0.62 + bulge * 0.28) * (1.0 + 0.5 * uEjectaTravel);
  vec3 pos = position * knead;
  vNormalView = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vPositionView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const sunEjectaFragmentShader = /* glsl */ `
uniform float time;
uniform float uCloseVisibility;
uniform float uWhiteout;
uniform float uEjecta;
uniform float uEjectaTravel;
varying vec3 vDir;
varying vec3 vNormalView;
varying vec3 vPositionView;

float ejectaHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float ejectaNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(ejectaHash(i), ejectaHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(ejectaHash(i + vec3(0.0, 1.0, 0.0)), ejectaHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(ejectaHash(i + vec3(0.0, 0.0, 1.0)), ejectaHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(ejectaHash(i + vec3(0.0, 1.0, 1.0)), ejectaHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  if (uEjecta < 0.004) discard;

  // Streaked cloud: noise squashed along local +Y (the travel axis), so the
  // mass reads as streamers trailing back toward the surface it left. The
  // pattern loosens as the cloud expands (travel opens the gaps).
  vec3 p = vDir;
  float streak = ejectaNoise(vec3(p.x * 6.0, p.y * 1.8 - time * 0.55, p.z * 6.0));
  float wisp = ejectaNoise(vec3(p.x * 13.0, p.y * 4.0 - time * 0.9, p.z * 13.0));
  float cloud = streak * 0.62 + wisp * 0.38;
  float gapOpen = mix(0.30, 0.50, uEjectaTravel);
  float strands = smoothstep(gapOpen, 0.9, cloud);

  // A translucent emission cloud: brightest through the middle (longest
  // chord) and fading OUT at the silhouette — a floor there reads as a
  // solid egg. Denser streamer tail on the sunward side (-Y).
  float nv = abs(dot(normalize(vNormalView), normalize(-vPositionView)));
  float shellSoft = pow(nv, 1.4);
  float tail = 1.0 + 0.6 * smoothstep(0.2, -0.8, p.y);

  float alpha = strands * shellSoft * tail * uEjecta
    * uCloseVisibility * (1.0 - uWhiteout) * 0.34;
  if (alpha < 0.004) discard;
  alpha = min(alpha, 1.0);

  // Cools from the arch's pink-red toward a dim crimson as it recedes.
  vec3 hot = vec3(3.1, 0.32, 0.13);
  vec3 cold = vec3(1.1, 0.06, 0.04);
  vec3 color = mix(hot, cold, uEjectaTravel);
  color *= 0.8 + 0.45 * wisp;
  gl_FragColor = vec4(color * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Camera-facing glare plane. Its radius is `uExtent` photosphere radii. */
export const sunGlareVertexShader = /* glsl */ `
uniform float uMinHalfSizePx;
uniform float uVeilHalfPx;
uniform float uViewportHeight;
varying vec2 vUv;
varying float vExtentScale;
varying float vHalfSizePx;

void main() {
  vUv = uv;
  // Expand the plane in camera-view XY around the transformed Sun centre. It
  // remains a circular billboard without a per-frame CPU quaternion update.
  vec4 centreView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float halfSize = max(abs(position.x), abs(position.y));
  float physicalHalfNdc = projectionMatrix[1][1] * halfSize / max(-centreView.z, 1e-6);
  // A minimum screen-space footprint preserves an optical glint in the outer
  // system after the physical photosphere becomes sub-pixel.
  float baseMinNdc = (uMinHalfSizePx * 2.0) / max(uViewportHeight, 1.0);
  float baseHalfNdc = max(physicalHalfNdc, baseMinNdc);
  // The wide screen-space veiling glare (fragment) needs a far larger billboard
  // to paint its wash into. It only ever grows the quad; the physical/min
  // footprint above is the floor it can never fall below.
  float veilMinNdc = (uVeilHalfPx * 2.0) / max(uViewportHeight, 1.0);
  float drawnHalfNdc = max(baseHalfNdc, veilMinNdc);
  float sizeBoost = drawnHalfNdc / max(physicalHalfNdc, 1e-7);
  centreView.xy += position.xy * sizeBoost;
  // Two channels the fragment needs. vExtentScale is how much the veil grew the
  // quad past its physical/min size (1.0 when the veil is idle): the fragment
  // rebases the physical PSF by it so growth can't stretch the core/starburst.
  // vHalfSizePx is the quad's true on-screen half-size in CSS pixels (the
  // same unit as uViewportHeight), making the veil a pure screen-space
  // function immune to that same growth.
  vExtentScale = drawnHalfNdc / max(baseHalfNdc, 1e-7);
  vHalfSizePx = drawnHalfNdc * uViewportHeight * 0.5;
  gl_Position = projectionMatrix * centreView;
}
`;

/** The veiling-glare wash profile: a screen-space Moffat with this scale (as a
 *  fraction of viewport height) and outer exponent. Interpolated into the
 *  fragment shader below AND inverted by the controller's support solver
 *  (computeSunVeilSupport) to size the billboard — one definition site, so the
 *  drawn profile and the derived support can never drift apart. */
export const SUN_VEIL_SCALE_H = 0.022;
export const SUN_VEIL_BETA = 1.12;

export const sunGlareFragmentShader = /* glsl */ `
uniform float uExtent;
uniform float uVisibleFraction;
uniform float uGlareStrength;
uniform float uPointLike;
uniform float uCameraFx;
uniform float uEclipseLike;
uniform float uOccluderRadii;
uniform float uOccluderShade;
uniform vec2 uOccluderOffsetSr;
uniform float uExposureScale;
uniform float uEmergenceFlash;
uniform float uAtmosphereMix;
uniform vec3 uAtmosphereColor;
uniform float uVeilStrength;
uniform float uVeilWarmth;
uniform float uVeilAmt;
uniform float uStudyFilter;
uniform float uSpikeSustain;
uniform float uViewportHeight;
uniform float uArmDecayPx;
uniform float uArmDecayYPx;
uniform float uArmCoeff;
varying vec2 vUv;
varying float vExtentScale;
varying float vHalfSizePx;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm2(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 3; i++) {
    value += amplitude * noise2(p);
    p = p * 2.07 + vec2(7.1, 3.7);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float planeRadius = length(p);
  // The veiling glare below can enlarge this billboard far past the physical
  // glare quad. Re-express every physical PSF term in the pre-veil ("base")
  // quad frame so that growth can never stretch the core/aureole/starburst:
  // vExtentScale is 1.0 whenever the veil is idle, so this is a no-op then.
  vec2 pB = p * vExtentScale;
  float baseRadius = planeRadius * vExtentScale;
  // All derivatives are taken before the discard: fwidth after a neighbouring
  // lane discards is formally undefined. Reading the base frame keeps the spike
  // widths a constant pixel size no matter how much the veil grew the quad.
  float widthX = max(fwidth(pB.y) * 1.35, 0.010);
  float widthY = max(fwidth(pB.x) * 1.35, 0.010);
  float diagonalWidthA = max(fwidth(pB.x - pB.y) * 1.25, 0.014);
  float diagonalWidthB = max(fwidth(pB.x + pB.y) * 1.25, 0.014);
  float sensorWidth = max(fwidth(pB.y) * 1.15, 0.007);
  if (planeRadius >= 1.0) discard;

  float solarRadii = baseRadius * uExtent;
  float outside = max(solarRadii - 1.0, 0.0);
  // The veil can grow the quad far past the physical glare's disc. Fade the
  // physical PSF and corona in their own base frame so their edge stays put no
  // matter how much the veil enlarged the billboard; when the veil is idle
  // baseRadius === planeRadius and this equals edgeFade byte-for-byte. The wide
  // veil keeps fading by the drawn-quad edgeFade below as its own safety net.
  float baseEdgeFade = 1.0 - smoothstep(0.72, 0.94, baseRadius);
  float edgeFade = 1.0 - smoothstep(0.72, 0.94, planeRadius);

  // Optical point-spread profile: a tight hot core, medium aureole, and a
  // faint long tail. This keeps the glare white near the source and avoids the
  // giant orange Gaussian blob produced by the old canvas gradients.
  // Once the photosphere is sub-pixel the rasterizer can no longer deliver its
  // HDR radiance, so the core term takes over that energy: the outer-system
  // Sun stays a blinding point that still drives bloom, not a grey smudge.
  float core = exp(-outside * 2.40) * mix(0.24, 4.5, uPointLike);
  float aureole = 0.015 / (1.0 + outside * outside * 0.90);
  float tail = 0.0016 / pow(max(solarRadii, 1.0), 1.50);
  float visibleEnergy = pow(clamp(uVisibleFraction, 0.0, 1.0), 0.38);
  // The scene's exposure adaptation also tempers the lens glare (uExposureScale
  // = sqrt(exposure)), so staring into the Sun tightens the halo the way a
  // stopped-down camera would instead of gaining 1.5 stops on the scene.
  float glare = (core + aureole + tail) * visibleEnergy * uGlareStrength * uExposureScale;

  // Once the solar disc becomes only a few pixels wide, a restrained optical
  // starburst keeps it distinct from the starfield. Derivative-scaled widths
  // stay stable from high-DPI desktop captures down to the mobile fallback.
  float horizontal = exp(-abs(pB.y) / widthX) * exp(-abs(pB.x) * 1.70);
  float vertical = exp(-abs(pB.x) / widthY) * exp(-abs(pB.y) * 2.75) * 0.52;
  float diagonal = (
    exp(-abs(pB.x - pB.y) / diagonalWidthA)
    + exp(-abs(pB.x + pB.y) / diagonalWidthB)
  ) * exp(-baseRadius * 3.4) * 0.10;
  // uPointLike alone kills the spikes once the disc resolves past ~10 px, but
  // the reference stills show long thin diffraction spikes WITH a visible disc.
  // Carry a fraction of them through the mid-range on the camera-fx term.
  float starburst = (horizontal + vertical + diagonal)
    * max(uPointLike, uCameraFx * uSpikeSustain) * visibleEnergy * 0.30;
  glare += starburst;

  // A short, low-energy sensor streak bridges the scale range where the disc
  // is resolved but still overwhelmingly bright. It fades away for close-up
  // photosphere study and yields to the sharper starburst in the outer system.
  float sensorLine = exp(-abs(pB.y) / sensorWidth)
    * exp(-abs(pB.x) * 1.55);
  float sensorStreak = sensorLine * uCameraFx * (1.0 - uPointLike * 0.72)
    * visibleEnergy * 0.055;
  glare += sensorStreak;

  // Limb crossings and third contact briefly overwhelm the virtual optics
  // before exposure adaptation catches up. The controller supplies a
  // derivative-triggered impulse with a short exponential decay.
  float emergenceBloom = exp(-outside * 1.25) * uEmergenceFlash * visibleEnergy * 1.15;
  glare = (glare + emergenceBloom) * mix(1.0, 0.60, uAtmosphereMix);

  // A body deep into covering the Sun reads as a dark silhouette even through
  // the lens wash: optics can only glare with the light that still passes,
  // and none passes where the occluder stands. Carve its true disc — offset
  // and radius arrive from the controller in solar radii — out of the PSF
  // and the wide veil below; the floor leaves a breath of scattered haze so
  // the disc sits in the glare rather than being punched out of it. Shallow
  // partials arrive with uOccluderShade 0 and keep the full wash.
  float occluderDistance = length(pB * uExtent - uOccluderOffsetSr);
  float occluderCore = 1.0 - smoothstep(uOccluderRadii - 0.07, uOccluderRadii + 0.05, occluderDistance);
  float silhouette = 1.0 - uOccluderShade * 0.88 * occluderCore;
  glare *= silhouette;

  // --- Wide screen-space veiling glare ---
  // Real space-camera stills show the Sun's light washing across a big fraction
  // of the frame even when the disc is only a few pixels wide. This term is a
  // pure function of ON-SCREEN pixel distance (never solar radii), so the
  // vertex min-size boost cannot warp its shape. uVeilAmt already carries the
  // occlusion energy (0 in totality / behind a body or ring), the Mercury->Pluto
  // distance falloff, and the huge-disc cutoff, so the billboard the controller
  // sized and this intensity stay in lockstep. It is a broad wash, not a second
  // core; edgeFade below carries it smoothly to zero before the quad's disc edge.
  float pixelDist = planeRadius * vHalfSizePx;
  float dHat = pixelDist / max(uViewportHeight, 1.0);
  // Single power-law, deliberately plateau-free: any flat stretch or visible
  // boundary makes the wash read as a grey fog disc instead of light. Bright
  // near the core, then a continuous shallow fall the eye can't find an edge
  // on. The compact scale keeps the perceptible halo modest — the Sun reads
  // dangerously bright through saturation and exposure, never by painting a
  // wide grey footprint. Scale and exponent interpolate from the shared
  // constants the controller's support solver inverts.
  float dNorm = dHat / ${SUN_VEIL_SCALE_H};
  float veilShape = 1.0 / pow(1.0 + dNorm * dNorm, ${SUN_VEIL_BETA});
  // Long thin diffraction arms, also in true pixels: the base-quad starburst
  // can never exceed the physical footprint (~40 px at 1 AU), while reference
  // stills show spikes spanning hundreds. Gaussian cross-section a couple of
  // pixels wide; the horizontal pair reaches farther than the vertical, like
  // an aperture's dominant axis. The decay lengths and coefficient arrive from
  // the controller already scaled by the veil's reach and faded as the disc
  // resolves, so the arms collapse with distance in step with the quad the
  // controller sized: long at 1 AU, a short stub in the outer system. The
  // diagonal pair the veil used to carry is gone — the base-quad starburst
  // already draws the small diagonals that are the camera's signature at point
  // scale.
  vec2 pxOff = p * vHalfSizePx;
  float armAcross = pxOff.y / 1.7;
  float armAcrossV = pxOff.x / 1.7;
  float armX = exp(-armAcross * armAcross) * exp(-abs(pxOff.x) / max(uArmDecayPx, 1.0));
  float armY = exp(-armAcrossV * armAcrossV) * exp(-abs(pxOff.y) / max(uArmDecayYPx, 1.0)) * 0.25;
  float veilEnergy = uVeilStrength * uVeilAmt * uExposureScale
    * (1.0 + 0.5 * uEmergenceFlash) * mix(1.0, 0.60, uAtmosphereMix);
  float veil = (veilShape + (armX + armY) * uArmCoeff) * veilEnergy * silhouette;

  // Once the photosphere is covered, remove its glare and reveal a restrained
  // white corona. Broad bipolar lobes plus fine angular strands keep totality
  // from reading as another perfectly circular radial gradient. uEclipseLike
  // (CPU-computed Sun/occluder angular-size ratio) keeps the corona to true
  // eclipse geometry: a whole planet blotting out the sky reveals nothing.
  // The block stays behind a real branch: its atan/normalize are undefined at
  // the quad centre, and even multiplied by zero a NaN would poison the pixel.
  // It reads the base frame (pB/baseRadius) too, so a veil-enlarged quad during
  // the partial phase leaves the solar-radii corona geometry untouched.
  float coverage = 1.0 - clamp(uVisibleFraction, 0.0, 1.0);
  float eclipse = smoothstep(0.97, 0.995, coverage) * clamp(uEclipseLike, 0.0, 1.0);
  float corona = 0.0;
  float chromosphere = 0.0;
  if (eclipse > 0.0 && baseRadius > 1e-4) {
    float angle = atan(pB.y, pB.x);
    float cloudWarp = fbm2(pB * 2.7 + (pB / baseRadius) * solarRadii * 0.13);
    float angleWarp = angle
      + sin(angle * 3.0 + solarRadii * 0.18) * 0.025
      + (cloudWarp - 0.5) * 0.07;
    // The glare plane is screen-space (no depth test), so the eclipsing body
    // cannot z-mask it; carve its disc out analytically instead. The corona
    // hugging that black limb — not a wash across it — is what makes totality
    // read. uOccluderRadii is the occluder's angular size in solar radii.
    float occluderEdge = max(uOccluderRadii, 1.0);
    float occluderMask = smoothstep(occluderEdge - 0.05, occluderEdge + 0.03, solarRadii);
    float pastLimb = max(solarRadii - occluderEdge, 0.0);
    // Real coronas are lobed and ragged: two broad equatorial streamers, a
    // few polar plumes, and cloudWarp-modulated fine rays with no readable
    // periodicity, all falling off steeply away from the bright limb ring.
    float broadStreamers = pow(abs(cos(angleWarp - 0.18)), 2.6);
    float polarPlumes = pow(abs(sin(angleWarp + 0.08)), 7.0) * 0.32;
    float fineStreamers = pow(0.5 + 0.5 * cos(angleWarp * 17.0 + cloudWarp * 0.6), 20.0)
      * (0.4 + 1.2 * cloudWarp);
    float coronaTexture = mix(0.72, 1.16, cloudWarp);
    float innerCorona = exp(-pastLimb * 3.2) * 0.5;
    float coronaShape = (
      0.03 + broadStreamers + polarPlumes + fineStreamers * 0.10
    ) * coronaTexture;
    float coronaFalloff = exp(-pastLimb * 0.75) / pow(max(solarRadii, 1.0), 0.7);
    corona = eclipse * occluderMask * (innerCorona + coronaShape * coronaFalloff * 0.75);

    // The chromosphere is normally drowned by the photosphere. Behind the
    // occluder mask it survives only while the cover is barely larger than
    // the disc — which is exactly the second/third-contact flash.
    float chromosphereNoise = 0.72 + 0.28 * sin(angle * 19.0 + cloudWarp * 5.0);
    chromosphere = eclipse * occluderMask * exp(-outside * 13.0) * chromosphereNoise * 0.35;
  }

  float warmth = smoothstep(1.6, 7.0, solarRadii) * 0.30;
  vec3 glareColor = mix(vec3(1.0, 0.985, 0.94), vec3(1.0, 0.67, 0.30), warmth);
  glareColor = mix(glareColor, uAtmosphereColor, uAtmosphereMix * 0.88);
  // The veil is broadband white; an optional whisper of warmth grows only in
  // the outer fade behind the uVeilWarmth knob. It takes the same atmosphere
  // tint the core glare does, so a grazed-atmosphere Sun warms both together.
  vec3 veilColor = mix(vec3(1.0, 0.99, 0.965), vec3(1.0, 0.80, 0.52),
    uVeilWarmth * smoothstep(0.25, 0.9, dHat));
  veilColor = mix(veilColor, uAtmosphereColor, uAtmosphereMix * 0.88);
  // Whatever glare survives the study filter passes through it: tint the
  // remnant to the filtergram hue so the close-approach halo warms with the
  // disc instead of laying a broadband-white floor under its palette.
  vec3 filterHue = vec3(1.0, 0.42, 0.10);
  glareColor = mix(glareColor, filterHue, uStudyFilter);
  veilColor = mix(veilColor, filterHue, uStudyFilter);
  vec3 coronaColor = vec3(0.90, 0.95, 1.0);
  vec3 chromosphereColor = vec3(1.0, 0.24, 0.10);
  vec3 rgb = (glareColor * glare + coronaColor * corona + chromosphereColor * chromosphere) * baseEdgeFade
    + veilColor * veil * edgeFade;
  float alpha = clamp(
    (glare + corona + chromosphere) * baseEdgeFade + veil * edgeFade, 0.0, 1.0
  );

  gl_FragColor = vec4(rgb, alpha);
  // No-ops under the composer; keep the additive glare inside the same
  // exposure/tonemap/colour response as the rest of the no-bloom frame.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Three small clip-space quads form a restrained lens-ghost train. Unlike the
 * Sun glare plane they sit on the optical axis between the source and screen
 * centre, so they move correctly as the camera pans without a full-screen pass.
 */
export const sunLensGhostVertexShader = /* glsl */ `
uniform vec2 uSunNdc;
uniform vec2 uViewportPx;
attribute float aGhostFactor;
attribute float aGhostSizePx;
attribute float aGhostTint;
varying vec2 vGhostUv;
varying float vGhostTint;

void main() {
  vGhostUv = position.xy * 0.5 + 0.5;
  vGhostTint = aGhostTint;
  vec2 centre = uSunNdc * aGhostFactor;
  vec2 halfSizeNdc = vec2(
    aGhostSizePx * 2.0 / max(uViewportPx.x, 1.0),
    aGhostSizePx * 2.0 / max(uViewportPx.y, 1.0)
  );
  gl_Position = vec4(centre + position.xy * halfSizeNdc, 0.0, 1.0);
}
`;

export const sunLensGhostFragmentShader = /* glsl */ `
uniform float uGhostStrength;
uniform float uExposureScale;
uniform float uEmergenceFlash;
uniform float uAtmosphereMix;
uniform vec3 uAtmosphereColor;
varying vec2 vGhostUv;
varying float vGhostTint;

void main() {
  vec2 p = (vGhostUv - 0.5) * 2.0;
  float r = length(p);
  if (r >= 1.0) discard;

  // Soft glass reflection plus a thin aperture rim. Three authored tint IDs
  // avoid the rainbow stack associated with arcade lens-flare textures.
  float body = exp(-r * r * 4.8) * 0.16;
  float rim = exp(-abs(r - 0.62) * 22.0) * 0.075;
  float aperture = 1.0 - smoothstep(0.78, 1.0, r);
  vec3 cool = vec3(0.32, 0.52, 0.62);
  vec3 warm = vec3(0.72, 0.43, 0.22);
  vec3 neutral = vec3(0.54, 0.48, 0.38);
  vec3 ghostColor = vGhostTint < 0.5
    ? cool
    : (vGhostTint < 1.5 ? warm : neutral);
  ghostColor = mix(ghostColor, uAtmosphereColor, uAtmosphereMix * 0.45);

  float flashBoost = 1.0 + uEmergenceFlash * 0.65;
  float energy = (body + rim) * aperture * uGhostStrength * uExposureScale * flashBoost;
  float alpha = clamp(energy, 0.0, 0.08);
  gl_FragColor = vec4(ghostColor * energy, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
