/**
 * The Look-at menu: a compact centered card listing the landed sky's
 * pickable targets (Sun / parent planet / moons) with their live apparent
 * sizes. The root element is a full-screen click-catcher — the Observatory
 * panel and the mobile sheet are not clickable behind it, and tapping
 * outside the card closes. Rows rebuild on every open (apparent sizes are
 * live quantities); nothing renders per-frame.
 */
import {
  formatDiscDeg,
  surfaceTargetKey,
  type SurfaceTarget,
  type SurfaceTargetChoice,
} from '../surfaceView';

export class SurfaceTargetMenu {
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private wired = false;

  /** `onClose` fires on every open→closed transition, whatever triggered it
   *  (×, click-away, or the owner) — the owner restores label visibility
   *  there, so no close path can leave the world labels hidden. */
  constructor(
    private onPick: (target: SurfaceTarget) => void,
    private onClose: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('surface-target-menu');
    this.listEl = document.getElementById('surface-target-list');
    this.subEl = document.getElementById('surface-target-sub');
    if (this.wired) return;
    this.wired = true;
    document
      .getElementById('surface-target-menu-close')
      ?.addEventListener('click', () => this.close());
    this.rootEl?.addEventListener('click', (e) => {
      if (e.target === this.rootEl) this.close();
    });
  }

  /** Rebuild rows and show. `currentKey` marks the target already in view
   *  (set on in-view opens, null pre-entry). */
  open(choices: SurfaceTargetChoice[], currentKey: string | null, subText: string): void {
    if (!this.rootEl || !this.listEl) return;
    if (this.subEl) this.subEl.textContent = subText;
    this.listEl.textContent = '';
    for (const choice of choices) {
      const row = document.createElement('button');
      const current = currentKey !== null && surfaceTargetKey(choice.target) === currentKey;
      row.className =
        'travel-item stm-row' +
        (choice.resolvable ? '' : ' stm-dim') +
        (current ? ' travel-item-current' : '');
      const dot = document.createElement('span');
      dot.className = 'travel-item-dot';
      dot.style.background = `#${choice.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'travel-item-name';
      name.textContent = choice.name;
      const meta = document.createElement('span');
      meta.className = 'stm-meta';
      meta.textContent = `∅ ${formatDiscDeg(choice.discDeg)}°${choice.resolvable ? '' : ' · too small'}`;
      row.append(dot, name, meta);
      row.addEventListener('click', () => this.onPick(choice.target));
      this.listEl.appendChild(row);
    }
    this.rootEl.classList.add('visible');
    this.listEl.scrollTop = 0;
  }

  close(): void {
    if (!this.isOpen()) return;
    this.rootEl?.classList.remove('visible');
    this.onClose();
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }
}
