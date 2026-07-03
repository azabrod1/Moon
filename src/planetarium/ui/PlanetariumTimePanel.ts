/**
 * Renders the Planetarium's time readouts: the collapsed bar's date + signed
 * rate label, the popover's magnitude-only rate readout, the datetime input,
 * and the transport segments' lit state. Diffs against the last rendered
 * value so editing the input field is not clobbered mid-keystroke and steady
 * state writes no DOM.
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
  private rateValueEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private reverseBtn: HTMLElement | null = null;
  private pauseBtn: HTMLElement | null = null;
  private playBtn: HTMLElement | null = null;
  private lastLabel = '';
  private lastRateLabel = '';
  private lastRateValue = '';
  private lastTransport = '';
  private lastInputValue = '';

  bind(): void {
    this.valueEl = document.getElementById('planetarium-time-value');
    this.rateEl = document.getElementById('planetarium-time-rate');
    this.rateValueEl = document.getElementById('planetarium-time-rate-value');
    this.inputEl = document.getElementById('planetarium-time-input') as HTMLInputElement | null;
    this.reverseBtn = document.getElementById('planetarium-time-reverse');
    this.pauseBtn = document.getElementById('planetarium-time-pause');
    this.playBtn = document.getElementById('planetarium-time-play');
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
    // Popover readout is magnitude-only ("Realtime", "1 min/s") — direction is
    // the lit segment's job, and a stable label width keeps the − / + steppers
    // from shifting under a repeat-clicking pointer.
    const nextRateValue = formatTimeRateLabel(Math.abs(time.rate), false);

    if (this.valueEl && this.lastLabel !== nextLabel) {
      this.valueEl.textContent = nextLabel;
      this.lastLabel = nextLabel;
    }
    if (this.rateEl && this.lastRateLabel !== nextRateLabel) {
      this.rateEl.textContent = nextRateLabel;
      this.lastRateLabel = nextRateLabel;
    }
    if (this.rateValueEl && this.lastRateValue !== nextRateValue) {
      this.rateValueEl.textContent = nextRateValue;
      this.lastRateValue = nextRateValue;
    }
    if (this.inputEl && this.lastInputValue !== nextInputValue && document.activeElement !== this.inputEl) {
      this.inputEl.value = nextInputValue;
      this.lastInputValue = nextInputValue;
    }

    const transport = time.paused
      ? time.rate < 0 ? 'paused-rev' : 'paused-fwd'
      : time.rate < 0 ? 'rev' : 'fwd';
    if (this.lastTransport !== transport) {
      const paused = time.paused;
      this.setSegment(this.reverseBtn, transport === 'rev', paused && time.rate < 0);
      this.setSegment(this.pauseBtn, paused, false);
      this.setSegment(this.playBtn, transport === 'fwd', paused && time.rate >= 0);
      this.pauseBtn?.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
      this.rateValueEl?.classList.toggle('is-dim', paused);
      this.lastTransport = transport;
    }
  }

  /** `on` lights the segment for the clock's current state; `armed` faintly
   *  tints the direction a paused clock would resume into (pausing keeps the
   *  rate's sign, so "resume goes backward" must stay visible). */
  private setSegment(el: HTMLElement | null, on: boolean, armed: boolean): void {
    if (!el) return;
    el.classList.toggle('on', on);
    el.classList.toggle('armed', armed && !on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}
