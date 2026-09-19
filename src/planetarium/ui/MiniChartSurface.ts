/**
 * The corner chart's DOM: the box that carries the chart's rectangle, the
 * button inside it that frames the WebGL rectangle and takes the tap, and the
 * grip at its bottom-right corner that resizes it. Every gesture the chart
 * answers lives here — the tap that opens the full map, the corner drag, the
 * pinch, the double-tap on the grip that puts the size back — and the laws
 * they follow (what width a pointer asks for, where a release settles) are
 * miniChart.ts's, pure and tested; this module is the DOM and the pointer
 * bookkeeping around them.
 *
 * The box is what the mode sizes — one write of left/top/width/height from
 * the same rect the scissor uses — and it takes no pointers itself: the
 * button and the grip do. The button has to be a real DOM surface: on coarse
 * pointers the flight zone is a transparent full-width layer above the
 * canvas, so a canvas hit-test never fires under it, and a pointerdown check
 * could never intercept a wheel in any case. It sits above that zone and
 * covers the rectangle, and the zone stays live everywhere else — unlike the
 * full map, the corner chart does not take steering away. The grip is the
 * button's sibling, not its child: a button may hold no interactive content.
 *
 * The tap opens on RELEASE, not on press, the way a button does: a press may
 * be the first finger of a pinch, and a pinch must not open the map. Travel
 * past the tap slop, or a second finger, retires the tap.
 *
 * A gesture measures the size range once at its start (the phone sheet's
 * idiom: a move costs no layout) and holds every ask to it. The host is
 * told the width on every move (`live`) and once at the end (`commit`, which
 * is what saves); Escape mid-drag hands back the width the drag started from
 * and ends it; a capture lost to anything — the chart hidden under the
 * finger, the browser taking the pointer — commits what it had, so no
 * gesture can leave the chart at a size nobody chose and nothing saved.
 * One resize at a time: a pinch is refused while a drag is live and the
 * other way round, since both would be writing the one width.
 */

import {
  miniDragWidth,
  miniPinchWidth,
  miniReleaseWidth,
  type MiniChartRect,
  type MiniSizeRange,
} from '../map/miniChart';

/** A press that travels no further than this is a tap; the sheets' slop. */
const TAP_MAX_PX = 8;
/** Two taps on the grip inside this window put the size back. */
const GRIP_DOUBLE_TAP_MS = 350;

export interface MiniChartSurfaceHost {
  /** A tap on the chart, or Enter on it. */
  openMap(): void;
  /** The chart's width right now, CSS px. */
  widthPx(): number;
  /** What this canvas allows, measured at a gesture's start. */
  sizeRange(): MiniSizeRange;
  /** A gesture asks for a width, already held to the range. `live` draws it
   *  and saves nothing; `commit` is the size the user chose. */
  setWidthPx(widthPx: number, phase: 'live' | 'commit'): void;
  /** The grip's double-tap: back to the default size, saved. */
  resetSize(): void;
  /** A resize gesture began: reserve the chart's target for its ceiling. */
  resizeStarted(): void;
  /** It ended, by any road: release the reserve. */
  resizeEnded(): void;
}

interface CornerDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWidthPx: number;
  /** The last width asked for. */
  widthPx: number;
  range: MiniSizeRange;
  /** The furthest the pointer has been from where it went down. */
  movedPx: number;
}

interface Pinch {
  pointerIds: [number, number];
  positions: Map<number, { x: number; y: number }>;
  startDistancePx: number;
  startWidthPx: number;
  widthPx: number;
  range: MiniSizeRange;
}

interface Tap {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  movedPx: number;
  /** Retired — by travel past the slop or by a second finger — so its
   *  release opens nothing. */
  spent: boolean;
}

