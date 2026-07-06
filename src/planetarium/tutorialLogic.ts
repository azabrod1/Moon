/**
 * Pure logic for the guided tutorial — the Next-driven click-through that stages
 * the app's showcase scenes (Saturn's rings, standing on the Moon, time-lapse,
 * a total solar eclipse). DOM-free so the step table, the phase machine, and
 * the restore/settle decisions stay unit-testable; PlanetariumMode owns the
 * scene staging and the card widget.
 */
import type { ShadowEventSpec } from '../astronomy/shadows';

export type TutorialStepId = 'welcome' | 'saturn' | 'moon' | 'timelapse' | 'eclipse' | 'wrap';

/** What the controller must stage when a step becomes current ('none' = card only). */
export type TutorialStage = 'none' | 'saturn' | 'moon' | 'timelapse' | 'eclipse';

/** Which busy signals gate a step's Next button (see isStepSettled). */
export interface SettleNeeds {
  /** Wait out arrivals: no in-flight veil-gated teleport, no covering veil. */
  arrival: boolean;
  /** Wait out the surface-view entry FOV glide. */
  fov: boolean;
  /** Hold Next until the eclipse clock reaches the totality settle instant —
   *  an eager click must not skip the climax (the ghost skip stays live). */
  totality: boolean;
  /** Minimum time since staging completed before Next enables. */
  dwellMs: number;
}

export interface TutorialStep {
  id: TutorialStepId;
  /** Card headline (the eyebrow is always "Tutorial"). */
  title: string;
  body: string;
  /** Eclipse card swaps to this once the clock settles into totality. */
  totalityBody?: string;
  /** Primary button. Advances the tutorial everywhere except the wrap card, where it restores. */
  primaryLabel: string;
  /** Ghost skip button; null on the wrap card — ending the tutorial always takes
   *  you back to where and when you started. */
  ghostLabel: string | null;
  stage: TutorialStage;
  settle: SettleNeeds;
}

/** Next stays disabled this long after a scene staging lands, so it can't
 *  enable on the exact frame the veil clears while the scene is still
 *  visually snapping in. */
export const TUTORIAL_SETTLE_DWELL_MS = 350;

const SCENE_SETTLE: SettleNeeds = { arrival: true, fov: false, totality: false, dwellMs: TUTORIAL_SETTLE_DWELL_MS };
// Surface settle is the eclipse card's: it also holds Next for the totality moment.
const SURFACE_SETTLE: SettleNeeds = { arrival: true, fov: true, totality: true, dwellMs: TUTORIAL_SETTLE_DWELL_MS };
const CARD_ONLY_SETTLE: SettleNeeds = { arrival: false, fov: false, totality: false, dwellMs: 0 };

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'welcome',
    title: 'A quick look around',
    body: 'Four stops: Saturn, the Moon, Jupiter with time sped up, and a total solar eclipse. The tutorial does the flying and shows you the button behind each move; you can always drag to look around.',
    primaryLabel: 'Start the tutorial',
    ghostLabel: 'Not now',
    stage: 'none',
    settle: CARD_ONLY_SETTLE,
  },
  {
    id: 'saturn',
    title: 'Saturn',
    body: 'That was the \u{1F680} button at the top right, or T: every planet and moon, one tap each. Take a second with the rings.',
    primaryLabel: 'Next: the Moon',
    ghostLabel: 'Skip tutorial',
    stage: 'saturn',
    settle: SCENE_SETTLE,
  },
  {
    id: 'moon',
    title: 'Landed on the Moon',
    body: 'This time it was the \u{1F52D} Observatory button, or O: it lands you on the world instead of stopping beside it. That’s Earth overhead, and the panel follows this sky. Leave, top right, lifts you off.',
    primaryLabel: 'Next: Jupiter',
    ghostLabel: 'Skip tutorial',
    stage: 'moon',
    settle: SCENE_SETTLE,
  },
  {
    id: 'timelapse',
    title: 'Jupiter in fast-forward',
    body: 'Two hours pass every second here: Jupiter spins through a full day in five, and Io laps it in about twenty. The clock at the bottom of the screen does this; tap it to set the speed or jump to a date. The Observatory panel keeps up alongside.',
    primaryLabel: 'Next: the eclipse',
    ghostLabel: 'Skip tutorial',
    stage: 'timelapse',
    settle: SCENE_SETTLE,
  },
  {
    id: 'eclipse',
    title: 'August 2, 2027',
    body: 'You’re standing on Earth, right where the Moon’s shadow is about to sweep past. Watch the Sun: the Moon is closing on it. Wherever you land, the Observatory panel lists eclipses like this; Jump takes you there.',
    totalityBody:
      'Totality. The Moon covers the whole Sun; only the glow at the rim gets past. Standing in one spot you’d get six minutes of this, the longest over land this century.',
    primaryLabel: 'Next: wrap up',
    ghostLabel: 'Skip tutorial',
    stage: 'eclipse',
    settle: SURFACE_SETTLE,
  },
  {
    id: 'wrap',
    title: 'That’s the tutorial',
    body: '\u{1F680} Teleport (T) parks you beside any planet or moon; \u{1F52D} Observatory (O) lands you on one and reads its sky; the clock at the bottom sets the speed and the date. Help, Historic Journeys, and this tutorial live in the ☰ menu.',
    primaryLabel: 'End tutorial',
    ghostLabel: null,
    stage: 'none',
    settle: CARD_ONLY_SETTLE,
  },
];

