/**
 * Pointer input for the Observatory's surface view: drag → look-around pixel
 * deltas (content follows the finger), mouse wheel / two-pointer pinch → a
 * multiplicative FOV zoom factor. Replaces OrbitControls wholesale while the
 * surface view is active — orbit semantics can't express look-from-a-point.
 * GyroSteering/FlightInput lifecycle idiom: construct once, `attach()` on
 * entry, `detach()` on exit; the owner converts deltas to radians at the
 * current FOV and clamps the zoom.
 */
export class SurfaceLook {
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist: number | null = null;
  private attached = false;

  constructor(
    private readonly dom: HTMLElement,
    /** Raw pixel drag deltas; any call means the user broke target tracking. */
    private readonly onLook: (dxPx: number, dyPx: number) => void,
    /** Multiplicative FOV factor (> 1 widens the view). */
    private readonly onZoom: (factor: number) => void,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.dom.addEventListener('pointerdown', this.handlePointerDown);
    this.dom.addEventListener('pointermove', this.handlePointerMove);
    this.dom.addEventListener('pointerup', this.handlePointerEnd);
    this.dom.addEventListener('pointercancel', this.handlePointerEnd);
    this.dom.addEventListener('lostpointercapture', this.handlePointerEnd);
    // Not passive: the wheel must zoom the view, never scroll the page.
    this.dom.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.dom.removeEventListener('pointerdown', this.handlePointerDown);
    this.dom.removeEventListener('pointermove', this.handlePointerMove);
    this.dom.removeEventListener('pointerup', this.handlePointerEnd);
    this.dom.removeEventListener('pointercancel', this.handlePointerEnd);
    this.dom.removeEventListener('lostpointercapture', this.handlePointerEnd);
    this.dom.removeEventListener('wheel', this.handleWheel);
    // Release any mid-drag captures (detach can land mid-gesture — Escape,
    // mission start) so the pointer doesn't stay bound to the canvas.
    for (const pointerId of this.pointers.keys()) {
      try {
        this.dom.releasePointerCapture?.(pointerId);
      } catch {
        // Already released by the browser — fine.
      }
    }
    this.pointers.clear();
    this.pinchDist = null;
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinchDist = this.currentPinchDist();
  };

  private handlePointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      if (dx !== 0 || dy !== 0) this.onLook(dx, dy);
      return;
    }
    const dist = this.currentPinchDist();
    if (dist !== null && this.pinchDist !== null && dist > 0 && this.pinchDist > 0) {
      // Pinch out (growing spread) zooms in (narrower FOV).
      this.onZoom(this.pinchDist / dist);
    }
    this.pinchDist = dist;
  };

  private handlePointerEnd = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = this.currentPinchDist();
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    // ~10% FOV per wheel notch; trackpads stream small deltas continuously.
    this.onZoom(Math.exp(e.deltaY * 0.001));
  };

  private currentPinchDist(): number | null {
    if (this.pointers.size < 2) return null;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
