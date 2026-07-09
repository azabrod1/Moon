/**
 * The volume-compare studio scene: a glass version of the container planet, a
 * warm key light, a dimmed starfield, and an instanced mesh of filler spheres —
 * everything under one group flipped visible on activate. Studio scale pins the
 * container's inner radius at 1.0 unit (the same scale the solver and the
 * spherePhysics mouth geometry use), so 1 filler ball is 1/across units across.
 *
 * The mode owns the camera, the OrbitControls, and the DOM; this owns the scene
 * content, the VC-owned textures, and their disposal. Nothing here reaches into
 * the Planetarium's state or its saves.
 *
 * Glass v1 is two shells sharing one program (BackSide then FrontSide): a
 * view-dependent alpha that stays near-clear face-on and dense at the rim, a
 * tight warm fresnel edge lobe, an opening discarded around +Y on both shells,
 * and — on the back wall only — the container's own colour map ghosted in and
 * lit by the key, so glass-Jupiter still reads as Jupiter. The ghost's gain is
 * normalized by the map's mean luminance so a dark-ocean Earth reads as
 * translucent as bright-banded Jupiter rather than a solid unlit ball.
 */
import * as THREE from 'three';
import {
  loadTexture,
  createMoonTextures,
  ATMOSPHERES,
  planetArchetype,
  moonArchetype,
  type AtmosphereConfig,
} from '../planetarium/PlanetFactory';
import { augmentSurfaceMaterial, type SurfaceArchetype } from '../planetarium/world/surfaceShading';
import { createPlanetariumStarfield } from '../planetarium/world/starfield';
import { captureDeviceTextureCaps } from '../planetarium/world/texturePolicy';
import { atmosphereVertexShader, atmosphereFragmentShader } from '../shared/shaders/atmosphere';
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planetarium/planets/planetData';
import { MOONS, type MoonData } from '../planetarium/planets/moonData';
import { mouthGeometry } from './spherePhysics';
import { mulberry32 } from './rng';
import { DEG2RAD } from '../shared/math/angles';
import type { Comparison } from './compareLogic';

// --- studio scale + framing ------------------------------------------------
// The container's inner radius is 1 unit; the glass shells sit exactly there.
const CONTAINER_R = 1.0;
// Camera framing (the mode applies these to the camera + its OrbitControls).
export const VC_FRAMING = {
  /** Start orbit: gentle 20° elevation. `distance` is the wide-screen default —
   *  the real per-aspect value comes from defaultOrbitDistance(). */
  elevationDeg: 20,
  distance: 4.2,
  /** Look slightly below the equator so the open mouth sits in the upper frame. */
  target: new THREE.Vector3(0, -0.15, 0),
  /** Orbit distance clamp — never inside the glass, never lost in the dark. */
  minDistance: 1.7,
  maxDistance: 8,
  dampingFactor: 0.05,
} as const;

/**
 * Default orbit distance for an aspect ratio. On wide screens the vessel takes
 * ~69% of the frame's height — showroom framing, air above and below. On
 * narrow (portrait) screens the horizontal FOV is the tight side, so fit ~95%
 * of that instead; without this the sphere overflows a phone frame and the
 * vessel silhouette is lost entirely.
 */
export function defaultOrbitDistance(aspect: number): number {
  const vHalf = 20 * DEG2RAD; // half of the camera's 40° vertical FOV
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.01));
  const fitHalf = Math.min(0.69 * vHalf, 0.95 * hHalf);
  return CONTAINER_R / Math.sin(fitHalf);
}

