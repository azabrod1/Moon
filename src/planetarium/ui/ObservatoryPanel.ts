/**
 * Observatory panel for the Planetarium's landed mode — cool-glass instrument
 * styling (accent reserved for happening-now warmth). "From ⟨body⟩ ▾" vantage
 * header (click = change vantage) with swap chip, phase hero (SVG glyph +
 * angular-diameter data line; Quiet-sky card on moonless grounds), live
 * now-bar, the surface-view entry, Earth's prev/next jump rows with next-date
 * metas, and the per-system upcoming-events list with classification badges.
 * Pure DOM + ephemeris reads; clock changes, camera work, and the chunked
 * event search live in PlanetariumMode. 8 Hz renders touch text nodes only;
 * list rebuilds happen only in setEvents.
 */
import { computeOrbitalState, type EventType } from '../../astronomy/ephemeris';
import { formatDateCompact } from '../../astronomy/planetary';
import type { ShadowClassification, ShadowEvent } from '../../astronomy/shadows';
import {
  bodyDisplayName,
  formatDiscDeg,
  selectSurfaceTarget,
  surfaceEventPhrase,
  type SurfaceEventInfo,
  type SurfaceLandedInfo,
} from '../surfaceView';
import { setText } from '../../shared/dom';

/** What the phase hero shows for the current landed body. */
export type ObservatorySubjectInfo =
  | {
      kind: 'earth';
      subject: 'Moon' | 'Earth';
      angularDiameterDeg: number;
      distanceKm: number;
    }
  | {
      kind: 'moon-phase';
      parentName: string;
      moonName: string;
      illumination: number;
      waxing: boolean;
      angularDiameterDeg: number;
      distanceKm: number;
    }
  | { kind: 'events-only'; parentName: string }
  /** Moonless system (Mercury, Venus): the hero becomes the "Quiet sky" card. */
  | { kind: 'companionless'; planetName: string; tintCss: string };

/** Panel state computed by the owner per render (vantage, clock, metas). */
export interface ObservatoryRenderExtras {
  /** "From Earth" — the vantage line doubles as the change-vantage button. */
  vantageName: string;
  /** Companion body name for the swap chip, or null to hide it. */
  swapName: string | null;
  /** Now-bar tag: 'paused' | 'realtime' | a rate label. */
  nowTag: string;
  /** Word to show in place of the tag while an event is overhead, or null.
   *  Panel-only — the surface HUD's transport clock keeps the rate label. */
  nowVerb: string | null;
  /** Earth finder metas ('' hides one, '···' = still scanning); null = not the Earth system. */
  nextDates: { full: string; new: string; lunar: string; solar: string } | null;
  /** Name the finder rows' almanac ("from Earth") — only worth the width
   *  where the vantage isn't the one the row names. */
  finderAffix: string | null;
  /** Everything the sky window's state depends on that only the owner knows. */
  window: ObservatoryWindowContext;
}

/** Which of the window's pictograms is showing. 'stars' is the bare sky — a
 *  vantage with no phase subject has no disc to draw. */
export type ObservatoryWindowGlyph =
  | 'phase'
  | 'stars'
  | 'sun'
  | 'reddened'
  | 'shadow-dot'
  | 'orbit';

/** The window inputs the owner supplies (scene, clock and event side). */
export interface ObservatoryWindowContext {
  /** The surface view is up — the same slot is the way back out. */
  surfaceActive: boolean;
  /** Stepping through opens the target picker first (generic planets). */
  lookupOpensMenu: boolean;
  landed: SurfaceLandedInfo;
  /** The event overhead right now, or null. */
  live: { spec: SurfaceEventInfo; classification: ShadowClassification } | null;
  /** Stepping through re-lands the player first. */
  relocates: boolean;
}

export interface ObservatoryWindowInput extends ObservatoryWindowContext {
  /** False where the vantage has no phase subject (a generic planet). */
  hasPhase: boolean;
}

export interface ObservatoryWindowState {
  mode: 'idle' | 'live' | 'return';
  title: string;
  sub: string;
  glyph: ObservatoryWindowGlyph;
  showNow: boolean;
  relocates: boolean;
}

/** Earth's own almanac pair — the events its sky has proper names for. */
function isEarthAlmanacPair(spec: SurfaceEventInfo): boolean {
  return spec.parentPlanet === 'Earth' && spec.moonName === 'Moon';
}

function standingOn(landed: SurfaceLandedInfo, planetName: string): boolean {
  return landed.type === 'planet' && landed.name === planetName;
}

/**
 * What the sky window says and shows.
 *
 * Titles are observer-true: they name the sight from where the player
 * actually stands, so "The Moon is crossing the Sun" appears only where an
 * observer would see that. The sub-line carries the offer, and names a
 * destination only when stepping through moves you there.
 */
export function observatoryWindowState(input: ObservatoryWindowInput): ObservatoryWindowState {
  if (input.surfaceActive) {
    return {
      mode: 'return',
      title: 'Return to orbit',
      // The exit restores the landed orbit camera, not deep space.
      sub: 'Leave the surface · Esc',
      glyph: 'orbit',
      showNow: false,
      relocates: false,
    };
  }
  const live = input.live;
  if (!live) {
    const body = bodyDisplayName(input.landed.name);
    return {
      mode: 'idle',
      title: 'Look up',
      sub: input.lookupOpensMenu
        ? `Choose what to watch from ${body}`
        : `See the sky from ${body}`,
      glyph: input.hasPhase ? 'phase' : 'stars',
      showNow: false,
      relocates: false,
    };
  }
  return {
    mode: 'live',
    title: windowEventTitle(input.landed, live.spec, live.classification),
    sub: windowEventSub(input.landed, live.spec, live.classification, input.relocates),
    // Keyed off the sight the surface view will actually point at, so the
    // pictogram can't tell a different story from the title beside it.
    glyph: windowEventGlyph(selectSurfaceTarget(input.landed, live.spec).kind),
    showNow: true,
    relocates: input.relocates,
  };
}

