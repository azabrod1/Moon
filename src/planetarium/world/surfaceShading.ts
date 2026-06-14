/**
 * Per-body surface-shading augmentation for the Planetarium. Once the flat
 * scene ambient is gone, a body's night side would crush to pure black; this
 * adds a dim, cool, *directional* starlight floor in the body's own material —
 * keyed to where the Sun actually is for that body — so the dark hemisphere
 * keeps its shape without washing out daylight contrast. Further view-space
 * lighting terms layer onto this same onBeforeCompile hook — they share the
 * sun-direction varyings.
 *
 * Two cast-shadow terms also live here, both traced in the body's own frame
 * (so they read the raw `position` varying, unaffected by pole orientation):
 *   - Ring shadow (Saturn): trace toward the Sun to the ring plane; dim by the
 *     rings' opacity where it lands. Gated by `uRingOuter > 0`.
 *   - Moon-shadow transits: a moon between the Sun and a fragment casts an
 *     umbra/penumbra spot onto the globe (Io's shadow crawling across Jupiter).
 *
 * The injected GLSL is byte-identical for every body (only uniforms differ), so
 * materials still share compiled programs — no custom cache key needed.
 */
import * as THREE from 'three';

export type SurfaceArchetype = 'airless' | 'rocky' | 'gas' | 'icy' | 'earth';

/** Ring annulus that shadows this body's surface (object-space radii, AU). */
export interface RingShadowConfig {
  inner: number;
  outer: number;
}

/** Up to this many moons cast a shadow onto any one parent at once. */
export const MAX_MOON_SHADOWS = 4;

/** Per-frame-updated uniforms the mode feeds from each body's real position. */
export interface SurfaceShadingFx {
  uSunDirWorld: { value: THREE.Vector3 };       // world sun, for the night-fill terminator
  uSunDirLocal: { value: THREE.Vector3 };       // sun in the body's frame, for the cast-shadow traces
  uMoonShadow: { value: THREE.Vector4[] };      // [xyz = moon centre in body frame (AU), w = moon radius AU]
  uMoonShadowCount: { value: number };          // active entries in uMoonShadow
  uPlanetshineColor: { value: THREE.Color };    // parent's reflected-light tint (moons only)
  uPlanetshineDir: { value: THREE.Vector3 };    // world direction from the moon to its parent
  uPlanetshineIntensity: { value: number };     // night-side parent glow; 0 for planets / no parent
}

interface NightFill {
  color: number;      // cool starlight tint (linear-ish hex)
  strength: number;   // peak night-side fraction of albedo (kept small)
  termWidth: number;  // half-width of the day/night rolloff, in dot(n, sun)
}

// Wider terminators on bodies with air (light wraps); tight on airless worlds.
// Keyed to surface class, not atmosphere depth, so Venus and Titan (thick haze)
// sit tighter here than reality; the atmosphere phase models their wrap properly.
const NIGHT_FILL: Record<SurfaceArchetype, NightFill> = {
  airless: { color: 0x223044, strength: 0.05, termWidth: 0.10 },
  rocky:   { color: 0x243246, strength: 0.06, termWidth: 0.16 },
  gas:     { color: 0x2a3550, strength: 0.08, termWidth: 0.24 },
  icy:     { color: 0x28384f, strength: 0.07, termWidth: 0.12 },
  earth:   { color: 0x1c2c44, strength: 0.05, termWidth: 0.16 },
};

