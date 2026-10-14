/**
 * Pure logic for the guided tutorial — the Next-driven click-through that stages
 * the app's showcase scenes (Saturn's rings, standing on the Moon, time-lapse,
 * a total solar eclipse). Choosing the tour is the decision, so every entry
 * stages the first stop at once: there is no welcome card, and the first
 * stop's staging copy carries the one-line introduction. DOM-free so the step
 * table, the beats, the phase machine, and the restore/settle decisions stay
 * unit-testable; PlanetariumMode owns the scene staging and the card widget.
 */
import type { ShadowEventSpec } from '../astronomy/shadows';
import { TIME_RATE_PRESETS } from './timeRates';

export type TutorialStepId = 'saturn' | 'moon' | 'timelapse' | 'eclipse' | 'wrap';

/** A wrap-card chip: the action it performs after the restore, and its label. */
export type TutorialChipId = 'visit-mars' | 'earth-from-moon' | 'follow-voyager';
export interface TutorialChip {
  id: TutorialChipId;
  label: string;
}

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
  /** Mono line under the title for the place or the date; null for none. A
   *  stop that states a fact about the sky overrides it live (PlanetariumMode). */
  kicker: string | null;
  /** May contain {teleport}/{observatory} tokens — the card renders them as
   *  clones of the live action-button SVGs, so the glyph the copy points at is
   *  the glyph on screen (see tutorialBodySegments in TutorialCard). */
  body: string;
  /** Copy while the stop is still staging — the beats playing, the arrival
   *  pending; `body` takes over once the scene has landed. Absent: `body` throughout. */
  bodyDuring?: string;
  /** The demonstration played before the arrival (see TutorialBeat); absent
   *  for a stop that stages in one move. */
  beats?: readonly TutorialBeat[];
  /** The card once the eclipse reaches totality: the climax gets its own words. */
  totality?: { title: string; kicker: string; body: string };
  /** The wrap's doors: each restores the journey, then does what its label says. */
  chips?: readonly TutorialChip[];
  /** Primary button. Advances the tutorial everywhere except the wrap card, where it restores. */
  primaryLabel: string;
  /** Ghost skip button; null on the wrap card — ending the tutorial always takes
   *  you back to where and when you started. */
  ghostLabel: string | null;
  stage: TutorialStage;
  settle: SettleNeeds;
}

// ── Beats ─────────────────────────────────────────────────────────────────────
// A stop's demonstration is a list of beats: ring a control, hold long enough
// to read, press it for real, let its consequence land, then the next. The
// runner (stepBeatRun) is a pure reducer over visible wall time so the holds,
// the press and the fall-through for a missing control are all testable;
// PlanetariumMode performs the effects it returns.

/** A control the spotlight can ring, by what it is rather than by element. */
export type TutorialTargetRef =
  | { kind: 'chip'; id: 'planetarium-btn-travel' | 'planetarium-btn-observatory' | 'planetarium-btn-menu' }
  /** A deck row, on the tab the beat means: the same row on another tab is a different control. */
  | { kind: 'deck-row'; name: string; verb: 'travel' | 'observe' }
  /** The Observatory panel's Look up window. */
  | { kind: 'panel-window' }
  /** One of the panel's almanac arrows, by its element id. */
  | { kind: 'panel-step'; id: 'observatory-next-solar' }
  /** The time rail with its clock, at the bottom of the screen. */
  | { kind: 'time-rail' };

/** The scene work a beat's press stands for. The host performs it and reports
 *  when it has landed (the deck open with the row in view; the arrival done;
 *  the panel open; the surface view up). 'arrive' is the tour's own composed
 *  arrival; 'observe' is the deck row's real commit, the Observatory landing. */
