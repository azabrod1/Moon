/**
 * Per-body surface-shading augmentation for the Planetarium. Once the flat
 * scene ambient is gone, a body's night side would crush to pure black; this
 * adds a dim, cool, *directional* starlight floor in the body's own material —
 * keyed to where the Sun actually is for that body — so the dark hemisphere
 * keeps its shape without washing out daylight contrast. Further view-space
 * lighting terms layer onto this same onBeforeCompile hook — they share the
 * sun-direction varying.
 *
 * Saturn additionally casts its ring shadow onto the globe: each fragment traces
 * toward the Sun (in the body's local frame) to the ring plane and, if it lands
 * within the ring annulus, dims by the rings' opacity there. The trace is gated
 * by `uRingOuter > 0`, so the injected GLSL is byte-identical for every body
 * (only uniforms differ) and materials still share compiled programs — no custom
 * cache key needed.
 */
import * as THREE from 'three';

export type SurfaceArchetype = 'airless' | 'rocky' | 'gas' | 'icy' | 'earth';

/** Ring annulus that shadows this body's surface (object-space radii, AU). */
export interface RingShadowConfig {
  inner: number;
  outer: number;
}

/** Per-frame-updated uniforms the mode feeds from each body's real position. */
export interface SurfaceShadingFx {
  uSunDirWorld: { value: THREE.Vector3 };   // world-space sun, for the night-fill terminator
  uSunDirLocal: { value: THREE.Vector3 };   // sun in the body's own frame, for the ring-shadow trace
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
): SurfaceShadingFx {
  const night = NIGHT_FILL[archetype];

  // Created up front so the mode can update these refs even before the material
  // lazily compiles; onBeforeCompile assigns the same objects into the shader.
  const fx: SurfaceShadingFx = {
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    uSunDirLocal: { value: new THREE.Vector3(1, 0, 0) },
  };
  const uNightColor = { value: new THREE.Color(night.color) };
  const uNightStrength = { value: night.strength };
  const uTermWidth = { value: night.termWidth };
  const uRingInner = { value: ringShadow ? ringShadow.inner : 0 };
  const uRingOuter = { value: ringShadow ? ringShadow.outer : 0 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uSunDirLocal = fx.uSunDirLocal;
    shader.uniforms.uNightColor = uNightColor;
    shader.uniforms.uNightStrength = uNightStrength;
    shader.uniforms.uTermWidth = uTermWidth;
    shader.uniforms.uRingInner = uRingInner;
    shader.uniforms.uRingOuter = uRingOuter;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSunDirWorld;\nvarying vec3 vSunViewDir;\nvarying vec3 vObjPos;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
          + 'vSunViewDir = normalize((viewMatrix * vec4(uSunDirWorld, 0.0)).xyz);\n'
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
          + 'varying vec3 vSunViewDir;\n'
          + 'varying vec3 vObjPos;\n'
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
          + '  // Ring shadow on the globe: trace toward the Sun (local frame) to\n'
          + '  // the ring plane (y = 0) and dim by the rings opacity where it lands.\n'
          + '  if (uRingOuter > 0.0) {\n'
          + '    vec3 sd = normalize(uSunDirLocal);\n'
          + '    if (abs(sd.y) > 1e-4) {\n'
          + '      float tHit = -vObjPos.y / sd.y;\n'
          + '      if (tHit > 0.0) {\n'
          + '        vec3 hit = vObjPos + sd * tHit;\n'
          + '        float t01 = (length(hit.xz) - uRingInner) / (uRingOuter - uRingInner);\n'
          + '        outgoingLight *= 1.0 - 0.9 * ringShadowOpacity(t01) * dayFactor;\n'
          + '      }\n'
          + '    }\n'
          + '  }\n'
          + '}\n'
          + '#include <opaque_fragment>',
      );
  };
  mat.needsUpdate = true;
  return fx;
}
