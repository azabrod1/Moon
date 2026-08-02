import type { MapCardAction, MapVerb } from '../map/mapLogic';
import type { FactRow } from '../map/mapFacts';
import { makeTiltGlyph } from './mapTiltGlyph';

/**
 * MapHUD — the on-screen controls for the System map: the segmented scale
 * control (both states always visible, the active one marked), the close chip,
 * the ◂ Overview chip that releases a focus, and the picked-body card (tint dot,
 * name, live distance, one-line description, action buttons, facts).
 *
 * DOM-thin: the markup lives in index.html, this caches the elements and wires
 * their listeners once (the bind()/wired idiom). It owns no map state — it
 * reports intent through the callbacks and reflects state through its setters.
 * The facts arrive as data, already resolved and formatted; this decides
 * nothing about them but how they are painted and how much room they get.
 */

/** The facts viewport is worth having at three rows or more. Below that the
 *  card would carry a hairline, a scrollbar and a sliver — so the section comes
 *  off instead, and the actions keep the room. Measured: three ~14 px rows,
 *  their two gaps, the hairline and its pad. */
const MIN_FACTS_PX = 66;

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
  private cardLine: HTMLElement | null = null;
  private cardActions: HTMLElement | null = null;
  private cardFacts: HTMLElement | null = null;
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
    this.cardLine = document.getElementById('map-card-line');
    this.cardActions = document.getElementById('map-card-actions');
    this.cardFacts = document.getElementById('map-card-facts');
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
    // On a phone the chip lands on its own row below the close button, so it
    // is part of the top chrome the card's height is measured against. A card
    // opened at a clean overview and then Focus-ed would otherwise keep a cap
    // that never knew the chip was coming.
    this.measureCard();
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

  /** Show (or replace in place) the picked-body card. The rows and the one-liner
   *  arrive finished — this paints them and never asks a catalog anything. */
  showCard(
    displayName: string,
    colorCss: string,
    distText: string,
    actions: MapCardAction[],
    disabled: boolean,
    rows: readonly FactRow[],
    oneLiner: string,
  ): void {
    if (!this.card) return;
    if (this.cardDot) this.cardDot.style.background = colorCss;
    if (this.cardName) this.cardName.textContent = displayName;
    this.lastDist = distText;
    this.lastDisabled = disabled;
    if (this.cardDist) this.cardDist.textContent = distText;
    if (this.cardLine) this.cardLine.textContent = oneLiner;
    this.renderFacts(rows, colorCss);
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

  /** Rebuild the fact rows. Called only from showCard — the facts are catalog
   *  figures, so nothing about them changes while the card stands open. */
  private renderFacts(rows: readonly FactRow[], colorCss: string): void {
    const facts = this.cardFacts;
    if (!facts) return;
    facts.innerHTML = '';
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'map-card-fact';
      const key = document.createElement('span');
      key.className = 'map-card-fact-k';
      key.textContent = row.label;
      line.appendChild(key);
      if (typeof row.value === 'string') {
        const value = document.createElement('span');
        value.className = 'map-card-fact-v';
        value.textContent = row.value;
        line.appendChild(value);
      } else {
        line.appendChild(makeTiltGlyph(row.value.tiltDeg, colorCss));
      }
      facts.appendChild(line);
    }
  }

  /**
   * Dock the card above the bottom bands (bar + scale control) and cap its
   * height at the room actually left between them and the top chrome —
   * measured, so a narrow phone's stacked controls never collide with it.
   *
   * "Top chrome" is both the close button and the ◂ Overview chip: below 640 px
   * the chip drops to its own row, and that row is the tightest case this
   * exists for. What gives under the cap is the facts section; if the room left
   * for it will not hold three rows, it comes off entirely and the actions keep
   * the space.
   */
  measureCard(): void {
    if (!this.card || !this.isCardOpen()) return;
    const rect = (id: string): DOMRect | null => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // A hidden chip measures as a zero box wherever it sits — read it as
      // absent rather than as chrome at the top of the viewport.
      return r.height > 0 ? r : null;
    };
    const bandsTop = Math.min(
      rect('planetarium-bottom-bar')?.top ?? Infinity,
      rect('map-scale')?.top ?? Infinity,
    );
    const bottom = Math.round(Number.isFinite(bandsTop) ? window.innerHeight - bandsTop + 12 : 96);
    this.card.style.bottom = `${bottom}px`;

    const chromeBottom = Math.max(
      rect('map-close')?.bottom ?? 0,
      rect('map-overview')?.bottom ?? 0,
    );
    // The card's own bottom edge sits at (innerHeight − bottom); the top chrome
    // ends at chromeBottom, and 12 px of air between them is the same gap the
    // dock leaves at the other end.
    const available = Math.max(0, window.innerHeight - bottom - chromeBottom - 12);

    // Measure the card at its natural height first: the facts' share is
    // whatever the cap leaves after the chrome that cannot shrink.
    const facts = this.cardFacts;
    this.card.style.maxHeight = '';
    if (facts) facts.style.display = '';
    const naturalH = this.card.getBoundingClientRect().height;
    const factsH = facts ? facts.getBoundingClientRect().height : 0;
    const factsRoom = available - (naturalH - factsH);
    if (facts && factsRoom < MIN_FACTS_PX) facts.style.display = 'none';
    this.card.style.maxHeight = `${Math.round(available)}px`;
  }

  private setActive(seg: HTMLButtonElement | null, active: boolean): void {
    if (!seg) return;
    seg.classList.toggle('on', active);
    seg.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}
