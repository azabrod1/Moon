import type { MapCardAction, MapVerb } from '../map/mapLogic';

/**
 * MapHUD — the on-screen controls for the System map: the segmented scale
 * control (both states always visible, the active one marked), the close chip,
 * the ◂ Overview chip that releases a focus, and the picked-body card (tint dot,
 * name, live distance, action buttons).
 *
 * DOM-thin: the markup lives in index.html, this caches the elements and wires
 * their listeners once (the bind()/wired idiom). It owns no map state — it
 * reports intent through the callbacks and reflects state through its setters.
 */
export class MapHUD {
  private root: HTMLElement | null = null;
  private segCompressed: HTMLButtonElement | null = null;
  private segTrue: HTMLButtonElement | null = null;
  private overviewChip: HTMLElement | null = null;
  private chipShown = false;

  private card: HTMLElement | null = null;
  private cardDot: HTMLElement | null = null;
  private cardName: HTMLElement | null = null;
  private cardDist: HTMLElement | null = null;
  private cardActions: HTMLElement | null = null;
  private lastDist = '';
  private lastDisabled = false;
  private wired = false;

  constructor(
    private readonly onScale: (trueScale: boolean) => void,
    private readonly onClose: () => void,
    private readonly onVerb: (verb: MapVerb) => void,
    private readonly onFocus: () => void,
    private readonly onOverview: () => void,
  ) {}

  /** Cache elements (every activation) and wire listeners once. */
  bind(): void {
    this.root = document.getElementById('system-map-ui');
    this.segCompressed = document.getElementById('map-scale-compressed') as HTMLButtonElement | null;
    this.segTrue = document.getElementById('map-scale-true') as HTMLButtonElement | null;
    this.overviewChip = document.getElementById('map-overview');
    this.card = document.getElementById('map-card');
    this.cardDot = document.getElementById('map-card-dot');
    this.cardName = document.getElementById('map-card-name');
    this.cardDist = document.getElementById('map-card-dist');
    this.cardActions = document.getElementById('map-card-actions');
    if (this.wired) return;
    this.wired = true;
    this.segCompressed?.addEventListener('click', () => this.onScale(false));
    this.segTrue?.addEventListener('click', () => this.onScale(true));
    document.getElementById('map-close')?.addEventListener('click', () => this.onClose());
    this.overviewChip?.addEventListener('click', () => this.onOverview());
    // Delegated so the rebuilt-per-pick buttons need no per-button listeners.
    // Focus and the commit verbs travel on different attributes, so a commit
    // handler can never be reached by a button that isn't one.
    this.cardActions?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (btn.dataset.action === 'focus') this.onFocus();
      else if (btn.dataset.verb) this.onVerb(btn.dataset.verb as MapVerb);
    });
  }

  /** Show the ◂ Overview chip while the camera is on a body. The map itself has
   *  no HUD reference, so the per-frame refresh owns this; writes on change. */
  setOverviewChip(visible: boolean): void {
    if (visible === this.chipShown) return;
    this.chipShown = visible;
    this.overviewChip?.classList.toggle('visible', visible);
  }

  show(): void {
    // Explicit value — the element's CSS default is display:none, so clearing
    // the inline style would hide it, not show it.
    if (this.root) this.root.style.display = 'block';
  }

  hide(): void {
    if (this.root) this.root.style.display = 'none';
    this.hideCard();
    this.setOverviewChip(false);
  }

  /** Reflect which scale is active on the segmented control. */
  render(trueScale: boolean): void {
    this.setActive(this.segCompressed, !trueScale);
    this.setActive(this.segTrue, trueScale);
  }

  isCardOpen(): boolean {
    return !!this.card?.classList.contains('visible');
  }

  /** Show (or replace in place) the picked-body card. */
  showCard(
    displayName: string,
    colorCss: string,
    distText: string,
    actions: MapCardAction[],
    disabled: boolean,
  ): void {
    if (!this.card) return;
    if (this.cardDot) this.cardDot.style.background = colorCss;
    if (this.cardName) this.cardName.textContent = displayName;
    this.lastDist = distText;
    this.lastDisabled = disabled;
    if (this.cardDist) this.cardDist.textContent = distText;
    if (this.cardActions) {
      this.cardActions.innerHTML = '';
      for (const action of actions) {
        const btn = document.createElement('button');
        btn.className = 'map-card-btn';
        if (action.kind === 'commit') {
          btn.dataset.action = 'commit';
          btn.dataset.verb = action.verb;
          // Only a commit waits on an arrival; Focus is a camera move and stays
          // live throughout.
          btn.disabled = disabled;
        } else {
          btn.dataset.action = 'focus';
        }
        btn.textContent = action.label;
        this.cardActions.appendChild(btn);
      }
    }
    this.card.classList.add('visible');
    this.measureCard();
  }

  hideCard(): void {
    this.card?.classList.remove('visible');
  }

  /** Live distance readout — writes only on a change. */
  setDistanceText(text: string): void {
    if (text === this.lastDist) return;
    this.lastDist = text;
    if (this.cardDist) this.cardDist.textContent = text;
  }

  /** Grey the commit buttons out while an arrival is in flight (writes on
   *  change). Focus is not one of them — the camera is always free to move. */
  setActionsDisabled(disabled: boolean): void {
    if (!this.cardActions || disabled === this.lastDisabled) return;
    this.lastDisabled = disabled;
    for (const btn of this.cardActions.querySelectorAll('button[data-action="commit"]')) {
      (btn as HTMLButtonElement).disabled = disabled;
    }
  }

  /** Dock the card above the bottom bands (bar + scale control) — measured, so
   *  a narrow phone's stacked controls never collide with it. */
  measureCard(): void {
    if (!this.card || !this.isCardOpen()) return;
    const top = (id: string): number => {
      const el = document.getElementById(id);
      return el ? el.getBoundingClientRect().top : Infinity;
    };
    const bandsTop = Math.min(top('planetarium-bottom-bar'), top('map-scale'));
    const bottom = Number.isFinite(bandsTop) ? window.innerHeight - bandsTop + 12 : 96;
    this.card.style.bottom = `${Math.round(bottom)}px`;
  }

  private setActive(seg: HTMLButtonElement | null, active: boolean): void {
    if (!seg) return;
    seg.classList.toggle('on', active);
    seg.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}
