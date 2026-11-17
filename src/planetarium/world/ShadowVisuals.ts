/**
 * True-scale shadow visuals for the landed moon system. Always on: transit
 * shadow spots — the classic Io dot crawling across Jupiter, or the Moon's
 * shadow on Earth during a solar eclipse. Behind the Observatory panel's
 * "Shadow guides" toggle: the parent's (+ landed moon's near-syzygy) cone
 * fills, and instrument-style guide lines, split by event kind —
 *
 *   eclipse kind   the parent's anti-sun shadow axis, umbra/penumbra
 *                  cross-section rings where a guided moon's orbit crosses
 *                  the shadow (the dark circle the moon swims through), and
 *                  an orbit-crossing tick whose miss distance from the rings
 *                  *is* the season geometry;
 *   transit kind   the guided moon's shadow axis down to its surface
 *                  footprint, true umbra/penumbra footprint rings around the
 *                  posed spot, and an umbra-tip tick when the apex hangs
 *                  above the surface (the annular signature);
 *
 * plus view-dependent cone silhouette edges that fade in once the occluder
 * resolves on screen, and fade out with the camera inside a cone (you can't
 * see a volume's outline from inside it — and you'd be inside that shadow).
 * "Resolves on screen" is decided from the analytic tangent size at the
 * camera's distance, never a sampled footprint: a footprint reads 0 px as soon
 * as its body leaves the frustum, which would blink the edges off whenever the
 * parent is steered past the frame edge with its guides still mid-viewport.
 *
 * Honesty contract: every position, radius and length is
 * true scale, computed from the same closed forms the event engine
 * classifies with (computeShadowConeProfileKm, shadowAxisSphereHitAU — the
 * guides and the event list can never disagree). Only line WIDTH is
 * screen-space (px-width Line2 lines; true-scale cones are 100:1 hairlines
 * that would vanish — the panel caption says so). The one fixed-size element
 * is the footprint reticle (exposed via getFootprintReticleLocal, drawn by
 * PlanetariumMode as HTML, same glyph as the surface HUD's sub-resolution
 * reticle): a marker, not geometry, shown when the true rings collapse below
 * resolvability.
 *
 * Everything lives in the parent's moon-system group (parent at local
 * origin, AU units), so the floating origin is free; lines are shared unit
 * geometry re-posed per frame by transform with zero allocations.
 *
 * Caveat: small moons render inflated in orbit view (the moonRenderSize
 * curve lifts them toward an anchor fraction of the parent's radius — less
 * while observing the parent planet, more in flythrough), so a tiny moon's
 * drawn ball can still dwarf its own true-scale guides — Phobos' drawn ball
 * swallows its real ∅59 km footprint rings. The rings and spot are real; the
 * ball isn't. Surface view renders true sizes, and there the meshes and
 * guides agree.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { KM_PER_AU } from '../../astronomy/constants';
import { discDiameterPx } from '../../shared/math/discScreenSize';
import {
  computeConeSilhouette,
  computeShadowConeProfileKm,
  occluderEnlargement,
  shadowAxisSphereHitAU,
  type ShadowConeProfile,
} from '../../astronomy/shadows';
import { bodyShape } from '../../astronomy/bodyShape';
import {
  projectedOutlineRadius,
  spheroidNormal,
  spheroidRadiusToward,
  type SpheroidShape,
} from '../../astronomy/spheroid';
import { resolveGuideVisibility } from '../surfaceView';
import type { MoonMesh } from '../PlanetFactory';
import {
  applyLensShaderUniforms,
  augmentFixedScreenLineForLens,
  type LensShaderUniforms,
} from '../../shared/three/lensShader';
import { projectSphereToScreen, type SphereScreenProjection } from '../../shared/three/projectToScreen';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1); // CircleGeometry's / unit ring's facing axis

// Radially-graded shadow spot: alpha follows the Sun-cover fraction across the
// footprint — a flat-dark core (the umbra, or the antumbra where cover
// plateaus below 1 because the Sun's ring still lights it), easing to nothing
// at the penumbra rim. The 0.6 power widens the dark heart the way space
// photos show it (cover stays high until the Moon's disc slides mostly off
// the Sun): a diffuse smudge, dark for the inner half, soft skirt to zero —
// never a uniform disc.
const SPOT_CORE_DARK = 0.8;
const SPOT_VERTEX = /* glsl */ `
varying float vR;
void main() {
  vR = length(position.xy);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SPOT_FRAGMENT = /* glsl */ `
