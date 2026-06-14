/**
 * Per-body surface-shading augmentation for the Planetarium. Once the flat
 * scene ambient is gone, a body's night side would crush to pure black; this
 * adds a dim, cool, *directional* starlight floor in the body's own material —
 * keyed to where the Sun actually is for that body — so the dark hemisphere
 * keeps its shape without washing out daylight contrast. Further view-space
 * lighting terms can layer onto this same onBeforeCompile hook — they share the
 * sun-direction varying.
 *
 * The injected GLSL is identical for every body (only uniforms differ), so
 * materials still share compiled programs by their own map state — no custom
 * cache key needed.
 */
import * as THREE from 'three';

export type SurfaceArchetype = 'airless' | 'rocky' | 'gas' | 'icy' | 'earth';

/** Per-frame-updated uniforms the mode feeds from each body's real position. */
export interface SurfaceShadingFx {
  uSunDirWorld: { value: THREE.Vector3 };
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

export function augmentSurfaceMaterial(
  mat: THREE.MeshStandardMaterial,
  archetype: SurfaceArchetype,
): SurfaceShadingFx {
  const night = NIGHT_FILL[archetype];

  // Created up front so the mode can update these refs even before the material
  // lazily compiles; onBeforeCompile assigns the same objects into the shader.
  const fx: SurfaceShadingFx = {
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
  };
  const uNightColor = { value: new THREE.Color(night.color) };
  const uNightStrength = { value: night.strength };
  const uTermWidth = { value: night.termWidth };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uNightColor = uNightColor;
    shader.uniforms.uNightStrength = uNightStrength;
    shader.uniforms.uTermWidth = uTermWidth;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSunDirWorld;\nvarying vec3 vSunViewDir;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSunViewDir = normalize((viewMatrix * vec4(uSunDirWorld, 0.0)).xyz);',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
          + 'uniform vec3 uNightColor;\n'
          + 'uniform float uNightStrength;\n'
          + 'uniform float uTermWidth;\n'
          + 'varying vec3 vSunViewDir;',
      )
      // Inject after lighting but before <opaque_fragment> writes outgoingLight
      // into gl_FragColor — so the floor lands in linear radiance (tone-mapped
      // downstream) and reads the perturbed view-space `normal`.
      .replace(
        '#include <opaque_fragment>',
        '{\n'
          + '  float dayFactor = smoothstep(-uTermWidth, uTermWidth, dot(normalize(normal), normalize(vSunViewDir)));\n'
          + '  outgoingLight += diffuseColor.rgb * uNightColor * (uNightStrength * (1.0 - dayFactor));\n'
          + '}\n'
          + '#include <opaque_fragment>',
      );
  };
  mat.needsUpdate = true;
  return fx;
}