export type TutorialPerform =
  | { kind: 'none' }
  | { kind: 'open-deck'; verb: 'travel' | 'observe'; reveal: string }
  | { kind: 'arrive' }
  | { kind: 'observe'; name: string; parentPlanet?: string }
  | { kind: 'open-panel' }
  | { kind: 'look-up' }
  /** Step the clock up the real ladder, one detent every `stepMs`, flashing each. */
  | { kind: 'rate-ladder'; rates: readonly number[]; stepMs: number }
  /** The panel's own almanac jump: the next event of this type from the clock. */
  | { kind: 'jump'; type: 'solar-eclipse'; direction: 1 }
  /** Back to the jumped-to event's first contact, at realtime. */
  | { kind: 'rewind' }
  /** Declutter the surface view and run the clock at this rate toward the climax. */
  | { kind: 'approach'; rate: number };

export interface TutorialBeat {
  id: string;
  /** What the spotlight rings and names while the beat holds; null clears it
   *  (the consequence on screen is the thing to look at). `key` is the
   *  keyboard shortcut, shown as a chip on pointer devices only. */
  spotlight: { target: TutorialTargetRef; label: string; key?: string } | null;
  /** Press the spotlight's control once the hold has passed (a visible press
   *  on the real control, then `perform`). */
  press: boolean;
  perform: TutorialPerform;
  /** The least the beat stays on screen before its press, in visible wall
   *  time — a frame's dt, not a timer, so a hidden tab pauses it. */
  minHoldMs: number;
  /** Caption on the arrival veil, shown from its first frame, when `perform` raises one. */
  veilNote?: string;
  /** "You try": after its hold the beat waits, without a deadline, for the
   *  user's own press on the control (recognised when it starts) — or for
   *  "Show me", which the card's primary reads meanwhile and which presses
   *  the control for them. Both end in the same perform and the same guard. */
  await?: boolean;
  /** Card copy while this beat is current, over the step's staging copy. */
  body?: string;
}

/** The visible press on the real control: scale and the chip's own on-colour. */
export const TUTORIAL_PRESS_MS = 180;

/** A beat's hold is a minimum readable time, never a deadline. */
export const TUTORIAL_BEAT_HOLD_MS = 1400;

const MOON_LANDED_BODY =
  'You’re standing on the Moon. The panel reads this sky: phases, distances, and what happens next.';

const MOON_BEATS: readonly TutorialBeat[] = [
  {
    id: 'observatory-chip',
    spotlight: { target: { kind: 'chip', id: 'planetarium-btn-observatory' }, label: 'Observatory', key: 'O' },
    press: true,
    perform: { kind: 'open-deck', verb: 'observe', reveal: 'Moon' },
    minHoldMs: TUTORIAL_BEAT_HOLD_MS,
  },
  {
    id: 'moon-row',
    spotlight: { target: { kind: 'deck-row', name: 'Moon', verb: 'observe' }, label: 'Tap the Moon' },
    press: true,
    await: true,
    perform: { kind: 'observe', name: 'Moon', parentPlanet: 'Earth' },
    minHoldMs: 0,
    veilNote: 'Landing on the Moon…',
  },
  // Picture first: two seconds of the Moon from orbit, then the panel.
  {
    id: 'moon-picture',
    spotlight: null,
    press: false,
    perform: { kind: 'open-panel' },
    minHoldMs: 2000,
    body: MOON_LANDED_BODY,
  },
  {
    id: 'look-up',
    spotlight: { target: { kind: 'panel-window' }, label: 'Look up' },
    press: true,
    perform: { kind: 'look-up' },
    minHoldMs: TUTORIAL_BEAT_HOLD_MS,
    body: MOON_LANDED_BODY,
  },
];

/** The detents the Jupiter stop climbs: 1 min/s, 20 min/s, 1 hr/s — real
 *  rungs of the shared ladder, so the rail's thumb lands where a tap could. */
export const TUTORIAL_RATE_LADDER: readonly number[] = TIME_RATE_PRESETS.slice(1, 4);

const JUPITER_BEATS: readonly TutorialBeat[] = [
  { id: 'jupiter-arrive', spotlight: null, press: false, perform: { kind: 'arrive' }, minHoldMs: 0, veilNote: 'Landing on Jupiter…' },
  {
    id: 'time-rail',
    spotlight: { target: { kind: 'time-rail' }, label: 'Time' },
    press: false,
    perform: { kind: 'rate-ladder', rates: TUTORIAL_RATE_LADDER, stepMs: 700 },
    minHoldMs: 1200,
  },
];

