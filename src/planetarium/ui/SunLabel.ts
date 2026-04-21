/**
 * Screen-space label for the Sun in the Planetarium. Projects the Sun's
 * world position to canvas coordinates each frame, hides when off-screen
 * or occluded by a nearer planet, and shows distance in AU (or km when
 * closer than 0.01 AU). Diffs against last transform/text to keep DOM
 * churn out of the hot path.
 */
import * as THREE from 'three';

const AU_IN_KM = 149597870.7;
const LABEL_MARGIN_PX = 50;
const LABEL_OFFSET_PX = 16;
const OCCLUSION_TEST_OFFSET_PX = 24;

export class SunLabel {
  private el: HTMLDivElement | null = null;
  private visible = false;
  private lastTransform = '';
  private lastDistText = '';
  private readonly projected = new THREE.Vector3();

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
    isOccluded: (screenX: number, screenY: number, depth: number) => boolean,
  ): void {
    if (!this.el) return;

    this.projected.copy(sunWorldPos).project(camera);
    const screenX = (this.projected.x * 0.5 + 0.5) * canvas.clientWidth;
    const screenY = (-this.projected.y * 0.5 + 0.5) * canvas.clientHeight;

    const depth = camera.position.distanceTo(sunWorldPos);
    const occluded = isOccluded(screenX, screenY + OCCLUSION_TEST_OFFSET_PX, depth);

    const onScreen = this.projected.z < 1
      && screenX > -LABEL_MARGIN_PX && screenX < canvas.clientWidth + LABEL_MARGIN_PX
      && screenY > -LABEL_MARGIN_PX && screenY < canvas.clientHeight + LABEL_MARGIN_PX;

    if (!occluded && onScreen) {
      if (!this.visible) {
        this.el.style.display = 'block';
        this.visible = true;
      }
      const transform = `translate(${screenX}px, ${screenY + LABEL_OFFSET_PX}px)`;
      if (transform !== this.lastTransform) {
        this.el.style.transform = transform;
        this.lastTransform = transform;
      }
      const distText = distanceFromSunAU < 0.01
        ? `${(distanceFromSunAU * AU_IN_KM).toFixed(0)} km`
        : `${distanceFromSunAU.toFixed(2)} AU`;
      if (distText !== this.lastDistText) {
        const distEl = this.el.querySelector('.planet-label-dist');
        if (distEl) distEl.textContent = distText;
        this.lastDistText = distText;
      }
    } else if (this.visible) {
      this.el.style.display = 'none';
      this.visible = false;
    }
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
    this.visible = false;
    this.lastTransform = '';
    this.lastDistText = '';
  }
}
