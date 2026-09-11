/**
 * The Look-inside studio scene: one body at unit radius, opened by the cut
 * frame. A skin wearing the body's own colour map (borrowed through the same
 * loader the compare studio uses, owned and disposed here), lit section
 * faces, a studio key and fill, and a dimmed starfield — everything under
 * one group flipped visible on activate.
 *
 * The cut is terraced: each region inward is cut a little narrower than the
 * one above it (TERRACE_STEP of the opening angle per region), so a wedge
 * shows the mantle's outer surface as a step around the core, the way a
 * cutaway illustration does. Per region there is a shell (its outer sphere,
 * discarded inside its own wedge, dressed in the region's look) and a pair
 * of half-disc faces at its own angle; the crust's shell is the textured
 * skin itself. An outer region's face runs to the centre, and its inner
 * part is hidden inside the next region's solid, so depth does the
 * terracing — nothing is stitched. The body wears
 * its real pose (IAU pole and spin for planets, the tidal lock for moons)
 * at the planetarium's instant; the light is a studio key that rides with
 * the camera so the section faces are always lit from a three-quarter,
 * whatever the orbit. Studio light with real pose, per plan §5.
 *
 * The mode owns the camera, the OrbitControls, the DOM and the presentation
 * clock; this owns the scene content and its GPU resources. Nothing here
 * reaches into the Planetarium's state.
 *
 * Texture ownership is explicit: loadBody resolves the map, checks the
 * caller's staleness guard, swaps the new material in, and only then
 * disposes the old one, so no frame samples freed memory. Anisotropy, tier
 * caps and the memory profile are captured once per session by whichever
 * tool opens first (the compare studio's rule).
 */
import * as THREE from 'three';
import {
  loadTexture,
  createLateTextureSlot,
  createMoonTextures,
  planetArchetype,
  moonArchetype,
  createAtmosphereMaterial,
  ATMOSPHERES,
  type LateTextureSlot,
} from '../planetarium/PlanetFactory';
import { RING_CONFIGS, createPlanetRings, type RingShadingFx } from '../planetarium/planets/rings';
import { augmentSurfaceMaterial, type SurfaceShadingFx, type SurfaceArchetype } from '../planetarium/world/surfaceShading';
import { createPlanetariumStarfield, setStarfieldPixelRatio } from '../planetarium/world/starfield';
import { applyLensShaderUniforms, type LensShaderUniforms } from '../shared/three/lensShader';
import { captureDeviceCaps } from '../planetarium/world/texturePolicy';
import { profileForDevice, readDeviceSignals } from '../planetarium/world/gpuEnvelope';
import type { PlanetData } from '../planetarium/planets/planetData';
import type { InteriorBody } from './interiorBody';
import { computeBodyOrientationQuaternion, ttJDFromUtcMs } from '../astronomy/planetary';
import { computeMoonOffsetEquatorialAU } from '../astronomy/satellites';
import { tidalLockQuaternion, tidalRollNorth } from '../planetarium/world/tidalLock';
import { applyAtmosphereCut, applyPhotosphereCut, applySkinCut, configureSkinCutEdge, createSkinCutUniforms, type SkinCutUniforms } from './rendering/skinCut';
import { SUN_ATMOSPHERE_TINT_RGB, sunPhotosphereFragmentShader, sunPhotosphereVertexShader } from '../shared/shaders/sun';
import { SUN_POLE_DEC_DEG, SUN_POLE_RA_DEG } from '../planetarium/planets/planetData';
import type { AtmosphereConfig } from '../planetarium/PlanetFactory';
import { applySkinFade, createSkinFadeUniforms, idleFadeTexture, type SkinFadeUniforms } from './rendering/skinFade';
import {
  createSectionMaterial,
  createSectionUniforms,
  writeSectionRegions,
  writeTemperatureScale,
  type SectionRegionLook,
  type SectionUniforms,
} from './rendering/sectionMaterial';
import type { TemperatureRange } from './temperatureScale';
import { createCutFaceBasis, createCutFrame, cutFaceBasis, terraceOpeningAngle, type CutFrame } from './cutFrame';
import { MAX_REGIONS } from './rendering/sectionMaterial';

/** The body's radius in studio units; every framing number is relative to it. */
export const BODY_RADIUS = 1;
/** Each region inward opens this fraction of the angle less than the one above. */
export const TERRACE_STEP = 0.2;

