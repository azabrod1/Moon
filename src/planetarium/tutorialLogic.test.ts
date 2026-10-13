import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_STEPS,
  TUTORIAL_ECLIPSE,
  TUTORIAL_TIMELAPSE_RATE,
  TUTORIAL_ECLIPSE_APPROACH_RATE,
  TUTORIAL_SETTLE_DWELL_MS,
  totalitySettleUtcMs,
  tutorialTransition,
  isStepSettled,
  restorePlan,
  canStartTutorial,
  clockWasLive,
  restoredClockUtcMs,
  TUTORIAL_STOP_COUNT,
  TUTORIAL_PRESS_MS,
  tutorialStopNumber,
  tutorialProgress,
  initialBeatRun,
  stepBeatRun,
} from './tutorialLogic';
import type {
  BeatRunState,
  BeatSignals,
  RestoreContext,
  SettleSignals,
  TutorialBeat,
  TutorialPhase,
  TutorialTransitionEvent,
} from './tutorialLogic';
import { findShadowEvent } from '../astronomy/shadows';
import { formatTimeRateLabel } from '../astronomy/planetary';

const MIN = 60_000;

describe('TUTORIAL_STEPS', () => {
  it('is the four stops and the wrap in order, ids unique — no welcome card, the first stop stages at once', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['saturn', 'moon', 'timelapse', 'eclipse', 'wrap']);
  });

  it('stages match the cards: the four stops scene-staged, the wrap card-only', () => {
    expect(TUTORIAL_STEPS.map((s) => s.stage)).toEqual(['saturn', 'moon', 'timelapse', 'eclipse', 'none']);
  });

  it('card-only steps settle instantly; staged steps wait out arrivals and dwell', () => {
    for (const step of TUTORIAL_STEPS) {
      if (step.stage === 'none') {
        expect(step.settle).toEqual({ arrival: false, fov: false, totality: false, dwellMs: 0 });
      } else {
        expect(step.settle.arrival).toBe(true);
        expect(step.settle.dwellMs).toBe(TUTORIAL_SETTLE_DWELL_MS);
      }
    }
  });

  it('the Moon and the eclipse end in surface view, so they wait out the FOV glide', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.settle.fov).toBe(step.stage === 'eclipse' || step.stage === 'moon');
    }
  });

  it('the Moon stop: ring and press the Observatory chip, then wait for the user on the Moon row, then picture, panel and Look up', () => {
    const moon = TUTORIAL_STEPS.find((s) => s.id === 'moon')!;
    expect(moon.beats?.map((b) => b.id)).toEqual(['observatory-chip', 'moon-row', 'moon-picture', 'look-up']);
    const [chip, row, picture, lookUp] = moon.beats!;
    expect(chip.perform).toEqual({ kind: 'open-deck', verb: 'observe', reveal: 'Moon' });
    expect(row.await).toBe(true);
    expect(row.minHoldMs).toBe(0);
    expect(row.perform).toEqual({ kind: 'observe', name: 'Moon', parentPlanet: 'Earth' });
    expect(row.veilNote).toMatch(/Moon/);
    // Two seconds of the Moon from orbit before the panel opens, then the window.
    expect(picture.spotlight).toBeNull();
    expect(picture.minHoldMs).toBe(2000);
    expect(picture.perform).toEqual({ kind: 'open-panel' });
    expect(lookUp.spotlight?.target).toEqual({ kind: 'panel-window' });
    expect(lookUp.perform).toEqual({ kind: 'look-up' });
    expect(picture.body).toBe(lookUp.body);
    expect(moon.bodyDuring).toMatch(/Tap the Moon/);
    expect(moon.body).toMatch(/Earth/);
    // Only one beat in the tour is a you-try.
    const awaiting = TUTORIAL_STEPS.flatMap((s) => s.beats ?? []).filter((b) => b.await);
    expect(awaiting.map((b) => b.id)).toEqual(['moon-row']);
  });

  it('only the eclipse holds Next for the totality moment', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.settle.totality).toBe(step.stage === 'eclipse');
    }
  });

  it('the stops are the four scene-staged steps; the wrap counts as after them', () => {
    expect(TUTORIAL_STOP_COUNT).toBe(4);
    expect(TUTORIAL_STEPS.map((_, i) => tutorialStopNumber(i))).toEqual([1, 2, 3, 4, null]);
    expect(tutorialProgress(0)).toEqual({ count: 4, current: 1, done: 0, label: 'Stop 1 of 4' });
    expect(tutorialProgress(1)).toEqual({ count: 4, current: 2, done: 1, label: 'Stop 2 of 4' });
    expect(tutorialProgress(4)).toEqual({ count: 4, current: null, done: 4, label: 'All 4 stops seen' });
  });

  it('Saturn plays its demonstration: ring and press the Teleport chip, then ring and press the Saturn row into the arrival', () => {
    const saturn = TUTORIAL_STEPS.find((s) => s.id === 'saturn')!;
    expect(saturn.beats?.map((b) => b.id)).toEqual(['teleport-chip', 'saturn-row']);
    const [chip, row] = saturn.beats!;
    expect(chip.spotlight?.target).toEqual({ kind: 'chip', id: 'planetarium-btn-travel' });
    expect(chip.spotlight?.key).toBe('T');
    expect(chip.press).toBe(true);
    expect(chip.perform).toEqual({ kind: 'open-deck', verb: 'travel', reveal: 'Saturn' });
    expect(row.spotlight?.target).toEqual({ kind: 'deck-row', name: 'Saturn' });
    expect(row.perform).toEqual({ kind: 'arrive' });
    expect(row.veilNote).toMatch(/Saturn/);
    // The copy while the beats play introduces the tour; the settled copy is the lesson.
    expect(saturn.bodyDuring).toMatch(/Four stops/);
    expect(saturn.body).not.toMatch(/Four stops/);
    // A beat that presses must have something to press.
    for (const step of TUTORIAL_STEPS) {
      for (const beat of step.beats ?? []) {
        if (beat.press) expect(beat.spotlight).not.toBeNull();
        // A hold is a minimum readable time; a you-try beat may offer Show me at once.
        if (!beat.await) expect(beat.minHoldMs).toBeGreaterThan(0);
      }
    }
  });

  it('every card has complete copy; only the wrap card drops the skip (always taken back)', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.primaryLabel.length).toBeGreaterThan(0);
      if (step.id === 'wrap') {
        expect(step.ghostLabel).toBeNull();
      } else {
        expect(step.ghostLabel && step.ghostLabel.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('tutorialTransition', () => {
  const PHASES: TutorialPhase[] = ['staging', 'settling', 'ready', 'ending'];

  it('next and back stage only from ready', () => {
    for (const event of ['next', 'back'] as TutorialTransitionEvent[]) {
      expect(tutorialTransition('ready', event)).toBe('staging');
      for (const phase of PHASES.filter((p) => p !== 'ready')) {
        expect(tutorialTransition(phase, event)).toBe(phase);
      }
    }
  });

  it('staged moves staging → settling and nothing else', () => {
    expect(tutorialTransition('staging', 'staged')).toBe('settling');
    for (const phase of PHASES.filter((p) => p !== 'staging')) {
      expect(tutorialTransition(phase, 'staged')).toBe(phase);
    }
  });

  it('settled moves settling → ready and nothing else', () => {
    expect(tutorialTransition('settling', 'settled')).toBe('ready');
    for (const phase of PHASES.filter((p) => p !== 'settling')) {
      expect(tutorialTransition(phase, 'settled')).toBe(phase);
    }
  });

  it('skip and abort end the tutorial from any phase', () => {
    for (const phase of PHASES) {
      for (const event of ['skip', 'abort'] as TutorialTransitionEvent[]) {
        expect(tutorialTransition(phase, event)).toBe('ending');
      }
    }
  });
});

describe('isStepSettled', () => {
  const IDLE: SettleSignals = {
    arrivalInFlight: false,
    veilCovering: false,
    fovAnimating: false,
    totalityReached: true,
    sinceStagedMs: TUTORIAL_SETTLE_DWELL_MS,
  };
  const FULL = { arrival: true, fov: true, totality: true, dwellMs: TUTORIAL_SETTLE_DWELL_MS };

  it('settles when every required signal is idle and the dwell has passed', () => {
    expect(isStepSettled(IDLE, FULL)).toBe(true);
  });

  it('dwell boundary: the exact dwell settles, one ms short does not', () => {
    expect(isStepSettled({ ...IDLE, sinceStagedMs: TUTORIAL_SETTLE_DWELL_MS - 1 }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, sinceStagedMs: TUTORIAL_SETTLE_DWELL_MS }, FULL)).toBe(true);
  });

  it('an in-flight arrival or a covering veil blocks when arrival is required', () => {
    expect(isStepSettled({ ...IDLE, arrivalInFlight: true }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, veilCovering: true }, FULL)).toBe(false);
  });

  it('the FOV glide blocks only when required', () => {
    expect(isStepSettled({ ...IDLE, fovAnimating: true }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, fovAnimating: true }, { ...FULL, fov: false })).toBe(true);
  });

  it('an unreached totality blocks only when required', () => {
    expect(isStepSettled({ ...IDLE, totalityReached: false }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, totalityReached: false }, { ...FULL, totality: false })).toBe(true);
  });

  it('signals not required are ignored (card-only steps settle immediately)', () => {
    const busy: SettleSignals = {
      arrivalInFlight: true,
      veilCovering: true,
      fovAnimating: true,
      totalityReached: false,
      sinceStagedMs: 0,
    };
    expect(isStepSettled(busy, { arrival: false, fov: false, totality: false, dwellMs: 0 })).toBe(true);
  });
});

