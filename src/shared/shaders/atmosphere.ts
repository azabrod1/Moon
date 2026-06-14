// Atmosphere shell: a single-scatter approximation on a back-side sphere. The
// world-space normal plus a fed sun direction give a day-side Rayleigh limb that
// warms toward the terminator, and a Henyey-Greenstein Mie peak that lights a
// back-lit crescent. Output is additive linear HDR radiance so the composer's
// tonemap + bloom carry the bright forward-scatter rim.
export const atmosphereVertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vCenter;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;  // planet center in scene space
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const atmosphereFragmentShader = /* glsl */ `
#define PI 3.141592653589793

uniform vec3 uSunDirWorld;     // direction to the sun (scene space)
uniform vec3 uDayColor;        // Rayleigh tint in full sun
uniform vec3 uSunsetColor;     // warmed tint toward the terminator / crescent
uniform vec3 uMieColor;        // forward-scatter halo (near white)
uniform float uRayleighStrength;
uniform float uMieStrength;
uniform float uMieG;           // Henyey-Greenstein asymmetry (forward)
uniform float uPower;          // radial falloff shaping
uniform float uIntensity;
uniform float uHaloStrength;    // glow spilling past the limb into space: ~1 for a thin
                                // atmosphere over a surface, low for all-atmosphere giants
uniform float uPlanetRadius;   // solid surface radius (shell inner bound)
uniform float alphaScale;      // distance fade, fed per frame (0 far .. 1 near)

varying vec3 vWorldPos;
varying vec3 vCenter;

void main() {
  float outerR = length(vWorldPos - vCenter);          // shell radius
  vec3 D = normalize(vWorldPos - cameraPosition);      // view ray, camera -> fragment
  vec3 oc = cameraPosition - vCenter;
  vec3 closest = cameraPosition + D * (-dot(oc, D));   // ray point nearest the center
  float b = length(closest - vCenter);                 // impact parameter (lowest radius the ray reaches)

  // Glow profile across the limb, keyed to the ray's closest approach b. A raw
  // chord length would be physically tidy but its sqrt tangents at the surface
  // limb and the shell silhouette read as a hard wire under additive blending +
  // bloom (worst on the cool, dark-disced ice giants, where it can't hide in the
  // disc). A gaussian centred on the surface limb gives the same bright-limb look
  // with no corners: it eases into the lit disc and tapers to zero before the
  // silhouette, so the halo dissolves into space with no edge.
  float shell = max(outerR - uPlanetRadius, 1e-9);
  float u = (b - uPlanetRadius) / shell;   // 0 at the surface limb, 1 at the silhouette, <0 over the disc
  float depth = exp(-2.5 * u * u);
  depth *= 1.0 - smoothstep(0.4, 0.9, u);  // taper to nothing before the silhouette
  depth *= smoothstep(-1.6, -0.3, u);      // ease in over the lit disc, clear at disc centre
  // Scale the part beyond the limb (over black space) per body. A thin
  // atmosphere over a surface keeps its bright arc + forward-scatter halo;
  // an all-atmosphere giant suppresses it so the limb can't ring against black.
  float overSpace = smoothstep(0.0, 0.2, u); // 0 on the lit disc, 1 just past the limb
  depth *= mix(1.0, uHaloStrength, overSpace);
  depth = pow(depth, uPower);

  // Day/night + tint evaluated where the ray dips closest to the surface.
  // Guard the central ray (b -> 0): normalize(0) is undefined, so fall back to
  // the fragment's own radial direction there.
  vec3 nClosest = b > 1e-9 ? normalize(closest - vCenter) : normalize(vWorldPos - vCenter);
  vec3 L = normalize(uSunDirWorld);
  float day = smoothstep(-0.25, 0.25, dot(nClosest, L));

  // Blue in full phase, warming toward orange as the view turns back-lit.
  vec3 V = -D;
  float phase = dot(V, L);                             // +1 sun behind viewer, -1 crescent
  float redden = 1.0 - smoothstep(-0.6, 0.4, phase);   // ordered edges (reversed smoothstep is undefined)
  vec3 rayleighColor = mix(uDayColor, uSunsetColor, redden);
  float rayleigh = depth * day * uRayleighStrength;

  // Mie forward-scatter: the bright rim that lights a back-lit crescent.
  float mu = clamp(-phase, -1.0, 1.0);
  float g = uMieG;
  float denom = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(denom, 1.5));
  float mie = depth * day * hg * uMieStrength;

  vec3 radiance = (rayleighColor * rayleigh + uMieColor * mie) * uIntensity * alphaScale;
  gl_FragColor = vec4(radiance, 1.0);
}
`;

export const earthNightVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSunDir;
uniform vec3 sunDirection;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  // Transform sun direction to view space
  vSunDir = normalize((viewMatrix * vec4(sunDirection, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const earthNightFragmentShader = /* glsl */ `
uniform sampler2D nightTexture;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSunDir;

void main() {
  vec4 nightColor = texture2D(nightTexture, vUv);
  // Show night lights only on dark side
  float sunDot = dot(vNormal, vSunDir);
  float nightMix = smoothstep(-0.1, -0.3, sunDot);
  gl_FragColor = vec4(nightColor.rgb * nightMix * 1.5, nightMix * nightColor.a);
}
`;
