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
 * **A row that sits at the cap cannot be ranked.** The device this exists for
 * caps rAF at 60 and idles near it, so a change worth 2–4 ms of GPU time reads
 * 60 fps with and without it. So the sweep pins the render ratio to 3 for its
 * own duration — one device pixel per texel on that screen — which puts every
 * configuration below the cap, where a saving has somewhere to show. The
 * milliseconds are then ratio-3 milliseconds and the table says so. The bloom
 * chain deliberately sizes from the display's own ratio rather than the pin
 * (app/renderResolution.ts keeps the glow's width), so the bloom rows are read
 * at their true size either way.
 *
 * **The device heats under the measurement.** A phone measured for a minute is
 * not the same phone at the end of it: an early run read the baseline at 54 fps
 * and, two dozen holds later, 44 — with rows in between that hiding the
 * spacecraft appeared to cost 30 ms. A sweep that measures each configuration
 * once, in a fixed order, ranks the order rather than the configurations. So
 * the default run is **paired**:
 *
 *  - each candidate gets blocks of **A B B A** — baseline, candidate held
 *    across two windows, baseline — so a device sliding steadily under the run
 *    subtracts out of both pairings inside the block;
 *  - **two blocks per candidate**, giving four pairings, and the row reports
 *    the MEDIAN of them with the spread beside it: a wide spread means the
 *    device moved more than the configuration did, and the median is the
 *    honest number;
 *  - **candidates are shuffled** every run and the order printed, so a
 *    residual slide cannot land on the same one twice;
 *  - the **all-off control sits outside the blocks**, bracketed by its own two
 *    baselines — it is a verdict about the cap, not a ranked cost;
 *  - **every baseline is printed in sequence** as a thermal-drift line, so how
 *    far the device moved is on screen beside what it is being asked to
 *    explain.
 *
 * The run is also **frozen**: the clock rate goes to 0 for its duration and is
 * put back afterwards, and the sweep waits for the sector tiles to stop
 * arriving before the first hold (or says in the verdict that it started
 * anyway, and how many were still in flight). The pose is never moved — the
 * ride frame holds it — and the verdict names the pose that was measured,
 * because an early-out that skips work where a term is exactly zero is priced
 * by the coverage under the camera: a daylight run cannot say what the night
 * shell's early-out saves on the night side.
 *
 * The control still switches everything off at once. If that reads half rate
 * on an idle main thread, the page is being paced from outside — which iOS
 * does under thermal and background pressure — and the table says so in words
 * rather than letting the rows be read as costs they are not.
 *
 * Three runs are offered:
 *
 *  - **Sweep** — the paired run above. Minutes, and the ranking it gives is
 *    the one to act on.
 *  - **Quick** — one bracketed pass, A B A C A D, three-second holds: the
 *    short look that says whether anything is grossly wrong.
 *  - **Soak** — five minutes of the baseline, logged every ten seconds. Short
 *    cool measurements cannot say whether a saving survives a sustained run,
 *    and this is what a sustained run looks like on that device.
 *
 * The fourth readout is the frame-sliced work. The texture warm pump and the
 * atmosphere bake each take a share of a smoothed frame interval, so a scene
 * that makes frames long licences longer slices, which keeps the frames long:
 * the interval, each consumer's budget, its spend and its queue depth are on
 * screen live, and "Reset budget" makes the tracker believe the next frame
 * outright — the same reset that returning to a hidden tab performs.
 *
 * **Other modules add rows to this sweep without this file knowing them.** A
 * subsystem shipping efficiency switches publishes them on the dev bridge —
 * `__moon.perfSwitches()` says which keys exist and where each stands, and
 * `__moon.perfArm(key, on)` moves one — and the sweep enumerates that when a
 * run starts, so a switch that landed after this file was written is swept
 * anyway. (`__moon.perfRegister(key, { set, label })` is the same door for
 * something with no registry of its own.) For a switch found ON the CANDIDATE
 * is that switch turned OFF, so its row reads as the cost the switch removes
 * and its label says so; a switch found off is measured the other way round.
 * Every switch that is exact and ships on is also measured TOGETHER as one
 * row: savings that overlap do not add, and the combined row is the only
 * honest total.
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

/** What one configuration measured. */
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
  /** Against the baselines it was paired with; negative means cheaper. In the
   *  paired run this is the median of the pairings, in the quick run the single
   *  bracketed delta. Zero on the baselines themselves. */
  deltaMs: number;
  /** Paired run: how far the pairings disagreed (widest minus narrowest). */
  spreadMs?: number;
  /** Paired run: every pairing's delta, in the order they were taken. */
  deltas?: number[];
}

/** Frames per second at or above which a configuration is running at rate. */
export const FULL_RATE_FPS = 50;
/** Busy share of a frame below which the main thread is idle most of it. */
export const IDLE_BUSY_SHARE = 0.5;
/** Baseline movement across a run over which the device changed under it. */
export const THERMAL_DRIFT = 0.1;
/** Sun elevation inside which the sub-camera point is neither day nor night. */
export const TERMINATOR_DEG = 10;

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

/**
 * One candidate's four pairings reduced to a number and a doubt.
 *
 * The median is the row's delta: with a device sliding under the run, one
 * pairing catching a thermal step must not become the configuration's cost.
 * The spread is what the run could not hold still — a candidate whose spread
 * is wider than its median measured the device, not the switch, and the table
 * puts the two side by side so that is visible rather than inferred.
 */
