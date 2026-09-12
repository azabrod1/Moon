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
 * The skin is the planetarium's own, not a plainer copy of it: the body's
 * colour map through the same surface shader, and with it whatever detail the
 * planetarium gives that body — Earth's cloud deck on its own shell, its bump
 * relief, and the water mask its ocean glints through; a measured elevation
 * normal where one exists (Mars). They are fetched beside the colour map, cut
 * by the same frame, posed and hidden with the skin and freed with it. Earth's
 * night lights are the one thing deliberately left out: the studio's fill
 * lights the far side, so there is no night here for them to show in.
 *
 * The mode owns the camera, the OrbitControls, the DOM and the presentation
 * clock; this owns the scene content and its GPU resources. Nothing here
 * reaches into the Planetarium's state.
 *
 * Texture ownership is explicit: prepareBody starts the colour map's fetch and
 * every other map that body wears with it, runs the studio's prefilter while
 * they are in flight, and builds the skin (and its cloud deck) off the mesh
 * under the caller's staleness guard — a prefilter that throws adopts the
 * fetches it overlapped, so nothing is left unowned; presentBody swaps them in
 * and only then disposes the old ones, and discardPrepared frees a prepared
 * skin that is never presented (its detail maps, its deck and its late slots
 * included), so no frame samples freed memory and nothing arriving late is
 * held for ever.
 * Everything that can throw for a body — the shader splices, a moon's
 * procedural map — happens in prepareBody or before the skin swap, so a
 * failure leaves the previous body whole. The programs the reveal draws are
 * linked before the cut opens rather than on the frames it opens over
 * (warmUpRevealShaders under the veil, warmUpPreparedSkin in a swap's close);
 * both compile this group alone, in the live scene's render state, and both are
 * fail-open. Anisotropy, tier caps and the
 * memory profile are captured once per session by whichever tool opens
 * first (the compare studio's rule).
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
  MOON_NORMAL_KEYS,
  PLANET_NORMAL_KEYS,
  type LateTextureSlot,
} from '../planetarium/PlanetFactory';
import { RING_CONFIGS, createPlanetRings, type RingShadingFx } from '../planetarium/planets/rings';
import { augmentSurfaceMaterial, setSurfaceWaterGloss, type SurfaceShadingFx, type SurfaceArchetype } from '../planetarium/world/surfaceShading';
import { CLOUD_NORMAL_SCALE, cloudShellScale } from '../planetarium/world/cloudDeck';
import { createPlanetariumStarfield, setStarfieldPixelRatio } from '../planetarium/world/starfield';
import { applyLensShaderUniforms, type LensShaderUniforms } from '../shared/three/lensShader';
import { captureDeviceCaps } from '../planetarium/world/texturePolicy';
import { warmUpSceneShaders } from '../planetarium/world/shaderWarmup';
import { debugLog, debugWarn } from '../shared/debug';
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
/** Earth's height field, in body radii — the planetarium's own 0.02 of the body. */
const SKIN_BUMP_SCALE = 0.02;
/** How deep a measured relief is drawn, by its map key. The planetarium halves
 *  Mars's MOLA — rainbow-decoded, noisy, and harsh on crater rims at full
 *  strength — and leaves the Moon's LOLA at its authored depth; a section's
 *  skin is the same surface, so it is drawn at the same depth. */
const MEASURED_NORMAL_SCALE: Record<string, number> = { marsNormal: 0.5 };
/** Each region inward opens this fraction of the angle less than the one above. */
export const TERRACE_STEP = 0.2;

// --- lighting --------------------------------------------------------------
// The compare studio's key, but camera-relative: expressed in the camera's
// basis (right, up, back) so the section faces are lit from the upper left
// of whatever the viewer is looking from. A world-fixed key would put the
// faces in the dark on the far side of an orbit, and the faces are the
// product here.
// A directional key, a little more frontal than before, so the exterior wraps in light
// around the wedge and each face takes a gradient across its width; the fill is held
// low so the terraces' ledge shadows and the faces' relief are not washed flat.
const KEY_LIGHT_CAMERA_DIR = new THREE.Vector3(-0.35, 0.4, 0.85).normalize();
const KEY_LIGHT_DISTANCE = 6;
const KEY_LIGHT_COLOR = 0xffe8c8;
const KEY_LIGHT_INTENSITY = 2.6;
const FILL_SKY_COLOR = 0xaeb6c6;
const FILL_GROUND_COLOR = 0x2a2622;
const FILL_HEMI_INTENSITY = 1.0;
// The skin's night side takes the planetshine channel as a faint studio
// fill, the compare fillers' idiom, so the unlit limb reads as a dim world.
const FILL_SHINE_COLOR = 0x9aa4b8;
const FILL_SHINE_DIR = new THREE.Vector3(0.4, 0.2, 1).normalize();
const FILL_SHINE_INTENSITY = 1.2;
const STARFIELD_DIM = 0.45;
/** The backdrop behind the starfield: a faint dark-blue radial glow, linear, so the body has
 *  air around it rather than a hole. Drawn first at the far plane, writing no depth. */
const VIGNETTE_CENTRE_COLOR = new THREE.Color(0.006, 0.01, 0.02);
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
const SUN_STUDIO_EXPOSURE = 0.3;

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

/** A body's skin, loaded and built but not yet on the mesh. The Sun has no map, no late slot and no surface shading. */
export interface PreparedSkin {
  body: InteriorBody;
  material: THREE.Material;
  texture: THREE.Texture | null;
  late: LateTextureSlot | null;
  /** The surface shading's uniforms, bound to this material; fed the key direction once it is presented. */
  fx: SurfaceShadingFx | null;
  /** Every map loaded for the skin beside its colour — relief, the water mask —
   *  owned by this skin and freed with it, bound or not: a stand-in that
   *  arrived instead of a real map is not bound and is still this skin's. */
  detail: readonly THREE.Texture[];
  /** Earth's cloud deck, built and waiting for its shell. Null for every other body. */
  clouds: PreparedClouds | null;
}

/** A cloud deck, built but not yet hung on its shell. */
export interface PreparedClouds {
  material: THREE.MeshStandardMaterial;
  /** The deck's colour map (replaced if a late arrival lands) and its relief. */
  color: THREE.Texture;
  normal: THREE.Texture | null;
  /** The shell's radius in body radii — the real cloud top over the real body. */
  shellScale: number;
  /** Where the real colour map lands when the loader handed over its stand-in. */
  late: LateTextureSlot;
  /** True while the deck wears that stand-in: a flat white sheet read as
   *  coverage would wrap the body in an opaque shell, so the deck stays off
   *  until the map is real. */
  awaitingMap: boolean;
}

/** What a body wears beside its colour map, in flight. One shape for every
 *  body — null-heavy on purpose, so there is one place that frees it. */
interface PreparedDetail {
  /** Relief for the skin: a measured normal (Mars) or a height field (Earth). */
  normal: THREE.Texture | null;
  bump: THREE.Texture | null;
  /** The ocean's gloss mask. */
  roughness: THREE.Texture | null;
  /** The cloud deck's colour and relief, the shell they hang on, and the slot
   *  a colour map that missed the loader's timeout arrives through. */
  cloudColor: THREE.Texture | null;
  cloudNormal: THREE.Texture | null;
  cloudLate: LateTextureSlot | null;
  cloudShellScale: number;
  /** How deep the measured relief is drawn (MEASURED_NORMAL_SCALE). */
  normalScale: number;
}

/** Free a body's detail maps: a prepare that went stale, or a prefilter that
 *  threw over fetches already in flight. */
function discardDetail(detail: PreparedDetail): void {
  detail.normal?.dispose();
  detail.bump?.dispose();
  detail.roughness?.dispose();
  detail.cloudColor?.dispose();
  detail.cloudNormal?.dispose();
  detail.cloudLate?.connect((arrival) => arrival.dispose());
}

/** Free a cloud deck that was built and never hung (or never will be again). */
function discardClouds(clouds: PreparedClouds): void {
  clouds.material.dispose();
  clouds.color.dispose();
  clouds.normal?.dispose();
  clouds.late.connect((arrival) => arrival.dispose());
}

/** Whether a map is the real thing rather than the loader's stand-in. The flat
 *  grey a failed fetch leaves behind is not a water mask (its gloss would put
 *  an ocean's sheen on the whole body) and not a relief (as a tangent normal it
 *  is the zero vector); a flat white one is not a cloud deck. */
function isRealMap(texture: THREE.Texture | null | undefined): texture is THREE.Texture {
  return !!texture && texture.userData?.proceduralFallback !== true;
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
  private readonly keyLight: THREE.DirectionalLight;
  /** The renderer's tone curve before the studio took it, restored on dispose. */
  private readonly previousToneMapping: THREE.ToneMapping;
  private readonly starfield: THREE.Points;
  private readonly vignette: THREE.Mesh;
  private readonly skinGeometry: THREE.SphereGeometry;
  private readonly skinMesh: THREE.Mesh;
  private skinMaterial: THREE.Material | null = null;
  /** The photosphere while the Sun is the body: its clock is the presentation clock. */
  private sunMaterial: THREE.ShaderMaterial | null = null;
  private skinFx: SurfaceShadingFx | null = null;
  private skinTexture: THREE.Texture | null = null;
  /** The maps the live skin wears beside its colour, freed when it is. */
  private skinDetail: readonly THREE.Texture[] = [];
  /** The cloud deck on the body right now (Earth alone), and its maps. */
  private readonly cloudMesh: THREE.Mesh;
  private cloudMaterial: THREE.MeshStandardMaterial | null = null;
  private cloudColor: THREE.Texture | null = null;
  private cloudNormal: THREE.Texture | null = null;
  /** The skin wears the loader's procedural fallback and the real map is still to come through the late slot. */
  private lateMapPending = false;
  /** What a mesh wears when it wears nothing: one material, never disposed until the scene is. */
  private readonly placeholderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
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
  /** The sub-pixel sphere the shader warm-up's probes wear; built on the first
   *  warm-up and disposed with the scene. */
  private warmupProbeGeometry: THREE.SphereGeometry | null = null;
  private multisampled = true;
  private readonly floatCapable: boolean;
  private environment: THREE.Texture | null = null;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, floatCapable: boolean) {
    this.scene = scene;
    this.renderer = renderer;
    this.floatCapable = floatCapable;
    // The studio's tone curve: Neutral keeps a hot face's hue where ACES turns everything
    // past mid-grey toward white, so a molten core reads as gold rather than cream. The
    // renderer's curve is the planetarium's; the OutputPass re-reads it every frame, so it
    // is set for the studio's life and given back on dispose. Art, documented.
    this.previousToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NeutralToneMapping;
    this.group = new THREE.Group();
    this.group.name = 'InteriorRoot';
    this.group.visible = false;

    // Lights live inside the group so they can never leak into another mode.
    this.keyLight = new THREE.DirectionalLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY);
    this.keyLight.position.set(0, 0, KEY_LIGHT_DISTANCE);
    this.group.add(this.keyLight);
    this.group.add(this.keyLight.target); // aimed at the body, at the origin
    this.group.add(new THREE.HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, FILL_HEMI_INTENSITY));

    // Dimmed starfield backdrop, this scene's own instance: scaling the colour
    // buffer dims it without touching the shared factory (the compare
    // studio's way; the gain uniform is the telescope's, not a dimmer).
    this.starfield = createPlanetariumStarfield(renderer.getPixelRatio());
    dimStarfield(this.starfield, STARFIELD_DIM);
    this.group.add(this.starfield);
    this.vignette = buildVignette();
    this.group.add(this.vignette);

    this.cutUniforms = createSkinCutUniforms();
    this.fadeUniforms = createSkinFadeUniforms();
    // 128×64, the compare studio's count: a coarser sphere scallops the limb.
    this.skinGeometry = new THREE.SphereGeometry(BODY_RADIUS, 128, 64);
    this.skinMesh = new THREE.Mesh(this.skinGeometry, this.placeholderMaterial);
    this.skinMesh.name = 'InteriorSkin';
    this.skinMesh.visible = false; // nothing half-loaded is ever shown
    this.group.add(this.skinMesh);
    // Earth's cloud deck: its own shell a cloud top above the skin, wearing
    // the same cut. Scaled per body when it is dressed; transparent by nature,
    // so it keeps its own edge treatment rather than the skin's (setEdgeMode).
    this.cloudMesh = new THREE.Mesh(this.skinGeometry, this.placeholderMaterial);
    this.cloudMesh.name = 'InteriorClouds';
    this.cloudMesh.visible = false;
    this.cloudMesh.renderOrder = 1;
    this.group.add(this.cloudMesh);
    // The ghost keeps only the wedge (the inverted cut) and draws last, blended over the faces.
    this.ghostCut = {
      uCutView: this.cutUniforms.uCutView,
      uCutSide: this.cutUniforms.uCutSide,
      uCutHalfAngle: this.cutUniforms.uCutHalfAngle,
      uCutFeather: this.cutUniforms.uCutFeather,
      uCutInvert: { value: 1 },
    };
    this.ghostMesh = new THREE.Mesh(this.skinGeometry, this.placeholderMaterial);
    this.ghostMesh.name = 'InteriorGhost';
    this.ghostMesh.visible = false;
    this.ghostMesh.renderOrder = 3;
    this.group.add(this.ghostMesh);
    // The air: the planetarium's analytic shell, keyed to the studio light and
    // cut with the skin; drawn last so it adds over the faces' rim.
    this.atmosphereMesh = new THREE.Mesh(this.skinGeometry, this.placeholderMaterial);
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

  /** Which edge the cut feather becomes on this render path (plan §5). The
   *  cloud deck is not in this: it is transparent on every path by nature (a
   *  deck writes no depth and blends its own coverage), and that is exactly
   *  what carries the cut's feathered alpha, on the same wedge plane as the
   *  skin's edge. Given the skin's treatment it would turn opaque. */
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
   * The map's fetch and the studio's prefilter overlap: the fetch goes out
   * first and the PMREM runs while it is in flight. They need nothing from
   * each other, and one after the other they were the whole of a first entry's
   * wait — on a software GPU the prefilter alone is seconds, and a phone pays
   * both in a serial line before anything is on screen. The device caps stay
   * ahead of the fetch: the tier and the anisotropy the loader applies are read
   * from them.
   *
   * The loader resolves its procedural fallback after a timeout, so the fetch
   * is given a late slot: the real map, arriving after the fallback, is swapped
   * onto the live skin — or disposed if a newer body has taken over by then.
   */
  async prepareBody(body: InteriorBody, isStale: () => boolean): Promise<PreparedSkin | null> {
    if (!this.capsCaptured) {
      captureDeviceCaps(this.renderer, profileForDevice(readDeviceSignals(this.renderer.getContext())));
      this.capsCaptured = true;
    }
    if (body.sun) {
      this.ensureEnvironment();
      return { body, material: this.buildPhotosphereMaterial(), texture: null, late: null, fx: null, detail: [], clouds: null };
    }
    const late = createLateTextureSlot();
    const pendingTexture = this.loadBodyColor(body, late);
    const pendingDetail = this.loadBodyDetail(body);
    try {
      this.ensureEnvironment();
    } catch (error) {
      // The fetches are already out: adopt them, so a prefilter that throws
      // cannot leave a texture nobody owns (or an unhandled rejection) behind
      // it. The throw still reaches the caller, which leaves the previous body whole.
      void pendingTexture.then((texture) => texture.dispose(), () => {});
      late.connect((arrival) => arrival.dispose());
      void pendingDetail.then(discardDetail, () => {});
      throw error;
    }
    const [texture, detail] = await Promise.all([pendingTexture, pendingDetail]);
    if (isStale()) {
      texture.dispose();
      late.connect((arrival) => arrival.dispose());
      discardDetail(detail);
      return null;
    }
    const archetype: SurfaceArchetype = body.planet
      ? planetArchetype(body.planet)
      : body.moon
        ? moonArchetype(body.moon)
        : 'airless';
    const { material, fx } = this.buildSkinMaterial(texture, archetype, detail);
    const skinDetail = [detail.normal, detail.bump, detail.roughness].filter((map): map is THREE.Texture => map !== null);
    return { body, material, texture, late, fx, detail: skinDetail, clouds: this.buildCloudDeck(detail, fx) };
  }

  /**
   * The maps a body wears beside its colour, started with it and awaited
   * together: Earth's cloud deck, its bump relief and the water mask its ocean
   * glints through — the planetarium's own set, which is what its Earth has
   * always had and the tool's had not — plus a measured elevation normal for
   * any body that has one (Mars's MOLA, the Moon's LOLA). Nothing else in the
   * catalog has detail maps.
   *
   * Only the deck's colour map gets a late slot. It is the one whose absence
   * shows: no deck at all, or the loader's flat white sheet wrapped round the
   * body. A relief or a gloss mask that misses the timeout stands in as flat
   * grey, which is read here as "no relief, no gloss" and never bound.
   */
  private async loadBodyDetail(body: InteriorBody): Promise<PreparedDetail> {
    const detail: PreparedDetail = {
      normal: null, bump: null, roughness: null,
      cloudColor: null, cloudNormal: null, cloudLate: null, cloudShellScale: 1, normalScale: 1,
    };
    const planet = body.planet;
    const pending: Promise<void>[] = [];
    const normalKey = planet ? PLANET_NORMAL_KEYS[planet.name] : body.moon ? MOON_NORMAL_KEYS[body.moon.name] : undefined;
    if (normalKey) {
      detail.normalScale = MEASURED_NORMAL_SCALE[normalKey] ?? 1;
      pending.push(loadTexture(normalKey, '2k', 'data').then((map) => { detail.normal = map; }));
    }
    if (planet?.name === 'Earth') {
      detail.cloudLate = createLateTextureSlot();
      detail.cloudShellScale = cloudShellScale(planet.radiusKm);
      const cloudLate = detail.cloudLate;
      pending.push(loadTexture('earthBump', '2k', 'mask').then((map) => { detail.bump = map; }));
      pending.push(loadTexture('earthRoughness', '2k', 'mask').then((map) => { detail.roughness = map; }));
      pending.push(loadTexture('earthClouds', '2k', 'color', { late: cloudLate }).then((map) => { detail.cloudColor = map; }));
      pending.push(loadTexture('earthCloudsNormal', '2k', 'data').then((map) => { detail.cloudNormal = map; }));
    }
    await Promise.all(pending);
    return detail;
  }

  /**
   * Earth's cloud deck: the planetarium's material on a shell of its own, one
   * real cloud top above the skin. Its alpha is the coverage its map states,
   * read in the surface augmentation (world/cloudDeck), so clear sky ends up
   * with no deck on it; it shares the skin's shading uniforms, so one key
   * direction lights both; and it takes the skin's cut, so the wedge removes
   * the air over the section as well as the ground. Built off the mesh like
   * the skin, so a stale load frees it with no frame the wiser.
   */
  private buildCloudDeck(detail: PreparedDetail, fx: SurfaceShadingFx): PreparedClouds | null {
    const color = detail.cloudColor;
    const late = detail.cloudLate;
    if (!color || !late) return null;
    // A relief that came back as the loader's flat grey is the zero vector as a
    // tangent normal: it would unlight the deck rather than leave it alone.
    const normal = isRealMap(detail.cloudNormal) ? detail.cloudNormal : null;
    if (detail.cloudNormal && detail.cloudNormal !== normal) detail.cloudNormal.dispose();
    const material = new THREE.MeshStandardMaterial({
      map: color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      roughness: 1,
      normalMap: normal,
      normalScale: new THREE.Vector2(CLOUD_NORMAL_SCALE, CLOUD_NORMAL_SCALE),
    });
    augmentSurfaceMaterial(material, 'cloud', undefined, 0, fx);
    applySkinCut(material, this.cutUniforms);
    return { material, color, normal, shellScale: detail.cloudShellScale, late, awaitingMap: !isRealMap(color) };
  }

  /** Free a prepared skin that will never be presented: its material, every
   *  map loaded for it (its colour, its detail, its cloud deck's), and
   *  whatever its late slots deliver afterwards. */
  discardPrepared(prepared: PreparedSkin): void {
    prepared.material.dispose();
    prepared.texture?.dispose();
    prepared.late?.connect((arrival) => arrival.dispose());
    for (const map of prepared.detail) map.dispose();
    if (prepared.clouds) discardClouds(prepared.clouds);
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
      applyAtmosphereCut(material, this.cutUniforms, body.sun ? atmosphere.scale : undefined);
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
    this.atmosphereMesh.material = this.placeholderMaterial;
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
   * here. The ghost takes the same map, for the reveal that follows — the
   * skin's alone; the cloud deck's wedge simply goes with the cut. The
   * body's context (its air, its rings) is dressed first: it is the one step
   * here that can throw, and a throw then leaves the previous skin on.
   *
   * The deck itself is not in the cross-fade: only a map can fade into a map,
   * and the incoming deck's shell has no outgoing map of its own to blend
   * from. It turns over with the skin, behind the closed cut the swap
   * ceremony holds.
   */
  presentBody(prepared: PreparedSkin, fadeSeconds: number): void {
    const { material, texture, late } = prepared;
    this.dressContext(prepared.body);
    const previousMaterial = this.skinMaterial;
    const previousTexture = this.skinTexture;
    // The cross-fade lives in the standard skin's shader: only a map can fade into a map.
    const fading = fadeSeconds > 0 && previousTexture !== null && previousMaterial !== null && texture !== null;
    this.finishFade(); // a fade cut short by a faster swap still resolves its waiters
    this.skinMesh.material = material;
    this.skinMaterial = material;
    this.sunMaterial = prepared.body.sun ? (material as THREE.ShaderMaterial) : null;
    this.skinFx = prepared.fx;
    this.skinTexture = texture;
    this.skinMesh.visible = true;
    previousMaterial?.dispose();
    // The outgoing skin's detail maps go with its material (nothing draws it
    // again); only its colour is held back, and only while the fade reads it.
    this.releaseSkinDetail();
    this.skinDetail = prepared.detail;
    this.dressClouds(prepared.clouds);
    if (fading) {
      this.fadeOutgoing = previousTexture;
      this.fadeUniforms.uSkinFadeMap.value = previousTexture!;
      this.fadeUniforms.uSkinFade.value = 0;
      this.fadeSeconds = fadeSeconds;
      this.fadeElapsedS = 0;
    } else {
      previousTexture?.dispose();
    }
    this.ghostMaterial?.dispose();
    this.ghostMaterial = null;
    this.ghostMesh.visible = false;
    this.ghostMesh.material = this.placeholderMaterial;
    this.lateMapPending = false;
    if (!texture || !late) return; // the Sun: no ghost of a light, no late map
    const ghost = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0, transparent: true, opacity: 0, depthWrite: false });
    applySkinCut(ghost, this.ghostCut);
    this.ghostMaterial = ghost;
    this.ghostMesh.material = ghost;
    // The loader hands out its procedural fallback past its timeout; the real map then comes late.
    this.lateMapPending = texture.userData.proceduralFallback === true;
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
      this.lateMapPending = false;
      if (fallback && fallback !== arrival) fallback.dispose();
    });
  }

  /** Hang a prepared cloud deck on its shell and take the last body's down.
   *  A deck still wearing the loader's stand-in stays hidden until its real
   *  map lands through the late slot — a flat white sheet read as coverage is
   *  an opaque shell around the body, which is worse than no clouds. */
  private dressClouds(clouds: PreparedClouds | null): void {
    this.releaseClouds();
    if (!clouds) return;
    this.cloudMaterial = clouds.material;
    this.cloudColor = clouds.color;
    this.cloudNormal = clouds.normal;
    this.cloudMesh.material = clouds.material;
    this.cloudMesh.scale.setScalar(clouds.shellScale);
    this.cloudMesh.quaternion.copy(this.skinMesh.quaternion);
    this.cloudMesh.visible = !clouds.awaitingMap;
    clouds.late.connect((arrival) => {
      // Only onto the deck this load built: a later body owns the shell otherwise.
      if (this.cloudMaterial !== clouds.material) {
        arrival.dispose();
        return;
      }
      const standIn = this.cloudColor;
      clouds.material.map = arrival;
      clouds.material.needsUpdate = true;
      this.cloudColor = arrival;
      this.cloudMesh.visible = this.skinMesh.visible;
      if (standIn && standIn !== arrival) standIn.dispose();
    });
  }

  /** Take the deck off the shell and free it. */
  private releaseClouds(): void {
    this.cloudMesh.visible = false;
    this.cloudMesh.material = this.placeholderMaterial;
    this.cloudMaterial?.dispose();
    this.cloudMaterial = null;
    this.cloudColor?.dispose();
    this.cloudColor = null;
    this.cloudNormal?.dispose();
    this.cloudNormal = null;
  }

  /** Free the maps the skin wore beside its colour. */
  private releaseSkinDetail(): void {
    for (const map of this.skinDetail) map.dispose();
    this.skinDetail = [];
  }

  /**
   * Link every program the reveal is about to draw, while the veil still covers
   * the canvas.
   *
   * Nothing compiles the section before the cut opens: the faces hide while
   * their region is closed (applyCut), the ghost until the reveal, and the skin,
   * the air and the rings are dressed a few milliseconds before it with no frame
   * in between — so all of it used to be built on the frames the reader watches
   * the reveal on. Measured on a software GPU that is the whole of the reveal's
   * first frame, five to seven programs deep; on a phone it is the stall the map
   * loader's own timeout was written around (see prepareBody).
   *
   * What is compiled is this group's materials (`compileSubtree`) in the live
   * scene's render state: three initializes every material it traverses, visible
   * or not, so the group is exactly the right root — no face has to be shown for
   * it and no frame can catch a pose that never existed — while the lights and
   * the bound target still come from the frame the reveal will be drawn in.
   * Programs are keyed on both, and a program built in another state is one the
   * reveal cannot use.
   *
   * The warm-up's own one-pixel draw is what forces the driver to finish a link
   * it only promised. The faces, the shells and the ghost are hidden, so they
   * take sub-pixel probes wearing their LIVE materials (the planetarium's
   * warm-up idiom — a copy's program is freed with the copy); the skin, the air
   * and the rings are visible by then and the draw finds them itself.
   *
   * Fail-open throughout: this only buys a reveal that does not stutter, and a
   * program that misses it links on its first real draw as it always did.
   */
  async warmUpRevealShaders(camera: THREE.PerspectiveCamera, drawsThroughComposer: boolean): Promise<void> {
    const probeGroup = new THREE.Group();
    probeGroup.name = 'InteriorWarmupProbes';
    probeGroup.visible = false;
    try {
      for (const material of this.revealMaterials()) probeGroup.add(this.buildWarmupProbe(material));
      this.group.add(probeGroup);
      const { resolved, warmDrawMs } = await warmUpSceneShaders(this.renderer, this.scene, camera, {
        drawsThroughComposer,
        probeGroups: [probeGroup],
        compileSubtree: this.group,
        // Every pending program in this task, no frame yielded: the veil is up,
        // so a yielded frame is the reader's wait either way — shaderWarmup's
        // own rule for work paid behind a cover.
        resolvePerFrame: Number.POSITIVE_INFINITY,
        onError: (stage, error) => debugWarn(`Look inside: reveal warm-up ${stage} failed`, { error: String(error) }),
      });
      // Which programs this built, by material, and what each cost: the reading
      // that says whether the set is the one the reveal draws and nothing more.
      debugLog('Look inside: reveal warm-up', {
        programs: resolved.length,
        warmDrawMs: Math.round(warmDrawMs),
        built: resolved.map((row) => `${row.name || '?'} ${Math.round(row.ms)}ms`),
      });
    } catch (error) {
      debugWarn('Look inside: the reveal warm-up could not run', { error: String(error) });
    } finally {
      this.group.remove(probeGroup);
      probeGroup.clear(); // live materials and a shared geometry: nothing here is this group's to dispose
    }
  }

  /**
   * Link a prepared skin's program before it is worn. A swap's close is 0.9 s
   * of animation with nothing else to do in it, and the material built in
   * prepareBody is on no mesh yet, so its program would otherwise be built at
   * the cross-fade — the one moment of the ceremony that has to be smooth.
   * Usually a cache hit (one body's skin keys like another's), and not for the
   * Sun's photosphere, which is a program of its own. Fail-open.
   */
  async warmUpPreparedSkin(prepared: PreparedSkin, camera: THREE.PerspectiveCamera, drawsThroughComposer: boolean): Promise<void> {
    const probeGroup = new THREE.Group();
    probeGroup.name = 'InteriorPreparedSkinProbe';
    probeGroup.visible = false;
    probeGroup.add(this.buildWarmupProbe(prepared.material));
    // The deck is a program of its own, and a swap onto Earth would otherwise
    // build it at the cross-fade — the one moment that has to be smooth.
    if (prepared.clouds) probeGroup.add(this.buildWarmupProbe(prepared.clouds.material));
    this.group.add(probeGroup);
    try {
      const { resolved, warmDrawMs } = await warmUpSceneShaders(this.renderer, this.scene, camera, {
        drawsThroughComposer,
        probeGroups: [probeGroup],
        compileSubtree: this.group,
        resolvePerFrame: Number.POSITIVE_INFINITY,
        onError: (stage, error) => debugWarn(`Look inside: prepared-skin warm-up ${stage} failed`, { error: String(error) }),
      });
      // Usually nothing: one body's skin keys like another's. Logged only when
      // this window actually built something, so the common case stays quiet.
      if (resolved.length > 0) {
        debugLog('Look inside: prepared-skin warm-up', {
          programs: resolved.length,
          warmDrawMs: Math.round(warmDrawMs),
          built: resolved.map((row) => `${row.name || '?'} ${Math.round(row.ms)}ms`),
        });
      }
    } catch (error) {
      debugWarn('Look inside: the prepared-skin warm-up could not run', { error: String(error) });
    } finally {
      this.group.remove(probeGroup);
      probeGroup.clear();
    }
  }

  /** The materials the reveal draws that no earlier frame has drawn: the
   *  section faces, every terrace shell, the exterior ghost, and the cloud
   *  deck (which is its own program, and hidden whenever it is still waiting
   *  for its map). The skin, the air and the rings are visible by then and the
   *  warm-up's draw finds them itself. */
  private revealMaterials(): THREE.Material[] {
    const materials: THREE.Material[] = [this.faceMaterial];
    for (const shell of this.regionShells) materials.push(shell.material);
    if (this.ghostMaterial) materials.push(this.ghostMaterial);
    if (this.cloudMaterial) materials.push(this.cloudMaterial);
    return materials;
  }

  /** A sub-pixel mesh wearing a live material, for the warm-up's one-pixel
   *  draw. Never raycast, and never in the scene for a frame the reader sees:
   *  the warm-up adds it, shows it inside its own draw, and removes it. */
  private buildWarmupProbe(material: THREE.Material): THREE.Mesh {
    this.warmupProbeGeometry ??= new THREE.SphereGeometry(1e-9, 4, 2);
    const mesh = new THREE.Mesh(this.warmupProbeGeometry, material);
    mesh.raycast = () => {};
    return mesh;
  }

  /** Whether the skin still wears the loader's fallback with the real map to come. */
  awaitingLateMap(): boolean {
    return this.lateMapPending;
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

  /** The skin material and its shading uniforms, dressed in whatever detail
   *  the body has (bound before the augment, as PlanetFactory binds it, so the
   *  program is compiled with it in); nothing here binds to the live skin
   *  (presentBody does). */
  private buildSkinMaterial(
    texture: THREE.Texture,
    archetype: SurfaceArchetype,
    detail: PreparedDetail,
  ): { material: THREE.MeshStandardMaterial; fx: SurfaceShadingFx } {
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 });
    if (isRealMap(detail.normal)) {
      material.normalMap = detail.normal;
      material.normalScale.set(detail.normalScale, detail.normalScale);
      material.userData.hasRealNormal = true;
    } else if (isRealMap(detail.bump)) {
      material.bumpMap = detail.bump;
      material.bumpScale = BODY_RADIUS * SKIN_BUMP_SCALE;
    }
    if (detail.roughness) {
      // The mask drives roughness (ocean glossy, land and ice matte) and the
      // gloss remap below turns that into the sun glint on the seas — but only
      // once the mask really is one. Water is a dielectric: metalness stays 0.
      material.roughnessMap = detail.roughness;
      material.roughness = 1;
      material.metalness = 0;
    }
    const fx = augmentSurfaceMaterial(material, archetype);
    if (detail.roughness) setSurfaceWaterGloss(material, isRealMap(detail.roughness));
    fx.uSunDirWorld.value.copy(this.keyDirection);
    fx.uPlanetshineColor.value.setHex(FILL_SHINE_COLOR);
    fx.uPlanetshineDir.value.copy(FILL_SHINE_DIR);
    fx.uPlanetshineIntensity.value = FILL_SHINE_INTENSITY;
    applySkinFade(material, this.fadeUniforms);
    applySkinCut(material, this.cutUniforms);
    configureSkinCutEdge(material, this.multisampled);
    return { material, fx };
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
    this.cloudMesh.quaternion.copy(quaternion);
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
    this.skinMesh.material = this.placeholderMaterial;
    this.skinMaterial?.dispose();
    this.skinMaterial = null;
    this.sunMaterial = null;
    this.skinTexture?.dispose();
    this.skinTexture = null;
    this.releaseSkinDetail();
    this.releaseClouds();
    this.skinFx = null;
    this.lateMapPending = false;
    this.ghostMesh.visible = false;
    this.ghostMesh.material = this.placeholderMaterial;
    this.ghostMaterial?.dispose();
    this.ghostMaterial = null;
  }

  dispose(): void {
    this.renderer.toneMapping = this.previousToneMapping;
    this.releaseBodyResources();
    this.placeholderMaterial.dispose();
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
    this.warmupProbeGeometry?.dispose();
    this.warmupProbeGeometry = null;
    this.faceMaterial.dispose();
    this.starfield.geometry.dispose();
    (this.starfield.material as THREE.Material).dispose();
    this.vignette.geometry.dispose();
    (this.vignette.material as THREE.Material).dispose();
  }
}

function buildVignette(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { uVignetteColor: { value: VIGNETTE_CENTRE_COLOR } },
    vertexShader: /* glsl */ `
      varying vec2 vVignetteUv;
      void main() {
        vVignetteUv = uv;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uVignetteColor;
      varying vec2 vVignetteUv;
      void main() {
        float radius = length(vVignetteUv * 2.0 - 1.0);
        gl_FragColor = vec4(uVignetteColor * (1.0 - smoothstep(0.15, 1.15, radius)), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'InteriorVignette';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

function dimStarfield(stars: THREE.Points, dim: number): void {
  const color = stars.geometry.getAttribute('color') as THREE.BufferAttribute;
  const values = color.array as Float32Array;
  for (let index = 0; index < values.length; index++) values[index] *= dim;
  color.needsUpdate = true;
}
