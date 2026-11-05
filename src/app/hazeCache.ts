/**
 * Earth's sunlit haze, evaluated once per small block of the screen instead of
 * once per surface fragment.
 *
 * **Why.** Every fragment of Earth's ground and cloud deck adds the light the
 * air between it and the camera scatters toward the camera (world/
 * surfaceShading, "Aerial perspective, last"). The Sun's share of that light is
 * the frame's single most expensive term up close: eight dependent fetches
 * from the 3D scattering tables per fragment — two ends of the segment, two nu
 * slabs each, and the single-Mie colour beside each — where everything else in
 * the block is two 2D fetches. Measured on an M5 Max (Chromium, ANGLE/Metal,
 * High) the block costs about 0.9 ms of a frame at the postcard pose and 1.1 ms
 * straight down from 1.05 R, which is the difference between that frame
 * fitting a 120 Hz refresh and missing it. The light itself changes slowly
 * across the screen: it is the integral along a ray of a few kilometres of
 * scale height, and neighbouring rays a few pixels apart cross nearly the same
 * air.
 *
 * **What is cached.** The Sun's in-scatter alone, at one unit of solar
 * irradiance, for each of the two layers the surfaces end their segments at —
 * the ground at the body's radius and the cloud deck at its stated altitude
 * (AIR_LOOKUP_RADIUS) — on a grid of one texel per `HAZE_CACHE_DIVISOR` ×
 * `HAZE_CACHE_DIVISOR` scene pixels, rebuilt every frame from nothing (no
 * history, so nothing can lag or smear). Each texel runs the surfaces' own
 * GLSL (`aerialSegment`, `aerialTransmittance`, `aerialInscatter`) on the
 * segment from the camera to where the ray through the texel's centre first
 * meets the layer's sphere. A surface fragment reads it with one bilinear
 * fetch. Everything else in the block stays per fragment and exact: the
 * segment, its transmittance (which also dims the sea's glint and is the only
 * term Earth's night-lights shell reads), the Moon's in-scatter, the haze
 * weight, the loading fade, the cloud shadow's share of the air, the eclipse
 * and the bridge to the scene's Sun. Earth only: every other body with tables
 * keeps its exact per-fragment haze, because Earth is where the cost is and a
 * body that is not cached cannot be moved by the cache.
 *
 * **Where the cache is not trusted.** The cached value is a different segment
 * from the fragment's own: the mesh is a polyhedron and the cache ends on the
 * true sphere, and between texel centres the value is interpolated. Both are
 * small where the light varies slowly and wrong where it does not, so a
 * fragment evaluates the Sun's in-scatter exactly, as it did before the cache
 * existed, when ANY of these holds:
 *
 *   - its segment does not reach the ground (the other half of the folded
 *     table, and the thin ring of deck outside the ground's silhouette);
 *   - it is seen within `HAZE_EXACT_GRAZING` of grazing (the haze weight's own
 *     grazing measure, at the segment's end): the limb, where the column
 *     changes fastest and a bilinear footprint of 8 or 16 pixels can reach
 *     across the silhouette;
 *   - its segment-entry Sun cosine lies within one cache texel's angle of the
 *     interval `0 … 0.01` over which `aerialInscatter` switches single Mie off
 *     below the horizon — a cut 0.57 degrees wide that interpolation would
 *     smear by a texel;
 *   - the footprint's alpha says so (below).
 *
 * **The alpha contract.** Each texel's alpha is computed in the pass from the
 * geometry alone, no table fetch: the texel and its eight neighbours each cast
 * a ray through their centres, and the texel is trusted only if all nine reach
 * the ground. A trusted texel's alpha is its distance from the ground's
 * projected silhouette, in cache texels (the angle between its ray and the
 * body's centre against the silhouette cone `asin(R/|camera|)`, times the
 * scene camera's focal length in texels), mapped `(distance − 1) / 3` onto
 * 0 … 1; an untrusted one's is 0. Because the flag is dilated by one texel,
 * any 2 × 2 footprint that touches a texel whose own ray misses the ground
 * reads alpha exactly 0, with no neighbour reads in the surface shader. The
 * surface then takes: alpha 0 → exact; alpha 1 → the cache; in between →
 * exact and cache mixed by alpha, which is the band from about one to four
 * texels inside the silhouette. A texel whose own ray misses the ground stores
 * zero: every footprint that could weight it reads alpha 0 and takes the exact
 * branch, which never reads the cached colour, so the value is never used.
 *
 * **The pass.** A composer pass right before the scene's RenderPass and one
 * right after it (main.ts buildComposer, the planetarium's composer only).
 * The first refreshes the camera's and the body's world matrices itself — the
 * scene render that would otherwise do it comes later — draws one quad per
 * layer into its own half-float target, and only then switches the layer on
 * for the surfaces; the second switches it off again. So the cache is in force
 * only for the one scene draw it was rendered for: a warm-up draw, a census
 * link, a resize, a mode change, a table rebind or a context restore between
 * frames always sees it off and draws the exact haze. Sized from the ACTIVE
 * scene draw rectangle (main.ts applySceneViewports), not the canvas and not
 * the allocated target: under Dynamic the frame is drawn into a sub-rectangle
 * of a larger allocation, and the rectangle moves on every rung. Linear data:
 * no tone curve, no blending, no depth, no mipmaps; the targets are linear,
 * clamped and filtered.
 *
 * **Doors.** `?hazecache=0` (any build) compiles the surfaces without the
 * cache at all: the define is gone and every surface program is the program
 * from before the cache, character for character. The DEV switch `haze-cache`
 * (app/perfSwitches.ts) turns it off live, inside one compiled program, for an
 * A/B out of one page load. DEV `?hazecachediv=<n>` sets the divisor,
 * `?hazeexact=<grazing>,<margin scale>` the exact band, `?hazecache32f=1`
 * stores the cache in 32-bit float to separate storage error from spatial
 * error, `?hazeprobe=1` compiles the full-resolution probes and the reason
 * readout, and `__moon.hazeCache()` reads the state out (size, divisor, exact
 * band, the layers drawn, and — with the probes compiled — `{ coverage: true
 * }`, the share of the visible surface on the cache and on each exact
 * reason). The pass is the "Haze cache" row of `__moon.gpuProfile`.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_GLSL,
  atmosphereLookupUniforms,
  atmosphereSessionSizes,
  atmosphereTableDefines,
} from '../planetarium/world/atmosphereLut';
import { perfSwitchOn } from './perfSwitches';

/** Scene pixels per cache texel, each way. */
export const HAZE_CACHE_DIVISOR = 4;
/** The haze weight's grazing measure (1 − cos of the view angle at the
 *  segment's end) from which a fragment always evaluates the Sun's in-scatter
 *  exactly: about 78 degrees from straight down, the outer couple of percent
 *  of a disc's radius seen from afar. */
