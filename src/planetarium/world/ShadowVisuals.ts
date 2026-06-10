/**
 * True-scale shadow visuals for the landed moon system: the parent planet's
 * umbra/penumbra cones (+ the landed moon's own cones near syzygy) behind the
 * Sky panel's "shadow cones" toggle, and always-on transit shadow spots — the
 * classic Io dot crawling across Jupiter, or the Moon's shadow on Earth during
 * a solar eclipse. Everything lives in the parent's moon-system group (parent
 * at local origin, AU units), so the floating origin is free. Cone radii come
 * from the same closed forms as the shadow engine (shadows.ts); meshes are
 * shared unit geometry, re-posed per frame with zero allocations.
 *
 * Caveat (documented in the plan): small moons render with a 5%-of-parent
 * minimum mesh scale, so a tiny moon's mesh can dwarf its true-scale cones —
 * the cones are real, some meshes aren't.
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../../astronomy/constants';
import { occluderEnlargement } from '../../astronomy/shadows';
import { KM_CONSTANTS } from '../../shared/constants/physicalData';
import type { MoonMesh } from '../PlanetFactory';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1); // CircleGeometry's facing axis
/** Show the landed moon's cones once its shadow axis passes within this many parent radii. */
const MOON_CONE_GATE_RADII = 3;

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
  private conesGroup = new THREE.Group();

  // Unit cone: apex at y=0 opening to radius 1 at y=1 — posed via scale(R, L, R).
  private unitCone: THREE.BufferGeometry;
  private unitDisc: THREE.BufferGeometry;

  private parentUmbra: THREE.Mesh;
  private parentPenumbra: THREE.Mesh;
  private moonUmbra: THREE.Mesh;
  private moonPenumbra: THREE.Mesh;
  private spotMaterial: THREE.MeshBasicMaterial;
  private spots = new Map<string, THREE.Mesh>();

  private conesVisible = false;

  private tmpAxis = new THREE.Vector3();
  private tmpHelio = new THREE.Vector3();
  private tmpVec = new THREE.Vector3();
  private tmpOrigin = new THREE.Vector3();

  constructor() {
    const cone = new THREE.CylinderGeometry(1, 0, 1, 48, 1, true);
    cone.translate(0, 0.5, 0);
    this.unitCone = cone;
    this.unitDisc = new THREE.CircleGeometry(1, 48);

    // Same visual language as the Moon view's cones: parent shadow dark red,
    // moon shadow dark blue; umbra denser than penumbra.
    this.parentUmbra = new THREE.Mesh(this.unitCone, coneMaterial(0x331111, 0.16));
    this.parentPenumbra = new THREE.Mesh(this.unitCone, coneMaterial(0x331111, 0.07));
    this.moonUmbra = new THREE.Mesh(this.unitCone, coneMaterial(0x111133, 0.2));
    this.moonPenumbra = new THREE.Mesh(this.unitCone, coneMaterial(0x111133, 0.08));
    this.conesGroup.add(this.parentUmbra, this.parentPenumbra, this.moonUmbra, this.moonPenumbra);
    this.conesGroup.visible = false;
    this.root.add(this.conesGroup);

    this.spotMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
  }

  /** Parent the visuals into a moon-system group (parent planet at local origin). */
  attach(systemGroup: THREE.Group): void {
    this.detach();
    systemGroup.add(this.root);
  }

  detach(): void {
    this.root.removeFromParent();
    for (const spot of this.spots.values()) spot.visible = false;
  }

  setConesVisible(visible: boolean): void {
    this.conesVisible = visible;
    this.conesGroup.visible = visible;
  }

  /**
   * Re-pose everything for the current frame. `parentWorldPosAU` is the
   * parent's heliocentric position (Sun at world origin); each moon mesh's
   * `position` is its parent-relative offset in AU — both straight from the
   * render path, so the cones/spots match the drawn scene by construction.
   */
  update(
    parentWorldPosAU: { x: number; y: number; z: number },
    parentName: string,
    parentRadiusKm: number,
    moons: MoonMesh[],
    landedMoonName: string | null,
    farthestMoonReachAU: number,
  ): void {
    const axis = this.tmpAxis.set(parentWorldPosAU.x, parentWorldPosAU.y, parentWorldPosAU.z);
    const parentDistAU = axis.length();
    if (parentDistAU <= 0) return;
    axis.divideScalar(parentDistAU); // anti-sunward shadow axis

    if (this.conesVisible) {
      this.poseConePair(
        this.parentUmbra,
        this.parentPenumbra,
        this.tmpOrigin.set(0, 0, 0),
        axis,
        parentDistAU,
        // Effective occluding radius (Earth: Danjon-enlarged) so the drawn
        // cones agree with the engine's classification and moon dimming.
        parentRadiusKm * occluderEnlargement(parentName),
        farthestMoonReachAU,
      );
    }

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

      if (this.conesVisible && m.data.name === landedMoonName) {
        // Near-syzygy gate: pose the landed moon's cones only when its shadow
        // axis passes within a few parent radii of the parent's center.
        const along = -offset.dot(moonAxis); // distance from moon to closest approach
        const missSq = offset.lengthSq() - along * along;
        const gateAU = (MOON_CONE_GATE_RADII * parentRadiusKm) / KM_PER_AU;
        if (along > 0 && missSq < gateAU * gateAU) {
          this.poseConePair(
            this.moonUmbra,
            this.moonPenumbra,
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
    this.moonUmbra.visible = moonConesPosed;
    this.moonPenumbra.visible = moonConesPosed;
  }

  /**
   * Pose an occluder's umbra + penumbra cones. Umbra: apex at the umbra tip,
   * opening back to the occluder's radius. Penumbra: apex at the pinch point
   * sunward of the occluder, opening anti-sunward past the system (capped —
   * the true penumbra is unbounded).
   */
  private poseConePair(
    umbra: THREE.Mesh,
    penumbra: THREE.Mesh,
    originAU: THREE.Vector3,
    axis: THREE.Vector3,
    sunDistAU: number,
    occluderRadiusKm: number,
    reachAU: number,
  ): void {
    const sunRadiusKm = KM_CONSTANTS.SUN_RADIUS;
    const sunDistKm = sunDistAU * KM_PER_AU;
    const radiusAU = occluderRadiusKm / KM_PER_AU;
    const umbraLenAU = (occluderRadiusKm * sunDistKm) / (sunRadiusKm - occluderRadiusKm) / KM_PER_AU;
    const pinchAU = (occluderRadiusKm * sunDistKm) / (sunRadiusKm + occluderRadiusKm) / KM_PER_AU;

    umbra.position.copy(originAU).addScaledVector(axis, umbraLenAU);
    umbra.quaternion.setFromUnitVectors(UP, this.tmpVec.copy(axis).negate());
    umbra.scale.set(radiusAU, umbraLenAU, radiusAU);

    const penLenAU = pinchAU + Math.max(reachAU * 1.25, umbraLenAU);
    const penEndRadiusAU = (radiusAU * penLenAU) / pinchAU;
    penumbra.position.copy(originAU).addScaledVector(axis, -pinchAU);
    penumbra.quaternion.setFromUnitVectors(UP, axis);
    penumbra.scale.set(penEndRadiusAU, penLenAU, penEndRadiusAU);
  }

  /**
   * Place a moon's shadow spot on the parent sphere: intersect the shadow
   * axis ray (from the moon, anti-sunward) with the sphere at local origin,
   * size the disc to the penumbra radius there, and lift it off the surface
   * by its own sagitta so the flat disc doesn't pierce the curvature.
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
    const b = moonOffsetAU.dot(moonAxis);
    const c = moonOffsetAU.lengthSq() - parentRadiusAU * parentRadiusAU;
    const discriminant = b * b - c;
    if (discriminant <= 0) {
      spot.visible = false;
      return;
    }
    const tAU = -b - Math.sqrt(discriminant); // near-surface hit along the shadow ray
    if (tAU <= 0) {
      spot.visible = false;
      return;
    }

    const penumbraKm =
      moonRadiusKm +
      ((tAU * KM_PER_AU) * (KM_CONSTANTS.SUN_RADIUS + moonRadiusKm)) / (moonSunDistAU * KM_PER_AU);
    const spotRadiusAU = Math.min(penumbraKm / KM_PER_AU, parentRadiusAU * 0.9);

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
    (this.parentUmbra.material as THREE.Material).dispose();
    (this.parentPenumbra.material as THREE.Material).dispose();
    (this.moonUmbra.material as THREE.Material).dispose();
    (this.moonPenumbra.material as THREE.Material).dispose();
    this.spotMaterial.dispose();
    this.spots.clear();
  }
}
