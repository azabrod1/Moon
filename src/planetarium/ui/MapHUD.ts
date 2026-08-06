import type { MapCardAction, MapVerb } from '../map/mapLogic';
import type { FactRow } from '../map/mapFacts';
import type { MapEventRowModel } from '../map/mapEvents';
import { makeTiltGlyph } from './mapTiltGlyph';

/**
 * MapHUD — the on-screen controls for the System map: the console (scale
 * segment, zoom pair, Overview, Flip, Focus, and the line that explains the
 * chart), the close chip, the info popover, and the picked-body card (tint dot,
 * name, live distance, one-line description, action buttons, the system's next
 * event, facts).
 *
 * DOM-thin: the markup lives in index.html, this caches the elements and wires
 * their listeners once (the bind()/wired idiom). It owns no map state — it
 * reports intent through the callbacks and reflects state through its setters.
 * The facts arrive as data, already resolved and formatted; this decides
 * nothing about them but how they are painted and how much room they get.
 */

/** Sit a map popover directly above the console and cap it at the room left
 *  over. Measured rather than written into the stylesheet: the console's height
 *  is whatever its rows come to, and it changes shape at the phone breakpoint.
 *  Exported because the Focus picker is its own widget and hangs in the same
 *  place. */
export function anchorAboveMapConsole(el: HTMLElement): void {
  const consoleEl = document.getElementById('map-console');
  const rect = consoleEl?.getBoundingClientRect();
  if (!rect || !(rect.height > 0)) return;
  const gap = 8;
  el.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
  // The top chrome is the ceiling, not the viewport: the action cluster sits
  // ABOVE the map layer and stays clickable over it, so a popover grown into
  // that corner would put its own search box behind a live button.
  let ceiling = 0;
  for (const id of ['map-close', 'planetarium-actions']) {
    const chrome = document.getElementById(id)?.getBoundingClientRect();
    if (chrome && chrome.height > 0) ceiling = Math.max(ceiling, chrome.bottom);
  }
  // 12 px of air below it, the same margin the chart's other corners keep.
  el.style.maxHeight = `${Math.max(0, Math.round(rect.top - gap - ceiling - 12))}px`;
}

/** The facts viewport is worth having at three rows or more. Below that the
 *  card would carry a hairline, a scrollbar and a sliver — so the section comes
 *  off instead, and the actions keep the room. Measured: three ~14 px rows,
 *  their two gaps, the hairline and its pad. */
const MIN_FACTS_PX = 66;

export class MapHUD {
  private root: HTMLElement | null = null;
  private consoleEl: HTMLElement | null = null;
  private segCompressed: HTMLButtonElement | null = null;
  private segTrue: HTMLButtonElement | null = null;
  private overviewBtn: HTMLButtonElement | null = null;
  private flipBtn: HTMLButtonElement | null = null;
  private focusBtn: HTMLButtonElement | null = null;
  private infoBtn: HTMLButtonElement | null = null;
  private infoPop: HTMLElement | null = null;
  private infoBody: HTMLElement | null = null;
  private overviewOn = true;
  private flipOn = true;

  /** The console's own buttons, assigned by the owner (the bottom bar's
   *  idiom). The constructor's callbacks are the card's and the segment's —
   *  these arrived with the console and are kept apart from them. */
  onFlip: () => void = () => {};
  onFocusMenu: () => void = () => {};
  /** The ⓘ line. The owner decides — it folds the other instruments away
   *  before this one appears. */
  onInfo: () => void = () => {};
  /** The map layer is going down: the owner closes whatever else it has open
   *  over the chart. */
  onHidden: () => void = () => {};

  private card: HTMLElement | null = null;
  private cardDot: HTMLElement | null = null;
  private cardName: HTMLElement | null = null;
  private cardDist: HTMLElement | null = null;
  private cardLine: HTMLElement | null = null;
  private cardActions: HTMLElement | null = null;
  private cardFacts: HTMLElement | null = null;
  private cardEvent: HTMLElement | null = null;
  private cardEventLabel: HTMLElement | null = null;
  private cardEventWhen: HTMLElement | null = null;
  /** The event the row is painted with, or null when it carries none. Held
   *  because measureCard re-shows the row to measure it, and only a row with
   *  something to say may come back. */
  private eventRow: MapEventRowModel | null = null;
  private hoverMeta: HTMLElement | null = null;
  private lastHoverMeta: string | null = null;
  private lastDist = '';
  private lastDisabled = false;
  private wired = false;