// --- lighting --------------------------------------------------------------
// The compare studio's key, but camera-relative: expressed in the camera's
// basis (right, up, back) so the section faces are lit from the upper left
// of whatever the viewer is looking from. A world-fixed key would put the
// faces in the dark on the far side of an orbit, and the faces are the
// product here.
const KEY_LIGHT_CAMERA_DIR = new THREE.Vector3(-0.6, 0.5, 0.65).normalize();
const KEY_LIGHT_DISTANCE = 6;
const KEY_LIGHT_COLOR = 0xffe8c8;
const KEY_LIGHT_INTENSITY = 4.5;
const FILL_SKY_COLOR = 0xaeb6c6;
const FILL_GROUND_COLOR = 0x2a2622;
const FILL_HEMI_INTENSITY = 2.0;
// The skin's night side takes the planetshine channel as a faint studio
// fill, the compare fillers' idiom, so the unlit limb reads as a dim world.
const FILL_SHINE_COLOR = 0x9aa4b8;
const FILL_SHINE_DIR = new THREE.Vector3(0.4, 0.2, 1).normalize();
const FILL_SHINE_INTENSITY = 1.2;
const STARFIELD_DIM = 0.45;
// The studio the section faces reflect: a black stage with one large warm
// softbox upper-left of the viewer and a small cool panel low on the right,
// prefiltered once per session and turned with the camera each frame so the
// sheen sits where the key does. A liquid-iron core or a metallic-hydrogen
// layer reads as metal only with something structured to mirror — a grey
// room gives a dull blur and a flat diffuse wash that hides the key's
// direction. Without float targets the environment cannot be prefiltered
// and the faces fall back to a matte look (lustre off).
const FACE_ENV_INTENSITY = 1.0;
// The softbox sits high: a face square to the camera mirrors what is behind
// the viewer, and a bright panel there is a flat blast with a bloom halo,
// not a sheen. High and to the left, the roughness lobe catches its edge
// and the reflection is a gradient across the face, which is the sheen.
const STUDIO_SOFTBOX_COLOR = new THREE.Color(1.0, 0.93, 0.82).multiplyScalar(1.1);
const STUDIO_RIM_COLOR = new THREE.Color(0.55, 0.68, 1.0).multiplyScalar(0.8);
const STUDIO_FLOOR_COLOR = new THREE.Color(0.15, 0.14, 0.12);
/** The analytic air shell's presence in the studio (the planetarium's distance fade, held near). */
const ATMOSPHERE_ALPHA = 0.7;
/** The studio key's angular radius as the ring shadow's penumbra: a soft edge, not a point. */
const RING_SUN_TAN = 0.004;
/** The Sun's pole (IAU) and its sidereal spin (IAU 2009: W = 84.176° + 14.1844°/day), as the
 *  orientation code reads a planet record. */
const SUN_ORIENTATION = {
  poleRaDeg: SUN_POLE_RA_DEG,
  poleDecDeg: SUN_POLE_DEC_DEG,
  primeMeridianDegAtJ2000: 84.176,
  primeMeridianRateDegPerDay: 14.1844,
} as PlanetData;
/** The corona as exterior glow: the analytic shell in the Sun's colours, lit from the camera so
 *  the fringe is even all round. Art, keyed like the planets' air. */
const SUN_CORONA: AtmosphereConfig = {
  dayColor: [1.0, 0.86, 0.62],
  sunsetColor: [1.0, 0.62, 0.3],
  mieColor: [1.0, 0.92, 0.75],
  rayleighStrength: 1.6,
  mieStrength: 0,
  mieG: 0.5,
  power: 1.2,
  intensity: 1.0,
  haloStrength: 0.8,
  scale: 1.3,
};
/** The photosphere's HDR radiance (3.8 in the planetarium, where it is the light) scaled to
 *  sit beside a section face without whiting the studio out. Art, documented. */
const SUN_STUDIO_EXPOSURE = 0.5;

function buildStudioEnvironment(): THREE.Scene {
  const studio = new THREE.Scene();
  const panel = (width: number, height: number, color: THREE.Color, position: THREE.Vector3) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.copy(position);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  };
  panel(7, 5, STUDIO_SOFTBOX_COLOR, new THREE.Vector3(-3, 5.5, 3));
  panel(3, 6, STUDIO_RIM_COLOR, new THREE.Vector3(6, -1.5, -3));
  panel(24, 24, STUDIO_FLOOR_COLOR, new THREE.Vector3(0, -7, 0));
  return studio;
}

/** A body's skin, loaded and built but not yet on the mesh. The Sun has no map and no late slot. */
export interface PreparedSkin {
  body: InteriorBody;
  material: THREE.Material;
  texture: THREE.Texture | null;
  late: LateTextureSlot | null;
}

const tmpOffset = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpRollNorth = new THREE.Vector3();
const tmpBasis = new THREE.Matrix4();
const tmpFace = createCutFaceBasis();
const tmpTerraceFrame = createCutFrame();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpBack = new THREE.Vector3();
const tmpEnvQuaternion = new THREE.Quaternion();