describe('restorePlan', () => {
  const BASE: RestoreContext = {
    snapshotLandedOn: null,
    panelWasOpen: false,
    snapshotSurfaceView: false,
    inSurfaceView: false,
    landedOn: null,
    lifecycleAbort: false,
  };

  it('user skip back to a landed snapshot rides the veil and reopens the panel', () => {
    const plan = restorePlan({
      ...BASE,
      snapshotLandedOn: 'Io',
      panelWasOpen: true,
      landedOn: 'Earth',
    });
    expect(plan).toEqual({
      exitSurfaceView: false,
      exitLandedFirst: false,
      veilGate: true,
      reopenPanel: true,
      reenterSurfaceView: false,
    });
  });

  it('walks back into a surface view the snapshot was in, only once re-landed and never on a lifecycle abort', () => {
    const landed = { ...BASE, snapshotLandedOn: 'Moon', snapshotSurfaceView: true };
    expect(restorePlan(landed).reenterSurfaceView).toBe(true);
    expect(restorePlan({ ...landed, lifecycleAbort: true }).reenterSurfaceView).toBe(false);
    // A cruising snapshot has no ground to stand on, whatever the flag says.
    expect(restorePlan({ ...BASE, snapshotSurfaceView: true }).reenterSurfaceView).toBe(false);
    // Still exits the tour's own surface view before the landed state changes.
    expect(restorePlan({ ...landed, inSurfaceView: true }).exitSurfaceView).toBe(true);
  });

  it('lifecycle aborts never veil-gate, even to a landed snapshot', () => {
    const plan = restorePlan({ ...BASE, snapshotLandedOn: 'Io', lifecycleAbort: true });
    expect(plan.veilGate).toBe(false);
  });

  it('cruising snapshot: no veil, and a current landing lifts off first', () => {
    const plan = restorePlan({ ...BASE, landedOn: 'Earth' });
    expect(plan.veilGate).toBe(false);
    expect(plan.exitLandedFirst).toBe(true);
    expect(restorePlan(BASE).exitLandedFirst).toBe(false);
  });

  it('surface view always exits before the landed state changes', () => {
    expect(restorePlan({ ...BASE, inSurfaceView: true }).exitSurfaceView).toBe(true);
  });

  it('the panel only reopens when the snapshot was landed', () => {
    expect(restorePlan({ ...BASE, panelWasOpen: true }).reopenPanel).toBe(false);
    expect(
      restorePlan({ ...BASE, panelWasOpen: true, snapshotLandedOn: 'Moon' }).reopenPanel,
    ).toBe(true);
  });
});

