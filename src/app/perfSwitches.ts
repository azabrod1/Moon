/**
 * The GPU-efficiency switches — DEV only, one per change that removes work the
 * picture does not depend on.
 *
 * Each of these changes exists to make a frame cheaper without moving a pixel,
 * and a claim like that is worth exactly what the diff between the two
 * pictures says. So every one of them ships as an A/B: switched OFF the
 * pipeline is byte-for-byte the one that was there before the change, switched
 * ON it is the cheaper path, and the acceptance test is a capture of both out
 * of ONE page load — one GPU, one pose, one clock — differenced pixel by
 * pixel. Two captures from two builds cannot do that job: a tile that landed a
 * frame later, a lens strength renegotiated at a different size or an exposure
 * that had not settled all read as a difference the shader did not make.
 *
 * That is also why a shader item's two paths both live in the compiled
 * program, behind a uniform, rather than behind a recompile: the sweep flips
 * these between three-second holds, and a relink mid-hold would be measured as
 * the thing being measured. A PRODUCTION build carries neither path — every
 * site reads `import.meta.env.DEV` inline, so the bundler folds the switch
 * away and emits the cheap text alone, with no uniform, no branch and no key
 * string left in `dist/`.
 *
 * `fused-final` is the exception that is off by default: it is the one item
 * that cannot promise the same pixels (an intermediate half-float rounding
 * disappears), so it is built to be measured and reported, not to be run.
 */

/** One switchable efficiency change. */
export type PerfSwitchKey =
  | 'night-early'
  | 'cloud-clear'
  | 'cloud-taps'
  | 'glint-gate'
  | 'r8-maps'
  | 'bloom-nodepth'
  | 'depth-discard'
  | 'fused-final';

/**
 * What each switch does, in the words a sweep row is labelled with, and where
 * it stands when nothing has touched it.
 *
 * The default is also what a production build compiles: a switch that defaults
 * on has its cheap path as the only path there, and one that defaults off has
 * neither path.
 */
export const PERF_SWITCHES: ReadonlyArray<{
  key: PerfSwitchKey;
  label: string;
  on: boolean;
  /** True where flipping it mid-session cannot reach what is already on the
   *  GPU, so the page has to be loaded again for the switch to mean anything. */
  needsReload?: boolean;
}> = [
  { key: 'night-early', label: 'Night shell early-out', on: true },
  { key: 'cloud-clear', label: 'Cloud deck: clear sky early-out', on: true },
  { key: 'cloud-taps', label: 'Cloud deck: dead taps', on: true },
  { key: 'glint-gate', label: 'Ocean glint mask gate', on: true },
  { key: 'r8-maps', label: 'One-channel bump/water maps', on: true, needsReload: true },
  { key: 'bloom-nodepth', label: 'Bloom targets without depth', on: true },
  { key: 'depth-discard', label: 'Scene depth/stencil discard', on: true },
  { key: 'fused-final', label: 'Fused bloom blend + output', on: false },
];

/** Where each switch stands when nothing has touched it, as a plain literal:
 *  a bundler can see that building it has no effect, which is what lets the
 *  whole registry disappear from a production build. */
const DEFAULT_ON: Record<PerfSwitchKey, boolean> = {
  'night-early': true,
  'cloud-clear': true,
  'cloud-taps': true,
  'glint-gate': true,
  'r8-maps': true,
  'bloom-nodepth': true,
  'depth-discard': true,
  'fused-final': false,
};

const live: Record<string, boolean> = { ...DEFAULT_ON };

/** The uniform objects the shader items read, one per key, shared by every
 *  material that carries the switch — a flip has to reach the globe, its
 *  streamed sectors and the night shell in the same frame or the A/B is of two
 *  different pictures. */
const uniforms: Record<string, { value: number }> = {};

// `?perfoff=key,key` starts a session with those switches off. It is how an
// item whose A/B cannot be flipped mid-session is captured — a texture's
// format is decided when it is uploaded, so the two pictures have to come from
// two page loads at the same frozen pose. Read at module load, before anything
// has asked a switch a question. DEV only: a production build folds the guard
// away and the whole registry with it.
if (import.meta.env.DEV && typeof location !== 'undefined') {
  for (const key of new URLSearchParams(location.search).get('perfoff')?.split(',') ?? []) {
    const k = key.trim();
    if (k in DEFAULT_ON) live[k] = false;
  }
}

type Listener = (on: boolean) => void;
const listeners: Record<string, Listener[]> = {};

/** Whether a switch is applied right now. */
export function perfSwitchOn(key: PerfSwitchKey): boolean {
  return live[key] ?? false;
}

/** The shared uniform for a shader switch: 1 while it is applied, 0 while the
 *  material is to draw exactly what it drew before the change. */
export function perfSwitchUniform(key: PerfSwitchKey): { value: number } {
  return (uniforms[key] ??= { value: perfSwitchOn(key) ? 1 : 0 });
}

/** Run `fn` whenever this switch moves — for the items that are not a uniform
 *  (a render target's attachments, a pass list). Called once immediately with
 *  the switch's current state, so a listener never has to duplicate it. */
export function onPerfSwitch(key: PerfSwitchKey, fn: Listener): void {
  (listeners[key] ??= []).push(fn);
  fn(perfSwitchOn(key));
}

/** Apply or restore one switch. Returns false for a name nothing owns, which
 *  is what lets the bridge below hand an unknown key on to the perf sweep's
 *  own arms rather than swallowing it. */
export function setPerfSwitch(key: string, on: boolean): boolean {
  if (!(key in DEFAULT_ON)) return false;
  const k = key as PerfSwitchKey;
  if (perfSwitchOn(k) === on) return true;
  live[k] = on;
  const u = uniforms[k];
  if (u) u.value = on ? 1 : 0;
  for (const fn of listeners[k] ?? []) fn(on);
  return true;
}

/** Every switch and where it stands, for the bridge and for a capture's log. */
export function perfSwitchState(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const s of PERF_SWITCHES) out[s.key] = perfSwitchOn(s.key);
  return out;
}

/**
 * Put `__moon.perfArm(key, on)` on the bridge.
 *
 * The on-device perf sweep installs a handler of its own under the same name
 * for the arms it builds, and neither registration knows about the other — so
 * the property is a chain rather than a value: whatever is assigned later
 * becomes the fallback for a key this registry does not own, and a plain
 * assignment from either side keeps both sets of keys working.
 */
export function installPerfSwitchBridge(): void {
  const bridge = ((window as unknown as Record<string, Record<string, unknown>>).__moon ??= {});
  let next: ((key: string, on: boolean) => boolean) | null =
    typeof bridge.perfArm === 'function'
      ? (bridge.perfArm as (key: string, on: boolean) => boolean)
      : null;
  const arm = (key: string, on: boolean): boolean =>
    setPerfSwitch(key, on) || (next ? next(key, on) : false);
  Object.defineProperty(bridge, 'perfArm', {
    configurable: true,
    get: () => arm,
    set: (fn: (key: string, on: boolean) => boolean) => { next = fn; },
  });
  bridge.perfSwitches = () => perfSwitchState();
}
