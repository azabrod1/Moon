/**
 * The Paused badge: a glass pill at the top centre of the Planetarium HUD
 * saying the clock is stopped and the ship held with it — the freeze Space
 * (or the ☰ menu) lays over the scene. Pure DOM: the owner decides whether
 * it shows (pauseBadgeLogic.ts) and hands the answer here on every time-UI
 * refresh; the last state is cached so a refresh writes nothing when nothing
 * changed. It is a button: activating it resumes through the owner's guarded
 * clock control, which on a touch screen is the one large resume target
 * outside the bar. Visibility (not display) carries the fade, and a hidden
 * badge leaves the tab order with it.
 *
 * Beside it sits its spoken twin, an off-screen live region: a screen reader
 * hears "Paused" or "Resumed" when a control changes the clock, which Space,
 * a rail tap, the surface strip and the badge itself cannot say natively
 * (the panel's radios can, and stay quiet here). The owner decides what is
 * spoken; a modal's own freeze is not a control and says nothing.
 */
export class PauseBadge {
  private readonly el: HTMLElement | null;
  private readonly liveEl: HTMLElement | null;
  private visible = false;
  private readonly onActivate: () => void;

  constructor(onResume: () => void) {
    this.el = document.getElementById('planetarium-pause-badge');
    this.liveEl = document.getElementById('planetarium-pause-live');
    this.onActivate = onResume;
    this.el?.addEventListener('click', this.onActivate);
  }

  render(visible: boolean): void {
    if (!this.el || visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle('visible', visible);
  }

  /** Say it for a screen reader. Written even when the text repeats: a fresh
   *  text node is a mutation, which is what a live region reads. */
  announce(text: string): void {
    if (this.liveEl) this.liveEl.textContent = text;
  }

  dispose(): void {
    this.el?.removeEventListener('click', this.onActivate);
  }
}
