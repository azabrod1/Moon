/**
 * On-device perf sweep (`?perf=1`) — DEV only, loaded on demand.
 *
 * A phone cannot be profiled from a Mac: the same frame costs different money
 * on different silicon, so the ranking of what a frame is spent on has to be
 * measured where the frame is slow. This is that measurement, driven from the
 * screen: park at the pose that is slow, tap Sweep, and each configuration is
 * applied on its own, held, measured, and put back exactly as it was found.
 *
 * Two numbers per configuration, and they answer different questions:
 *
 *  - **fps** is how far apart the frames arrive — rAF callbacks counted
 *    against the wall clock, never the app's own dt and never the rAF
 *    timestamp (after a busy main thread that timestamp is the frame the
 *    browser meant to start, not the one that ran).
 *  - **busy** is how much of each frame the app spends on the main thread:
 *    both ends of the animation loop's own tick. It excludes the GPU, which
 *    only has the work submitted to it inside that span.
 *
 * The gap between them is the point. A frame that arrives 33 ms after the last
 * one with 8 ms of work in it was not made slow by the app's work — the page
 * is being paced from outside, which iOS does under thermal and background
 * pressure, and which minimising the browser and coming back clears. So the
 * sweep ends on a CONTROL that switches everything off at once: if that still
 * reads half rate on an idle main thread, the table says so in words rather
 * than letting the per-configuration numbers be read as costs they are not.
 *
 * The third readout is the frame-sliced work. The texture warm pump and the
 * atmosphere bake each take a share of a smoothed frame interval, so a scene
 * that makes frames long licences longer slices, which keeps the frames long:
 * the interval, each consumer's budget, its spend and its queue depth are on
 * screen live, and "Reset budget" makes the tracker believe the next frame
 * outright — the same reset that returning to a hidden tab performs. If that
 * alone restores the frame rate at an unchanged pose, the loop is the cause.
 *
 * Every switch here is one the app already has, or the same field the app's
 * own URL kill switch writes; nothing is zeroed behind a subsystem's back, and
 * every one of them restores what it found rather than what it assumes.
 */

import { debugLog } from '../shared/debug';

/** One frame of the app's animation loop. */
export interface FrameSample {
  /** Wall clock at the rAF callback. */
  atMs: number;
  /** Main-thread ms between the two ends of the app's tick. */
  busyMs: number;
}

/** What a hold measured. */
export interface SweepRow {
  key: string;
  label: string;
  frames: number;
  fps: number;
  /** Milliseconds between delivered frames: 1000 / fps. */
  frameMs: number;
  /** frameMs against the first baseline's; negative means cheaper. */
  deltaMs: number;
  /** Median main-thread ms inside a frame. */
  busyMs: number;
  /** The smoothed interval the frame-sliced budgets were cut from. */
  intervalMs: number;
  /** Mean ms the warm pump spent per frame during the hold. */
  sliceMs: number;
}

/** Frames per second at or above which a configuration is running at rate. */
export const FULL_RATE_FPS = 50;
/** Busy share of a frame below which the main thread is idle most of it. */
export const IDLE_BUSY_SHARE = 0.5;
/** Baseline movement over which the ranking has drifted under the sweep. */
export const BASELINE_DRIFT = 0.15;

/** Middle value, or 0 for nothing. Median rather than mean: one collection
 *  pause inside a four-second window must not become the frame's cost. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Frame rate and main-thread cost over the samples at or after `fromMs`.
 *
 * The rate is the span between the first and last sample divided by the gaps
 * inside it — one fewer gap than there are samples — so a window that happens
 * to start and end on a frame is not credited with an extra one.
 */
export function summarizeFrames(samples: readonly FrameSample[], fromMs: number): {
  frames: number; fps: number; frameMs: number; busyMs: number;
} {
  const window = samples.filter((s) => s.atMs >= fromMs);
  const busyMs = median(window.map((s) => s.busyMs));
  if (window.length < 2) return { frames: window.length, fps: 0, frameMs: 0, busyMs };
  const spanMs = window[window.length - 1].atMs - window[0].atMs;
  const fps = spanMs > 0 ? ((window.length - 1) * 1000) / spanMs : 0;
  return { frames: window.length, fps, frameMs: fps > 0 ? 1000 / fps : 0, busyMs };
}

