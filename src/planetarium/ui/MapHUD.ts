import type { MapCardAction, MapVerb } from '../map/mapLogic';
import type { FactRow } from '../map/mapFacts';
import type { MapEventRowModel } from '../map/mapEvents';
import { filterDeckRows } from '../deckLogic';
import type { MapFocusRow } from '../map/mapFocusRows';
import type { MapLayerState } from '../map/SystemMap';
import { makeTiltGlyph } from './mapTiltGlyph';

/**
 * MapHUD — the on-screen controls for the System map: the bottom-right dock
 * (the standalone `?` chip, the panel, and the gesture-guide card beside
 * them), the close chip, and the picked-body card (tint dot, name, live
 * distance, one-line description, action buttons, the system's next event,
 * facts).
 *
 * The panel and its collapsed state are ONE element: open ↔ closed is a
 * grid-rows fold down to a 46px glyph chip, so nothing here swaps trees —
 * the `collapsed` class is the whole state, and the fold's transitionend
 * re-measures the geometry the animation moved.
 *
 * DOM-thin: the markup lives in index.html, this caches the elements and wires
 * their listeners once (the bind()/wired idiom). It owns no map state — it
 * reports intent through the callbacks and reflects state through its setters.
 * Collapsed-vs-open and help-open are the owner's session state; this paints
 * them. The one UI state it holds itself is which planet's moon tray stands
 * open — a disclosure, like the search highlight, not a mode. The facts arrive
 * as data, already resolved and formatted; this decides nothing about them but
 * how they are painted and how much room they get.
 *
 * The Focus picker's front page is the planet GRID (Sun + planets, a moon
 * tray folding open beneath the disclosed planet); a query swaps it for the
 * deck's flat filtered rows (`pk-row`, `pk-dot`, `pk-info`, `pk-tag-here`
 * with `mfm-*` overrides — the Look-at menu's idiom). Both are built from the
 * same MapFocusRow[]. The deck's own row DOM and sticky machinery are not
 * extractable; its pure search filter is, and that is what the query runs
 * through, so a search here behaves exactly as a search there does.
 */

/** The top chrome the panel may not grow into. It is the ceiling rather than
 *  the viewport: the action cluster sits ABOVE the map layer and stays
 *  clickable over it, so a panel grown into that corner would put its own
 *  search box behind a live button. */
function panelCeilingPx(): number {
  let ceiling = 0;
  for (const id of ['map-close', 'planetarium-actions']) {
    const chrome = document.getElementById(id)?.getBoundingClientRect();
    if (chrome && chrome.height > 0) ceiling = Math.max(ceiling, chrome.bottom);
  }
  return ceiling;
}

/** The dock's layout intent: the phone sheet below the breakpoint, the corner
 *  instrument above it. Asked of the stylesheet's own media condition rather
 *  than of a rect — a rect read mid-fold answers with the animation's
 *  progress, not the layout. */
function phoneLayout(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}

/** While the phone sheet is open the help chip floats above its top-right
 *  corner: 46px of chip and the 8px gap the dock keeps. The panel's measured
 *  cap reserves this, or a full-height sheet would push the chip under the
 *  top chrome. */
const PHONE_HELP_CHIP_RESERVE_PX = 54;

/** The facts viewport is worth having at three rows or more. Below that the
 *  card would carry a hairline, a scrollbar and a sliver — so the section comes
 *  off instead, and the actions keep the room. Measured: three ~14 px rows,
 *  their two gaps, the hairline and its pad. */
const MIN_FACTS_PX = 66;

/** What the caption under the scale segment says about the chart you are
 *  looking at. The always-visible teaching line, which is why the gesture
 *  guide carries no Scale row. */
const SCALE_NOTE_COMPRESSED = 'Distances compressed so every body stays visible.';
const SCALE_NOTE_TRUE = 'Real distances for the clock’s date.';

/** The layer switches, in the order the panel lists them: what the chart has
 *  always drawn first, then the two you can add. */
const LAYER_ROWS: readonly { key: keyof MapLayerState; id: string }[] = [
  { key: 'orbitLines', id: 'map-layer-orbits' },
  { key: 'bodyLabels', id: 'map-layer-labels' },
  { key: 'ambientMoons', id: 'map-layer-moons' },
  { key: 'constellations', id: 'map-layer-constellations' },
  { key: 'distanceRings', id: 'map-layer-rings' },
];

export class MapHUD {
  private root: HTMLElement | null = null;
  private dock: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private foldEl: HTMLElement | null = null;
  private helpChip: HTMLButtonElement | null = null;
  private helpCard: HTMLElement | null = null;
  private collapseBtn: HTMLButtonElement | null = null;
  private segCompressed: HTMLButtonElement | null = null;
  private segTrue: HTMLButtonElement | null = null;
  private scaleNote: HTMLElement | null = null;
  private zoomReadout: HTMLElement | null = null;
  private lastZoomReadout = '';
  private overviewBtn: HTMLButtonElement | null = null;
  private overviewOn = true;
  private panelBody: HTMLElement | null = null;
  private layerRows: { key: keyof MapLayerState; row: HTMLElement | null; tgl: HTMLButtonElement | null }[] = [];
  private ringsRowDim: boolean | null = null;