export const HAZE_EXACT_GRAZING = 0.8;
/** The single-Mie cut-off `aerialInscatter` applies, as the segment-entry Sun
 *  cosine at which it is complete. Its start is 0. */
export const HAZE_MIE_CUT = 0.01;

/** `?hazecache=0`, any build: the surfaces compile without the cache. */
export function parseHazeCacheParam(search: string): boolean {
  return new URLSearchParams(search).get('hazecache') !== '0';
}
/** DEV `?hazecachediv=<n>`: scene pixels per cache texel. */
export function parseHazeDivisorParam(search: string, dev: boolean): number {
  const n = dev ? Number(new URLSearchParams(search).get('hazecachediv')) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : HAZE_CACHE_DIVISOR;
}
/** DEV `?hazeexact=<grazing>,<margin scale>`: the exact band. */
export function parseHazeExactParam(search: string, dev: boolean): { grazing: number; margin: number } {
  const raw = dev ? new URLSearchParams(search).get('hazeexact') : null;
  const [g, m] = (raw ?? '').split(',').map(Number);
  return {
    grazing: Number.isFinite(g) && g > 0 && g <= 1 ? g : HAZE_EXACT_GRAZING,
    margin: Number.isFinite(m) && m >= 0 ? m : 1,
  };
}
/** DEV `?hazecache32f=1`: the cache stored in 32-bit float, the diagnostic. */
export function parseHaze32fParam(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get('hazecache32f') === '1';
}