// --- lighting --------------------------------------------------------------
// One warm point light raked from upper-side-behind (¾ back) so it rims the
// glass into a bright crescent and back-lights the mouth. No ambient, no fill —
// the dark side comes from the fillers' own surface-shading night floor.
// Showroom key: upper-left, ~45° camera-side of the product. The glass rim is
// view-locked fresnel and needs no back-light, so the key's job is the
// CONTENTS — lit hemispheres on the pile facing the viewer, and a brighter
// far wall behind it for silhouette separation. Orbiting still reveals the
// direction: the lit shoulder travels, the far side falls off.
const KEY_LIGHT_DIR = new THREE.Vector3(-0.6, 0.5, 0.65).normalize();
const KEY_LIGHT_DISTANCE = 6;
const KEY_LIGHT_COLOR = 0xffe8c8;
const KEY_LIGHT_INTENSITY = 8;
const WARM_TINT = new THREE.Color(0xffe6c4); // warm-key white for the fresnel rim
// Night-side lift for the fillers, borrowed from the app's planetshine idiom:
// a faint cool-neutral fill from the camera side so unlit hemispheres read as
// dim worlds instead of holes. Mode-scoped — set on VC's material handle only.
const FILL_SHINE_COLOR = 0x9aa4b8;
const FILL_SHINE_DIR = new THREE.Vector3(0.4, 0.2, 1).normalize();
const FILL_SHINE_INTENSITY = 0.55;

// --- ghost tuning ----------------------------------------------------------
// The ghost map's brightness is normalized to this mean luminance so every
// container reads EQUALLY translucent — the whole point of the gain. A bright
// map (Jupiter ~0.62) must be pulled DOWN to the target just as a dark one
// (Earth ~0.25) is lifted up, so the floor sits below 1: only a near-black map
// hits it. The ceiling stops a black map from blowing out. The target is low so
// the surface only WHISPERS through the vessel (blended at the view-dependent
// alpha, the ghost is faint at the clear centre and densest toward the rim) —
// the caption must read "empty glass Jupiter", not "Jupiter at night".
const GHOST_TARGET_LUM = 0.38;
// Floor sits below the gain the brightest map needs (Moon at target 0.32 wants
// ~0.44) so every container normalizes to the target — bright Jupiter/Moon read
// as translucent as dark Earth. It only guards against a near-black map (gain -> 0).
const GHOST_GAIN_MIN = 0.3;
const GHOST_GAIN_MAX = 5.0;
// High-contrast maps defeat a mean-only gain: at equal MEAN, Earth's bright
// Antarctica/cloud decks punch through the vessel as glowing blobs while its
// oceans stay black. The knee clamps ghost texels at this multiple of the map's
// own mean (converted to the shader's linear space), so peaks flatten toward
// the body's overall translucency and the glass illusion survives every map.
const GHOST_KNEE_X_MEAN = 2.5;

// --- backdrop --------------------------------------------------------------
// The Planetarium starfield, dimmed so it reads as depth behind the glass, not
// as dirt seen through it — but not so dim that the clear centre of the vessel
// reads as a HOLE in space instead of glass with space behind it.
const STARFIELD_DIM = 0.45;

// While an in-mode pair swap loads, the scene dims to this fraction (the arrival
// veil is only for mode entry) so the swap reads as deliberate, not a flicker.
const LOADING_DIM = 0.4;

// --- atmosphere ghost ------------------------------------------------------
// Containers with an atmosphere get the app's own glow shell, faded to this
// fraction so it whispers "this is that planet" without competing with the glass.
const ATMOSPHERE_GHOST_ALPHA = 0.3;

// --- instanced fillers -----------------------------------------------------
const INSTANCE_CAPACITY = 4000;
const FILLER_SEGMENTS_W = 16;
const FILLER_SEGMENTS_H = 10;
// devScatter keeps every ball this far inside the shell (|p| + r ≤ this) so no
// filler ever pokes through the glass in the transparency QA.
const SCATTER_INSET = 0.97;
const SCATTER_SEED = 0x5eed; // fixed so the QA layout is reproducible

const PLANET_BY_NAME = new Map<string, PlanetData>(PLANETARIUM_BODIES.map((p) => [p.name, p]));
const MOON_BY_NAME = new Map<string, MoonData>(MOONS.map((m) => [m.name, m]));

/** Catalog colour for a body's tint (Sun is absent from the catalogs). */
function bodyColor(name: string): number {
  if (name === 'Sun') return SUN_DATA.color;
  return PLANET_BY_NAME.get(name)?.color ?? MOON_BY_NAME.get(name)?.color ?? 0x888888;
}

/** Surface archetype for the filler's night-fill + limb darkening — the same
 *  classification the Planetarium uses. Sun is handled separately. */