  private searchEl: HTMLInputElement | null = null;
  private pickerEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private traywEl: HTMLElement | null = null;
  private trayHeadEl: HTMLElement | null = null;
  private trayChipsEl: HTMLElement | null = null;
  private followRowEl: HTMLElement | null = null;
  private followDotEl: HTMLElement | null = null;
  private followNameEl: HTMLElement | null = null;
  private followReleaseBtn: HTMLButtonElement | null = null;
  /** Every row built for this map session, and the buttons painting them —
   *  index for index, so the filter's answer maps straight onto the DOM. */
  private rows: MapFocusRow[] = [];
  /** The row WRAPPERS, index for index with `rows` — the filter shows and hides
   *  these, and the highlight class lives on them. The commit button inside is
   *  a separate element (see buildRow). */
  private rowEls: HTMLElement[] = [];
  private highlight = -1;
  /** The grid's cells by body name, for the here/followed rings and the tray
   *  disclosure paint. Rebuilt with the rows. */
  private cells = new Map<string, { cell: HTMLElement; moonsBtn: HTMLButtonElement | null }>();
  /** The rows' moons grouped under their planets, in catalog order — what a
   *  tray opens onto. */
  private moonsByPlanet = new Map<string, MapFocusRow[]>();
  /** Which planet's moon tray stands open, or null. The picker's one piece of
   *  HUD-local UI state — a disclosure, reset with the rows. */
  private openTray: string | null = null;
  /** The landed body's name, for the ember ring and the tray chips' `here`
   *  tint. From the same rows everything else reads. */
  private hereName: string | null = null;
  /** The body the camera is riding. Cached so a tray built later still paints
   *  its chips followed, and so repaints are change-only. */
  private followingName: string | null = null;
  /** Whether the next help-open should move focus into the card: set when the
   *  chip was activated by keyboard (detail 0), consumed by setHelpOpen. */
  private focusHelpOnOpen = false;