  constructor(
    private readonly onScale: (trueScale: boolean) => void,
    private readonly onClose: () => void,
    private readonly onVerb: (verb: MapVerb) => void,
    private readonly onFocus: () => void,
    private readonly onOverview: () => void,
    private readonly onEvent: () => void,
  ) {}

  /** Cache elements (every activation) and wire listeners once. */
  bind(): void {
    this.root = document.getElementById('system-map-ui');
    this.consoleEl = document.getElementById('map-console');
    this.segCompressed = document.getElementById('map-scale-compressed') as HTMLButtonElement | null;
    this.segTrue = document.getElementById('map-scale-true') as HTMLButtonElement | null;
    this.overviewBtn = document.getElementById('map-overview') as HTMLButtonElement | null;
    this.flipBtn = document.getElementById('map-flip') as HTMLButtonElement | null;
    this.focusBtn = document.getElementById('map-focus') as HTMLButtonElement | null;
    this.infoBtn = document.getElementById('map-info') as HTMLButtonElement | null;
    this.infoPop = document.getElementById('map-info-popover');
    this.infoBody = document.getElementById('map-info-body');
    this.card = document.getElementById('map-card');
    this.cardDot = document.getElementById('map-card-dot');
    this.cardName = document.getElementById('map-card-name');
    this.cardDist = document.getElementById('map-card-dist');
    this.cardLine = document.getElementById('map-card-line');
    this.cardActions = document.getElementById('map-card-actions');
    this.cardFacts = document.getElementById('map-card-facts');
    this.cardEvent = document.getElementById('map-card-event');
    this.cardEventLabel = document.getElementById('map-card-event-label');
    this.cardEventWhen = document.getElementById('map-card-event-when');
    this.hoverMeta = document.getElementById('map-hover-meta');
    if (this.wired) return;
    this.wired = true;
    this.segCompressed?.addEventListener('click', () => this.onScale(false));
    this.segTrue?.addEventListener('click', () => this.onScale(true));
    document.getElementById('map-close')?.addEventListener('click', () => this.onClose());
    this.overviewBtn?.addEventListener('click', () => this.onOverview());
    this.flipBtn?.addEventListener('click', () => this.onFlip());
    this.focusBtn?.addEventListener('click', () => this.onFocusMenu());
    this.infoBtn?.addEventListener('click', () => this.onInfo());
    // The fade follows the scroll — it lifts at the end, or it would slice the
    // closing line's glyphs with nothing below to promise.
    this.infoBody?.addEventListener('scroll', () => this.updateInfoFade());
    // Delegated so the rebuilt-per-pick buttons need no per-button listeners.
    // Focus and the commit verbs travel on different attributes, so a commit
    // handler can never be reached by a button that isn't one.
    // The whole event row is one target — it says one thing and does one thing.
    this.cardEvent?.addEventListener('click', () => this.onEvent());
    this.cardActions?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (btn.dataset.action === 'focus') this.onFocus();
      else if (btn.dataset.verb) this.onVerb(btn.dataset.verb as MapVerb);
    });
  }

  /** Grey the Overview row when neither of its journeys home is on offer, and
   *  the Flip row while anything else owns the camera. The map itself has no
   *  HUD reference, so the per-frame refresh owns both; they write on change. */
  setOverviewEnabled(enabled: boolean): void {
    if (enabled === this.overviewOn) return;
    this.overviewOn = enabled;
    if (this.overviewBtn) this.overviewBtn.disabled = !enabled;
  }

  setFlipEnabled(enabled: boolean): void {
    if (enabled === this.flipOn) return;
    this.flipOn = enabled;
    if (this.flipBtn) this.flipBtn.disabled = !enabled;
  }

  /** Light the Focus button while its picker stands open. */
  setFocusMenuOpen(open: boolean): void {
    this.focusBtn?.classList.toggle('open', open);
  }

  /** Stand the console down while another instrument takes its corner (Stats
   *  and Time both open into it), and put it back when they close. */
  setConsoleStoodDown(down: boolean): void {
    this.consoleEl?.classList.toggle('stood-down', down);
  }

  isInfoOpen(): boolean {
    return !!this.infoPop?.classList.contains('visible');
  }

  openInfo(): void {
    if (!this.infoPop) return;
    this.infoPop.classList.add('visible');
    anchorAboveMapConsole(this.infoPop);
    // Judge the fade AFTER the cap is applied: asking before it would answer
    // "fits" every time and the fade would never appear.
    this.updateInfoFade();
    this.infoBtn?.classList.add('open');
  }

  /** The fade marks MORE BELOW, nothing else: it shows only while the body
   *  overflows AND has somewhere left to scroll. A mask that stayed at the
   *  end of the scroll would cut the closing sentence's glyphs in half —
   *  which is exactly how it read on an 800px-tall viewport. */
  private updateInfoFade(): void {
    const body = this.infoBody;
    if (!body) return;
    const more = body.scrollHeight > body.clientHeight + 1
      && body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    body.classList.toggle('scrolls', more);
  }

  /** Re-seat an open info popover after a viewport change (the picker's rule:
   *  the console changes shape at the breakpoint under it). The scroll fade is
   *  re-judged too — the new cap can make a scrolling body fit, or vice versa. */
  reanchorInfo(): void {
    if (!this.isInfoOpen() || !this.infoPop) return;
    anchorAboveMapConsole(this.infoPop);
    this.updateInfoFade();
  }

  /** Closing blurs the button as well: a popover dismissed by Esc must not
   *  leave the keyboard focus sitting on the control that reopens it. */
  closeInfo(): void {
    if (!this.isInfoOpen()) return;
    this.infoPop?.classList.remove('visible');
    this.infoBtn?.classList.remove('open');
    this.infoBtn?.blur();
  }

  show(): void {
    // Explicit value — the element's CSS default is display:none, so clearing
    // the inline style would hide it, not show it.
    if (this.root) this.root.style.display = 'block';
    this.setConsoleStoodDown(false);
  }

  hide(): void {
    if (this.root) this.root.style.display = 'none';
    this.hideCard();
    this.setHoverMeta(null);
    this.closeInfo();
    this.setConsoleStoodDown(false);
    // Whatever else the owner has standing over the chart goes with the layer.
    this.onHidden();
  }

  /** The line about the body under the cursor, or null for nothing hovered.
   *  Arrives finished, like the card's facts; writes only on a change, because
   *  the caller resolves the hover every frame. */
  setHoverMeta(text: string | null): void {
    // Element first: a call before bind() (a lifecycle reset with the map never
    // opened) must not bank a value the DOM never received, or the next
    // identical call would be skipped as a no-op.
    if (!this.hoverMeta || text === this.lastHoverMeta) return;
    this.lastHoverMeta = text;
    this.hoverMeta.textContent = text ?? '';
    this.hoverMeta.classList.toggle('visible', text !== null);
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
    // A new body is a new sky: whatever the last one's search found says
    // nothing about this one, so the row starts empty and the owner refills it.
    this.eventRow = null;
    if (this.cardEvent) this.cardEvent.style.display = 'none';
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
    this.eventRow = null;
    if (this.cardEvent) this.cardEvent.style.display = 'none';
  }

  /**
   * The system's next event, or null while the search has nothing to show —
   * which covers "still scanning" as well as "nothing in range". The chart
   * says nothing rather than narrating its own search: the row is news, and a
   * card that reports its own housekeeping is noise.
   */
  setEventRow(model: MapEventRowModel | null): void {
    if (!this.cardEvent) return;
    const same = model !== null && this.eventRow !== null
      && model.label === this.eventRow.label && model.when === this.eventRow.when;
    if (same || (model === null && this.eventRow === null)) return;
    this.eventRow = model;
    if (model) {
      if (this.cardEventLabel) this.cardEventLabel.textContent = model.label;
      if (this.cardEventWhen) this.cardEventWhen.textContent = model.when;
    }
    // measureCard re-decides the display: on a short card the row is what
    // gives, and it must not paint itself back in behind that decision.
    this.measureCard();
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
   * Dock the card above the bottom bands and cap its height at the room
   * actually left between them and the top chrome — measured, so a narrow
   * phone's stacked controls never collide with it.
   *
   * The bands are the world bar, plus the console once it spans the width. On a
   * desktop the console is a corner instrument on the opposite side, and
   * docking a left-hand card above its top edge would float it hundreds of px
   * over nothing; on a phone the console is a full-width strip and IS the band.
   * Same width test the label pass uses, so the two agree about what counts.
   *
   * "Top chrome" is the close button — the only thing above the chart now that
   * the Overview control has moved into the console. What gives under the cap
   * is the facts section; if the room left for it will not hold three rows, it
   * comes off entirely and the actions keep the space.
   */
  measureCard(): void {
    if (!this.card || !this.isCardOpen()) return;
    const rect = (id: string): DOMRect | null => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // A hidden control measures as a zero box wherever it sits — read it as
      // absent rather than as chrome at the top of the viewport.
      return r.height > 0 ? r : null;
    };
    const consoleRect = rect('map-console');
    const consoleTop = consoleRect && consoleRect.width >= window.innerWidth - 32
      ? consoleRect.top
      : Infinity;
    const bandsTop = Math.min(rect('planetarium-bottom-bar')?.top ?? Infinity, consoleTop);
    const bottom = Math.round(Number.isFinite(bandsTop) ? window.innerHeight - bandsTop + 12 : 96);
    this.card.style.bottom = `${bottom}px`;

    const chromeBottom = rect('map-close')?.bottom ?? 0;
    // The card's own bottom edge sits at (innerHeight − bottom); the top chrome
    // ends at chromeBottom, and 12 px of air between them is the same gap the
    // dock leaves at the other end.
    const available = Math.max(0, window.innerHeight - bottom - chromeBottom - 12);

    // Measure the card at its natural height first: the facts' share is
    // whatever the cap leaves after the chrome that cannot shrink.
    const facts = this.cardFacts;
    const eventRow = this.cardEvent;
    this.card.style.maxHeight = '';
    if (facts) facts.style.display = '';
    if (eventRow) eventRow.style.display = this.eventRow ? 'flex' : 'none';
    const roomForFacts = (): number => {
      const naturalH = this.card!.getBoundingClientRect().height;
      const factsH = facts ? facts.getBoundingClientRect().height : 0;
      return available - (naturalH - factsH);
    };
    let factsRoom = roomForFacts();
    // The event row is the one thing that comes off before the facts do: the
    // facts are what the card is for, and the row is news that will keep. It
    // only goes if losing it actually buys the facts a viewport worth having —
    // on a card too short for them either way, the news stays.
    if (eventRow && this.eventRow && factsRoom < MIN_FACTS_PX) {
      eventRow.style.display = 'none';
      const roomWithoutRow = roomForFacts();
      if (roomWithoutRow >= MIN_FACTS_PX) factsRoom = roomWithoutRow;
      else eventRow.style.display = 'flex';
    }
    if (facts && factsRoom < MIN_FACTS_PX) facts.style.display = 'none';
    this.card.style.maxHeight = `${Math.round(available)}px`;

    // The cap has just been applied, so the facts' two heights finally disagree
    // when the list is longer than the room left for it — and a clipped last row
    // is what the fade exists to explain. Read AFTER the write: the measurement
    // above deliberately cleared the cap, so asking there would answer "fits"
    // every time and the fade would never appear anywhere. A card that does not
    // scroll gets no fade.
    if (facts) {
      facts.classList.toggle('scrolls', facts.scrollHeight > facts.clientHeight + 1);
    }
  }

  private setActive(seg: HTMLButtonElement | null, active: boolean): void {
    if (!seg) return;
    seg.classList.toggle('on', active);
    seg.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}
