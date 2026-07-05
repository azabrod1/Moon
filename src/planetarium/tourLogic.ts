/**
 * Pure logic for the guided tour — the Next-driven click-through that stages
 * the app's showcase scenes (Saturn's rings, standing on the Moon, time-lapse,
 * a total solar eclipse). DOM-free so the step table, the phase machine, and
 * the restore/settle decisions stay unit-testable; PlanetariumMode owns the
 * scene staging and the card widget.
 */
import type { ShadowEventSpec } from '../astronomy/shadows';

export type TourStepId = 'welcome' | 'saturn' | 'moon' | 'timelapse' | 'eclipse' | 'wrap';

/** What the controller must stage when a step becomes current ('none' = card only). */
export type TourStage = 'none' | 'saturn' | 'moon' | 'timelapse' | 'eclipse';

/** Which busy signals gate a step's Next button (see isStepSettled). */
export interface SettleNeeds {
  /** Wait out arrivals: no in-flight veil-gated teleport, no covering veil. */
  arrival: boolean;
  /** Wait out the surface-view entry FOV glide. */
  fov: boolean;
  /** Minimum time since staging completed before Next enables. */
  dwellMs: number;
}

export interface TourStep {
  id: TourStepId;
  /** Card headline (the eyebrow is always "Tour"). */
  title: string;
  body: string;
  /** Eclipse card swaps to this once the clock settles into totality. */
  totalityBody?: string;
  /** Dimmer second paragraph (the wrap card's stay-or-return question). */
  caption?: string;
  /** Primary button. Advances the tour everywhere except the wrap card, where it restores. */
  primaryLabel: string;
  /** Ghost button. Skips (and restores) everywhere except the wrap card, where it stays put. */
  ghostLabel: string;
  stage: TourStage;
  settle: SettleNeeds;
}

/** Next stays disabled this long after a scene staging lands, so it can't
 *  enable on the exact frame the veil clears while the scene is still
 *  visually snapping in. */
export const TOUR_SETTLE_DWELL_MS = 350;

const SCENE_SETTLE: SettleNeeds = { arrival: true, fov: false, dwellMs: TOUR_SETTLE_DWELL_MS };
const SURFACE_SETTLE: SettleNeeds = { arrival: true, fov: true, dwellMs: TOUR_SETTLE_DWELL_MS };
const CARD_ONLY_SETTLE: SettleNeeds = { arrival: false, fov: false, dwellMs: 0 };

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'A quick look around',
    body: 'Three stops: Saturn, the Moon, and a total solar eclipse. The tour does the flying; you can drag to look around at any stop.',
    primaryLabel: 'Start the tour',
    ghostLabel: 'Not now',
    stage: 'none',
    settle: CARD_ONLY_SETTLE,
  },
  {
    id: 'saturn',
    title: 'Saturn',
    body: 'That was the deck: the \u{1F680} button up top, or T. Every planet and moon is one tap away. Take a second with the rings.',
    primaryLabel: 'Next: the Moon',
    ghostLabel: 'Skip tour',
    stage: 'saturn',
    settle: SCENE_SETTLE,
  },
  {
    id: 'moon',
    title: 'Standing on the Moon',
    body: 'Same deck, Observatory tab: this one lands you on the body. That’s Earth up there. The panel shows its phase and what’s coming up in this sky.',
    primaryLabel: 'Next: let time run',
    ghostLabel: 'Skip tour',
    stage: 'moon',
    settle: SCENE_SETTLE,
  },
  {
    id: 'timelapse',
    title: 'Let time run',
    body: 'An hour passes every second now. Earth stays put in the Moon’s sky, spinning slowly. The time controls below do this anytime.',
    primaryLabel: 'Next: a solar eclipse',
    ghostLabel: 'Skip tour',
    stage: 'timelapse',
    settle: SURFACE_SETTLE,
  },
  {
    id: 'eclipse',
    title: 'August 2, 2027',
    body: 'You’re on Earth now, standing right in the path of the Moon’s shadow. Watch the Sun.',
    totalityBody:
      'Totality. The Moon covers the whole Sun; only the glow at the rim gets past. Standing in one spot you’d get six minutes of this, the longest over land this century.',
    primaryLabel: 'Next: wrap up',
    ghostLabel: 'Skip tour',
    stage: 'eclipse',
    settle: SURFACE_SETTLE,
  },
  {
    id: 'wrap',
    title: 'That’s the tour',
    body: 'Teleport drops you beside a body. Observatory lands you on one. Historic Journeys and this tour live in the ☰ menu.',
    caption: 'Stay in 2027, or go back to where and when you started?',
    primaryLabel: 'Take me back',
    ghostLabel: 'Stay here',
    stage: 'none',
    settle: CARD_ONLY_SETTLE,
  },
];