// Analytic stand-in for Saturn's ring opacity across the annulus (t: 0 inner …
// 1 outer), used only for the shadow it casts — the major features that read on
// the globe are the dense B ring, the clear Cassini Division, and the slightly
// thinner A ring. Matches the broad strokes of the texture in rings.ts.
const RING_SHADOW_OPACITY_GLSL = /* glsl */ `
float ringShadowOpacity(float t) {
  if (t < 0.0 || t > 1.0) return 0.0;
  float a = 0.9;
  a *= mix(0.4, 1.0, smoothstep(0.02, 0.18, t));         // C ring (faint inner)
  a *= mix(1.0, 0.8, smoothstep(0.58, 0.66, t));         // A ring a touch thinner than B
  a *= 1.0 - 0.92 * exp(-pow((t - 0.6) / 0.022, 2.0));   // Cassini Division
  a *= 1.0 - 0.6 * exp(-pow((t - 0.83) / 0.008, 2.0));   // Encke Gap
  a *= smoothstep(0.0, 0.04, t);                         // inner edge falloff
  a *= 1.0 - smoothstep(0.92, 1.0, t);                   // outer edge falloff
  return clamp(a, 0.0, 1.0);
}
`;

export function augmentSurfaceMaterial(
  mat: THREE.MeshStandardMaterial,
  archetype: SurfaceArchetype,
  ringShadow?: RingShadowConfig,
  sunTan = 0,
): SurfaceShadingFx {
  const night = NIGHT_FILL[archetype];

  // Created up front so the mode can update these refs even before the material
  // lazily compiles; onBeforeCompile assigns the same objects into the shader.
  const moonShadow: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_MOON_SHADOWS; i++) moonShadow.push(new THREE.Vector4());
  const fx: SurfaceShadingFx = {
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    uSunDirLocal: { value: new THREE.Vector3(1, 0, 0) },
    uMoonShadow: { value: moonShadow },
    uMoonShadowCount: { value: 0 },
    uPlanetshineColor: { value: new THREE.Color(0x6688aa) },
    uPlanetshineDir: { value: new THREE.Vector3(1, 0, 0) },
    uPlanetshineIntensity: { value: 0 },
  };
  const uNightColor = { value: new THREE.Color(night.color) };
  const uNightStrength = { value: night.strength };
  const uTermWidth = { value: night.termWidth };
  const uRingInner = { value: ringShadow ? ringShadow.inner : 0 };
  const uRingOuter = { value: ringShadow ? ringShadow.outer : 0 };
  const uSunTan = { value: sunTan };
  const uIcyRim = { value: archetype === 'icy' ? 1 : 0 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uSunDirLocal = fx.uSunDirLocal;
    shader.uniforms.uMoonShadow = fx.uMoonShadow;
    shader.uniforms.uMoonShadowCount = fx.uMoonShadowCount;
    shader.uniforms.uNightColor = uNightColor;
    shader.uniforms.uNightStrength = uNightStrength;
    shader.uniforms.uTermWidth = uTermWidth;
    shader.uniforms.uRingInner = uRingInner;
    shader.uniforms.uRingOuter = uRingOuter;
    shader.uniforms.uSunTan = uSunTan;
    shader.uniforms.uPlanetshineColor = fx.uPlanetshineColor;
    shader.uniforms.uPlanetshineDir = fx.uPlanetshineDir;
    shader.uniforms.uPlanetshineIntensity = fx.uPlanetshineIntensity;
    shader.uniforms.uIcyRim = uIcyRim;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSunDirWorld;\nuniform vec3 uPlanetshineDir;\n'
          + 'varying vec3 vSunViewDir;\nvarying vec3 vObjPos;\nvarying vec3 vPlanetshineViewDir;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
          + 'vSunViewDir = normalize((viewMatrix * vec4(uSunDirWorld, 0.0)).xyz);\n'
          + 'vPlanetshineViewDir = normalize((viewMatrix * vec4(uPlanetshineDir, 0.0)).xyz);\n'
          + 'vObjPos = position;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
          + 'uniform vec3 uNightColor;\n'
          + 'uniform float uNightStrength;\n'
          + 'uniform float uTermWidth;\n'
          + 'uniform vec3 uSunDirLocal;\n'
          + 'uniform float uRingInner;\n'
          + 'uniform float uRingOuter;\n'
          + 'uniform float uSunTan;\n'
          + `uniform vec4 uMoonShadow[${MAX_MOON_SHADOWS}];\n`
          + 'uniform int uMoonShadowCount;\n'
          + 'uniform vec3 uPlanetshineColor;\n'
          + 'uniform float uPlanetshineIntensity;\n'
          + 'uniform float uIcyRim;\n'
          + 'varying vec3 vSunViewDir;\n'
          + 'varying vec3 vObjPos;\n'
          + 'varying vec3 vPlanetshineViewDir;\n'
          + RING_SHADOW_OPACITY_GLSL,
      )
      // Inject after lighting but before <opaque_fragment> writes outgoingLight
      // into gl_FragColor — so terms land in linear radiance (tone-mapped
      // downstream) and read the perturbed view-space `normal`.
      .replace(
        '#include <opaque_fragment>',
        '{\n'
          + '  float dayFactor = smoothstep(-uTermWidth, uTermWidth, dot(normalize(normal), normalize(vSunViewDir)));\n'
          + '  outgoingLight += diffuseColor.rgb * uNightColor * (uNightStrength * (1.0 - dayFactor));\n'
          + '  // Planetshine: parent-lit glow on the night side. Albedo-multiplicative,\n'
          + '  // so the eclipse color-dim carries through it automatically.\n'
          + '  if (uPlanetshineIntensity > 0.0) {\n'
          + '    float pl = max(dot(normalize(normal), normalize(vPlanetshineViewDir)), 0.0);\n'
          + '    outgoingLight += diffuseColor.rgb * uPlanetshineColor * (uPlanetshineIntensity * pl * (1.0 - dayFactor));\n'
          + '  }\n'
          + '  // Icy moons: a cool Fresnel rim on the back-lit limb (ice scatters light).\n'
          + '  if (uIcyRim > 0.5) {\n'
          + '    float rim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);\n'
          + '    float back = max(-dot(normalize(normal), normalize(vSunViewDir)), 0.0);\n'
          + '    outgoingLight += vec3(0.55, 0.75, 1.0) * (rim * back * 0.4);\n'
          + '  }\n'
          + '  vec3 sd = normalize(uSunDirLocal);\n'
          + '  // Ring shadow on the globe: trace toward the Sun to the ring plane\n'
          + '  // (y = 0) and dim by the rings opacity where it lands.\n'
          + '  if (uRingOuter > 0.0 && abs(sd.y) > 1e-4) {\n'
          + '    float tHit = -vObjPos.y / sd.y;\n'
          + '    if (tHit > 0.0) {\n'
          + '      vec3 hit = vObjPos + sd * tHit;\n'
          + '      float t01 = (length(hit.xz) - uRingInner) / (uRingOuter - uRingInner);\n'
          + '      outgoingLight *= 1.0 - 0.9 * ringShadowOpacity(t01) * dayFactor;\n'
          + '    }\n'
          + '  }\n'
          + '  // Moon-shadow transits: a moon sunward of this fragment casts an\n'
          + '  // umbra/penumbra spot (cone narrows with distance behind the moon).\n'
          + '  for (int i = 0; i < ' + MAX_MOON_SHADOWS + '; i++) {\n'
          + '    if (i >= uMoonShadowCount) break;\n'
          + '    vec3 toMoon = uMoonShadow[i].xyz - vObjPos;\n'
          + '    float along = dot(toMoon, sd);\n'
          + '    if (along > 0.0) {\n'
          + '      float perp = length(toMoon - sd * along);\n'
          + '      float mr = uMoonShadow[i].w;\n'
          + '      float occ = 1.0 - smoothstep(max(mr - along * uSunTan, 0.0), mr + along * uSunTan, perp);\n'
          + '      outgoingLight *= 1.0 - occ * dayFactor;\n'
          + '    }\n'
          + '  }\n'
          + '}\n'
          + '#include <opaque_fragment>',
      );
  };
  mat.needsUpdate = true;
  return fx;
}
