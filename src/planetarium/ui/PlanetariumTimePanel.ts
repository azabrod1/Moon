/**
 * The bottom bar's time control — the whole `#time-control` segment: a
 * nine-detent rate rail riding on an adaptive clock, plus the expanded panel
 * the clock opens (transport, full labeled rail, exact UTC date). Renders
 * everything from `SimulationTime` with per-value diffing (steady state writes
 * no DOM, and the datetime input is never clobbered mid-edit) and turns rail
 * gestures into callbacks — it never mutates time itself; PlanetariumMode owns
 * the clock, and PlanetariumBottomBar owns the panel's open/close.
 */
import {
  formatAdaptiveClock,
  formatTimeRateLabel,
  formatUtcInputValue,
  type SimulationTime,
} from '../../astronomy/planetary';

/** How far (px) a pointer may wander and still count as a tap-in-place. */
const TAP_SLOP_PX = 4;
/** The clock counts as "at now" within this much drift (ms). */
const LIVE_DRIFT_MS = 120_000;
/** How long the unit flash covers the clock before fading back. */
const FLASH_HOLD_MS = 950;

export interface TimeRailCallbacks {
  /** Rail/trail/detent-label commit: snap to this preset index (magnitude
   *  only — the clock's direction is the mode's to keep). */
  onRateIndex(index: number): void;
  /** Keyboard stepper: ±1 along the ladder (routes through stepSimulationRate
   *  so off-ladder magnitudes snap the same way the buttons always did). */
  onStep(direction: -1 | 1): void;
  onPauseToggle(): void;
  onNow(): void;
}

/**
 * 0..1 rail position for a rate magnitude: detents sit at i/(n−1); off-ladder
 * magnitudes (the tutorial's 2 hr/s) interpolate log-linearly between their
 * neighbour presets so the thumb sits honestly between detents.
 */
export function railFraction(rateMagnitude: number, presets: readonly number[]): number {
  const last = presets.length - 1;
  if (!(rateMagnitude > presets[0])) return 0;
  if (rateMagnitude >= presets[last]) return 1;
  let i = 0;
  while (rateMagnitude >= presets[i + 1]) i++;
  const span = Math.log(presets[i + 1] / presets[i]);
  const into = Math.log(rateMagnitude / presets[i]);
  return (i + into / span) / last;
}