const ECLIPSE_REWIND_BODY = 'Let’s rewind to first contact and watch it begin.';

const ECLIPSE_BEATS: readonly TutorialBeat[] = [
  { id: 'earth-arrive', spotlight: null, press: false, perform: { kind: 'arrive' }, minHoldMs: 0, veilNote: 'Landing on Earth…' },
  {
    id: 'next-solar',
    spotlight: { target: { kind: 'panel-step', id: 'observatory-next-solar' }, label: 'Next eclipse' },
    press: true,
    perform: { kind: 'jump', type: 'solar-eclipse', direction: 1 },
    minHoldMs: TUTORIAL_BEAT_HOLD_MS,
    body: 'From any world, the panel lists the eclipses to come. The arrow jumps to the next one.',
  },
  {
    id: 'jumped',
    spotlight: null,
    press: false,
    perform: { kind: 'none' },
    minHoldMs: 2600,
    body: 'That parks you three minutes before the peak, on 2 August 2027.',
  },
  { id: 'rewind', spotlight: null, press: false, perform: { kind: 'rewind' }, minHoldMs: 400, body: ECLIPSE_REWIND_BODY },
  {
    id: 'look-up',
    spotlight: { target: { kind: 'panel-window' }, label: 'Look up' },
    press: true,
    perform: { kind: 'look-up' },
    minHoldMs: 1800,
    body: ECLIPSE_REWIND_BODY,
  },
  { id: 'approach', spotlight: null, press: false, perform: { kind: 'approach', rate: 1200 }, minHoldMs: 0 },
];

const SATURN_BEATS: readonly TutorialBeat[] = [
  {
    id: 'teleport-chip',
    spotlight: { target: { kind: 'chip', id: 'planetarium-btn-travel' }, label: 'Teleport', key: 'T' },
    press: true,
    perform: { kind: 'open-deck', verb: 'travel', reveal: 'Saturn' },
    minHoldMs: TUTORIAL_BEAT_HOLD_MS,
  },
  {
    id: 'saturn-row',
    spotlight: { target: { kind: 'deck-row', name: 'Saturn', verb: 'travel' }, label: 'Tap any planet or moon' },
    press: true,
    perform: { kind: 'arrive' },
    minHoldMs: TUTORIAL_BEAT_HOLD_MS,
    veilNote: 'Teleporting to Saturn…',
  },
];

/** Next stays disabled this long after a scene staging lands, so it can't
 *  enable on the exact frame the veil clears while the scene is still
 *  visually snapping in. */
export const TUTORIAL_SETTLE_DWELL_MS = 350;

