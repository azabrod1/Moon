/**
 * The Look-inside studio scene: one body at unit radius, opened by the cut
 * frame. A skin wearing the body's own colour map (borrowed through the same
 * loader the compare studio uses, owned and disposed here), two lit
 * half-disc section faces, a studio key and fill, and a dimmed starfield —
 * everything under one group flipped visible on activate. The body wears
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
  createMoonTextures,
  planetArchetype,
  moonArchetype,
} from '../planetarium/PlanetFactory';
import { augmentSurfaceMaterial, type SurfaceShadingFx, type SurfaceArchetype } from '../planetarium/world/surfaceShading';
import { createPlanetariumStarfield, setStarfieldPixelRatio } from '../planetarium/world/starfield';
import { applyLensShaderUniforms, type LensShaderUniforms } from '../shared/three/lensShader';
import { captureDeviceCaps } from '../planetarium/world/texturePolicy';
import { profileForDevice, readDeviceSignals } from '../planetarium/world/gpuEnvelope';
import { PLANETS, type PlanetData } from '../planetarium/planets/planetData';
import { MOONS, type MoonData } from '../planetarium/planets/moonData';
import { computeBodyOrientationQuaternion, ttJDFromUtcMs } from '../astronomy/planetary';
import { computeMoonOffsetEquatorialAU } from '../astronomy/satellites';
import { tidalLockQuaternion, tidalRollNorth } from '../planetarium/world/tidalLock';
import { applySkinCut, configureSkinCutEdge, createSkinCutUniforms, type SkinCutUniforms } from './rendering/skinCut';
import {
  createSectionMaterial,
  createSectionUniforms,
  writeSectionRegions,
  type SectionRegionLook,
  type SectionUniforms,
} from './rendering/sectionMaterial';
import { createCutFaceBasis, cutFaceBasis, type CutFrame } from './cutFrame';

/** The body's radius in studio units; every framing number is relative to it. */
export const BODY_RADIUS = 1;

// --- lighting --------------------------------------------------------------
// The compare studio's key, but camera-relative: expressed in the camera's
// basis (right, up, back) so the section faces are lit from the upper left
// of whatever the viewer is looking from. A world-fixed key would put the
// faces in the dark on the far side of an orbit, and the faces are the
// product here.
const KEY_LIGHT_CAMERA_DIR = new THREE.Vector3(-0.6, 0.5, 0.65).normalize();
const KEY_LIGHT_DISTANCE = 6;
const KEY_LIGHT_COLOR = 0xffe8c8;
const KEY_LIGHT_INTENSITY = 5.5;
const FILL_SKY_COLOR = 0xaeb6c6;
const FILL_GROUND_COLOR = 0x2a2622;
const FILL_HEMI_INTENSITY = 1.5;
// The skin's night side takes the planetshine channel as a faint studio
// fill, the compare fillers' idiom, so the unlit limb reads as a dim world.
const FILL_SHINE_COLOR = 0x9aa4b8;
const FILL_SHINE_DIR = new THREE.Vector3(0.4, 0.2, 1).normalize();
const FILL_SHINE_INTENSITY = 1.2;
const STARFIELD_DIM = 0.45;

const PLANET_BY_NAME = new Map<string, PlanetData>(PLANETS.map((planet) => [planet.name, planet]));
const MOON_BY_NAME = new Map<string, MoonData>(MOONS.map((moon) => [moon.name, moon]));

/** A catalog body the tool can open: a planet or a moon with a radius and a map. */
export interface InteriorBody {
  id: string;
  planet: PlanetData | null;
  moon: MoonData | null;
  radiusKm: number;
}

export function resolveInteriorBody(bodyId: string): InteriorBody | null {
  const planet = PLANET_BY_NAME.get(bodyId) ?? null;
  const moon = planet ? null : MOON_BY_NAME.get(bodyId) ?? null;
  if (!planet && !moon) return null;
  return { id: bodyId, planet, moon, radiusKm: planet?.radiusKm ?? moon!.radiusKm };
}

