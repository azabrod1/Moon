/**
 * One open of the Look-inside tool, timed: the marks, the stopwatch that holds
 * them and the rules for writing into it. Pure — no three, no DOM — because
 * the rules are where the bugs are: which open a late mark belongs to, and
 * whether the mode is still the one that asked for it.
 *
 * InteriorMode maps these onto the tool's lifecycle; main hands over the two
 * marks it owns (the veil's).
 */
/**
 * What one open of a body cost, ms from the activate (or, for a swap, from the
 * pick) that started it — null for a step not reached yet. The tool's open is a
 * chain of serial steps, and the only way to say which one a reader is waiting
 * on is to mark them: the bridge serves these as `interiorState().timings` and
 * the mode logs them once through debugLog, so `?debug=1` on a phone answers
 * the question on the device that is slow.
 *
 * Two of the marks are not this mode's to take. The mode-switch veil belongs to
 * main, and it is what stands between a reader and everything drawn before it
 * lifts: `firstFrame` is the first frame after the reveal started, which on a
 * first entry is routinely still behind black. So main marks `veilLifted` and
 * `firstVisibleFrame` through markUncovered, and only an entry carries them —
 * a swap has no veil.
 */
export interface InteriorOpenTimings {
  /** The session's first entry (which pays the shader compiles) or a later swap. */
  kind: 'entry' | 'swap';
  /** The body these marks describe. */
  bodyId: string;
  /** The colour map's fetch and the skin build (InteriorScene.prepareBody). */
  prepareStart: number | null;
  prepareEnd: number | null;
  /** The skin, the air and the rings on the body (InteriorScene.presentBody). */
  present: number | null;
  /** Linking the programs the reveal draws, under the veil (a first entry only). */
  precompileStart: number | null;
  precompileEnd: number | null;
  /** The cut starts opening. */
  revealStart: number | null;
  /** The first frame drawn with the body on the mesh. On an entry it is behind
   *  the veil, and it is the frame the veil must not lift before. */
  firstFrame: number | null;
  /** The veil finished fading out (its own transitionend, not the class change),
   *  and the first frame drawn after that: the first one a reader can actually
   *  see. Main's marks, an entry's alone. */
  veilLifted: number | null;
  firstVisibleFrame: number | null;
  /** The first frame devReady() is true: the map applied, the cut and the morph settled. */
  ready: number | null;
  /** renderer.info.programs.length as the reveal starts and once ready — how many
   *  programs the studio still compiles while the reader is watching. */
  programsAtReveal: number | null;
  programsWhenReady: number | null;
}

/** The steps an open marks, in the order they happen. */
export type OpenTimingMark =
  | 'prepareStart' | 'prepareEnd' | 'present'
  | 'precompileStart' | 'precompileEnd'
  | 'revealStart' | 'firstFrame' | 'ready';

/** The two marks main takes and hands over (see InteriorOpenTimings). */
export type UncoveredMark = 'veilLifted' | 'firstVisibleFrame';

/** One open's stopwatch: the marks it fills in and the instant they measure
 *  from. A commit holds its own, so a superseded commit's late steps land in an
 *  object nobody reads instead of overwriting the live open's marks. The id is
 *  what an outside marker names: main takes the veil's marks after activate
 *  resolves and writes them a fade later, by which time a pick may have
 *  installed a stopwatch of its own. */
export interface OpenStopwatch {
  readonly id: number;
  readonly startedAt: number;
  readonly timings: InteriorOpenTimings;
}

let openSequence = 0;

export function startOpenStopwatch(kind: 'entry' | 'swap', bodyId: string): OpenStopwatch {
  return {
    id: ++openSequence,
    startedAt: performance.now(),
    timings: {
      kind,
      bodyId,
      prepareStart: null,
      prepareEnd: null,
      present: null,
      precompileStart: null,
      precompileEnd: null,
      revealStart: null,
      firstFrame: null,
      veilLifted: null,
      firstVisibleFrame: null,
      ready: null,
      programsAtReveal: null,
      programsWhenReady: null,
    },
  };
}

/** Mark one step, to a tenth of a millisecond. The first mark of a step stands:
 *  a step reached twice (a reveal onto the body that was already on) is still
 *  the moment the reader waited for. */
export function markOpenStep(watch: OpenStopwatch, step: OpenTimingMark): void {
  if (watch.timings[step] !== null) return;
  watch.timings[step] = Math.round((performance.now() - watch.startedAt) * 10) / 10;
}

/** Mark one of the veil's steps — main's, handed over after the fact — into the
 *  open that asked for it, ms from that open's start; null when it is refused.
 *
 *  Refused unless the named open is still the live one, it is an entry, and the
 *  mode is still active. All three matter: a pick installs a stopwatch of its
 *  own and a swap has no veil, and an exit during the lift takes the tool down
 *  while main is still waiting — the switch out re-covers the screen, the
 *  lift's own event never comes, and the timer standing in for it would
 *  otherwise write "the reader saw the body" for a black screen and then take
 *  the planetarium's next frame as the tool's first visible one. */
export function markUncoveredStep(
  watch: OpenStopwatch,
  openId: number,
  mark: UncoveredMark,
  atMs: number,
  active: boolean,
): number | null {
  if (!active || watch.id !== openId || watch.timings.kind !== 'entry' || watch.timings[mark] !== null) return null;
  const value = Math.round((atMs - watch.startedAt) * 10) / 10;
  watch.timings[mark] = value;
  return value;
}
