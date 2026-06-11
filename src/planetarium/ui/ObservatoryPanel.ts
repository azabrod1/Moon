/**
 * Observatory panel for the Planetarium's landed mode — Option D "Cinematic
 * Instrument" (design reference: ~/.claude/plans/moon-design). Vantage header
 * with swap chip, phase hero (SVG glyph + angular-diameter data line), live
 * now-bar, the surface-view entry, Earth's prev/next jump rows with next-date
 * metas, and the per-system upcoming-events list with classification badges.
 * Pure DOM + ephemeris reads; clock changes, camera work, and the chunked
 * event search live in PlanetariumMode. 8 Hz renders touch text nodes only;
 * list rebuilds happen only in setEvents.
 */
import { computeOrbitalState, type EventType } from '../../astronomy/ephemeris';
import { formatDateCompact } from '../../astronomy/planetary';
import type { ShadowEvent } from '../../astronomy/shadows';
import { formatDiscDeg } from '../surfaceView';
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
  | { kind: 'events-only'; parentName: string };

/** Panel state computed by the owner per render (vantage, clock, metas). */
export interface ObservatoryRenderExtras {
  /** "You're on Earth" */
  vantageName: string;
  /** Companion body name for the swap chip, or null to hide it. */
  swapName: string | null;
  /** Now-bar tag: 'paused' | 'realtime' | a rate label. */
  nowTag: string;
  /** Surface view active → the Look up button becomes the exit affordance. */
  surfaceActive: boolean;
  /** Earth finder metas ('' hides one, '···' = still scanning); null = not the Earth system. */
  nextDates: { full: string; new: string; lunar: string; solar: string } | null;
}

/** One row of the upcoming-events list. Each row closes over its engine
 * event, so a click jumps to exactly what the row showed — a key re-lookup
 * would silently no-op while a restarted search repopulates its map. */