const tmpOffset = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpRollNorth = new THREE.Vector3();
const tmpBasis = new THREE.Matrix4();
const tmpFace = createCutFaceBasis();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpBack = new THREE.Vector3();

export class InteriorScene {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly group: THREE.Group;
  private readonly keyLight: THREE.PointLight;
  private readonly starfield: THREE.Points;
  private readonly skinGeometry: THREE.SphereGeometry;
  private readonly skinMesh: THREE.Mesh;
  private skinMaterial: THREE.MeshStandardMaterial | null = null;
  private skinFx: SurfaceShadingFx | null = null;
  private skinTexture: THREE.Texture | null = null;
  private readonly cutUniforms: SkinCutUniforms;
  private readonly sectionUniforms: SectionUniforms;
  private readonly faceGeometry: THREE.CircleGeometry;
  private readonly faceMaterial: THREE.MeshStandardMaterial;
  private readonly faceA: THREE.Mesh;
  private readonly faceB: THREE.Mesh;
  private readonly keyDirection = new THREE.Vector3(0, 0, 1);
  private readonly worldToBody = new THREE.Matrix3();
  private capsCaptured = false;
  private multisampled = true;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
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
    // 128×64, the compare studio's count: a coarser sphere scallops the limb.
    this.skinGeometry = new THREE.SphereGeometry(BODY_RADIUS, 128, 64);
    this.skinMesh = new THREE.Mesh(this.skinGeometry, new THREE.MeshStandardMaterial({ color: 0x000000 }));
    this.skinMesh.name = 'InteriorSkin';
    this.skinMesh.visible = false; // nothing half-loaded is ever shown
    this.group.add(this.skinMesh);

    this.sectionUniforms = createSectionUniforms();
    this.faceMaterial = createSectionMaterial(this.sectionUniforms);
    // A unit half-disc in +X: vertices from −90° to +90° so x ≥ 0, normal +Z.
    // The cut-frame face basis (radial, up, normal) is right-handed and maps
    // onto this geometry's (X, Y, Z) without a mirror.
    this.faceGeometry = new THREE.CircleGeometry(BODY_RADIUS, 160, -Math.PI / 2, Math.PI);
    this.faceA = new THREE.Mesh(this.faceGeometry, this.faceMaterial);
    this.faceB = new THREE.Mesh(this.faceGeometry, this.faceMaterial);
    this.faceA.name = 'InteriorFaceA';
    this.faceB.name = 'InteriorFaceB';
    this.faceA.visible = false;
    this.faceB.visible = false;
    this.group.add(this.faceA, this.faceB);

    scene.add(this.group);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  /** Which edge the cut feather becomes on this render path (plan §5). */
  setEdgeMode(multisampled: boolean): void {
    this.multisampled = multisampled;
    if (this.skinMaterial) configureSkinCutEdge(this.skinMaterial, multisampled);
  }

  /**
   * Load a body's colour map and dress the skin in it. Generation-guarded by
   * the caller's `isStale`: a stale resolve disposes what it loaded and
   * leaves the live skin untouched. Resolves true once the map is applied.
   */
  async loadBody(body: InteriorBody, isStale: () => boolean): Promise<boolean> {
    if (!this.capsCaptured) {
      captureDeviceCaps(this.renderer, profileForDevice(readDeviceSignals(this.renderer.getContext())));
      this.capsCaptured = true;
    }
    const texture = await this.loadBodyColor(body);
    if (isStale()) {
      texture.dispose();
      return false;
    }
    const archetype: SurfaceArchetype = body.planet
      ? planetArchetype(body.planet)
      : body.moon
        ? moonArchetype(body.moon)
        : 'airless';
    const material = this.buildSkinMaterial(texture, archetype);
    const previousMaterial = this.skinMaterial;
    const previousTexture = this.skinTexture;
    this.skinMesh.material = material;
    this.skinMaterial = material;
    this.skinTexture = texture;
    this.skinMesh.visible = true;
    previousMaterial?.dispose();
    previousTexture?.dispose();
    return true;
  }