/** DEV `?hazeprobe=1`: the surfaces also compile the full-resolution probes
 *  and the reason readout (HAZE_PROBE), for a measurement session; without
 *  it a development program has the shipping structure, so it can be timed. */
export function parseHazeProbeParam(search: string, dev: boolean): boolean {
  return dev && new URLSearchParams(search).get('hazeprobe') === '1';
}
let probeCompiled = false;
export function setHazeProbeCompiled(on: boolean): void {
  probeCompiled = import.meta.env.DEV && on;
}
/** Whether the surfaces compile the probes and the readout this session. */
export function hazeProbeCompiled(): boolean {
  return probeCompiled;
}

let compiled = true;
/** Set once at boot from the URL, before any surface material exists. */
export function setHazeCacheCompiled(on: boolean): void {
  compiled = on;
}
/** Whether the surfaces compile the cache's read this session. */
export function hazeCacheCompiled(): boolean {
  return compiled;
}

/**
 * The camera ray through a point of the active scene viewport, shared by the
 * pass and by the surfaces' development probe so the two derive it with one
 * text. `ray` is the projection's (1/P00, 1/P11, P20/P00, P21/P11) — exact for
 * any perspective, the off-axis terms included — and `basis` the camera's
 * world rotation; the result is in the world's axes, which is the frame the
 * surfaces' segments are in (body-centred, world-axis offsets).
 */
export const HAZE_RAY_GLSL = /* glsl */ `
vec3 hazeRayDir(vec2 ndc, vec4 ray, mat3 basis) {
  return normalize(basis * vec3(ndc.x * ray.x + ray.z, ndc.y * ray.y + ray.w, -1.0));
}
// The distance along a unit ray to its first crossing of the sphere of this
// radius about the centre, or -1. The discriminant from the ray's closest
// approach rather than as a difference of two squares of the camera's
// distance, which loses its digits far out.
float hazeSphereHit(vec3 origin, vec3 dir, float radius) {
  float b = dot(origin, dir);
  vec3 perp = origin - dir * b;
  float disc = radius * radius - dot(perp, perp);
  if (disc < 0.0) return -1.0;
  float t = -b - sqrt(disc);
  return t > 0.0 ? t : -1.0;
}
`;

/**
 * What the surfaces add under `HAZE_CACHE`: the cache's uniforms and the
 * function that hands the aerial block its Sun in-scatter. Injected right
 * after the lookup and AERIAL_PERSPECTIVE_GLSL, so the segment type and the
 * lookups exist. Every line is inside the define's own conditional.
 *
 * The fetch is `textureLod` at level 0: it sits in a branch that is uniform
 * for the draw, but the exact branch below it diverges per fragment, and the
 * cache has no levels to choose between anyway. Development builds can add,
 * under HAZE_PROBE (`?hazeprobe=1`), the full-resolution probes (`uHazeProbe`:
 * the cache's own endpoint on the true sphere, evaluated per fragment
 * wherever the cache would be read, optionally round-tripped through half
 * float, or everywhere) and the reason readout (`uHazeDiag`); left out by
 * default, because each probe inlines the lookup again and a program that
 * size does not time like the one that ships.
 */