const SCENE_SETTLE: SettleNeeds = { arrival: true, fov: false, totality: false, dwellMs: TUTORIAL_SETTLE_DWELL_MS };
// A stop that ends in surface view waits out the entry glide too.
const LOOKUP_SETTLE: SettleNeeds = { arrival: true, fov: true, totality: false, dwellMs: TUTORIAL_SETTLE_DWELL_MS };
// Surface settle is the eclipse card's: it also holds Next for the totality moment.
const SURFACE_SETTLE: SettleNeeds = { arrival: true, fov: true, totality: true, dwellMs: TUTORIAL_SETTLE_DWELL_MS };
const CARD_ONLY_SETTLE: SettleNeeds = { arrival: false, fov: false, totality: false, dwellMs: 0 };

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'saturn',
    title: 'Teleport',
    kicker: 'Saturn',
    bodyDuring: 'Four stops, about two minutes. First, {teleport} Teleport: this button jumps you to any planet or moon. We’re going to Saturn.',
    body: 'One tap, anywhere in the solar system. Drag to look around.',
    beats: SATURN_BEATS,
    // Skip reads "Skip tutorial" here too: a skip before the first arrival
    // restores nothing, because nothing has moved yet (everStaged).
    primaryLabel: 'Next: the Moon',
    ghostLabel: 'Skip tutorial',
    stage: 'saturn',
    settle: SCENE_SETTLE,
  },
  {
    id: 'moon',
    title: 'Stand on a world',
    kicker: 'The Moon',
    bodyDuring: 'The {observatory} Observatory lands you on a world. Tap the Moon.',
    // The kicker is live once the view is up: Earth's phase as the panel reads it.
    body: 'Look up, and there is Earth.',
    beats: MOON_BEATS,
    primaryLabel: 'Next: speed up time',
    ghostLabel: 'Skip tutorial',
    stage: 'moon',
    settle: LOOKUP_SETTLE,
  },
  {
    id: 'timelapse',
    title: 'Speed up time',
    kicker: 'Jupiter · 1 hr/s',
    bodyDuring: 'Next, time. The clock at the bottom of the screen sets the speed; let’s run it up.',
    body: 'An hour passes every second. Jupiter turns once in ten seconds; Io laps it in forty-two. Tap a notch on the rail for any speed, or tap the date to jump.',
    beats: JUPITER_BEATS,
    primaryLabel: 'Next: an eclipse',
    ghostLabel: 'Skip tutorial',
    stage: 'timelapse',
    settle: SCENE_SETTLE,
  },
  {
    id: 'eclipse',
    title: 'A total solar eclipse',
    kicker: 'From Earth · 2 August 2027',
    bodyDuring: 'Last stop: Earth, and the sky’s best show.',
    // Settling is the approach: the kicker counts down to the peak live.
    body: 'The Moon is crossing the Sun at twenty minutes a second. Stay with it.',
    beats: ECLIPSE_BEATS,
    totality: {
      title: 'Totality',
      kicker: '6 minutes · the longest on land this century',
      body: 'The Sun’s corona, from the ground. You can drag to look around; the clock is back to realtime.',
    },
    primaryLabel: 'Next: wrap up',
    ghostLabel: 'Skip tutorial',
    stage: 'eclipse',
    settle: SURFACE_SETTLE,
  },
  {
    id: 'wrap',
    title: 'That’s the tour',
    kicker: null,
    body: '{teleport} Teleport jumps. {observatory} Observatory lands and reads the sky. The clock bends time. Help and the historic journeys live in the ☰ menu.',
    // A door, not a summary: three things to try next, each from where you started.
    chips: [
      { id: 'visit-mars', label: 'Visit Mars' },
      { id: 'earth-from-moon', label: 'Earth from the Moon' },
      { id: 'follow-voyager', label: 'Follow Voyager 1' },
    ],
    primaryLabel: 'Back where I was',
    ghostLabel: null,
    stage: 'none',
    settle: CARD_ONLY_SETTLE,
  },
];

/** The stops the progress dots count: every scene-staged step, in order. */
export const TUTORIAL_STOP_COUNT = TUTORIAL_STEPS.filter((step) => step.stage !== 'none').length;

/** 1-based number of a step among the stops, or null for a card-only bookend. */
export function tutorialStopNumber(index: number): number | null {
  const step = TUTORIAL_STEPS[index];
  if (!step || step.stage === 'none') return null;
  return TUTORIAL_STEPS.slice(0, index + 1).filter((s) => s.stage !== 'none').length;
}

/** Progress for the card's dots and its screen-reader counter. */
export function tutorialProgress(index: number): { count: number; current: number | null; done: number; label: string } {
  const current = tutorialStopNumber(index);
  if (current !== null) {
    return { count: TUTORIAL_STOP_COUNT, current, done: current - 1, label: `Stop ${current} of ${TUTORIAL_STOP_COUNT}` };
  }
  const before = TUTORIAL_STEPS.slice(0, index).filter((s) => s.stage !== 'none').length;
  return { count: TUTORIAL_STOP_COUNT, current: null, done: before, label: `All ${before} stops seen` };
}