/**
 * What the control configuration says about everything above it.
 *
 * With every layer hidden, the synthesis off, the tiles off screen, no bloom,
 * no lens and half the pixels, there is almost nothing left for either
 * processor to do. A control still short of full rate on an idle main thread
 * is therefore not the app's cost at all.
 */
export function throttleVerdict(control: { fps: number; busyMs: number }): string {
  if (control.fps <= 0) return 'The control measured no frames.';
  const frameMs = 1000 / control.fps;
  if (control.fps >= FULL_RATE_FPS) {
    return `With everything off the app runs at ${control.fps.toFixed(0)} fps, so the rows above are real costs.`;
  }
  if (control.busyMs < frameMs * IDLE_BUSY_SHARE) {
    return `Frame rate capped from outside the app: with everything off the frames still arrive `
      + `${frameMs.toFixed(1)} ms apart while the app spends only ${control.busyMs.toFixed(1)} ms in them. `
      + `Read the rows above as a ranking, not as costs.`;
  }
  return `With everything off the app still spends ${control.busyMs.toFixed(1)} ms of a `
    + `${frameMs.toFixed(1)} ms frame, so the cost is in work this sweep cannot switch off.`;
}

/** A note when the two baselines disagree, or empty when they hold. */
export function baselineDriftNote(firstFps: number, lastFps: number): string {
  if (firstFps <= 0 || lastFps <= 0) return '';
  const drift = Math.abs(lastFps - firstFps) / firstFps;
  if (drift < BASELINE_DRIFT) return '';
  return `The baseline moved from ${firstFps.toFixed(0)} to ${lastFps.toFixed(0)} fps across the sweep — `
    + `the device changed under it, so treat the ranking as approximate.`;
}

/** What the frame-sliced work is budgeting itself against and taking. */
export interface FrameBudgetReadout {
  frameIntervalMs: number;
  reseeding: boolean;
  warm: { budgetMs: number; spentMs: number; queued: number };
  bake: { budgetMs: number; spentMs: number; stepsLeft: number; ageMs: number } | null;
  tiles: { resident: number; loading: number; inflight: number };
}

/** Everything the sweep switches, supplied by the owners of each piece. */
export interface PerfSweepDeps {
  ready: () => boolean;
  setSynthesis: (on: boolean | null) => void;
  setRoleHidden: (role: 'atmosphere' | 'clouds' | 'nightLights', hidden: boolean) => void;
  setSectorMeshes: (visible: boolean) => void;
  setChrome: (visible: boolean) => void;
  setShip: (visible: boolean) => void;
  shipVisible: () => boolean;
  budget: () => FrameBudgetReadout | null;
  resetBudget: () => void;
  /** The composer's passes, or null where this build has none of that pass. */
  passes: () => { bloom: { enabled: boolean } | null; lens: { enabled: boolean } | null };
  pinPixelRatio: (ratio: number | null) => void;
  pixelRatio: () => number;
  setFrameProbe: (probe: { start(): void; end(): void } | null) => void;
}

/** How long one configuration is held, and how much of the hold is thrown
 *  away: a switch changes what is uploaded and what fades, and the first
 *  second of a hold is that settling rather than the configuration. */
const HOLD_MS = 5000;
const SETTLE_MS = 1000;
/** How often the budget readout is sampled inside a hold, and how often the
 *  live line is rewritten — both slow enough to read and to cost nothing. */
const BUDGET_SAMPLE_MS = 100;
const LIVE_REFRESH_MS = 500;
/** Frames the live line averages over. */
const LIVE_FRAMES = 30;

/** One thing the sweep switches off and back on. `set(true)` applies it. */
interface Arm {
  key: string;
  label: string;
  available: () => boolean;
  set: (applied: boolean) => void;
}