function windowEventTitle(
  landed: SurfaceLandedInfo,
  spec: SurfaceEventInfo,
  classification: ShadowClassification,
): string {
  if (isEarthAlmanacPair(spec) && standingOn(landed, 'Earth')) {
    if (spec.kind === 'eclipse') return 'Lunar eclipse overhead';
    // The badge word the upcoming list already computes leads the solar
    // form; a transit never classifies penumbral, so that falls back plain.
    const badge =
      classification === 'total' || classification === 'partial' || classification === 'annular'
        ? classification[0].toUpperCase() + classification.slice(1)
        : 'Solar';
    return `${badge} eclipse overhead`;
  }
  return surfaceEventPhrase(landed, spec);
}

function windowEventSub(
  landed: SurfaceLandedInfo,
  spec: SurfaceEventInfo,
  classification: ShadowClassification,
  relocates: boolean,
): string {
  if (relocates) {
    const parent = bodyDisplayName(spec.parentPlanet);
    if (spec.kind === 'eclipse') {
      return classification === 'total'
        ? `stand on ${parent} to see it turn red`
        : `stand on ${parent} to watch the eclipse`;
    }
    return `stand on ${parent} to see the eclipse`;
  }
  // Standing on Earth while its own Moon darkens: the sub says what the
  // classification honestly delivers, since a penumbral eclipse looks like
  // nothing happened unless the panel says that IS the show.
  if (isEarthAlmanacPair(spec) && spec.kind === 'eclipse' && standingOn(landed, 'Earth')) {
    if (classification === 'total') return 'see the Moon turn red';
    if (classification === 'penumbral') return 'a subtle dimming — easy to miss';
    return 'the Moon is crossing Earth’s shadow';
  }
  return 'see it from the surface';
}

/**
 * Three pictograms, one per kind of sight: the Sun with a bite out of it,
 * a body sitting reddened inside a shadow, and a shadow crawling a disc.
 * The ring is a pictogram, not a promise of corona.
 */
function windowEventGlyph(sight: ReturnType<typeof selectSurfaceTarget>['kind']): ObservatoryWindowGlyph {
  switch (sight) {
    case 'sun':
    case 'sun-from-spot':
      return 'sun';
    case 'moon':
      return 'reddened';
    case 'parent':
      return 'shadow-dot';
  }
}

export interface ObservatoryWatchRowState {
  visible: boolean;
  title: string;
  meta: string;
}

/**
 * The watch row is the surface view's home for the better-vantage offer: on
 * the ground the window slot is the way back out, so the offer needs a row
 * of its own. In orbit view the window already carries it a few pixels away,
 * and ember is reserved for happening-now — two ember rows dilute that.
 */
export function observatoryWatchRowState(input: ObservatoryWindowInput): ObservatoryWatchRowState {
  const live = input.live;
  if (!live || !input.surfaceActive || !input.relocates) {
    return { visible: false, title: '', meta: '' };
  }
  return {
    visible: true,
    title: `Watch from ${bodyDisplayName(live.spec.parentPlanet)}`,
    meta: live.classification === 'none' ? 'eclipse in progress' : `${live.classification} eclipse`,
  };
}

/**
 * The word the now-bar's tag shows while an event is overhead. Earth's own
 * pair reads "eclipse" whichever way its shadow points — from that ground
 * both are eclipses; elsewhere a moon's shadow crossing the planet is the
 * transit the panel names it.
 */
export function liveEventVerb(spec: SurfaceEventInfo): string {
  if (spec.kind === 'eclipse') return 'eclipse';
  return isEarthAlmanacPair(spec) ? 'eclipse' : 'transit';
}

/** One row of the upcoming-events list. Each row closes over its engine
 * event, so a click jumps to exactly what the row showed — a key re-lookup
 * would silently no-op while a restarted search repopulates its map. */
export interface ObservatoryEventRow {
  event: ShadowEvent;
  label: string;
  classification: string;
  /** Observer-conditioned "what you'll see" one-liner ('' when unknown). */
  hint: string;
  /** 'mag 1.10' — Earth system only; generic systems keep the badge alone. */
  magnitudeText: string | null;
  /** Apparent ∅ of the body this event is watched on, from the current
   * vantage (the surface-target table decides which body that is). */
  discDeg: number;
  /** True when that body can never resolve from here, even at max zoom —
   * the row dims and its rail glyph becomes the hollow ring. */
  speck: boolean;
}

// The phase of Earth seen from the Moon is the complement of the Moon's phase.
const EARTH_PHASE_NAME: Record<string, string> = {
  'New Moon': 'Full Earth',
  'Waxing Crescent': 'Waning Gibbous',
  'First Quarter': 'Last Quarter',
  'Waxing Gibbous': 'Waning Crescent',
  'Full Moon': 'New Earth',
  'Waning Gibbous': 'Waxing Crescent',
  'Last Quarter': 'First Quarter',
  'Waning Crescent': 'Waxing Gibbous',
};

/** Where the bottom sheet is parked (≤640px): 'peek' tracks the floor of the
 * drag range (the summary through the now-bar), 'full' tracks the content
 * ceiling even as the chunked event search grows it, and a number is a
 * hand-picked height in px — clamped on apply, never re-grown. Free drag:
 * the sheet stays wherever the finger leaves it. */
export type SheetPark = 'peek' | 'full' | number;

// Sheet-drag release thresholds (px). Dismiss = finger travel past the peek
// floor. The snap epsilon maps near-edge releases onto the tracking states —
// a release 5px shy of an edge is intent for the edge, and a park 1px above
// the floor would scroll instead of whole-card-dragging, so make those
// heights unreachable by hand.
const SHEET_DISMISS_DRAG_PX = 80;
const SHEET_SNAP_EPSILON_PX = 8;

/**
 * Where a sheet drag settles on release. Pure — unit-tested. dyPx is finger
 * travel (down positive); the sheet parks wherever the finger leaves it
 * (free drag, no detent snap), except: past the dismiss threshold below the
 * peek floor it dismisses, and within the snap epsilon of either edge it
 * resolves to the tracking state so the park follows future floor/ceiling
 * changes. From the floor a dismiss needs a >80px pull;
 * from height the pull must travel the whole stack plus the
 * threshold — it can't skip straight off-screen. Degenerate panels (ceiling
 * ≈ floor) resolve every non-dismiss release to 'peek'. Tap-vs-drag
 * discrimination happens at the call site, not here.
 */
