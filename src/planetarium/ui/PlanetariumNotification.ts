/**
 * Transient notification banner shown in the Planetarium HUD. Fades after
 * 4 seconds; each new call cancels the previous timeout.
 *
 * A banner can carry one action button (a failed tool open offers Reload).
 * Such a banner stays up three times as long, since the reader has to find
 * and press it, and it takes pointers, which the plain banner never does so
 * the scene under it stays clickable.
 */
const VISIBLE_MS = 4000;
const VISIBLE_WITH_ACTION_MS = 12000;

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface NotificationOptions {
  /** Bypass the mute — for the manual-Save confirmation and the tutorial's
   *  own end toasts, which must not be silent. */
  force?: boolean;
  action?: NotificationAction;
}

export class PlanetariumNotification {
  private el: HTMLElement | null;
  private hideTimeout: number | null = null;
  private muted = false;

  constructor() {
    this.el = document.getElementById('planetarium-notification');
  }

  /**
   * While muted (the guided tutorial: the card is the narrator, and on phones
   * the banner zone is where the card sits) non-forced banners drop
   * silently. Muting also clears any banner already up, so a toast fired
   * just before the tutorial started cannot linger under the card.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.clear();
  }

  show(text: string, opts?: NotificationOptions): void {
    if (!this.el) return;
    if (this.muted && !opts?.force) return;
    const action = opts?.action;
    this.el.textContent = text;
    this.el.classList.toggle('has-action', !!action);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notification-action';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        this.clear();
        action.run();
      });
      this.el.append(' ', button);
    }
    this.el.classList.add('visible');

    if (this.hideTimeout !== null) clearTimeout(this.hideTimeout);
    this.hideTimeout = window.setTimeout(() => {
      this.el?.classList.remove('visible');
      this.hideTimeout = null;
    }, action ? VISIBLE_WITH_ACTION_MS : VISIBLE_MS);
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
