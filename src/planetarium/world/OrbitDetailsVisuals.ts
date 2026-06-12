/**
 * Three.js visuals for the Observatory's orbit-details overlay (the Moon-view
 * OrbitDetailsOverlay, ported to real per-moon geometry): the sampled orbit
 * polyline, dashed major/minor axes, the center→F1 "c-segment" (the visibly
 * eccentric element at low e), apsides ticks, and the two equal-time Kepler
 * sweep sectors. All geometry lives in the parent's moon-system group (parent
 * at local origin, AU units) — same residency as ShadowVisuals, so the
 * floating origin is free.
 *
 * The F1/F2 focus markers are NOT drawn here: world-space rings collapse
 * sub-pixel exactly for the showcase orbits (Neso's a is ~2000 parent radii),
 * so the foci are fixed-px HTML glyphs — "a label, not geometry" — projected
 * per frame by PlanetariumMode from getFocusLocalPositions().
 *
 * Palette: cool monochrome only, per the locked Option D rule (warm is
 * reserved for happening-now). The legacy overlay's gold focus/sector colors
 * are deliberately not carried over.
 */
import * as THREE from 'three';
import type { OrbitGeometry } from '../orbitDetails';

const ORBIT_LINE_COLOR = 0x7c9aff;
const AXIS_COLOR = 0x9ab8ff;
const DETAIL_COLOR = 0xcfe2ff;
/** Apsis tick half-length and c-segment/tick sizing, as fractions of a. */
const TICK_HALF_LENGTH_FRACTION = 0.015;
const DASH_SIZE_FRACTION = 1 / 60;
const GAP_SIZE_FRACTION = 1 / 100;

export interface OrbitVisualOptions {
  closeLoop: boolean;
  /** Circular-degenerate: apsides/axes directions are float noise — hide them. */
  suppressApsides: boolean;
  /** Foci merged: the empty focus (and the c-segment to it) hides. */
  suppressEmptyFocus: boolean;
}

function disposeLineGeometry(line: THREE.Line): void {
  line.geometry.dispose();
}

export class OrbitDetailsVisuals {
  private root = new THREE.Group();

