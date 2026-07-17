/**
 * Screen-space label for the Sun in the Planetarium. Projects the Sun's
 * world position to canvas coordinates each frame, hides when off-screen
 * or occluded by a nearer planet, and shows distance in AU (or km when
 * closer than 0.01 AU). Diffs against last transform/text to keep DOM
 * churn out of the hot path.
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../../astronomy/constants';
import { projectToScreen } from '../../shared/three/projectToScreen';
import { sunLabelClearRadiusPx, type SunGlareMaskParams } from '../world/sunGlareMask';

const LABEL_MARGIN_PX = 50;
const LABEL_OFFSET_PX = 16;
// Mars reaches about 1.67 AU at aphelion. Inside its full orbit the Sun is
// visually unmistakable, so the label only becomes useful beyond this edge.
export const SUN_LABEL_MIN_DISTANCE_AU = 1.67;

export function shouldShowSunLabel(distanceFromSunAU: number): boolean {
  return distanceFromSunAU > SUN_LABEL_MIN_DISTANCE_AU;
}

export class SunLabel {
  private el: HTMLDivElement | null = null;
  private visible = false;
  private lastTransform = '';
  private lastDistText = '';

  attach(): void {
    const container = document.getElementById('planet-labels');
    if (!container) return;
    this.el = document.createElement('div');
    this.el.className = 'planet-label';
    this.el.innerHTML = '<span class="planet-label-name">Sun</span><span class="planet-label-dist"></span>';
    this.el.style.display = 'none';
    container.appendChild(this.el);
  }

  update(
    sunWorldPos: THREE.Vector3,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    distanceFromSunAU: number,
    sunRadiusPx: number,
    isOccluded: (screenX: number, screenY: number, depth: number) => boolean,
    sunMask?: SunGlareMaskParams,
  ): void {
    if (!this.el) return;
    if (!shouldShowSunLabel(distanceFromSunAU)) {
      this.hide();
      return;
    }

    const projected = projectToScreen(sunWorldPos, camera, canvas.clientWidth, canvas.clientHeight);
    const screenX = projected.x;
    const screenY = projected.y;

    // Drop the label below the disc once the Sun grows on screen. Clearing the
    // whole outer glow would exile the label, so lift just past the bright
    // inner shell (~3.5x the mesh radius) — enough to sit off the burning face.
    // The Sun's label never fades; instead, when the glare wash is active push
    // it out past the L = 0.02 isophote so it never sits in its own blaze.
    const glareClearPx = sunMask ? sunLabelClearRadiusPx(sunMask) : 0;
    const labelOffsetY = Math.max(LABEL_OFFSET_PX, sunRadiusPx * 3.5 + 6, glareClearPx);

    const depth = camera.position.distanceTo(sunWorldPos);
    // Probe 8px into the label body (not its top edge) so a foreground disc
    // grazing the anchor line still hides the text it would actually cover.
    const occluded = isOccluded(screenX, screenY + labelOffsetY + 8, depth);

    const onScreen = projected.ndcZ < 1
      && screenX > -LABEL_MARGIN_PX && screenX < canvas.clientWidth + LABEL_MARGIN_PX
      && screenY > -LABEL_MARGIN_PX && screenY < canvas.clientHeight + LABEL_MARGIN_PX;

    if (!occluded && onScreen) {
      if (!this.visible) {
        this.el.style.display = 'block';
        this.visible = true;
      }
      const transform = `translate(${screenX}px, ${screenY + labelOffsetY}px)`;
      if (transform !== this.lastTransform) {
        this.el.style.transform = transform;
        this.lastTransform = transform;
      }
      const distText = distanceFromSunAU < 0.01
        ? `${(distanceFromSunAU * KM_PER_AU).toFixed(0)} km`
        : `${distanceFromSunAU.toFixed(2)} AU`;
      if (distText !== this.lastDistText) {
        const distEl = this.el.querySelector('.planet-label-dist');
        if (distEl) distEl.textContent = distText;
        this.lastDistText = distText;
      }
    } else {
      this.hide();
    }
  }

  private hide(): void {
    if (!this.el || !this.visible) return;
    this.el.style.display = 'none';
    this.visible = false;
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
    this.visible = false;
    this.lastTransform = '';
    this.lastDistText = '';
  }
}