function fillerArchetype(name: string): SurfaceArchetype {
  const planet = PLANET_BY_NAME.get(name);
  if (planet) return planetArchetype(planet);
  const moon = MOON_BY_NAME.get(name);
  if (moon) return moonArchetype(moon);
  return 'airless';
}

// --- glass shader ----------------------------------------------------------
const GLASS_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec2 vUv;
void main() {
  vUv = uv;
  vObjPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLASS_FRAGMENT = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uWarmTint;
uniform vec3 uCatalogTint;
uniform sampler2D uGhostMap;
uniform float uHasGhost;
uniform float uGhostGain;
uniform float uMouthPlaneY; // the opening's plane height on the unit sphere (2 = no mouth)
uniform float uGhostKnee;   // ghost texel ceiling (linear) — flattens bright peaks
uniform float uBackShell;   // 1 for the far shell (lit ghost), 0 for the near shell
uniform float uDim;         // 1 normally, < 1 while an in-mode pair swap loads
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec2 vUv;

void main() {
  // The mouth: a real opening around +Y, cut on both shells so balls never
  // pour through intact glass — feathered over a short band so the cut reads
  // as a made opening, not a texture seam.
  vec3 dir = normalize(vObjPos);
  float mouthEdge = 1.0 - smoothstep(uMouthPlaneY - 0.05, uMouthPlaneY, dir.y);
  if (mouthEdge <= 0.0) discard;

  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(uCam - vWorldPos);
  float ndv = abs(dot(N, V));

  // View-dependent alpha: clearest face-on, dense at the rim (constant alpha
  // reads as a frosted billiard ball and double-darkens where the shells
  // cross). The floor stays visibly above zero — a fully-clear centre reveals
  // raw void and the vessel reads as a hole instead of glass.
  float alpha = mix(0.14, 0.9, pow(1.0 - ndv, 2.5));

  // Tight warm fresnel edge lobe, blended with a faint catalog-colour rim.
  float edge = pow(1.0 - ndv, 5.0);
  vec3 col = mix(uWarmTint, uCatalogTint, 0.35) * edge;

  // Ghosted back wall: the far shell shows the container's surface faintly.
  // The key modulates the shell so orbiting reveals a light DIRECTION (lit
  // shoulder, falloff, dark side) — but the floor keeps the texture present on
  // the dark half, so no day/night terminator ever reads on the glass. The
  // knee clamps bright texels (icecaps, cloud decks) that would otherwise
  // punch through the vessel as solid glowing patches. A cheap limb factor
  // keeps it a surface, not a decal.
  if (uBackShell > 0.5 && uHasGhost > 0.5) {
    float shell = 0.6 + 0.4 * max(dot(N, uSunDir), 0.0);
    float limb = pow(ndv, 0.4);
    vec3 ghost = min(texture2D(uGhostMap, vUv).rgb, vec3(uGhostKnee));
    col += ghost * uGhostGain * limb * shell;
  } else if (uBackShell > 0.5) {
    // A ghost-less container (the Sun) would otherwise be a void behind glass:
    // give the vessel an ember interior instead — its own colour pulled toward
    // deep fire, amplitude sized against the low face-on alpha it blends under.
    vec3 emberTint = mix(uCatalogTint, vec3(1.0, 0.45, 0.15), 0.6);
    col += emberTint * (0.3 + 0.5 * (1.0 - ndv));
  }

  gl_FragColor = vec4(col * uDim, alpha * mouthEdge);
}
`;

interface GhostLoad {
  tex: THREE.Texture;
  gain: number;
  meanLum: number;
}

interface GlassUniforms {
  uCam: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
  uWarmTint: { value: THREE.Color };
  uCatalogTint: { value: THREE.Color };
  uGhostMap: { value: THREE.Texture | null };
  uHasGhost: { value: number };
  uGhostGain: { value: number };
  uGhostKnee: { value: number };
  uMouthPlaneY: { value: number };
  uDim: { value: number };
}

export class CompareScene {
  readonly group: THREE.Group;
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private capsCaptured = false;

  private keyLight: THREE.PointLight;
  private starfield: THREE.Points;

  // Glass: two shells over one shared uniform block.
  private glassUniforms: GlassUniforms;
  private backShell: THREE.Mesh;
  private frontShell: THREE.Mesh;
  private glassGeo: THREE.SphereGeometry;
  private backMat: THREE.ShaderMaterial;
  private frontMat: THREE.ShaderMaterial;

  // Instanced fillers.
  private fillerGeo: THREE.SphereGeometry;
  private fillerMesh: THREE.InstancedMesh;
  private fillerMap: THREE.Texture | null = null;
  private ballRadius = 0.1;
  // The live mouth plane (2 = vessel whole); the atmosphere shell's cut follows it.
  private mouthPlaneY = 2;

  // Held, VC-owned textures for the current pair (disposed on swap + dispose()).
  private ghostTex: THREE.Texture | null = null;
  private emptyTex: THREE.Texture; // 1×1 default so the ghost sampler is always bound
  private atmosphere: THREE.Mesh | null = null;

  // Scratch for scatter (no per-call allocation).
  private scratchMatrix = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchQuat = new THREE.Quaternion();
  private scratchScale = new THREE.Vector3();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'VolumeCompareRoot';
    this.group.visible = false;

    // Key light — inside the group so it can never leak into the other modes.
    this.keyLight = new THREE.PointLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY, 0, 0.5);
    this.keyLight.position.copy(KEY_LIGHT_DIR).multiplyScalar(KEY_LIGHT_DISTANCE);
    this.group.add(this.keyLight);

    // Dimmed starfield backdrop (VC owns this instance; scaling the colour buffer
    // dims it without touching the shared factory).
    this.starfield = createPlanetariumStarfield();
    dimStarfield(this.starfield, STARFIELD_DIM);
    this.group.add(this.starfield);

    // 1×1 default texture so the ghost sampler is always bound (Sun has no map).
    this.emptyTex = makeEmptyTexture();

    // Glass shells — shared uniform block; only uBackShell differs per material.
    this.glassUniforms = {
      uCam: { value: new THREE.Vector3() },
      uSunDir: { value: KEY_LIGHT_DIR.clone() },
      uWarmTint: { value: WARM_TINT.clone() },
      uCatalogTint: { value: new THREE.Color(0xffffff) },
      uGhostMap: { value: this.emptyTex },
      uHasGhost: { value: 0 },
      uGhostGain: { value: 1 },
      uGhostKnee: { value: 1 },
      uMouthPlaneY: { value: 0.93 },
      uDim: { value: 1 },
    };
    this.glassGeo = new THREE.SphereGeometry(CONTAINER_R, 64, 32);
    this.backMat = this.makeGlassMaterial(THREE.BackSide, 1);
    this.frontMat = this.makeGlassMaterial(THREE.FrontSide, 0);
    this.backShell = new THREE.Mesh(this.glassGeo, this.backMat);
    this.backShell.renderOrder = 1;
    this.frontShell = new THREE.Mesh(this.glassGeo, this.frontMat);
    this.frontShell.renderOrder = 3;
    this.group.add(this.backShell, this.frontShell);

    // Instanced fillers — capacity fixed, all matrices zero-scale so unwritten
    // slots never render an identity ball at the origin.
    this.fillerGeo = new THREE.SphereGeometry(1, FILLER_SEGMENTS_W, FILLER_SEGMENTS_H);
    const placeholder = this.makeFillerMaterial('Earth'); // replaced on first pair
    this.fillerMesh = new THREE.InstancedMesh(this.fillerGeo, placeholder, INSTANCE_CAPACITY);
    this.fillerMesh.count = 0;
    this.fillerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fillerMesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < INSTANCE_CAPACITY; i++) this.fillerMesh.setMatrixAt(i, zero);
    this.fillerMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.fillerMesh);

    this.scene.add(this.group);
  }

  private makeGlassMaterial(side: THREE.Side, backShell: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      // Share the uniform-value wrappers so one update feeds both shells; only
      // uBackShell is per-material. Identical GLSL keeps one compiled program.
      uniforms: { ...this.glassUniforms, uBackShell: { value: backShell } },
      vertexShader: GLASS_VERTEX,
      fragmentShader: GLASS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side,
    });
  }

  private makeFillerMaterial(filler: string): THREE.MeshStandardMaterial {
    if (filler === 'Sun') {
      // A textureless hot body — never the map-less standard material (which
      // would render black). P4 does the Sun-as-filler properly.
      return new THREE.MeshStandardMaterial({
        color: 0xff8a3a,
        emissive: new THREE.Color(0xff7a26),
        emissiveIntensity: 1.6,
        roughness: 1,
        metalness: 0,
      });
    }
    const mat = new THREE.MeshStandardMaterial({
      map: this.fillerMap ?? this.emptyTex,
      roughness: 0.95,
      metalness: 0,
    });
    const fx = augmentSurfaceMaterial(mat, fillerArchetype(filler));
    fx.uSunDirWorld.value.copy(KEY_LIGHT_DIR); // the one key light is the fillers' sun
    // The app's planetshine channel doubles as the studio fill: a faint
    // cool-neutral lift from the camera side so unlit hemispheres read as dim
    // worlds instead of holes in the pile. Mode-scoped — only VC's material.
    fx.uPlanetshineColor.value.setHex(FILL_SHINE_COLOR);
    fx.uPlanetshineDir.value.copy(FILL_SHINE_DIR);
    fx.uPlanetshineIntensity.value = FILL_SHINE_INTENSITY;
    return mat;
  }

  /**
   * Load one body's colour texture (VC-owned; caller disposes). Sun resolves to
   * null (rendered textureless). Photo bodies stream their real map; procedural
   * moons synthesize theirs mesh-free.
   */
  private async loadBodyColor(name: string): Promise<THREE.Texture | null> {
    if (name === 'Sun') return null;
    const planet = PLANET_BY_NAME.get(name);
    if (planet) return loadTexture(planet.textureKey);
    const moon = MOON_BY_NAME.get(name);
    if (moon?.textureKey) return loadTexture(moon.textureKey);
    if (moon) {
      const { colorTex, bumpTex } = createMoonTextures(moon.color, moon.name, moon.radiusKm);
      bumpTex.dispose(); // the glass ghost + filler map want colour only
      return colorTex;
    }
    return null;
  }

  private async loadGhost(name: string): Promise<GhostLoad | null> {
    const tex = await this.loadBodyColor(name);
    if (!tex) return null;
    const meanLum = meanLuminance(tex.image as CanvasImageSource | null);
    const gain = THREE.MathUtils.clamp(
      GHOST_TARGET_LUM / Math.max(meanLum, 0.05),
      GHOST_GAIN_MIN,
      GHOST_GAIN_MAX,
    );
    return { tex, gain, meanLum };
  }

  /** Measured mean luminance of the current ghost map (0 = no ghost); for the log. */
  private lastGhostMeanLum = 0;
  getGhostMeanLum(): number {
    return this.lastGhostMeanLum;
  }

  /**
   * Load and apply a new pair's textures. Generation-guarded: the mode passes a
   * staleness check that is consulted after the async load — a stale resolve
   * disposes what it loaded and leaves the live scene untouched. On a fresh
   * resolve, new textures are assigned before the outgoing pair's are disposed,
   * so no frame ever samples freed memory.
   */
  async applyPair(comparison: Comparison, container: string, filler: string, isStale: () => boolean): Promise<void> {
    if (!this.capsCaptured) {
      captureDeviceTextureCaps(this.renderer);
      this.capsCaptured = true;
    }
    const [ghost, fillerTex] = await Promise.all([
      container === 'Sun' ? Promise.resolve(null) : this.loadGhost(container),
      filler === 'Sun' ? Promise.resolve(null) : this.loadBodyColor(filler),
    ]);
    if (isStale()) {
      ghost?.tex.dispose();
      fillerTex?.dispose();
      return;
    }
    this.applyGhost(container, ghost);
    this.applyFiller(filler, fillerTex);
    this.applyMouth(comparison);
    this.applyAtmosphere(container);
  }

  private applyGhost(container: string, ghost: GhostLoad | null): void {
    // Assign new before disposing old.
    const prev = this.ghostTex;
    if (ghost) {
      this.glassUniforms.uGhostMap.value = ghost.tex;
      this.glassUniforms.uHasGhost.value = 1;
      this.glassUniforms.uGhostGain.value = ghost.gain;
      // The knee lives in the shader's linear space; the mean is measured on
      // sRGB-encoded pixels, so convert the ceiling through the ~2.2 curve.
      this.glassUniforms.uGhostKnee.value =
        Math.pow(Math.min(GHOST_KNEE_X_MEAN * ghost.meanLum, 1), 2.2);
      this.ghostTex = ghost.tex;
      this.lastGhostMeanLum = ghost.meanLum;
    } else {
      // Sun (or a body with no map): warm-tinted glass, no ghost.
      this.glassUniforms.uGhostMap.value = this.emptyTex;
      this.glassUniforms.uHasGhost.value = 0;
      this.ghostTex = null;
      this.lastGhostMeanLum = 0;
    }
    this.glassUniforms.uCatalogTint.value.setHex(bodyColor(container));
    if (prev) prev.dispose();
  }

  private applyFiller(filler: string, fillerTex: THREE.Texture | null): void {
    const prevMat = this.fillerMesh.material as THREE.MeshStandardMaterial;
    const prevMap = this.fillerMap;
    this.fillerMap = fillerTex;
    // Build the new material while the old one still holds the shared program
    // alive, so the swap never frees + recompiles it.
    const mat = this.makeFillerMaterial(filler);
    this.fillerMesh.material = mat;
    // A pair change resets the pour — clear any scattered fillers.
    this.fillerMesh.count = 0;
    prevMat.dispose();
    if (prevMap) prevMap.dispose();
  }

  private applyMouth(comparison: Comparison): void {
    // The ball radius (and therefore the mouth) come from the live comparison,
    // via the same spherePhysics geometry the solver uses — never re-derived.
    this.ballRadius = 1 / comparison.across;
    // Boulders never pour through a hole (they melt down from the glass top)
    // and a sub-unity filler could pass no opening — for both, the vessel stays
    // whole. A cut that nothing can use reads as a rendering bug.
    if (comparison.regime === 'boulders' || comparison.subUnity) {
      this.mouthPlaneY = 2; // above the pole — the discard band never triggers
    } else {
      this.mouthPlaneY = mouthGeometry(this.ballRadius, CONTAINER_R).mouthPlaneY;
    }
    this.glassUniforms.uMouthPlaneY.value = this.mouthPlaneY;
  }

  private applyAtmosphere(container: string): void {
    if (this.atmosphere) {
      this.group.remove(this.atmosphere);
      this.atmosphere.geometry.dispose();
      (this.atmosphere.material as THREE.Material).dispose();
      this.atmosphere = null;
    }
    const params = ATMOSPHERES[container];
    if (!params) return; // airless bodies (and Sun) get no ghost shell
    this.atmosphere = makeAtmosphereGhost(params, this.mouthPlaneY);
    this.group.add(this.atmosphere);
  }

  /**
   * Scatter `n` static fillers inside the glass — a deterministic settled pile
   * for the transparency QA and the CP2 montage (P3's real pour replaces this).
   * Every ball is strictly inside the shell and packed toward the lower
   * hemisphere. `n = 0` clears.
   */
  scatter(n: number): void {
    const r = this.ballRadius;
    const count = Math.max(0, Math.min(Math.floor(n), INSTANCE_CAPACITY));
    const reach = SCATTER_INSET - r;
    if (count === 0 || reach <= 0) {
      // A filler bigger than the glass (sub-unity pairs) can't sit inside — clear.
      this.fillerMesh.count = 0;
      this.fillerMesh.instanceMatrix.needsUpdate = true;
      return;
    }
    const rng = mulberry32(SCATTER_SEED);
    let placed = 0;
    for (let i = 0; i < count; i++) {
      // Vertical: quadratic bias toward the bottom (a settled pile), still inside.
      const t = rng();
      const y = -reach + reach * 1.3 * t * t;
      const maxXZ = Math.sqrt(Math.max(0, reach * reach - y * y));
      const a = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * maxXZ; // uniform in the disc
      this.scratchPos.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      randomQuat(this.scratchQuat, rng);
      this.scratchScale.setScalar(r);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.fillerMesh.setMatrixAt(placed++, this.scratchMatrix);
    }
    this.fillerMesh.count = placed;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
  }

  /** Per-frame: feed the camera position into the glass shells. */
  update(cameraWorldPos: THREE.Vector3): void {
    this.glassUniforms.uCam.value.copy(cameraWorldPos);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Dim the whole scene during an in-mode pair swap (key light + glass). */
  setDimmed(dim: boolean): void {
    this.keyLight.intensity = dim ? KEY_LIGHT_INTENSITY * LOADING_DIM : KEY_LIGHT_INTENSITY;
    this.glassUniforms.uDim.value = dim ? LOADING_DIM : 1;
  }

  dispose(): void {
    this.group.visible = false;
    this.scene.remove(this.group);

    this.glassGeo.dispose();
    this.backMat.dispose();
    this.frontMat.dispose();

    this.fillerGeo.dispose();
    (this.fillerMesh.material as THREE.Material).dispose();
    this.fillerMesh.dispose();
    this.fillerMap?.dispose();
    this.fillerMap = null;

    if (this.atmosphere) {
      this.atmosphere.geometry.dispose();
      (this.atmosphere.material as THREE.Material).dispose();
      this.atmosphere = null;
    }

    this.starfield.geometry.dispose();
    (this.starfield.material as THREE.Material).dispose();

    this.ghostTex?.dispose();
    this.ghostTex = null;
    this.emptyTex.dispose();
  }
}

// --- module helpers --------------------------------------------------------

/** Dim VC's own starfield instance by scaling its per-vertex colour buffer. */
function dimStarfield(stars: THREE.Points, dim: number): void {
  const color = stars.geometry.getAttribute('color') as THREE.BufferAttribute;
  const arr = color.array as Float32Array;
  for (let i = 0; i < arr.length; i++) arr[i] *= dim;
  color.needsUpdate = true;
}

function makeEmptyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Mean Rec.709 luminance of an image, sampled at 32×32. 0 if unreadable. */
function meanLuminance(image: CanvasImageSource | null): number {
  if (!image) return 0;
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  try {
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    }
    return sum / (size * size);
  } catch {
    return 0; // tainted canvas (shouldn't happen same-origin) — skip normalization
  }
}

/** Uniform-random unit quaternion (Shoemake) into `out`. */
function randomQuat(out: THREE.Quaternion, rng: () => number): void {
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  out.set(
    s1 * Math.sin(2 * Math.PI * u2),
    s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3),
    s2 * Math.cos(2 * Math.PI * u3),
  );
}

/** The app's atmosphere glow shell, dimmed for the ghost, keyed to the studio light. */
function makeAtmosphereGhost(config: AtmosphereConfig, mouthPlaneY: number): THREE.Mesh {
  // The shell shares the glass's opening: uncut, the halo arcs over the hole
  // and reads as glass where there is none. The cone angle matches the unit-
  // sphere mouth plane, with a hair of margin so the shell edge stays tucked
  // behind the glass's feathered cut.
  const thetaStart = mouthPlaneY >= 1 ? 0 : Math.acos(mouthPlaneY) + 0.02;
  const geo = new THREE.SphereGeometry(
    CONTAINER_R * config.scale, 64, 32, 0, Math.PI * 2, thetaStart, Math.PI - thetaStart,
  );
  const mat = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uSunDirWorld: { value: KEY_LIGHT_DIR.clone() },
      alphaScale: { value: ATMOSPHERE_GHOST_ALPHA }, // the ghost's fixed presence
      uDayColor: { value: new THREE.Vector3(...config.dayColor) },
      uSunsetColor: { value: new THREE.Vector3(...config.sunsetColor) },
      uMieColor: { value: new THREE.Vector3(...config.mieColor) },
      uRayleighStrength: { value: config.rayleighStrength },
      uMieStrength: { value: config.mieStrength },
      uMieG: { value: config.mieG },
      uPower: { value: config.power },
      uIntensity: { value: config.intensity },
      uHaloStrength: { value: config.haloStrength },
      uPlanetRadius: { value: CONTAINER_R },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4; // over the front shell, so the halo adds on top of the rim
  return mesh;
}