function buildArms(deps: PerfSweepDeps): Arm[] {
  // The ship's own state is read on the way out and written back on the way
  // in: the chrome switch restores the user's own "show ship" choice, and a
  // sweep that assumed "on" would turn it back on for someone who had it off.
  let shipWas = true;
  let chromeShipWas = true;
  return [
    {
      key: 'synthesis',
      label: 'Synthesis off',
      available: () => true,
      set: (applied) => deps.setSynthesis(applied ? false : null),
    },
    {
      key: 'tiles',
      label: 'Sector tiles hidden',
      available: () => true,
      set: (applied) => deps.setSectorMeshes(!applied),
    },
    {
      key: 'atmosphere',
      label: 'Atmosphere hidden',
      available: () => true,
      set: (applied) => deps.setRoleHidden('atmosphere', applied),
    },
    {
      key: 'clouds',
      label: 'Clouds hidden',
      available: () => true,
      set: (applied) => deps.setRoleHidden('clouds', applied),
    },
    {
      key: 'night',
      label: 'Night lights hidden',
      available: () => true,
      set: (applied) => deps.setRoleHidden('nightLights', applied),
    },
    {
      key: 'bloom',
      label: 'Bloom off',
      available: () => deps.passes().bloom !== null,
      set: (applied) => {
        // The pass is skipped, not removed: rebuilding the composer would
        // relink every program inside the hold that is being measured.
        const bloom = deps.passes().bloom;
        if (bloom) bloom.enabled = !applied;
      },
    },
    {
      key: 'lens',
      label: 'Lens off',
      available: () => deps.passes().lens !== null,
      set: (applied) => {
        // Skipping the lens pass leaves off-axis discs egg-shaped and the DOM
        // overlays pre-distorted for the hold, which is a look, not a break;
        // rebuilding the chain to avoid that would cost a relink instead.
        const lens = deps.passes().lens;
        if (lens) lens.enabled = !applied;
      },
    },
    {
      key: 'halfres',
      label: 'Half resolution',
      available: () => true,
      set: (applied) => deps.pinPixelRatio(applied ? 1 : null),
    },
    {
      key: 'ship',
      label: 'Ship hidden',
      available: () => true,
      set: (applied) => {
        if (applied) {
          shipWas = deps.shipVisible();
          deps.setShip(false);
        } else {
          deps.setShip(shipWas);
        }
      },
    },
    {
      // Applied last in the control and so restored first: bringing the chrome
      // back shows the ship, and the ship switch above then puts back what it
      // found.
      key: 'chrome',
      label: 'Labels and HUD hidden',
      available: () => true,
      set: (applied) => {
        if (applied) {
          chromeShipWas = deps.shipVisible();
          deps.setChrome(false);
        } else {
          deps.setChrome(true);
          deps.setShip(chromeShipWas);
        }
      },
    },
  ];
}

/** Wall-clock wait that runs on animation frames, so a throttled page waits
 *  the same wall time rather than the same number of frames. */