describe('canStartTutorial', () => {
  it('starts only when nothing else owns the session', () => {
    expect(
      canStartTutorial({ missionActive: false, resumePromptVisible: false, alreadyActive: false }),
    ).toBe(true);
    expect(
      canStartTutorial({ missionActive: true, resumePromptVisible: false, alreadyActive: false }),
    ).toBe(false);
    expect(
      canStartTutorial({ missionActive: false, resumePromptVisible: true, alreadyActive: false }),
    ).toBe(false);
    expect(
      canStartTutorial({ missionActive: false, resumePromptVisible: false, alreadyActive: true }),
    ).toBe(false);
  });
});

describe('stepBeatRun', () => {
  const chip: TutorialBeat = {
    id: 'chip',
    spotlight: { target: { kind: 'chip', id: 'planetarium-btn-travel' }, label: 'Teleport' },
    press: true,
    perform: { kind: 'open-deck', verb: 'travel', reveal: 'Saturn' },
    minHoldMs: 1000,
  };
  const row: TutorialBeat = {
    id: 'row',
    spotlight: { target: { kind: 'deck-row', name: 'Saturn' }, label: 'Tap any planet or moon' },
    press: true,
    perform: { kind: 'arrive' },
    minHoldMs: 1000,
  };
  const holdOnly: TutorialBeat = { id: 'hold', spotlight: null, press: false, perform: { kind: 'none' }, minHoldMs: 500 };
  const beats = [chip, row];
  const tryIt: TutorialBeat = {
    id: 'try',
    spotlight: { target: { kind: 'deck-row', name: 'Moon' }, label: 'Tap the Moon' },
    press: true,
    await: true,
    perform: { kind: 'observe', name: 'Moon', parentPlanet: 'Earth' },
    minHoldMs: 300,
  };
  const signals = (over: Partial<BeatSignals> = {}): BeatSignals => ({
    dtMs: 100,
    paused: false,
    targetPresent: true,
    performed: false,
    userActed: false,
    showMe: false,
    ...over,
  });
  const run = (list: readonly TutorialBeat[], state: BeatRunState, over: Partial<BeatSignals> = {}) =>
    stepBeatRun(list, state, signals(over));
  const kinds = (effects: ReturnType<typeof stepBeatRun>['effects']) => effects.map((e) => e.kind);

  it('entering a beat shows its spotlight, then the hold counts visible time', () => {
    const first = run(beats, initialBeatRun());
    expect(kinds(first.effects)).toEqual(['spotlight']);
    expect(first.state.stage).toBe('hold');
    const held = run(beats, first.state);
    expect(held.state.heldMs).toBe(100);
    expect(held.effects).toEqual([]);
  });

  it('the hold ends on the minimum, not before, and a paused frame does not count', () => {
    let state: BeatRunState = { index: 0, stage: 'hold', heldMs: 800, pressedMs: 0 };
    state = run(beats, state, { paused: true }).state;
    expect(state.heldMs).toBe(800);
    state = run(beats, state).state;
    expect(state).toMatchObject({ stage: 'hold', heldMs: 900 });
    const pressed = run(beats, state);
    expect(kinds(pressed.effects)).toEqual(['press-down']);
    expect(pressed.state.stage).toBe('press');
  });

  it('the press lasts its 180 ms, then the perform starts and waits for the host', () => {
    let state: BeatRunState = { index: 0, stage: 'press', heldMs: 1000, pressedMs: 0 };
    const mid = run(beats, state, { dtMs: TUTORIAL_PRESS_MS - 1 });
    expect(mid.effects).toEqual([]);
    const up = run(beats, mid.state, { dtMs: 1 });
    expect(kinds(up.effects)).toEqual(['press-up', 'perform']);
    expect(up.state.stage).toBe('perform');
    state = run(beats, up.state, { performed: false }).state;
    expect(state.stage).toBe('perform');
    const next = run(beats, state, { performed: true });
    expect(next.state).toEqual({ index: 1, stage: 'enter', heldMs: 0, pressedMs: 0 });
    expect(next.effects).toEqual([]);
  });

  it('a missing control skips the spotlight and the press but keeps the hold and still performs', () => {
    const entered = run(beats, initialBeatRun(), { targetPresent: false });
    expect(entered.effects).toEqual([{ kind: 'spotlight', beat: chip, present: false }]);
    const state: BeatRunState = { index: 0, stage: 'hold', heldMs: 1000, pressedMs: 0 };
    const result = run(beats, state, { targetPresent: false });
    expect(kinds(result.effects)).toEqual(['perform']);
    expect(result.state.stage).toBe('perform');
  });

  it('a hold-only beat advances on its own; the last beat finishes the run', () => {
    const list = [holdOnly, holdOnly];
    const state: BeatRunState = { index: 1, stage: 'hold', heldMs: 500, pressedMs: 0 };
    const result = run(list, state, { dtMs: 0 });
    expect(kinds(result.effects)).toEqual(['finish']);
    expect(result.state.stage).toBe('done');
    expect(run(list, result.state).effects).toEqual([]);
  });

  it('a you-try beat waits after its hold with no deadline; Show me presses for the user', () => {
    const list = [tryIt];
    let state: BeatRunState = { index: 0, stage: 'hold', heldMs: 300, pressedMs: 0 };
    state = run(list, state, { dtMs: 0 }).state;
    expect(state.stage).toBe('await');
    // Minutes pass: still waiting, nothing performed.
    for (let i = 0; i < 100; i++) {
      const tick = run(list, state, { dtMs: 1000 });
      expect(tick.effects).toEqual([]);
      state = tick.state;
    }
    expect(state.stage).toBe('await');
    const shown = run(list, state, { showMe: true });
    expect(kinds(shown.effects)).toEqual(['press-down']);
    expect(shown.state.stage).toBe('press');
    const up = run(list, shown.state, { dtMs: TUTORIAL_PRESS_MS });
    expect(kinds(up.effects)).toEqual(['press-up', 'perform']);
    expect(up.state.stage).toBe('perform');
  });

  it('the user’s own press ends the wait — even mid-hold — with no press or perform of the runner’s own', () => {
    const list = [tryIt];
    const waiting: BeatRunState = { index: 0, stage: 'await', heldMs: 300, pressedMs: 0 };
    const acted = run(list, waiting, { userActed: true });
    expect(acted.effects).toEqual([]);
    expect(acted.state.stage).toBe('perform');
    const early: BeatRunState = { index: 0, stage: 'hold', heldMs: 50, pressedMs: 0 };
    const actedEarly = run(list, early, { userActed: true });
    expect(actedEarly.effects).toEqual([]);
    expect(actedEarly.state.stage).toBe('perform');
    // Either way the beat ends only once the landing has happened.
    expect(run(list, acted.state, { performed: false }).state.stage).toBe('perform');
    expect(kinds(run(list, acted.state, { performed: true }).effects)).toEqual(['finish']);
  });

  it('Show me with the control gone performs without a press', () => {
    const waiting: BeatRunState = { index: 0, stage: 'await', heldMs: 300, pressedMs: 0 };
    const shown = run([tryIt], waiting, { showMe: true, targetPresent: false });
    expect(kinds(shown.effects)).toEqual(['perform']);
    expect(shown.state.stage).toBe('perform');
  });

  it('an empty list finishes at once', () => {
    const result = run([], initialBeatRun());
    expect(kinds(result.effects)).toEqual(['finish']);
    expect(result.state.stage).toBe('done');
  });
});

