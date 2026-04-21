/**
 * Transient notification banner shown in the Planetarium HUD. Fades after
 * 4 seconds; each new call cancels the previous timeout.
 */
const VISIBLE_MS = 4000;

export class PlanetariumNotification {
  private el: HTMLElement | null;
  private hideTimeout: number | null = null;

  constructor() {
    this.el = document.getElementById('planetarium-notification');
  }

  show(text: string): void {
    if (!this.el) return;
    this.el.textContent = text;
    this.el.classList.add('visible');

    if (this.hideTimeout !== null) clearTimeout(this.hideTimeout);
    this.hideTimeout = window.setTimeout(() => {
      this.el?.classList.remove('visible');
      this.hideTimeout = null;
    }, VISIBLE_MS);
  }

  dispose(): void {
    if (this.hideTimeout !== null) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }
}
