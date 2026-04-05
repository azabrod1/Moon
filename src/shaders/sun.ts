export const sunCoronaVertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const sunCoronaFragmentShader = /* glsl */ `
uniform float time;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

// Simple noise
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 viewDir = normalize(-vPosition);
  float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);

  // Animated surface turbulence
  vec2 uv = vUv * 6.0;
  float n = fbm(uv + time * 0.15);
  float n2 = fbm(uv * 1.5 - time * 0.1);

  // Core color
  vec3 coreColor = vec3(1.0, 0.95, 0.8);
  vec3 midColor = vec3(1.0, 0.7, 0.2);
  vec3 edgeColor = vec3(1.0, 0.3, 0.05);

  vec3 surfaceColor = mix(coreColor, midColor, rimDot * 0.7 + n * 0.3);
  surfaceColor = mix(surfaceColor, edgeColor, pow(rimDot, 2.0));

  // Intensity with surface detail
  float intensity = 2.5 - rimDot * 1.2 + n2 * 0.3;

  gl_FragColor = vec4(surfaceColor * intensity, 1.0);
}
`;

export const sunGlowVertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const sunGlowFragmentShader = /* glsl */ `
uniform float alphaScale;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 viewDir = normalize(-vPosition);
  float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);
  float intensity = pow(rimDot, 2.5) * 2.0;

  vec3 glowColor = mix(
    vec3(1.0, 0.6, 0.1),
    vec3(1.0, 0.2, 0.0),
    rimDot
  );

  gl_FragColor = vec4(glowColor * intensity, intensity * alphaScale);
}
`;