describe('the showcase eclipse', () => {
  // Deliberately redundant with the EclipseWise pin in shadows.test.ts: if the
  // engine drifts, this failure points straight at the tutorial's staging inputs.
  const event = findShadowEvent(TUTORIAL_ECLIPSE.spec, TUTORIAL_ECLIPSE.searchFromUtcMs, 1);

  it('the fixed search finds the 2027-08-02 total solar eclipse', () => {
    expect(event).not.toBeNull();
    expect(event!.classification).toBe('total');
    expect(Math.abs(event!.peakUtcMs - TUTORIAL_ECLIPSE.expectedPeakUtcMs)).toBeLessThan(20 * MIN);
  });

  it('the totality settle instant lands inside the event, before the peak', () => {
    const settle = totalitySettleUtcMs(event!.peakUtcMs);
    expect(settle).toBeGreaterThan(event!.startUtcMs);
    expect(settle).toBeLessThan(event!.peakUtcMs);
  });

  it('the tutorial rates render as clean rate labels', () => {
    // The eclipse approach rides the "20 min/s" preset; the time-lapse rate is
    // deliberately off the preset ladder (see its comment), which the UI
    // supports: every readout formats the live rate, and the −/+ stepper snaps
    // off-ladder magnitudes back onto the ladder. Pin the labels so neither
    // rate drifts somewhere the formatter renders raggedly.
    expect(formatTimeRateLabel(TUTORIAL_TIMELAPSE_RATE, false)).toBe('2 hr/s');
    expect(formatTimeRateLabel(TUTORIAL_ECLIPSE_APPROACH_RATE, false)).toBe('20 min/s');
    const presets = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
    expect(presets).toContain(TUTORIAL_ECLIPSE_APPROACH_RATE);
  });
});