export interface BeatRunState {
  index: number;
  /** 'enter' shows the beat's spotlight; 'hold' counts visible time; 'await'
   *  is a you-try beat waiting for the user (no deadline); 'press' is the
   *  visible press; 'perform' waits for the host's scene work; 'done' means
   *  the list has finished and the host should mark the step staged. */
  stage: 'enter' | 'hold' | 'await' | 'press' | 'perform' | 'done';
  heldMs: number;
  pressedMs: number;
}

export function initialBeatRun(): BeatRunState {
  return { index: 0, stage: 'enter', heldMs: 0, pressedMs: 0 };
}

/** What the host reports each frame. */
export interface BeatSignals {
  /** Visible wall time since the last frame (clamped by the host; zero while hidden). */
  dtMs: number;
  /** A transient overlay (☰, the time panel, stats, Tools, the map) has the
   *  screen: the hold waits for it to close rather than fighting the user. */
  paused: boolean;
  /** The beat's control exists on screen right now. */
  targetPresent: boolean;
  /** The beat's perform has landed. */
  performed: boolean;
  /** The user pressed the awaited control themselves (their press is the
   *  perform, already under way). Read on await beats only. */
  userActed: boolean;
  /** "Show me" was pressed this frame (one-shot). Read in the await stage only. */
  showMe: boolean;
}

export type BeatEffect =
  | { kind: 'spotlight'; beat: TutorialBeat; present: boolean }
  | { kind: 'press-down'; beat: TutorialBeat }
  | { kind: 'press-up'; beat: TutorialBeat }
  | { kind: 'perform'; beat: TutorialBeat }
  | { kind: 'finish' };

/**
 * One frame of a beat list. Effects are returned in the order the host must
 * apply them. A beat ends only when its hold has passed AND its perform has
 * landed, never on the hold alone; a control that is not on screen skips the
 * spotlight and the press but keeps the hold (the card narrates on) and still
 * performs, so a missing element can never strand the stop. A you-try beat
 * waits after its hold for the user's own press (recognised at its start,
 * even mid-hold) or for "Show me"; both end in the same perform and the same
 * landed guard.
 */
export function stepBeatRun(
  beats: readonly TutorialBeat[],
  state: BeatRunState,
  signals: BeatSignals,
): { state: BeatRunState; effects: BeatEffect[] } {
  const effects: BeatEffect[] = [];
  let next: BeatRunState = { ...state };
  if (next.stage === 'done') return { state: next, effects };
  const beat = beats[next.index];
  if (!beat) {
    next.stage = 'done';
    effects.push({ kind: 'finish' });
    return { state: next, effects };
  }
  const startPerform = () => {
    if (beat.perform.kind === 'none') {
      advance();
      return;
    }
    next.stage = 'perform';
    effects.push({ kind: 'perform', beat });
  };
  const advance = () => {
    next = { index: next.index + 1, stage: 'enter', heldMs: 0, pressedMs: 0 };
    if (next.index >= beats.length) {
      next.stage = 'done';
      effects.push({ kind: 'finish' });
    }
  };
  switch (next.stage) {
    case 'enter':
      effects.push({ kind: 'spotlight', beat, present: signals.targetPresent });
      next.stage = 'hold';
      next.heldMs = 0;
      break;
    case 'hold':
      if (beat.await && signals.userActed) {
        // Their press is the perform, already under way: wait for it to land.
        next.stage = 'perform';
        break;
      }
      if (!signals.paused) next.heldMs += signals.dtMs;
      if (next.heldMs >= beat.minHoldMs) {
        if (beat.await) {
          next.stage = 'await';
        } else if (beat.press && beat.spotlight && signals.targetPresent) {
          next.stage = 'press';
          next.pressedMs = 0;
          effects.push({ kind: 'press-down', beat });
        } else {
          startPerform();
        }
      }
      break;
    case 'await':
      if (signals.userActed) {
        next.stage = 'perform';
      } else if (signals.showMe) {
        if (beat.press && beat.spotlight && signals.targetPresent) {
          next.stage = 'press';
          next.pressedMs = 0;
          effects.push({ kind: 'press-down', beat });
        } else {
          startPerform();
        }
      }
      break;
    case 'press':
      next.pressedMs += signals.dtMs;
      if (next.pressedMs >= TUTORIAL_PRESS_MS) {
        effects.push({ kind: 'press-up', beat });
        startPerform();
      }
      break;
    case 'perform':
      if (signals.performed) advance();
      break;
  }
  return { state: next, effects };
}

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