  /** The panel's own rows, assigned by the owner (the bottom bar's idiom).
   *  The constructor's callbacks are the card's and the segment's — these
   *  arrived with the panel and are kept apart from them. */
  /** The `?` chip: toggle the gesture guide. */
  onHelp: () => void = () => {};
  /** The card's own ×: close it. A separate intent from the toggle — a close
   *  control on a card still fading out must never reopen it. */
  onHelpClose: () => void = () => {};
  /** The chevron: fold the panel away. The owner banks the preference. */
  onCollapse: () => void = () => {};
  /** The folded chip (any tap on it, or the chevron a keyboard kept): bring
   *  the panel back. */
  onExpand: () => void = () => {};
  /** A find-a-body row was chosen. */
  onPickRow: (name: string) => void = () => {};
  /** The `following` chip on the followed row: give the focus back. */
  onReleaseFocus: () => void = () => {};
  /** A layer switch was pressed. The owner holds the state and paints it back. */
  onLayer: (key: keyof MapLayerState, on: boolean) => void = () => {};
  /**
   * The dock's own geometry moved — the panel folded or landed its fold, the
   * moon tray opened, the picker swapped between grid and results, the guide
   * joined or left, the caption swapped to a line of a different length. The
   * panel is bottom-anchored, so ALL of those move its top edge, and the
   * label placer caches the dock's rects. One door, so no new section has to
   * remember to tell it.
   */
  onPanelGeometry: () => void = () => {};

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
  /**
   * The card control a pointer actually went down on, or null.
   *
   * A tap on a body opens the card UNDER THE FINGER, and the browser then
   * synthesizes a compatibility click at the same point — which lands on
   * whichever control has just materialized there and fires it. Measured on a
   * 320 px phone, a single tap on Jupiter committed the card's Teleport: one
   * touch, and the ship was gone.
   *
   * The teleport chip's own asymmetry is the fix: a deliberate press always
   * begins with its own pointerdown ON the control, and the synthesized click
   * after an opening tap has none. So a pointer click is honoured only when
   * this names the control it landed on. No timers — a suppression window is a
   * guess about how fast a person is.
   */
  private cardArmedEl: HTMLElement | null = null;
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
    this.dock = document.getElementById('map-dock');
    this.panel = document.getElementById('map-panel');
    this.foldEl = this.panel?.querySelector('.map-fold') ?? null;
    this.helpChip = document.getElementById('map-help-chip') as HTMLButtonElement | null;
    this.helpCard = document.getElementById('map-help-card');
    this.collapseBtn = document.getElementById('map-panel-collapse') as HTMLButtonElement | null;
    this.panelBody = document.getElementById('map-panel-body');
    this.segCompressed = document.getElementById('map-scale-compressed') as HTMLButtonElement | null;
    this.segTrue = document.getElementById('map-scale-true') as HTMLButtonElement | null;
    this.scaleNote = document.getElementById('map-scale-note');
    this.zoomReadout = document.getElementById('map-zoom-readout');
    this.overviewBtn = document.getElementById('map-overview') as HTMLButtonElement | null;
    this.searchEl = document.getElementById('map-focus-search') as HTMLInputElement | null;
    this.pickerEl = document.getElementById('map-picker');
    this.listEl = document.getElementById('map-focus-list');
    this.emptyEl = document.getElementById('map-focus-empty');
    this.gridEl = document.getElementById('map-focus-grid');
    this.traywEl = document.getElementById('map-moon-tray');
    this.trayHeadEl = document.getElementById('map-moon-tray-head');
    this.trayChipsEl = document.getElementById('map-moon-tray-chips');
    this.followRowEl = document.getElementById('map-following-row');
    this.followDotEl = document.getElementById('map-following-dot');
    this.followNameEl = document.getElementById('map-following-name');
    this.followReleaseBtn = document.getElementById('map-following-release') as HTMLButtonElement | null;
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
    // The chip toggles the guide; a keyboard activation (detail 0) is
    // remembered so the open can hand the card the focus it came from.
    this.helpChip?.addEventListener('click', (e) => {
      this.focusHelpOnOpen = e.detail === 0;
      this.onHelp();
    });
    document.getElementById('map-help-close')?.addEventListener('click', () => this.onHelpClose());
    // One button, two meanings: it folds an open panel away, and — for the
    // keyboard that can still reach it inside the folded chip — brings the
    // panel back. A pointer never sees the second meaning (the folded chevron
    // is pointer-inert; the whole chip below answers the tap instead).
    this.collapseBtn?.addEventListener('click', () => {
      if (this.panel?.classList.contains('collapsed')) this.onExpand();
      else this.onCollapse();
    });
    // The folded panel is one 46px chip, and the whole chip is the way back
    // in — both layouts now, since both fold to the same chip.
    //
    // The state is snapshotted in the CAPTURE phase, before any control inside
    // the panel has run, and the bubble handler answers to that snapshot alone.
    // Reading the class on the way back up instead would be answering a
    // question the same press has already changed: the chevron's own handler
    // above folds the panel DURING the dispatch, so the bubble would arrive at
    // a panel wearing a fresh `collapsed` and unfold what the press just
    // folded. (The phone sheet's card exclusion once hit the same wall from
    // the other side — a tap that opened the card folded the sheet, and the
    // unfold destroyed the card within the one dispatch.)
    //
    // The chevron is excluded rather than silenced: it already toggles both
    // ways on its own, and stopping propagation there would rob main.ts's
    // document-level rule of the click it uses to blur a pointer-pressed
    // button — leaving the chevron focused, where the next Space re-fires it
    // instead of pausing the sim.
    let pressBeganCollapsed = false;
    this.panel?.addEventListener(
      'click',
      () => { pressBeganCollapsed = !!this.panel?.classList.contains('collapsed'); },
      true,
    );
    this.panel?.addEventListener('click', (e) => {
      if (!pressBeganCollapsed) return;
      if ((e.target as HTMLElement).closest('#map-panel-collapse')) return;
      this.onExpand();
    });
    // The fold animates geometry no resize announces: re-measure when the
    // panel's width morph, the body fold or the moon tray lands. Filtered to
    // the three elements whose landing moves the panel's box — the title's
    // max-width and the body's opacity ride the same transitions and say
    // nothing new.
    this.panel?.addEventListener('transitionend', (e) => {
      const rows = e.propertyName === 'grid-template-rows'
        && (e.target === this.foldEl || e.target === this.traywEl);
      const width = e.target === this.panel && e.propertyName === 'width';
      if (!rows && !width) return;
      this.measurePanel();
      this.measureCard();
    });
    this.followReleaseBtn?.addEventListener('click', () => this.onReleaseFocus());
    for (const { key, id } of LAYER_ROWS) {
      const row = document.getElementById(id);
      const tgl = row?.querySelector('.tgl') as HTMLButtonElement | null;
      this.layerRows.push({ key, row, tgl });
      tgl?.addEventListener('click', () => {
        this.onLayer(key, !tgl.classList.contains('on'));
      });
    }
    this.searchEl?.addEventListener('input', () => this.applyFilter());
    this.searchEl?.addEventListener('keydown', (e) => this.searchKeydown(e));
    // The fade marks MORE BELOW and nothing else: it lifts at the end of the
    // scroll, or it would slice the footnote's glyphs with nothing beneath.
    this.panelBody?.addEventListener('scroll', () => this.updatePanelFade());
    // Delegated so the rebuilt-per-pick buttons need no per-button listeners.
    // Focus and the commit verbs travel on different attributes, so a commit
    // handler can never be reached by a button that isn't one.
    // The whole event row is one target — it says one thing and does one thing.
    // Every one of them arms on its own pointerdown (see cardArmedEl).
    this.cardEvent?.addEventListener('pointerdown', () => {
      this.cardArmedEl = this.cardEvent;
    });
    this.cardEvent?.addEventListener('click', (e) => {
      if (!this.cardClickAllowed(e, this.cardEvent)) return;
      this.onEvent();
    });
    this.cardActions?.addEventListener('pointerdown', (e) => {
      this.cardArmedEl = (e.target as HTMLElement).closest('button[data-action]');
    });
    this.cardActions?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      if (!this.cardClickAllowed(e, btn)) return;
      if (btn.dataset.action === 'focus') this.onFocus();
      else if (btn.dataset.verb) this.onVerb(btn.dataset.verb as MapVerb);
    });
  }

  /** Whether a click on a card control is one the user actually made on it.
   *  A keyboard activation arrives with detail 0 and no pointer behind it, so
   *  it always passes — the card stays fully operable without a pointer. */
  private cardClickAllowed(e: MouseEvent, control: HTMLElement | null): boolean {
    if (e.detail === 0) return true;
    const armed = this.cardArmedEl === control;
    // One press, one activation: whether it fired or not, the arming is spent.
    this.cardArmedEl = null;
    return armed;
  }

  // ── The panel ──────────────────────────────────────────────────────────

  /**
   * Fold the panel away, or bring it back.
   *
   * The class is all this writes: the fold is the stylesheet's (grid rows +
   * width morph), and the same class folds the desktop instrument and the
   * phone sheet down to the same 46px chip, so the DOM never has to know
   * which layout it is in. The dock's `panel-open` mirror is for the phone's
   * floating help chip. The measure here catches the toggle's START; the
   * transitionend listener catches where the fold lands.
   */
  setPanelCollapsed(collapsed: boolean): void {
    this.panel?.classList.toggle('collapsed', collapsed);
    this.dock?.classList.toggle('panel-open', !collapsed);
    this.collapseBtn?.setAttribute(
      'aria-label',
      collapsed ? 'Open the panel' : 'Collapse the panel',
    );
    this.collapseBtn?.setAttribute('title', collapsed ? 'Open' : 'Collapse');
    // The disclosure pairing: this button's aria-controls names the body, so
    // it owes a state to go with it.
    this.collapseBtn?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this.measurePanel();
    this.measureCard();
  }

  /**
   * Show or hide the gesture guide, keeping the chip lit with it — the chip's
   * pressed state and the card are one thing, never two.
   *
   * Focus is managed only when the keyboard is the pointer: a chip activated
   * by key hands the card's × its focus (the card sits after the whole panel
   * in DOM order — a keyboard user should not have to walk there), and any
   * close that would strand focus inside the hidden card gives it back to the
   * chip. A pointer press keeps its own rules — main.ts's document-level
   * blur owns that.
   */
  setHelpOpen(open: boolean): void {
    const wasOpen = !!this.dock?.classList.contains('help-open');
    this.dock?.classList.toggle('help-open', open);
    // The `visible` class is the label pass's cue that this sheet is standing
    // chrome (the picked card's idiom) — the labels dodge an open guide.
    this.helpCard?.classList.toggle('visible', open);
    this.helpChip?.classList.toggle('on', open);
    this.helpChip?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && this.helpCard?.contains(document.activeElement)) {
      this.helpChip?.focus();
    }
    this.helpCard?.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open && !wasOpen && this.focusHelpOnOpen) {
      (document.getElementById('map-help-close') as HTMLButtonElement | null)?.focus();
    }
    this.focusHelpOnOpen = false;
    // The card stands beside the panel, not in it — no height changed, but
    // the label placer caches the dock's chrome and the guide just joined or
    // left it.
    this.onPanelGeometry();
  }

  /**
   * Cap the panel at the room actually left between where it docks and the top
   * chrome, hand whatever is left over to the find list, and say whether the
   * body has more below it.
   *
   * Measured rather than written into the stylesheet: the panel's height is
   * whatever its sections come to, and both ends move — the chart's chrome
   * changes with the viewport, and the panel changes shape at the phone
   * breakpoint.
   *
   * The dock is bottom-anchored, so its own bottom edge is the same number
   * whatever the cap does to its height — which is why this can be read
   * without clearing the cap first.
   */
  measurePanel(): void {
    const panel = this.panel;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    if (rect.height > 0) {
      // 12 px of air below the top chrome, the same margin the chart's other
      // corners keep. The open phone sheet also reserves the help chip's
      // floating row above its own top edge.
      const chipReserve = phoneLayout() && !panel.classList.contains('collapsed')
        ? PHONE_HELP_CHIP_RESERVE_PX
        : 0;
      const cap = Math.max(0, Math.round(rect.bottom - panelCeilingPx() - 12 - chipReserve));
      panel.style.maxHeight = `${cap}px`;
      this.updatePanelFade();
    }
    // Told UNCONDITIONALLY, including for a panel that has just measured as
    // nothing: a shape that went to zero is a geometry change like any other —
    // the band it occupied is free now, and a cache still holding its old rect
    // would go on steering labels around a panel that is not there.
    this.onPanelGeometry();
  }

  /**
   * Mark which way the panel body has more — the card's fact-list idiom, at
   * both ends.
   *
   * Each edge shows only while there is somewhere left to scroll THAT way: a
   * bottom mask that stayed at the end of the scroll would cut the footnote in
   * half, and a top one at the start would dim the scale segment for nothing.
   *
   * The top edge earns its own mask because the sections do not end where the
   * body does. The find list is a fixed porthole with its own scrollbar, so a
   * body scrolled past it slices that window against the header's hairline —
   * with its search box and heading already gone above, a hard edge there reads
   * as a list that has been cut off rather than one that has been scrolled.
   */
  private updatePanelFade(): void {
    const body = this.panelBody;
    if (!body) return;
    const overflows = body.scrollHeight > body.clientHeight + 1;
    const more = overflows && body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    const above = overflows && body.scrollTop > 1;
    body.classList.toggle('scrolls', more);
    body.classList.toggle('scrolls-up', above);
  }

  /** Stand the dock down while another instrument takes its corner (Stats and
   *  Time both open into it), and put it back when they close. The whole
   *  cluster goes — help chip, panel and guide — because the corner is what
   *  is being given up, not the panel. */
  setPanelStoodDown(down: boolean): void {
    this.dock?.classList.toggle('stood-down', down);
    // Standing down empties the corner, which is a geometry change like any
    // other. A full remeasure rather than the bare notification: a resize can
    // cross the phone breakpoint while the panel is stood down (its zero
    // height skips the cap pass), so the return trip must reapply the cap —
    // measurePanel() notifies the geometry door unconditionally either way.
    this.measurePanel();
  }

  /** Paint the layer switches. The owner holds the state; this only reflects
   *  it, so a refused or clamped write can never leave a switch lying. */
  setLayers(layers: MapLayerState): void {
    for (const { key, tgl } of this.layerRows) {
      if (!tgl) continue;
      const on = layers[key];
      tgl.classList.toggle('on', on);
      tgl.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /** Dim the distance-rings row while the chart is not at true scale — the
   *  rings measure real distance, and there is none to measure on a compressed
   *  chart. Keyed on the COMMITTED scale, so the row wakes on the press rather
   *  than when the animation lands. */
  setRingsRowDim(dim: boolean): void {
    if (dim === this.ringsRowDim) return;
    this.ringsRowDim = dim;
    const entry = this.layerRows.find((r) => r.key === 'distanceRings');
    entry?.row?.classList.toggle('dim', dim);
    // The dim class stops a mouse and nothing else. A switch left in the tab
    // order is still a switch: Enter on it would turn on a layer the row says
    // is unavailable, and nothing would draw. Native `disabled` takes it out of
    // the tab order and refuses the key, so the keyboard sees what the eye does.
    if (entry?.tgl) {
      entry.tgl.disabled = dim;
      entry.tgl.setAttribute('aria-disabled', dim ? 'true' : 'false');
    }
  }

  /** Grey the Reset view row when neither of its journeys home is on offer.
   *  The map itself has no HUD reference, so the per-frame refresh owns this;
   *  it writes on change. */
  setOverviewEnabled(enabled: boolean): void {
    if (enabled === this.overviewOn) return;
    this.overviewOn = enabled;
    if (this.overviewBtn) this.overviewBtn.disabled = !enabled;
  }

  /** How far in the camera has come, as the panel prints it. The caller
   *  quantizes; this writes only on a change. */
  setZoomReadout(text: string): void {
    if (text === this.lastZoomReadout) return;
    this.lastZoomReadout = text;
    if (this.zoomReadout) this.zoomReadout.textContent = text;
  }

  /** Reflect which scale is active on the segmented control, and say what that
   *  scale means underneath it. */
  render(trueScale: boolean): void {
    this.setActive(this.segCompressed, !trueScale);
    this.setActive(this.segTrue, trueScale);
    const note = trueScale ? SCALE_NOTE_TRUE : SCALE_NOTE_COMPRESSED;
    if (this.scaleNote && this.scaleNote.textContent !== note) {
      this.scaleNote.textContent = note;
      // The two captions wrap to different numbers of lines, and the panel is
      // bottom-anchored: swapping them moves its top edge.
      this.measurePanel();
    }
  }

  // ── The Focus picker ───────────────────────────────────────────────────

  /** Catalog tint as CSS — the rows carry 0xRRGGBB. */
  private static rowColorCss(row: MapFocusRow): string {
    return `#${row.color.toString(16).padStart(6, '0')}`;
  }

  /** Rebuild the picker — the planet grid, the tray roster behind it, and the
   *  flat search rows — from one set of rows. The query starts empty and the
   *  tray closed: the picker is opened to go somewhere, and the last trip's
   *  search says nothing about this one. */
  setFocusRows(rows: MapFocusRow[]): void {
    if (!this.listEl) return;
    this.rows = rows;
    this.rowEls = [];
    this.highlight = -1;
    this.followingName = null;
    this.hereName = rows.find((row) => row.here)?.name ?? null;
    this.listEl.textContent = '';
    for (const row of rows) this.listEl.appendChild(this.buildRow(row));
    // The empty line lives INSIDE the fixed-height results box (it must not
    // add height below it), so the clear above took it out — put it back.
    if (this.emptyEl) this.listEl.appendChild(this.emptyEl);
    this.buildGrid(rows);
    this.setTray(null);
    this.paintFollowing();
    if (this.searchEl) this.searchEl.value = '';
    this.applyFilter();
    this.listEl.scrollTop = 0;
    this.measurePanel();
  }

  /** The grid: one cell per parentless row, in roster order — the fly-to
   *  button, and the moon-count disclosure when the planet has moons. */
  private buildGrid(rows: MapFocusRow[]): void {
    const grid = this.gridEl;
    if (!grid) return;
    this.cells.clear();
    this.moonsByPlanet.clear();
    grid.textContent = '';
    for (const row of rows) {
      if (!row.parent) continue;
      const group = this.moonsByPlanet.get(row.parent);
      if (group) group.push(row);
      else this.moonsByPlanet.set(row.parent, [row]);
    }
    for (const row of rows) {
      if (row.parent) continue;
      const moons = this.moonsByPlanet.get(row.name) ?? [];
      const cell = document.createElement('div');
      cell.className = 'map-cell';
      if (row.here) cell.classList.add('here');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'map-cell-go';
      const dot = document.createElement('span');
      dot.className = 'pk-dot';
      dot.style.background = MapHUD.rowColorCss(row);
      const name = document.createElement('b');
      name.textContent = row.name;
      go.append(dot, name);
      // The tooltip carries the row's one line of meta — the orbit the list
      // used to print beside the name. "star" would just repeat the Sun.
      go.title = `Focus ${row.name}`
        + (row.meta && row.meta !== 'star' ? ` · ${row.meta}` : '');
      go.addEventListener('click', () => this.onPickRow(row.name));
      cell.appendChild(go);
      let moonsBtn: HTMLButtonElement | null = null;
      if (moons.length > 0) {
        moonsBtn = document.createElement('button');
        moonsBtn.type = 'button';
        moonsBtn.className = 'map-cell-moons';
        moonsBtn.innerHTML = `${moons.length}<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 8 L10 12.5 L14.5 8"></path></svg>`;
        const gloss = `${moons.length} moon${moons.length > 1 ? 's' : ''}`;
        moonsBtn.title = `${row.name} — ${gloss}`;
        moonsBtn.setAttribute('aria-label', `Show the ${gloss} of ${row.name}`);
        moonsBtn.setAttribute('aria-expanded', 'false');
        moonsBtn.setAttribute('aria-controls', 'map-moon-tray');
        moonsBtn.addEventListener('click', () => {
          this.setTray(this.openTray === row.name ? null : row.name);
        });
        cell.appendChild(moonsBtn);
      }
      grid.appendChild(cell);
      this.cells.set(row.name, { cell, moonsBtn });
    }
  }

  /**
   * Fold the moon tray open under the grid (or away). The chips are rebuilt
   * for the disclosed planet — from the cached here/following names too, so a
   * tray opened later still wears the rings the state earned earlier.
   */
  private setTray(name: string | null): void {
    this.openTray = name;
    if (name && this.trayHeadEl && this.trayChipsEl) {
      const moons = this.moonsByPlanet.get(name) ?? [];
      this.trayHeadEl.textContent = `${name} · ${moons.length} moon${moons.length > 1 ? 's' : ''}`;
      this.trayChipsEl.textContent = '';
      for (const moon of moons) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'map-tray-chip';
        chip.dataset.name = moon.name;
        if (moon.name === this.followingName) chip.classList.add('followed');
        if (moon.name === this.hereName) chip.classList.add('here');
        const dot = document.createElement('span');
        dot.className = 'pk-dot';
        dot.style.background = MapHUD.rowColorCss(moon);
        chip.append(dot, moon.name);
        chip.title = `Focus ${moon.name}`;
        chip.addEventListener('click', () => this.onPickRow(moon.name));
        this.trayChipsEl.appendChild(chip);
      }
    }
    this.traywEl?.classList.toggle('open', name !== null);
    for (const [cellName, { cell, moonsBtn }] of this.cells) {
      cell.classList.toggle('open', cellName === name);
      moonsBtn?.setAttribute('aria-expanded', cellName === name ? 'true' : 'false');
    }
    // The tray folds the panel taller or shorter; the transitionend listener
    // catches where it lands, this catches the start.
    this.measurePanel();
  }

  /**
   * Mark the body the camera is riding — the following row under the grid
   * with its release chip, the accent ring on the cell, the lit tray chip,
   * and the flat row's tint for a search in progress.
   *
   * `name` is null whenever there is nothing to release — including while a
   * release is already flying, which is why the caller passes the releasable
   * predicate's answer rather than the focus name. A row that stood through
   * the flight would offer a release that has already happened.
   */
  setFollowing(name: string | null): void {
    if (name === this.followingName) return;
    this.followingName = name;
    this.paintFollowing();
  }

  private paintFollowing(): void {
    const name = this.followingName;
    if (this.followRowEl) {
      this.followRowEl.hidden = name === null;
      if (name !== null) {
        const row = this.rows.find((r) => r.name === name);
        if (this.followDotEl && row) this.followDotEl.style.background = MapHUD.rowColorCss(row);
        if (this.followNameEl) this.followNameEl.textContent = `Following ${name}`;
        // Named for what it does to the body it sits beside — "following"
        // alone is a state, and a control has to say its action.
        this.followReleaseBtn?.setAttribute('aria-label', `Stop following ${name}`);
        if (this.followReleaseBtn) this.followReleaseBtn.title = `Stop following ${name}`;
      }
    }
    for (const [cellName, { cell }] of this.cells) {
      cell.classList.toggle('followed', cellName === name);
    }
    const chips = this.trayChipsEl?.children;
    if (chips) {
      for (const chip of chips) {
        chip.classList.toggle('followed', (chip as HTMLElement).dataset.name === name);
      }
    }
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].classList.toggle('mfm-followed', this.rows[i].name === name);
    }
    // The row appearing or leaving moves the bottom-anchored panel's top edge.
    this.measurePanel();
  }

  /**
   * The search owns the keyboard while it holds focus.
   *
   * Every key stops here: the window's own cascade bails on INPUT targets, but
   * a bail is not the same promise as never being reached, and "Mars" has to
   * be typeable with M bound to the map. Repeats are dropped for the same
   * reason the window ladder drops them — a held Esc must not clear the query
   * and blur the field in one press.
   */
  private searchKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.repeat) return;
    // The arrows and Enter drive the RESULTS, and the results stand only
    // while a query does — with the grid up they would walk an invisible
    // list. (Tab walks the grid itself; that is the browser's.)
    const searching = !!this.searchEl?.value.trim();
    if (e.key === 'ArrowDown') { e.preventDefault(); if (searching) this.moveHighlight(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (searching) this.moveHighlight(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (searching) this.commitHighlight(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      // A query is what Esc gives back first; an empty field has nothing left
      // to undo, so the key hands the chart's own cascade back its keyboard.
      if (this.searchEl?.value) {
        this.searchEl.value = '';
        this.applyFilter();
      } else {
        this.searchEl?.blur();
      }
    }
  }

  /** Step the highlight over the rows the filter left visible. */
  private moveHighlight(delta: number): void {
    const visible = this.visibleIndices();
    if (visible.length === 0) return;
    const at = visible.indexOf(this.highlight);
    const next = at < 0
      ? (delta > 0 ? visible[0] : visible[visible.length - 1])
      : visible[(at + delta + visible.length) % visible.length];
    this.setHighlight(next);
    this.rowEls[next]?.scrollIntoView({ block: 'nearest' });
  }

  /** Enter: commit the highlighted row, or the only one a search has left. */
  private commitHighlight(): void {
    const visible = this.visibleIndices();
    const index = this.highlight >= 0 && visible.includes(this.highlight)
      ? this.highlight
      : (visible.length === 1 ? visible[0] : -1);
    if (index < 0) return;
    this.commitRow(this.rows[index].name);
  }

  /** A search result was chosen: the query is spent — clear it, hand the
   *  picker back to the grid, and only then fly. */
  private commitRow(name: string): void {
    if (this.searchEl) this.searchEl.value = '';
    this.applyFilter();
    this.onPickRow(name);
  }

  private visibleIndices(): number[] {
    return this.rowEls
      .map((el, i) => (el.style.display === 'none' ? -1 : i))
      .filter((i) => i >= 0);
  }

  /**
   * One flat search row: a plain wrapper carrying the deck's row look, with
   * the commit button inside it. The wrapper is not itself interactive: a
   * button inside a button is invalid, unreachable by keyboard and ambiguous
   * to a screen reader — the same rule the grid cells follow.
   */
  private buildRow(row: MapFocusRow): HTMLElement {
    const wrap = document.createElement('div');
    // The deck's own two row shapes: a planet is a sticky header its moons
    // scroll beneath, a moon is indented under it.
    wrap.className = `pk-row mfm-row ${row.parent ? 'pk-moon' : 'pk-planet'}`;
    wrap.setAttribute('role', 'listitem');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'mfm-pick';
    const dot = document.createElement('span');
    dot.className = 'pk-dot';
    dot.style.background = MapHUD.rowColorCss(row);
    const info = document.createElement('span');
    info.className = 'pk-info';
    const name = document.createElement('b');
    // Raw catalog names, as the deck's rows carry them: the search matches what
    // the row says.
    name.textContent = row.name;
    info.appendChild(name);
    if (row.meta) {
      const meta = document.createElement('small');
      meta.textContent = row.meta;
      info.appendChild(meta);
    }
    pick.append(dot, info);
    if (row.here) {
      const pill = document.createElement('span');
      pill.className = 'pk-tag-here';
      // Where you are standing — the deck's word for the same thing.
      pill.textContent = 'here';
      wrap.classList.add('here', 'mfm-current');
      // Inside the commit button, so the whole row stays one target.
      pick.appendChild(pill);
    }
    pick.addEventListener('click', () => this.commitRow(row.name));
    wrap.appendChild(pick);
    this.rowEls.push(wrap);
    return wrap;
  }

  private applyFilter(): void {
    const query = this.searchEl?.value ?? '';
    const q = query.trim().toLowerCase();
    // The mode swap: a query stands the flat results in for the grid (the
    // results box is a fixed-height porthole, so the bottom-anchored panel's
    // top edge holds still while the query narrows). Geometry moves only when
    // the MODE changes, and the measure below owns that edge.
    const wasSearching = !!this.pickerEl?.classList.contains('searching');
    this.pickerEl?.classList.toggle('searching', !!q);
    const visible = filterDeckRows(query, this.rows);
    let any = false;
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].style.display = visible[i] ? '' : 'none';
      if (visible[i]) any = true;
    }
    this.emptyEl?.classList.toggle('visible', !any);
    if (q) {
      // Typing is already choosing: highlight the first row the query NAMES —
      // not a parent riding along on its moon's match — so the Enter that
      // follows commits what the search found, no arrow press first.
      let pick = -1;
      for (let i = 0; i < this.rows.length; i++) {
        if (visible[i] && this.rows[i].name.toLowerCase().includes(q)) { pick = i; break; }
      }
      if (pick < 0) pick = visible.findIndex((v) => v);
      this.setHighlight(pick);
      if (this.listEl) this.listEl.scrollTop = 0;
    } else if (this.highlight >= 0) {
      // No query, no results on screen — no highlight either.
      this.setHighlight(-1);
    }
    if (wasSearching !== !!q) this.measurePanel();
  }

  private setHighlight(index: number): void {
    if (this.highlight >= 0) this.rowEls[this.highlight]?.classList.remove('hl');
    this.highlight = index;
    if (index >= 0) this.rowEls[index]?.classList.add('hl');
  }

  // ── The layer ──────────────────────────────────────────────────────────

  show(): void {
    // Explicit value — the element's CSS default is display:none, so clearing
    // the inline style would hide it, not show it.
    if (this.root) this.root.style.display = 'block';
    this.setPanelStoodDown(false);
  }

  hide(): void {
    if (this.root) this.root.style.display = 'none';
    this.hideCard();
    this.setHoverMeta(null);
    this.setPanelStoodDown(false);
    // The keyboard must not be left inside a field the chart no longer shows.
    this.searchEl?.blur();
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
    // The card has just appeared under whatever opened it. Nothing on it has
    // been pressed yet, so nothing on it is armed.
    this.cardArmedEl = null;
    this.card.classList.add('visible');
    this.measureCard();
  }

  hideCard(): void {
    this.card?.classList.remove('visible');
    this.cardArmedEl = null;
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
   * The bands are the world bar, plus the dock on the phone layout. On a
   * desktop the dock is a corner instrument on the opposite side, and docking
   * a left-hand card above its top edge would float it hundreds of px over
   * nothing; on a phone the card spans the width, so the dock is its band —
   * the folded two-chip dock no less than the open sheet.
   *
   * "Top chrome" is the close button — the only thing above the chart now that
   * the Overview control has moved into the panel. What gives under the cap
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
    // The bands are the world bar, plus — on the phone layout — the whole
    // dock: the open sheet spans the row, and even the folded two-chip dock
    // owns its strip of the bottom (the card spans the width down there, so a
    // corner test would lay it across the chips). Layout intent rather than a
    // width test, because mid-fold the sheet's rect is neither shape.
    const dockTop = phoneLayout() ? rect('map-dock')?.top ?? Infinity : Infinity;
    const bandsTop = Math.min(rect('planetarium-bottom-bar')?.top ?? Infinity, dockTop);
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
