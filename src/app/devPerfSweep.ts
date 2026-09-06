/**
 * On-device perf sweep (`?perf=1`) — DEV only, loaded on demand.
 *
 * A phone cannot be profiled from a Mac: the same frame costs different money
 * on different silicon, so the ranking of what a frame is spent on has to be
 * measured where the frame is slow. This is that measurement, driven from the
 * screen: park at the pose that is slow, tap Sweep, and each configuration is
 * applied on its own, held, measured, and put back exactly as it was found.
 *
 * Three numbers per configuration, and they answer different questions:
 *
 *  - **fps** is how far apart the frames arrive — rAF callbacks counted
 *    against the wall clock, never the app's own dt and never the rAF
 *    timestamp (after a busy main thread that timestamp is the frame the
 *    browser meant to start, not the one that ran).
 *  - **busy** is how much of each frame the app spends on the main thread:
 *    both ends of the animation loop's own tick.
 *  - **off** is the rest of the frame — the GPU, the compositor, or a cap.
 *    Work submitted inside `busy` is paid here.
 *
 * **The device heats under the measurement.** A phone measured for a minute is
 * not the same phone at the end of it: an early run read the baseline at 54 fps
 * and, two dozen holds later, 44 — with rows in between that hiding the
 * spacecraft appeared to cost 30 ms. A sweep that measures each configuration
 * once, in a fixed order, ranks the order rather than the configurations. So
 * this one:
 *
 *  - **brackets every configuration with a baseline** — A B A C A D — and
 *    reports each one against the MEAN of the two baselines either side of it,
 *    so a device sliding under the run subtracts out;
 *  - **shuffles the order every run**, and prints it, so a residual slide
 *    cannot land on the same configuration twice;
 *  - **holds three seconds** rather than five, first second discarded, because
 *    the total wall time IS the heat;
 *  - **prints every baseline in sequence** as a thermal-drift line, so how far
 *    the device moved is on screen beside what it is being asked to explain.
 *
 * It still ends on a CONTROL that switches everything off at once. If that
 * reads half rate on an idle main thread, the page is being paced from outside
 * — which iOS does under thermal and background pressure — and the table says
 * so in words rather than letting the rows be read as costs they are not.
 *
 * The fourth readout is the frame-sliced work. The texture warm pump and the
 * atmosphere bake each take a share of a smoothed frame interval, so a scene
 * that makes frames long licences longer slices, which keeps the frames long:
 * the interval, each consumer's budget, its spend and its queue depth are on
 * screen live, and "Reset budget" makes the tracker believe the next frame
 * outright — the same reset that returning to a hidden tab performs.
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

/** What one hold measured. */
export interface SweepRow {
  key: string;
  label: string;
  frames: number;
  fps: number;
  /** Milliseconds between delivered frames: 1000 / fps. */
  frameMs: number;
  /** Median main-thread ms inside a frame. */
  busyMs: number;
  /** frameMs minus busyMs: the part of a frame the main thread did not hold. */
  offMainMs: number;
  /** frameMs against the mean of the two baselines either side; negative means
   *  cheaper. Zero on the baselines themselves. */
  deltaMs: number;
}

/** Frames per second at or above which a configuration is running at rate. */
export const FULL_RATE_FPS = 50;
/** Busy share of a frame below which the main thread is idle most of it. */
export const IDLE_BUSY_SHARE = 0.5;
/** Baseline movement across a run over which the device changed under it. */
export const THERMAL_DRIFT = 0.1;

/** Middle value, or 0 for nothing. Median rather than mean: one collection
 *  pause inside a measured window must not become the frame's cost. */
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
  frames: number; fps: number; frameMs: number; busyMs: number; offMainMs: number;
} {
  const window = samples.filter((s) => s.atMs >= fromMs);
  const busyMs = median(window.map((s) => s.busyMs));
  if (window.length < 2) return { frames: window.length, fps: 0, frameMs: 0, busyMs, offMainMs: 0 };
  const spanMs = window[window.length - 1].atMs - window[0].atMs;
  const fps = spanMs > 0 ? ((window.length - 1) * 1000) / spanMs : 0;
  const frameMs = fps > 0 ? 1000 / fps : 0;
  return { frames: window.length, fps, frameMs, busyMs, offMainMs: Math.max(0, frameMs - busyMs) };
}