export interface ObservatoryEventRow {
  event: ShadowEvent;
  label: string;
  classification: string;
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
function formatRowTime(utcMs: number, includeYear: boolean): string {
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

function formatCountdown(nowUtcMs: number, event: ShadowEvent): string {
  if (nowUtcMs > event.endUtcMs) return 'ended';
  if (nowUtcMs >= event.startUtcMs) return 'now';
  const totalMinutes = Math.floor((event.peakUtcMs - nowUtcMs) / 60_000);
  if (totalMinutes < 60) return `in ${Math.max(totalMinutes, 1)}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `in ${totalHours}h ${totalMinutes % 60}m`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 365) return `in ${totalDays}d`;
  return `in ${((event.peakUtcMs - nowUtcMs) / (365.25 * 86_400_000)).toFixed(1)}y`;
}

/**
 * Phase headline/meta/glyph inputs for a subject — shared by the panel hero
 * and the surface HUD's no-event fallback. Null for events-only subjects.
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
 * SVG path for the phase glyph's shadow region: the dark-limb semicircle
 * closed by the elliptical terminator (semi-minor axis ∝ |2f − 1|). Crescent
 * (f < ½) bows the terminator into the lit side; gibbous bows it back. Disc:
 * r=19 centered at (20,20), matching the markup's <circle>.
 */
export function phaseGlyphShadowPath(litFraction: number, lightOnRight: boolean): string {
  const f = Math.min(1, Math.max(0, litFraction));
  const c = 2 * f - 1; // −1 new … +1 full
  const rt = (19 * Math.abs(c)).toFixed(2);
  // Dark limb = the semicircle away from the light; sweep flags follow.
  const darkSweep = lightOnRight ? 0 : 1;
  const termSweep = (f < 0.5) === lightOnRight ? 0 : 1;
  return `M 20 1 A 19 19 0 0 ${darkSweep} 20 39 A ${rt} 19 0 0 ${termSweep} 20 1 Z`;
}

export class ObservatoryPanel {
  private panelEl: HTMLElement | null = null;
  private earthRowsEl: HTMLElement | null = null;
  private heroEl: HTMLElement | null = null;
  private glyphShadowEl: SVGPathElement | null = null;
  private nowBarEl: HTMLElement | null = null;
  private swapEl: HTMLElement | null = null;
  private eventsListEl: HTMLElement | null = null;
  private renderedRows: { row: ObservatoryEventRow; rowEl: HTMLElement; cdEl: HTMLElement }[] = [];
  private wired = false;

  constructor(
    private onJump: (type: EventType, direction: 1 | -1) => void,
    private onEventJump: (event: ShadowEvent) => void,
    private onConesToggle: (on: boolean) => void,
    private onClose: () => void,
    private onLookup: () => void,
    private onSwap: () => void,
  ) {}

  bind(): void {
    this.panelEl = document.getElementById('observatory-panel');
    this.earthRowsEl = document.getElementById('observatory-earth-rows');
    this.heroEl = document.getElementById('observatory-hero');
    this.glyphShadowEl = document.getElementById('observatory-glyph-shadow') as SVGPathElement | null;
    this.nowBarEl = document.getElementById('observatory-nowbar');
    this.swapEl = document.getElementById('observatory-swap');
    this.eventsListEl = document.getElementById('observatory-events-list');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('observatory-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose(); // owner drops its chunked search immediately, not next frame
    });
    this.wireSheetDrag();
    // Crossing the 640px breakpoint re-houses the panel (sheet ↔ side
    // panel) — the published inset must follow.
    window.addEventListener('resize', () => this.updateSheetInset());
    const conesToggle = document.getElementById('observatory-cones-toggle') as HTMLInputElement | null;
    conesToggle?.addEventListener('change', () => this.onConesToggle(conesToggle.checked));
    document.getElementById('observatory-lookup')?.addEventListener('click', () => this.onLookup());
    this.swapEl?.addEventListener('click', () => this.onSwap());
    this.wireJump('observatory-prev-full', 'full-moon', -1);
    this.wireJump('observatory-next-full', 'full-moon', 1);
    this.wireJump('observatory-prev-new', 'new-moon', -1);
    this.wireJump('observatory-next-new', 'new-moon', 1);
    this.wireJump('observatory-prev-lunar', 'lunar-eclipse', -1);
    this.wireJump('observatory-next-lunar', 'lunar-eclipse', 1);
    this.wireJump('observatory-prev-solar', 'solar-eclipse', -1);
    this.wireJump('observatory-next-solar', 'solar-eclipse', 1);
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
   * Publish the sheet's height as --sheet-inset so bottom-anchored chrome
   * (the surface transport strip) rides its top edge instead of being
   * buried — cross-component policy 2: a sheet never seals the transport.
   */
  private updateSheetInset(): void {
    if (this.isOpen() && this.isSheetForm() && this.panelEl) {
      document.body.style.setProperty('--sheet-inset', `${this.panelEl.offsetHeight}px`);
    } else {
      document.body.style.removeProperty('--sheet-inset');
    }
  }

  show(): void {
    this.panelEl?.classList.add('visible');
    document.body.classList.add('observatory-sheet-open');
    this.updateSheetInset();
  }

  hide(): void {
    this.panelEl?.classList.remove('visible');
    document.body.classList.remove('observatory-sheet-open');
    this.updateSheetInset();
  }

  /**
   * Sheet-form swipe-to-dismiss: a downward drag on the header (the grab
   * handle + eyebrow row — not the scrollable body, so list scrolling never
   * arms it) follows the finger and releases past a threshold. Pointer
   * events only on the handle keep the sky above the sheet gesture-live.
   */
  private wireSheetDrag(): void {
    const handle = document.querySelector('#observatory-panel .obs-eyebrow') as HTMLElement | null;
    if (!handle || !this.panelEl) return;
    const panel = this.panelEl;
    let startY: number | null = null;
    let activePointer: number | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if (!this.isSheetForm()) return;
      // A tap on the close X (a child of the header) must stay a click —
      // capturing would retarget its pointerup to the handle and eat it.
      if ((e.target as HTMLElement).closest('button')) return;
      if (activePointer !== null) return; // one finger drives the sheet
      activePointer = e.pointerId;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activePointer || startY === null) return;
      const dy = Math.max(0, e.clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== activePointer || startY === null) return;
      const dy = e.clientY - startY;
      activePointer = null;
      startY = null;
      panel.style.transform = '';
      if (dy > 80) {
        this.hide();
        this.onClose();
      }
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  /** One ~600ms accent glow on the now-bar — called after any time jump. */
  flashNowBar(): void {
    if (!this.nowBarEl) return;
    this.nowBarEl.classList.remove('flash');
    // Force a reflow so re-adding the class restarts the animation.
    void this.nowBarEl.offsetWidth;
    this.nowBarEl.classList.add('flash');
  }

  /** Replace the upcoming-events list; an empty statusText hides the status line. */
  setEvents(rows: ObservatoryEventRow[], statusText: string, nowUtcMs: number): void {
    setText('observatory-events-status', statusText);
    if (!this.eventsListEl) return;
    this.eventsListEl.textContent = '';
    this.renderedRows = [];
    for (const row of rows) {
      // The year earns its width only when the event is far out.
      const includeYear = Math.abs(row.event.peakUtcMs - nowUtcMs) > 300 * 86_400_000;
      const rowEl = document.createElement('div');
      rowEl.className = row.speck ? 'obs-ev speck' : 'obs-ev';
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
      const timeEl = document.createElement('span');
      timeEl.className = 'obs-ev-time';
      timeEl.textContent = row.magnitudeText
        ? `${formatRowTime(row.event.peakUtcMs, includeYear)} · ${row.magnitudeText}`
        : formatRowTime(row.event.peakUtcMs, includeYear);
      const cdEl = document.createElement('span');
      cdEl.className = 'obs-cd';
      metaEl.append(badgeEl, timeEl, cdEl);
      mainEl.append(nameEl, metaEl);
      const rightEl = document.createElement('span');
      rightEl.className = 'obs-ev-right';
      const jumpEl = document.createElement('button');
      jumpEl.className = 'obs-tpill';
      jumpEl.textContent = 'Jump';
      jumpEl.title = `Jump to ${row.label}`;
      jumpEl.addEventListener('click', () => this.onEventJump(row.event));
      const diaEl = document.createElement('span');
      diaEl.className = 'obs-ev-dia';
      diaEl.textContent = `∅ ${formatDiscDeg(row.discDeg)}°`;
      rightEl.append(jumpEl, diaEl);
      rowEl.append(railEl, mainEl, rightEl);
      this.eventsListEl.appendChild(rowEl);
      this.renderedRows.push({ row, rowEl, cdEl });
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
    setText('observatory-lookup-label', extras.surfaceActive ? 'Return to orbit' : 'Look up');
    setText(
      'observatory-lookup-hint',
      extras.surfaceActive ? '— leave the surface' : '— watch from the surface',
    );

    if (this.earthRowsEl) this.earthRowsEl.style.display = extras.nextDates ? '' : 'none';
    if (extras.nextDates) {
      setText('observatory-meta-full', extras.nextDates.full);
      setText('observatory-meta-new', extras.nextDates.new);
      setText('observatory-meta-lunar', extras.nextDates.lunar);
      setText('observatory-meta-solar', extras.nextDates.solar);
    }

    const phase = observatoryPhaseText(utcMs, info);
    if (this.heroEl) {
      const show = phase ? '' : 'none';
      if (this.heroEl.style.display !== show) {
        // Hero visibility changes the sheet's height (vantage swaps flip
        // subject kinds) — republish the inset.
        this.heroEl.style.display = show;
        this.updateSheetInset();
      }
    }
    if (phase && info.kind !== 'events-only') {
      setText('observatory-phase-name', phase.headline);
      setText('observatory-phase-meta', phase.meta);
      setText('observatory-phase-data', formatDiscDataLine(info.angularDiameterDeg, info.distanceKm));
      this.setGlyph(phase.litFraction, phase.lightOnRight);
    }

    setText('observatory-now', formatObservatoryClock(utcMs));
    setText('observatory-now-tag', extras.nowTag);

    for (const { row, rowEl, cdEl } of this.renderedRows) {
      const text = formatCountdown(utcMs, row.event);
      if (cdEl.textContent !== text) cdEl.textContent = text;
      const live = utcMs >= row.event.startUtcMs && utcMs <= row.event.endUtcMs;
      if (rowEl.classList.contains('live') !== live) rowEl.classList.toggle('live', live);
    }
  }

  private setGlyph(litFraction: number, lightOnRight: boolean): void {
    this.glyphShadowEl?.setAttribute('d', phaseGlyphShadowPath(litFraction, lightOnRight));
  }
}