uniform float uInnerFrac;
uniform float uCoreCover;
varying float vR;
void main() {
  float cover = uCoreCover * pow(1.0 - smoothstep(min(uInnerFrac, 0.999), 1.0, vR), 0.6);
  gl_FragColor = vec4(0.0, 0.0, 0.0, ${SPOT_CORE_DARK.toFixed(2)} * cover);
}`;

function makeSpotMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SPOT_VERTEX,
    fragmentShader: SPOT_FRAGMENT,
    uniforms: { uInnerFrac: { value: 0 }, uCoreCover: { value: 1 } },
    transparent: true,
    depthWrite: false,
  });
}
/** Show the landed moon's cones once its shadow axis passes within this many parent radii. */
const MOON_CONE_GATE_RADII = 3;

// Instrument line spec: one neutral core color over a
// dark casing so lines read over black *and* a lit limb without glowing
// (far below the bloom threshold); identity tints live only in the cone
// fills. Solid = umbra, dashed = penumbra; the axis is the faintest line.
const GUIDE_CORE_COLOR = 0xc6cdda;
const GUIDE_CASING_COLOR = 0x000000;
const PARENT_FILL_COLOR = 0x2a1714;
const MOON_FILL_COLOR = 0x141a2a;
// Dash patterns are in unit-geometry distance (ring circumference 2π,
// segment length 1), so a ring keeps a constant dash count at any radius.
const PENUMBRA_DASH = 0.05;
const PENUMBRA_GAP = 0.037;
const AXIS_DASH = 0.008;
const AXIS_GAP = 0.02;

interface GuideStyle {
  core: LineMaterial;
  casing: LineMaterial;
}

const tmpPoseDir = new THREE.Vector3();
const tmpEllipseMinor = new THREE.Vector3();
const tmpEllipseBasis = new THREE.Matrix4();

/**
 * One drawn guide: a px-width core line over its dark casing, sharing a unit
 * geometry (ring or segment), posed per frame by transform only.
 */
class GuideLine {
  readonly group = new THREE.Group();

  constructor(geometry: LineGeometry, style: GuideStyle) {
    const casing = new Line2(geometry, style.casing);
    const core = new Line2(geometry, style.core);
    // Draw after the cone fills/spots (transparent pass sorts renderOrder
    // first), casing under core; depth-test still hides lines behind the
    // planet — a ring's far arc disappears, which is the 3D cue.
    casing.renderOrder = 20;
    core.renderOrder = 21;
    this.group.add(casing, core);
    this.group.visible = false;
  }

  setRing(centerAU: THREE.Vector3, normalUnit: THREE.Vector3, radiusAU: number): void {
    this.group.position.copy(centerAU);
    this.group.quaternion.setFromUnitVectors(FORWARD, normalUnit);
    this.group.scale.setScalar(radiusAU);
    this.group.visible = true;
  }

  /** The unit ring as an ellipse: semi-axis `majorAU` along `majorUnit`
   *  (perpendicular to the normal), `minorAU` across it. */
  setEllipse(centerAU: THREE.Vector3, normalUnit: THREE.Vector3, majorUnit: THREE.Vector3, majorAU: number, minorAU: number): void {
    this.group.position.copy(centerAU);
    const minorUnit = tmpEllipseMinor.crossVectors(normalUnit, majorUnit);
    this.group.quaternion.setFromRotationMatrix(tmpEllipseBasis.makeBasis(majorUnit, minorUnit, normalUnit));
    this.group.scale.set(majorAU, minorAU, majorAU);
    this.group.visible = true;
  }

  setSegment(fromAU: THREE.Vector3, toAU: THREE.Vector3): void {
    const dir = tmpPoseDir.copy(toAU).sub(fromAU);
    const lengthAU = dir.length();
    if (lengthAU < 1e-12) {
      this.group.visible = false;
      return;
    }
    this.group.position.copy(fromAU);
    this.group.quaternion.setFromUnitVectors(UP, dir.divideScalar(lengthAU));
    this.group.scale.set(1, lengthAU, 1);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

/** Pose record for one cone fill, consumed by the camera-dependent edge pass. */
interface ConeRecord {
  posed: boolean;
  fill: THREE.Mesh;
  edgeA: GuideLine;
  edgeB: GuideLine;
  apexAU: THREE.Vector3;
  /** Apex → opening, unit. */
  axisUnit: THREE.Vector3;
  halfAngleRad: number;
  /** Apex → base plane along the axis (AU). */
  axialLengthAU: number;
  /**
   * Where the physical shadow begins along the axis from the apex (AU): 0
   * for the umbra, the pinch distance for the penumbra (its apex sits
   * sunward of the occluder — the gap between them is lit space).
   */
  shadowMinAxialAU: number;
  /** A flattened occluder's cone: minor/major radius (1 for a round cone)
   *  and the unit major direction across the axis. */
  minorRatio: number;
  majorUnit: THREE.Vector3;
}

/** A moon the guides follow: the landed/companion subject and, when a jumped
 * or live event names a different moon, that one too. */
export interface GuideSlotInput {
  name: string | null;
  /** The moon's current orbit-plane normal (unit). */
  orbitNormal: THREE.Vector3;
}

interface GuideSlot {
  name: string | null;
  orbitNormal: THREE.Vector3;
  // eclipse kind — the parent's shadow where this moon's orbit crosses it
  ringUmbra: GuideLine;
  ringPenumbra: GuideLine;
  crossingTick: GuideLine;
  // transit kind — this moon's shadow on the parent
  transitAxis: GuideLine;
  footprintUmbra: GuideLine;
  footprintPenumbra: GuideLine;
  tipTick: GuideLine;
  footprintPosed: boolean;
  /** Hysteresis state: true rings drawn vs collapsed to the reticle. */
  footprintRingsVisible: boolean;
  /** Camera-pass output: show the fixed-px footprint reticle here. */
  reticleActive: boolean;
  hitDirUnit: THREE.Vector3;
  hitPosAU: THREE.Vector3;
  footprintRadiusAU: number;
}

function coneMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/**
 * Probe objects for the boot-time shader warmup: one instance of every
 * material family this module introduces (cone/spot fill, solid and dashed
 * fat guide lines) on degenerate geometry. These programs otherwise link on
 * the first frame that draws them — the first surface-view entry — freezing
 * that frame long enough on slow GPUs that the entering click reads as dead.
 * Nothing else holds these materials before a landing, and three destroys a
 * program with its last material, so the probes stay in the scene, invisible
 * and never raycast, for the session.
 */
export function createShadowVisualsWarmupProbes(): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  group.visible = false;
  const noPick = <T extends THREE.Object3D>(o: T): T => { o.raycast = () => {}; return o; };
  const fill = coneMaterial(0xffffff, 0.1);
  const cone = new THREE.CylinderGeometry(1e-9, 0, 1e-9, 3, 1, true);
  group.add(noPick(new THREE.Mesh(cone, fill)));
  const spotFill = makeSpotMaterial();
  const disc = new THREE.CircleGeometry(1e-9, 3);
  group.add(noPick(new THREE.Mesh(disc, spotFill)));
  const segment = new LineGeometry();
  segment.setPositions([0, 0, 0, 0, 1e-9, 0]);
  const solid = new LineMaterial({ color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true, depthWrite: false });
  const dashed = new LineMaterial({
    color: 0xffffff, linewidth: 1, opacity: 0.5, transparent: true, depthWrite: false,
    dashed: true, dashSize: 1, gapSize: 1,
  });
  // The live guides draw through the lens augmentation, and its cache-key tag
  // is part of the program: an un-augmented probe compiles a program nothing
  // ever draws. The lens uniforms it returns stay at rest — the probe is only
  // ever drawn one pixel wide under the load screen.
  augmentFixedScreenLineForLens(solid);
  augmentFixedScreenLineForLens(dashed);
  const solidLine = new Line2(segment, solid);
  const dashedLine = new Line2(segment, dashed);
  solidLine.computeLineDistances();
  group.add(noPick(solidLine), noPick(dashedLine));
  return {
    group,
    dispose: () => {
      fill.dispose();
      spotFill.dispose();
      solid.dispose();
      dashed.dispose();
      cone.dispose();
      disc.dispose();
      segment.dispose();
    },
  };
}

export class ShadowVisuals {
  private root = new THREE.Group();
  private guidesGroup = new THREE.Group();

  // Unit cone: apex at y=0 opening to radius 1 at y=1 — posed via scale(R, L, R).
  private unitCone: THREE.BufferGeometry;
  private unitDisc: THREE.BufferGeometry;
  // Unit guide geometries: ring of radius 1 in the XY plane, segment (0,0,0)→(0,1,0).
  private unitRing: LineGeometry;
  private unitSegment: LineGeometry;

  private lineMaterials: LineMaterial[] = [];
  private lineLensUniforms: LensShaderUniforms[] = [];
  private styleUmbra: GuideStyle;
  private stylePenumbra: GuideStyle;
  private styleAxis: GuideStyle;
  private styleTick: GuideStyle;

  private parentUmbraRec: ConeRecord;
  private parentPenumbraRec: ConeRecord;
  private moonUmbraRec: ConeRecord;
  private moonPenumbraRec: ConeRecord;
  private coneRecords: ConeRecord[];
  private parentAxisLine: GuideLine;
  private slots: GuideSlot[];

  private spots = new Map<string, THREE.Mesh>();

  private guidesVisible = false;
  // Camera-pass anchors written by update(), plus edge-gate hysteresis.
  private parentRadiusEffAU = 0;
  private landedMoonOffsetAU = new THREE.Vector3();
  private landedMoonRadiusAU = 0;
  private parentEdgesResolvable = false;
  private moonEdgesResolvable = false;
  private lastLandedMoonName: string | null = null;

  private profileScratch: ShadowConeProfile = {
    umbraLengthKm: 0,
    pinchKm: 0,
    umbraRadiusKm: 0,
    penumbraRadiusKm: 0,
  };

  private tmpAxis = new THREE.Vector3();
  private outlineMajorUnit = new THREE.Vector3();
  private outlineMinorUnit = new THREE.Vector3();
  private outlineMinorKm = 0;
  private coneBasis = new THREE.Matrix4();
  private tmpHelio = new THREE.Vector3();
  private tmpVec = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();
  private tmpAxisInOrbitPlane = new THREE.Vector3();
  private tmpRingCenter = new THREE.Vector3();
  private tmpSyzygy = new THREE.Vector3();
  private tmpTickDir = new THREE.Vector3();
  private tmpSegA = new THREE.Vector3();
  private tmpSegB = new THREE.Vector3();
  private tmpEdgeDirA = new THREE.Vector3();
  private tmpEdgeDirB = new THREE.Vector3();
  private tmpEdgeEnd = new THREE.Vector3();
  private tmpWorld = new THREE.Vector3();
  private sphereProjection: SphereScreenProjection = {
    x: 0, y: 0, ndcX: 0, ndcY: 0, ndcZ: 0,
    footprintX: 0, footprintY: 0, radiusPx: 0, diameterPx: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
    footprintKind: 'none',
  };

  constructor() {
    const cone = new THREE.CylinderGeometry(1, 0, 1, 48, 1, true);
    cone.translate(0, 0.5, 0);
    this.unitCone = cone;
    this.unitDisc = new THREE.CircleGeometry(1, 48);

    const ringPositions: number[] = [];
    const RING_SEGMENTS = 128;
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      ringPositions.push(Math.cos(a), Math.sin(a), 0);
    }
    this.unitRing = new LineGeometry();
    this.unitRing.setPositions(ringPositions);
    this.unitSegment = new LineGeometry();
    this.unitSegment.setPositions([0, 0, 0, 0, 1, 0]);

    const casingSolid = this.makeLineMaterial(GUIDE_CASING_COLOR, 3.5, 0.38);
    const casingPenumbra = this.makeLineMaterial(GUIDE_CASING_COLOR, 3.5, 0.38, PENUMBRA_DASH, PENUMBRA_GAP);
    const casingAxis = this.makeLineMaterial(GUIDE_CASING_COLOR, 3.5, 0.38, AXIS_DASH, AXIS_GAP);
    this.styleUmbra = { core: this.makeLineMaterial(GUIDE_CORE_COLOR, 1.5, 0.85), casing: casingSolid };
    this.stylePenumbra = {
      core: this.makeLineMaterial(GUIDE_CORE_COLOR, 1.5, 0.55, PENUMBRA_DASH, PENUMBRA_GAP),
      casing: casingPenumbra,
    };
    this.styleAxis = {
      core: this.makeLineMaterial(GUIDE_CORE_COLOR, 1, 0.35, AXIS_DASH, AXIS_GAP),
      casing: casingAxis,
    };
    this.styleTick = { core: this.makeLineMaterial(GUIDE_CORE_COLOR, 1, 0.6), casing: casingSolid };

    // Dashed LineMaterials read per-segment distance attributes; computing
    // them once per shared unit geometry serves every line posed from it.
    new Line2(this.unitRing, this.styleUmbra.core).computeLineDistances();
    new Line2(this.unitSegment, this.styleUmbra.core).computeLineDistances();

    // Same visual language as before: parent shadow warm-dark, moon shadow
    // cool-dark; umbra denser than penumbra.
    this.parentUmbraRec = this.makeConeRecord(coneMaterial(PARENT_FILL_COLOR, 0.16), this.styleUmbra);
    this.parentPenumbraRec = this.makeConeRecord(coneMaterial(PARENT_FILL_COLOR, 0.07), this.stylePenumbra);
    this.moonUmbraRec = this.makeConeRecord(coneMaterial(MOON_FILL_COLOR, 0.18), this.styleUmbra);
    this.moonPenumbraRec = this.makeConeRecord(coneMaterial(MOON_FILL_COLOR, 0.08), this.stylePenumbra);
    this.coneRecords = [
      this.parentUmbraRec,
      this.parentPenumbraRec,
      this.moonUmbraRec,
      this.moonPenumbraRec,
    ];

    this.parentAxisLine = new GuideLine(this.unitSegment, this.styleAxis);
    this.guidesGroup.add(this.parentAxisLine.group);
    this.slots = [this.makeSlot(), this.makeSlot()];

    this.guidesGroup.visible = false;
    this.root.add(this.guidesGroup);
  }

  private makeLineMaterial(
    color: number,
    widthPx: number,
    opacity: number,
    dashSize?: number,
    gapSize?: number,
  ): LineMaterial {
    const material = new LineMaterial({
      color,
      linewidth: widthPx,
      opacity,
      transparent: true,
      depthWrite: false,
      dashed: dashSize !== undefined,
      dashSize: dashSize ?? 1,
      gapSize: gapSize ?? 0,
    });
    this.lineLensUniforms.push(augmentFixedScreenLineForLens(material));
    this.lineMaterials.push(material);
    return material;
  }

  private makeConeRecord(material: THREE.MeshBasicMaterial, style: GuideStyle): ConeRecord {
    const fill = new THREE.Mesh(this.unitCone, material);
    fill.visible = false;
    const edgeA = new GuideLine(this.unitSegment, style);
    const edgeB = new GuideLine(this.unitSegment, style);
    this.guidesGroup.add(fill, edgeA.group, edgeB.group);
    return {
      posed: false,
      fill,
      edgeA,
      edgeB,
      apexAU: new THREE.Vector3(),
      axisUnit: new THREE.Vector3(),
      halfAngleRad: 0,
      axialLengthAU: 0,
      shadowMinAxialAU: 0,
      minorRatio: 1,
      majorUnit: new THREE.Vector3(1, 0, 0),
    };
  }

  private makeSlot(): GuideSlot {
    const slot: GuideSlot = {
      name: null,
      orbitNormal: new THREE.Vector3(0, 1, 0),
      ringUmbra: new GuideLine(this.unitRing, this.styleUmbra),
      ringPenumbra: new GuideLine(this.unitRing, this.stylePenumbra),
      crossingTick: new GuideLine(this.unitSegment, this.styleTick),
      transitAxis: new GuideLine(this.unitSegment, this.styleAxis),
      footprintUmbra: new GuideLine(this.unitRing, this.styleUmbra),
      footprintPenumbra: new GuideLine(this.unitRing, this.stylePenumbra),
      tipTick: new GuideLine(this.unitSegment, this.styleTick),
      footprintPosed: false,
      footprintRingsVisible: false,
      reticleActive: false,
      hitDirUnit: new THREE.Vector3(),
      hitPosAU: new THREE.Vector3(),
      footprintRadiusAU: 0,
    };
    this.guidesGroup.add(
      slot.ringUmbra.group,
      slot.ringPenumbra.group,
      slot.crossingTick.group,
      slot.transitAxis.group,
      slot.footprintUmbra.group,
      slot.footprintPenumbra.group,
      slot.tipTick.group,
    );
    return slot;
  }

  /** Parent the visuals into a moon-system group (parent planet at local origin). */
  attach(systemGroup: THREE.Group): void {
    this.detach();
    systemGroup.add(this.root);
    // New system, new gates: resolvability hysteresis must not carry over.
    this.parentEdgesResolvable = false;
    this.moonEdgesResolvable = false;
    for (const slot of this.slots) slot.footprintRingsVisible = false;
  }

  detach(): void {
    this.root.removeFromParent();
    for (const spot of this.spots.values()) spot.visible = false;
    for (const slot of this.slots) slot.reticleActive = false;
  }

  setGuidesVisible(visible: boolean): void {
    if (visible && !this.guidesVisible) {
      // The camera pass skips hidden guides, so band state from before the
      // toggle-off is stale — re-enabling starts the hysteresis fresh.
      this.parentEdgesResolvable = false;
      this.moonEdgesResolvable = false;
      for (const slot of this.slots) slot.footprintRingsVisible = false;
    }
    this.guidesVisible = visible;
    this.guidesGroup.visible = visible;
  }

  /**
   * Re-pose the world-space visuals for the current frame. `parentWorldPosAU`
   * is the parent's heliocentric position (Sun at world origin); each moon
   * mesh's `position` is its parent-relative offset in AU — both straight
   * from the render path, so the guides match the drawn scene by
   * construction. `guideSlots` names the moons the guides follow (camera
   * work — silhouette edges, footprint collapse — happens later in
   * updateCameraGuides, after the frame's camera is final).
   */
  update(
    parentWorldPosAU: { x: number; y: number; z: number },
    parentName: string,
    parentRadiusKm: number,
    moons: MoonMesh[],
    landedMoonName: string | null,
    farthestMoonReachAU: number,
    guideSlots: readonly GuideSlotInput[],
  ): void {
    this.resetFrame(landedMoonName);

    const axis = this.tmpAxis.set(parentWorldPosAU.x, parentWorldPosAU.y, parentWorldPosAU.z);
    const parentDistAU = axis.length();
    if (parentDistAU <= 0) return;
    axis.divideScalar(parentDistAU); // anti-sunward shadow axis

    // Effective occluding radius (Earth: Danjon-enlarged) so drawn cones and
    // rings agree with the engine's classification and moon dimming.
    const parentEffRadiusKm = parentRadiusKm * occluderEnlargement(parentName);
    this.parentRadiusEffAU = parentEffRadiusKm / KM_PER_AU;
    // A flattened parent (astronomy/bodyShape, scene axes like this group):
    // its cones and eclipse rings are the outline the Sun sees, its spots and
    // footprints sit on its true surface.
    const parentShape = bodyShape(parentName);

    if (this.guidesVisible) {
      this.poseConePair(
        this.parentUmbraRec,
        this.parentPenumbraRec,
        this.tmpOrigin.set(0, 0, 0),
        axis,
        parentDistAU,
        parentEffRadiusKm,
        farthestMoonReachAU,
        parentShape,
      );
      for (let s = 0; s < this.slots.length; s++) {
        const input = guideSlots[s];
        const slot = this.slots[s];
        const name = input?.name ?? null;
        if (slot.name !== name) {
          slot.name = name;
          slot.footprintRingsVisible = false;
        }
        if (name && input) slot.orbitNormal.copy(input.orbitNormal);
      }
    }

    const parentRadiusAU = parentRadiusKm / KM_PER_AU;
    let maxRingDistAU = 0;
    let moonConesPosed = false;
    for (const m of moons) {
      const spot = this.ensureSpot(m.data.name);
      if (!m.mesh.visible) {
        spot.visible = false;
        continue;
      }
      const offset = m.mesh.position;
      const moonHelio = this.tmpHelio
        .set(parentWorldPosAU.x, parentWorldPosAU.y, parentWorldPosAU.z)
        .add(offset);
      const moonDistAU = moonHelio.length();
      if (moonDistAU <= 0) {
        spot.visible = false;
        continue;
      }
      const moonAxis = moonHelio.divideScalar(moonDistAU); // moon's anti-sunward axis

      this.poseSpot(spot, offset, moonAxis, moonDistAU, m.data.radiusKm, parentRadiusKm, parentShape);

      if (this.guidesVisible) {
        const slot = this.slotFor(m.data.name);
        if (slot) {
          maxRingDistAU = Math.max(
            maxRingDistAU,
            this.poseEclipseRings(slot, m, axis, parentDistAU, parentEffRadiusKm, parentShape),
          );
          this.poseTransitGuides(slot, m, moonAxis, moonDistAU, parentRadiusAU, parentShape);
        }
      }

      if (this.guidesVisible && m.data.name === landedMoonName) {
        this.landedMoonOffsetAU.copy(offset);
        this.landedMoonRadiusAU = m.data.radiusAU;
        // Near-syzygy gate: pose the landed moon's cones only when its shadow
        // axis passes within a few parent radii of the parent's center.
        const along = -offset.dot(moonAxis); // distance from moon to closest approach
        const missSq = offset.lengthSq() - along * along;
        const gateAU = (MOON_CONE_GATE_RADII * parentRadiusKm) / KM_PER_AU;
        if (along > 0 && missSq < gateAU * gateAU) {
          this.poseConePair(
            this.moonUmbraRec,
            this.moonPenumbraRec,
            offset,
            moonAxis,
            moonDistAU,
            m.data.radiusKm,
            offset.length() * 1.5,
          );
          moonConesPosed = true;
        }
      }
    }
    if (!moonConesPosed) {
      this.moonUmbraRec.fill.visible = false;
      this.moonPenumbraRec.fill.visible = false;
    }

    if (this.guidesVisible) {
      // Anti-sun axis: from inside the planet (the mesh occludes that part,
      // so it emerges from the limb) out past the guided rings — or across
      // the system's reach when nothing is guided.
      const axisEndAU = maxRingDistAU > 0 ? maxRingDistAU * 1.15 : farthestMoonReachAU * 0.9;
      this.tmpSegA.set(0, 0, 0);
      this.tmpSegB.copy(axis).multiplyScalar(axisEndAU);
      this.parentAxisLine.setSegment(this.tmpSegA, this.tmpSegB);
    }
  }

  /** Hide every per-frame guide and clear pose records; update() re-poses. */
  private resetFrame(landedMoonName: string | null): void {
    for (const rec of this.coneRecords) {
      rec.posed = false;
      rec.fill.visible = false;
      rec.edgeA.hide();
      rec.edgeB.hide();
    }
    this.parentAxisLine.hide();
    for (const slot of this.slots) {
      slot.footprintPosed = false;
      slot.reticleActive = false;
      slot.ringUmbra.hide();
      slot.ringPenumbra.hide();
      slot.crossingTick.hide();
      slot.transitAxis.hide();
      slot.footprintUmbra.hide();
      slot.footprintPenumbra.hide();
      slot.tipTick.hide();
    }
    if (landedMoonName !== this.lastLandedMoonName) {
      this.lastLandedMoonName = landedMoonName;
      this.moonEdgesResolvable = false;
    }
  }

  private slotFor(moonName: string): GuideSlot | null {
    for (const slot of this.slots) {
      if (slot.name === moonName) return slot;
    }
    return null;
  }

  /**
   * Eclipse-kind guides: umbra + penumbra cross-section rings where this
   * moon's orbit crosses the parent's shadow axis, plus the orbit-crossing
   * tick at the orbit point nearest the axis. The tick's distance from the
   * rings is the real miss geometry — in eclipse season it rides the rings,
   * out of season it floats off them by periapsis·sin β. Returns the ring
   * distance along the axis (AU; 0 when nothing was posed). The crossing
   * distance reads the moon's current orbital radius — the circular-orbit
   * reading; a high-e moon's true crossing radius can differ.
   */
  private poseEclipseRings(
    slot: GuideSlot,
    moon: MoonMesh,
    axis: THREE.Vector3,
    parentDistAU: number,
    parentEffRadiusKm: number,
    parentShape: SpheroidShape,
  ): number {
    const offset = moon.mesh.position;
    const orbitRadiusAU = offset.length();
    if (orbitRadiusAU <= 0) return 0;
    const orbitNormal = slot.orbitNormal;
    const sinBeta = axis.dot(orbitNormal);
    const axisInOrbitPlane = this.tmpAxisInOrbitPlane.copy(axis).addScaledVector(orbitNormal, -sinBeta);
    const wLen = axisInOrbitPlane.length();
    // Pole-on (axis ⊥ orbit plane): the orbit never approaches the shadow
    // axis — there is no crossing to mark. Drawing anything here would be a
    // fabrication; resetFrame already hid the rings and tick.
    if (wLen <= 1e-6) return 0;
    // Orbit-crossing axial distance r·cos β.
    const ringDistAU = orbitRadiusAU * wLen;

    computeShadowConeProfileKm(
      parentEffRadiusKm,
      parentDistAU * KM_PER_AU,
      ringDistAU * KM_PER_AU,
      this.profileScratch,
    );
    const penumbraAU = this.profileScratch.penumbraRadiusKm / KM_PER_AU;
    // Past the apex |radius| is the antumbra boundary — same convention as
    // the transit footprint rings.
    const umbraAbsAU = Math.abs(this.profileScratch.umbraRadiusKm) / KM_PER_AU;

    this.tmpRingCenter.copy(axis).multiplyScalar(ringDistAU);
    if (parentShape.flattening > 0 && this.outlineAxes(axis, parentEffRadiusKm, parentShape)) {
      // The cross-section of a flattened parent's shadow: an ellipse, its
      // minor axis along the projected pole, each axis the cone of that radius.
      const majorPenumbraAU = penumbraAU;
      const majorUmbraAU = umbraAbsAU;
      computeShadowConeProfileKm(this.outlineMinorKm, parentDistAU * KM_PER_AU, ringDistAU * KM_PER_AU, this.profileScratch);
      const minorPenumbraAU = this.profileScratch.penumbraRadiusKm / KM_PER_AU;
      const minorUmbraAU = Math.abs(this.profileScratch.umbraRadiusKm) / KM_PER_AU;
      slot.ringPenumbra.setEllipse(this.tmpRingCenter, axis, this.outlineMajorUnit, majorPenumbraAU, minorPenumbraAU);
      if (majorUmbraAU > 1e-12 && minorUmbraAU > 1e-12) {
        slot.ringUmbra.setEllipse(this.tmpRingCenter, axis, this.outlineMajorUnit, majorUmbraAU, minorUmbraAU);
      }
    } else {
      slot.ringPenumbra.setRing(this.tmpRingCenter, axis, penumbraAU);
      if (umbraAbsAU > 1e-12) slot.ringUmbra.setRing(this.tmpRingCenter, axis, umbraAbsAU);
    }

    const syzygy = this.tmpSyzygy.copy(axisInOrbitPlane).divideScalar(wLen).multiplyScalar(orbitRadiusAU);
    const tickDir = this.tmpTickDir.crossVectors(orbitNormal, syzygy).normalize();
    const halfLenAU = penumbraAU * 0.35;
    this.tmpSegA.copy(syzygy).addScaledVector(tickDir, -halfLenAU);
    this.tmpSegB.copy(syzygy).addScaledVector(tickDir, halfLenAU);
    slot.crossingTick.setSegment(this.tmpSegA, this.tmpSegB);
    return ringDistAU;
  }

  /**
   * Transit-kind guides: the moon's shadow axis down to its surface
   * footprint, true footprint rings around the spot (umbra solid — past the
   * apex the |radius| ring is the annular zone boundary, still a sharp real
   * edge), and the umbra-tip tick when the apex hangs above the surface
   * (annular events announce themselves before any ring resolves near-in).
   *
   * When the axis misses the disc but the shadow still touches it (a grazing
   * partial — the engine's event window: miss < penumbra + parent radius),
   * the rings degrade to the true cone cross-sections at the axis' closest
   * approach, floating past the limb exactly where the shadow clips it, and
   * the axis runs on past the planet so the miss reads as a miss — the same
   * degradation idiom as shadowAxisSurfacePoint. The filled spot stays
   * hit-only (a grazing penumbra's real surface shading is next to
   * invisible); the guides are what point at it.
   */
  private poseTransitGuides(
    slot: GuideSlot,
    moon: MoonMesh,
    moonAxis: THREE.Vector3,
    moonDistAU: number,
    parentRadiusAU: number,
    parentShape: SpheroidShape,
  ): void {
    const offset = moon.mesh.position;
    const tHitAU = shadowAxisSphereHitAU(offset, moonAxis, parentRadiusAU, parentShape);
    const tNearAU = tHitAU ?? -offset.dot(moonAxis);
    if (tNearAU <= 0) return;

    computeShadowConeProfileKm(
      moon.data.radiusKm,
      moonDistAU * KM_PER_AU,
      tNearAU * KM_PER_AU,
      this.profileScratch,
    );
    const penumbraAU = this.profileScratch.penumbraRadiusKm / KM_PER_AU;
    const umbraAbsAU = Math.abs(this.profileScratch.umbraRadiusKm) / KM_PER_AU;
    // Shadow wider than most of the disc: flat rings stop being a footprint
    // (the clamped spot already covers the cap) — guides bow out.
    if (penumbraAU > parentRadiusAU * 0.85) return;

    if (tHitAU !== null) {
      // Same sagitta lift as the spot, so rings and spot sit on one shell.
      const sagittaAU =
        parentRadiusAU - Math.sqrt(Math.max(parentRadiusAU * parentRadiusAU - penumbraAU * penumbraAU, 0));
      const hitPos = slot.hitPosAU;
      const dir = this.surfacePose(offset, moonAxis, tHitAU, parentRadiusAU, sagittaAU * 1.2, parentShape, hitPos);

      slot.footprintPenumbra.setRing(hitPos, dir, penumbraAU);
      if (umbraAbsAU > 1e-12) slot.footprintUmbra.setRing(hitPos, dir, umbraAbsAU);

      this.tmpSegA.copy(offset).addScaledVector(moonAxis, -0.35 * tHitAU);
      slot.transitAxis.setSegment(this.tmpSegA, hitPos);
      slot.hitDirUnit.copy(dir);
    } else {
      const closePos = slot.hitPosAU.copy(offset).addScaledVector(moonAxis, tNearAU);
      const closeLengthAU = closePos.length();
      const surfaceAU = parentShape.flattening > 0 && closeLengthAU > 0
        ? spheroidRadiusToward(closePos.x / closeLengthAU, closePos.y / closeLengthAU, closePos.z / closeLengthAU, parentRadiusAU, parentShape)
        : parentRadiusAU;
      if (closeLengthAU >= surfaceAU + penumbraAU) return;

      slot.footprintPenumbra.setRing(closePos, moonAxis, penumbraAU);
      if (umbraAbsAU > 1e-12) slot.footprintUmbra.setRing(closePos, moonAxis, umbraAbsAU);

      this.tmpSegA.copy(offset).addScaledVector(moonAxis, -0.35 * tNearAU);
      this.tmpSegB.copy(offset).addScaledVector(moonAxis, 1.35 * tNearAU);
      slot.transitAxis.setSegment(this.tmpSegA, this.tmpSegB);
      slot.hitDirUnit.copy(closePos).normalize();
    }

    const apexAU = this.profileScratch.umbraLengthKm / KM_PER_AU;
    if (apexAU < tNearAU) {
      const tickDir = this.tmpTickDir.crossVectors(slot.orbitNormal, moonAxis);
      if (tickDir.lengthSq() > 1e-12) {
        tickDir.normalize();
        const halfLenAU = moon.data.radiusAU * 0.8;
        this.tmpSegA.copy(offset).addScaledVector(moonAxis, apexAU);
        this.tmpSegB.copy(this.tmpSegA).addScaledVector(tickDir, halfLenAU);
        this.tmpSegA.addScaledVector(tickDir, -halfLenAU);
        slot.tipTick.setSegment(this.tmpSegA, this.tmpSegB);
      }
    }

    slot.footprintPosed = true;
    slot.footprintRadiusAU = penumbraAU;
  }

  /**
   * Camera-dependent pass — run after the frame's camera is final (the
   * surface camera re-pins late): cone silhouette edges with their
   * resolvability gates, inside-a-cone fill suppression, footprint
   * rings-vs-reticle collapse, and the px-width line resolution uniforms.
   * `cameraLocalAU` is the camera position in this system's parent-centered
   * frame. `displayFovDeg` is the fov the viewer actually sees — the lens pass
   * keeps the overscan in `camera.fov`, so the occluder gates below size their
   * discs from this angle and never from the camera's own field.
   */
  updateCameraGuides(
    cameraLocalAU: THREE.Vector3,
    systemWorldPosition: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    viewportWidthPx: number,
    viewportHeightPx: number,
    displayFovDeg: number,
  ): void {
    for (let i = 0; i < this.lineMaterials.length; i++) {
      const material = this.lineMaterials[i];
      material.resolution.set(viewportWidthPx, viewportHeightPx);
      applyLensShaderUniforms(
        this.lineLensUniforms[i],
        camera,
        viewportWidthPx,
        viewportHeightPx,
      );
    }
    if (!this.guidesVisible) return;

    // Both occluder gates ask "is this body big enough on screen for its edges
    // to read", so both size the disc analytically from camera distance — the
    // question still has an answer when the body is outside the frustum, where a
    // measured footprint reads 0 px and would blink the edges off. The lens
    // rescales an in-frustum disc slightly; the 8/6 px hysteresis in
    // resolveGuideVisibility absorbs that, whereas a measured/analytic hybrid
    // would step exactly at the frustum boundary — the blink itself.
    const parentDiscPx = discDiameterPx(
      this.parentRadiusEffAU,
      cameraLocalAU.length(),
      displayFovDeg,
      viewportHeightPx,
    );
    this.parentEdgesResolvable = resolveGuideVisibility(parentDiscPx, this.parentEdgesResolvable);
    this.poseConeEdges(this.parentUmbraRec, this.parentEdgesResolvable, cameraLocalAU);
    this.poseConeEdges(this.parentPenumbraRec, this.parentEdgesResolvable, cameraLocalAU);

    if (this.moonUmbraRec.posed) {
      const moonDiscPx = discDiameterPx(
        this.landedMoonRadiusAU,
        cameraLocalAU.distanceTo(this.landedMoonOffsetAU),
        displayFovDeg,
        viewportHeightPx,
      );
      this.moonEdgesResolvable = resolveGuideVisibility(moonDiscPx, this.moonEdgesResolvable);
    }
    this.poseConeEdges(this.moonUmbraRec, this.moonEdgesResolvable, cameraLocalAU);
    this.poseConeEdges(this.moonPenumbraRec, this.moonEdgesResolvable, cameraLocalAU);

    for (const slot of this.slots) {
      if (!slot.footprintPosed) {
        slot.reticleActive = false;
        // No footprint = no transit in progress: drop the band state so the
        // next transit (possibly much later, from elsewhere) starts fresh.
        slot.footprintRingsVisible = false;
        continue;
      }
      // The footprint ring keeps the MEASURED projection: it is a ring lying on
      // the parent's surface, not a sphere seen from outside, so the tangent
      // form would not describe it. It is also always in view when it matters —
      // the reticle handoff below only runs for a camera-facing spot.
      const ringPx = projectSphereToScreen(
        this.tmpWorld.copy(systemWorldPosition).add(slot.hitPosAU),
        slot.footprintRadiusAU,
        camera,
        viewportWidthPx,
        viewportHeightPx,
        this.sphereProjection,
      ).diameterPx;
      slot.footprintRingsVisible = resolveGuideVisibility(ringPx, slot.footprintRingsVisible);
      if (!slot.footprintRingsVisible) {
        slot.footprintUmbra.hide();
        slot.footprintPenumbra.hide();
      }
      const facing = this.tmpVec.copy(cameraLocalAU).sub(slot.hitPosAU).dot(slot.hitDirUnit) > 0;
      slot.reticleActive = !slot.footprintRingsVisible && facing;
    }
  }

  /**
   * Where to draw the fixed-px footprint reticle (parent-centered AU), when
   * a guided transit's true rings are collapsed and the spot faces the
   * camera. The reticle is a label, not geometry — the same sub-resolution
   * glyph the surface HUD uses.
   */
  getFootprintReticleLocal(out: THREE.Vector3): boolean {
    if (!this.guidesVisible) return false;
    // One marker, last slot first: slot 1 is the jumped/live event's moon —
    // when two footprints collapse at once (Jupiter double transits), the
    // event the user asked about wins the reticle.
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i];
      if (slot.reticleActive) {
        out.copy(slot.hitPosAU);
        return true;
      }
    }
    return false;
  }

  private poseConeEdges(rec: ConeRecord, resolvable: boolean, cameraLocalAU: THREE.Vector3): void {
    if (!rec.posed) {
      rec.edgeA.hide();
      rec.edgeB.hide();
      return;
    }
    // The silhouette runs even when the occluder is sub-resolution: the edge
    // LINES are gated on resolvability below, but the camera-inside-the-fill
    // test must not be — you can stand in a cone whose occluder shows < 6 px
    // (Mars from near its own umbra tip) and the fill would tint the frame.
    let halfAngleRad = rec.halfAngleRad;
    if (rec.minorRatio < 1) {
      // An elliptical cone's outline, seen from the camera, stands off the
      // axis by the ellipse's support radius across the line of sight: the
      // round cone of that radius has the same silhouette.
      const toCamera = this.tmpVec.copy(cameraLocalAU).sub(rec.apexAU);
      toCamera.addScaledVector(rec.axisUnit, -toCamera.dot(rec.axisUnit));
      const across = this.tmpEdgeEnd.crossVectors(rec.axisUnit, toCamera);
      const acrossLength = across.length();
      if (acrossLength > 0) {
        across.divideScalar(acrossLength);
        const alongMajor = across.dot(rec.majorUnit);
        const support = Math.sqrt(alongMajor * alongMajor + rec.minorRatio * rec.minorRatio * (1 - alongMajor * alongMajor));
        halfAngleRad = Math.atan(Math.tan(rec.halfAngleRad) * support);
      }
    }
    const status = computeConeSilhouette(
      rec.apexAU,
      rec.axisUnit,
      halfAngleRad,
      cameraLocalAU,
      this.tmpEdgeDirA,
      this.tmpEdgeDirB,
    );
    if (status === 'inside') {
      // Inside the nappe there is no silhouette. The fill goes too — but only
      // when the camera is inside the *shadow* span of the cone, where the
      // fill would tint the whole frame. The infinite nappe is wider than the
      // shadow: a camera in the penumbra's sunward pinch gap (or past the
      // umbra's base plane) sits in daylight with the cone plainly in view.
      const dAxialAU = this.tmpVec.copy(cameraLocalAU).sub(rec.apexAU).dot(rec.axisUnit);
      if (dAxialAU >= rec.shadowMinAxialAU && dAxialAU <= rec.axialLengthAU) {
        rec.fill.visible = false;
      }
    }
    if (status !== 'edges' || !resolvable) {
      rec.edgeA.hide();
      rec.edgeB.hide();
      return;
    }
    const generatrixAU = rec.axialLengthAU / Math.cos(halfAngleRad);
    this.tmpEdgeEnd.copy(rec.apexAU).addScaledVector(this.tmpEdgeDirA, generatrixAU);
    rec.edgeA.setSegment(rec.apexAU, this.tmpEdgeEnd);
    this.tmpEdgeEnd.copy(rec.apexAU).addScaledVector(this.tmpEdgeDirB, generatrixAU);
    rec.edgeB.setSegment(rec.apexAU, this.tmpEdgeEnd);
  }

  /**
   * Pose an occluder's umbra + penumbra cone fills and record their geometry
   * for the edge pass. Umbra: apex at the umbra tip, opening back to the
   * occluder's radius. Penumbra: apex at the pinch point sunward of the
   * occluder, opening anti-sunward past the system (capped — the true
   * penumbra is unbounded).
   */
  private poseConePair(
    recUmbra: ConeRecord,
    recPenumbra: ConeRecord,
    originAU: THREE.Vector3,
    axis: THREE.Vector3,
    sunDistAU: number,
    occluderRadiusKm: number,
    reachAU: number,
    occluderShape?: SpheroidShape,
  ): void {
    // A flattened occluder casts an elliptical cone: the minor radius along
    // the projected pole, scaled about the equatorial radius's apex. Against
    // the engine's cone of each direction's own apex that is tens of km off
    // at the moons' distances, on a cone tens of thousands across.
    const elliptical = occluderShape !== undefined && occluderShape.flattening > 0
      && this.outlineAxes(axis, occluderRadiusKm, occluderShape);
    const minorRatio = elliptical ? this.outlineMinorKm / occluderRadiusKm : 1;
    recUmbra.minorRatio = minorRatio;
    recPenumbra.minorRatio = minorRatio;
    if (elliptical) {
      recUmbra.majorUnit.copy(this.outlineMajorUnit);
      recPenumbra.majorUnit.copy(this.outlineMajorUnit);
    }
    computeShadowConeProfileKm(occluderRadiusKm, sunDistAU * KM_PER_AU, 0, this.profileScratch);
    const radiusAU = occluderRadiusKm / KM_PER_AU;
    const umbraLenAU = this.profileScratch.umbraLengthKm / KM_PER_AU;
    const pinchAU = this.profileScratch.pinchKm / KM_PER_AU;

    const umbra = recUmbra.fill;
    umbra.position.copy(originAU).addScaledVector(axis, umbraLenAU);
    if (elliptical) this.orientEllipticalCone(umbra, this.tmpVec.copy(axis).negate());
    else umbra.quaternion.setFromUnitVectors(UP, this.tmpVec.copy(axis).negate());
    umbra.scale.set(radiusAU, umbraLenAU, radiusAU * minorRatio);
    umbra.visible = true;
    recUmbra.posed = true;
    recUmbra.apexAU.copy(originAU).addScaledVector(axis, umbraLenAU);
    recUmbra.axisUnit.copy(axis).negate();
    recUmbra.halfAngleRad = Math.atan(radiusAU / umbraLenAU);
    recUmbra.axialLengthAU = umbraLenAU;
    recUmbra.shadowMinAxialAU = 0; // tip → occluder: the whole span is umbra

    const penLenAU = pinchAU + Math.max(reachAU * 1.25, umbraLenAU);
    const penEndRadiusAU = (radiusAU * penLenAU) / pinchAU;
    const penumbra = recPenumbra.fill;
    penumbra.position.copy(originAU).addScaledVector(axis, -pinchAU);
    if (elliptical) this.orientEllipticalCone(penumbra, axis);
    else penumbra.quaternion.setFromUnitVectors(UP, axis);
    penumbra.scale.set(penEndRadiusAU, penLenAU, penEndRadiusAU * minorRatio);
    penumbra.visible = true;
    recPenumbra.posed = true;
    recPenumbra.apexAU.copy(originAU).addScaledVector(axis, -pinchAU);
    recPenumbra.axisUnit.copy(axis);
    recPenumbra.halfAngleRad = Math.atan(radiusAU / pinchAU);
    recPenumbra.axialLengthAU = penLenAU;
    // Shadow starts at the occluder's center plane; apex → there is the lit
    // sunward pinch gap (the textbook crossing-lines construction).
    recPenumbra.shadowMinAxialAU = pinchAU;
  }

  /**
   * Place a moon's shadow spot on the parent sphere: intersect the shadow
   * axis ray (from the moon, anti-sunward) with the sphere at local origin,
   * size the disc to the penumbra radius there, and lift it off the surface
   * by its own sagitta so the flat disc doesn't pierce the curvature. The
   * disc's fill is radially graded (see SPOT_FRAGMENT), not uniform. The
   * 0.9·parentRadius cap is a degenerate-case guard (a flat disc stops
   * approximating a hemispheric cap) — no catalog moon reaches it; if one
   * ever did, the drawn spot would under-read the true penumbra.
   */
  private poseSpot(
    spot: THREE.Mesh,
    moonOffsetAU: THREE.Vector3,
    moonAxis: THREE.Vector3,
    moonSunDistAU: number,
    moonRadiusKm: number,
    parentRadiusKm: number,
    parentShape: SpheroidShape,
  ): void {
    const parentRadiusAU = parentRadiusKm / KM_PER_AU;
    // Near-surface hit along the shadow ray — same helper the surface-view
    // vantage stands on, so the spot and the observer agree by construction.
    const tAU = shadowAxisSphereHitAU(moonOffsetAU, moonAxis, parentRadiusAU, parentShape);
    if (tAU === null) {
      spot.visible = false;
      return;
    }

    computeShadowConeProfileKm(
      moonRadiusKm,
      moonSunDistAU * KM_PER_AU,
      tAU * KM_PER_AU,
      this.profileScratch,
    );
    const spotRadiusAU = Math.min(
      this.profileScratch.penumbraRadiusKm / KM_PER_AU,
      parentRadiusAU * 0.9,
    );

    // Grade the disc like the real footprint: the flat-dark core spans |umbra|
    // (antumbra when negative) as a fraction of the drawn radius, and the core's
    // darkness is the Sun-cover fraction on the axis — 1 once the umbra reaches
    // the surface, (moon/Sun angular-size ratio)² inside an antumbra.
    const umbKm = this.profileScratch.umbraRadiusKm;
    const penKm = this.profileScratch.penumbraRadiusKm;
    const uniforms = (spot.material as THREE.ShaderMaterial).uniforms;
    uniforms.uInnerFrac.value = Math.min(Math.abs(umbKm) / (spotRadiusAU * KM_PER_AU), 1);
    // (pen+umb)/(pen−umb) = moonAngRadius/sunAngRadius at the hit point.
    const ratio = (penKm + umbKm) / Math.max(penKm - umbKm, 1e-9);
    uniforms.uCoreCover.value = umbKm >= 0 ? 1 : ratio * ratio;

    const sagittaAU =
      parentRadiusAU - Math.sqrt(Math.max(parentRadiusAU * parentRadiusAU - spotRadiusAU * spotRadiusAU, 0));
    const dir = this.surfacePose(moonOffsetAU, moonAxis, tAU, parentRadiusAU, sagittaAU * 1.2, parentShape, spot.position);
    spot.quaternion.setFromUnitVectors(FORWARD, dir);
    spot.scale.setScalar(spotRadiusAU);
    spot.visible = true;
  }

  /**
   * Where a shadow axis meets the parent, lifted off the ground by the flat
   * disc's sagitta lift plus a 0.2% skin: written into `outPos`, and the unit
   * surface normal there returned (in this.tmpVec). On a sphere that is the
   * radial direction and the lift is from the centre, as it always was; on a
   * flattened parent it is the spheroid's normal at the true hit.
   */
  private surfacePose(
    offsetAU: THREE.Vector3,
    axis: THREE.Vector3,
    tAU: number,
    parentRadiusAU: number,
    sagittaLiftAU: number,
    parentShape: SpheroidShape,
    outPos: THREE.Vector3,
  ): THREE.Vector3 {
    const dir = this.tmpVec.copy(offsetAU).addScaledVector(axis, tAU);
    if (parentShape.flattening === 0) {
      dir.normalize();
      outPos.copy(dir).multiplyScalar(parentRadiusAU + sagittaLiftAU + parentRadiusAU * 0.002);
      return dir;
    }
    outPos.copy(dir);
    spheroidNormal(dir.x, dir.y, dir.z, parentShape, dir);
    outPos.addScaledVector(dir, sagittaLiftAU + parentRadiusAU * 0.002);
    return dir;
  }

  /** A flattened occluder's outline along the shadow axis: the minor radius
   *  (km, along the projected pole) into outlineMinorKm and the unit major
   *  direction into outlineMajorUnit. False seen pole-on, where it is round. */
  private outlineAxes(axis: THREE.Vector3, radiusKm: number, shape: SpheroidShape): boolean {
    const major = this.outlineMajorUnit.set(shape.poleX, shape.poleY, shape.poleZ).cross(axis);
    const majorLength = major.length();
    if (majorLength < 1e-9) return false;
    major.divideScalar(majorLength);
    const minor = this.outlineMinorUnit.crossVectors(axis, major);
    this.outlineMinorKm = projectedOutlineRadius(axis.x, axis.y, axis.z, minor.x, minor.y, minor.z, radiusKm, shape);
    return true;
  }

  /** Point the unit cone (opening along +Y) along `coneDir`, its local X on
   *  the outline's major direction so a scale.z of minor/major flattens it. */
  private orientEllipticalCone(cone: THREE.Mesh, coneDir: THREE.Vector3): void {
    const zUnit = this.outlineMinorUnit.crossVectors(this.outlineMajorUnit, coneDir);
    cone.quaternion.setFromRotationMatrix(this.coneBasis.makeBasis(this.outlineMajorUnit, coneDir, zUnit));
  }

  private ensureSpot(moonName: string): THREE.Mesh {
    let spot = this.spots.get(moonName);
    if (!spot) {
      spot = new THREE.Mesh(this.unitDisc, makeSpotMaterial());
      spot.visible = false;
      this.spots.set(moonName, spot);
      this.root.add(spot);
    }
    return spot;
  }

  dispose(): void {
    this.detach();
    this.unitCone.dispose();
    this.unitDisc.dispose();
    this.unitRing.dispose();
    this.unitSegment.dispose();
    for (const rec of this.coneRecords) {
      (rec.fill.material as THREE.Material).dispose();
    }
    for (const material of this.lineMaterials) material.dispose();
    this.lineMaterials.length = 0;
    for (const spot of this.spots.values()) (spot.material as THREE.Material).dispose();
    this.spots.clear();
  }
}
