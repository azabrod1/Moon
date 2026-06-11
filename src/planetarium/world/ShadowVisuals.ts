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
 *
 * Honesty contract (design round D-3): every position, radius and length is
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
 * Caveat (documented in the plan): small moons render with a 5%-of-parent
 * minimum mesh scale in orbit view, so a tiny moon's inflated ball can dwarf
 * its own true-scale guides — Phobos' drawn ball swallows its real ∅59 km
 * footprint rings. The rings and spot are real; the ball isn't. Surface view
 * drops the floor, and there the meshes and guides agree.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { KM_PER_AU } from '../../astronomy/constants';
import {
  computeConeSilhouette,
  computeShadowConeProfileKm,
  occluderEnlargement,
  shadowAxisSphereHitAU,
  type ShadowConeProfile,
} from '../../astronomy/shadows';
import {
  angularDiameterDeg,
  projectedDiscPx,
  resolveGuideVisibility,
} from '../surfaceView';
import type { MoonMesh } from '../PlanetFactory';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1); // CircleGeometry's / unit ring's facing axis
/** Show the landed moon's cones once its shadow axis passes within this many parent radii. */
const MOON_CONE_GATE_RADII = 3;

// Instrument line spec (design round D-3): one neutral core color over a
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

  private spotMaterial: THREE.MeshBasicMaterial;
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
  private tmpHelio = new THREE.Vector3();
  private tmpVec = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();
  private tmpW = new THREE.Vector3();
  private tmpRingCenter = new THREE.Vector3();
  private tmpSyzygy = new THREE.Vector3();
  private tmpTickDir = new THREE.Vector3();
  private tmpSegA = new THREE.Vector3();
  private tmpSegB = new THREE.Vector3();
  private tmpEdgeDirA = new THREE.Vector3();
  private tmpEdgeDirB = new THREE.Vector3();
  private tmpEdgeEnd = new THREE.Vector3();

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
    // cool-dark (D-3 fill tints); umbra denser than penumbra.
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

    this.spotMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
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

    if (this.guidesVisible) {
      this.poseConePair(
        this.parentUmbraRec,
        this.parentPenumbraRec,
        this.tmpOrigin.set(0, 0, 0),
        axis,
        parentDistAU,
        parentEffRadiusKm,
        farthestMoonReachAU,
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

      this.poseSpot(spot, offset, moonAxis, moonDistAU, m.data.radiusKm, parentRadiusKm);

      if (this.guidesVisible) {
        const slot = this.slotFor(m.data.name);
        if (slot) {
          maxRingDistAU = Math.max(
            maxRingDistAU,
            this.poseEclipseRings(slot, m, axis, parentDistAU, parentEffRadiusKm),
          );
          this.poseTransitGuides(slot, m, moonAxis, moonDistAU, parentRadiusAU);
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
    m: MoonMesh,
    axis: THREE.Vector3,
    parentDistAU: number,
    parentEffRadiusKm: number,
  ): number {
    const offset = m.mesh.position;
    const orbitRadiusAU = offset.length();
    if (orbitRadiusAU <= 0) return 0;
    const n = slot.orbitNormal;
    const sinBeta = axis.dot(n);
    const w = this.tmpW.copy(axis).addScaledVector(n, -sinBeta);
    const wLen = w.length();
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
    slot.ringPenumbra.setRing(this.tmpRingCenter, axis, penumbraAU);
    if (umbraAbsAU > 1e-12) slot.ringUmbra.setRing(this.tmpRingCenter, axis, umbraAbsAU);

    const syzygy = this.tmpSyzygy.copy(w).divideScalar(wLen).multiplyScalar(orbitRadiusAU);
    const tickDir = this.tmpTickDir.crossVectors(n, syzygy).normalize();
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
    m: MoonMesh,
    moonAxis: THREE.Vector3,
    moonDistAU: number,
    parentRadiusAU: number,
  ): void {
    const offset = m.mesh.position;
    const tHitAU = shadowAxisSphereHitAU(offset, moonAxis, parentRadiusAU);
    const tNearAU = tHitAU ?? -offset.dot(moonAxis);
    if (tNearAU <= 0) return;

    computeShadowConeProfileKm(
      m.data.radiusKm,
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
      const dir = this.tmpVec.copy(offset).addScaledVector(moonAxis, tHitAU).normalize();
      // Same sagitta lift as the spot, so rings and spot sit on one shell.
      const sagittaAU =
        parentRadiusAU - Math.sqrt(Math.max(parentRadiusAU * parentRadiusAU - penumbraAU * penumbraAU, 0));
      const liftAU = parentRadiusAU + sagittaAU * 1.2 + parentRadiusAU * 0.002;
      const hitPos = slot.hitPosAU.copy(dir).multiplyScalar(liftAU);

      slot.footprintPenumbra.setRing(hitPos, dir, penumbraAU);
      if (umbraAbsAU > 1e-12) slot.footprintUmbra.setRing(hitPos, dir, umbraAbsAU);

      this.tmpSegA.copy(offset).addScaledVector(moonAxis, -0.35 * tHitAU);
      slot.transitAxis.setSegment(this.tmpSegA, hitPos);
      slot.hitDirUnit.copy(dir);
    } else {
      const closePos = slot.hitPosAU.copy(offset).addScaledVector(moonAxis, tNearAU);
      if (closePos.length() >= parentRadiusAU + penumbraAU) return;

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
        const halfLenAU = m.data.radiusAU * 0.8;
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
   * frame.
   */
  updateCameraGuides(
    cameraLocalAU: THREE.Vector3,
    fovYDeg: number,
    viewportWidthPx: number,
    viewportHeightPx: number,
  ): void {
    for (const material of this.lineMaterials) {
      material.resolution.set(viewportWidthPx, viewportHeightPx);
    }
    if (!this.guidesVisible) return;

    const camDistAU = Math.max(cameraLocalAU.length(), 1e-12);
    const parentPx = projectedDiscPx(
      angularDiameterDeg(this.parentRadiusEffAU, camDistAU),
      fovYDeg,
      viewportHeightPx,
    );
    this.parentEdgesResolvable = resolveGuideVisibility(parentPx, this.parentEdgesResolvable);
    this.poseConeEdges(this.parentUmbraRec, this.parentEdgesResolvable, cameraLocalAU);
    this.poseConeEdges(this.parentPenumbraRec, this.parentEdgesResolvable, cameraLocalAU);

    if (this.moonUmbraRec.posed) {
      const moonDistAU = Math.max(cameraLocalAU.distanceTo(this.landedMoonOffsetAU), 1e-12);
      const moonPx = projectedDiscPx(
        angularDiameterDeg(this.landedMoonRadiusAU, moonDistAU),
        fovYDeg,
        viewportHeightPx,
      );
      this.moonEdgesResolvable = resolveGuideVisibility(moonPx, this.moonEdgesResolvable);
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
      const distAU = Math.max(cameraLocalAU.distanceTo(slot.hitPosAU), 1e-12);
      const ringPx = projectedDiscPx(
        angularDiameterDeg(slot.footprintRadiusAU, distAU),
        fovYDeg,
        viewportHeightPx,
      );
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
    const status = computeConeSilhouette(
      rec.apexAU,
      rec.axisUnit,
      rec.halfAngleRad,
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
    const generatrixAU = rec.axialLengthAU / Math.cos(rec.halfAngleRad);
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
  ): void {
    computeShadowConeProfileKm(occluderRadiusKm, sunDistAU * KM_PER_AU, 0, this.profileScratch);
    const radiusAU = occluderRadiusKm / KM_PER_AU;
    const umbraLenAU = this.profileScratch.umbraLengthKm / KM_PER_AU;
    const pinchAU = this.profileScratch.pinchKm / KM_PER_AU;

    const umbra = recUmbra.fill;
    umbra.position.copy(originAU).addScaledVector(axis, umbraLenAU);
    umbra.quaternion.setFromUnitVectors(UP, this.tmpVec.copy(axis).negate());
    umbra.scale.set(radiusAU, umbraLenAU, radiusAU);
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
    penumbra.quaternion.setFromUnitVectors(UP, axis);
    penumbra.scale.set(penEndRadiusAU, penLenAU, penEndRadiusAU);
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
  ): void {
    const parentRadiusAU = parentRadiusKm / KM_PER_AU;
    // Near-surface hit along the shadow ray — same helper the surface-view
    // vantage stands on, so the spot and the observer agree by construction.
    const tAU = shadowAxisSphereHitAU(moonOffsetAU, moonAxis, parentRadiusAU);
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

    const dir = this.tmpVec.copy(moonOffsetAU).addScaledVector(moonAxis, tAU).normalize();
    const sagittaAU =
      parentRadiusAU - Math.sqrt(Math.max(parentRadiusAU * parentRadiusAU - spotRadiusAU * spotRadiusAU, 0));
    spot.position.copy(dir).multiplyScalar(parentRadiusAU + sagittaAU * 1.2 + parentRadiusAU * 0.002);
    spot.quaternion.setFromUnitVectors(FORWARD, dir);
    spot.scale.setScalar(spotRadiusAU);
    spot.visible = true;
  }

  private ensureSpot(moonName: string): THREE.Mesh {
    let spot = this.spots.get(moonName);
    if (!spot) {
      spot = new THREE.Mesh(this.unitDisc, this.spotMaterial);
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
    this.spotMaterial.dispose();
    this.spots.clear();
  }
}