export class InteriorScene {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly group: THREE.Group;
  private readonly keyLight: THREE.PointLight;
  private readonly starfield: THREE.Points;
  private readonly skinGeometry: THREE.SphereGeometry;
  private readonly skinMesh: THREE.Mesh;
  private skinMaterial: THREE.Material | null = null;
  /** The photosphere while the Sun is the body: its clock is the presentation clock. */
  private sunMaterial: THREE.ShaderMaterial | null = null;
  private skinFx: SurfaceShadingFx | null = null;
  private skinTexture: THREE.Texture | null = null;
  private readonly cutUniforms: SkinCutUniforms;
  /** The body swap's cross-fade: the outgoing map, blended out in the incoming skin's shader. */
  private readonly fadeUniforms: SkinFadeUniforms;
  private fadeSeconds = 0;
  private fadeElapsedS = 0;
  private fadeOutgoing: THREE.Texture | null = null;
  private fadeResolvers: (() => void)[] = [];
  /** The reveal's exterior ghost: the removed wedge of the skin, translucent, fading as the cut opens. */
  private readonly ghostMesh: THREE.Mesh;
  private ghostMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly ghostCut: SkinCutUniforms;
  /** 0 stills every pattern (prefers-reduced-motion). */
  private motionScale = 1;
  /** The air, cut by the same frame, for bodies that carry a shell; the rings, whole, as context. */
  private readonly atmosphereMesh: THREE.Mesh;
  private atmosphereMaterial: THREE.ShaderMaterial | null = null;
  private ringMesh: THREE.Mesh | null = null;
  private ringFx: RingShadingFx | null = null;
  private ringsWanted = true;
  private readonly poseQuaternion = new THREE.Quaternion();
  private readonly ringSunLocal = new THREE.Vector3();
  private readonly sectionUniforms: SectionUniforms;
  private readonly faceGeometry: THREE.CircleGeometry;
  private readonly faceMaterial: THREE.MeshStandardMaterial;
  /** Face pairs per region, inside-out; [count-1] is the crust's, at the full angle. */
  private readonly regionFaces: { a: THREE.Mesh; b: THREE.Mesh }[] = [];
  private readonly shellGeometry: THREE.SphereGeometry;
  /** Terrace shells per region, inside-out; the crust has none (the skin is its shell). */
  private readonly regionShells: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; cut: SkinCutUniforms; region: { value: number } }[] = [];
  private regionCount = 1;
  private readonly keyDirection = new THREE.Vector3(0, 0, 1);
  private readonly worldToBody = new THREE.Matrix3();
  private capsCaptured = false;
  private multisampled = true;
  private readonly floatCapable: boolean;
  private environment: THREE.Texture | null = null;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, floatCapable: boolean) {
    this.scene = scene;
    this.renderer = renderer;
    this.floatCapable = floatCapable;
    this.group = new THREE.Group();
    this.group.name = 'InteriorRoot';
    this.group.visible = false;

    // Lights live inside the group so they can never leak into another mode.
    this.keyLight = new THREE.PointLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY, 0, 0.5);
    this.keyLight.position.set(0, 0, KEY_LIGHT_DISTANCE);
    this.group.add(this.keyLight);
    this.group.add(new THREE.HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, FILL_HEMI_INTENSITY));

    // Dimmed starfield backdrop, this scene's own instance: scaling the colour
    // buffer dims it without touching the shared factory (the compare
    // studio's way; the gain uniform is the telescope's, not a dimmer).
    this.starfield = createPlanetariumStarfield(renderer.getPixelRatio());
    dimStarfield(this.starfield, STARFIELD_DIM);
    this.group.add(this.starfield);

    this.cutUniforms = createSkinCutUniforms();
    this.fadeUniforms = createSkinFadeUniforms();
    // 128×64, the compare studio's count: a coarser sphere scallops the limb.
    this.skinGeometry = new THREE.SphereGeometry(BODY_RADIUS, 128, 64);
    this.skinMesh = new THREE.Mesh(this.skinGeometry, new THREE.MeshStandardMaterial({ color: 0x000000 }));
    this.skinMesh.name = 'InteriorSkin';
    this.skinMesh.visible = false; // nothing half-loaded is ever shown
    this.group.add(this.skinMesh);
    // The ghost keeps only the wedge (the inverted cut) and draws last, blended over the faces.
    this.ghostCut = {
      uCutView: this.cutUniforms.uCutView,
      uCutSide: this.cutUniforms.uCutSide,
      uCutHalfAngle: this.cutUniforms.uCutHalfAngle,
      uCutFeather: this.cutUniforms.uCutFeather,
      uCutInvert: { value: 1 },
    };
    this.ghostMesh = new THREE.Mesh(this.skinGeometry, new THREE.MeshStandardMaterial({ color: 0x000000 }));
    this.ghostMesh.name = 'InteriorGhost';
    this.ghostMesh.visible = false;
    this.ghostMesh.renderOrder = 3;
    this.group.add(this.ghostMesh);
    // The air: the planetarium's analytic shell, keyed to the studio light and
    // cut with the skin; drawn last so it adds over the faces' rim.
    this.atmosphereMesh = new THREE.Mesh(this.skinGeometry, new THREE.MeshBasicMaterial({ color: 0x000000 }));
    this.atmosphereMesh.name = 'InteriorAtmosphere';
    this.atmosphereMesh.visible = false;
    this.atmosphereMesh.renderOrder = 4;
    this.group.add(this.atmosphereMesh);

    this.sectionUniforms = createSectionUniforms();
    this.faceMaterial = createSectionMaterial(this.sectionUniforms);
    // A unit half-disc in +X: vertices from −90° to +90° so x ≥ 0, normal +Z.
    // The cut-frame face basis (radial, up, normal) is right-handed and maps
    // onto this geometry's (X, Y, Z) without a mirror.
    this.faceGeometry = new THREE.CircleGeometry(BODY_RADIUS, 160, -Math.PI / 2, Math.PI);
    this.shellGeometry = new THREE.SphereGeometry(BODY_RADIUS, 128, 64);
    for (let index = 0; index < MAX_REGIONS; index++) {
      const a = new THREE.Mesh(this.faceGeometry, this.faceMaterial);
      const b = new THREE.Mesh(this.faceGeometry, this.faceMaterial);
      a.name = `InteriorFaceA${index}`;
      b.name = `InteriorFaceB${index}`;
      a.visible = false;
      b.visible = false;
      this.group.add(a, b);
      this.regionFaces.push({ a, b });
      // One shell material per region: its own region index and cut angle,
      // one shared program (the shader text is identical).
      const region = { value: index };
      const cut: SkinCutUniforms = {
        uCutView: this.cutUniforms.uCutView,
        uCutSide: this.cutUniforms.uCutSide,
        uCutHalfAngle: { value: 0 },
        uCutFeather: this.cutUniforms.uCutFeather,
        uCutInvert: { value: 0 },
      };
      const material = createSectionMaterial(this.sectionUniforms, { shellRegion: region });
      applySkinCut(material, cut);
      const mesh = new THREE.Mesh(this.shellGeometry, material);
      mesh.name = `InteriorShell${index}`;
      mesh.visible = false;
      this.group.add(mesh);
      this.regionShells.push({ mesh, material, cut, region });
    }

    scene.add(this.group);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  /** Which edge the cut feather becomes on this render path (plan §5). */
  setEdgeMode(multisampled: boolean): void {
    this.multisampled = multisampled;
    if (this.skinMaterial) configureSkinCutEdge(this.skinMaterial, multisampled);
    for (const shell of this.regionShells) configureSkinCutEdge(shell.material, multisampled);
  }

  /**
   * Load a body's colour map and build its skin material, without showing
   * either: the caller presents it when the ceremony is ready (a swap
   * closes the cut first). Generation-guarded by `isStale`: a stale resolve
   * disposes what it loaded and returns null.
   *
   * The loader resolves its procedural fallback after a timeout, and the
   * first frames of this mode compile a dozen programs (a slow device stalls
   * past that timeout compiling them), so the fetch is given a late slot: the
   * real map, arriving after the fallback, is swapped onto the live skin —
   * or disposed if a newer body has taken over by then.
   */
  async prepareBody(body: InteriorBody, isStale: () => boolean): Promise<PreparedSkin | null> {
    if (!this.capsCaptured) {
      captureDeviceCaps(this.renderer, profileForDevice(readDeviceSignals(this.renderer.getContext())));
      this.capsCaptured = true;
    }
    this.ensureEnvironment();
    if (body.sun) return { body, material: this.buildPhotosphereMaterial(), texture: null, late: null };
    const late = createLateTextureSlot();
    const texture = await this.loadBodyColor(body, late);
    if (isStale()) {
      texture.dispose();
      late.connect((arrival) => arrival.dispose());
      return null;
    }
    const archetype: SurfaceArchetype = body.planet
      ? planetArchetype(body.planet)
      : body.moon
        ? moonArchetype(body.moon)
        : 'airless';
    return { body, material: this.buildSkinMaterial(texture, archetype), texture, late };
  }

  /** The body's context: its air shell if it has one, its rings if it has them. */
  private dressContext(body: InteriorBody): void {
    this.releaseContext();
    const atmosphere = body.sun ? SUN_CORONA : ATMOSPHERES[body.id];
    if (atmosphere) {
      const material = createAtmosphereMaterial(atmosphere, BODY_RADIUS, 'analytic', {
        initialAlpha: ATMOSPHERE_ALPHA,
        initialSunDir: this.keyDirection,
      });
      applyAtmosphereCut(material, this.cutUniforms);
      this.atmosphereMaterial = material;
      this.atmosphereMesh.material = material;
      this.atmosphereMesh.scale.setScalar(atmosphere.scale);
      this.atmosphereMesh.visible = true;
      this.coronaLit = body.sun;
    }
    const rings = RING_CONFIGS[body.id];
    if (rings) {
      const { mesh, fx } = createPlanetRings(BODY_RADIUS, rings, RING_SUN_TAN);
      mesh.name = 'InteriorRings';
      mesh.renderOrder = 2;
      mesh.quaternion.copy(this.poseQuaternion);
      mesh.visible = this.ringsWanted;
      this.group.add(mesh);
      this.ringMesh = mesh;
      this.ringFx = fx;
    }
  }

  private releaseContext(): void {
    this.coronaLit = false;
    this.atmosphereMesh.visible = false;
    this.atmosphereMesh.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.atmosphereMaterial?.dispose();
    this.atmosphereMaterial = null;
    if (this.ringMesh) {
      this.group.remove(this.ringMesh);
      this.ringMesh.geometry.dispose();
      const material = this.ringMesh.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.dispose();
      this.ringMesh = null;
      this.ringFx = null;
    }
  }

  private coronaLit = false;

  /** Whether the current body has rings to show. */
  hasRings(): boolean {
    return this.ringMesh !== null;
  }

  setRingsVisible(on: boolean): void {
    this.ringsWanted = on;
    if (this.ringMesh) this.ringMesh.visible = on;
  }

  /** The Sun's skin: the planetarium's photosphere, granulating on the presentation clock, cut like a skin. */
  private buildPhotosphereMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        uAtmosphereMix: { value: 0 },
        uAtmosphereColor: { value: new THREE.Color(...SUN_ATMOSPHERE_TINT_RGB) },
        uInteriorFade: { value: 1 },
        uWhiteout: { value: 0 },
      },
      vertexShader: sunPhotosphereVertexShader,
      fragmentShader: sunPhotosphereFragmentShader,
    });
    applyPhotosphereCut(material, this.cutUniforms, SUN_STUDIO_EXPOSURE);
    configureSkinCutEdge(material, this.multisampled);
    return material;
  }

  /** Whether a skin is on the body: false before the first body, so an entry has nothing to fade from. */
  hasSkin(): boolean {
    return this.skinMaterial !== null;
  }

  /**
   * Dress the skin in a prepared body. With `fadeSeconds` above zero and a
   * skin already on, the outgoing map is blended out inside the incoming
   * skin's shader over that long (resolved by advance()); otherwise the swap
   * is immediate. Either way nothing half-loaded shows: the map is already
   * here. The ghost takes the same map, for the reveal that follows.
   */
  presentBody(prepared: PreparedSkin, fadeSeconds: number): void {
    const { material, texture, late } = prepared;
    const previousMaterial = this.skinMaterial;
    const previousTexture = this.skinTexture;
    // The cross-fade lives in the standard skin's shader: only a map can fade into a map.
    const fading = fadeSeconds > 0 && previousTexture !== null && previousMaterial !== null && texture !== null;
    this.finishFade(); // a fade cut short by a faster swap still resolves its waiters
    this.skinMesh.material = material;
    this.skinMaterial = material;
    this.sunMaterial = prepared.body.sun ? (material as THREE.ShaderMaterial) : null;
    this.skinFx = prepared.body.sun ? null : this.skinFx;
    this.skinTexture = texture;
    this.skinMesh.visible = true;
    previousMaterial?.dispose();
    if (fading) {
      this.fadeOutgoing = previousTexture;
      this.fadeUniforms.uSkinFadeMap.value = previousTexture!;
      this.fadeUniforms.uSkinFade.value = 0;
      this.fadeSeconds = fadeSeconds;
      this.fadeElapsedS = 0;
    } else {
      previousTexture?.dispose();
    }
    this.dressContext(prepared.body);
    this.ghostMaterial?.dispose();
    this.ghostMaterial = null;
    this.ghostMesh.visible = false;
    if (!texture || !late) return; // the Sun: no ghost of a light, no late map
    const ghost = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0, transparent: true, opacity: 0, depthWrite: false });
    applySkinCut(ghost, this.ghostCut);
    this.ghostMaterial = ghost;
    this.ghostMesh.material = ghost;
    const standard = material as THREE.MeshStandardMaterial;
    late.connect((arrival) => {
      // Only onto the skin this load dressed: a later body owns it otherwise.
      if (this.skinMaterial !== material) {
        arrival.dispose();
        return;
      }
      const fallback = this.skinTexture;
      standard.map = arrival;
      standard.needsUpdate = true;
      ghost.map = arrival;
      ghost.needsUpdate = true;
      this.skinTexture = arrival;
      if (fallback && fallback !== arrival) fallback.dispose();
    });
  }

  /** prepare + present at once, for the first entry under the veil. Resolves true once the map is applied. */
  async loadBody(body: InteriorBody, isStale: () => boolean): Promise<boolean> {
    const prepared = await this.prepareBody(body, isStale);
    if (!prepared) return false;
    this.presentBody(prepared, 0);
    return true;
  }

  /** Resolves once the current cross-fade has finished (at once when none runs). */
  fadeDone(): Promise<void> {
    if (this.fadeOutgoing === null) return Promise.resolve();
    return new Promise((resolve) => this.fadeResolvers.push(resolve));
  }

  isFading(): boolean {
    return this.fadeOutgoing !== null;
  }

  /** Per-frame: the cross-fade's clock. */
  advance(dt: number): void {
    if (this.fadeOutgoing === null) return;
    this.fadeElapsedS += dt;
    const t = Math.min(1, this.fadeElapsedS / Math.max(this.fadeSeconds, 1e-3));
    this.fadeUniforms.uSkinFade.value = t * t * (3 - 2 * t);
    if (t >= 1) this.finishFade();
  }

  private finishFade(): void {
    this.fadeUniforms.uSkinFade.value = 1;
    this.fadeUniforms.uSkinFadeMap.value = idleFadeTexture();
    this.fadeOutgoing?.dispose();
    this.fadeOutgoing = null;
    const resolvers = this.fadeResolvers;
    this.fadeResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /** The reveal ghost's opacity: 0 hides it. */
  setGhost(opacity: number): void {
    const visible = opacity > 0.002 && this.ghostMaterial !== null;
    this.ghostMesh.visible = visible;
    if (visible && this.ghostMaterial) this.ghostMaterial.opacity = opacity;
  }

  /** 0 stills every pattern; applied on the next applyRegions. */
  setMotionScale(scale: number): void {
    this.motionScale = scale;
  }

  private async loadBodyColor(body: InteriorBody, late: LateTextureSlot): Promise<THREE.Texture> {
    const textureKey = body.planet?.textureKey ?? body.moon?.textureKey;
    if (textureKey) return loadTexture(textureKey, '2k', 'color', { late });
    const moon = body.moon!;
    const { colorTex, bumpTex } = createMoonTextures(moon.color, moon.name, moon.radiusKm);
    bumpTex.dispose(); // colour only: the section, not the surface, is the product here
    return colorTex;
  }

  private buildSkinMaterial(texture: THREE.Texture, archetype: SurfaceArchetype): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 });
    const fx = augmentSurfaceMaterial(material, archetype);
    fx.uSunDirWorld.value.copy(this.keyDirection);
    fx.uPlanetshineColor.value.setHex(FILL_SHINE_COLOR);
    fx.uPlanetshineDir.value.copy(FILL_SHINE_DIR);
    fx.uPlanetshineIntensity.value = FILL_SHINE_INTENSITY;
    applySkinFade(material, this.fadeUniforms);
    applySkinCut(material, this.cutUniforms);
    configureSkinCutEdge(material, this.multisampled);
    this.skinFx = fx;
    return material;
  }

  /** The region looks, inside-out, with their boundaries already remapped to display space. */
  applyRegions(regionsInsideOut: readonly SectionRegionLook[]): void {
    writeSectionRegions(this.sectionUniforms, regionsInsideOut, this.floatCapable, this.motionScale);
    this.regionCount = Math.max(1, Math.min(regionsInsideOut.length, MAX_REGIONS));
    for (let index = 0; index < MAX_REGIONS; index++) {
      const radius = index < this.regionCount ? regionsInsideOut[index].outerDisplay : 0;
      const faces = this.regionFaces[index];
      faces.a.scale.setScalar(Math.max(radius, 1e-4));
      faces.b.scale.setScalar(Math.max(radius, 1e-4));
      this.regionShells[index].mesh.scale.setScalar(Math.max(radius, 1e-4));
    }
  }

  /** Composition (0) or Temperature (1): which diagram the faces draw. */
  setDisplayMode(mode: 0 | 1): void {
    this.sectionUniforms.uDisplayMode.value = mode;
  }

  /** The body's temperature scale for Temperature mode; null when nothing is known. */
  setTemperatureScale(range: TemperatureRange | null): void {
    writeTemperatureScale(this.sectionUniforms, range);
  }

  /** The emphasised region (inside-out index, −1 none) and how far in it is. */
  setEmphasis(regionIndex: number, amount: number): void {
    this.sectionUniforms.uEmphasis.value = regionIndex;
    this.sectionUniforms.uEmphasisAmount.value = amount;
  }

  /** Prefilter the studio environment once and hand it to the faces. Under
   *  the mode-transition veil on first entry, like the first shader compile. */
  private ensureEnvironment(): void {
    if (this.environment || !this.floatCapable) return;
    const generator = new THREE.PMREMGenerator(this.renderer);
    const studio = buildStudioEnvironment();
    this.environment = generator.fromScene(studio, 0.04).texture;
    generator.dispose();
    for (const shell of this.regionShells) {
      shell.material.envMap = this.environment;
      shell.material.envMapIntensity = FACE_ENV_INTENSITY;
      shell.material.needsUpdate = true;
    }
    studio.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
    this.faceMaterial.envMap = this.environment;
    this.faceMaterial.envMapIntensity = FACE_ENV_INTENSITY;
    this.faceMaterial.needsUpdate = true;
  }

  /**
   * The body's real orientation at an instant: IAU pole and spin for a
   * planet, the tidal lock for a moon. The faces read the inverse so their
   * patterns are fixed to the material, not to the screen.
   */
  setPose(body: InteriorBody, utcMs: number): void {
    const quaternion = this.skinMesh.quaternion;
    if (body.sun) {
      computeBodyOrientationQuaternion(SUN_ORIENTATION, ttJDFromUtcMs(utcMs), quaternion);
    } else if (body.planet) {
      computeBodyOrientationQuaternion(body.planet, ttJDFromUtcMs(utcMs), quaternion);
    } else if (body.moon) {
      computeMoonOffsetEquatorialAU(body.moon.name, body.moon.parentPlanet, utcMs, tmpOffset, tmpNormal);
      tidalRollNorth(body.moon.name, body.moon.parentPlanet, tmpNormal, tmpRollNorth);
      if (!tidalLockQuaternion(tmpOffset, tmpRollNorth, quaternion)) quaternion.identity();
    } else {
      quaternion.identity();
    }
    for (const shell of this.regionShells) shell.mesh.quaternion.copy(quaternion);
    this.poseQuaternion.copy(quaternion);
    this.ringMesh?.quaternion.copy(quaternion);
    tmpBasis.makeRotationFromQuaternion(quaternion).invert();
    this.worldToBody.setFromMatrix4(tmpBasis);
    this.sectionUniforms.uWorldToBody.value.copy(this.worldToBody);
  }

  /**
   * Point every region's faces and shell at the frame, terraced: the crust
   * (the outermost region) opens by the full angle, each region inward by
   * TERRACE_STEP less. Faces hide when their region is closed.
   */
  applyCut(frame: CutFrame): void {
    this.cutUniforms.uCutView.value.copy(frame.view);
    this.cutUniforms.uCutSide.value.copy(frame.side);
    this.cutUniforms.uCutHalfAngle.value = frame.openingAngle * 0.5;
    // The corner where the faces meet is a crease; a Section has none.
    this.sectionUniforms.uCorner.value = 1 - frame.openingAngle / Math.PI;
    tmpTerraceFrame.view.copy(frame.view);
    tmpTerraceFrame.side.copy(frame.side);
    tmpTerraceFrame.hinge.copy(frame.hinge);
    const count = this.regionCount;
    for (let index = 0; index < MAX_REGIONS; index++) {
      const faces = this.regionFaces[index];
      const shell = this.regionShells[index];
      const isCrust = index === count - 1;
      if (index >= count) {
        faces.a.visible = false;
        faces.b.visible = false;
        shell.mesh.visible = false;
        continue;
      }
      const angle = terraceOpeningAngle(frame.openingAngle, count - 1 - index, TERRACE_STEP);
      shell.cut.uCutHalfAngle.value = angle * 0.5;
      shell.mesh.visible = !isCrust; // the skin is the crust's shell
      const open = angle > 1e-4;
      faces.a.visible = open;
      faces.b.visible = open;
      if (!open) continue;
      tmpTerraceFrame.openingAngle = angle;
      const faceA = cutFaceBasis(tmpTerraceFrame, 'a', tmpFace);
      tmpBasis.makeBasis(faceA.radial, faceA.up, faceA.normal);
      faces.a.quaternion.setFromRotationMatrix(tmpBasis);
      const faceB = cutFaceBasis(tmpTerraceFrame, 'b', tmpFace);
      tmpBasis.makeBasis(faceB.radial, faceB.up, faceB.normal);
      faces.b.quaternion.setFromRotationMatrix(tmpBasis);
    }
  }

  setPresentationTime(seconds: number): void {
    this.sectionUniforms.uTime.value = seconds;
    if (this.sunMaterial) this.sunMaterial.uniforms.time.value = seconds;
  }

  /**
   * Per-frame camera-dependent state: the key rides with the camera (upper
   * left of the viewer), and the starfield's point sprites are told the
   * viewport and framebuffer they draw into — their kernel measures in
   * output pixels and discards everything until it is fed (the planetarium
   * feeds its own sprites the same way each frame; a tool camera has no
   * lens, so the warp is the identity).
   */
  updateForCamera(camera: THREE.PerspectiveCamera): void {
    const viewportWidth = Math.max(this.renderer.domElement.clientWidth, 1);
    const viewportHeight = Math.max(this.renderer.domElement.clientHeight, 1);
    applyLensShaderUniforms(
      (this.starfield.material as THREE.ShaderMaterial).uniforms as unknown as LensShaderUniforms,
      camera,
      viewportWidth,
      viewportHeight,
      this.renderer.getPixelRatio(),
    );
    tmpRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    tmpUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    tmpBack.set(0, 0, 1).applyQuaternion(camera.quaternion);
    this.keyDirection
      .copy(tmpRight).multiplyScalar(KEY_LIGHT_CAMERA_DIR.x)
      .addScaledVector(tmpUp, KEY_LIGHT_CAMERA_DIR.y)
      .addScaledVector(tmpBack, KEY_LIGHT_CAMERA_DIR.z)
      .normalize();
    this.keyLight.position.copy(this.keyDirection).multiplyScalar(KEY_LIGHT_DISTANCE);
    this.skinFx?.uSunDirWorld.value.copy(this.keyDirection);
    // A planet's air is lit by the studio key; the Sun's corona by the camera, so its fringe is even all round.
    if (this.atmosphereMaterial) (this.atmosphereMaterial.uniforms.uSunDirWorld.value as THREE.Vector3).copy(this.coronaLit ? tmpBack : this.keyDirection);
    if (this.ringFx) {
      this.ringFx.uSunDirWorld.value.copy(this.keyDirection);
      // The ring shader shadows in the planet's own frame.
      tmpEnvQuaternion.copy(this.poseQuaternion).invert();
      this.ringFx.uSunDirLocal.value.copy(this.ringSunLocal.copy(this.keyDirection).applyQuaternion(tmpEnvQuaternion));
    }
    // The studio turns with the camera: the lookup is rotated by the inverse,
    // so the softbox stays upper-left of whoever is looking.
    tmpEnvQuaternion.copy(camera.quaternion).invert();
    this.faceMaterial.envMapRotation.setFromQuaternion(tmpEnvQuaternion);
    for (const shell of this.regionShells) shell.material.envMapRotation.setFromQuaternion(tmpEnvQuaternion);
  }

  onResize(): void {
    setStarfieldPixelRatio(this.starfield, this.renderer.getPixelRatio());
  }

  /** Hand the body's map back: the next activate reloads regardless, and the
   *  planetarium's memory envelope cannot see what this mode leaves resident. */
  releaseBodyResources(): void {
    this.finishFade();
    this.releaseContext();
    this.skinMesh.visible = false;
    this.skinMesh.material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    this.skinMaterial?.dispose();
    this.skinMaterial = null;
    this.sunMaterial = null;
    this.skinTexture?.dispose();
    this.skinTexture = null;
    this.skinFx = null;
    this.ghostMesh.visible = false;
    this.ghostMesh.material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    this.ghostMaterial?.dispose();
    this.ghostMaterial = null;
  }

  dispose(): void {
    this.releaseBodyResources();
    this.faceMaterial.envMap = null;
    for (const shell of this.regionShells) {
      shell.material.envMap = null;
      shell.material.dispose();
    }
    this.environment?.dispose();
    this.environment = null;
    this.scene.remove(this.group);
    this.skinGeometry.dispose();
    this.shellGeometry.dispose();
    this.faceGeometry.dispose();
    this.faceMaterial.dispose();
    this.starfield.geometry.dispose();
    (this.starfield.material as THREE.Material).dispose();
  }
}

function dimStarfield(stars: THREE.Points, dim: number): void {
  const color = stars.geometry.getAttribute('color') as THREE.BufferAttribute;
  const values = color.array as Float32Array;
  for (let index = 0; index < values.length; index++) values[index] *= dim;
  color.needsUpdate = true;
}