function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const tick = (): void => {
      if (performance.now() - startedAt >= ms) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function fmt(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '–';
}

const PANEL_CSS = `
#perf-sweep {
  position: fixed; top: 52px; left: 8px; right: 8px; z-index: 90;
  max-height: 66vh; display: flex; flex-direction: column;
  padding: 10px 12px 12px; border-radius: 12px;
  background: rgba(8, 10, 15, 0.92); border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  color: var(--t1, #eef1f7); font-family: var(--font-ui, system-ui, sans-serif);
  font-size: 12px; pointer-events: auto; -webkit-user-select: none; user-select: none;
}
/* Folded keeps the live line: watching the frame rate is the whole reason to
   fold the table away and look at the scene. */
#perf-sweep.folded { max-height: none; }
#perf-sweep.folded .ps-body { display: none; }
#perf-sweep .ps-head { display: flex; align-items: center; gap: 8px; }
#perf-sweep .ps-title { flex: 1; font-weight: 600; letter-spacing: 0.02em; }
#perf-sweep button {
  font-family: inherit; font-size: 12px; color: var(--t1, #eef1f7);
  background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px; padding: 6px 10px; cursor: pointer;
}
#perf-sweep button:active { background: rgba(255, 255, 255, 0.12); }
#perf-sweep button[disabled] { opacity: 0.45; }
#perf-sweep button.ps-go { color: var(--accent, #5e8bff); border-color: rgba(94, 139, 255, 0.5); }
#perf-sweep .ps-body { margin-top: 4px; overflow-y: auto; }
#perf-sweep .ps-live { margin-top: 6px; }
#perf-sweep .ps-live, #perf-sweep .ps-budget {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;
  font-variant-numeric: tabular-nums; color: var(--t2, #9aa4b8); line-height: 1.5;
}
#perf-sweep .ps-live b { color: var(--t1, #eef1f7); font-weight: 600; }
#perf-sweep .ps-actions { display: flex; gap: 8px; margin: 8px 0 4px; }
#perf-sweep .ps-status { margin: 6px 0 2px; color: var(--accent, #5e8bff); font-size: 11.5px; }
#perf-sweep .ps-scroll { overflow-x: auto; margin-top: 6px; }
#perf-sweep table { border-collapse: collapse; width: 100%; min-width: 380px; }
#perf-sweep th, #perf-sweep td {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px;
  font-variant-numeric: tabular-nums; text-align: right; padding: 3px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07); white-space: nowrap;
}
#perf-sweep th { color: var(--t2, #9aa4b8); font-weight: 500; }
#perf-sweep td.ps-name, #perf-sweep th.ps-name { text-align: left; white-space: normal; }
#perf-sweep tr.ps-control td { color: var(--accent, #5e8bff); }
#perf-sweep .ps-note { margin-top: 8px; font-size: 11.5px; line-height: 1.45; color: var(--t1, #eef1f7); }
#perf-sweep .ps-legend { margin-top: 6px; font-size: 10.5px; line-height: 1.45; color: var(--t2, #9aa4b8); }
`;

const PANEL_HTML = `
<div class="ps-head">
  <span class="ps-title">Perf sweep</span>
  <button type="button" class="ps-fold">Hide</button>
</div>
<div class="ps-live"></div>
<div class="ps-budget"></div>
<div class="ps-body">
  <div class="ps-actions">
    <button type="button" class="ps-go">Sweep</button>
    <button type="button" class="ps-reset">Reset budget</button>
  </div>
  <div class="ps-status"></div>
  <div class="ps-scroll"></div>
  <div class="ps-note"></div>
</div>
`;

/**
 * Build the overlay, install the frame probe, and wait to be told to sweep.
 * Called once, from the DEV `?perf=1` branch in main.ts.
 */
export function installPerfSweep(deps: PerfSweepDeps): void {
  if (document.getElementById('perf-sweep')) return;

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'perf-sweep';
  panel.innerHTML = PANEL_HTML;
  document.body.appendChild(panel);

  const liveEl = panel.querySelector('.ps-live') as HTMLElement;
  const budgetEl = panel.querySelector('.ps-budget') as HTMLElement;
  const statusEl = panel.querySelector('.ps-status') as HTMLElement;
  const scrollEl = panel.querySelector('.ps-scroll') as HTMLElement;
  const noteEl = panel.querySelector('.ps-note') as HTMLElement;
  const goBtn = panel.querySelector('.ps-go') as HTMLButtonElement;
  const resetBtn = panel.querySelector('.ps-reset') as HTMLButtonElement;
  const foldBtn = panel.querySelector('.ps-fold') as HTMLButtonElement;

  // The frame probe is the one measuring instrument: it feeds the live line
  // always, and a hold's sample list while one is running.
  const live: FrameSample[] = [];
  let recording: FrameSample[] | null = null;
  let sweeping = false;
  let wentHidden = false;
  let frameStartedAt = 0;
  let liveWrittenAt = 0;

  // A page that was not being shown got frames from a throttle, not a display,
  // and nothing measured across that says anything about the pose.
  document.addEventListener('visibilitychange', () => {
    if (sweeping && document.visibilityState !== 'visible') wentHidden = true;
  });

  deps.setFrameProbe({
    start: () => { frameStartedAt = performance.now(); },
    end: () => {
      const sample: FrameSample = { atMs: frameStartedAt, busyMs: performance.now() - frameStartedAt };
      live.push(sample);
      if (live.length > LIVE_FRAMES) live.shift();
      recording?.push(sample);
      if (sample.atMs - liveWrittenAt >= LIVE_REFRESH_MS) {
        liveWrittenAt = sample.atMs;
        writeLive();
      }
    },
  });

  function writeLive(): void {
    const summary = summarizeFrames(live, 0);
    liveEl.innerHTML = summary.fps > 0
      ? `<b>${summary.fps.toFixed(0)} fps</b> · ${summary.frameMs.toFixed(1)} ms apart · busy <b>${summary.busyMs.toFixed(1)} ms</b>`
      : 'waiting for frames';
    const budget = deps.budget();
    if (!budget) {
      budgetEl.textContent = '';
      return;
    }
    const bake = budget.bake && budget.bake.ageMs < 2000
      ? ` · bake ${budget.bake.spentMs.toFixed(1)}/${budget.bake.budgetMs.toFixed(1)} (${budget.bake.stepsLeft} left)`
      : '';
    budgetEl.textContent =
      `interval ${budget.frameIntervalMs.toFixed(1)} ms`
      + ` · warm ${budget.warm.spentMs.toFixed(1)}/${budget.warm.budgetMs.toFixed(1)} (${budget.warm.queued} queued)`
      + bake
      + ` · tiles ${budget.tiles.resident} up, ${budget.tiles.inflight} in flight`;
  }

  foldBtn.addEventListener('click', () => {
    const folded = panel.classList.toggle('folded');
    foldBtn.textContent = folded ? 'Show' : 'Hide';
  });

  resetBtn.addEventListener('click', () => {
    deps.resetBudget();
    statusEl.textContent = 'Budget reset — the next frame is believed outright.';
  });

  goBtn.addEventListener('click', () => { void runSweep(); });

  function renderTable(rows: SweepRow[]): void {
    const body = rows.map((row) => `
      <tr class="${row.key === 'control' ? 'ps-control' : ''}">
        <td class="ps-name">${row.label}</td>
        <td>${fmt(row.fps, 0)}</td>
        <td>${fmt(row.frameMs)}</td>
        <td>${row.key === 'baseline' ? '–' : fmt(row.deltaMs)}</td>
        <td>${fmt(row.busyMs)}</td>
        <td>${fmt(row.intervalMs)}</td>
        <td>${fmt(row.sliceMs, 2)}</td>
      </tr>`).join('');
    scrollEl.innerHTML = `
      <table>
        <thead><tr>
          <th class="ps-name">Config</th><th>fps</th><th>ms</th><th>Δms</th>
          <th>busy</th><th>int</th><th>slice</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="ps-legend">
        ms = gap between frames · busy = main thread inside a frame ·
        int = the smoothed interval the frame-sliced work budgets against ·
        slice = warm-pump spend per frame
      </div>`;
  }

  /** Hold one configuration and measure the tail of the hold. */
  async function measure(key: string, label: string): Promise<SweepRow> {
    const startedAt = performance.now();
    recording = [];
    const intervals: number[] = [];
    const slices: number[] = [];
    let sampledAt = 0;
    const sampleBudget = (): void => {
      const now = performance.now();
      if (now - sampledAt < BUDGET_SAMPLE_MS) return;
      sampledAt = now;
      if (now - startedAt < SETTLE_MS) return;
      const budget = deps.budget();
      if (!budget) return;
      intervals.push(budget.frameIntervalMs);
      slices.push(budget.warm.spentMs);
    };
    const pump = (): void => {
      sampleBudget();
      if (recording) requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    await waitMs(HOLD_MS);
    const samples = recording;
    recording = null;
    const summary = summarizeFrames(samples, startedAt + SETTLE_MS);
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      key,
      label,
      frames: summary.frames,
      fps: summary.fps,
      frameMs: summary.frameMs,
      deltaMs: 0,
      busyMs: summary.busyMs,
      intervalMs: mean(intervals),
      sliceMs: mean(slices),
    };
  }

  async function runSweep(): Promise<void> {
    if (sweeping) return;
    if (!deps.ready()) {
      statusEl.textContent = 'The scene is still loading.';
      return;
    }
    sweeping = true;
    wentHidden = false;
    goBtn.disabled = true;
    resetBtn.disabled = true;
    noteEl.textContent = '';
    scrollEl.innerHTML = '';

    const arms = buildArms(deps).filter((arm) => arm.available());
    const total = arms.length + 3; // both baselines and the control
    const rows: SweepRow[] = [];
    let step = 0;
    const announce = (label: string): void => {
      step += 1;
      statusEl.textContent = `Measuring ${label} — ${step} of ${total}`;
    };

    try {
      announce('Baseline');
      rows.push(await measure('baseline', 'Baseline'));

      for (const arm of arms) {
        announce(arm.label);
        arm.set(true);
        try {
          rows.push(await measure(arm.key, arm.label));
        } finally {
          arm.set(false);
        }
      }

      // Everything at once. Applied in order and unwound in reverse, so a
      // switch that writes state another switch also writes puts it back in
      // the order it was taken.
      announce('Everything off');
      const applied: Arm[] = [];
      try {
        for (const arm of arms) {
          arm.set(true);
          applied.push(arm);
        }
        rows.push(await measure('control', 'Everything off'));
      } finally {
        for (let i = applied.length - 1; i >= 0; i--) applied[i].set(false);
      }

      announce('Baseline again');
      rows.push(await measure('baseline-last', 'Baseline again'));
    } finally {
      sweeping = false;
      goBtn.disabled = false;
      resetBtn.disabled = false;
    }

    const baseMs = rows[0].frameMs;
    for (const row of rows) row.deltaMs = baseMs > 0 && row.frameMs > 0 ? row.frameMs - baseMs : 0;
    renderTable(rows);

    const control = rows.find((r) => r.key === 'control');
    const last = rows.find((r) => r.key === 'baseline-last');
    const verdict = control ? throttleVerdict(control) : '';
    const drift = last ? baselineDriftNote(rows[0].fps, last.fps) : '';
    const hiddenNote = wentHidden
      ? 'The page stopped being shown during the sweep, so these numbers are not the pose\u2019s. Run it again.'
      : '';
    noteEl.textContent = [hiddenNote, verdict, drift].filter(Boolean).join(' ');
    statusEl.textContent = 'Done.';

    const results = {
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      renderPixelRatio: deps.pixelRatio(),
      verdict,
      drift,
      rows,
    };
    const bridge = ((window as unknown as Record<string, Record<string, unknown>>).__moon ??= {});
    bridge.perfSweep = results;
    // The overlay is the only console a phone has without a cable, and the
    // same table has to survive a look at `?debug=1` afterwards.
    debugLog('Perf sweep', `${results.viewport} dpr ${results.devicePixelRatio}`);
    for (const row of rows) {
      debugLog(
        `Perf sweep ${row.label}`,
        `${row.fps.toFixed(1)} fps, ${row.frameMs.toFixed(1)} ms, `
        + `${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs.toFixed(1)} ms vs baseline, `
        + `busy ${row.busyMs.toFixed(1)} ms, interval ${row.intervalMs.toFixed(1)} ms, `
        + `slice ${row.sliceMs.toFixed(2)} ms`,
      );
    }
    debugLog('Perf sweep verdict', noteEl.textContent);
  }

  writeLive();
}