/** Time-lapse card rate — 1 hr/s over Jupiter: a full rotation every ~10 s
 *  with the Galilean moons visibly wheeling (Io laps in ~42 s). The top of the
 *  ladder the stop climbs, and a real detent: the rail's thumb lands where a
 *  tap of the user's own could put it, so the card can say so. */
export const TUTORIAL_TIMELAPSE_RATE = TUTORIAL_RATE_LADDER[TUTORIAL_RATE_LADDER.length - 1];

/** Eclipse approach rate — the "20 min/s" preset: the ~2 h from first contact
 *  to peak plays as a few seconds of the Moon biting into the Sun. */
export const TUTORIAL_ECLIPSE_APPROACH_RATE = 1200;

/**
 * How far before the eclipse peak the tutorial drops the rate back to 1×.
 * ShadowEvent carries only the outer penumbral contacts and the peak — no
 * second/third-contact times — so this lead comes from the published
 * circumstances of the one fixed event above: at the point of greatest
 * eclipse, totality begins ≈191.5 s before peak (EclipseWise). Settling just
 * inside that means the Sun is already fully covered when realtime resumes.
 * The observer stands still on the spot of greatest eclipse
 * (computeSpotAnchorLocal in surfaceView.ts), where totality lasts 6m23s
 * about the peak, so it ends the same lead after the peak — the window the
 * climax card is read inside (eclipseClockPhase). The render loop caps a
 * frame at 100 ms, so the approach at 1200× steps at most 120 s of sim time
 * a frame and cannot step over that window. Validated visually in QA, not
 * by the pin test.
 */
export const TUTORIAL_TOTALITY_SETTLE_LEAD_MS = 190_000;

/** The instant local totality ends at the standing spot: symmetric with the
 *  lead about the peak, just inside the published 6m23s. */
export function totalityEndUtcMs(peakUtcMs: number): number {
  return peakUtcMs + TUTORIAL_TOTALITY_SETTLE_LEAD_MS;
}

/** The instant the eclipse step settles to realtime (single definition of the sign). */
export function totalitySettleUtcMs(peakUtcMs: number): number {
  return peakUtcMs - TUTORIAL_TOTALITY_SETTLE_LEAD_MS;
}

/** A clock run back this far before the event's first contact still counts
 *  as approaching it (a reverse step from the rewind instant). */
export const TUTORIAL_ECLIPSE_APPROACH_MARGIN_MS = 60 * 60_000;

/**
 * Where the eclipse stop's clock stands against its event, since the time
 * controls stay live while Next is held for totality: 'approach' from a
 * little before first contact up to the settle instant, 'totality' from
 * there to the end of local totality at the standing spot, and 'away' once
 * the clock stands before the approach or past totality — the event's
 * partial tail included, where the Sun is back from behind the Moon —
 * whether it ran there or was moved by hand (a Now press, a date, a reverse
 * run). Away, the stop stops waiting for a totality that may never come,
 * and the climax card is never shown over the wrong sky.
 */
export function eclipseClockPhase(
  nowUtcMs: number,
  event: { startUtcMs: number; peakUtcMs: number },
): 'approach' | 'totality' | 'away' {
  const settle = totalitySettleUtcMs(event.peakUtcMs);
  if (nowUtcMs >= settle && nowUtcMs <= totalityEndUtcMs(event.peakUtcMs)) return 'totality';
  if (nowUtcMs >= event.startUtcMs - TUTORIAL_ECLIPSE_APPROACH_MARGIN_MS && nowUtcMs < settle) return 'approach';
  return 'away';
}