/**
 * The tutorial's showcase eclipse: the total solar eclipse of 2027-08-02 —
 * 6m23s at greatest eclipse, the longest totality over land this century.
 * Searched forward from a fixed date so every tutorial finds the same event no
 * matter where the sim clock sits; shadows.test.ts pins this exact search
 * (same spec, same from-date) to the EclipseWise peak within 20 minutes.
 * Always stage from the engine's returned event, never from the expected
 * values — they exist for the pin test and a degenerate-search guard.
 */
export const TUTORIAL_ECLIPSE = {
  spec: { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' } as ShadowEventSpec,
  searchFromUtcMs: Date.parse('2027-07-01T00:00:00Z'),
  expectedPeakUtcMs: Date.parse('2027-08-02T10:06:41Z'),
};

/** Time-lapse card rate — 2 hr/s over Jupiter: a full rotation every ~5 s with
 *  the Galilean moons visibly wheeling (Io laps in ~21 s). Deliberately off the
 *  −/+ stepper's preset ladder (1 hr/s felt slow, 6 hr/s frantic): every rate
 *  readout formats the live value, and stepSimulationRate snaps off-ladder
 *  magnitudes back onto the ladder. */
export const TUTORIAL_TIMELAPSE_RATE = 7200;

/** Eclipse approach rate — the "20 min/s" preset: the ~2 h from first contact
 *  to peak plays as a few seconds of the Moon biting into the Sun. */
export const TUTORIAL_ECLIPSE_APPROACH_RATE = 1200;

/**
 * How far before the eclipse peak the tutorial drops the rate back to 1×.
 * ShadowEvent carries only the outer penumbral contacts and the peak — no
 * second/third-contact times — so this lead comes from the published
 * circumstances of the one fixed event above: at the point of greatest
 * eclipse, totality begins ≈191.5 s before peak (EclipseWise). Settling just
 * inside that means the Sun is already fully covered when realtime resumes,
 * and the umbral-spot-riding surface camera keeps it covered for as long as
 * the user lingers. Frame granularity at 1200× overshoots by ≤ ~20 s of sim
 * time — still deep inside totality. Validated visually in QA, not by the
 * pin test.
 */
export const TUTORIAL_TOTALITY_SETTLE_LEAD_MS = 190_000;

/** The instant the eclipse step settles to realtime (single definition of the sign). */
export function totalitySettleUtcMs(peakUtcMs: number): number {
  return peakUtcMs - TUTORIAL_TOTALITY_SETTLE_LEAD_MS;
}

/**
 * Per-step phase machine. 'staging' = scene work requested (theater playing,
 * arrival pending); 'settling' = staged, waiting for the busy signals to
 * clear; 'ready' = Next enabled; 'ending' = a stop was requested while an
 * arrival was in flight and the restore runs on the first idle frame.
 */
export type TutorialPhase = 'staging' | 'settling' | 'ready' | 'ending';

export type TutorialTransitionEvent = 'next' | 'back' | 'staged' | 'settled' | 'skip' | 'abort';

/** Guarded transitions; anything not listed is a no-op, so a stale event
 *  (a timer or arrival callback landing late) can never move the phase backwards. */
export function tutorialTransition(phase: TutorialPhase, event: TutorialTransitionEvent): TutorialPhase {
  switch (event) {
    case 'next':
    case 'back': // both directions re-stage; stagings are absolute, so which step is the driver's index math
      return phase === 'ready' ? 'staging' : phase;
    case 'staged':
      return phase === 'staging' ? 'settling' : phase;
    case 'settled':
      return phase === 'settling' ? 'ready' : phase;
    case 'skip':
    case 'abort':
      return 'ending';
  }
}

/** Live busy signals sampled by the per-frame tutorial update. */
export interface SettleSignals {
  arrivalInFlight: boolean;
  veilCovering: boolean;
  fovAnimating: boolean;
  totalityReached: boolean;
  sinceStagedMs: number;
}

/** Whether a staged step has finished visually arriving (gates 'settling' → 'ready'). */
export function isStepSettled(signals: SettleSignals, needs: SettleNeeds): boolean {
  if (needs.arrival && (signals.arrivalInFlight || signals.veilCovering)) return false;
  if (needs.fov && signals.fovAnimating) return false;
  if (needs.totality && !signals.totalityReached) return false;
  return signals.sinceStagedMs >= needs.dwellMs;
}

export interface RestoreContext {
  /** The pre-tutorial snapshot was landed on this body (null = cruising). */
  snapshotLandedOn: string | null;
  /** The pre-tutorial snapshot had the observatory panel open. */
  panelWasOpen: boolean;
  /** Currently in surface view. */
  inSurfaceView: boolean;
  /** Currently landed on this body (null = cruising). */
  landedOn: string | null;
  /** Mode deactivation / mission start / new journey — anything that must
   *  finish restoring before its own teardown continues. */
  lifecycleAbort: boolean;
}

/** The sequencing decisions stopTutorial executes in order. */
export interface RestorePlan {
  /** Leave surface view (instant) before any landed-state change. */
  exitSurfaceView: boolean;
  /** Landed now but the snapshot was cruising: take off before restoring. */
  exitLandedFirst: boolean;
  /** Route the restore through a veil-gated arrival. Forced off for lifecycle
   *  aborts: a veil-gated arrival is silently dropped when another arrival is
   *  already in flight, and a lifecycle abort cannot wait — it must restore
   *  synchronously (the landed re-entry paints cold systems synchronously,
   *  so the sync path is safe, just less pretty). */
  veilGate: boolean;
  /** Reopen the observatory panel once re-landed. */
  reopenPanel: boolean;
}

export function restorePlan(ctx: RestoreContext): RestorePlan {
  return {
    exitSurfaceView: ctx.inSurfaceView,
    exitLandedFirst: ctx.landedOn !== null && ctx.snapshotLandedOn === null,
    veilGate: !ctx.lifecycleAbort && ctx.snapshotLandedOn !== null,
    reopenPanel: ctx.panelWasOpen && ctx.snapshotLandedOn !== null,
  };
}

/** The tutorial never starts over a mission, under the resume prompt, or twice. */
export function canStartTutorial(ctx: {
  missionActive: boolean;
  resumePromptVisible: boolean;
  alreadyActive: boolean;
}): boolean {
  return !ctx.missionActive && !ctx.resumePromptVisible && !ctx.alreadyActive;
}
