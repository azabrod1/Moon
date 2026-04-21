export const atmosphereVertexShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const atmosphereFragmentShader = /* glsl */ `
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 viewDir = normalize(-vPosition);
  float rimDot = 1.0 - max(dot(viewDir, vNormal), 0.0);
  float intensity = pow(rimDot, 5.0) * 0.8;

  vec3 atmosphereColor = mix(
    vec3(0.35, 0.6, 1.0),
    vec3(0.15, 0.35, 0.9),
    rimDot
  );

  gl_FragColor = vec4(atmosphereColor, intensity * 0.35);
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
