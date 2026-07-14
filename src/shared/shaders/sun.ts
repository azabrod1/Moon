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

vec3 hash33(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453);
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
        // Each convection centre breathes around its own anchor. The topology
        // evolves without a texture sheet visibly translating over the sphere.
        seed += sin(seed * 6.28318 + t * vec3(0.17, 0.13, 0.19)) * 0.065;
        vec3 delta = neighbour + seed - local;
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
  float limbWarmth = pow(1.0 - mu, 5.0) * 0.34;
  vec3 color = mix(laneColor, whiteHot, smoothstep(0.12, 0.82, lanes));
  color = mix(color, warmLimb, limbWarmth);

  float limbDarkening = 0.48 + 0.52 * pow(mu, 0.58);
  float radiance = 3.8 * limbDarkening * detail;
  radiance *= 1.0 - spotPenumbra * 0.42 - spotCore * 0.38;
  radiance *= 1.0 + faculae;

  gl_FragColor = vec4(color * radiance, 1.0);
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
  if (planeRadius >= 1.0) discard;

  float solarRadii = planeRadius * uExtent;
  float outside = max(solarRadii - 1.0, 0.0);
  float edgeFade = 1.0 - smoothstep(0.72, 0.94, planeRadius);

  // Optical point-spread profile: a tight hot core, medium aureole, and a
  // faint long tail. This keeps the glare white near the source and avoids the
  // giant orange Gaussian blob produced by the old canvas gradients.
  float core = exp(-outside * 2.40);
  float aureole = 0.012 / (1.0 + outside * outside * 1.30);
  float tail = 0.001 / pow(max(solarRadii, 1.0), 1.55);
  float visibleEnergy = pow(clamp(uVisibleFraction, 0.0, 1.0), 0.38);
  float glare = (core * 0.24 + aureole + tail) * visibleEnergy * uGlareStrength;

  // Once the solar disc becomes only a few pixels wide, a restrained optical
  // starburst keeps it distinct from the starfield. Derivative-scaled widths
  // stay stable from high-DPI desktop captures down to the mobile fallback.
  float widthX = max(fwidth(p.y) * 1.35, 0.010);
  float widthY = max(fwidth(p.x) * 1.35, 0.010);
  float horizontal = exp(-abs(p.y) / widthX) * exp(-abs(p.x) * 2.25);
  float vertical = exp(-abs(p.x) / widthY) * exp(-abs(p.y) * 2.75) * 0.52;
  float diagonalWidthA = max(fwidth(p.x - p.y) * 1.25, 0.014);
  float diagonalWidthB = max(fwidth(p.x + p.y) * 1.25, 0.014);
  float diagonal = (
    exp(-abs(p.x - p.y) / diagonalWidthA)
    + exp(-abs(p.x + p.y) / diagonalWidthB)
  ) * exp(-planeRadius * 3.4) * 0.13;
  float starburst = (horizontal + vertical + diagonal) * uPointLike * visibleEnergy * 0.20;
  glare += starburst;

  // A short, low-energy sensor streak bridges the scale range where the disc
  // is resolved but still overwhelmingly bright. It fades away for close-up
  // photosphere study and yields to the sharper starburst in the outer system.
  float sensorLine = exp(-abs(p.y) / max(fwidth(p.y) * 1.15, 0.007))
    * exp(-abs(p.x) * 1.55);
  float sensorStreak = sensorLine * uCameraFx * (1.0 - uPointLike * 0.72)
    * visibleEnergy * 0.055;
  glare += sensorStreak;

  // Once the photosphere is covered, remove its glare and reveal a restrained
  // white corona. Broad bipolar lobes plus fine angular strands keep totality
  // from reading as another perfectly circular radial gradient.
  float coverage = 1.0 - clamp(uVisibleFraction, 0.0, 1.0);
  float eclipse = smoothstep(0.97, 0.995, coverage);
  float angle = atan(p.y, p.x);
  float cloudWarp = fbm2(p * 2.7 + normalize(p + vec2(1e-4)) * solarRadii * 0.13);
  float angleWarp = angle
    + sin(angle * 3.0 + solarRadii * 0.18) * 0.025
    + (cloudWarp - 0.5) * 0.07;
  float broadStreamers = pow(abs(cos(angleWarp - 0.18)), 3.8);
  float polarPlumes = pow(abs(sin(angleWarp + 0.08)), 7.0) * 0.32;
  float fineStreamers = pow(0.5 + 0.5 * cos(angleWarp * 17.0 + cloudWarp * 0.6), 20.0);
  float coronaTexture = mix(0.72, 1.16, cloudWarp);
  float innerCorona = exp(-outside * 1.75) * 0.09;
  float coronaShape = (
    0.025 + broadStreamers * 1.28 + polarPlumes + fineStreamers * 0.14
  ) * coronaTexture;
  float coronaFalloff = exp(-outside * 0.44) / pow(max(solarRadii, 1.0), 0.58);
  float corona = eclipse * (innerCorona + coronaShape * coronaFalloff * 0.62);

  // The chromosphere is normally drowned by the photosphere. During totality
  // it survives as a hairline warm rim beneath the much cooler white corona.
  float chromosphereNoise = 0.72 + 0.28 * sin(angle * 19.0 + cloudWarp * 5.0);
  float chromosphere = eclipse * exp(-outside * 13.0) * chromosphereNoise * 0.12;

  float warmth = smoothstep(1.15, 5.5, solarRadii) * 0.28;
  vec3 glareColor = mix(vec3(1.0, 0.985, 0.94), vec3(1.0, 0.67, 0.30), warmth);
  vec3 coronaColor = vec3(0.90, 0.95, 1.0);
  vec3 chromosphereColor = vec3(1.0, 0.24, 0.10);
  vec3 rgb = (
    glareColor * glare + coronaColor * corona + chromosphereColor * chromosphere
  ) * edgeFade;
  float alpha = clamp(glare + corona + chromosphere, 0.0, 1.0) * edgeFade;

  gl_FragColor = vec4(rgb, alpha);
}
`;
