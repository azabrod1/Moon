/**
 * Procedural ring systems. A flat disc with a 1024×1 radial gradient texture
 * (u = 0 inner edge … u = 1 outer edge) laid in the planet's equatorial plane,
 * so it inherits the planet group's pole orientation (Uranus's rings stand
 * near-vertical from its 98° tilt for free).
 *
 * Saturn is the showpiece. The others are faint and dark in reality — Uranus's
 * narrow charcoal ringlets, Jupiter's single dust ring, Neptune's tenuous
 * sheet — present for realism, not spectacle.
 */
import * as THREE from 'three';
import { applyTextureDefaults } from '../world/texturePolicy';

export type RingStyle = 'saturn' | 'uranus' | 'jupiter' | 'neptune';

export interface RingConfig {
  innerFactor: number; // inner radius ÷ planet radius
  outerFactor: number; // outer radius ÷ planet radius
  style: RingStyle;
}

export const RING_CONFIGS: Record<string, RingConfig> = {
  Saturn: { innerFactor: 1.24, outerFactor: 2.27, style: 'saturn' },
  Uranus: { innerFactor: 1.64, outerFactor: 2.01, style: 'uranus' },
  Jupiter: { innerFactor: 1.4, outerFactor: 1.81, style: 'jupiter' },
  Neptune: { innerFactor: 1.7, outerFactor: 2.54, style: 'neptune' },
};

const STRIP_WIDTH = 1024;

// Deterministic hash so the ring texture is identical every run.
function seededRand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Brightest contribution of a set of narrow bands at the given position.
function bandPeak(t: number, bands: Array<[number, number, number]>): number {
  let a = 0;
  for (const [center, halfWidth, strength] of bands) {
    const d = Math.abs(t - center);
    if (d < halfWidth) a = Math.max(a, (1 - d / halfWidth) * strength);
  }
  return a;
}

// Paint one texel of the radial strip (x: 0…STRIP_WIDTH). Returns [r,g,b,a],
// each 0–255. t runs 0 at the inner edge to 1 at the outer edge.
function paintRing(x: number, style: RingStyle): [number, number, number, number] {
  const t = x / STRIP_WIDTH;

  if (style === 'saturn') {
    // Band layout (C/B/Cassini/A/Encke) is mirrored by ringShadowOpacity() in
    // world/surfaceShading.ts for the cast shadow — keep the two in step.
    let alpha = 0.75;
    if (t < 0.18) alpha *= 0.3 + (t / 0.18) * 0.4; // C ring (inner, faint)
    if (t > 0.57 && t < 0.63) alpha = 0.04; // Cassini Division
    if (t > 0.82 && t < 0.84) alpha = 0.08; // Encke Gap
    if (t < 0.05) alpha *= t / 0.05; // inner edge falloff
    if (t > 0.92) alpha *= (1 - t) / 0.08; // outer edge falloff

    const brightness = 200 + seededRand(x * 7.3) * 30; // warm ivory/tan
    let r = brightness;
    let g = brightness * 0.92;
    let b = brightness * 0.78;
    if (t < 0.57) {
      r *= 1.05; // B ring (brightest, inner half)
      g *= 1.0;
    } else if (t > 0.63) {
      r *= 0.88; // A ring (slightly dimmer, outer)
      g *= 0.85;
      b *= 0.82;
      alpha *= 0.75;
    }
    if (seededRand(x * 13.7) < 0.04) alpha *= 0.15; // fine structure
    return [r, g, b, alpha * 255];
  }

  if (style === 'uranus') {
    // A handful of narrow charcoal ringlets; the ε ring (outermost) is the
    // widest and brightest. Nearly black between them.
    const alpha = bandPeak(t, [
      [0.18, 0.012, 0.4],
      [0.34, 0.01, 0.35],
      [0.5, 0.012, 0.4],
      [0.66, 0.014, 0.45],
      [0.81, 0.016, 0.5],
      [0.96, 0.035, 0.8], // ε ring
    ]);
    const v = 64 + seededRand(x * 5.1) * 26; // dark neutral grey
    return [v, v, v * 1.03, alpha * 255];
  }

  if (style === 'jupiter') {
    // One faint reddish dust ring, brightest at the outer (main) edge with a
    // tenuous halo falling away inward.
    let a = 0.015 + t * 0.03;
    if (t > 0.72) a += ((t - 0.72) / 0.28) * 0.06; // main ring
    if (t < 0.1) a *= t / 0.1;
    if (t > 0.97) a *= (1 - t) / 0.03;
    const v = 120 + seededRand(x * 3.3) * 24; // reddish-brown dust
    return [v, v * 0.74, v * 0.5, a * 255];
  }

  // neptune — tenuous dark sheet with two faint ringlets (Le Verrier, Adams).
  let a = 0.018 + bandPeak(t, [
    [0.42, 0.02, 0.22],
    [0.95, 0.035, 0.4], // Adams ring (outer)
  ]);
  if (t < 0.08) a *= t / 0.08;
  if (t > 0.97) a *= (1 - t) / 0.03;
  const v = 58 + seededRand(x * 4.7) * 20; // dark blue-grey
  return [v * 0.82, v * 0.86, v, a * 255];
}