  private orbitMaterial = new THREE.LineBasicMaterial({
    color: ORBIT_LINE_COLOR,
    transparent: true,
    opacity: 0.4,
  });
  private axisMaterial = new THREE.LineDashedMaterial({
    color: AXIS_COLOR,
    transparent: true,
    opacity: 0.3,
    dashSize: 1,
    gapSize: 1,
  });
  private detailMaterial = new THREE.LineBasicMaterial({
    color: DETAIL_COLOR,
    transparent: true,
    opacity: 0.6,
  });
  private trailingFillMaterial = new THREE.MeshBasicMaterial({
    color: ORBIT_LINE_COLOR,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private offsetFillMaterial = new THREE.MeshBasicMaterial({
    color: ORBIT_LINE_COLOR,
    transparent: true,
    opacity: 0.09,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private trailingOutlineMaterial = new THREE.LineBasicMaterial({
    color: ORBIT_LINE_COLOR,
    transparent: true,
    opacity: 0.32,
  });
  private offsetOutlineMaterial = new THREE.LineBasicMaterial({
    color: ORBIT_LINE_COLOR,
    transparent: true,
    opacity: 0.18,
  });

  private orbitLine = new THREE.Line(new THREE.BufferGeometry(), this.orbitMaterial);
  private majorAxis = new THREE.Line(new THREE.BufferGeometry(), this.axisMaterial);
  private minorAxis = new THREE.Line(new THREE.BufferGeometry(), this.axisMaterial);
  private cSegment = new THREE.Line(new THREE.BufferGeometry(), this.detailMaterial);
  private periTick = new THREE.Line(new THREE.BufferGeometry(), this.detailMaterial);
  private apoTick = new THREE.Line(new THREE.BufferGeometry(), this.detailMaterial);
  private trailingFill = new THREE.Mesh(new THREE.BufferGeometry(), this.trailingFillMaterial);
  private offsetFill = new THREE.Mesh(new THREE.BufferGeometry(), this.offsetFillMaterial);
  private trailingOutline = new THREE.Line(new THREE.BufferGeometry(), this.trailingOutlineMaterial);
  private offsetOutline = new THREE.Line(new THREE.BufferGeometry(), this.offsetOutlineMaterial);

  private emptyFocusLocal = new THREE.Vector3();
  private emptyFocusSuppressed = true;
  private hasOrbit = false;

  constructor() {
    this.root.visible = false;
    this.root.add(
      this.orbitLine,
      this.majorAxis,
      this.minorAxis,
      this.cSegment,
      this.periTick,
      this.apoTick,
      this.trailingFill,
      this.offsetFill,
      this.trailingOutline,
      this.offsetOutline,
    );
  }

  /** Parent into a moon-system group (parent planet at local origin). */
  attach(systemGroup: THREE.Group): void {
    this.detach();
    systemGroup.add(this.root);
  }

  detach(): void {
    this.root.removeFromParent();
    this.hasOrbit = false;
  }

  isAttached(): boolean {
    return this.root.parent !== null;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible && this.hasOrbit;
  }

  isVisible(): boolean {
    return this.root.visible;
  }

  private swapLineGeometry(line: THREE.Line, points: THREE.Vector3[], dashed: boolean): void {
    disposeLineGeometry(line);
    line.geometry = new THREE.BufferGeometry().setFromPoints(points);
    if (dashed) line.computeLineDistances();
  }

  setOrbit(points: THREE.Vector3[], geometry: OrbitGeometry, opts: OrbitVisualOptions): void {
    const linePoints = opts.closeLoop ? [...points, points[0]] : points;
    this.swapLineGeometry(this.orbitLine, linePoints, false);

    const a = geometry.semiMajorAxisAU;
    this.axisMaterial.dashSize = a * DASH_SIZE_FRACTION;
    this.axisMaterial.gapSize = a * GAP_SIZE_FRACTION;

    const showApsides = !opts.suppressApsides;
    this.majorAxis.visible = showApsides;
    this.minorAxis.visible = showApsides;
    this.periTick.visible = showApsides;
    this.apoTick.visible = showApsides;
    if (showApsides) {
      this.swapLineGeometry(this.majorAxis, [geometry.majorAxisA, geometry.majorAxisB], true);
      const halfMinor = geometry.minorDir.clone().multiplyScalar(geometry.semiMinorAxisAU);
      this.swapLineGeometry(
        this.minorAxis,
        [geometry.center.clone().sub(halfMinor), geometry.center.clone().add(halfMinor)],
        true,
      );
      const tick = (apsis: THREE.Vector3, line: THREE.Line) => {
        const radial = apsis.clone().normalize().multiplyScalar(a * TICK_HALF_LENGTH_FRACTION);
        this.swapLineGeometry(line, [apsis.clone().sub(radial), apsis.clone().add(radial)], false);
      };
      tick(geometry.periPoint, this.periTick);
      tick(geometry.apoPoint, this.apoTick);
    }

    this.emptyFocusSuppressed = opts.suppressEmptyFocus || opts.suppressApsides;
    this.emptyFocusLocal.copy(geometry.emptyFocus);
    this.cSegment.visible = !this.emptyFocusSuppressed;
    if (!this.emptyFocusSuppressed) {
      this.swapLineGeometry(this.cSegment, [geometry.center, new THREE.Vector3(0, 0, 0)], false);
    }

    this.hasOrbit = true;
  }

  /** Fan polygons (apex at the parent/local origin) from fresh seam samples. */
  updateSectors(trailingArc: THREE.Vector3[], offsetArc: THREE.Vector3[]): void {
    const buildFan = (arc: THREE.Vector3[], fill: THREE.Mesh, outline: THREE.Line) => {
      const vertices: number[] = [];
      for (let i = 0; i + 1 < arc.length; i++) {
        vertices.push(
          0, 0, 0,
          arc[i].x, arc[i].y, arc[i].z,
          arc[i + 1].x, arc[i + 1].y, arc[i + 1].z,
        );
      }
      fill.geometry.dispose();
      fill.geometry = new THREE.BufferGeometry();
      fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      const outlinePoints = [new THREE.Vector3(0, 0, 0), ...arc, new THREE.Vector3(0, 0, 0)];
      disposeLineGeometry(outline);
      outline.geometry = new THREE.BufferGeometry().setFromPoints(outlinePoints);
    };
    buildFan(trailingArc, this.trailingFill, this.trailingOutline);
    buildFan(offsetArc, this.offsetFill, this.offsetOutline);
  }

  /** F1 = the parent (local origin); F2 = the derived empty focus. Returns
   *  false when there is no orbit set or the empty focus is suppressed —
   *  the caller hides the F2 glyph (F1 may still show). */
  getFocusLocalPositions(outF1: THREE.Vector3, outF2: THREE.Vector3): { hasOrbit: boolean; showF2: boolean } {
    outF1.set(0, 0, 0);
    outF2.copy(this.emptyFocusLocal);
    return { hasOrbit: this.hasOrbit, showF2: this.hasOrbit && !this.emptyFocusSuppressed };
  }

  dispose(): void {
    this.detach();
    for (const line of [
      this.orbitLine,
      this.majorAxis,
      this.minorAxis,
      this.cSegment,
      this.periTick,
      this.apoTick,
      this.trailingOutline,
      this.offsetOutline,
    ]) {
      disposeLineGeometry(line);
    }
    this.trailingFill.geometry.dispose();
    this.offsetFill.geometry.dispose();
    for (const material of [
      this.orbitMaterial,
      this.axisMaterial,
      this.detailMaterial,
      this.trailingFillMaterial,
      this.offsetFillMaterial,
      this.trailingOutlineMaterial,
      this.offsetOutlineMaterial,
    ]) {
      material.dispose();
    }
  }
}
