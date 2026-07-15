/**
 * Planetarium Sun shaders.
 *
 * The photosphere deliberately lives in HDR linear light. Tone mapping and
 * eye adaptation decide how much detail survives; the source itself is never
 * authored as a flat display-white disc. Object-space noise keeps the sphere
 * seamless at the longitude wrap and poles.
 */
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

void main() {
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

  // One sparse bipolar active-region pair establishes the Sun's enormous
  // scale. Antipodal placement guarantees a restrained group on whichever
  // hemisphere a traveller approaches, without tiling spots over the star.
  vec3 spotAxis = normalize(vec3(0.38, -0.37, 0.85));
  float spotPenumbra = max(
    spotDisc(p, spotAxis, 0.020, 0.070),
    spotDisc(p, -spotAxis, 0.020, 0.070)
  );
  vec3 spotCoreAxis = normalize(spotAxis + vec3(0.012, -0.010, 0.014));
  float spotCore = max(
    spotDisc(p, spotCoreAxis, 0.008, 0.034),
    spotDisc(p, -spotCoreAxis, 0.008, 0.034)
  );
  float faculae = spotPenumbra * pow(1.0 - mu, 1.8) * 0.24;

  // Broadband sunlight from space is white. Warmth is restricted to the last
  // sliver of the limb/chromosphere rather than baked through the whole disc.
  vec3 whiteHot = vec3(1.0, 0.985, 0.94);
  vec3 laneColor = vec3(1.0, 0.62, 0.20);
  vec3 warmLimb = vec3(1.0, 0.73, 0.36);
  float limbWarmth = pow(1.0 - mu, 3.5) * 0.5;
  vec3 color = mix(laneColor, whiteHot, smoothstep(0.12, 0.82, lanes));
  color = mix(color, warmLimb, limbWarmth);

  float limbDarkening = 0.40 + 0.60 * pow(mu, 0.62);
  float radiance = 3.8 * limbDarkening * detail;
  radiance *= 1.0 - spotPenumbra * 0.42 - spotCore * 0.38;
  radiance *= 1.0 + faculae;

  // When the camera→Sun sightline skims a planet's atmosphere, extinguish the
  // white source and pull it toward that atmosphere's sunset colour. This is
  // driven by geometry in the controller, not by camera position alone.
  color = mix(color, uAtmosphereColor, uAtmosphereMix * 0.82);
  radiance *= mix(1.0, 0.62, uAtmosphereMix);

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

/** Thin, broken chromosphere shell for close-approach limb detail. */
export const sunProminenceVertexShader = /* glsl */ `
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

export const sunProminenceFragmentShader = /* glsl */ `
uniform float time;
uniform float uCloseVisibility;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vObjectDirection;

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

void main() {
  vec3 viewDir = normalize(-vPosition);
  float mu = abs(dot(viewDir, normalize(vNormal)));
  float limb = pow(1.0 - clamp(mu, 0.0, 1.0), 4.5);
  vec3 p = normalize(vObjectDirection);
  float broad = prominenceNoise(p * 5.2 + vec3(time * 0.018, 0.0, -time * 0.011));
  float fine = prominenceNoise(p * 17.0 + broad * 1.8);
  float activeArc = smoothstep(0.60, 0.82, broad) * smoothstep(0.42, 0.78, fine);
  float spicules = smoothstep(0.52, 0.88, prominenceNoise(p * 43.0 - time * 0.015));
  float structure = activeArc * 0.82 + spicules * 0.18;
  float alpha = limb * structure * uCloseVisibility * 0.72;
  if (alpha < 0.004) discard;

  vec3 hotPink = vec3(3.2, 0.18, 0.045);
  vec3 orange = vec3(2.6, 0.58, 0.08);
  vec3 color = mix(hotPink, orange, fine * 0.45);
  gl_FragColor = vec4(color * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Camera-facing glare plane. Its radius is `uExtent` photosphere radii. */
export const sunGlareVertexShader = /* glsl */ `
uniform float uMinHalfSizePx;
uniform float uViewportHeight;
varying vec2 vUv;

void main() {
  vUv = uv;
  // Expand the plane in camera-view XY around the transformed Sun centre. It
  // remains a circular billboard without a per-frame CPU quaternion update.
  // A minimum screen-space footprint preserves an optical glint in the outer
  // system after the physical photosphere becomes sub-pixel.
  vec4 centreView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float halfSize = max(abs(position.x), abs(position.y));
  float physicalHalfNdc = projectionMatrix[1][1] * halfSize / max(-centreView.z, 1e-6);
  float minimumHalfNdc = (uMinHalfSizePx * 2.0) / max(uViewportHeight, 1.0);
  float sizeBoost = max(1.0, minimumHalfNdc / max(physicalHalfNdc, 1e-7));
  centreView.xy += position.xy * sizeBoost;
  gl_Position = projectionMatrix * centreView;
}
`;

export const sunGlareFragmentShader = /* glsl */ `
uniform float uExtent;
uniform float uVisibleFraction;
uniform float uGlareStrength;
uniform float uPointLike;
uniform float uCameraFx;
uniform float uEclipseLike;
uniform float uOccluderRadii;
uniform float uExposureScale;
uniform float uEmergenceFlash;
uniform float uAtmosphereMix;
uniform vec3 uAtmosphereColor;
varying vec2 vUv;

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
  // All derivatives are taken before the discard: fwidth after a neighbouring
  // lane discards is formally undefined.
  float widthX = max(fwidth(p.y) * 1.35, 0.010);
  float widthY = max(fwidth(p.x) * 1.35, 0.010);
  float diagonalWidthA = max(fwidth(p.x - p.y) * 1.25, 0.014);
  float diagonalWidthB = max(fwidth(p.x + p.y) * 1.25, 0.014);
  float sensorWidth = max(fwidth(p.y) * 1.15, 0.007);
  if (planeRadius >= 1.0) discard;

  float solarRadii = planeRadius * uExtent;
  float outside = max(solarRadii - 1.0, 0.0);
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
  float horizontal = exp(-abs(p.y) / widthX) * exp(-abs(p.x) * 1.70);
  float vertical = exp(-abs(p.x) / widthY) * exp(-abs(p.y) * 2.75) * 0.52;
  float diagonal = (
    exp(-abs(p.x - p.y) / diagonalWidthA)
    + exp(-abs(p.x + p.y) / diagonalWidthB)
  ) * exp(-planeRadius * 3.4) * 0.10;
  float starburst = (horizontal + vertical + diagonal) * uPointLike * visibleEnergy * 0.30;
  glare += starburst;

  // A short, low-energy sensor streak bridges the scale range where the disc
  // is resolved but still overwhelmingly bright. It fades away for close-up
  // photosphere study and yields to the sharper starburst in the outer system.
  float sensorLine = exp(-abs(p.y) / sensorWidth)
    * exp(-abs(p.x) * 1.55);
  float sensorStreak = sensorLine * uCameraFx * (1.0 - uPointLike * 0.72)
    * visibleEnergy * 0.055;
  glare += sensorStreak;

  // Limb crossings and third contact briefly overwhelm the virtual optics
  // before exposure adaptation catches up. The controller supplies a
  // derivative-triggered impulse with a short exponential decay.
  float emergenceBloom = exp(-outside * 1.25) * uEmergenceFlash * visibleEnergy * 1.15;
  glare = (glare + emergenceBloom) * mix(1.0, 0.60, uAtmosphereMix);

  // Once the photosphere is covered, remove its glare and reveal a restrained
  // white corona. Broad bipolar lobes plus fine angular strands keep totality
  // from reading as another perfectly circular radial gradient. uEclipseLike
  // (CPU-computed Sun/occluder angular-size ratio) keeps the corona to true
  // eclipse geometry: a whole planet blotting out the sky reveals nothing.
  // The block stays behind a real branch: its atan/normalize are undefined at
  // the quad centre, and even multiplied by zero a NaN would poison the pixel.
  float coverage = 1.0 - clamp(uVisibleFraction, 0.0, 1.0);
  float eclipse = smoothstep(0.97, 0.995, coverage) * clamp(uEclipseLike, 0.0, 1.0);
  float corona = 0.0;
  float chromosphere = 0.0;
  if (eclipse > 0.0 && planeRadius > 1e-4) {
    float angle = atan(p.y, p.x);
    float cloudWarp = fbm2(p * 2.7 + (p / planeRadius) * solarRadii * 0.13);
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
  vec3 coronaColor = vec3(0.90, 0.95, 1.0);
  vec3 chromosphereColor = vec3(1.0, 0.24, 0.10);
  vec3 rgb = (
    glareColor * glare + coronaColor * corona + chromosphereColor * chromosphere
  ) * edgeFade;
  float alpha = clamp(glare + corona + chromosphere, 0.0, 1.0) * edgeFade;

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
