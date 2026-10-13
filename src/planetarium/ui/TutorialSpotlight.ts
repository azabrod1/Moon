/**
 * The tutorial's spotlight layer: a dimming mask with a cutout around the one
 * control being taught, a pulsing ring on the cutout, a coach bubble of one
 * to three words with an arrow back at the control, and the visible press on
 * the real control. It points at chrome only (the cluster chips, a deck row,
 * later the rail and the panel windows), never at the scene: the beat runner
 * hides it the moment the press's consequence is the thing to look at. The
 * geometry is tutorialSpotlightLogic's; this class measures and draws. The
 * target is re-measured every frame while the layer is up (track), so a
 * scrolling deck list, a dragged phone sheet or a resize cannot leave the
 * ring behind. Decorative throughout (aria-hidden): the card's live body
 * carries the words. Sits at z 29 in #planetarium-ui — above the cluster
 * (28), the deck (27) and the panel (21), below the card (30) and the veil
 * (50) — and never takes pointer events, so the user can still tap the
 * control it rings.
 */
import {
  SPOTLIGHT_CUTOUT_RADIUS_PX,
  placeBubble,
  spotlightCutout,
} from '../tutorialSpotlightLogic';
import type { BubbleSide, Rect } from '../tutorialSpotlightLogic';

/** Class the press puts on the real control for TUTORIAL_PRESS_MS. */
export const TUTORIAL_PRESS_CLASS = 'tutorial-press';

export interface SpotlightMeasure {
  cutout: Rect;
  bubble: Rect;
  side: BubbleSide;
}

export class TutorialSpotlight {
  private rootEl: HTMLElement | null = null;
  private maskPathEl: SVGPathElement | null = null;
  private ringEl: HTMLElement | null = null;
  private bubbleEl: HTMLElement | null = null;
  private bubbleTextEl: HTMLElement | null = null;
  private bubbleKeyEl: HTMLElement | null = null;
  private target: Element | null = null;
  private pressed: Element | null = null;
  private lastMeasure: SpotlightMeasure | null = null;

  bind(): void {
    this.rootEl = document.getElementById('tutorial-spotlight');
    this.maskPathEl = document.getElementById('tutorial-spotlight-mask') as SVGPathElement | null;
    this.ringEl = document.getElementById('tutorial-spotlight-ring');
    this.bubbleEl = document.getElementById('tutorial-bubble');
    this.bubbleTextEl = document.getElementById('tutorial-bubble-text');
    this.bubbleKeyEl = document.getElementById('tutorial-bubble-key');
  }

  /** Ring `target` and label it. The first measurement happens here so the
   *  layer never shows a frame with the ring at its last position. */
  show(target: Element, label: string, key: string | undefined, avoid: readonly Rect[]): void {
    this.target = target;
    if (this.bubbleTextEl) this.bubbleTextEl.textContent = label;
    if (this.bubbleKeyEl) {
      this.bubbleKeyEl.textContent = key ?? '';
      this.bubbleKeyEl.style.display = key ? '' : 'none';
    }
    if (this.track(avoid)) this.rootEl?.classList.add('visible');
  }

  hide(): void {
    this.target = null;
    this.lastMeasure = null;
    this.rootEl?.classList.remove('visible');
  }

  isVisible(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }

  /** The current target, for the host to check it is still the element it rang. */
  currentTarget(): Element | null {
    return this.target;
  }

  /** The last measurement, for the headless walk's assertions. */
  measure(): SpotlightMeasure | null {
    return this.lastMeasure;
  }

  /**
   * Re-measure the target and lay the cutout, the ring and the bubble out
   * around it, keeping the bubble off every `avoid` rectangle (the card).
   * Returns null — and hides the layer — when the target has left the
   * document or has no size (a closed deck's row, a hidden chip).
   */
  track(avoid: readonly Rect[]): SpotlightMeasure | null {
    const root = this.rootEl;
    const target = this.target;
    if (!root || !target || !target.isConnected) {
      this.hide();
      return null;
    }
    const targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) {
      this.hide();
      return null;
    }
    const rootRect = root.getBoundingClientRect();
    const viewport: Rect = { x: 0, y: 0, w: rootRect.width, h: rootRect.height };
    const local = (rect: { x: number; y: number; width: number; height: number }): Rect => ({
      x: rect.x - rootRect.x,
      y: rect.y - rootRect.y,
      w: rect.width,
      h: rect.height,
    });
    const cutout = spotlightCutout(local(targetRect), viewport);
    if (this.maskPathEl) {
      this.maskPathEl.setAttribute('d', maskPath(viewport, cutout, SPOTLIGHT_CUTOUT_RADIUS_PX));
    }
    if (this.ringEl) {
      this.ringEl.style.left = `${cutout.x}px`;
      this.ringEl.style.top = `${cutout.y}px`;
      this.ringEl.style.width = `${cutout.w}px`;
      this.ringEl.style.height = `${cutout.h}px`;
    }
    let bubble: Rect = { x: 0, y: 0, w: 0, h: 0 };
    let side: BubbleSide = 'below';
    if (this.bubbleEl) {
      const size = { w: this.bubbleEl.offsetWidth, h: this.bubbleEl.offsetHeight };
      const placed = placeBubble({
        cutout,
        size,
        viewport,
        avoid: avoid.map((rect) => ({ x: rect.x - rootRect.x, y: rect.y - rootRect.y, w: rect.w, h: rect.h })),
      });
      this.bubbleEl.style.left = `${placed.x}px`;
      this.bubbleEl.style.top = `${placed.y}px`;
      this.bubbleEl.style.setProperty('--arrow', `${placed.arrow}px`);
      for (const s of ['below', 'above', 'left', 'right'] as const) {
        this.bubbleEl.classList.toggle(`side-${s}`, placed.side === s);
      }
      bubble = { x: placed.x, y: placed.y, w: size.w, h: size.h };
      side = placed.side;
    }
    this.lastMeasure = { cutout, bubble, side };
    return this.lastMeasure;
  }

  /** The visible press on the real control. Released by release(), and by
   *  clear() on every stop, so the class can never outlive its beat. */
  press(target: Element): void {
    this.release();
    this.pressed = target;
    target.classList.add(TUTORIAL_PRESS_CLASS);
  }

  release(): void {
    this.pressed?.classList.remove(TUTORIAL_PRESS_CLASS);
    this.pressed = null;
  }

  /** Everything down: the layer, the bubble and any press still showing. */
  clear(): void {
    this.release();
    this.hide();
  }
}

/** The dimming sheet with a rounded cutout: outer rectangle plus an inner
 *  rounded rectangle, evenodd so the inner one is the hole. */
function maskPath(viewport: Rect, cutout: Rect, radius: number): string {
  const r = Math.min(radius, cutout.w / 2, cutout.h / 2);
  const x0 = cutout.x;
  const y0 = cutout.y;
  const x1 = cutout.x + cutout.w;
  const y1 = cutout.y + cutout.h;
  const outer = `M${viewport.x} ${viewport.y}H${viewport.x + viewport.w}V${viewport.y + viewport.h}H${viewport.x}Z`;
  const inner =
    `M${x0 + r} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}` +
    `H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`;
  return outer + inner;
}