export function hazeSurfaceDeclsGlsl(dev: boolean): string {
  const probe = dev ? `#ifdef HAZE_PROBE
uniform float uHazeProbe;
uniform vec4 uHazeRay;
uniform mat3 uHazeBasis;
uniform float uHazeDiag;
float hazeReason = 0.0;
${HAZE_RAY_GLSL}
vec3 hazeHalf(vec3 s) {
  return vec3(unpackHalf2x16(packHalf2x16(s.rg)), unpackHalf2x16(packHalf2x16(vec2(s.b, 0.0))).x);
}
// The cache's own endpoint, the true sphere under this pixel's centre,
// evaluated here at full resolution: 1 where the cache would be read (the
// exact rules honoured), 2 the same stored through half float, 3 everywhere.
vec3 hazeProbeInscatter(AerialSegment seg, vec3 airT) {
  if (uHazeProbe < 2.5 && hazeExactOnly(seg)) return aerialInscatter(uScattering, seg, airT);
  vec2 ndc = 2.0 * (gl_FragCoord.xy - uHazeViewport.xy) / uHazeViewport.zw - 1.0;
  vec3 c = vAirCam / uPlanetRadius;
  vec3 d = hazeRayDir(ndc, uHazeRay, uHazeBasis);
  float t = hazeSphereHit(c, d, uAirLookupRadius > 0.0 ? uAirLookupRadius : uBottomRadius);
  if (t > 0.0) {
    AerialSegment sphere = aerialSegment(c, c + d * t, normalize(uSunDirWorld));
    if (sphere.valid) {
      vec3 s = aerialInscatter(uScattering, sphere, aerialTransmittance(uTransmittance, sphere));
      return uHazeProbe > 1.5 && uHazeProbe < 2.5 ? hazeHalf(s) : s;
    }
  }
  return aerialInscatter(uScattering, seg, airT);
}
#endif
` : '';
  const probeEntry = dev
    ? '#ifdef HAZE_PROBE\n  if (uHazeProbe > 0.5) return hazeProbeInscatter(seg, airT);\n  hazeReason = 1.0;\n#endif\n'
    : '';
  const reason = dev
    ? `#ifdef HAZE_PROBE
    hazeReason = !seg.hitsGround ? 2.0 : hazeGrazing(seg) >= uHazeExact.x ? 3.0 : hazeMieBand(seg) ? 4.0
        : cached.a <= 0.0 ? 5.0 : cached.a < 1.0 ? 6.0 : 7.0;
#endif
`
    : '';
  return `#ifdef HAZE_CACHE
uniform sampler2D uHazeSun;
uniform float uHazeOn;
uniform vec4 uHazeViewport;
uniform vec2 uHazeExact;
// The haze weight's own grazing measure, at the segment's end.
float hazeGrazing(AerialSegment seg) {
  vec3 up = normalize(seg.origin + seg.view * seg.d);
  return 1.0 - clamp(dot(up, -seg.view), 0.0, 1.0);
}
// The segment-entry Sun inside the single-Mie cut-off, widened by the margin.
bool hazeMieBand(AerialSegment seg) {
  return seg.muS >= -uHazeExact.y && seg.muS <= ${HAZE_MIE_CUT.toFixed(2)} + uHazeExact.y;
}
// Where the Sun's in-scatter is always evaluated exactly.
bool hazeExactOnly(AerialSegment seg) {
  return !seg.hitsGround || hazeGrazing(seg) >= uHazeExact.x || hazeMieBand(seg);
}
${probe}// The cache's share of this fragment's Sun in-scatter: 0 off or untrusted,
// 1 the cache alone. One call site of the exact lookup, so the program holds
// one copy of it.
vec3 hazeSunInscatter(AerialSegment seg, vec3 airT) {
${probeEntry}  vec4 cached = vec4(0.0);
  float a = 0.0;
  if (uHazeOn > 0.0) {
    vec2 uv = (gl_FragCoord.xy - uHazeViewport.xy) / uHazeViewport.zw;
    cached = textureLod(uHazeSun, uv, 0.0);
${reason}    a = hazeExactOnly(seg) ? 0.0 : cached.a;
  }
  if (a >= 1.0) return cached.rgb;
  vec3 exact = aerialInscatter(uScattering, seg, airT);
  return a > 0.0 ? mix(exact, cached.rgb, a) : exact;
}
#endif
`;
}