/** The detent whose preset is nearest in log space (it's a geometric ladder). */
export function nearestPresetIndex(rateMagnitude: number, presets: readonly number[]): number {
  const magnitude = Math.max(rateMagnitude, presets[0]);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < presets.length; i++) {
    const dist = Math.abs(Math.log(magnitude / presets[i]));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * What a press on the tap-to-pause rail means, decided by distance from the
 * LIVE THUMB — not by which detent index the press rounds to. Within `slopPx`
 * of the thumb is a tap-in-place → pause; anywhere else selects the detent
 * under the press, even the detent nearest an off-ladder rate (whose index
 * equals the thumb's, so an index-equality test would misread it as a pause).
 * A rate sitting exactly on a detent puts the thumb on that detent, so tapping
 * it still reads as on-thumb → pause.
 */
export function railTapAction(pointerX: number, thumbX: number, slopPx: number): 'pause' | 'select' {
  return Math.abs(pointerX - thumbX) <= slopPx ? 'pause' : 'select';
}

/** Compact detent label — "1min", never bare "1m" (minute would read as month
 *  two labels away from "1mo"). */
export function railDetentLabel(presetSeconds: number): string {
  if (presetSeconds === 1) return '1×';
  if (presetSeconds < 3600) return `${Math.round(presetSeconds / 60)}min`;
  if (presetSeconds < 86400) return `${Math.round(presetSeconds / 3600)}h`;
  if (presetSeconds < 604800) return `${Math.round(presetSeconds / 86400)}d`;
  if (presetSeconds < 2592000) return `${Math.round(presetSeconds / 604800)}w`;
  if (presetSeconds < 86400 * 365) return `${Math.round(presetSeconds / 2592000)}mo`;
  return `${Math.round(presetSeconds / 31557600)}yr`;
}

interface SliderDrag {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
}

export class PlanetariumTimePanel {
  private rootEl: HTMLElement | null = null;
  private railEl: HTMLElement | null = null;
  private railFillEl: HTMLElement | null = null;
  private railThumbEl: HTMLElement | null = null;
  private tipEl: HTMLElement | null = null;
  private clockEl: HTMLElement | null = null;
  private clockDateEl: HTMLElement | null = null;
  private clockTimeEl: HTMLElement | null = null;
  private clockSwapEl: HTMLElement | null = null;
  private trailEl: HTMLElement | null = null;
  private trailFillEl: HTMLElement | null = null;
  private trailThumbEl: HTMLElement | null = null;
  private labelButtons: HTMLButtonElement[] = [];
  private rateEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private nowBtn: HTMLElement | null = null;
  private reverseBtn: HTMLElement | null = null;
  private pauseBtn: HTMLElement | null = null;
  private playBtn: HTMLElement | null = null;

  private wired = false;
  private displayIndex = 0;
  /** 0..1 position of the live thumb (railFraction of the current rate), kept
   *  from the last render so a tap can be measured against the thumb, not a
   *  detent index — an off-ladder rate sits between detents. */
  private thumbFraction = 0;
  private lastPct = '';
  private lastLive: boolean | null = null;
  private lastPaused: boolean | null = null;
  private lastDate = '';
  private lastTimeSlot: string | null = null;
  private lastRateLabel = '';
  private lastLabelIndex = -1;
  private lastNowOff: boolean | null = null;
  private lastTransport = '';
  private lastInputValue = '';
  private prevFlashLabel: string | null = null;
  private flashTimer: number | null = null;
  private railDrag: SliderDrag = { active: false, moved: false, startX: 0, startY: 0 };
  private trailDrag: SliderDrag = { active: false, moved: false, startX: 0, startY: 0 };

  constructor(
    private presets: readonly number[],
    private callbacks: TimeRailCallbacks,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('time-control');
    this.railEl = document.getElementById('planetarium-time-rail');
    this.railFillEl = this.railEl?.querySelector('.tr-fill') ?? null;
    this.railThumbEl = this.railEl?.querySelector('.tr-thumb') ?? null;
    this.tipEl = this.railEl?.querySelector('.tr-tip') ?? null;
    this.clockEl = document.getElementById('time-clock');
    this.clockDateEl = this.clockEl?.querySelector('.d') ?? null;
    this.clockTimeEl = this.clockEl?.querySelector('.t') ?? null;
    this.clockSwapEl = this.clockEl?.querySelector('.swap') ?? null;
    this.trailEl = document.getElementById('planetarium-time-trail');
    this.trailFillEl = this.trailEl?.querySelector('.fill') ?? null;
    this.trailThumbEl = this.trailEl?.querySelector('.thumb') ?? null;
    this.rateEl = document.getElementById('planetarium-time-rate-value');
    this.inputEl = document.getElementById('planetarium-time-input') as HTMLInputElement | null;
    this.nowBtn = document.getElementById('planetarium-time-now');
    this.reverseBtn = document.getElementById('planetarium-time-reverse');
    this.pauseBtn = document.getElementById('planetarium-time-pause');
    this.playBtn = document.getElementById('planetarium-time-play');

    if (this.wired) return;
    this.wired = true;

    // Everything below runs once — bind() re-runs on every mode activation,
    // and doubled listeners would turn tap-to-pause into a no-op.
    const last = this.presets.length - 1;
    this.rootEl?.style.setProperty('--rail-step', `${100 / last}%`);
    for (const slider of [this.railEl, this.trailEl]) {
      slider?.setAttribute('aria-valuemin', '0');
      slider?.setAttribute('aria-valuemax', String(last));
    }
    this.buildDetentLabels();
    if (this.railEl) this.attachSlider(this.railEl, this.railDrag, { tapToPause: true });
    if (this.trailEl) this.attachSlider(this.trailEl, this.trailDrag, { tapToPause: false });
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

  render(time: SimulationTime, opts?: { flash?: boolean }): void {
    if (!this.railEl) return;
    const magnitude = Math.abs(time.rate);
    const nowMs = Date.now();
    const offNow = Math.abs(time.currentUtcMs - nowMs) > LIVE_DRIFT_MS;
    const live = !time.paused && time.rate > 0 && Math.abs(magnitude - 1) < 1e-9 && !offNow;
    const index = nearestPresetIndex(magnitude, this.presets);
    this.displayIndex = index;
    const fraction = railFraction(magnitude, this.presets);
    this.thumbFraction = fraction;
    const pct = `${(fraction * 100).toFixed(2)}%`;
    const rateLabel = formatTimeRateLabel(time.rate, time.paused);

    if (this.lastPct !== pct) {
      if (this.railFillEl) this.railFillEl.style.width = pct;
      if (this.railThumbEl) this.railThumbEl.style.left = pct;
      if (this.trailFillEl) this.trailFillEl.style.width = pct;
      if (this.trailThumbEl) this.trailThumbEl.style.left = pct;
      this.lastPct = pct;
    }
    if (this.lastLive !== live) {
      this.railEl.classList.toggle('live', live);
      this.clockEl?.classList.toggle('live', live);
      this.trailEl?.classList.toggle('live', live);
      this.rateEl?.classList.toggle('live', live);
      this.lastLive = live;
    }
    if (this.lastPaused !== time.paused) {
      this.railEl.classList.toggle('paused', time.paused);
      this.rateEl?.classList.toggle('dim', time.paused);
      this.lastPaused = time.paused;
    }

    const parts = formatAdaptiveClock(time.currentUtcMs, magnitude);
    const timeSlot = time.paused ? 'paused' : parts.time;
    if (this.clockDateEl && this.lastDate !== parts.date) {
      this.clockDateEl.textContent = parts.date;
      this.lastDate = parts.date;
    }
    if (this.clockTimeEl && this.lastTimeSlot !== timeSlot) {
      this.clockTimeEl.textContent = timeSlot;
      this.clockTimeEl.classList.toggle('hidden', timeSlot === '');
      this.lastTimeSlot = timeSlot;
    }

    if (this.lastRateLabel !== rateLabel) {
      if (this.rateEl) this.rateEl.textContent = rateLabel;
      this.railEl.setAttribute('aria-valuetext', rateLabel);
      this.trailEl?.setAttribute('aria-valuetext', rateLabel);
      this.lastRateLabel = rateLabel;
    }
    if (this.lastLabelIndex !== index) {
      this.railEl.setAttribute('aria-valuenow', String(index));
      this.trailEl?.setAttribute('aria-valuenow', String(index));
      this.labelButtons.forEach((btn, i) => btn.classList.toggle('on', i === index));
      this.lastLabelIndex = index;
    }

    const nextInputValue = formatUtcInputValue(time.currentUtcMs);
    if (this.inputEl && this.lastInputValue !== nextInputValue && document.activeElement !== this.inputEl) {
      this.inputEl.value = nextInputValue;
      this.lastInputValue = nextInputValue;
    }
    if (this.lastNowOff !== offNow) {
      this.nowBtn?.classList.toggle('off', offNow);
      this.lastNowOff = offNow;
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
      this.lastTransport = transport;
    }

    // The unit flash is gesture-driven (opts.flash), never diff-driven — a
    // restored save must not flash its old rate over the clock at load.
    if (opts?.flash && this.prevFlashLabel !== null && rateLabel !== this.prevFlashLabel) {
      this.flash(rateLabel);
    }
    this.prevFlashLabel = rateLabel;
  }

  private buildDetentLabels(): void {
    const wrap = document.getElementById('planetarium-time-labels');
    if (!wrap) return;
    const last = this.presets.length - 1;
    this.labelButtons = this.presets.map((preset, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = railDetentLabel(preset);
      btn.style.left = `${(i / last) * 100}%`;
      btn.setAttribute('aria-label', `Set rate ${formatTimeRateLabel(preset, false)}`);
      btn.addEventListener('click', () => this.callbacks.onRateIndex(i));
      wrap.appendChild(btn);
      return btn;
    });
  }

  private attachSlider(el: HTMLElement, drag: SliderDrag, opts: { tapToPause: boolean }): void {
    const endDrag = () => {
      drag.active = false;
      el.classList.remove('dragging');
      this.hideTip();
    };
    el.addEventListener('pointerdown', (e) => {
      drag.active = true;
      drag.moved = false;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer ids (tests, some assistive tech) can't be captured.
      }
      el.classList.add('dragging');
      const idx = this.indexFromX(el, e.clientX);
      if (opts.tapToPause) {
        // Rail: pause vs select is decided by distance from the LIVE thumb, not
        // by detent-index equality. A press away from the thumb selects that
        // detent right away and counts as a move so release won't also pause —
        // even the detent nearest an off-ladder rate, whose index matches the
        // thumb's. A press on the thumb defers to pointerup, which pauses if it
        // stays in place (a rate exactly on a detent puts the thumb there, so
        // tapping that detent still pauses).
        const rect = el.getBoundingClientRect();
        const thumbX = rect.left + this.thumbFraction * rect.width;
        if (railTapAction(e.clientX, thumbX, TAP_SLOP_PX) === 'select') {
          this.callbacks.onRateIndex(idx);
          drag.moved = true;
        }
      } else {
        // The panel trail commits even in place — a tap there means "this rate,
        // running" (it unpauses), never pause.
        this.callbacks.onRateIndex(idx);
        if (idx !== this.displayIndex) drag.moved = true;
      }
      if (el === this.railEl) this.showTip(idx);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_SLOP_PX) {
          drag.moved = true;
        }
        const idx = this.indexFromX(el, e.clientX);
        if (idx !== this.displayIndex) {
          this.callbacks.onRateIndex(idx);
          drag.moved = true;
        }
        if (el === this.railEl) this.showTip(idx);
      } else if (el === this.railEl) {
        this.showTip(this.indexFromX(el, e.clientX));
      }
    });
    el.addEventListener('pointerup', (e) => {
      const wasTap = drag.active && !drag.moved;
      drag.active = false;
      el.classList.remove('dragging');
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already be gone (synthetic pointers, cancelled drags).
      }
      // Touch gets no pointerleave — hide the tooltip on release or it lingers.
      if (e.pointerType !== 'mouse') this.hideTip();
      if (wasTap && opts.tapToPause) this.callbacks.onPauseToggle();
    });
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', () => {
      if (drag.active) endDrag();
    });
    el.addEventListener('pointerleave', () => {
      if (!drag.active) this.hideTip();
    });
    window.addEventListener('blur', () => {
      if (drag.active) endDrag();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === '.') this.callbacks.onStep(1);
      else if (e.key === 'ArrowLeft' || e.key === ',') this.callbacks.onStep(-1);
      else if (e.key === ' ') this.callbacks.onPauseToggle();
      else if (e.key === 'n' || e.key === 'N') this.callbacks.onNow();
      else return;
      // Handled here — without this the window-level handler would also see
      // the key and Space would double as the ship's thrust toggle.
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private indexFromX(el: HTMLElement, clientX: number): number {
    const rect = el.getBoundingClientRect();
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const last = this.presets.length - 1;
    return Math.max(0, Math.min(last, Math.round(fraction * last)));
  }

  private showTip(index: number): void {
    if (!this.tipEl) return;
    const label = formatTimeRateLabel(this.presets[index], false);
    if (this.tipEl.textContent !== label) this.tipEl.textContent = label;
    this.tipEl.style.left = `${(index / (this.presets.length - 1)) * 100}%`;
    this.tipEl.classList.add('show');
  }

  private hideTip(): void {
    this.tipEl?.classList.remove('show');
  }

  private flash(text: string): void {
    if (!this.clockEl || !this.clockSwapEl) return;
    this.clockSwapEl.textContent = text;
    this.clockEl.classList.add('flash');
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.clockEl?.classList.remove('flash');
      this.flashTimer = null;
    }, FLASH_HOLD_MS);
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
