/**
 * Planetarium background starfield: the bright-star catalog projected onto a
 * fixed-radius celestial sphere as GPU points (per-vertex size + colour-index
 * tint). Pure builders — no scene or mode state.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';

/** Map a stellar colour index (B–V) to an approximate RGB tint. */
export function getStarColor(colorIndex: number): THREE.Color {
  const clamped = THREE.MathUtils.clamp(colorIndex, -0.3, 1.8);
  const t = (clamped + 0.3) / 2.1;
  const cool = new THREE.Color(0.55, 0.70, 1.0);
  const neutral = new THREE.Color(1.0, 0.97, 0.92);
  const warm = new THREE.Color(1.0, 0.68, 0.38);
  return t < 0.5
    ? cool.clone().lerp(neutral, t * 2)
    : neutral.clone().lerp(warm, (t - 0.5) * 2);
}

export function createPlanetariumStarfield(): THREE.Points {
  // Filter out Sol (rendered as 3D mesh)
  const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10);
  const starCount = catalog.length;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const sizes = new Float32Array(starCount);

  for (let i = 0; i < starCount; i++) {
    const star = catalog[i];
    const radius = 85;
    const ra = THREE.MathUtils.degToRad(star.raDeg);
    const dec = THREE.MathUtils.degToRad(star.decDeg);
    const cosDec = Math.cos(dec);
    const color = getStarColor(star.colorIndex);
    const brightness = THREE.MathUtils.clamp(1.2 - (star.magnitude + 1.44) / 8, 0.25, 1.2);

    positions[i * 3] = radius * cosDec * Math.cos(ra);
    positions[i * 3 + 1] = radius * Math.sin(dec);
    positions[i * 3 + 2] = radius * cosDec * Math.sin(ra);

    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;

    // More spread so constellation stars (mag 1-3) stand out from dim ones
    sizes[i] = THREE.MathUtils.clamp(6.0 - star.magnitude * 1.1, 1.2, 6.5);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  // Custom shader for per-vertex star sizes
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * pixelRatio;
        }
      `,
    fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.2, 0.5, d);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });

  return new THREE.Points(geo, mat);
}