export function sheetReleaseTarget(
  startHeightPx: number,
  dyPx: number,
  fullHeightPx: number,
  peekHeightPx: number,
): 'dismiss' | SheetPark {
  const peek = Math.min(peekHeightPx, fullHeightPx);
  const target = startHeightPx - dyPx;
  if (target < peek - SHEET_DISMISS_DRAG_PX) return 'dismiss';
  // Clamp before the edge checks so a degenerate range (ceiling ≈ floor)
  // resolves to 'peek' — 'full' there would disarm the whole-card drag
  // surface. When the epsilons overlap, peek deliberately wins.
  const clamped = Math.max(peek, Math.min(fullHeightPx, target));
  if (clamped <= peek + SHEET_SNAP_EPSILON_PX) return 'peek';
  if (clamped >= fullHeightPx - SHEET_SNAP_EPSILON_PX) return 'full';
  return clamped;
}

/** Coarse phase bucket for bodies without a named-lunation convention. */
function genericPhaseName(illumination: number): string {
  if (illumination < 0.02) return 'New';
  if (illumination < 0.35) return 'Crescent';
  if (illumination < 0.65) return 'Half';
  if (illumination < 0.98) return 'Gibbous';
  return 'Full';
}

/**
 * "Jun 12 03:14" (or "Jun 12 2026 03:14" for far events) — compact enough for
 * a panel row to keep the magnitude and countdown un-truncated beside it.
 */
