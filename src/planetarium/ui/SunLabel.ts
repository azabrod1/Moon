/**
 * Screen-space label for the Sun in the Planetarium. Projects the Sun's
 * world position to canvas coordinates each frame, hides when off-screen
 * or occluded by a nearer planet, and shows distance in AU (or km when
 * closer than 0.01 AU). Diffs against last transform/text to keep DOM
 * churn out of the hot path.
 */
import * as THREE from 'three';
import { formatBodyDistance } from '../bodyDistance';
import { projectToScreen } from '../../shared/three/projectToScreen';
import { sunLabelClearRadiusPx, type SunGlareMaskParams } from '../world/sunGlareMask';
import { rectsOverlap, type LabelRect } from '../planetLabelPlacement';

const LABEL_MARGIN_PX = 50;
const LABEL_OFFSET_PX = 16;
// Mars reaches about 1.67 AU at aphelion. Inside its full orbit the Sun is
// visually unmistakable, so the label only becomes useful beyond this edge.
export const SUN_LABEL_MIN_DISTANCE_AU = 1.67;

export function shouldShowSunLabel(distanceFromSunAU: number): boolean {
  return distanceFromSunAU > SUN_LABEL_MIN_DISTANCE_AU;
}

export class SunLabel {
  /** Whether `update` can possibly show the label — the same gates it applies
   *  first thing. The caller checks this BEFORE measuring the Sun's screen
   *  footprint (a 32-rim-ray lens projection), which is only consumed by a
   *  visible label; keep these two gate sets in step with update()'s
   *  early-outs. */
  static wantsFootprint(labelsOn: boolean, revealed: boolean, distanceFromSunAU: number): boolean {
    return (labelsOn || revealed) && shouldShowSunLabel(distanceFromSunAU);
  }

  private el: HTMLDivElement | null = null;
  private visible = false;
  private lastTransform = '';
  private lastDistText = '';
  // Last placed anchor + measured box, exposed to the planet-label contest as
  // a blocker rect (measured once on reveal, like the planet labels' boxes).
  private lastAnchorX = 0;
  private lastAnchorY = 0;
  private boxW = 64;
  private boxH = 24;
  private blockerScratch = { x: 0, y: 0, w: 64, h: 24 };
  private yieldScratch = { x: 0, y: 0, w: 64, h: 24 };

  /** The label's screen rect while visible (top-left at the transform anchor,
   *  the shared convention), or null when hidden. Planet labels clear this
   *  rect in their de-overlap contest — the Sun's own label never yields. */
  blockerRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.visible) return null;
    this.blockerScratch.x = this.lastAnchorX;
    this.blockerScratch.y = this.lastAnchorY;
    this.blockerScratch.w = this.boxW;
    this.blockerScratch.h = this.boxH;
    return this.blockerScratch;
  }

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
    // Label visibility policy: `labelsOn` is the master "Planet labels" setting;
    // `revealed` is the hover/tap reveal, which draws the Sun label (and its
    // distance line, at full opacity) even with labels off. The physical gate
    // below (hidden inside 1.67 AU) is never lifted by the reveal.
    labelsOn: boolean,
    revealed: boolean,
    sunMask?: SunGlareMaskParams,
    // The revealed planet label's rect, if one is drawn this frame. The Sun's
    // label is an uncontestable blocker in the planet-label contest, so a
    // revealed inner planet's exempt label would otherwise overprint it —
    // recreating the exact pileup the contest removes. The user's reveal
    // gesture outranks the anchor label; it returns on unhover.
    yieldToRect?: LabelRect | null,
  ): void {
    if (!this.el) return;
    if (!labelsOn && !revealed) {
      this.hide();
      return;
    }
    if (!shouldShowSunLabel(distanceFromSunAU)) {
      this.hide();
      return;
    }
    this.el.classList.toggle('revealed', revealed);

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

    let yielded = false;
    if (yieldToRect) {
      this.yieldScratch.x = screenX;
      this.yieldScratch.y = screenY + labelOffsetY;
      this.yieldScratch.w = this.boxW;
      this.yieldScratch.h = this.boxH;
      yielded = rectsOverlap(this.yieldScratch, yieldToRect);
    }

    if (!occluded && !yielded && onScreen) {
      const justRevealed = !this.visible;
      if (!this.visible) {
        this.el.style.display = 'block';
        this.visible = true;
      }
      const transform = `translate(${screenX}px, ${screenY + labelOffsetY}px)`;
      if (transform !== this.lastTransform) {
        this.el.style.transform = transform;
        this.lastTransform = transform;
      }
      this.lastAnchorX = screenX;
      this.lastAnchorY = screenY + labelOffsetY;
      if (justRevealed && this.el.offsetWidth > 0) {
        this.boxW = this.el.offsetWidth;
        this.boxH = this.el.offsetHeight;
      }
      const distText = formatBodyDistance(distanceFromSunAU);
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
