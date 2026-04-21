/**
 * Constellation line overlay for the Planetarium starfield. Projects bright
 * stars onto a fixed-radius celestial sphere and draws the canonical 88-line
 * figures on top of them. Toggled on/off by the settings panel.
 */
import * as THREE from 'three';
import { CONSTELLATIONS } from './data/constellations';
import { BRIGHT_STAR_CATALOG } from './data/brightStars';

const STAR_SPHERE_RADIUS = 85;
const SNAP_RADIUS_DEG = 3; // max degrees to snap a constellation vertex to a catalog star
const LINE_COLOR = 0x6688bb;
const LINE_OPACITY = 0.28;

/** Convert RA/Dec (degrees) to a 3D point on the star sphere. */
function celestialToVec3(raDeg: number, decDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const ra = THREE.MathUtils.degToRad(raDeg);
  const dec = THREE.MathUtils.degToRad(decDeg);
  const cosDec = Math.cos(dec);
  out.set(
    STAR_SPHERE_RADIUS * cosDec * Math.cos(ra),
    STAR_SPHERE_RADIUS * Math.sin(dec),
    STAR_SPHERE_RADIUS * cosDec * Math.sin(ra),
  );
  return out;
}

/**
 * Angular distance between two points given in degrees (RA/Dec).
 * Returns degrees.
 */
function angularDistDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const toRad = Math.PI / 180;
  const d1 = dec1 * toRad;
  const d2 = dec2 * toRad;
  const dRa = (ra2 - ra1) * toRad;
  const sinD1 = Math.sin(d1), cosD1 = Math.cos(d1);
  const sinD2 = Math.sin(d2), cosD2 = Math.cos(d2);
  const sinDRa = Math.sin(dRa), cosDRa = Math.cos(dRa);
  const a = cosD2 * sinDRa;
  const b = cosD1 * sinD2 - sinD1 * cosD2 * cosDRa;
  const c = sinD1 * sinD2 + cosD1 * cosD2 * cosDRa;
  return Math.atan2(Math.sqrt(a * a + b * b), c) * (180 / Math.PI);
}

interface LabelState {
  el: HTMLDivElement;
  pos: THREE.Vector3; // 3D position on star sphere (centroid of constellation)
  visible: boolean;
  lastTransform: string;
}

export class Constellations {
  readonly lines: THREE.LineSegments;
  private labels: LabelState[] = [];
  private labelContainer: HTMLDivElement;
  private tempV = new THREE.Vector3();

  constructor() {
    // Build a cache of snapped positions: for each unique RA/Dec endpoint
    // in constellation data, find the nearest catalog star within SNAP_RADIUS_DEG.
    const snapCache = new Map<string, [number, number]>();

    const snap = (ra: number, dec: number): [number, number] => {
      const key = `${ra},${dec}`;
      const cached = snapCache.get(key);
      if (cached) return cached;

      let bestRa = ra;
      let bestDec = dec;
      let bestDist = SNAP_RADIUS_DEG;

      for (const star of BRIGHT_STAR_CATALOG) {
        const d = angularDistDeg(ra, dec, star.raDeg, star.decDeg);
        if (d < bestDist) {
          bestDist = d;
          bestRa = star.raDeg;
          bestDec = star.decDeg;
        }
      }

      const result: [number, number] = [bestRa, bestDec];
      snapCache.set(key, result);
      return result;
    };

    // Count total line segments
    let totalSegments = 0;
    for (const c of CONSTELLATIONS) totalSegments += c.lines.length;

    const positions = new Float32Array(totalSegments * 6); // 2 vertices × 3 components
    let idx = 0;
    const v = new THREE.Vector3();

    // Label container
    this.labelContainer = document.createElement('div');
    this.labelContainer.id = 'constellation-labels';
    this.labelContainer.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:14;overflow:hidden;';
    document.body.appendChild(this.labelContainer);

    for (const c of CONSTELLATIONS) {
      // Build line geometry and compute centroid
      let centroidRa = 0;
      let centroidDec = 0;
      let nPoints = 0;
      const pointSet = new Set<string>();

      for (const [ra1, dec1, ra2, dec2] of c.lines) {
        const [sra1, sdec1] = snap(ra1, dec1);
        const [sra2, sdec2] = snap(ra2, dec2);

        celestialToVec3(sra1, sdec1, v);
        positions[idx++] = v.x;
        positions[idx++] = v.y;
        positions[idx++] = v.z;

        celestialToVec3(sra2, sdec2, v);
        positions[idx++] = v.x;
        positions[idx++] = v.y;
        positions[idx++] = v.z;

        const k1 = `${sra1},${sdec1}`;
        const k2 = `${sra2},${sdec2}`;
        if (!pointSet.has(k1)) {
          pointSet.add(k1);
          centroidRa += sra1;
          centroidDec += sdec1;
          nPoints++;
        }
        if (!pointSet.has(k2)) {
          pointSet.add(k2);
          centroidRa += sra2;
          centroidDec += sdec2;
          nPoints++;
        }
      }

      // Create label at centroid
      if (nPoints > 0) {
        centroidRa /= nPoints;
        centroidDec /= nPoints;

        const labelEl = document.createElement('div');
        labelEl.className = 'constellation-label';
        labelEl.textContent = c.name;
        labelEl.style.display = 'none';
        this.labelContainer.appendChild(labelEl);

        const pos = new THREE.Vector3();
        celestialToVec3(centroidRa, centroidDec, pos);

        this.labels.push({
          el: labelEl,
          pos,
          visible: false,
          lastTransform: '',
        });
      }
    }

    // Build geometry
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: LINE_OPACITY,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.renderOrder = -1; // render before stars so stars appear on top
    this.lines.visible = false; // off by default
  }

  /** Update label screen positions. Call each frame when visible. */
  updateLabels(camera: THREE.PerspectiveCamera, canvasWidth: number, canvasHeight: number): void {
    if (!this.lines.visible) return;

    for (const label of this.labels) {
      this.tempV.copy(label.pos);
      this.tempV.project(camera);

      const screenX = (this.tempV.x * 0.5 + 0.5) * canvasWidth;
      const screenY = (-this.tempV.y * 0.5 + 0.5) * canvasHeight;

      if (
        this.tempV.z < 1 &&
        screenX > -20 &&
        screenX < canvasWidth + 20 &&
        screenY > -20 &&
        screenY < canvasHeight + 20
      ) {
        if (!label.visible) {
          label.el.style.display = 'block';
          label.visible = true;
        }
        const transform = `translate(${screenX}px, ${screenY}px)`;
        if (transform !== label.lastTransform) {
          label.el.style.transform = transform;
          label.lastTransform = transform;
        }
      } else if (label.visible) {
        label.el.style.display = 'none';
        label.visible = false;
      }
    }
  }

  setVisible(visible: boolean): void {
    this.lines.visible = visible;
    if (!visible) {
      for (const label of this.labels) {
        if (label.visible) {
          label.el.style.display = 'none';
          label.visible = false;
        }
      }
    }
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.lines.removeFromParent();
    this.labelContainer.remove();
  }
}