/** The reasons the development readout names, by the code the surface writes
 *  (`hazeReason`); 0 is a fragment with no air in front of it. */
export const HAZE_REASONS = ['no air', 'cache off', 'misses the ground', 'grazing', 'Mie cut-off', 'silhouette footprint', 'blend', 'cache'] as const;

const PASS_VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PASS_FRAGMENT = /* glsl */ `
${ATMOSPHERE_LOOKUP_GLSL}
${AERIAL_PERSPECTIVE_GLSL}
${HAZE_RAY_GLSL}
// The two tables this pass reads; the lookup text leaves their declarations
// to each consumer.
uniform sampler2D uTransmittance;
uniform sampler3D uScattering;
uniform vec3 uSunDirWorld;
uniform vec3 uHazeCam;
uniform float uHazeLayerRadius;
uniform vec4 uHazeRay;
uniform mat3 uHazeBasis;
uniform vec2 uHazeTexels;
uniform float uHazeFocal;

// Whether a ray from the camera reaches the ground sphere, from the geometry
// alone: ahead of the camera and passing closer to the centre than the ground.
bool hazeGroundRay(vec3 c, vec3 d) {
  float b = dot(c, d);
  vec3 perp = c - d * b;
  return b < 0.0 && dot(perp, perp) <= uBottomRadius * uBottomRadius;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uHazeTexels;
  vec2 ndc = uv * 2.0 - 1.0;
  vec2 texel = 2.0 / uHazeTexels;
  vec3 c = uHazeCam;
  bool trusted = true;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      trusted = trusted && hazeGroundRay(c, hazeRayDir(ndc + vec2(float(i), float(j)) * texel, uHazeRay, uHazeBasis));
    }
  }
  vec3 d = hazeRayDir(ndc, uHazeRay, uHazeBasis);
  float t = hazeSphereHit(c, d, uHazeLayerRadius);
  vec3 s = vec3(0.0);
  if (t > 0.0 && hazeGroundRay(c, d)) {
    AerialSegment seg = aerialSegment(c, c + d * t, normalize(uSunDirWorld));
    if (seg.valid) s = aerialInscatter(uScattering, seg, aerialTransmittance(uTransmittance, seg));
  }
  float alpha = 0.0;
  if (trusted) {
    vec3 toCentre = -normalize(c);
    float angle = atan(length(cross(d, toCentre)), dot(d, toCentre));
    float edge = asin(min(uBottomRadius / length(c), 1.0));
    alpha = clamp(((edge - angle) * uHazeFocal - 1.0) / 3.0, 0.0, 1.0);
  }
  gl_FragColor = vec4(s, alpha);
}
`;

/** One layer's surface-side uniforms, as the air block carries them. */
export interface HazeLayerUniforms {
  uHazeSun: THREE.IUniform;
  uHazeOn: THREE.IUniform;
}

/** The uniforms every surface's air block carries for the cache: the ground
 *  layer's under their GLSL names, the deck's under `…Deck` (the deck's
 *  material points the GLSL names at those), and the ones the two share. */
export function createHazeAirUniforms(dummy: THREE.Texture): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = {
    uHazeSun: { value: dummy },
    uHazeOn: { value: 0 },
    uHazeSunDeck: { value: dummy },
    uHazeOnDeck: { value: 0 },
    uHazeViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uHazeExact: { value: new THREE.Vector2(HAZE_EXACT_GRAZING, 0) },
  };
  if (import.meta.env.DEV) {
    u.uHazeProbe = { value: 0 };
    u.uHazeRay = { value: new THREE.Vector4(1, 1, 0, 0) };
    u.uHazeBasis = { value: new THREE.Matrix3() };
    u.uHazeDiag = hazeDiagUniform;
  }
  return u;
}

/** The development readout's switch, one object for every surface. */
export const hazeDiagUniform = { value: 0 };

