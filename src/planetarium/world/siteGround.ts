/**
 * The ground under a site (stage 2): one full-screen pass that paints every
 * pixel whose view ray points below the horizon. A ray is ground when it
 * points down by more than the horizon's dip, acos(R / (R + h)), which the
 * caller computes in doubles (siteView.ts horizonDipDeg): the float-safe
 * form at a two-metre eye on a body thousands of km across, where |c|² − R²
 * in the shader would sit at the edge of float32.
 *
 * Everything drawn before it below the horizon — stars, planet and moon
 * points, constellation lines, the globe's mesh beyond the near plane — is
 * painted over; sky pixels are discarded. It draws inside the scene, so the
 * lens pass warps its horizon exactly as it warps everything else (a horizon
 * through the frame's centre stays straight, one off it curves). DOM overlays
 * are not scene geometry: the controller hides those below the horizon itself.
 *
 * The view ray comes from the projection's scale and offset terms, never
 * from its inverse: with the near plane at 1e-6 AU and the far at 200 AU,
 * un-projecting cancels two ±5e5 terms in float32 and the ray comes out NaN.
 *
 * Shading is the scene's own Lambert law (`radiance` is albedo ×
 * SUN_LIGHT_INTENSITY / π × the Sun's colour, dimmed by the caller in
 * eclipse), times the cosine of the Sun's altitude: flat ground. Colour only
 * — Earth's ground marks the sea in alpha for the glow pass, and this layer
 * must not write it. The tone-mapping chunks make it right on the no-float
 * route, where the scene draws straight to the screen, and are no-ops in the
 * composer's linear target.
 */
import * as THREE from 'three';

export class SiteGround {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    uProjectionScale: { value: new THREE.Vector2(1, 1) },
    uProjectionOffset: { value: new THREE.Vector2(0, 0) },
    uCameraWorld: { value: new THREE.Matrix4() },
    uZenith: { value: new THREE.Vector3(0, 1, 0) },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    uSinDip: { value: 0 },
    uRadiance: { value: new THREE.Color(0, 0, 0) },
  };

  constructor() {
    const uniforms = this.uniforms;
    const material = new THREE.ShaderMaterial({
      name: 'SiteGround',
      uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec2 uProjectionScale;
        uniform vec2 uProjectionOffset;
        uniform mat4 uCameraWorld;
        uniform vec3 uZenith;
        uniform vec3 uSunDirection;
        uniform float uSinDip;
        uniform vec3 uRadiance;
        varying vec2 vNdc;
        void main() {
          vec3 viewDirection = normalize(vec3((vNdc + uProjectionOffset) / uProjectionScale, -1.0));
          vec3 ray = normalize(mat3(uCameraWorld) * viewDirection);
          // Below the horizon by more than the dip: the ray meets the ground.
          float depression = -dot(ray, uZenith) - uSinDip;
          float edge = fwidth(depression) * 1.5;
          float ground = smoothstep(-edge, edge, depression);
          if (ground <= 0.0) discard;
          float sunUp = max(dot(uZenith, uSunDirection), 0.0);
          gl_FragColor = vec4(uRadiance * sunUp, ground);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.mesh.name = 'Site ground';
    this.mesh.frustumCulled = false;
    // After every scene layer it has to cover below the horizon.
    this.mesh.renderOrder = 10_000;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const projection = (camera as THREE.PerspectiveCamera).projectionMatrix.elements;
      uniforms.uProjectionScale.value.set(projection[0], projection[5]);
      uniforms.uProjectionOffset.value.set(projection[8], projection[9]);
      uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    };
  }

  /** This frame's site: its up, the direction to the Sun, the horizon's dip
   *  (radians) and the ground's radiance at normal incidence (linear). */
  update(zenith: THREE.Vector3, sunDirection: THREE.Vector3, horizonDipRad: number, radiance: THREE.Color): void {
    this.uniforms.uZenith.value.copy(zenith);
    this.uniforms.uSunDirection.value.copy(sunDirection).normalize();
    this.uniforms.uSinDip.value = Math.sin(horizonDipRad);
    this.uniforms.uRadiance.value.copy(radiance);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** The ground's albedo per body, linear RGB, as the globe is drawn with it:
 *  the Moon's disc centre at full phase read off the scene's linear target
 *  (__moon.readScene: 0.190, 0.164, 0.138) over SUN_LIGHT_INTENSITY / π. Its
 *  map is graded to the real normal albedo (about 0.13 here), so the raw
 *  map's mean (0.45) would light the ground three and a half times too
 *  bright. Bodies without an entry are not offered as sites. */
export const SITE_GROUND_ALBEDO_LINEAR: Readonly<Record<string, readonly [number, number, number]>> = {
  Moon: [0.1546, 0.1332, 0.1124],
};
