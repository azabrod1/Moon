/**
 * The atmosphere shell drawn from the precomputed tables — the sky seen past a
 * body's limb, as a physical airlight rather than an authored fringe. It shares
 * the analytic shell's mesh (BackSide, additive, no depth write) and its two
 * per-frame uniforms (`uSunDirWorld`, `alphaScale`), so the two tiers are
 * interchangeable on one mesh; only the fragment colour differs.
 *
 * Four things about it are load-bearing:
 *
 *  - **The ray is advanced to the atmosphere entry point before any lookup.**
 *    Nothing in the app is ever inside the air: the camera floor is 268 km, the
 *    landed eye 374 km, the modelled top 100 km. So the case that runs on every
 *    frame is the viewer in space, where the camera's own r sits far above the
 *    table's top row — look up there and every sample clamps to the top layer
 *    and the sky comes back flat. The primary path intersects the sphere of
 *    radius `uTopRadius` (the PHYSICAL top, a table parameter — not the mesh
 *    radius, which is larger), moves the origin to the entry point and
 *    re-derives r, mu, mu_s and nu there. The inside-start branch is kept for
 *    dev poses, which are the only way to reach it.
 *
 *  - **The mesh is larger than the air.** Rays that cross the mesh but miss the
 *    top sphere return zero, which is what tapers the radiance to nothing
 *    across the outermost shell of mesh rather than ending it on a wire.
 *
 *  - **A ray that hits the ground returns zero here.** The airlight in front of
 *    a surface belongs to that surface's own shading (it needs the segment from
 *    the camera to the fragment, not to the far boundary). The depth test
 *    against the opaque globe already rejects most of those fragments, but not
 *    where no globe is drawn, so the shader states the split itself.
 *
 *  - **The eclipse trace runs in the body frame.** The shell is a child of the
 *    body's group with an identity local rotation, so its object space IS the
 *    frame `uMoonShadow`'s caster centres are given in, and the same uniform
 *    values apply without a second set. The trace is evaluated at the lowest
 *    point the view ray reaches, where the air it carries is densest.
 *
 * Past the terminator the sky is no longer the Sun's. Two more sources draw
 * there, both weighted by the one `nightWeight` every non-solar term in the app
 * shares, read here at the ray's lowest point:
 *
 *  - **Airglow** is emitted in a thin layer of the upper air, not scattered
 *    from anything, so it is computed on the whole ray — including the rays
 *    that pass ABOVE the modelled air, which no table describes and which is
 *    where the 630 nm fringe sits. It is the one term here that is not a table
 *    lookup, and the one whose radiance is authored.
 *  - **The Moon** is a second light on the same air: the same tables, the same
 *    fetch count, with the two angles that involve the source swapped. Its
 *    irradiance uniform carries its distance, its phase, its own eclipse and
 *    its redder spectrum, so the shader cannot tell the two sources apart.
 *
 * What this tier still does not carry is the city glow — the upward-scattered
 * light that makes a city visible through cloud.
 */
import * as THREE from 'three';
import {
  ATMOSPHERE_LOOKUP_GLSL,
  atmosphereLookupUniforms,
  atmosphereTableDefines,
  applyAtmosphereParams,
  type AtmosphereTables,
} from './atmosphereLut';
import {
  AIRLIGHT_SCALE,
  atmosphereParams,
  clampCosine,
  rayIntersectsGround,
  type AtmosphereParams,
  type AtmosphereTableSizes,
} from './atmosphereModel';
import { MAX_MOON_SHADOWS, MOON_SHADOW_TRACE_GLSL, type SurfaceShadingFx } from './surfaceShading';
import { AIRGLOW_GLSL, AIRGLOW_LIMB_CAP, NIGHT_WEIGHT_GLSL, airglowUniforms } from './nightSources';

const SHELL_VERTEX = /* glsl */`
uniform vec3 uSunDirWorld;
uniform vec3 uMoonDirWorld;
out vec3 vObjPos;
out vec3 vCamObj;
out vec3 vSunObj;
out vec3 vMoonObj;

void main() {
  vObjPos = position;
  // Object space is the body frame: the group carries the pole orientation and
  // the translation, the shell's own rotation is identity, and the group is
  // never scaled — so the model matrix's basis is orthonormal and its transpose
  // inverts it. Both the eclipse casters and the table's geometry are stated in
  // that frame, so the whole fragment stage stays in it.
  vec3 bx = normalize(modelMatrix[0].xyz);
  vec3 by = normalize(modelMatrix[1].xyz);
  vec3 bz = normalize(modelMatrix[2].xyz);
  vec3 rel = cameraPosition - modelMatrix[3].xyz;
  vCamObj = vec3(dot(rel, bx), dot(rel, by), dot(rel, bz));
  vSunObj = vec3(dot(uSunDirWorld, bx), dot(uSunDirWorld, by), dot(uSunDirWorld, bz));
  vMoonObj = vec3(dot(uMoonDirWorld, bx), dot(uMoonDirWorld, by), dot(uMoonDirWorld, bz));
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const SHELL_FRAGMENT = /* glsl */`
// The lookup GLSL takes its tables as parameters, so each consumer declares the
// samplers it actually reads. Sky radiance needs the scattering table alone:
// the segment runs from the entry point to the far boundary, which is what a
// table texel already is — no transmittance ratio, no irradiance.
uniform sampler3D uScattering;