  private async loadBodyColor(body: InteriorBody): Promise<THREE.Texture> {
    const textureKey = body.planet?.textureKey ?? body.moon?.textureKey;
    if (textureKey) return loadTexture(textureKey);
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
    applySkinCut(material, this.cutUniforms);
    configureSkinCutEdge(material, this.multisampled);
    this.skinFx = fx;
    return material;
  }

  /** The region looks, inside-out, with their boundaries already remapped to display space. */
  applyRegions(regionsInsideOut: readonly SectionRegionLook[]): void {
    writeSectionRegions(this.sectionUniforms, regionsInsideOut);
  }

  /**
   * The body's real orientation at an instant: IAU pole and spin for a
   * planet, the tidal lock for a moon. The faces read the inverse so their
   * patterns are fixed to the material, not to the screen.
   */
  setPose(body: InteriorBody, utcMs: number): void {
    const quaternion = this.skinMesh.quaternion;
    if (body.planet) {
      computeBodyOrientationQuaternion(body.planet, ttJDFromUtcMs(utcMs), quaternion);
    } else if (body.moon) {
      computeMoonOffsetEquatorialAU(body.moon.name, body.moon.parentPlanet, utcMs, tmpOffset, tmpNormal);
      tidalRollNorth(body.moon.name, body.moon.parentPlanet, tmpNormal, tmpRollNorth);
      if (!tidalLockQuaternion(tmpOffset, tmpRollNorth, quaternion)) quaternion.identity();
    } else {
      quaternion.identity();
    }
    tmpBasis.makeRotationFromQuaternion(quaternion).invert();
    this.worldToBody.setFromMatrix4(tmpBasis);
    this.sectionUniforms.uWorldToBody.value.copy(this.worldToBody);
  }

  /** Point the faces and the skin's discard at the frame; hides the faces when closed. */
  applyCut(frame: CutFrame): void {
    this.cutUniforms.uCutView.value.copy(frame.view);
    this.cutUniforms.uCutSide.value.copy(frame.side);
    this.cutUniforms.uCutHalfAngle.value = frame.openingAngle * 0.5;
    // The corner where the faces meet is a crease; a Section has none.
    this.sectionUniforms.uCorner.value = 1 - frame.openingAngle / Math.PI;
    const open = frame.openingAngle > 1e-4;
    this.faceA.visible = open;
    this.faceB.visible = open;
    if (!open) return;
    const faceA = cutFaceBasis(frame, 'a', tmpFace);
    tmpBasis.makeBasis(faceA.radial, faceA.up, faceA.normal);
    this.faceA.quaternion.setFromRotationMatrix(tmpBasis);
    const faceB = cutFaceBasis(frame, 'b', tmpFace);
    tmpBasis.makeBasis(faceB.radial, faceB.up, faceB.normal);
    this.faceB.quaternion.setFromRotationMatrix(tmpBasis);
  }

  setPresentationTime(seconds: number): void {
    this.sectionUniforms.uTime.value = seconds;
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
  }

  onResize(): void {
    setStarfieldPixelRatio(this.starfield, this.renderer.getPixelRatio());
  }

  /** Hand the body's map back: the next activate reloads regardless, and the
   *  planetarium's memory envelope cannot see what this mode leaves resident. */
  releaseBodyResources(): void {
    this.skinMesh.visible = false;
    this.skinMesh.material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    this.skinMaterial?.dispose();
    this.skinMaterial = null;
    this.skinTexture?.dispose();
    this.skinTexture = null;
    this.skinFx = null;
  }

  dispose(): void {
    this.releaseBodyResources();
    this.scene.remove(this.group);
    this.skinGeometry.dispose();
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