/**
 * The frame time a configuration is charged against: the mean of the baseline
 * before it and the baseline after it.
 *
 * Averaging the pair is what makes the number survive a device that is sliding
 * under the run — the slide between two baselines three seconds apart is small,
 * and the configuration between them sits at their midpoint whatever the level
 * has drifted to. A missing or unmeasured neighbour falls back to the other.
 */
export function bracketFrameMs(
  before: { frameMs: number } | undefined,
  after: { frameMs: number } | undefined,
): number {
  const pair = [before?.frameMs, after?.frameMs].filter((v): v is number => typeof v === 'number' && v > 0);
  if (pair.length === 0) return 0;
  return pair.reduce((a, b) => a + b, 0) / pair.length;
}

/** A permutation of `items`, drawn with `rng` (Fisher–Yates). The order is
 *  redrawn every run so a device that keeps sliding cannot charge the same
 *  configuration for it twice. */
export function shuffled<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every baseline of the run in the order it was taken, and how far the device
 *  moved between the first and the worst. Empty when it held. */
export function thermalDriftLine(baselines: readonly { fps: number }[]): string {
  if (baselines.length < 2) return '';
  const sequence = baselines.map((b) => b.fps.toFixed(0)).join(' → ');
  const first = baselines[0].fps;
  const lowest = Math.min(...baselines.map((b) => b.fps));
  if (first <= 0) return `Baselines: ${sequence} fps.`;
  const fall = (first - lowest) / first;
  if (fall < THERMAL_DRIFT) return `Baselines: ${sequence} fps — steady.`;
  return `Baselines: ${sequence} fps — the device lost ${(fall * 100).toFixed(0)}% under the run, `
    + `so read each row against its own two baselines, not against the first.`;
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
  /** Every surface a frame is drawn into, in device pixels — the evidence that
   *  a resolution switch really moved the pixels. */
  renderTargets: () => unknown;
  setFrameProbe: (probe: { start(): void; end(): void } | null) => void;
}

/**
 * How long a configuration is held and how much of the hold is thrown away.
 *
 * Three seconds, not five: the wall time of the whole run is what heats the
 * device, and every second of it degrades the rows still to come. The first
 * second is the switch settling — the synthesis term eases over a quarter of a
 * second, a resize reallocates targets — so two seconds are measured, which at
 * 30 fps is sixty frames.
 */
const HOLD_MS = 3000;
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

/**
 * The switches the sweep offers as rows.
 *
 * The spacecraft and the HUD are not among them. Both were measured and both
 * are far too small to see through the noise of a device that is heating —
 * hiding the ship read 30 ms once, which is the run's drift, not a spacecraft.
 * They are still switched for the CONTROL, where the question is whether an
 * empty frame runs at rate rather than what one model costs.
 */
function buildArms(deps: PerfSweepDeps): Arm[] {
  return [
    {
      key: 'tiles',
      label: 'Sector tiles hidden',
      available: () => true,
      set: (applied) => deps.setSectorMeshes(!applied),
    },
    {
      key: 'clouds',
      label: 'Clouds hidden',
      available: () => true,
      set: (applied) => deps.setRoleHidden('clouds', applied),
    },
    {
      key: 'atmosphere',
      label: 'Atmosphere hidden',
      available: () => true,
      set: (applied) => deps.setRoleHidden('atmosphere', applied),
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
      // Through the app's own resize path, so the composer's scene target and
      // its partner are reallocated at the new ratio. A switch that moved the
      // renderer's ratio alone would leave the frame drawn into the same
      // pixels and report that they were free. (The bloom chain keeps its own
      // ratio by design, so this arm halves everything but the glow.)
      set: (applied) => deps.pinPixelRatio(applied ? 1 : null),
    },
    {
      key: 'synthesis',
      label: 'Synthesis off',
      available: () => true,
      set: (applied) => deps.setSynthesis(applied ? false : null),
    },
  ];
}