uniform float uPlanetRadius;
uniform float alphaScale;
uniform float uSolarIrradiance;
// Per channel: the tables are baked at WHITE unit irradiance, and the scene's
// Sun is a warm point light. A scalar here lights the air with a whiter Sun
// than the ground below it.
uniform vec3 uAirlightScale;
// The same bridge for the Moon, with its distance, its phase, its own eclipse
// and its redder spectrum already in it — so a moonlit lookup costs exactly
// what a sunlit one does. Zero on a body with no moon worth the second fetch.
uniform vec3 uMoonIrradiance;
uniform vec4 uMoonShadow[${MAX_MOON_SHADOWS}];
uniform int uMoonShadowCount;
uniform float uSunTan;

in vec3 vObjPos;
in vec3 vCamObj;
in vec3 vSunObj;
in vec3 vMoonObj;

out vec4 fragColor;

${MOON_SHADOW_TRACE_GLSL}
${NIGHT_WEIGHT_GLSL}
${AIRGLOW_GLSL}

void main() {
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);

  vec3 toFragment = vObjPos - vCamObj;
  float span = length(toFragment);
  // A degenerate ray (the camera exactly on the shell) has no direction to
  // normalize; normalize(0) is undefined and reads as NaN on Metal.
  if (span <= 0.0 || uPlanetRadius <= 0.0) return;
  vec3 view = toFragment / span;
  vec3 sun = normalize(vSunObj);

  // The tables are baked in radius units, where the surface is r = 1.
  vec3 camera = vCamObj / uPlanetRadius;
  float rCam = length(camera);
  if (!(rCam > 0.0)) return;
  float rmuCam = dot(camera, view);

  // Ground rays carry their air in the surface material, where the segment ends
  // at the fragment rather than at the far boundary — and the airglow layer in
  // front of a lit surface is a thousandth of what is behind it.
  if (rayIntersectsGround(rCam, clampCosine(rmuCam / rCam))) return;

  // The lowest point the ray reaches: the deepest air it crosses, and so where
  // the eclipse is traced and where the Sun's elevation decides every non-solar
  // source. One point, from the camera's own origin, so the airglow, the
  // moonlight and the eclipse cannot disagree about which part of the ray they
  // are talking about.
  vec3 lowest = camera + view * max(-rmuCam, 0.0);
  float night = nightWeight(clampCosine(dot(normalize(lowest), sun)));

  // Airglow: emitted in the layer, not scattered from anything, so it is
  // computed on the whole ray — including the rays that pass above the modelled
  // air entirely, which is where the 630 nm fringe lives.
  vec3 radiance = airglowRadiance(camera, view, night);

  // The air itself. The ray is advanced to the entry point first: from out here
  // a lookup at the camera's own radius clamps every ray to the table's top row
  // and the sky comes back flat.
  vec3 origin = camera;
  float r = rCam;
  float rmu = rmuCam;
  bool inAir = true;
  if (r > uTopRadius) {
    float disc = rmu * rmu - r * r + uTopRadius * uTopRadius;
    float dEntry = -rmu - safeSqrt(disc);
    if (disc < 0.0 || dEntry <= 0.0) {
      inAir = false;                        // misses the air, or it is behind
    } else {
      origin += view * dEntry;
      // r*mu at the entry point is rmu + dEntry, which is exactly -sqrt(disc):
      // written that way it stays a number of size ~0.2 instead of a difference
      // of two numbers of size r, which at 8 R spends four of highp's digits.
      rmu = -sqrt(disc);
      r = uTopRadius;
    }
  } else {
    // Inside the air — dev poses only; the table already starts at the camera.
    r = clampRadius(r);
  }

  if (inAir) {
    float mu = clampCosine(rmu / r);
    float nu = clampCosine(dot(view, sun));
    vec4 scattering = getScattering3DRGBA(
        uScattering, r, mu, clampCosine(dot(origin, sun) / r), nu, false);
    vec3 rayleigh = max(scattering.rgb, vec3(0.0));
    vec3 mie = max(getExtrapolatedSingleMieScattering(scattering), vec3(0.0));

    // Eclipse: the same casters the ground traces, in the same frame, sampled
    // at the ray's lowest point.
    float sunVisible = 1.0;
    for (int i = 0; i < ${MAX_MOON_SHADOWS}; i++) {
      if (i >= uMoonShadowCount) break;
      sunVisible *= 1.0 - moonShadowOcclusion(
          uMoonShadow[i].xyz - lowest * uPlanetRadius, uMoonShadow[i].w, sun, uSunTan);
    }
    radiance += (rayleigh * rayleighPhaseFunction(nu) + mie * miePhaseFunction(uMiePhaseG, nu))
        * uAirlightScale * (uSolarIrradiance * sunVisible);

    // The Moon, through the same tables: a second light on the same air, so the
    // lookup is the sunlit one with the two angles that involve the source
    // swapped. Behind the night weight, so by day it costs a branch and no
    // fetches at all.
    if (night > 0.0 && uMoonIrradiance != vec3(0.0)) {
      vec3 moon = normalize(vMoonObj);
      float nuMoon = clampCosine(dot(view, moon));
      vec4 lunar = getScattering3DRGBA(
          uScattering, r, mu, clampCosine(dot(origin, moon) / r), nuMoon, false);
      vec3 lunarRayleigh = max(lunar.rgb, vec3(0.0));
      vec3 lunarMie = max(getExtrapolatedSingleMieScattering(lunar), vec3(0.0));
      radiance += (lunarRayleigh * rayleighPhaseFunction(nuMoon)
              + lunarMie * miePhaseFunction(uMiePhaseG, nuMoon))
          * uMoonIrradiance * night;
    }
  }

  fragColor = vec4(radiance * alphaScale, 1.0);
}
`;

/** A 1×1 stand-in for each table, so a material can exist — and its program can
 *  be linked in the boot warm-up — before any table is baked. Sampling one is
 *  never legal: a shell only becomes the drawn material once its body's tables
 *  are ready. */
function dummyTables(): { map2D: THREE.DataTexture; map3D: THREE.Data3DTexture } {
  const map2D = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  map2D.needsUpdate = true;
  const map3D = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  map3D.minFilter = THREE.LinearFilter;
  map3D.magFilter = THREE.LinearFilter;
  map3D.needsUpdate = true;
  return { map2D, map3D };
}

export interface AtmosphereShellOptions {
  /** Solid surface radius in AU — the table's bottom radius in scene units. */
  planetRadius: number;
  /** Table dimensions, which the addressing GLSL takes as #defines. One profile
   *  per session, so every shell compiles to the same program. */
  sizes: AtmosphereTableSizes;
  /** Body whose parameters the shader carries. Its tables are bound later. */
  body: string;
  /** The body's shared shading uniforms, so the shell's eclipse spot is the
   *  same object the ground's is fed from. */
  fx?: SurfaceShadingFx;
  /** Tangent of the Sun's angular radius at this body — the penumbra width. */
  sunTan?: number;
  initialAlpha?: number;
  initialSunDir?: THREE.Vector3;
}

/**
 * The LUT-tier shell material. Built without tables: the program links in the
 * boot warm-up, and `bindAtmosphereShellTables` supplies the textures when the
 * bake finishes.
 */
export function createAtmosphereShellMaterial(
  options: AtmosphereShellOptions,
): THREE.ShaderMaterial {
  const params = atmosphereParams(options.body);
  const dummies = dummyTables();
  const airglow = airglowUniforms(options.body);
  const uniforms: Record<string, THREE.IUniform> = {
    ...atmosphereLookupUniforms(),
    uSunDirWorld: { value: options.initialSunDir?.clone() ?? new THREE.Vector3(0, 0, 1) },
    alphaScale: { value: options.initialAlpha ?? 0.0 },
    uPlanetRadius: { value: options.planetRadius },
    uSolarIrradiance: { value: 1 },
    uAirlightScale: { value: new THREE.Vector3(...AIRLIGHT_SCALE) },
    // The Moon's two uniforms come off the body's shared air block wherever
    // there is one: the shell and the ground it wraps have to be lit by the
    // same Moon, and a second pair of objects is how they stop being.
    uMoonDirWorld: options.fx?.air?.uMoonDirWorld ?? { value: new THREE.Vector3(0, 0, 1) },
    uMoonIrradiance: options.fx?.air?.uMoonIrradiance ?? { value: new THREE.Vector3() },
    uAirglowBands: { value: new THREE.Vector4(...airglow.bands) },
    uAirglowGreen: { value: new THREE.Vector3(...airglow.green) },
    uAirglowOrange: { value: new THREE.Vector3(...airglow.orange) },
    uAirglowLimbCap: { value: AIRGLOW_LIMB_CAP },
    uMoonShadow: options.fx?.uMoonShadow
      ?? { value: Array.from({ length: MAX_MOON_SHADOWS }, () => new THREE.Vector4()) },
    uMoonShadowCount: options.fx?.uMoonShadowCount ?? { value: 0 },
    uSunTan: { value: options.sunTan ?? 0 },
  };
  applyAtmosphereParams(uniforms, params);
  uniforms.uTransmittance.value = dummies.map2D;
  uniforms.uIrradiance.value = dummies.map2D;
  uniforms.uScattering.value = dummies.map3D;

  const material = new THREE.ShaderMaterial({
    vertexShader: SHELL_VERTEX,
    fragmentShader: ATMOSPHERE_LOOKUP_GLSL + SHELL_FRAGMENT,
    glslVersion: THREE.GLSL3,
    precision: 'highp',
    defines: atmosphereTableDefines(options.sizes),
    uniforms,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.userData.atmosphereDummyTables = [dummies.map2D, dummies.map3D];
  return material;
}

/** Point a shell at a body's finished tables. */
export function bindAtmosphereShellTables(
  material: THREE.ShaderMaterial,
  tables: AtmosphereTables,
): void {
  applyAtmosphereParams(material.uniforms, tables.params);
  material.uniforms.uTransmittance.value = tables.transmittance;
  material.uniforms.uScattering.value = tables.scattering;
  material.uniforms.uIrradiance.value = tables.irradiance;
}

/** Free the 1×1 stand-ins a shell was built with (the tables themselves belong
 *  to the baker). */
export function disposeAtmosphereShellMaterial(material: THREE.ShaderMaterial): void {
  const dummies = material.userData.atmosphereDummyTables as THREE.Texture[] | undefined;
  if (dummies) for (const texture of dummies) texture.dispose();
  material.dispose();
}

// ---------------------------------------------------------------------------
// The ray setup, in TypeScript
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export interface ShellRay {
  /** False when the ray never enters the air: it misses the top sphere, or the
   *  air is behind the camera. Nothing is drawn for those — which is what
   *  tapers the shell to zero across the mesh outside the physical top. */
  readonly reachesAir: boolean;
  /** True when the ray ends on the surface. The shell draws nothing there; the
   *  air in front of a surface is that surface's own to carry. */
  readonly hitsGround: boolean;
  /** Distance from the camera to the entry point, in radius units; 0 for a
   *  camera already inside the air. */
  readonly entryDistance: number;
  /** The four table coordinates, AT THE ENTRY POINT. */
  readonly r: number;
  readonly mu: number;
  readonly muS: number;
  readonly nu: number;
}

/**
 * Where in the tables a view ray lands. Mirrors SHELL_FRAGMENT above line for
 * line, in the frame the shader works in: the body's own, radius units, origin
 * at its centre. The shader cannot be unit-tested and this can, so the two are
 * kept in step by hand — the golden captures are what would catch a drift.
 *
 * The step that matters is the shift: with the camera outside the air (which is
 * every pose the app can actually reach), a lookup at the camera's own radius
 * would clamp to the table's top row for every ray, and the sky would come back
 * flat. The ray is advanced to the top boundary first and all four coordinates
 * are re-derived there.
 */
export function atmosphereShellRay(
  params: AtmosphereParams,
  cameraRadii: Vec3,
  view: Vec3,
  sun: Vec3,
): ShellRay {
  const miss: ShellRay = {
    reachesAir: false, hitsGround: false, entryDistance: 0, r: 0, mu: 0, muS: 0, nu: 0,
  };
  let origin = cameraRadii;
  let r = Math.sqrt(dot(origin, origin));
  if (!(r > 0)) return miss;
  let rmu = dot(origin, view);
  let entryDistance = 0;

  if (r > params.topRadius) {
    const disc = rmu * rmu - r * r + params.topRadius * params.topRadius;
    if (disc < 0) return miss;
    const dEntry = -rmu - Math.sqrt(disc);
    if (dEntry <= 0) return miss;
    origin = [
      origin[0] + view[0] * dEntry,
      origin[1] + view[1] * dEntry,
      origin[2] + view[2] * dEntry,
    ];
    // rmu + dEntry is exactly -sqrt(disc); the closed form keeps the entry
    // point's r*mu off a subtraction of two numbers of size r.
    rmu = -Math.sqrt(disc);
    r = params.topRadius;
    entryDistance = dEntry;
  } else {
    r = Math.min(params.topRadius, Math.max(params.bottomRadius, r));
  }

  const mu = clampCosine(rmu / r);
  return {
    reachesAir: true,
    hitsGround: rayIntersectsGround(params, r, mu),
    entryDistance,
    r,
    mu,
    muS: clampCosine(dot(origin, sun) / r),
    nu: clampCosine(dot(view, sun)),
  };
}