export function formatEventRowTime(utcMs: number, includeYear: boolean): string {
  const d = new Date(utcMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const datePart = includeYear
    ? formatDateCompact(utcMs)
    : formatDateCompact(utcMs).replace(/ \d{4}$/, '');
  return `${datePart} ${hh}:${mm}`;
}

/** "JUN 9 2026 · 14:32:05 UTC" — the mono now-bar/when-line format. */
export function formatObservatoryClock(utcMs: number): string {
  const d = new Date(utcMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${formatDateCompact(utcMs).toUpperCase()} · ${hh}:${mm}:${ss} UTC`;
}

/** "∅ 0.50° · 402,300 km" — the hero's mono data line. */
function formatDiscDataLine(angularDiameterDeg: number, distanceKm: number): string {
  const deg = angularDiameterDeg >= 1 ? angularDiameterDeg.toFixed(1) : angularDiameterDeg.toFixed(2);
  return `∅ ${deg}° · ${Math.round(distanceKm).toLocaleString('en-US')} km`;
}

/**
 * How far off an event is, in words: "in 2 days", never "in 2d". One unit
 * per rung — an hour and twenty minutes of extra precision is noise on a
 * row whose job is "soon or not". The rungs are chosen so the widest string
 * ("in 364 days") still clears the right column.
 */
export function formatCountdown(nowUtcMs: number, event: ShadowEvent): string {
  if (nowUtcMs > event.endUtcMs) return 'ended';
  if (nowUtcMs >= event.startUtcMs) return 'now';
  const totalMinutes = Math.floor((event.peakUtcMs - nowUtcMs) / 60_000);
  if (totalMinutes < 60) return `in ${Math.max(totalMinutes, 1)} min`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `in ${totalHours} ${totalHours === 1 ? 'hour' : 'hours'}`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 365) return `in ${totalDays} ${totalDays === 1 ? 'day' : 'days'}`;
  return `in ${((event.peakUtcMs - nowUtcMs) / (365.25 * 86_400_000)).toFixed(1)} years`;
}

/**
 * Phase headline/meta/glyph inputs for a subject — shared by the panel hero
 * and the surface HUD's no-event fallback. Null for events-only and
 * companionless subjects (the latter's hero is the static Quiet-sky card).
 */
export function observatoryPhaseText(
  utcMs: number,
  info: ObservatorySubjectInfo,
): { headline: string; meta: string; litFraction: number; lightOnRight: boolean } | null {
  if (info.kind === 'earth') {
    const state = computeOrbitalState(new Date(utcMs));
    const illumination = info.subject === 'Earth' ? 1 - state.illumination : state.illumination;
    const phaseName =
      info.subject === 'Earth'
        ? EARTH_PHASE_NAME[state.phaseName] ?? state.phaseName
        : state.phaseName;
    // Last Quarter is a waning phase too — name-matching 'Waning' alone would
    // mirror the glyph for that whole bucket.
    const waning = phaseName.includes('Waning') || phaseName === 'Last Quarter';
    return {
      headline: phaseName,
      meta: `${info.subject === 'Earth' ? 'Earth' : 'The Moon'} · ${Math.round(illumination * 100)}% lit`,
      litFraction: illumination,
      lightOnRight: !waning,
    };
  }
  if (info.kind === 'moon-phase') {
    return {
      headline: `${genericPhaseName(info.illumination)} ${info.parentName}`,
      meta: `${info.parentName} · ${Math.round(info.illumination * 100)}% lit`,
      litFraction: info.illumination,
      lightOnRight: info.waxing,
    };
  }
  return null;
}

/**
 * SVG path for the phase glyph's LIT region: the sunward semicircle closed by
 * the elliptical terminator (semi-minor axis ∝ |2f − 1|). Crescent (f < ½)
 * bows the terminator into the lit side; gibbous bows it back. Disc: r=19
 * centered at (20,20).
 *
 * The light is what gets painted, so the dark limb is simply absent and the
 * glass panel shows through it. The two alternatives both leave a mark: a
 * dark shape laid over a lit disc is an opaque blob against bright sky, and
 * masking the lit disc with the shadow multiplies the mask's own antialiased
 * edge into a hairline that traces the whole rim at 1× pixel density.
 */
export function phaseGlyphLitPath(litFraction: number, lightOnRight: boolean): string {
  const f = Math.min(1, Math.max(0, litFraction));
  const c = 2 * f - 1; // −1 new … +1 full
  const rt = (19 * Math.abs(c)).toFixed(2);
  // Lit limb = the semicircle toward the light; sweep flags follow.
  const litSweep = lightOnRight ? 1 : 0;
  const termSweep = (f < 0.5) === lightOnRight ? 0 : 1;
  return `M 20 1 A 19 19 0 0 ${litSweep} 20 39 A ${rt} 19 0 0 ${termSweep} 20 1 Z`;
}

export class ObservatoryPanel {
  private panelEl: HTMLElement | null = null;
  private earthRowsEl: HTMLElement | null = null;
  private heroEl: HTMLElement | null = null;
  private glyphLitEl: SVGPathElement | null = null;
  private nowBarEl: HTMLElement | null = null;
  private swapEl: HTMLElement | null = null;
  private finderAffixEls: HTMLElement[] = [];
  private windowEl: HTMLElement | null = null;
  private windowLitEl: SVGPathElement | null = null;
  private watchRowEl: HTMLElement | null = null;
  // The window's structural state, so an 8 Hz render that changes nothing
  // touches no DOM: re-writing it would restart the NOW tick's pulse eight
  // times a second and read as a frozen-bright dot.
  private windowKey = '';
  private eventsListEl: HTMLElement | null = null;
  private orbitRowEl: HTMLElement | null = null;
  private orbitToggleEl: HTMLInputElement | null = null;
  private orbitCapEl: HTMLElement | null = null;
  // ⓘ explainer notes under the footer toggles. Open state is per-open only:
  // they collapse with the panel so a read note doesn't eat sheet space forever.
  private guidesInfoEl: HTMLElement | null = null;
  private guidesExplainEl: HTMLElement | null = null;
  private orbitInfoEl: HTMLElement | null = null;
  private orbitExplainEl: HTMLElement | null = null;
  private keyInfoEl: HTMLElement | null = null;
  private keyExplainEl: HTMLElement | null = null;
  private orbitAvailable = false;
  private renderedRows: { row: ObservatoryEventRow; rowEl: HTMLElement; countdownEl: HTMLElement }[] = [];
  private wired = false;
  // Sheet-form park state (≤640px) — the user's INTENT. Entering sheet form —
  // open or a breakpoint crossing — always means peek; `wasSheetForm` detects
  // crossings. Mutated only by release/tap/show/collapse, never by layout.
  private sheetPark: SheetPark = 'peek';
  // BEHAVIOR derived from the applied height: a content shrink can pin a
  // hand-picked park to the floor — it must act like peek (overflow hidden,
  // whole-card drag surface) without destroying the picked height for when
  // the content returns.
  private sheetAtPeek = true;
  private wasSheetForm = false;
  // A live handle/panel drag owns the sheet's height — content rebuilds must
  // not re-assert the detent mid-gesture (the chunked event search publishes
  // rows for seconds right after open).
  private sheetDragging = false;
  // Escape/mission/surface-entry can hide() mid-drag; if the browser drops
  // the pointer capture with the panel display:none, no terminal pointer
  // event ever reaches it and sheetDragging would wedge true forever. Set by
  // wireSheetDrag (closure state lives there); called by hide().
  private abortSheetDrag: (() => void) | null = null;

  constructor(
    private onJump: (type: EventType, direction: 1 | -1) => void,
    private onEventJump: (event: ShadowEvent) => void,
    private onGuidesToggle: (on: boolean) => void,
    private onClose: () => void,
    private onLookup: () => void,
    /** The watch row: step onto the ground the event is worth watching from.
     *  Never onLookup — on the surface that first branch is the way OUT. */
    private onWatchLive: () => void,
    private onSwap: () => void,
    private onOrbitDetailsToggle: (on: boolean) => void,
    private onLayoutChange: () => void,
    /** "From ⟨body⟩ ▾" clicked — the owner opens the vantage picker. */
    private onVantageChangeRequest: () => void,
  ) {}

  bind(): void {
    this.panelEl = document.getElementById('observatory-panel');
    this.earthRowsEl = document.getElementById('observatory-earth-rows');
    this.heroEl = document.getElementById('observatory-hero');
    this.glyphLitEl = document.getElementById('observatory-glyph-lit') as SVGPathElement | null;
    this.nowBarEl = document.getElementById('observatory-nowbar');
    this.swapEl = document.getElementById('observatory-swap');
    this.finderAffixEls = [
      ...(this.earthRowsEl?.querySelectorAll<HTMLElement>('.obs-lbl-from') ?? []),
    ];
    this.windowEl = document.getElementById('observatory-lookup');
    this.windowLitEl = document.getElementById('observatory-window-lit') as SVGPathElement | null;
    this.watchRowEl = document.getElementById('observatory-watch');
    this.eventsListEl = document.getElementById('observatory-events-list');
    this.orbitRowEl = document.getElementById('observatory-orbit-row');
    this.orbitToggleEl = document.getElementById('observatory-orbit-toggle') as HTMLInputElement | null;
    this.orbitCapEl = document.getElementById('observatory-orbit-cap');
    this.guidesInfoEl = document.getElementById('observatory-guides-info');
    this.guidesExplainEl = document.getElementById('observatory-guides-explain');
    this.orbitInfoEl = document.getElementById('observatory-orbit-info');
    this.orbitExplainEl = document.getElementById('observatory-orbit-explain');
    this.keyInfoEl = document.getElementById('observatory-key-info');
    this.keyExplainEl = document.getElementById('observatory-key-explain');
    if (this.wired) return;
    this.wired = true;
    // Seed the crossing detector — the first updateSheetInset call must not
    // read the initial form as a breakpoint crossing.
    this.wasSheetForm = this.isSheetForm();
    document.getElementById('observatory-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose(); // owner drops its chunked search immediately, not next frame
    });
    this.wireSheetDrag();
    // Crossing the 640px breakpoint re-houses the panel (sheet ↔ side
    // panel) — the published inset must follow.
    window.addEventListener('resize', () => this.updateSheetInset());
    const guidesToggle = document.getElementById('observatory-guides-toggle') as HTMLInputElement | null;
    const guidesCaption = document.getElementById('observatory-guides-cap');
    guidesToggle?.addEventListener('change', () => {
      this.onGuidesToggle(guidesToggle.checked);
      // The honesty caption belongs to the drawn lines: show it only while
      // they're on. (Toggle state is session-only and starts unchecked, so
      // markup default display:none always agrees.)
      if (guidesCaption) guidesCaption.style.display = guidesToggle.checked ? '' : 'none';
    });
    const orbitToggle = this.orbitToggleEl;
    orbitToggle?.addEventListener('change', () => {
      this.onOrbitDetailsToggle(orbitToggle.checked);
      this.syncOrbitCapDisplay();
    });
    this.wireInfoNote(this.guidesInfoEl, this.guidesExplainEl);
    this.wireInfoNote(this.orbitInfoEl, this.orbitExplainEl);
    this.wireInfoNote(this.keyInfoEl, this.keyExplainEl);
    this.windowEl?.addEventListener('click', () => this.onLookup());
    this.watchRowEl?.addEventListener('click', () => this.onWatchLive());
    this.swapEl?.addEventListener('click', () => this.onSwap());
    document.getElementById('observatory-vantage-btn')?.addEventListener('click', () => this.onVantageChangeRequest());
    this.wireJump('observatory-prev-full', 'full-moon', -1);
    this.wireJump('observatory-next-full', 'full-moon', 1);
    this.wireJump('observatory-prev-new', 'new-moon', -1);
    this.wireJump('observatory-next-new', 'new-moon', 1);
    this.wireJump('observatory-prev-lunar', 'lunar-eclipse', -1);
    this.wireJump('observatory-next-lunar', 'lunar-eclipse', 1);
    this.wireJump('observatory-prev-solar', 'solar-eclipse', -1);
    this.wireJump('observatory-next-solar', 'solar-eclipse', 1);
  }

  /** ⓘ button toggles its explainer note open/closed. */
  private wireInfoNote(button: HTMLElement | null, explain: HTMLElement | null): void {
    if (!button || !explain) return;
    button.addEventListener('click', (event) => {
      // The button lives inside the toggle's <label>; eat the click so it
      // can't double as a checkbox flip.
      event.preventDefault();
      event.stopPropagation();
      const open = explain.style.display === 'none';
      explain.style.display = open ? '' : 'none';
      button.setAttribute('aria-expanded', String(open));
      // The note changes the panel's height — the sheet's full park and the
      // chevron clamp both measure it.
      this.updateSheetInset();
      this.onLayoutChange();
      // A hand-picked or max-height-capped sheet won't grow to fit the note —
      // it can open entirely below the scrollport.
      if (open) explain.scrollIntoView({ block: 'nearest' });
    });
  }

  private collapseInfoNote(button: HTMLElement | null, explain: HTMLElement | null): void {
    if (explain) explain.style.display = 'none';
    button?.setAttribute('aria-expanded', 'false');
  }

  private wireJump(buttonId: string, type: EventType, direction: 1 | -1): void {
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    if (!button) return;
    button.addEventListener('click', () => {
      // Eclipse searches can scan ~40 lunations; disable the button and defer
      // so the disabled state paints before the search blocks the main thread.
      button.disabled = true;
      window.setTimeout(() => {
        try {
          this.onJump(type, direction);
        } finally {
          button.disabled = false;
        }
      }, 10);
    });
  }

  isOpen(): boolean {
    return this.panelEl?.classList.contains('visible') ?? false;
  }

  /** ≤640px the panel renders as a bottom sheet (CSS media query). */
  private isSheetForm(): boolean {
    return window.innerWidth <= 640;
  }

  /**
   * The peek height — the floor of the drag range: the summary through the
   * sky window. Jumps park the sheet here, so the floor has to clear the
   * window and the watch row above it — the whole reason a jump is worth
   * anything is the step it offers next. The now-bar sits above the window,
   * so the older rationale still holds: the bottom time pill hides while the
   * sheet is open, and the floor keeps the only clock on screen. The anchor
   * chain is visibility-aware (offsetHeight, not inline style): surface view
   * hides the now-bar via a body class and events-only subjects hide the
   * hero inline — falling through keeps the sheet from collapsing to a
   * sliver when they are gone.
   */
  private peekHeightPx(): number {
    const panel = this.panelEl;
    if (!panel) return 0;
    const vantage = panel.querySelector('.obs-vantage') as HTMLElement | null;
    for (const anchor of [this.windowEl, this.nowBarEl, this.heroEl, vantage]) {
      if (anchor && anchor.offsetHeight > 0) {
        return Math.min(anchor.offsetTop + anchor.offsetHeight + 12, this.sheetFullHeightPx());
      }
    }
    return this.sheetFullHeightPx();
  }

  /**
   * The drag ceiling: content extent under the CSS max-height cap — read
   * from computed style rather than twinning the stylesheet's min(55vh, …)
   * formula. scrollHeight reads back a pinned inline height whenever the
   * content is SHORTER than it (a stale ceiling after rows shrink), so the
   * measurement runs with the inline height cleared and restores it —
   * synchronous, nothing paints in between.
   */
  private sheetFullHeightPx(): number {
    const panel = this.panelEl;
    if (!panel) return 0;
    const inline = panel.style.height;
    panel.style.height = '';
    const cap = parseFloat(getComputedStyle(panel).maxHeight);
    const full = Math.min(panel.scrollHeight, Number.isFinite(cap) ? cap : Infinity);
    panel.style.height = inline;
    return full;
  }

  /**
   * Single owner of sheet layout: applies the current park (≤640px) clamped
   * to the live floor/ceiling, then publishes the sheet's height as
   * --sheet-inset so bottom-anchored chrome (the surface transport strip,
   * the surface-HUD corners) rides its top edge instead of being buried —
   * the sheet never covers the surface transport strip. Behavior
   * (.sheet-peek, scrollTop) keys off the APPLIED height while sheetPark
   * keeps the intent, so a transient content shrink acts like peek and the
   * hand-picked height recovers when the content regrows. Desktop or closed,
   * it clears every sheet artifact — a stale inline height would truncate
   * the desktop side panel.
   */
  private updateSheetInset(): void {
    if (this.sheetDragging) return; // a live drag owns the height
    const panel = this.panelEl;
    const sheetForm = this.isSheetForm();
    // Crossing into sheet form always lands at peek (same rule as show()).
    if (sheetForm && !this.wasSheetForm) this.sheetPark = 'peek';
    this.wasSheetForm = sheetForm;
    if (panel && this.isOpen() && sheetForm) {
      const full = this.sheetFullHeightPx();
      const peek = this.peekHeightPx();
      const h =
        this.sheetPark === 'peek'
          ? peek
          : this.sheetPark === 'full'
            ? full
            : Math.max(peek, Math.min(full, this.sheetPark));
      this.sheetAtPeek = h <= peek + 1;
      panel.style.height = `${h}px`;
      panel.classList.toggle('sheet-peek', this.sheetAtPeek);
      if (this.sheetAtPeek) panel.scrollTop = 0;
      document.body.style.setProperty('--sheet-inset', `${panel.offsetHeight}px`);
    } else {
      if (panel) {
        panel.style.height = '';
        panel.style.transform = '';
        panel.classList.remove('sheet-peek');
      }
      this.sheetAtPeek = true;
      document.body.style.removeProperty('--sheet-inset');
    }
    this.onLayoutChange();
  }

  /**
   * Re-measure the sheet when a peek anchor's visibility flips via a body
   * class no content rebuild tracks (the now-bar across surface-view exit).
   */
  refreshSheetLayout(): void {
    this.updateSheetInset();
  }

  /**
   * Jumps park the sheet at peek instead of dismissing it: the framed event
   * stays visible AND the now-bar carries the new date. No-op on desktop or
   * when closed.
   */
  collapseSheetToPeek(): void {
    if (!this.isOpen() || !this.isSheetForm()) return;
    this.sheetPark = 'peek';
    this.updateSheetInset();
  }

  show(): void {
    this.panelEl?.classList.add('visible');
    document.body.classList.add('observatory-sheet-open');
    // Opening (or re-targeting — show() also fires on landed→landed switches)
    // always starts at peek: the sky stays visible, drag up for the rest.
    this.sheetPark = 'peek';
    this.updateSheetInset();
  }

  hide(): void {
    // A close mid-drag must terminate the gesture first, or the dragging
    // guard would make updateSheetInset skip its cleanup below.
    this.abortSheetDrag?.();
    this.collapseInfoNote(this.guidesInfoEl, this.guidesExplainEl);
    this.collapseInfoNote(this.orbitInfoEl, this.orbitExplainEl);
    this.collapseInfoNote(this.keyInfoEl, this.keyExplainEl);
    this.panelEl?.classList.remove('visible');
    document.body.classList.remove('observatory-sheet-open');
    this.updateSheetInset();
  }

  /**
   * Sheet-form free drag: the sheet parks wherever the finger leaves it
   * between the peek floor and the content ceiling — no detent snap. AT
   * PEEK nothing scrolls (overflow hidden), so the whole card is
   * the drag surface: a swipe up on it is the natural expand gesture. Above
   * the floor the body scrolls a list, so only the header (grab handle +
   * eyebrow row) arms the gesture. Buttons stay excluded (capturing would
   * retarget their pointerup and eat the click). Below the floor the card
   * translates down (dismiss preview); the release settles via pure
   * sheetReleaseTarget. A tap on the handle (|dy| < 6, pointerup only — a
   * cancelled gesture reverts) toggles peek ⇄ full: collapse-first from any
   * height, because the phone's most urgent need is the sky back. Known
   * trade: a fast flick under-travels (release parks where the finger
   * stopped — no velocity projection); the handle tap covers "give me
   * everything".
   */
  private wireSheetDrag(): void {
    const panel = this.panelEl;
    if (!panel) return;
    let startY: number | null = null;
    let activePointer: number | null = null;
    let fromHandle = false;
    let startHeight = 0;
    let fullHeight = 0;
    let peekHeight = 0;
    // Terminal cleanup for non-release endings (hide() mid-drag, capture
    // loss). Leaves height/class/inset to the caller's updateSheetInset.
    const abort = () => {
      if (activePointer === null) return;
      try {
        panel.releasePointerCapture(activePointer);
      } catch {
        // capture already gone
      }
      activePointer = null;
      startY = null;
      this.sheetDragging = false;
      panel.style.transform = '';
    };
    this.abortSheetDrag = abort;
    panel.addEventListener('pointerdown', (e) => {
      if (!this.isSheetForm()) return;
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;
      const viaHandle = target.closest('.obs-eyebrow') !== null;
      // Above the floor the body scrolls — only the handle drags there.
      if (!this.sheetAtPeek && !viaHandle) return;
      if (activePointer !== null) return; // one finger drives the sheet
      try {
        panel.setPointerCapture(e.pointerId);
      } catch {
        return; // pointer already gone — don't arm a gesture we can't end
      }
      activePointer = e.pointerId;
      startY = e.clientY;
      fromHandle = viaHandle;
      startHeight = panel.offsetHeight;
      fullHeight = this.sheetFullHeightPx();
      peekHeight = this.peekHeightPx();
      this.sheetDragging = true;
    });
    panel.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activePointer || startY === null) return;
      if (!this.isOpen()) {
        // Closed under the finger and capture survived — end it here.
        abort();
        this.updateSheetInset();
        return;
      }
      // One continuous law: the finger asks for a height; clamp it to the
      // drag range and render below-floor overshoot as a downward translate
      // (dismiss preview). The transport strip rides the visible height
      // (the sheet must not cover the transport strip mid-gesture either) —
      // clamped at 0: a long mouse pull
      // can report clientY past the viewport under pointer capture, and a
      // negative inset would push the bottom chrome off-screen.
      const target = startHeight - (e.clientY - startY);
      const floor = Math.min(peekHeight, fullHeight);
      const h = Math.max(floor, Math.min(fullHeight, target));
      const down = Math.max(0, floor - target);
      panel.style.height = `${h}px`;
      panel.style.transform = down > 0 ? `translateY(${down}px)` : '';
      document.body.style.setProperty('--sheet-inset', `${Math.max(0, h - down)}px`);
      // The live height moves the panel's top edge — owner caches (the
      // surface-HUD chevron clamp) must not read a stale rect mid-gesture.
      this.onLayoutChange();
    });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== activePointer || startY === null) return;
      const dy = e.clientY - startY;
      activePointer = null;
      startY = null;
      this.sheetDragging = false;
      panel.style.transform = '';
      // Closed under us (mission force-close), breakpoint crossed mid-drag,
      // or the gesture was cancelled: settle to a clean current state.
      if (!this.isOpen() || !this.isSheetForm() || cancelled) {
        this.updateSheetInset();
        return;
      }
      if (fromHandle && Math.abs(dy) < 6) {
        // Tap: expand from the floor, park back at the floor from anywhere
        // above; no-op when there's no real range to toggle across (the
        // degenerate park would silently disarm the whole-card drag surface).
        if (fullHeight - peekHeight > 1) {
          this.sheetPark = this.sheetAtPeek ? 'full' : 'peek';
        }
        this.updateSheetInset();
        return;
      }
      const park = sheetReleaseTarget(startHeight, dy, fullHeight, peekHeight);
      if (park === 'dismiss') {
        this.hide();
        this.onClose();
        return;
      }
      this.sheetPark = park;
      this.updateSheetInset();
    };
    panel.addEventListener('pointerup', (e) => release(e, false));
    panel.addEventListener('pointercancel', (e) => release(e, true));
    // Any capture loss the handlers above didn't see (browser took it away,
    // element hidden) still terminates the gesture. After a normal release
    // activePointer is already null — this no-ops.
    panel.addEventListener('lostpointercapture', (e) => {
      if (e.pointerId !== activePointer) return;
      abort();
      this.updateSheetInset();
    });
  }

  /** One ~600ms accent glow on the now-bar — called after any time jump. */
  flashNowBar(): void {
    if (!this.nowBarEl) return;
    this.nowBarEl.classList.remove('flash');
    // Force a reflow so re-adding the class restarts the animation.
    void this.nowBarEl.offsetWidth;
    this.nowBarEl.classList.add('flash');
  }

  /**
   * Show/hide the Orbit-details footer row (no orbit subject → no row). The
   * checkbox state is left alone — like Shadow guides it's session-sticky,
   * so landing back on a moon restores the user's choice.
   */
  setOrbitDetailsAvailable(available: boolean): void {
    this.orbitAvailable = available;
    if (this.orbitRowEl) this.orbitRowEl.style.display = available ? '' : 'none';
    // The row's explainer note must not outlive the row (it would read as an
    // orphaned paragraph between the remaining footer rows).
    if (!available) this.collapseInfoNote(this.orbitInfoEl, this.orbitExplainEl);
    this.syncOrbitCapDisplay();
  }

  isOrbitDetailsOn(): boolean {
    return this.orbitToggleEl?.checked ?? false;
  }

  private syncOrbitCapDisplay(): void {
    if (!this.orbitCapEl) return;
    this.orbitCapEl.style.display =
      this.orbitAvailable && this.orbitToggleEl?.checked ? '' : 'none';
    // Row/cap visibility changes the sheet's height — keep the inset current
    // (the sheet must not cover the surface-view transport strip).
    this.updateSheetInset();
  }

  /** Replace the readout lines + honesty captions (null clears). Called on
   *  subject/geometry change only, never on the 8 Hz text cadence. */
  setOrbitReadout(readout: { lines: string[]; captions: string[] } | null): void {
    if (!this.orbitCapEl) return;
    this.orbitCapEl.textContent = '';
    if (!readout) return;
    for (const line of readout.lines) {
      const el = document.createElement('div');
      el.className = 'obs-orbit-line';
      el.textContent = line;
      this.orbitCapEl.appendChild(el);
    }
    for (const caption of readout.captions) {
      const el = document.createElement('div');
      el.className = 'obs-orbit-note';
      el.textContent = caption;
      this.orbitCapEl.appendChild(el);
    }
    // Readout rebuilds change the sheet's height — keep the inset current.
    this.updateSheetInset();
  }

  /** Replace the upcoming-events list; an empty statusText hides the status line. */
  setEvents(rows: ObservatoryEventRow[], statusText: string): void {
    setText('observatory-events-status', statusText);
    if (!this.eventsListEl) return;
    this.eventsListEl.textContent = '';
    this.renderedRows = [];
    for (const row of rows) {
      // The whole row is the jump: a real button, so it answers to the
      // keyboard and the tap target is the row you were reading. Each row
      // closes over its own event — a key re-lookup would silently no-op
      // while a restarted search repopulates the map.
      const rowEl = document.createElement('button');
      rowEl.type = 'button';
      rowEl.className = row.speck ? 'obs-ev speck' : 'obs-ev';
      rowEl.setAttribute('aria-label', `Jump to ${row.label}`);
      rowEl.addEventListener('click', () => this.onEventJump(row.event));
      // Rail glyph: a disc sized to the apparent ∅ (log scale, 3–9px), or
      // the hollow "nothing to see from here" ring for specks.
      const railEl = document.createElement('span');
      railEl.className = 'obs-ev-rail';
      const glyphEl = document.createElement('i');
      if (row.speck) {
        glyphEl.className = 'obs-ev-ring';
      } else {
        glyphEl.className = 'obs-ev-disc';
        const px = Math.round(
          Math.min(9, Math.max(3, 3 + 1.5 * Math.log10(Math.max(row.discDeg, 0.01) / 0.01))),
        );
        glyphEl.style.width = `${px}px`;
        glyphEl.style.height = `${px}px`;
      }
      railEl.appendChild(glyphEl);
      const mainEl = document.createElement('div');
      mainEl.className = 'obs-ev-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'obs-ev-name';
      nameEl.textContent = row.label;
      const metaEl = document.createElement('div');
      metaEl.className = 'obs-ev-meta';
      const badgeEl = document.createElement('span');
      badgeEl.className = 'obs-badge';
      badgeEl.textContent = row.classification;
      // "What you'll see" rides the row as a tooltip for now — the jump toast
      // and surface-HUD subline carry it in full; an in-row treatment is
      // kept out to preserve density.
      if (row.hint) {
        rowEl.title = row.hint;
        badgeEl.title = row.hint;
      }
      const timeEl = document.createElement('span');
      timeEl.className = 'obs-ev-time';
      // No year: the countdown beside it carries far-ness in words, and the
      // meta line has magnitude to fit as well.
      const when = formatEventRowTime(row.event.peakUtcMs, false);
      timeEl.textContent = row.magnitudeText ? `${when} · ${row.magnitudeText}` : when;
      metaEl.append(badgeEl, timeEl);
      mainEl.append(nameEl, metaEl);
      const rightEl = document.createElement('span');
      rightEl.className = 'obs-ev-right';
      const countdownEl = document.createElement('span');
      countdownEl.className = 'obs-cd';
      const diameterEl = document.createElement('span');
      diameterEl.className = 'obs-ev-dia';
      diameterEl.textContent = `∅ ${formatDiscDeg(row.discDeg)}°`;
      rightEl.append(countdownEl, diameterEl);
      rowEl.append(railEl, mainEl, rightEl);
      this.eventsListEl.appendChild(rowEl);
      this.renderedRows.push({ row, rowEl, countdownEl });
    }
    // List rebuilds change the sheet's height — keep the inset current.
    this.updateSheetInset();
  }

  /** Re-render all live text (phase hero, now-bar, countdowns) — 8 Hz cadence. */
  render(utcMs: number, info: ObservatorySubjectInfo, extras: ObservatoryRenderExtras): void {
    if (!this.isOpen()) return;

    setText('observatory-vantage', extras.vantageName);
    if (this.swapEl) {
      this.swapEl.style.display = extras.swapName ? '' : 'none';
      if (extras.swapName) setText('observatory-swap-name', extras.swapName);
    }
    if (this.earthRowsEl) this.earthRowsEl.style.display = extras.nextDates ? '' : 'none';
    if (extras.nextDates && this.finderAffixEls.length > 0) {
      // Standing on the Moon, "Full Moon" sits under a hero reading "New
      // Earth": the affix says whose sky the row is naming. From Earth it
      // says nothing the vantage line hasn't.
      const affix = extras.finderAffix ?? '';
      if (this.finderAffixEls[0].textContent !== affix) {
        for (const el of this.finderAffixEls) el.textContent = affix;
      }
    }
    if (extras.nextDates) {
      setText('observatory-meta-full', extras.nextDates.full);
      setText('observatory-meta-new', extras.nextDates.new);
      setText('observatory-meta-lunar', extras.nextDates.lunar);
      setText('observatory-meta-solar', extras.nextDates.solar);
    }

    const phase = observatoryPhaseText(utcMs, info);
    const quiet = info.kind === 'companionless';
    // Quiet variant restyles the glyph to the catalog-tinted ring and hides
    // the events/guides sections (CSS on the class); everything live-text
    // stays on the same nodes.
    this.panelEl?.classList.toggle('quiet', quiet);
    if (this.heroEl) {
      const show = phase || quiet ? '' : 'none';
      if (this.heroEl.style.display !== show) {
        // Hero visibility changes the sheet's height (vantage swaps flip
        // subject kinds) — republish the inset.
        this.heroEl.style.display = show;
        this.updateSheetInset();
      }
    }
    if (quiet) {
      this.panelEl?.style.setProperty('--obs-quiet-tint', info.tintCss);
      setText('observatory-phase-name', 'Quiet sky');
      setText('observatory-phase-meta', 'No moons in this system');
      setText('observatory-phase-data', 'planets & bright stars only');
    } else if (phase && info.kind !== 'events-only') {
      setText('observatory-phase-name', phase.headline);
      setText('observatory-phase-meta', phase.meta);
      setText('observatory-phase-data', formatDiscDataLine(info.angularDiameterDeg, info.distanceKm));
      this.setGlyph(phase.litFraction, phase.lightOnRight);
    }

    setText('observatory-now', formatObservatoryClock(utcMs));
    // The verb only ever replaces the uninformative "realtime" — the rate
    // label still owns the tag everywhere else.
    setText('observatory-now-tag', extras.nowVerb ?? extras.nowTag);

    this.renderWindow({ ...extras.window, hasPhase: phase !== null }, phase);

    for (const { row, rowEl, countdownEl } of this.renderedRows) {
      const text = formatCountdown(utcMs, row.event);
      if (countdownEl.textContent !== text) countdownEl.textContent = text;
      const live = utcMs >= row.event.startUtcMs && utcMs <= row.event.endUtcMs;
      if (rowEl.classList.contains('live') !== live) rowEl.classList.toggle('live', live);
    }
  }

  /**
   * The sky window and the watch row above it. Everything structural is
   * gated on a state key: the window carries a pulsing NOW tick and a mask
   * the hero shares an id space with, and the 8 Hz cadence would restart the
   * one and churn the other. Only the phase terminator moves every render,
   * and that is an attribute write on a node that stays put.
   */
  private renderWindow(
    input: ObservatoryWindowInput,
    phase: { litFraction: number; lightOnRight: boolean } | null,
  ): void {
    const state = observatoryWindowState(input);
    const watch = observatoryWatchRowState(input);
    const key = [
      state.mode,
      state.title,
      state.sub,
      state.glyph,
      state.showNow ? '1' : '0',
      state.relocates ? '1' : '0',
      watch.visible ? watch.title + '|' + watch.meta : '',
    ].join('');
    if (key !== this.windowKey) {
      this.windowKey = key;
      setText('observatory-window-title', state.title);
      setText('observatory-window-sub', state.sub);
      if (this.windowEl) {
        this.windowEl.dataset.glyph = state.glyph;
        this.windowEl.classList.toggle('live', state.mode === 'live');
        this.windowEl.classList.toggle('return', state.mode === 'return');
      }
      if (this.watchRowEl) {
        this.watchRowEl.style.display = watch.visible ? '' : 'none';
        if (watch.visible) {
          setText('observatory-watch-title', watch.title);
          setText('observatory-watch-meta', watch.meta);
        }
      }
      // The watch row appearing or vanishing changes the sheet's height, and
      // the peek floor is measured to the window's bottom edge.
      this.updateSheetInset();
    }
    if (state.glyph === 'phase' && phase) {
      this.windowLitEl?.setAttribute(
        'd',
        phaseGlyphLitPath(phase.litFraction, phase.lightOnRight),
      );
    }
  }

  /** One flash on the window — the hand-off after a jump that lit it up. */
  flashWindow(): void {
    if (!this.windowEl) return;
    this.windowEl.classList.remove('flash');
    // Force a reflow so re-adding the class restarts the animation.
    void this.windowEl.offsetWidth;
    this.windowEl.classList.add('flash');
  }

  private setGlyph(litFraction: number, lightOnRight: boolean): void {
    this.glyphLitEl?.setAttribute('d', phaseGlyphLitPath(litFraction, lightOnRight));
  }
}