export function pairedDelta(deltas: readonly number[]): { deltaMs: number; spreadMs: number } {
  const usable = deltas.filter((d) => Number.isFinite(d));
  if (usable.length === 0) return { deltaMs: 0, spreadMs: 0 };
  return { deltaMs: median(usable), spreadMs: Math.max(...usable) - Math.min(...usable) };
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

/** A point in the scene's heliocentric AU frame. */
export interface Vec3 { x: number; y: number; z: number }

/**
 * How high the Sun stands over the point of `bodyAbs` directly under the
 * camera, in degrees; negative is night.
 *
 * The Sun sits at the scene's origin, so a body's sunward direction is its own
 * position negated (the same derivation `computeBodyStateInto` uses for every
 * lighting uniform), and the local up at the sub-camera point is the direction
 * from the body's centre to the camera. Null when either vector is degenerate
 * — a camera at a body's exact centre has no sub-camera point.
 */
export function sunElevationDeg(bodyAbs: Vec3, camAbs: Vec3): number | null {
  const ux = camAbs.x - bodyAbs.x;
  const uy = camAbs.y - bodyAbs.y;
  const uz = camAbs.z - bodyAbs.z;
  const uLen = Math.hypot(ux, uy, uz);
  const sLen = Math.hypot(bodyAbs.x, bodyAbs.y, bodyAbs.z);
  if (uLen <= 0 || sLen <= 0) return null;
  // Sun direction from the body is −bodyAbs; the dot with the local up is the
  // sine of the elevation.
  const dot = (ux * -bodyAbs.x + uy * -bodyAbs.y + uz * -bodyAbs.z) / (uLen * sLen);
  return (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Day, night, or the band between them where a coverage-gated term is partly
 *  on. Ten degrees either side of the horizon: inside that the night mix and
 *  the cloud lighting are both mid-transition, which is neither case. */
export function poseLabel(elevDeg: number): 'daylight pose' | 'terminator' | 'night pose' {
  if (elevDeg > TERMINATOR_DEG) return 'daylight pose';
  if (elevDeg < -TERMINATOR_DEG) return 'night pose';
  return 'terminator';
}

/**
 * Which pose the run priced, in words for the verdict.
 *
 * An early-out that returns before the work when a term is exactly zero saves
 * nothing where the term is not zero. Whether the sub-camera point was lit
 * therefore decides which rows the run can speak for, and that has to be on
 * the screen beside the numbers rather than remembered afterwards.
 */
export function poseNote(body: string | null, elevDeg: number | null): string {
  if (!body || elevDeg === null) {
    return 'The pose could not be read, so which side of the terminator these rows priced is unknown.';
  }
  const label = poseLabel(elevDeg);
  const height = elevDeg >= 0
    ? `${elevDeg.toFixed(0)}° above the horizon`
    : `${(-elevDeg).toFixed(0)}° below the horizon`;
  const caveat = label === 'daylight pose'
    ? 'The night and clear-sky early-outs skip work only where their term is zero, so this run does not price what they save over the night side.'
    : label === 'night pose'
      ? 'The lit-ground rows — the glint gate above all — save nothing here, so this run does not price them; a daylight pose does.'
      : 'Both sides of the terminator are in frame, so every coverage-gated row is priced part on and part off.';
  return `Taken at a ${label} over ${body}, the Sun ${height} under the camera. ${caveat}`;
}

/** Whether the milliseconds are amplified, and by how much — the sentence the
 *  verdict carries so a table read later cannot be mistaken for the app's own
 *  frame times. */
export function amplifierNote(active: boolean, pinnedRatio: number, restingRatio: number): string {
  if (!active) {
    return `Load amplifier off: these milliseconds are at the app's own render ratio ${restingRatio}, `
      + `so a row worth a few milliseconds may be hidden under the frame-rate cap.`;
  }
  return `Load amplifier on: the render ratio was pinned to ${pinnedRatio} for the run `
    + `(the app rests at ${restingRatio}), so every millisecond here is a ratio-${pinnedRatio} frame `
    + `and a saving has somewhere below the cap to show. The bloom chain sizes from the display's own `
    + `ratio rather than the pin, so the bloom rows are already at their true size.`;
}

/** Said only when the run started with tiles still arriving: their uploads land
 *  inside whichever holds they land in, and that is not those rows' cost. */
export function tilesReadyNote(inflight: number, waitedMs: number): string {
  if (inflight <= 0) return '';
  return `Started with ${inflight} sector tile${inflight === 1 ? '' : 's'} still in flight after `
    + `${(waitedMs / 1000).toFixed(0)} s of waiting, so a row or two carries an upload that is not its own.`;
}

/** Elapsed wall time as a soak row's name. */
export function soakLabel(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  return `t+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
 * A switch handed straight to this file through `__moon.perfRegister`.
 *
 * The efficiency switches the sweep was built around do not come this way —
 * they announce themselves on the bridge (see `bridgeSwitchStates`), and this
 * file finds them there without either side importing the other. This is the
 * door for anything that has no registry of its own: a probe adding one row
 * for an afternoon, or a harness proving the plumbing.
 *
 * `set` takes the SWITCH's own state — true is the switch on — which is the
 * polarity a subsystem thinks in. The sweep turns that into a candidate
 * configuration itself: for a switch that ships on, the candidate is the
 * switch OFF, and the row is then the cost the switch removes.
 */
export interface PerfSwitch {
  set: (on: boolean) => void;
  /** How the row reads. Left out, the sweep names it from the key. */
  label?: string;
  /** Where the switch stands when nothing has touched it. Read from the
   *  switch's own state at the start of a run when it is left out. */
  defaultOn?: boolean;
  /** True where flipping it needs a page reload: it is then listed but never
   *  held inside a run, because a reload would end the run. */
  needsReload?: boolean;
  /** False for a switch that changes pixels, which keeps it out of the
   *  combined row (that row is the total of the exact ones). */
  exact?: boolean;
}

/**
 * How the efficiency switches' rows should read, and which of them the sweep
 * must not try to hold.
 *
 * Nothing here creates a row: the switches announce themselves, and a key
 * absent from `__moon.perfSwitches()` is only reported at the end of a run as
 * one that has not arrived yet. This is the wording — a row has to say what
 * the CANDIDATE is, and for a switch that ships on the candidate is the switch
 * turned off, which is the cost it removes — plus the two facts the bridge
 * readout cannot carry: that the one-channel maps are already on the GPU when
 * a run starts, so flipping them needs a reload, and that the fused final pass
 * is the one item not promising the same pixels, so it never joins the
 * combined total.
 */
const EXPECTED_SWITCHES: Record<string, { off: string; on: string; needsReload?: boolean; exact?: boolean }> = {
  'night-early': { off: 'Night early-out removed', on: 'Night early-out on' },
  'cloud-clear': { off: 'Clear-sky early-out removed', on: 'Clear-sky early-out on' },
  'cloud-taps': { off: 'Dead cloud taps restored', on: 'Dead cloud taps removed' },
  'glint-gate': { off: 'Glint gate removed', on: 'Glint gate on' },
  'r8-maps': { off: 'One-channel maps off', on: 'One-channel maps on', needsReload: true },
  'bloom-nodepth': { off: 'Bloom depth buffers back', on: 'Bloom depth buffers off' },
  'depth-discard': { off: 'Depth discard removed', on: 'Depth discard on' },
  'fused-final': { off: 'Fused final pass off', on: 'Fused final pass on', exact: false },
};

/**
 * How long a configuration is held and how much of the hold is thrown away.
 *
 * The paired run holds 2.5 s and drops the first 0.5 s: the switch has already
 * settled by the second of a candidate's two consecutive holds, and the wall
 * time of the whole run is what heats the device. The quick run keeps the
 * older 3 s hold with a full second discarded, because there its single hold
 * is both the settling and the measurement.
 */
const PAIRED_HOLD_MS = 2500;
const PAIRED_SETTLE_MS = 500;
const PAIRED_BLOCKS = 2;
const QUICK_HOLD_MS = 3000;
const QUICK_SETTLE_MS = 1000;
/** Five minutes, sampled every ten seconds: what a sustained run does to the
 *  device, which no sequence of cool three-second holds can show. */
const SOAK_MS = 300_000;
const SOAK_SAMPLE_MS = 10_000;
/**
 * The Phone preset: one block per candidate over the rows a phone is actually
 * being asked about, and nothing else.
 *
 * A full paired run is sixteen candidates in two blocks each — five and a half
 * minutes of held load, which on the device this exists for is five and a half
 * minutes of heating, and the last rows are measured on a different phone from
 * the first. This list is the efficiency switches themselves plus the three
 * rows that give them their scale (the whole tile layer, half the pixels, and
 * everything at once), at two pairings apiece: about two minutes, which a
 * phone holds without sliding far.
 *
 * Keys absent from a build are simply not offered — the list is a filter over
 * the candidates a run finds, never a demand for rows that do not exist.
 */
const PHONE_KEYS = [
  'combined',
  'tiles',
  'night-early',
  'cloud-clear',
  'cloud-taps',
  'glint-gate',
  'bloom-nodepth',
  'depth-discard',
  'fused-final',
  'halfres',
];

/** The ratio the load amplifier pins. Three is one device pixel per texel on
 *  the phone this sweep exists for, and enough load on anything else to put a
 *  frame under the cap. */
const AMPLIFIER_RATIO = 3;
/** After the pin, the app resizes every composer target and the first frames
 *  through the new ones are not representative. */
const AMPLIFIER_SETTLE_MS = 1000;
/** How long the sweep waits for the sector tiles to stop arriving before it
 *  starts anyway and says so. */
const TILE_WAIT_MS = 20_000;
/** How often the budget readout is sampled inside a hold, and how often the
 *  live line is rewritten — both slow enough to read and to cost nothing. */
const BUDGET_SAMPLE_MS = 100;
const LIVE_REFRESH_MS = 500;
/** Frames the live line averages over. */
const LIVE_FRAMES = 30;

/** One thing the sweep switches off and back on. `set(true)` applies the
 *  CANDIDATE configuration, whichever way the underlying switch points. */
interface Arm {
  key: string;
  label: string;
  /** A switch some other module registered, rather than one of this file's
   *  own configurations. */
  registered: boolean;
  /** Registered switches only: whether the switch ships on, which is what
   *  makes its candidate the switch turned off. */
  defaultOn: boolean;
  /** Whether it belongs in the combined total (exact, no reload, ships on). */
  combinable: boolean;
  /** False where flipping it needs a reload: listed, never held. */
  swept: boolean;
  available: () => boolean;
  set: (applied: boolean) => void;
}

/** Where the sweep's own pixel ratio rests between candidates: the amplifier's
 *  pin during a run, null (the app's own choice) outside one. The half-
 *  resolution arm has to return to it rather than to "unpinned", or a run
 *  would drop its amplifier halfway through. */
interface RestingRatio { ratio: number | null }

/**
 * The switches the sweep offers as rows, on top of whatever other modules have
 * registered.
 *
 * The spacecraft and the HUD are not among them. Both were measured and both
 * are far too small to see through the noise of a device that is heating —
 * hiding the ship read 30 ms once, which is the run's drift, not a spacecraft.
 * They are still switched for the CONTROL, where the question is whether an
 * empty frame runs at rate rather than what one model costs.
 */
function buildArms(deps: PerfSweepDeps, resting: RestingRatio): Arm[] {
  const config = (key: string, label: string, set: (applied: boolean) => void, available = (): boolean => true): Arm =>
    ({ key, label, registered: false, defaultOn: false, combinable: false, swept: true, available, set });
  // What the half-resolution arm halves: the amplifier's pin inside a run, or
  // whatever the app is rendering at when the arm is thrown on its own.
  let halvedFrom = 0;
  return [
    config('tiles', 'Sector tiles hidden', (applied) => deps.setSectorMeshes(!applied)),
    config('clouds', 'Clouds hidden', (applied) => deps.setRoleHidden('clouds', applied)),
    config('atmosphere', 'Atmosphere hidden', (applied) => deps.setRoleHidden('atmosphere', applied)),
    config('night', 'Night lights hidden', (applied) => deps.setRoleHidden('nightLights', applied)),
    config(
      'bloom',
      'Bloom off',
      (applied) => {
        // The pass is skipped, not removed: rebuilding the composer would
        // relink every program inside the hold that is being measured.
        const bloom = deps.passes().bloom;
        if (bloom) bloom.enabled = !applied;
      },
      () => deps.passes().bloom !== null,
    ),
    config(
      'lens',
      'Lens off',
      (applied) => {
        // Skipping the lens pass leaves off-axis discs egg-shaped and the DOM
        // overlays pre-distorted for the hold, which is a look, not a break;
        // rebuilding the chain to avoid that would cost a relink instead.
        const lens = deps.passes().lens;
        if (lens) lens.enabled = !applied;
      },
      () => deps.passes().lens !== null,
    ),
    // Through the app's own resize path, so the composer's scene target and
    // its partner are reallocated at the new ratio. A switch that moved the
    // renderer's ratio alone would leave the frame drawn into the same pixels
    // and report that they were free. (The bloom chain keeps its own ratio by
    // design, so this arm halves everything but the glow.)
    config('halfres', 'Half resolution', (applied) => {
      if (applied) {
        halvedFrom = resting.ratio ?? deps.pixelRatio();
        deps.pinPixelRatio(halvedFrom / 2);
      } else {
        deps.pinPixelRatio(resting.ratio);
      }
    }),
    config('synthesis', 'Synthesis off', (applied) => deps.setSynthesis(applied ? false : null)),
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
    registered: false,
    defaultOn: false,
    combinable: false,
    swept: true,
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

/** Every registered switch turned off at once, as one row.
 *
 *  Two early-outs that each skip the same fragment save that fragment once, so
 *  the exact items' savings do not add and the sum of their rows is not what
 *  the build gets. This row is what it gets. Null with fewer than two members,
 *  where the combined row would only repeat a row already in the table. */
function buildCombined(members: readonly Arm[]): Arm | null {
  if (members.length < 2) return null;
  return {
    key: 'combined',
    label: `All ${members.length} exact switches off`,
    registered: false,
    defaultOn: false,
    combinable: false,
    swept: true,
    available: () => true,
    set: (applied) => {
      if (applied) for (const m of members) m.set(true);
      else for (let i = members.length - 1; i >= 0; i--) members[i].set(false);
    },
  };
}

/** The dev bridge, as this file reads and writes it. */
type Bridge = Record<string, unknown>;

function bridgeObject(): Bridge {
  const owner = window as unknown as Record<string, Bridge>;
  return (owner.__moon ??= {});
}

/**
 * Where the efficiency switches announce themselves.
 *
 * `__moon.perfSwitches()` answers with every switch a subsystem owns and where
 * it stands right now, and `__moon.perfArm(key, on)` moves one. Neither side
 * imports the other: the sweep reads the bridge at the start of a run, so a
 * switch that landed an hour ago is swept without this file having heard of
 * it, and a build where none of them exist yet sweeps its own rows alone.
 *
 * `perfArm` is a chain — whoever owns a key answers first and passes the rest
 * on — so calling it here reaches the switch's owner wherever it lives.
 */
function bridgeSwitchStates(): Record<string, boolean> {
  const bridge = bridgeObject();
  if (typeof bridge.perfSwitches !== 'function') return {};
  const state = (bridge.perfSwitches as () => unknown)();
  if (!state || typeof state !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function bridgeArm(key: string, on: boolean): void {
  const bridge = bridgeObject();
  if (typeof bridge.perfArm === 'function') (bridge.perfArm as (k: string, v: boolean) => boolean)(key, on);
}

/** Switches handed to this file directly, by key. Held here rather than on the
 *  bridge, so nothing this file writes can overwrite a seam another module
 *  published under a name of its own. */
const localSwitches = new Map<string, PerfSwitch>();

/** One registration, however it was written: a bare setter is as good as a
 *  described switch, and the description then comes from the expected table. */
function readSwitch(value: unknown): PerfSwitch | null {
  if (typeof value === 'function') return { set: value as (on: boolean) => void };
  if (value && typeof value === 'object' && typeof (value as PerfSwitch).set === 'function') {
    return value as PerfSwitch;
  }
  return null;
}

/**
 * Every switch the sweep can offer beyond its own configurations, as arms.
 *
 * The polarity is flipped where a switch ships on: its candidate is the switch
 * OFF, so the row reads as the cost turning it on removes, and the label says
 * that too. Where the switch ships on is read from the switch's own state as
 * the run starts — the state it is put back to afterwards is the state it was
 * found in, never one assumed from a table.
 */
function registeredArms(): Arm[] {
  const out: Arm[] = [];
  const seen = new Set<string>();
  const add = (key: string, foundOn: boolean, sw: PerfSwitch | null): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const expected = EXPECTED_SWITCHES[key];
    const defaultOn = sw?.defaultOn ?? foundOn;
    const needsReload = sw?.needsReload ?? expected?.needsReload ?? false;
    const exact = sw?.exact ?? expected?.exact ?? true;
    const label = sw?.label
      ?? (defaultOn ? expected?.off : expected?.on)
      ?? `${key} ${defaultOn ? 'off' : 'on'}`;
    const set = sw ? sw.set : (on: boolean): void => bridgeArm(key, on);
    out.push({
      key,
      label,
      registered: true,
      defaultOn,
      combinable: defaultOn && exact && !needsReload,
      swept: !needsReload,
      available: () => true,
      // The candidate is the other state; restoring writes back the state the
      // run found, whichever way round that was.
      set: (applied) => set(applied ? !defaultOn : defaultOn),
    });
  };
  for (const [key, on] of Object.entries(bridgeSwitchStates())) add(key, on, localSwitches.get(key) ?? null);
  for (const [key, sw] of localSwitches) add(key, sw.defaultOn ?? true, sw);
  return out;
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

function fmt(value: number | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '–';
}

/** A number off an untyped bridge readout. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function vec(value: unknown): Vec3 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const x = num(v.x); const y = num(v.y); const z = num(v.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

/**
 * Which body fills the frame and how high the Sun stands over the point under
 * the camera, read off the bridge the rest of the QA kit reads.
 *
 * The body is whichever surface is being drawn at the highest density —
 * `surfaceDensity()` is already sorted that way — and its position and the
 * player's come from `probe()`. Everything is optional: a pose that cannot be
 * read makes the verdict say so rather than making the run fail.
 */
function readPose(): { body: string | null; sunElevDeg: number | null; radii: number | null } {
  const bridge = bridgeObject();
  const densities = typeof bridge.surfaceDensity === 'function'
    ? (bridge.surfaceDensity as () => unknown[])()
    : [];
  const first = Array.isArray(densities) ? densities[0] as Record<string, unknown> | undefined : undefined;
  const body = typeof first?.name === 'string' ? first.name : null;
  if (!body || typeof bridge.probe !== 'function') return { body, sunElevDeg: null, radii: null };
  const probe = (bridge.probe as (name: string) => unknown)(body) as Record<string, unknown> | null;
  const bodyAbs = vec(probe?.bodyAbs);
  const playerAbs = vec(probe?.playerAbs);
  if (!bodyAbs || !playerAbs) return { body, sunElevDeg: null, radii: null };
  const radius = num(probe?.radiusAU);
  const distance = num(probe?.distToBodyAU);
  return {
    body,
    sunElevDeg: sunElevationDeg(bodyAbs, playerAbs),
    radii: radius && distance ? distance / radius : null,
  };
}

/**
 * The clock's rate and whether it is paused.
 *
 * `tutorialState()` is the one bridge readout that carries them, whether or
 * not a tutorial is running — the sweep needs the rate only to put it back
 * afterwards, and reading it there costs no new accessor in the app.
 */
function readClock(): { rate: number; paused: boolean } | null {
  const bridge = bridgeObject();
  if (typeof bridge.tutorialState !== 'function') return null;
  const state = (bridge.tutorialState as () => unknown)() as Record<string, unknown> | null;
  const rate = num(state?.rate);
  if (rate === null) return null;
  return { rate, paused: state?.paused === true };
}

function setTimeRate(rate: number): void {
  const bridge = bridgeObject();
  if (typeof bridge.setTimeRate === 'function') (bridge.setTimeRate as (r: number) => void)(rate);
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
#perf-sweep button[hidden] { display: none; }
#perf-sweep button.ps-go { color: var(--accent, #5e8bff); border-color: rgba(94, 139, 255, 0.5); }
#perf-sweep button.ps-stop { color: #ffb4a2; border-color: rgba(255, 180, 162, 0.5); }
#perf-sweep .ps-body { margin-top: 4px; overflow-y: auto; }
#perf-sweep .ps-live { margin-top: 6px; }
#perf-sweep .ps-live, #perf-sweep .ps-budget {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;
  font-variant-numeric: tabular-nums; color: var(--t2, #9aa4b8); line-height: 1.5;
}
#perf-sweep .ps-live b { color: var(--t1, #eef1f7); font-weight: 600; }
#perf-sweep .ps-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
#perf-sweep .ps-amp {
  display: flex; align-items: center; gap: 6px; margin: 2px 0 4px;
  font-size: 11.5px; color: var(--t2, #9aa4b8);
}
#perf-sweep .ps-status { margin: 6px 0 2px; color: var(--accent, #5e8bff); font-size: 11.5px; }
#perf-sweep .ps-scroll { overflow-x: auto; margin-top: 6px; }
/* Seven columns have to fit a 390 px phone without a sideways swipe: the
   numbers are three characters and the names are allowed to wrap. */
#perf-sweep table { border-collapse: collapse; width: 100%; min-width: 320px; }
#perf-sweep th, #perf-sweep td {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px;
  font-variant-numeric: tabular-nums; text-align: right; padding: 3px 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07); white-space: nowrap;
}
#perf-sweep th { color: var(--t2, #9aa4b8); font-weight: 500; }
#perf-sweep td.ps-name, #perf-sweep th.ps-name { text-align: left; white-space: normal; }
#perf-sweep tr.ps-control td { color: var(--accent, #5e8bff); }
#perf-sweep tr.ps-combined td { color: #b6f0c8; }
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
    <button type="button" class="ps-phone">Phone</button>
    <button type="button" class="ps-quick">Quick</button>
    <button type="button" class="ps-soak">Soak 5 min</button>
    <button type="button" class="ps-stop" hidden>Stop</button>
    <button type="button" class="ps-reset">Reset budget</button>
  </div>
  <label class="ps-amp"><input type="checkbox" class="ps-amp-box" checked> Amplify: pin the render ratio to 3</label>
  <div class="ps-status"></div>
  <div class="ps-scroll"></div>
  <div class="ps-note"></div>
</div>
`;

/** What one run was asked for. Everything is optional: the buttons pass a mode
 *  and nothing else, and a harness passes short holds and a few keys so a
 *  smoke run proves the plumbing without spending the minutes a real run
 *  spends. */
export interface PerfRunOptions {
  /** 'phone' is 'paired' over the preset list, one block each. */
  mode?: 'paired' | 'phone' | 'quick' | 'soak';
  /** Only these candidate keys, in the shuffled order they land in. */
  keys?: string[];
  blocks?: number;
  holdMs?: number;
  settleMs?: number;
  amplify?: boolean;
  soakMs?: number;
  sampleMs?: number;
}

/**
 * Build the overlay, install the frame probe, and wait to be told to run.
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
  const phoneBtn = panel.querySelector('.ps-phone') as HTMLButtonElement;
  const quickBtn = panel.querySelector('.ps-quick') as HTMLButtonElement;
  const soakBtn = panel.querySelector('.ps-soak') as HTMLButtonElement;
  const stopBtn = panel.querySelector('.ps-stop') as HTMLButtonElement;
  const resetBtn = panel.querySelector('.ps-reset') as HTMLButtonElement;
  const foldBtn = panel.querySelector('.ps-fold') as HTMLButtonElement;
  const ampBox = panel.querySelector('.ps-amp-box') as HTMLInputElement;

  // On a touch device the Phone preset is the run to reach for — the full
  // paired sweep is five minutes of held load, and a phone measured for five
  // minutes is a different phone by the end. The accent says which one that
  // is; both are always there.
  const touchDevice = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  if (touchDevice) {
    goBtn.classList.remove('ps-go');
    phoneBtn.classList.add('ps-go');
    // First in the row as well as accented: on a 390 px screen the buttons
    // wrap, and the default should not be the one that wrapped.
    phoneBtn.parentElement?.prepend(phoneBtn);
  }

  // The frame probe is the one measuring instrument: it feeds the live line
  // always, and a hold's sample list while one is running.
  const live: FrameSample[] = [];
  let recording: FrameSample[] | null = null;
  let running = false;
  let stopRequested = false;
  let wentHidden = false;
  let frameStartedAt = 0;
  let liveWrittenAt = 0;

  // The sweep's resting pixel ratio, shared with the half-resolution arm so it
  // returns to the amplifier's pin rather than to the app's own ratio.
  const resting: RestingRatio = { ratio: null };
  const singles = buildArms(deps, resting);
  const configIndex = new Map<string, Arm>();
  for (const arm of singles) configIndex.set(arm.key, arm);
  const control = buildControl(deps, singles);
  configIndex.set(control.key, control);

  // A page that was not being shown got frames from a throttle, not a display,
  // and nothing measured across that says anything about the pose.
  document.addEventListener('visibilitychange', () => {
    if (running && document.visibilityState !== 'visible') wentHidden = true;
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

  goBtn.addEventListener('click', () => { void run({ mode: 'paired' }); });
  phoneBtn.addEventListener('click', () => { void run({ mode: 'phone' }); });
  quickBtn.addEventListener('click', () => { void run({ mode: 'quick' }); });
  soakBtn.addEventListener('click', () => { void run({ mode: 'soak' }); });
  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    statusEl.textContent = 'Stopping after this hold…';
  });

  function setRunning(on: boolean): void {
    running = on;
    goBtn.disabled = on;
    phoneBtn.disabled = on;
    quickBtn.disabled = on;
    soakBtn.disabled = on;
    resetBtn.disabled = on;
    ampBox.disabled = on;
    stopBtn.hidden = !on;
  }

  function renderTable(rows: readonly SweepRow[], legend: string): void {
    const body = rows.map((row) => `
      <tr class="${row.key === 'control' ? 'ps-control' : row.key === 'combined' ? 'ps-combined' : ''}">
        <td class="ps-name">${row.label}</td>
        <td>${fmt(row.fps, 0)}</td>
        <td>${fmt(row.frameMs)}</td>
        <td>${fmt(row.deltaMs)}</td>
        <td>${fmt(row.spreadMs)}</td>
        <td>${fmt(row.busyMs)}</td>
        <td>${fmt(row.offMainMs)}</td>
      </tr>`).join('');
    scrollEl.innerHTML = `
      <table>
        <thead><tr>
          <th class="ps-name">Config</th><th>fps</th><th>ms</th><th>Δms</th><th>±</th>
          <th>busy</th><th>off</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="ps-legend">${legend}</div>`;
  }

  /** Hold one configuration and measure the tail of the hold. */
  async function measure(key: string, label: string, holdMs: number, settleMs: number): Promise<SweepRow> {
    const startedAt = performance.now();
    recording = [];
    await waitMs(holdMs);
    const samples = recording;
    recording = null;
    const summary = summarizeFrames(samples, startedAt + settleMs);
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
  function budgetWatcher(settleMs: number): { stop: () => { intervalMs: number; sliceMs: number } } {
    const startedAt = performance.now();
    const intervals: number[] = [];
    const slices: number[] = [];
    let watching = true;
    let sampledAt = 0;
    const tick = (): void => {
      if (!watching) return;
      const now = performance.now();
      if (now - sampledAt >= BUDGET_SAMPLE_MS && now - startedAt >= settleMs) {
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
    return { stop: () => { watching = false; return { intervalMs: mean(intervals), sliceMs: mean(slices) }; } };
  }

  /** Wait for the tile streamer to go quiet, so no upload lands inside a hold
   *  and is charged to it. Returns what was still in flight when the wait ran
   *  out, which the verdict reports rather than hiding. */
  async function waitForTiles(): Promise<{ inflight: number; waitedMs: number }> {
    const startedAt = performance.now();
    let inflight = deps.budget()?.tiles.inflight ?? 0;
    while (inflight > 0 && performance.now() - startedAt < TILE_WAIT_MS && !stopRequested) {
      statusEl.textContent = `Waiting for ${inflight} sector tile${inflight === 1 ? '' : 's'} to land…`;
      await waitMs(500);
      inflight = deps.budget()?.tiles.inflight ?? 0;
    }
    return { inflight, waitedMs: performance.now() - startedAt };
  }

  /**
   * One run of any of the three shapes.
   *
   * Everything that is changed for the run — the clock rate, the pixel-ratio
   * pin, every arm — is restored in the same `finally`, so a stop, an error or
   * a candidate that throws mid-block still hands the app back exactly as it
   * was found.
   */
  async function run(options: PerfRunOptions): Promise<unknown> {
    if (running) return null;
    if (!deps.ready()) {
      statusEl.textContent = 'The scene is still loading.';
      return null;
    }
    const mode = options.mode ?? 'paired';
    // The Phone preset is a paired run with a shorter list and one block: the
    // protocol is the same, the wall time is the difference.
    const paired = mode === 'paired' || mode === 'phone';
    const soakMs = options.soakMs ?? SOAK_MS;
    const sampleMs = options.sampleMs ?? SOAK_SAMPLE_MS;
    // A soak's hold IS its sample interval, and none of it is discarded: the
    // configuration never changes, so there is nothing settling to throw away.
    const holdMs = options.holdMs ?? (mode === 'soak' ? sampleMs : paired ? PAIRED_HOLD_MS : QUICK_HOLD_MS);
    const settleMs = options.settleMs ?? (mode === 'soak' ? 0 : paired ? PAIRED_SETTLE_MS : QUICK_SETTLE_MS);
    const blocks = Math.max(1, options.blocks ?? (mode === 'phone' ? 1 : PAIRED_BLOCKS));
    const amplify = options.amplify ?? ampBox.checked;

    setRunning(true);
    stopRequested = false;
    wentHidden = false;
    noteEl.textContent = '';
    scrollEl.innerHTML = '';

    const restingRatio = deps.pixelRatio();
    const clockWas = readClock();
    const rows: SweepRow[] = [];
    const baselines: SweepRow[] = [];
    let budgetMs = { intervalMs: 0, sliceMs: 0 };
    let step = 0;
    let total = 0;
    const announce = (label: string, extra = ''): void => {
      step += 1;
      // How much longer this is going to hold the device: a paired run over a
      // dozen candidates is minutes, and a phone in someone's hand should not
      // have to be guessed at from a hold count.
      const leftS = Math.max(0, Math.round(((total - step) * holdMs) / 1000));
      const left = `${Math.floor(leftS / 60)}:${String(leftS % 60).padStart(2, '0')} left`;
      statusEl.textContent = `${label} — ${step} of ${total}${extra ? ` · ${extra}` : ''} · ${left}`;
    };
    const hold = async (key: string, label: string): Promise<SweepRow> => {
      const watcher = budgetWatcher(settleMs);
      try {
        return await measure(key, label, holdMs, settleMs);
      } finally {
        budgetMs = watcher.stop();
      }
    };

    // Which candidates this run has. The registry is read here, at the start
    // of the run, so a switch registered a minute ago is swept without this
    // file ever having heard of it.
    const registered = registeredArms();
    const skipped = registered.filter((arm) => !arm.swept);
    const missing = Object.keys(EXPECTED_SWITCHES).filter((key) => !registered.some((arm) => arm.key === key));
    const combined = buildCombined(registered.filter((arm) => arm.combinable));
    let candidates = [
      ...singles.filter((arm) => arm.available()),
      ...registered.filter((arm) => arm.swept),
      ...(combined ? [combined] : []),
    ];
    const wanted = options.keys ?? (mode === 'phone' ? PHONE_KEYS : null);
    if (wanted) candidates = candidates.filter((arm) => wanted.includes(arm.key));
    const order = mode === 'soak' ? [] : shuffled(paired ? candidates : [...candidates, control]);
    total = mode === 'soak'
      ? Math.ceil(soakMs / sampleMs)
      : paired ? order.length * blocks * 4 + 3 : order.length * 2 + 1;
    // What this is about to cost in wall time, said before it starts rather
    // than discovered from a hold count: a phone is being held while it runs,
    // and a run nobody expected to take five minutes gets abandoned halfway,
    // which is the one outcome that measures nothing.
    const plannedMs = total * holdMs;
    const plannedMin = plannedMs >= 90_000
      ? `about ${Math.round(plannedMs / 60_000)} min`
      : `about ${Math.round(plannedMs / 1000)} s`;
    if (mode !== 'soak') {
      statusEl.textContent = `${mode === 'phone' ? 'Phone preset' : paired ? 'Paired sweep' : 'Quick sweep'}: `
        + `${order.length} configuration${order.length === 1 ? '' : 's'}, ${total} holds, ${plannedMin}.`;
      // Long enough to be read before the first hold overwrites it.
      await waitMs(1200);
    }

    let tiles = { inflight: 0, waitedMs: 0 };
    // Which pose the run priced, read once the clock is stopped — the sky is
    // then the sky every hold is measured against.
    let pose: { body: string | null; sunElevDeg: number | null; radii: number | null } =
      { body: null, sunElevDeg: null, radii: null };
    try {
      // Frozen state: a clock that is running moves every body, every shadow
      // and the tile streamer's target under the measurement.
      if (clockWas && clockWas.rate !== 0) setTimeRate(0);
      pose = readPose();
      tiles = await waitForTiles();
      if (amplify) {
        resting.ratio = AMPLIFIER_RATIO;
        deps.pinPixelRatio(AMPLIFIER_RATIO);
        statusEl.textContent = `Pinning the render ratio to ${AMPLIFIER_RATIO}… · ${total} holds, ${plannedMin}`;
        await waitMs(AMPLIFIER_SETTLE_MS);
      }

      if (mode === 'soak') {
        // The baseline, held, sampled on the clock. Nothing is switched: the
        // question is what the device does to itself over five minutes.
        const startedAt = performance.now();
        let first: SweepRow | null = null;
        while (performance.now() - startedAt < soakMs && !stopRequested) {
          announce('Soaking');
          const row = await hold('soak', soakLabel(performance.now() - startedAt + sampleMs));
          first ??= row;
          row.deltaMs = first.frameMs > 0 && row.frameMs > 0 ? row.frameMs - first.frameMs : 0;
          rows.push(row);
          baselines.push(row);
          renderTable(rows, legendFor(mode, amplify));
          debugLog(`Perf soak ${row.label}`, `${row.fps.toFixed(1)} fps, ${row.frameMs.toFixed(1)} ms, `
            + `busy ${row.busyMs.toFixed(1)} ms, off main ${row.offMainMs.toFixed(1)} ms`);
        }
      } else if (paired) {
        // A B B A, twice per candidate. The candidate stays applied across its
        // two holds, so the second one is measured on a configuration that has
        // been settled for a full hold, and each pairing charges a candidate
        // hold against the baseline hold beside it.
        for (const arm of order) {
          if (stopRequested) break;
          const deltas: number[] = [];
          const armRows: SweepRow[] = [];
          for (let block = 0; block < blocks && !stopRequested; block++) {
            const where = `${arm.label}, block ${block + 1} of ${blocks}`;
            announce('Baseline', where);
            const before = await hold('baseline', 'Baseline');
            baselines.push(before);
            arm.set(true);
            try {
              announce(arm.label, where);
              const first = await hold(arm.key, arm.label);
              announce(arm.label, where);
              const second = await hold(arm.key, arm.label);
              armRows.push(first, second);
              if (before.frameMs > 0 && first.frameMs > 0) deltas.push(first.frameMs - before.frameMs);
              announce('Baseline', where);
              const after = await hold('baseline', 'Baseline');
              baselines.push(after);
              if (after.frameMs > 0 && second.frameMs > 0) deltas.push(second.frameMs - after.frameMs);
            } finally {
              arm.set(false);
            }
          }
          const { deltaMs, spreadMs } = pairedDelta(deltas);
          rows.push({
            key: arm.key,
            label: arm.label,
            frames: armRows.reduce((sum, r) => sum + r.frames, 0),
            fps: median(armRows.map((r) => r.fps)),
            frameMs: median(armRows.map((r) => r.frameMs)),
            busyMs: median(armRows.map((r) => r.busyMs)),
            offMainMs: median(armRows.map((r) => r.offMainMs)),
            deltaMs,
            spreadMs,
            deltas,
          });
          renderTable(rows, legendFor(mode, amplify));
          if (stopRequested) break;
        }
        // The control sits outside the blocks: it is not a ranked cost but the
        // question of whether an empty frame runs at rate at all.
        if (!stopRequested) {
          announce('Baseline', control.label);
          const before = await hold('baseline', 'Baseline');
          baselines.push(before);
          control.set(true);
          let row: SweepRow;
          try {
            announce(control.label);
            row = await hold(control.key, control.label);
          } finally {
            control.set(false);
          }
          announce('Baseline', control.label);
          const after = await hold('baseline', 'Baseline');
          baselines.push(after);
          const bracket = bracketFrameMs(before, after);
          row.deltaMs = bracket > 0 && row.frameMs > 0 ? row.frameMs - bracket : 0;
          rows.push(row);
        }
      } else {
        // The quick run: one bracketed pass, the control shuffled in among the
        // rest so it is not charged with the whole run's drift.
        announce('Baseline');
        baselines.push(await hold('baseline', 'Baseline'));
        for (const arm of order) {
          if (stopRequested) break;
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
        for (let i = 0; i < rows.length; i++) {
          const bracket = bracketFrameMs(baselines[i], baselines[i + 1]);
          rows[i].deltaMs = bracket > 0 && rows[i].frameMs > 0 ? rows[i].frameMs - bracket : 0;
        }
      }
    } finally {
      // Put the device back before anything is reported: the report is written
      // from numbers already taken, and a thrown row must not leave the app
      // pinned, frozen or missing a layer.
      resting.ratio = null;
      if (amplify) deps.pinPixelRatio(null);
      if (clockWas && clockWas.rate !== 0) setTimeRate(clockWas.rate);
      setRunning(false);
    }

    renderTable(rows, legendFor(mode, amplify));

    const controlRow = rows.find((r) => r.key === 'control');
    const verdict = controlRow ? throttleVerdict(controlRow) : '';
    const drift = thermalDriftLine(baselines);
    const amplifierLine = amplifierNote(amplify, AMPLIFIER_RATIO, restingRatio);
    const poseLine = poseNote(pose.body, pose.sunElevDeg);
    const tilesLine = tilesReadyNote(tiles.inflight, tiles.waitedMs);
    const hiddenNote = wentHidden
      ? 'The page stopped being shown during the run, so these numbers are not the pose’s. Run it again.'
      : '';
    const stoppedNote = stopRequested ? 'Stopped early, so the table is only as far as it got.' : '';
    const skippedNote = skipped.length
      ? `Not swept (a reload would end the run): ${skipped.map((a) => a.key).join(', ')}.`
      : '';
    const missingNote = missing.length
      ? `Not published by this build, so not in this run: ${missing.join(', ')}.`
      : '';
    const orderNote = order.length ? `Order this run: ${order.map((a) => a.label).join(', ')}.` : '';
    noteEl.textContent = [
      hiddenNote, stoppedNote, verdict, amplifierLine, poseLine, tilesLine, drift,
      skippedNote, missingNote, orderNote,
    ].filter(Boolean).join(' ');
    statusEl.textContent = stopRequested ? 'Stopped.' : 'Done.';

    const results = {
      at: new Date().toISOString(),
      mode,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio,
      renderPixelRatio: deps.pixelRatio(),
      restingPixelRatio: restingRatio,
      amplified: amplify,
      amplifierRatio: amplify ? AMPLIFIER_RATIO : null,
      holdMs,
      settleMs,
      blocks: paired ? blocks : 1,
      order: order.map((a) => a.key),
      registered: registered.map((a) => ({
        key: a.key, label: a.label, defaultOn: a.defaultOn, swept: a.swept, combinable: a.combinable,
      })),
      combinedOf: combined ? registered.filter((a) => a.combinable).map((a) => a.key) : [],
      notRegistered: missing,
      pose: { ...pose, label: pose.sunElevDeg === null ? null : poseLabel(pose.sunElevDeg) },
      tiles,
      timeRate: { was: clockWas?.rate ?? null, paused: clockWas?.paused ?? null },
      verdict,
      amplifier: amplifierLine,
      poseNote: poseLine,
      tilesNote: tilesLine,
      drift,
      wentHidden,
      stopped: stopRequested,
      rows,
      baselines,
      // The last hold's frame-sliced spend. Kept because a dead budget loop is
      // itself a finding, and a live one would show here first.
      budget: budgetMs,
    };
    const bridge = bridgeObject();
    bridge.perfSweep = results;
    if (mode === 'soak') bridge.perfSoak = results;
    // The overlay is the only console a phone has without a cable, and the
    // same table has to survive a look at `?debug=1` afterwards.
    debugLog('Perf sweep', `${mode} · ${results.viewport} dpr ${results.devicePixelRatio} `
      + `· render ratio ${results.renderPixelRatio}${orderNote ? ` · ${orderNote}` : ''}`);
    for (const row of rows) {
      debugLog(
        `Perf sweep ${row.label}`,
        `${row.fps.toFixed(1)} fps, ${row.frameMs.toFixed(1)} ms, `
        + `${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs.toFixed(1)} ms vs its baselines`
        + `${typeof row.spreadMs === 'number' ? ` (spread ${row.spreadMs.toFixed(1)} ms over ${row.deltas?.length ?? 0} pairings)` : ''}, `
        + `busy ${row.busyMs.toFixed(1)} ms, off main ${row.offMainMs.toFixed(1)} ms`,
      );
    }
    debugLog('Perf sweep drift', drift);
    debugLog('Perf sweep pose', poseLine);
    debugLog('Perf sweep amplifier', amplifierLine);
    if (tilesLine) debugLog('Perf sweep tiles', tilesLine);
    if (verdict) debugLog('Perf sweep verdict', verdict);
    return results;
  }

  /** The table's own footer: what each column is, and at which ratio the
   *  milliseconds were taken. */
  function legendFor(mode: 'paired' | 'phone' | 'quick' | 'soak', amplify: boolean): string {
    const columns = mode === 'soak'
      ? 'ms = gap between frames · Δms = against the first sample · busy = main thread inside a frame'
        + ' · off = the rest of the frame, not on the main thread'
      : mode !== 'quick'
        ? 'ms = gap between frames, median of the candidate’s holds · Δms = median of the pairings'
          + ' (candidate minus the baseline beside it) · ± = spread across those pairings, wider than Δ means'
          + ' the device moved more than the switch did · busy = main thread inside a frame'
          + ' · off = the rest of the frame, not on the main thread'
        : 'ms = gap between frames · Δms = against the mean of the baselines either side'
          + ' · busy = main thread inside a frame · off = the rest of the frame, not on the main thread';
    const ratio = amplify
      ? `Milliseconds are at the pinned render ratio ${AMPLIFIER_RATIO}, not the app’s own. `
        + 'The bloom chain sizes from the display’s ratio rather than the pin, so the bloom rows are at their true size.'
      : 'Milliseconds are at the app’s own render ratio.';
    return `${columns}. ${ratio}`;
  }

  // Harness seams. `perfArm` applies or restores one switch by name — for this
  // file's own configurations `true` APPLIES the configuration ('bloom' true
  // means bloom off), and for a switch handed here through `perfRegister`
  // `true` is the switch's own on, which is the polarity its owner thinks in.
  // The assignment below joins a chain rather than replacing one: a subsystem
  // that publishes its own `perfArm` for its own keys hands everything else
  // on, so both sets of names work through the one call. `perfArmKeys`
  // enumerates everything the sweep would offer, and `perfTargets` reads the
  // surfaces a frame is drawn into — a resolution switch is only believable if
  // the targets moved, and that is a size to be read, not a timing to be
  // inferred.
  const bridge = bridgeObject();
  bridge.perfArm = (key: string, applied: boolean): boolean => {
    // Only switches registered HERE are answered by key: one that lives on the
    // bridge is already answered by its owner ahead of this handler, and
    // calling back out to the bridge for it would be a loop.
    const sw = localSwitches.get(key);
    if (sw) {
      sw.set(applied);
      return true;
    }
    if (key === 'combined') {
      const arm = buildCombined(registeredArms().filter((a) => a.combinable));
      if (!arm) return false;
      arm.set(applied);
      return true;
    }
    const arm = configIndex.get(key);
    if (!arm) return false;
    arm.set(applied);
    return true;
  };
  bridge.perfRegister = (key: string, sw: PerfSwitch | ((on: boolean) => void)): boolean => {
    const entry = readSwitch(sw);
    if (!key || !entry) return false;
    localSwitches.set(key, entry);
    return true;
  };
  bridge.perfArmKeys = (): string[] => {
    const keys = [...configIndex.keys(), ...registeredArms().map((arm) => arm.key)];
    if (registeredArms().filter((a) => a.combinable).length >= 2) keys.push('combined');
    return keys;
  };
  bridge.perfRun = (options?: PerfRunOptions) => run(options ?? {});
  bridge.perfStop = (): boolean => {
    if (!running) return false;
    stopRequested = true;
    return true;
  };
  bridge.perfTargets = () => deps.renderTargets();

  writeLive();
}