export class MiniChartSurface {
  private boxEl: HTMLElement | null = null;
  private buttonEl: HTMLElement | null = null;
  private gripEl: HTMLElement | null = null;
  private host: MiniChartSurfaceHost | null = null;
  private drag: CornerDrag | null = null;
  private pinch: Pinch | null = null;
  private tap: Tap | null = null;
  private lastGripTapMs = Number.NEGATIVE_INFINITY;
  /** Dev forensics: how many resize gestures have been committed. */
  private commits = 0;

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelDrag();
  };

  /** Find the elements and wire them, once. False when the DOM has no chart. */
  bind(host: MiniChartSurfaceHost): boolean {
    if (this.boxEl) {
      this.host = host;
      return true;
    }
    const box = document.getElementById('mini-chart-box');
    const button = document.getElementById('mini-chart');
    const grip = document.getElementById('mini-chart-grip');
    if (!box || !button || !grip) return false;
    this.boxEl = box;
    this.buttonEl = button;
    this.gripEl = grip;
    this.host = host;
    this.wireButton(button);
    this.wireGrip(grip);
    return true;
  }

  isBound(): boolean {
    return this.boxEl !== null;
  }

  /** The box's geometry: the chart's rectangle, from the one definition the
   *  scissor is written from. */
  setRect(rect: MiniChartRect): void {
    const box = this.boxEl;
    if (!box) return;
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  /** The stylesheet hides the box by default, so shown/hidden is an inline
   *  display either way — an empty string would hand it back to the rule that
   *  hides it. Written only on a change; the property is read every frame. */
  setShown(shown: boolean): void {
    const box = this.boxEl;
    if (!box) return;
    const want = shown ? 'block' : 'none';
    if (box.style.display !== want) box.style.display = want;
  }

  /** Whether a drag or a pinch is live. */
  isResizing(): boolean {
    return this.drag !== null || this.pinch !== null;
  }

  /** Dev forensics. */
  state(): { resizing: boolean; gesture: 'drag' | 'pinch' | null; tapHeld: boolean; commits: number } {
    return {
      resizing: this.isResizing(),
      gesture: this.drag ? 'drag' : this.pinch ? 'pinch' : null,
      tapHeld: this.tap !== null,
      commits: this.commits,
    };
  }

  /**
   * The chart is going away under whatever is in flight (hidden by the map,
   * the deck, a landing, the veil; the mode deactivating): a resize commits
   * what it had, a held tap opens nothing, and every capture is handed back.
   */
  abort(): void {
    if (this.drag) this.finishDrag(this.drag, 'commit');
    if (this.pinch) this.finishPinch(this.pinch);
    if (this.tap) {
      this.releaseCapture(this.buttonEl, this.tap.pointerId);
      this.tap = null;
    }
  }

  // ── The button: tap to open, pinch to resize ─────────────────────────────

  private wireButton(button: HTMLElement): void {
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // A third finger has nothing to say.
      if (this.pinch) return;
      const held = this.tap;
      if (held === null) {
        if (!this.capture(button, event.pointerId)) return;
        event.preventDefault();
        event.stopPropagation();
        this.tap = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          clientX: event.clientX,
          clientY: event.clientY,
          movedPx: 0,
          spent: false,
        };
        return;
      }
      if (event.pointerId === held.pointerId) return;
      // A second finger on the chart: a pinch, and the first finger's tap is
      // over — lifting either opens nothing now.
      if (this.drag || !this.host) return;
      if (!this.capture(button, event.pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      held.spent = true;
      const startDistancePx = Math.hypot(event.clientX - held.clientX, event.clientY - held.clientY);
      const widthPx = this.host.widthPx();
      this.pinch = {
        pointerIds: [held.pointerId, event.pointerId],
        positions: new Map([
          [held.pointerId, { x: held.clientX, y: held.clientY }],
          [event.pointerId, { x: event.clientX, y: event.clientY }],
        ]),
        startDistancePx,
        startWidthPx: widthPx,
        widthPx,
        range: this.host.sizeRange(),
      };
      this.beginResize();
    });
    button.addEventListener('pointermove', (event) => {
      const pinch = this.pinch;
      if (pinch && pinch.positions.has(event.pointerId)) {
        pinch.positions.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const a = pinch.positions.get(pinch.pointerIds[0]);
        const b = pinch.positions.get(pinch.pointerIds[1]);
        if (!a || !b || !this.host) return;
        const distancePx = Math.hypot(b.x - a.x, b.y - a.y);
        pinch.widthPx = clampWidth(miniPinchWidth(pinch.startWidthPx, pinch.startDistancePx, distancePx), pinch.range);
        this.host.setWidthPx(pinch.widthPx, 'live');
        return;
      }
      const tap = this.tap;
      if (!tap || event.pointerId !== tap.pointerId) return;
      tap.clientX = event.clientX;
      tap.clientY = event.clientY;
      tap.movedPx = Math.max(tap.movedPx, Math.hypot(event.clientX - tap.startClientX, event.clientY - tap.startClientY));
      if (tap.movedPx > TAP_MAX_PX) tap.spent = true;
    });
    const end = (event: PointerEvent, how: 'up' | 'cancel'): void => {
      const pinch = this.pinch;
      if (pinch && pinch.positions.has(event.pointerId)) {
        // One finger off is the end of the pinch. The other, if it is still
        // down, is the retired tap: its own release opens nothing.
        this.finishPinch(pinch);
        if (this.tap && this.tap.pointerId === event.pointerId) this.tap = null;
        return;
      }
      const tap = this.tap;
      if (!tap || event.pointerId !== tap.pointerId) return;
      this.tap = null;
      if (how === 'up' && !tap.spent && this.host) this.host.openMap();
    };
    button.addEventListener('pointerup', (event) => end(event, 'up'));
    button.addEventListener('pointercancel', (event) => end(event, 'cancel'));
    // A capture lost without a pointerup (the element hidden, the browser
    // taking the pointer) still ends the gesture; after a normal release the
    // pointer is already gone from the books and this no-ops.
    button.addEventListener('lostpointercapture', (event) => end(event, 'cancel'));
    // Swallow the scroll over the chart: the world is not what a wheel here
    // means, and the corner chart has no zoom of its own.
    button.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      this.host?.openMap();
    });
  }

  private finishPinch(pinch: Pinch): void {
    this.pinch = null;
    for (const pointerId of pinch.pointerIds) {
      // The retired tap's finger keeps its capture: its release is still
      // owed to the button, where it is ignored.
      if (this.tap && this.tap.pointerId === pointerId) continue;
      this.releaseCapture(this.buttonEl, pointerId);
    }
    if (this.host) {
      this.host.setWidthPx(miniReleaseWidth(pinch.range, pinch.widthPx), 'commit');
      this.commits++;
    }
    this.endResize();
  }

  // ── The grip: drag to resize, double-tap to reset ────────────────────────

  private wireGrip(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (this.drag || this.pinch || !this.host) return;
      if (!this.capture(grip, event.pointerId)) return;
      // No focus change, no text selection, and the flight zone under the
      // grip's reach never hears of it.
      event.preventDefault();
      event.stopPropagation();
      const widthPx = this.host.widthPx();
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidthPx: widthPx,
        widthPx,
        range: this.host.sizeRange(),
        movedPx: 0,
      };
      window.addEventListener('keydown', this.onWindowKeyDown, true);
      this.beginResize();
    });
    grip.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId || !this.host) return;
      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      drag.movedPx = Math.max(drag.movedPx, Math.hypot(dx, dy));
      // The finger asks for a width; the chart gives what the canvas can of it.
      drag.widthPx = clampWidth(miniDragWidth(drag.startWidthPx, dx, dy), drag.range);
      this.host.setWidthPx(drag.widthPx, 'live');
    });
    grip.addEventListener('pointerup', (event) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.movedPx > TAP_MAX_PX) {
        this.finishDrag(drag, 'commit');
        return;
      }
      // A press that stayed put is a tap on the grip. It resizes nothing — a
      // nudge inside the slop goes back where it was — and two of them inside
      // the window put the size back to the default.
      this.finishDrag(drag, 'restore');
      const nowMs = event.timeStamp;
      if (nowMs - this.lastGripTapMs <= GRIP_DOUBLE_TAP_MS) {
        this.lastGripTapMs = Number.NEGATIVE_INFINITY;
        this.host?.resetSize();
      } else {
        this.lastGripTapMs = nowMs;
      }
    });
    const lost = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.finishDrag(drag, drag.movedPx > TAP_MAX_PX ? 'commit' : 'restore');
    };
    grip.addEventListener('pointercancel', lost);
    grip.addEventListener('lostpointercapture', lost);
  }

  /** Escape: the chart goes back to where the drag started, nothing saved. */
  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.finishDrag(drag, 'restore');
  }

  /**
   * End a drag. `commit` settles the width the way a release does and saves
   * it; `restore` hands back the width the drag started from and saves
   * nothing. Either way the capture goes back and the Escape listener comes
   * off.
   */
  private finishDrag(drag: CornerDrag, outcome: 'commit' | 'restore'): void {
    if (this.drag !== drag) return;
    this.drag = null;
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    this.releaseCapture(this.gripEl, drag.pointerId);
    if (this.host) {
      if (outcome === 'commit') {
        this.host.setWidthPx(miniReleaseWidth(drag.range, drag.widthPx), 'commit');
        this.commits++;
      } else if (drag.widthPx !== drag.startWidthPx) {
        this.host.setWidthPx(drag.startWidthPx, 'live');
      }
    }
    this.endResize();
  }

  // ── Shared ───────────────────────────────────────────────────────────────

  private beginResize(): void {
    this.boxEl?.classList.add('resizing');
    document.body.classList.add('mini-chart-resizing');
    this.host?.resizeStarted();
  }

  private endResize(): void {
    if (this.isResizing()) return;
    this.boxEl?.classList.remove('resizing');
    document.body.classList.remove('mini-chart-resizing');
    this.host?.resizeEnded();
  }

  /** Take the pointer, or say the gesture cannot be armed: a pointer that is
   *  already gone (the sheets' idiom) must never start something that
   *  cannot end. */
  private capture(el: HTMLElement, pointerId: number): boolean {
    try {
      el.setPointerCapture(pointerId);
      return true;
    } catch {
      return false;
    }
  }

  private releaseCapture(el: HTMLElement | null, pointerId: number): void {
    if (!el) return;
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      // the capture is already gone
    }
  }
}

function clampWidth(widthPx: number, range: MiniSizeRange): number {
  if (!Number.isFinite(widthPx)) return range.defaultWidthPx;
  return Math.round(Math.min(range.maxWidthPx, Math.max(range.minWidthPx, widthPx)));
}