describe('the clock the tour hands back', () => {
  const now = 1_800_000_000_000;
  const DRIFT = 120_000;

  it('counts as live only at 1\u00d7, running, within the live window of now', () => {
    expect(clockWasLive({ currentUtcMs: now - 30_000, rate: 1, paused: false }, now, DRIFT)).toBe(true);
    expect(clockWasLive({ currentUtcMs: now - DRIFT, rate: 1, paused: false }, now, DRIFT)).toBe(true);
    expect(clockWasLive({ currentUtcMs: now - DRIFT - 1, rate: 1, paused: false }, now, DRIFT)).toBe(false);
    expect(clockWasLive({ currentUtcMs: now, rate: 60, paused: false }, now, DRIFT)).toBe(false);
    expect(clockWasLive({ currentUtcMs: now, rate: 1, paused: true }, now, DRIFT)).toBe(false);
    expect(clockWasLive({ currentUtcMs: now + 10 * DRIFT, rate: 1, paused: false }, now, DRIFT)).toBe(false);
  });

  it('comes back at now when it was live, and exactly as held otherwise', () => {
    const later = now + 5 * MIN;
    expect(restoredClockUtcMs(now, true, later)).toBe(later);
    expect(restoredClockUtcMs(Date.parse('1977-09-05T12:56:00Z'), false, later)).toBe(Date.parse('1977-09-05T12:56:00Z'));
  });
});
