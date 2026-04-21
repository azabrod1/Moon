/**
 * Renders the Planetarium's time readouts: current date/time, time rate
 * label ("Paused", "1×", "-10×", etc.), the datetime input, and the
 * pause/resume button label. Diffs against the last rendered value so
 * editing the input field is not clobbered mid-keystroke.
 */
import {
  formatDateCompact,
  formatTimeRateLabel,
  formatUtcInputValue,
  type SimulationTime,
} from '../../astronomy/planetary';

export class PlanetariumTimePanel {
  private valueEl: HTMLElement | null = null;
  private rateEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private lastLabel = '';
  private lastRateLabel = '';
  private lastInputValue = '';

  bind(): void {
    this.valueEl = document.getElementById('planetarium-time-value');
    this.rateEl = document.getElementById('planetarium-time-rate');
    this.inputEl = document.getElementById('planetarium-time-input') as HTMLInputElement | null;
  }

  /** Set the datetime input to match the time state (used at activation). */
  syncInputValue(utcMs: number): void {
    if (this.inputEl) {
      this.inputEl.value = formatUtcInputValue(utcMs);
      this.lastInputValue = this.inputEl.value;
    }
  }

  getInputEl(): HTMLInputElement | null {
    return this.inputEl;
  }

  render(time: SimulationTime): void {
    const nextLabel = formatDateCompact(time.currentUtcMs);
    const nextRateLabel = formatTimeRateLabel(time.rate, time.paused);
    const nextInputValue = formatUtcInputValue(time.currentUtcMs);

    if (this.valueEl && this.lastLabel !== nextLabel) {
      this.valueEl.textContent = nextLabel;
      this.lastLabel = nextLabel;
    }
    if (this.rateEl && this.lastRateLabel !== nextRateLabel) {
      this.rateEl.textContent = nextRateLabel;
      this.lastRateLabel = nextRateLabel;
    }
    if (this.inputEl && this.lastInputValue !== nextInputValue && document.activeElement !== this.inputEl) {
      this.inputEl.value = nextInputValue;
      this.lastInputValue = nextInputValue;
    }

    const pauseBtn = document.getElementById('planetarium-time-pause');
    if (pauseBtn) pauseBtn.textContent = time.paused ? 'Resume' : 'Pause';
  }
}