/**
 * Whether the eclipse card shows the climax right now: totality has been
 * reached (the one-shot that dropped the clock to realtime and released
 * Next) and the clock still stands inside local totality. A Now press, a
 * date, a fast run, or six minutes of realtime that carry the clock out
 * afterwards take the climax card down — the approach card with its live
 * kicker ("ends in 2h 30m", "ended 2h ago") is honest about the sky the
 * user is looking at — and a clock brought back in shows it again, without
 * touching the rate a second time.
 */
export function eclipseClimaxShown(
  totalityReached: boolean,
  nowUtcMs: number,
  event: { startUtcMs: number; peakUtcMs: number },
): boolean {
  return totalityReached && eclipseClockPhase(nowUtcMs, event) === 'totality';
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
  /** The pre-tutorial snapshot was in surface view (the tour exits it to
   *  stage, so the restore has to walk back in). */
  snapshotSurfaceView: boolean;
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
  /** Walk back into the surface view the snapshot was in, once re-landed.
   *  Never on a lifecycle abort: the caller's own teardown is about to tear
   *  the view down again, and the entry glide would run over it. */
  reenterSurfaceView: boolean;
}

export function restorePlan(ctx: RestoreContext): RestorePlan {
  return {
    exitSurfaceView: ctx.inSurfaceView,
    exitLandedFirst: ctx.landedOn !== null && ctx.snapshotLandedOn === null,
    veilGate: !ctx.lifecycleAbort && ctx.snapshotLandedOn !== null,
    reopenPanel: ctx.panelWasOpen && ctx.snapshotLandedOn !== null,
    reenterSurfaceView:
      !ctx.lifecycleAbort && ctx.snapshotSurfaceView && ctx.snapshotLandedOn !== null,
  };
}

/**
 * What a stop before the tour staged anything still has to put back. The
 * start itself makes one move — it leaves a surface view, because the
 * stagings need the orbit view — and a Skip or Esc during the first stop's
 * beats walks back into it: only while the ground is the same (an arrival
 * of the user's own is theirs to keep) and the user has not entered a
 * surface view of their own meanwhile. Everything else they did under the
 * card is theirs, and a lifecycle abort has no time for the entry glide.
 */
export function earlyRestorePlan(ctx: {
  snapshotLandedOn: string | null;
  snapshotSurfaceView: boolean;
  inSurfaceView: boolean;
  landedOn: string | null;
  lifecycleAbort: boolean;
}): { reenterSurfaceView: boolean } {
  return {
    reenterSurfaceView:
      !ctx.lifecycleAbort &&
      ctx.snapshotSurfaceView &&
      !ctx.inSurfaceView &&
      ctx.landedOn !== null &&
      ctx.landedOn === ctx.snapshotLandedOn,
  };
}

/**
 * Whether the clock the tour is about to take over was running at now: 1×,
 * not paused, within the live window of the wall clock. Recorded at entry,
 * because by the time the tour ends the snapshot's instant is minutes stale
 * and would restore as a clock that no longer reads live.
 */
export function clockWasLive(
  clock: { currentUtcMs: number; rate: number; paused: boolean },
  nowMs: number,
  driftMs: number,
): boolean {
  return !clock.paused && clock.rate === 1 && Math.abs(clock.currentUtcMs - nowMs) <= driftMs;
}

/** The instant a restore puts the clock at: now for a clock that was live,
 *  else exactly the instant the snapshot holds (a historical date, a paused
 *  clock, a warped rate all come back as they were). */
export function restoredClockUtcMs(snapshotUtcMs: number, wasLive: boolean, nowMs: number): number {
  return wasLive ? nowMs : snapshotUtcMs;
}

/** The tutorial never starts over a mission, under the resume prompt, or twice. */
export function canStartTutorial(ctx: {
  missionActive: boolean;
  resumePromptVisible: boolean;
  alreadyActive: boolean;
}): boolean {
  return !ctx.missionActive && !ctx.resumePromptVisible && !ctx.alreadyActive;
}
