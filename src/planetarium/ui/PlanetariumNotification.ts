/**
 * Transient notification banner shown in the Planetarium HUD. Fades after
 * 4 seconds; each new call cancels the previous timeout.
 */
const VISIBLE_MS = 4000;

export class PlanetariumNotification {
  private el: HTMLElement | null;
  private hideTimeout: number | null = null;
  private muted = false;

  constructor() {
    this.el = document.getElementById('planetarium-notification');
  }

  /**
   * While muted (the guided tour: the card is the narrator, and on phones
   * the banner zone is where the card sits) non-forced banners drop
   * silently. Muting also clears any banner already up, so a toast fired
   * just before the tour started cannot linger under the card.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.clear();
  }

  /** `force` bypasses the mute — for the manual-Save confirmation and the
   *  tour's own end toasts, which must not be silent. */
  show(text: string, opts?: { force?: boolean }): void {
    if (!this.el) return;
    if (this.muted && !opts?.force) return;
    this.el.textContent = text;
    this.el.classList.add('visible');

    if (this.hideTimeout !== null) clearTimeout(this.hideTimeout);
    this.hideTimeout = window.setTimeout(() => {
      this.el?.classList.remove('visible');
      this.hideTimeout = null;
    }, VISIBLE_MS);
  }

  private clear(): void {
    if (this.hideTimeout !== null) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.el?.classList.remove('visible');
  }

  dispose(): void {
    if (this.hideTimeout !== null) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }
}