/**
 * The tour's showcase eclipse: the total solar eclipse of 2027-08-02 —
 * 6m23s at greatest eclipse, the longest totality over land this century.
 * Searched forward from a fixed date so every tour finds the same event no
 * matter where the sim clock sits; shadows.test.ts pins this exact search
 * (same spec, same from-date) to the EclipseWise peak within 20 minutes.
 * Always stage from the engine's returned event, never from the expected
 * values — they exist for the pin test and a degenerate-search guard.
 */
export const TOUR_ECLIPSE = {
  spec: { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' } as ShadowEventSpec,
  searchFromUtcMs: Date.parse('2027-07-01T00:00:00Z'),
  expectedPeakUtcMs: Date.parse('2027-08-02T10:06:41Z'),
};

/** Time-lapse card rate — the transport strip's "1 hr/s" preset, fast enough
 *  that Earth visibly rotates (a turn every 24 s) while the sky wheels gently. */
export const TOUR_TIMELAPSE_RATE = 3600;

/** Eclipse approach rate — the "20 min/s" preset: the ~2 h from first contact
 *  to peak plays as a few seconds of the Moon biting into the Sun. */
export const TOUR_ECLIPSE_APPROACH_RATE = 1200;

/**
 * How far before the eclipse peak the tour drops the rate back to 1×.
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
export const TOUR_TOTALITY_SETTLE_LEAD_MS = 190_000;

/** The instant the eclipse step settles to realtime (single definition of the sign). */
export function totalitySettleUtcMs(peakUtcMs: number): number {
  return peakUtcMs - TOUR_TOTALITY_SETTLE_LEAD_MS;
}

/**
 * Per-step phase machine. 'staging' = scene work requested (theater playing,
 * arrival pending); 'settling' = staged, waiting for the busy signals to
 * clear; 'ready' = Next enabled; 'ending' = a stop was requested while an
 * arrival was in flight and the restore runs on the first idle frame.
 */
export type TourPhase = 'staging' | 'settling' | 'ready' | 'ending';

export type TourTransitionEvent = 'next' | 'staged' | 'settled' | 'skip' | 'abort';

/** Guarded transitions; anything not listed is a no-op, so a stale event
 *  (a timer or arrival callback landing late) can never move the phase backwards. */
export function tourTransition(phase: TourPhase, event: TourTransitionEvent): TourPhase {
  switch (event) {
    case 'next':
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

/** Live busy signals sampled by the per-frame tour update. */
export interface SettleSignals {
  arrivalInFlight: boolean;
  veilCovering: boolean;
  fovAnimating: boolean;
  sinceStagedMs: number;
}

/** Whether a staged step has finished visually arriving (gates 'settling' → 'ready'). */
export function isStepSettled(signals: SettleSignals, needs: SettleNeeds): boolean {
  if (needs.arrival && (signals.arrivalInFlight || signals.veilCovering)) return false;
  if (needs.fov && signals.fovAnimating) return false;
  return signals.sinceStagedMs >= needs.dwellMs;
}

export interface RestoreContext {
  /** The pre-tour snapshot was landed on this body (null = cruising). */
  snapshotLandedOn: string | null;
  /** The pre-tour snapshot had the observatory panel open. */
  panelWasOpen: boolean;
  /** Currently in surface view. */
  inSurfaceView: boolean;
  /** Currently landed on this body (null = cruising). */
  landedOn: string | null;
  /** Mode deactivation / mission start / new journey — anything that must
   *  finish restoring before its own teardown continues. */
  lifecycleAbort: boolean;
}

/** The sequencing decisions stopTour executes in order. */
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

/** The tour never starts over a mission, under the resume prompt, or twice. */
export function canStartTour(ctx: {
  missionActive: boolean;
  resumePromptVisible: boolean;
  alreadyActive: boolean;
}): boolean {
  return !ctx.missionActive && !ctx.resumePromptVisible && !ctx.alreadyActive;
}
