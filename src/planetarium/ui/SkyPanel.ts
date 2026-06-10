/**
 * Sky panel for the Planetarium's landed mode: a phase readout for the landed
 * system (the Moon from Earth, Earth from the Moon, the parent planet from any
 * other moon), prev/next phase + eclipse jumps for the Earth system, and a
 * chronological upcoming-events list fed by the shadow engine for every moon
 * system. Pure DOM + ephemeris reads; clock changes, camera framing, and the
 * chunked event search live in PlanetariumMode.
 */
import { computeOrbitalState, type EventType } from '../../astronomy/ephemeris';
import { formatDateCompact } from '../../astronomy/planetary';
import { setText } from '../../shared/dom';

/** What the phase row shows for the current landed body. */
export type SkySubjectInfo =
  | { kind: 'earth'; subject: 'Moon' | 'Earth' }
  | { kind: 'moon-phase'; parentName: string; moonName: string; illumination: number }
  | { kind: 'events-only'; parentName: string };

/** One row of the upcoming-events list (display data only; jumps go by key). */
export interface SkyEventRow {
  key: string;
  label: string;
  classification: string;
  startUtcMs: number;
  peakUtcMs: number;
  endUtcMs: number;
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

/** "Jun 12 2026 03:14" — compact enough for a panel row with a countdown beside it. */
function formatRowTime(utcMs: number): string {
  const d = new Date(utcMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDateCompact(utcMs)} ${hh}:${mm}`;
}

function formatCountdown(nowUtcMs: number, row: SkyEventRow): string {
  if (nowUtcMs > row.endUtcMs) return 'ended';
  if (nowUtcMs >= row.startUtcMs) return 'now';
  const totalMinutes = Math.floor((row.peakUtcMs - nowUtcMs) / 60_000);
  if (totalMinutes < 60) return `in ${Math.max(totalMinutes, 1)}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `in ${totalHours}h ${totalMinutes % 60}m`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 365) return `in ${totalDays}d ${totalHours % 24}h`;
  return `in ${((row.peakUtcMs - nowUtcMs) / (365.25 * 86_400_000)).toFixed(1)}y`;
}

export class SkyPanel {
  private panelEl: HTMLElement | null = null;
  private earthRowsEl: HTMLElement | null = null;
  private phaseRowEl: HTMLElement | null = null;
  private eventsListEl: HTMLElement | null = null;
  private renderedRows: { row: SkyEventRow; timeEl: HTMLElement }[] = [];
  private wired = false;

  constructor(
    private onJump: (type: EventType, direction: 1 | -1) => void,
    private onEventJump: (key: string) => void,
    private onConesToggle: (on: boolean) => void,
    private onClose: () => void,
  ) {}

  bind(): void {
    this.panelEl = document.getElementById('sky-panel');
    this.earthRowsEl = document.getElementById('sky-earth-rows');
    this.phaseRowEl = document.querySelector('#sky-panel .sky-phase-row');
    this.eventsListEl = document.getElementById('sky-events-list');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('sky-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose(); // owner drops its chunked search immediately, not next frame
    });
    const conesToggle = document.getElementById('sky-cones-toggle') as HTMLInputElement | null;
    conesToggle?.addEventListener('change', () => this.onConesToggle(conesToggle.checked));
    this.wireJump('sky-prev-full', 'full-moon', -1);
    this.wireJump('sky-next-full', 'full-moon', 1);
    this.wireJump('sky-prev-new', 'new-moon', -1);
    this.wireJump('sky-next-new', 'new-moon', 1);
    this.wireJump('sky-prev-lunar', 'lunar-eclipse', -1);
    this.wireJump('sky-next-lunar', 'lunar-eclipse', 1);
    this.wireJump('sky-prev-solar', 'solar-eclipse', -1);
    this.wireJump('sky-next-solar', 'solar-eclipse', 1);
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

  show(): void {
    this.panelEl?.classList.add('visible');
  }

  hide(): void {
    this.panelEl?.classList.remove('visible');
  }

  /** Replace the upcoming-events list; an empty statusText hides the status line. */
  setEvents(rows: SkyEventRow[], statusText: string): void {
    setText('sky-events-status', statusText);
    if (!this.eventsListEl) return;
    this.eventsListEl.textContent = '';
    this.renderedRows = [];
    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'sky-upcoming-row';
      const infoEl = document.createElement('div');
      infoEl.className = 'sky-upcoming-info';
      const labelEl = document.createElement('div');
      labelEl.className = 'sky-upcoming-label';
      labelEl.textContent = `${row.label} · ${row.classification}`;
      const timeEl = document.createElement('div');
      timeEl.className = 'sky-upcoming-time';
      infoEl.append(labelEl, timeEl);
      const jumpEl = document.createElement('button');
      jumpEl.className = 'nav-btn sky-upcoming-jump';
      jumpEl.innerHTML = '&#9654;';
      jumpEl.title = `Jump to ${row.label}`;
      jumpEl.addEventListener('click', () => this.onEventJump(row.key));
      rowEl.append(infoEl, jumpEl);
      this.eventsListEl.appendChild(rowEl);
      this.renderedRows.push({ row, timeEl });
    }
  }

  /** Re-render the phase readout + countdowns; cheap enough for the 8 Hz UI cadence. */
  render(utcMs: number, info: SkySubjectInfo): void {
    if (!this.isOpen()) return;
    if (this.earthRowsEl) this.earthRowsEl.style.display = info.kind === 'earth' ? '' : 'none';
    if (this.phaseRowEl) this.phaseRowEl.style.display = info.kind === 'events-only' ? 'none' : '';

    if (info.kind === 'earth') {
      const state = computeOrbitalState(new Date(utcMs));
      const illumination = info.subject === 'Earth' ? 1 - state.illumination : state.illumination;
      const phaseName = info.subject === 'Earth'
        ? EARTH_PHASE_NAME[state.phaseName] ?? state.phaseName
        : state.phaseName;
      setText('sky-subject', info.subject === 'Earth' ? 'Earth · from the Moon' : 'Moon · from Earth');
      setText('sky-phase-name', phaseName);
      setText('sky-illumination', `${Math.round(illumination * 100)}% lit`);
    } else if (info.kind === 'moon-phase') {
      setText('sky-subject', `${info.parentName} · from ${info.moonName}`);
      setText('sky-phase-name', genericPhaseName(info.illumination));
      setText('sky-illumination', `${Math.round(info.illumination * 100)}% lit`);
    } else {
      setText('sky-subject', `${info.parentName} system`);
    }

    for (const { row, timeEl } of this.renderedRows) {
      const text = `${formatRowTime(row.peakUtcMs)} · ${formatCountdown(utcMs, row)}`;
      if (timeEl.textContent !== text) timeEl.textContent = text;
    }
  }
}