/** Per-frame uniforms the mode feeds so shadow + translucency track the Sun. */
export interface RingShadingFx {
  uSunDirLocal: { value: THREE.Vector3 };  // sun in the planet's frame, for the cast shadow
  uSunDirWorld: { value: THREE.Vector3 };  // world sun, for the backlit transmission glow
}

// Two analytic terms on the ring material, both in the planet group's local
// frame (the ring rotation is baked into the geometry, so `position` is
// group-local with y ~ 0):
//   1. Planet shadow — darken ring fragments inside the planet's anti-sunward
//      shadow cone (penumbra width from the Sun's angular radius, sunTan).
//   2. Backlit translucency — when the Sun is on the far face from the camera,
//      thin rings transmit a forward-scatter glow while dense rings stay dark.
function augmentRingMaterial(
  mat: THREE.MeshStandardMaterial,
  planetRadiusAU: number,
  sunTan: number,
): RingShadingFx {
  const fx: RingShadingFx = {
    uSunDirLocal: { value: new THREE.Vector3(1, 0, 0) },
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
  };
  const uPlanetRadius = { value: planetRadiusAU };
  const uSunTan = { value: sunTan };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirLocal = fx.uSunDirLocal;
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uPlanetRadius = uPlanetRadius;
    shader.uniforms.uSunTan = uSunTan;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSunDirWorld;\nvarying vec3 vRingLocal;\nvarying vec3 vSunView;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n'
          + 'vRingLocal = position;\n'
          + 'vSunView = normalize((viewMatrix * vec4(uSunDirWorld, 0.0)).xyz);',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
          + 'uniform vec3 uSunDirLocal;\n'
          + 'uniform float uPlanetRadius;\n'
          + 'uniform float uSunTan;\n'
          + 'varying vec3 vRingLocal;\n'
          + 'varying vec3 vSunView;',
      )
      .replace(
        '#include <opaque_fragment>',
        '{\n'
          + '  vec3 sd = normalize(uSunDirLocal);\n'
          + '  float axial = dot(vRingLocal, -sd);\n'          // distance anti-sunward of the planet
          + '  float shadow = 0.0;\n'
          + '  if (axial > 0.0) {\n'
          + '    float perp = length(vRingLocal + sd * axial);\n'  // distance from the shadow axis
          + '    float umbra = uPlanetRadius - axial * uSunTan;\n'
          + '    float penumbra = uPlanetRadius + axial * uSunTan;\n'
          + '    shadow = 1.0 - smoothstep(umbra, penumbra, perp);\n'
          + '    outgoingLight *= 1.0 - 0.92 * shadow;\n'
          + '  }\n'
          + '  // Backlit: Sun on the far face (DoubleSide flips normal to camera,\n'
          + '  // so dot(normal, sunView) < 0 means back-lit). Thin rings glow — but\n'
          + '  // not where the planet shadow already blocks the sunlight.\n'
          + '  float ndl = dot(normalize(normal), normalize(vSunView));\n'
          + '  if (ndl < 0.0) {\n'
          + '    float transmit = exp(-(diffuseColor.a * 2.5) / max(-ndl, 0.15));\n'
          + '    outgoingLight += diffuseColor.rgb * transmit * (0.5 * (1.0 - 0.92 * shadow));\n'
          + '  }\n'
          + '}\n'
          + '#include <opaque_fragment>',
      );
  };
  mat.needsUpdate = true;
  return fx;
}

export function createPlanetRings(planetRadiusAU: number, cfg: RingConfig, sunTan: number): THREE.Mesh {
  const innerRadius = planetRadiusAU * cfg.innerFactor;
  const outerRadius = planetRadiusAU * cfg.outerFactor;

  const segments = 128;
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, segments, 3);

  // RingGeometry's default UVs are cartesian (bad for a radial texture). Remap
  // so u = 0 at the inner edge, u = 1 at the outer edge.
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i); // RingGeometry is in the XY plane before we rotate
    const r = Math.sqrt(x * x + z * z);
    const tt = (r - innerRadius) / (outerRadius - innerRadius);
    uv.setXY(i, tt, uv.getY(i));
  }

  // Bake the equatorial tilt into the geometry so a ring fragment's object
  // position is already group-local (XZ plane, y ~ 0) — the planet-shadow test
  // in augmentRingMaterial reads `position` directly, no mesh rotation to undo.
  geo.rotateX(-Math.PI / 2);

  const canvas = document.createElement('canvas');
  canvas.width = STRIP_WIDTH;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(STRIP_WIDTH, 1);
  const data = imgData.data;
  for (let x = 0; x < STRIP_WIDTH; x++) {
    const [r, g, b, a] = paintRing(x, cfg.style);
    const idx = x * 4;
    data[idx] = Math.floor(Math.min(255, r));
    data[idx + 1] = Math.floor(Math.min(255, g));
    data[idx + 2] = Math.floor(Math.min(255, b));
    data[idx + 3] = Math.floor(Math.min(255, a));
  }
  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  applyTextureDefaults(texture, 'color');

  // Warm self-glow for the icy/dusty bright systems; near-black for the dark
  // charcoal ones so they don't read as lit in shadow.
  const warm = cfg.style === 'saturn' || cfg.style === 'jupiter';
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    roughness: 0.6,
    metalness: 0.05,
    emissive: new THREE.Color(warm ? 0x1a1510 : 0x050506),
    depthWrite: false,
  });

  mat.userData.fx = augmentRingMaterial(mat, planetRadiusAU, sunTan);

  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
