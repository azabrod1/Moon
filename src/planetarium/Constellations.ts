/**
 * Constellation line overlay for the Planetarium starfield. Draws the canonical
 * 88 figures on the star sphere, through the catalog stars their endpoints name
 * (the snap lives in data/constellationGeometry, shared with the system map's
 * own sky). Toggled on/off by the settings panel.
 *
 * The hue and the opacity are this sky's own: the chart composites its figures
 * differently, so only the geometry is shared.
 */
import * as THREE from 'three';
import { projectToScreen } from '../shared/three/projectToScreen';
import {
  constellationLabelAnchors,
  constellationSegmentPositions,
} from './data/constellationGeometry';
import { STAR_SPHERE_RADIUS } from './world/starfield';

const LINE_COLOR = 0x6688bb;
const LINE_OPACITY = 0.28;

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

  constructor() {
    this.labelContainer = document.createElement('div');
    this.labelContainer.id = 'constellation-labels';
    this.labelContainer.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:14;overflow:hidden;';
    document.body.appendChild(this.labelContainer);

    for (const anchor of constellationLabelAnchors(STAR_SPHERE_RADIUS)) {
      const labelEl = document.createElement('div');
      labelEl.className = 'constellation-label';
      labelEl.textContent = anchor.name;
      labelEl.style.display = 'none';
      this.labelContainer.appendChild(labelEl);
      this.labels.push({
        el: labelEl,
        pos: anchor.position,
        visible: false,
        lastTransform: '',
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(constellationSegmentPositions(STAR_SPHERE_RADIUS), 3),
    );

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
      const proj = projectToScreen(label.pos, camera, canvasWidth, canvasHeight);
      const screenX = proj.x;
      const screenY = proj.y;

      if (
        proj.ndcZ < 1 &&
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
