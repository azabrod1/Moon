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
 */
export class PauseBadge {
  private readonly el: HTMLElement | null;
  private visible = false;
  private readonly onActivate: () => void;

  constructor(onResume: () => void) {
    this.el = document.getElementById('planetarium-pause-badge');
    this.onActivate = onResume;
    this.el?.addEventListener('click', this.onActivate);
  }

  render(visible: boolean): void {
    if (!this.el || visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle('visible', visible);
  }

  dispose(): void {
    this.el?.removeEventListener('click', this.onActivate);
  }
}
