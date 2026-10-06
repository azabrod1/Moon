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
 * `fused-final` is the exception to that last part. It is the one item that
 * cannot promise exactly the same pixels — the lens warp, the glow and the tone
 * map became one draw, and an intermediate half-float rounding disappeared with
 * the surfaces between them — so the picture it replaces has to stay reachable
 * on a real build. Both of its chains therefore ship, and the URL parameter
 * `?fused=0` is the door to the old one in production; this key is only the DEV
 * spelling of the same choice, which the pixel gate uses to arm the change
 * inside one session. Arming it rebuilds the composer, so it is a reload switch
 * as far as the sweep is concerned: a relink inside a measured hold is measured
 * as the thing being measured.
 *
 * `ground-cull` is the streamer leaving out of a draw the ground a finer drawn
 * sector tile covers (world/groundCull): the globe and each coarser level under
 * a tile are shaded and then lose the depth test on Apple GPUs, so they are not
 * submitted. Flipped live it puts every full index list back at once — no
 * upload, no relink — so it sweeps like any exact switch. Like `fused-final` it
 * has a production door of its own: `?groundcull=0` builds the ground with its
 * plain indexes and cuts nothing, and this key is only the DEV reading of the
 * cut on top of the layout.
 *
 * `cloud-program` is decided when the deck's material compiles — its
 * archetype becomes a compile-time define rather than a uniform, so the
 * compiler drops every branch the deck never takes — which is why it is a
 * reload switch: flipping it mid-session would relink the program inside the
 * hold being measured.
 *
 * The four `cloud-probe-*` keys are not changes at all. Each one removes one
 * of the cloud deck's terms outright — the smooth magnification filter, the
 * close-range detail, the relief map, the air in front of the deck — so a
 * device can say what that term costs, which is the number a decision about
 * the deck has to rest on: the deck is one draw of the same surface program
 * the ground uses, and a profiler can price the draw but not the terms inside
 * it. They are off by default, never exact, never in the combined row, and a
 * production build carries neither reading of them.
 *
 * The VISUAL keys — `cloud-noise-frame` — are not efficiency changes either.
 * They ship on and they change the picture on purpose: each one is a fix
 * whose OFF arm is the picture as it was, kept as the control a capture of the
 * fix is held against. A visual key is a control arm, not a saving: never
 * exact, never in the combined row, never in the Phone preset, and a
 * production build compiles its ON reading alone.
 *
 * `cloud-shadow` is a FEATURE key, on by default: cloud shadows on the ground,
 * the sea and the air under Earth's deck (world/surfaceShading), a change to
 * the picture, so never exact. It is a compile-time define on the ground
 * materials, so flipping it relinks them — live, through
 * `__moon.cloudShadow({on})` or this registry — and the sweep treats it like
 * `cloud-program`, never holding it inside a measured window. Like
 * `fused-final` it has a production door of its own: `?cloudshadows=0` at boot
 * turns it off in any build, and this key is the DEV spelling, which the URL
 * disarms.
 *
 * `cloud-light` is the same kind of key: the cloud deck lit as a cloud (the
 * light scattered inside it and the sky's own, world/surfaceShading), a
 * compile-time define on the planetarium's deck alone, on by default;
 * `?cloudlight=0` turns it off in any build.
 *
 * There is deliberately no key for the render resolution. The graphics-quality
 * levels are its A/B (`?quality=medium` is the picture as it was, and
 * `?upscale=<ratio>` pins any scene ratio for a measurement), and a key here
 * would be a second writer of the same variable: it would arm itself on every
 * DEV boot the moment a level asked for a ratio, so the sweep would enumerate
 * it by default and `perfArm` would silently overrule the user's own level.
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
  | 'fused-final'
  | 'cloud-program'
  | 'ground-cull'
  | 'cloud-noise-frame'
  | 'cloud-shadow'
  | 'cloud-light'
  | 'cloud-probe-smooth'
  | 'cloud-probe-detail'
  | 'cloud-probe-relief'
  | 'cloud-probe-air';

/**
 * What each switch does, in the words a sweep row is labelled with, and where
 * it stands when nothing has touched it.
 *
 * The default is also what a production build compiles: a switch that defaults
 * on has its cheap path as the only path there, and one that defaults off has
 * neither path. The exception is a key whose old path is a kill switch reached
 * by a URL parameter of its own — `fused-final`, `ground-cull`, `cloud-shadow`,
 * `cloud-light` — where both paths are in the production bundle and only this
 * registry's reading of them is DEV.
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
  { key: 'fused-final', label: 'Lens, glow and tone map as one pass', on: true, needsReload: true },
  { key: 'cloud-program', label: 'Cloud deck program of its own', on: true, needsReload: true },
  { key: 'ground-cull', label: 'Ground under a finer tile left undrawn', on: true },
  { key: 'cloud-noise-frame', label: 'Cloud noise anchored to the sheet', on: true },
  { key: 'cloud-shadow', label: 'Cloud shadows on the ground', on: true, needsReload: true },
  { key: 'cloud-light', label: 'Cloud deck lit as a cloud', on: true, needsReload: true },
  { key: 'cloud-probe-smooth', label: 'Cloud deck probe: smooth filter off', on: false },
  { key: 'cloud-probe-detail', label: 'Cloud deck probe: detail term off', on: false },
  { key: 'cloud-probe-relief', label: 'Cloud deck probe: relief map off', on: false },
  { key: 'cloud-probe-air', label: 'Cloud deck probe: air off', on: false },
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
  'fused-final': true,
  'cloud-program': true,
  'ground-cull': true,
  'cloud-noise-frame': true,
  'cloud-shadow': true,
  'cloud-light': true,
  'cloud-probe-smooth': false,
  'cloud-probe-detail': false,
  'cloud-probe-relief': false,
  'cloud-probe-air': false,
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