/** What the cache is told about the body it serves, each frame. */
export interface HazeCacheSubject {
  /** The body's air block (world/surfaceShading SurfaceAirFx). */
  air: Record<string, THREE.IUniform>;
  /** The body's sun direction uniform, the one its surfaces read. */
  sunDirWorld: THREE.IUniform;
  globe: THREE.Object3D;
  /** The cloud deck, when one is drawn this frame. */
  deck: THREE.Object3D | null;
  /** The deck's radius in the tables' radius units (1 = the ground). */
  deckRadius: number;
}

export type HazeProbe = 'off' | 'endpoint-sphere' | 'endpoint-sphere-half' | 'endpoint-sphere-raw';

export interface HazeCacheState {
  compiled: boolean;
  /** Whether the development probes and the readout are compiled (`?hazeprobe=1`). */
  probeCompiled: boolean;
  on: boolean;
  probe: HazeProbe;
  divisor: number;
  grazing: number;
  marginScale: number;
  storage: '16f' | '32f';
  layers: 'ground' | 'both';
  size: [number, number] | null;
  viewport: [number, number] | null;
  drawn: { ground: boolean; deck: boolean };
  mieMargin: number;
  skipped: string | null;
  /** The body-centred camera in radius units, the Sun's direction and the lens, for a probe that rebuilds the
   *  frame's geometry on the CPU. */
  geometry: { camera: [number, number, number]; sun: [number, number, number]; radiusAU: number } | null;
}

const _camPos = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _layerPos = new THREE.Vector3();
/** The table uniforms the pass reads off the body's air block each frame. */
const LOOKUP_KEYS = Object.keys(atmosphereLookupUniforms());
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();

/**
 * The cache's GPU side: the pass material and the two layer targets, kept for
 * the session across composer rebuilds (a rebuild disposes its passes, never
 * this).
 */
export class HazeCache {
  private material: THREE.ShaderMaterial | null = null;
  private quad: FullScreenQuad | null = null;
  private targets: { ground: THREE.WebGLRenderTarget | null; deck: THREE.WebGLRenderTarget | null } = { ground: null, deck: null };
  private live: HazeCacheSubject | null = null;
  private state: HazeCacheState;
  private readonly basis = new THREE.Matrix3();
  private readonly ray = new THREE.Vector4();

  constructor(
    private readonly subject: () => HazeCacheSubject | null,
    private readonly viewport: () => { width: number; height: number },
    opts: { divisor: number; grazing: number; margin: number; f32: boolean },
  ) {
    this.state = {
      compiled: hazeCacheCompiled(),
      probeCompiled: hazeProbeCompiled(),
      on: false,
      probe: 'off',
      divisor: opts.divisor,
      grazing: opts.grazing,
      marginScale: opts.margin,
      storage: opts.f32 ? '32f' : '16f',
      layers: 'both',
      size: null,
      viewport: null,
      drawn: { ground: false, deck: false },
      mieMargin: 0,
      skipped: null,
      geometry: null,
    };
  }

  /** Development: move the knobs live; reads the state back. */
  devSet(opts: Partial<{ divisor: number; grazing: number; margin: number; probe: HazeProbe; layers: 'ground' | 'both' }>): HazeCacheState {
    if (import.meta.env.DEV) {
      if (opts.divisor !== undefined && Number.isInteger(opts.divisor) && opts.divisor >= 1 && opts.divisor <= 16) this.state.divisor = opts.divisor;
      if (opts.grazing !== undefined && opts.grazing > 0 && opts.grazing <= 1) this.state.grazing = opts.grazing;
      if (opts.margin !== undefined && opts.margin >= 0) this.state.marginScale = opts.margin;
      if (opts.probe !== undefined) this.state.probe = opts.probe;
      if (opts.layers !== undefined) this.state.layers = opts.layers;
    }
    return this.readout();
  }

  readout(): HazeCacheState {
    return { ...this.state, drawn: { ...this.state.drawn } };
  }