/** The control: every row's switch at once, plus the spacecraft and the HUD,
 *  so what is left is as close to an empty frame as the app can show. Applied
 *  in order and unwound in reverse, and the ship's own state is read on the
 *  way out and written back on the way in — the chrome switch restores the
 *  user's own "show ship" choice, and a sweep that assumed "on" would turn it
 *  back on for someone who had it off. */
function buildControl(deps: PerfSweepDeps, arms: readonly Arm[]): Arm {
  let shipWas = true;
  return {
    key: 'control',
    label: 'Everything off',
    available: () => true,
    set: (applied) => {
      if (applied) {
        for (const arm of arms) arm.set(true);
        shipWas = deps.shipVisible();
        deps.setChrome(false);
      } else {
        deps.setChrome(true);
        deps.setShip(shipWas);
        for (let i = arms.length - 1; i >= 0; i--) arms[i].set(false);
      }
    },
  };
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
      ? `<b>${summary.fps.toFixed(0)} fps</b> · ${summary.frameMs.toFixed(1)} ms apart`
        + ` · busy <b>${summary.busyMs.toFixed(1)} ms</b>`
        + ` · <b>${summary.offMainMs.toFixed(1)} ms</b> not on main thread`
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

  function renderTable(rows: readonly SweepRow[]): void {
    const body = rows.map((row) => `
      <tr class="${row.key === 'control' ? 'ps-control' : ''}">
        <td class="ps-name">${row.label}</td>
        <td>${fmt(row.fps, 0)}</td>
        <td>${fmt(row.frameMs)}</td>
        <td>${fmt(row.deltaMs)}</td>
        <td>${fmt(row.busyMs)}</td>
        <td>${fmt(row.offMainMs)}</td>
      </tr>`).join('');
    scrollEl.innerHTML = `
      <table>
        <thead><tr>
          <th class="ps-name">Config</th><th>fps</th><th>ms</th><th>Δms</th>
          <th>busy</th><th>off</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="ps-legend">
        ms = gap between frames · Δms = against the mean of the baselines either side ·
        busy = main thread inside a frame · off = the rest of the frame, not on the main thread
      </div>`;
  }

  /** Hold one configuration and measure the tail of the hold. */
  async function measure(key: string, label: string): Promise<SweepRow> {
    const startedAt = performance.now();
    recording = [];
    await waitMs(HOLD_MS);
    const samples = recording;
    recording = null;
    const summary = summarizeFrames(samples, startedAt + SETTLE_MS);
    return {
      key,
      label,
      frames: summary.frames,
      fps: summary.fps,
      frameMs: summary.frameMs,
      busyMs: summary.busyMs,
      offMainMs: summary.offMainMs,
      deltaMs: 0,
    };
  }

  /** The frame-sliced budget through one hold, sampled rather than read once:
   *  the pump's spend is a per-frame figure and the last frame's is noise. */
  function budgetWatcher(): { stop: () => { intervalMs: number; sliceMs: number } } {
    const startedAt = performance.now();
    const intervals: number[] = [];
    const slices: number[] = [];
    let running = true;
    let sampledAt = 0;
    const tick = (): void => {
      if (!running) return;
      const now = performance.now();
      if (now - sampledAt >= BUDGET_SAMPLE_MS && now - startedAt >= SETTLE_MS) {
        sampledAt = now;
        const budget = deps.budget();
        if (budget) {
          intervals.push(budget.frameIntervalMs);
          slices.push(budget.warm.spentMs);
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return { stop: () => { running = false; return { intervalMs: mean(intervals), sliceMs: mean(slices) }; } };
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

    const singles = buildArms(deps).filter((arm) => arm.available());
    // The control switches every row's arm plus the ship and the HUD, and is
    // shuffled in among the rest: it is a configuration like any other, and
    // putting it last would charge it with the whole run's drift.
    const order = shuffled([...singles, buildControl(deps, singles)]);
    const total = order.length * 2 + 1; // a baseline before and after every one
    const rows: SweepRow[] = [];
    const baselines: SweepRow[] = [];
    let budgetMs = { intervalMs: 0, sliceMs: 0 };
    let step = 0;
    const announce = (label: string): void => {
      step += 1;
      statusEl.textContent = `Measuring ${label} — ${step} of ${total}`;
    };
    const hold = async (key: string, label: string): Promise<SweepRow> => {
      const watcher = budgetWatcher();
      try {
        return await measure(key, label);
      } finally {
        budgetMs = watcher.stop();
      }
    };

    try {
      announce('Baseline');
      baselines.push(await hold('baseline', 'Baseline'));

      for (const arm of order) {
        announce(arm.label);
        arm.set(true);
        try {
          rows.push(await hold(arm.key, arm.label));
        } finally {
          arm.set(false);
        }
        announce('Baseline');
        baselines.push(await hold('baseline', 'Baseline'));
      }
    } finally {
      sweeping = false;
      goBtn.disabled = false;
      resetBtn.disabled = false;
    }

    // Row i sat between baseline i and baseline i+1.
    for (let i = 0; i < rows.length; i++) {
      const bracket = bracketFrameMs(baselines[i], baselines[i + 1]);
      rows[i].deltaMs = bracket > 0 && rows[i].frameMs > 0 ? rows[i].frameMs - bracket : 0;
    }
    renderTable(rows);

    const control = rows.find((r) => r.key === 'control');
    const verdict = control ? throttleVerdict(control) : '';
    const drift = thermalDriftLine(baselines);
    const hiddenNote = wentHidden
      ? 'The page stopped being shown during the sweep, so these numbers are not the pose’s. Run it again.'
      : '';
    const orderNote = `Order this run: ${order.map((a) => a.label).join(', ')}.`;
    noteEl.textContent = [hiddenNote, verdict, drift, orderNote].filter(Boolean).join(' ');
    statusEl.textContent = 'Done.';

    const results = {
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      renderPixelRatio: deps.pixelRatio(),
      holdMs: HOLD_MS,
      settleMs: SETTLE_MS,
      order: order.map((a) => a.key),
      verdict,
      drift,
      wentHidden,
      rows,
      baselines,
      // The last hold's frame-sliced spend. Kept because a dead budget loop is
      // itself a finding, and a live one would show here first.
      budget: budgetMs,
    };
    const bridge = ((window as unknown as Record<string, Record<string, unknown>>).__moon ??= {});
    bridge.perfSweep = results;
    // The overlay is the only console a phone has without a cable, and the
    // same table has to survive a look at `?debug=1` afterwards.
    debugLog('Perf sweep', `${results.viewport} dpr ${results.devicePixelRatio} · ${orderNote}`);
    for (const row of rows) {
      debugLog(
        `Perf sweep ${row.label}`,
        `${row.fps.toFixed(1)} fps, ${row.frameMs.toFixed(1)} ms, `
        + `${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs.toFixed(1)} ms vs its baselines, `
        + `busy ${row.busyMs.toFixed(1)} ms, off main ${row.offMainMs.toFixed(1)} ms`,
      );
    }
    debugLog('Perf sweep drift', drift);
    debugLog('Perf sweep verdict', verdict);
  }

  // Harness seams: apply or restore one switch by name, and read the surfaces a
  // frame is drawn into. A resolution switch is only believable if the targets
  // moved, and that is a size to be read, not a timing to be inferred.
  const armIndex = new Map<string, Arm>();
  {
    const singles = buildArms(deps);
    for (const arm of singles) armIndex.set(arm.key, arm);
    const control = buildControl(deps, singles);
    armIndex.set(control.key, control);
  }
  const bridge = ((window as unknown as Record<string, Record<string, unknown>>).__moon ??= {});
  bridge.perfArm = (key: string, applied: boolean): boolean => {
    const arm = armIndex.get(key);
    if (!arm) return false;
    arm.set(applied);
    return true;
  };
  bridge.perfTargets = () => deps.renderTargets();

  writeLive();
}
