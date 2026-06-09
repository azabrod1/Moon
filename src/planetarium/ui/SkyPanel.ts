/**
 * Sky panel for the Planetarium's landed mode (Earth system only for now):
 * shows the Moon's current phase — or Earth's phase when landed on the Moon —
 * and offers prev/next jumps to full moons, new moons, and eclipses. Pure DOM
 * + ephemeris reads; the clock change and camera framing happen in the onJump
 * callback provided by PlanetariumMode.
 */
import { computeOrbitalState, type EventType } from '../../astronomy/ephemeris';
import { setText } from '../../shared/dom';

export type SkySubject = 'Moon' | 'Earth';

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

export class SkyPanel {
  private panelEl: HTMLElement | null = null;
  private wired = false;

  constructor(private onJump: (type: EventType, direction: 1 | -1) => void) {}

  bind(): void {
    this.panelEl = document.getElementById('sky-panel');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('sky-close')?.addEventListener('click', () => this.hide());
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

  /** Re-render the phase readout; cheap enough for the 8 Hz UI cadence. */
  render(utcMs: number, subject: SkySubject): void {
    if (!this.isOpen()) return;
    const state = computeOrbitalState(new Date(utcMs));
    const illumination = subject === 'Earth' ? 1 - state.illumination : state.illumination;
    const phaseName = subject === 'Earth'
      ? EARTH_PHASE_NAME[state.phaseName] ?? state.phaseName
      : state.phaseName;
    setText('sky-subject', subject === 'Earth' ? 'Earth · from the Moon' : 'Moon · from Earth');
    setText('sky-phase-name', phaseName);
    setText('sky-illumination', `${Math.round(illumination * 100)}% lit`);
  }
}