  private ensureMaterial(): THREE.ShaderMaterial {
    if (this.material) return this.material;
    const lookup = atmosphereLookupUniforms();
    const uniforms: Record<string, THREE.IUniform> = {
      ...lookup,
      uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
      uHazeCam: { value: new THREE.Vector3() },
      uHazeLayerRadius: { value: 1 },
      uHazeRay: { value: new THREE.Vector4() },
      uHazeBasis: { value: new THREE.Matrix3() },
      uHazeTexels: { value: new THREE.Vector2(1, 1) },
      uHazeFocal: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'HazeCache',
      uniforms,
      defines: atmosphereTableDefines(atmosphereSessionSizes()),
      vertexShader: PASS_VERTEX,
      fragmentShader: PASS_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
    return this.material;
  }

  private ensureTarget(layer: 'ground' | 'deck', w: number, h: number): THREE.WebGLRenderTarget {
    let target = this.targets[layer];
    const type = this.state.storage === '32f' ? THREE.FloatType : THREE.HalfFloatType;
    if (target && target.texture.type !== type) {
      target.dispose();
      target = null;
    }
    if (!target) {
      target = new THREE.WebGLRenderTarget(w, h, {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      target.texture.name = `HazeCache ${layer}`;
      this.targets[layer] = target;
    } else if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
    }
    return target;
  }

  /** Before the scene draw: the frame's geometry onto the subject's surfaces,
   *  the layers drawn, and only then the layers switched on. */
  begin(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.state.drawn.ground = false;
    this.state.drawn.deck = false;
    this.state.skipped = null;
    this.state.compiled = hazeCacheCompiled();
    const on = this.state.compiled && (import.meta.env.DEV ? perfSwitchOn('haze-cache') : true);
    this.state.on = on;
    this.live = null;
    if (!this.state.compiled) { this.state.skipped = 'not compiled'; return; }
    const subject = this.subject();
    if (!subject) { this.state.skipped = 'no body with live tables'; return; }
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) { this.state.skipped = 'not a perspective camera'; return; }
    const air = subject.air;
    const radiusAU = air.uPlanetRadius.value as number;
    if (!((air.uAirDensity.value as number) > 0) || !(radiusAU > 0)) { this.state.skipped = 'tables not live'; return; }

    // The matrices the scene draw is about to use, refreshed here because it
    // has not run yet: the camera's and the body's, from their own transforms.
    cam.updateWorldMatrix(true, false);
    subject.globe.updateWorldMatrix(true, false);
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    _bodyPos.setFromMatrixPosition(subject.globe.matrixWorld);
    _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
    _sphere.set(_bodyPos, radiusAU * Math.max(subject.deckRadius, 1) * 1.02);
    if (!subject.globe.visible || !_frustum.intersectsSphere(_sphere)) { this.state.skipped = 'body not in view'; return; }

    const { width: W, height: H } = this.viewport();
    const div = this.state.divisor;
    const cw = Math.max(1, Math.ceil(W / div));
    const ch = Math.max(1, Math.ceil(H / div));
    this.state.viewport = [W, H];
    this.state.size = [cw, ch];
    const p = cam.projectionMatrix.elements;
    this.ray.set(1 / p[0], 1 / p[5], p[8] / p[0], p[9] / p[5]);
    this.basis.setFromMatrix4(cam.matrixWorld);
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    this.state.mieMargin = this.state.marginScale * div * (vfov / H);

    (air.uHazeViewport.value as THREE.Vector4).set(0, 0, W, H);
    (air.uHazeExact.value as THREE.Vector2).set(this.state.grazing, this.state.mieMargin);
    if (import.meta.env.DEV) {
      (air.uHazeRay.value as THREE.Vector4).copy(this.ray);
      (air.uHazeBasis.value as THREE.Matrix3).copy(this.basis);
    }
    const sun = subject.sunDirWorld.value as THREE.Vector3;
    this.state.geometry = {
      camera: [(_camPos.x - _bodyPos.x) / radiusAU, (_camPos.y - _bodyPos.y) / radiusAU, (_camPos.z - _bodyPos.z) / radiusAU],
      sun: [sun.x, sun.y, sun.z],
      radiusAU,
    };
    this.live = subject;
    if (!on) { this.state.skipped = 'switched off'; return; }
    if (import.meta.env.DEV && this.state.probe !== 'off' && hazeProbeCompiled()) {
      air.uHazeProbe.value = { 'endpoint-sphere': 1, 'endpoint-sphere-half': 2, 'endpoint-sphere-raw': 3 }[this.state.probe];
      this.state.skipped = `probe ${this.state.probe}`;
      return;
    }

    const material = this.ensureMaterial();
    const u = material.uniforms;
    for (const key of LOOKUP_KEYS) u[key].value = air[key].value;
    (u.uSunDirWorld.value as THREE.Vector3).copy(sun);
    (u.uHazeRay.value as THREE.Vector4).copy(this.ray);
    (u.uHazeBasis.value as THREE.Matrix3).copy(this.basis);
    (u.uHazeTexels.value as THREE.Vector2).set(cw, ch);
    // The vertical focal length, in cache texels.
    u.uHazeFocal.value = (ch / 2) * p[5];

    const previous = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      const layers: Array<{ layer: 'ground' | 'deck'; mesh: THREE.Object3D; radius: number }> = [
        { layer: 'ground', mesh: subject.globe, radius: air.uBottomRadius.value as number },
      ];
      if (subject.deck && this.state.layers === 'both') {
        subject.deck.updateWorldMatrix(true, false);
        layers.push({ layer: 'deck', mesh: subject.deck, radius: subject.deckRadius });
      }
      for (const { layer, mesh, radius } of layers) {
        const target = this.ensureTarget(layer, cw, ch);
        // Each layer from its own mesh's centre, as its own vertex stage
        // derives `vAirCam`.
        const centre = layer === 'ground' ? _bodyPos : _layerPos.setFromMatrixPosition(mesh.matrixWorld);
        (u.uHazeCam.value as THREE.Vector3).set(
          (_camPos.x - centre.x) / radiusAU, (_camPos.y - centre.y) / radiusAU, (_camPos.z - centre.z) / radiusAU,
        );
        u.uHazeLayerRadius.value = radius;
        renderer.setRenderTarget(target);
        this.quad!.render(renderer);
        if (layer === 'ground') air.uHazeSun.value = target.texture;
        else air.uHazeSunDeck.value = target.texture;
        this.state.drawn[layer] = true;
      }
    } finally {
      renderer.setRenderTarget(previous);
      renderer.autoClear = oldAutoClear;
    }
    // Published only now that this frame's layers are drawn.
    air.uHazeOn.value = this.state.drawn.ground ? 1 : 0;
    air.uHazeOnDeck.value = this.state.drawn.deck ? 1 : 0;
  }

  /** After the scene draw: nothing outside it may read this frame's cache. */
  end(): void {
    const air = this.live?.air;
    if (!air) return;
    air.uHazeOn.value = 0;
    air.uHazeOnDeck.value = 0;
    if (import.meta.env.DEV) air.uHazeProbe.value = 0;
    this.live = null;
  }

  dispose(): void {
    this.targets.ground?.dispose();
    this.targets.deck?.dispose();
    this.targets = { ground: null, deck: null };
    this.quad?.dispose();
    this.material?.dispose();
    this.quad = null;
    this.material = null;
  }
}

/** The composer pass before the scene's RenderPass. Disposing it leaves the
 *  cache's targets alone: a composer rebuild disposes every pass. */
export class HazeCachePass extends Pass {
  constructor(private readonly cache: HazeCache, private readonly camera: THREE.Camera) {
    super();
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    this.cache.begin(renderer, this.camera);
  }
}

/** The composer pass right after the scene's RenderPass. */
export class HazeCacheEndPass extends Pass {
  constructor(private readonly cache: HazeCache) {
    super();
    this.needsSwap = false;
  }

  render(): void {
    this.cache.end();
  }
}
