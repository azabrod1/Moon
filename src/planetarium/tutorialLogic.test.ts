import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_STEPS,
  TUTORIAL_ECLIPSE,
  TUTORIAL_TIMELAPSE_RATE,
  TUTORIAL_ECLIPSE_APPROACH_RATE,
  TUTORIAL_SETTLE_DWELL_MS,
  totalitySettleUtcMs,
  totalityEndUtcMs,
  eclipseClockPhase,
  TUTORIAL_ECLIPSE_APPROACH_MARGIN_MS,
  tutorialTransition,
  isStepSettled,
  restorePlan,
  earlyRestorePlan,
  eclipseClimaxShown,
  canStartTutorial,
  clockWasLive,
  restoredClockUtcMs,
  TUTORIAL_STOP_COUNT,
  TUTORIAL_MAP_RATE_LADDER,
  TUTORIAL_MAP_RATE,
  TUTORIAL_PRESS_MS,
  TUTORIAL_RATE_LADDER,
  tutorialStopNumber,
  tutorialProgress,
  initialBeatRun,
  stepBeatRun,
  recoverBeatRun,
  tutorialLadderBase,
  TUTORIAL_PAUSE_GUARD_MS,
} from './tutorialLogic';
import type {
  BeatRunState,
  BeatSignals,
  RestoreContext,
  SettleSignals,
  TutorialBeat,
  TutorialPhase,
  TutorialSurface,
  TutorialTransitionEvent,
} from './tutorialLogic';
import { findShadowEvent } from '../astronomy/shadows';
import { formatTimeRateLabel } from '../astronomy/planetary';
import { TIME_RATE_PRESETS } from './timeRates';

const MIN = 60_000;

describe('TUTORIAL_STEPS', () => {
  it('is the five stops and the wrap in order, ids unique — no welcome card, the first stop stages at once', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['saturn', 'moon', 'timelapse', 'map', 'eclipse', 'wrap']);
  });

  it('stages match the cards: the five stops scene-staged, the wrap card-only', () => {
    expect(TUTORIAL_STEPS.map((s) => s.stage)).toEqual(['saturn', 'moon', 'timelapse', 'map', 'eclipse', 'none']);
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
    expect(row.minHoldMs).toBe(TUTORIAL_PAUSE_GUARD_MS);
    expect(row.body).toMatch(/Tap the Moon/);
    expect(row.perform).toEqual({ kind: 'observe', name: 'Moon', parentPlanet: 'Earth' });
    expect(row.veilNote).toMatch(/Moon/);
    // Two seconds of the Moon from orbit before the panel opens, then the window.
    expect(picture.spotlight).toBeNull();
    expect(picture.minHoldMs).toBe(2000);
    expect(picture.perform).toEqual({ kind: 'open-panel' });
    expect(lookUp.spotlight?.target).toEqual({ kind: 'panel-window' });
    expect(lookUp.perform).toEqual({ kind: 'look-up' });
    expect(lookUp.body?.startsWith(picture.body!)).toBe(true);
    expect(lookUp.body).toMatch(/Tap Look up/);
    expect(lookUp.spotlight?.label).toBe('Tap Look up');
    expect(moon.bodyDuring).not.toMatch(/Tap the Moon/);
    expect(moon.body).toMatch(/Earth/);
    // Every ringed control is the user's to press, so the pace is theirs,
    // and every ring's bubble says what to do with it.
    const ringed = TUTORIAL_STEPS.flatMap((s) => s.beats ?? []).filter((b) => b.spotlight);
    expect(ringed.length).toBeGreaterThanOrEqual(9);
    expect(ringed.every((b) => b.await === true)).toBe(true);
    expect(ringed.every((b) => /^(Tap|Drag) /.test(b.spotlight!.label))).toBe(true);
    const unringed = TUTORIAL_STEPS.flatMap((s) => s.beats ?? []).filter((b) => !b.spotlight);
    expect(unringed.every((b) => b.await === undefined)).toBe(true);
  });

  it('only the eclipse holds Next for the totality moment', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.settle.totality).toBe(step.stage === 'eclipse');
    }
  });

  it('the stops are the five scene-staged steps; the wrap counts as after them', () => {
    expect(TUTORIAL_STOP_COUNT).toBe(5);
    expect(TUTORIAL_STEPS.map((_, i) => tutorialStopNumber(i))).toEqual([1, 2, 3, 4, 5, null]);
    expect(tutorialProgress(0)).toEqual({ count: 5, current: 1, done: 0, label: 'Stop 1 of 5' });
    expect(tutorialProgress(1)).toEqual({ count: 5, current: 2, done: 1, label: 'Stop 2 of 5' });
    expect(tutorialProgress(5)).toEqual({ count: 5, current: null, done: 5, label: 'All 5 stops seen' });
  });

  it('Saturn plays its demonstration: ring and press the Teleport chip, then ring and press the Saturn row into the arrival', () => {
    const saturn = TUTORIAL_STEPS.find((s) => s.id === 'saturn')!;
    expect(saturn.beats?.map((b) => b.id)).toEqual(['teleport-chip', 'saturn-row']);
    const [chip, row] = saturn.beats!;
    expect(chip.spotlight?.target).toEqual({ kind: 'chip', id: 'planetarium-btn-travel' });
    expect(chip.spotlight?.key).toBe('T');
    expect(chip.press).toBe(true);
    expect(chip.perform).toEqual({ kind: 'open-deck', verb: 'travel', reveal: 'Saturn' });
    expect(row.spotlight?.target).toEqual({ kind: 'deck-row', name: 'Saturn', verb: 'travel' });
    expect(row.perform).toEqual({ kind: 'arrive' });
    expect(row.veilNote).toMatch(/Saturn/);
    // The copy while the beats play introduces the tour; the settled copy is the lesson.
    expect(saturn.bodyDuring).toMatch(/Five stops/);
    expect(saturn.body).not.toMatch(/Five stops/);
    // A beat that presses must have something to press.
    for (const step of TUTORIAL_STEPS) {
      for (const beat of step.beats ?? []) {
        if (beat.press) expect(beat.spotlight).not.toBeNull();
        // A waiting beat's hold is the tap guard before its Show me goes
        // live; an arrival or a scene move needs no hold.
        if (beat.await) expect(beat.minHoldMs).toBe(TUTORIAL_PAUSE_GUARD_MS);
      }
    }
  });

  it('Jupiter: an arrival, then the rail ringed while the clock climbs three real detents to 1 hr/s', () => {
    const jupiter = TUTORIAL_STEPS.find((s) => s.id === 'timelapse')!;
    expect(jupiter.beats?.map((b) => b.id)).toEqual(['jupiter-arrive', 'time-rail']);
    const [arrive, rail] = jupiter.beats!;
    expect(arrive.perform).toEqual({ kind: 'arrive' });
    expect(arrive.veilNote).toMatch(/Jupiter/);
    expect(rail.spotlight?.target).toEqual({ kind: 'time-rail' });
    expect(rail.spotlight?.label).toMatch(/1 hr\/s/);
    expect(rail.await).toBe(true);
    expect(rail.press).toBe(false);
    expect(rail.perform).toEqual({ kind: 'rate-ladder', rates: TUTORIAL_RATE_LADDER, stepMs: 700 });
    expect(TUTORIAL_RATE_LADDER).toEqual([60, 1200, 3600]);
    for (const rate of TUTORIAL_RATE_LADDER) expect(TIME_RATE_PRESETS).toContain(rate);
    expect(TUTORIAL_TIMELAPSE_RATE).toBe(3600);
    expect(jupiter.kicker).toBe('Jupiter · 1 hr/s');
    expect(jupiter.body).toMatch(/forty-two/);
    expect(jupiter.primaryLabel).toBe('Next: the map');
  });

  it('the map: Jupiter if need be, the Tools button and its System map row rung and pressed, the chart held, then the tour’s own climb to a month a second', () => {
    const map = TUTORIAL_STEPS.find((s) => s.id === 'map')!;
    expect(map.stage).toBe('map');
    expect(map.beats?.map((b) => b.id)).toEqual(['map-arrive', 'tools-chip', 'map-row', 'map-picture', 'map-rate']);
    const [arrive, tools, row, picture, rate] = map.beats!;
    expect(arrive.perform).toEqual({ kind: 'arrive' });
    expect(arrive.veilNote).toMatch(/Jupiter/);
    expect(tools.spotlight?.target).toEqual({ kind: 'chip', id: 'planetarium-btn-tools' });
    expect(tools.spotlight?.label).toBe('Tap Tools');
    expect(tools.press).toBe(true);
    expect(tools.await).toBe(true);
    expect(tools.perform).toEqual({ kind: 'open-tools' });
    expect(row.spotlight?.target).toEqual({ kind: 'tools-row', tool: 'map' });
    expect(row.spotlight?.label).toBe('Tap System map');
    expect(row.spotlight?.key).toBe('M');
    expect(row.await).toBe(true);
    expect(row.perform).toEqual({ kind: 'open-map' });
    expect(row.body).toMatch(/Tap System map/);
    // The chart alone for a moment, then the climb — the tour's own, with no
    // ring, since the chart is the thing to watch.
    expect(picture.spotlight).toBeNull();
    expect(picture.perform).toEqual({ kind: 'none' });
    expect(picture.minHoldMs).toBeGreaterThanOrEqual(2000);
    expect(picture.body).toMatch(/The ring is you, at Jupiter/);
    expect(rate.spotlight).toBeNull();
    expect(rate.await).toBeUndefined();
    expect(rate.perform).toEqual({ kind: 'rate-ladder', rates: TUTORIAL_MAP_RATE_LADDER, stepMs: 700 });
    // The ladder carries on from the time stop's rung, one real detent at a
    // time, to a month a second.
    expect(TUTORIAL_MAP_RATE_LADDER).toEqual([21600, 86400, 604800, 2592000]);
    for (const r of TUTORIAL_MAP_RATE_LADDER) expect(TIME_RATE_PRESETS).toContain(r);
    expect(TIME_RATE_PRESETS.indexOf(TUTORIAL_MAP_RATE_LADDER[0])).toBe(TIME_RATE_PRESETS.indexOf(TUTORIAL_TIMELAPSE_RATE) + 1);
    expect(TUTORIAL_MAP_RATE).toBe(2592000);
    expect(map.kicker).toBe('From Jupiter · 1 mo/s');
    expect(map.bodyDuring).toMatch(/\{tools\} Tools holds the map/);
    expect(map.body).toMatch(/three seconds/);
    expect(map.primaryLabel).toBe('Next: an eclipse');
    // The picture and the climb play on the chart; nothing else declares a scene.
    expect(map.beats!.filter((b) => b.scene === 'map').map((b) => b.id)).toEqual(['map-picture', 'map-rate']);
    for (const step of TUTORIAL_STEPS) {
      if (step.id !== 'map') for (const beat of step.beats ?? []) expect(beat.scene).toBeUndefined();
    }
  });

  it('the eclipse: land on Earth, press the panel’s next-solar arrow, say what it did, rewind, Look up, then approach; totality gets its own card', () => {
    const eclipse = TUTORIAL_STEPS.find((s) => s.id === 'eclipse')!;
    expect(eclipse.beats?.map((b) => b.id)).toEqual(['earth-arrive', 'next-solar', 'jumped', 'rewind', 'look-up', 'approach']);
    const [arrive, arrow, jumped, rewind, lookUp, approach] = eclipse.beats!;
    expect(arrive.veilNote).toMatch(/Earth/);
    expect(arrow.spotlight?.target).toEqual({ kind: 'panel-step', id: 'observatory-next-solar' });
    expect(arrow.press).toBe(true);
    expect(arrow.perform).toEqual({ kind: 'jump', type: 'solar-eclipse', direction: 1 });
    expect(jumped.body).toMatch(/three minutes before the peak/);
    expect(jumped.minHoldMs).toBeGreaterThanOrEqual(2000);
    expect(rewind.perform).toEqual({ kind: 'rewind' });
    expect(lookUp.spotlight?.target).toEqual({ kind: 'panel-window' });
    expect(lookUp.perform).toEqual({ kind: 'look-up' });
    expect(approach.perform).toEqual({ kind: 'approach', rate: TUTORIAL_ECLIPSE_APPROACH_RATE });
    expect(eclipse.totality?.title).toBe('Totality');
    expect(eclipse.totality?.body).toMatch(/corona/);
    expect(eclipse.body).toMatch(/twenty minutes a second/);
  });

  it('the wrap is a door: Back where I was, and three chips that each do what they say', () => {
    const wrap = TUTORIAL_STEPS.find((s) => s.id === 'wrap')!;
    expect(wrap.primaryLabel).toBe('Back where I was');
    expect(wrap.chips?.map((c) => [c.id, c.label])).toEqual([
      ['earth-from-moon', 'Earth from the Moon'],
      ['look-inside-earth', 'Look inside Earth'],
      ['follow-voyager', 'Follow Voyager 1'],
    ]);
    expect(wrap.body).toMatch(/\{tools\} Tools holds the map/);
    for (const step of TUTORIAL_STEPS) if (step.id !== 'wrap') expect(step.chips).toBeUndefined();
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

  it('next stages only from ready; back from any phase but ending', () => {
    expect(tutorialTransition('ready', 'next')).toBe('staging');
    for (const phase of PHASES.filter((p) => p !== 'ready')) {
      expect(tutorialTransition(phase, 'next')).toBe(phase);
    }
    for (const phase of PHASES.filter((p) => p !== 'ending')) {
      expect(tutorialTransition(phase, 'back')).toBe('staging');
    }
    expect(tutorialTransition('ending', 'back')).toBe('ending');
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

describe('earlyRestorePlan', () => {
  const BASE = { snapshotLandedOn: 'Moon', snapshotSurfaceView: true, inSurfaceView: false, landedOn: 'Moon', lifecycleAbort: false };

  it('walks back into the surface view the start left, on the same ground', () => {
    expect(earlyRestorePlan(BASE)).toEqual({ reenterSurfaceView: true });
  });

  it('leaves everything else alone: an orbit snapshot, a surface view the user entered since, other ground, no ground, a lifecycle abort', () => {
    expect(earlyRestorePlan({ ...BASE, snapshotSurfaceView: false }).reenterSurfaceView).toBe(false);
    expect(earlyRestorePlan({ ...BASE, inSurfaceView: true }).reenterSurfaceView).toBe(false);
    expect(earlyRestorePlan({ ...BASE, landedOn: 'Earth' }).reenterSurfaceView).toBe(false);
    expect(earlyRestorePlan({ ...BASE, landedOn: null, snapshotLandedOn: null }).reenterSurfaceView).toBe(false);
    expect(earlyRestorePlan({ ...BASE, lifecycleAbort: true }).reenterSurfaceView).toBe(false);
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

describe('recoverBeatRun', () => {
  const beatsOf = (id: string) => TUTORIAL_STEPS.find((s) => s.id === id)!.beats!;
  const map = beatsOf('map');
  const saturn = beatsOf('saturn');
  const moon = beatsOf('moon');
  const at = (beats: readonly TutorialBeat[], id: string, stage: BeatRunState['stage']): BeatRunState => ({
    index: beats.findIndex((b) => b.id === id),
    stage,
    heldMs: 300,
    pressedMs: 0,
  });
  const key = (s: TutorialSurface) => (s.kind === 'deck' ? `deck:${s.verb}` : s.kind);
  const signals = (open: string[], extra: { performed?: boolean; userActed?: boolean } = {}) => ({
    performed: extra.performed ?? false,
    userActed: extra.userActed ?? false,
    open: (s: TutorialSurface) => open.includes(key(s)),
  });
  const recovered = (beats: readonly TutorialBeat[], run: BeatRunState, s: ReturnType<typeof signals>) => {
    const next = recoverBeatRun(beats, run, s);
    return next && { id: beats[next.index].id, stage: next.stage, heldMs: next.heldMs };
  };

  it('a row whose container closes under its ring while it waits steps back to the beat that opens it', () => {
    // The popover's catcher, or ☰ opening over it, folds the System map row away.
    for (const stage of ['enter', 'hold', 'await'] as const) {
      expect(recovered(map, at(map, 'map-row', stage), signals([]))).toEqual({ id: 'tools-chip', stage: 'enter', heldMs: 0 });
    }
    expect(recovered(map, at(map, 'map-row', 'await'), signals(['tools']))).toBeNull();
    // The deck is the same: the row's own tab, not the other one.
    expect(recovered(saturn, at(saturn, 'saturn-row', 'await'), signals(['deck:observe']))?.id).toBe('teleport-chip');
    expect(recovered(saturn, at(saturn, 'saturn-row', 'await'), signals(['deck:travel']))).toBeNull();
    expect(recovered(moon, at(moon, 'moon-row', 'hold'), signals([]))?.id).toBe('observatory-chip');
  });

  it('a row the user pressed, or whose outcome already holds, is left to land: its own press takes the container down', () => {
    expect(recovered(map, at(map, 'map-row', 'await'), signals([], { userActed: true }))).toBeNull();
    // M at the Tools ring opened the chart past the popover: the row's outcome holds.
    expect(recovered(map, at(map, 'map-row', 'enter'), signals(['map'], { performed: true }))).toBeNull();
    // Pressed (by the user or Show me), the row's own perform folds the
    // popover into the chart: the chart is up and the outcome holds.
    for (const stage of ['press', 'perform'] as const) {
      expect(recovered(map, at(map, 'map-row', stage), signals(['map'], { performed: true }))).toBeNull();
      expect(recovered(saturn, at(saturn, 'saturn-row', stage), signals([]))).toBeNull();
    }
  });

  it('the chart closed under the map stop’s picture or climb steps back to the row, or to the Tools ring when the popover is shut too', () => {
    for (const id of ['map-picture', 'map-rate']) {
      for (const stage of ['enter', 'hold', 'perform'] as const) {
        // The map's own close, a T or O chip, a teleport from its card: nothing is left open.
        expect(recovered(map, at(map, id, stage), signals([]))?.id).toBe('tools-chip');
        // The Tools button: the chart folds into the popover, its row ready.
        expect(recovered(map, at(map, id, stage), signals(['tools']))?.id).toBe('map-row');
        expect(recovered(map, at(map, id, stage), signals(['map']))).toBeNull();
      }
    }
    // A scene beat stands on its chart however it got there, acted on or not.
    expect(recovered(map, at(map, 'map-rate', 'perform'), signals([], { performed: true, userActed: true }))?.id).toBe('tools-chip');
  });

  it('an opener whose surface was taken down before the run saw it land plays again', () => {
    // A double tap on the Tools button: the second half lands on the catcher.
    expect(recovered(map, at(map, 'tools-chip', 'perform'), signals([]))).toEqual({ id: 'tools-chip', stage: 'enter', heldMs: 0 });
    expect(recovered(map, at(map, 'tools-chip', 'perform'), signals(['tools'], { performed: true }))).toBeNull();
    expect(recovered(saturn, at(saturn, 'teleport-chip', 'perform'), signals([]))?.id).toBe('teleport-chip');
    // Before its perform the opener is still waiting: nothing to undo.
    expect(recovered(map, at(map, 'tools-chip', 'hold'), signals([]))).toBeNull();
    expect(recovered(map, at(map, 'tools-chip', 'await'), signals([]))).toBeNull();
  });

  it('beats that stand on nothing never step back', () => {
    for (const beats of [map, saturn, moon, beatsOf('timelapse'), beatsOf('eclipse')]) {
      for (const beat of beats) {
        const standsOn = beat.scene !== undefined || beat.spotlight?.target.kind === 'deck-row' || beat.spotlight?.target.kind === 'tools-row';
        const opens = ['open-deck', 'open-tools', 'open-map'].includes(beat.perform.kind);
        if (standsOn || opens) continue;
        for (const stage of ['enter', 'hold', 'await', 'press', 'perform'] as const) {
          expect(recoverBeatRun(beats, at(beats, beat.id, stage), signals([]))).toBeNull();
        }
      }
    }
    expect(recoverBeatRun(map, { index: map.length, stage: 'done', heldMs: 0, pressedMs: 0 }, signals([]))).toBeNull();
  });
});

describe('tutorialLadderBase', () => {
  it('is the rung just below a ladder’s first: realtime under Jupiter’s climb, an hour a second under the map’s', () => {
    expect(tutorialLadderBase(TUTORIAL_RATE_LADDER)).toBe(1);
    expect(tutorialLadderBase(TUTORIAL_MAP_RATE_LADDER)).toBe(3600);
    expect(tutorialLadderBase(TUTORIAL_MAP_RATE_LADDER)).toBe(TUTORIAL_TIMELAPSE_RATE);
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
    spotlight: { target: { kind: 'deck-row', name: 'Saturn', verb: 'travel' }, label: 'Tap any planet or moon' },
    press: true,
    perform: { kind: 'arrive' },
    minHoldMs: 1000,
  };
  const holdOnly: TutorialBeat = { id: 'hold', spotlight: null, press: false, perform: { kind: 'none' }, minHoldMs: 500 };
  const beats = [chip, row];
  const tryIt: TutorialBeat = {
    id: 'try',
    spotlight: { target: { kind: 'deck-row', name: 'Moon', verb: 'observe' }, label: 'Tap the Moon' },
    press: true,
    await: true,
    perform: { kind: 'observe', name: 'Moon', parentPlanet: 'Earth' },
    minHoldMs: 300,
  };
  const tryChip: TutorialBeat = {
    id: 'try-chip',
    spotlight: { target: { kind: 'chip', id: 'planetarium-btn-travel' }, label: 'Tap Teleport' },
    press: true,
    await: true,
    perform: { kind: 'open-deck', verb: 'travel', reveal: 'Saturn' },
    minHoldMs: 300,
  };
  const signals = (over: Partial<BeatSignals> = {}): BeatSignals => ({
    dtMs: 100,
    paused: false,
    targetPresent: true,
    performed: false,
    userActed: false,
    proceed: false,
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
    const shown = run(list, state, { proceed: true });
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
    const shown = run([tryIt], waiting, { proceed: true, targetPresent: false });
    expect(kinds(shown.effects)).toEqual(['perform']);
    expect(shown.state.stage).toBe('perform');
  });

  it('Show me is not taken before the guard has passed, and the wait has no deadline', () => {
    const list = [tryChip];
    let state: BeatRunState = { index: 0, stage: 'hold', heldMs: 0, pressedMs: 0 };
    // A double tap on Next lands here, and must not skip the scene.
    const early = run(list, state, { proceed: true });
    expect(early.effects).toEqual([]);
    expect(early.state.stage).toBe('hold');
    state = run(list, early.state, { dtMs: 200 }).state;
    expect(state.stage).toBe('await');
    for (let i = 0; i < 100; i++) {
      const tick = run(list, state, { dtMs: 1000 });
      expect(tick.effects).toEqual([]);
      state = tick.state;
    }
    expect(state.stage).toBe('await');
    const went = run(list, state, { proceed: true });
    expect(kinds(went.effects)).toEqual(['press-down']);
    expect(went.state.stage).toBe('press');
  });

  it('a waiting beat whose outcome already holds goes on without a press — in the hold and in the wait', () => {
    // The user got there first (opened the deck, looked up, dragged the
    // rail to the detent): no press of the runner's own, no Show me to wait for.
    const list = [tryChip];
    const held: BeatRunState = { index: 0, stage: 'hold', heldMs: 50, pressedMs: 0 };
    const fromHold = run(list, held, { performed: true });
    expect(fromHold.effects).toEqual([]);
    expect(fromHold.state.stage).toBe('perform');
    const waiting: BeatRunState = { index: 0, stage: 'await', heldMs: 300, pressedMs: 0 };
    const fromWait = run(list, waiting, { performed: true });
    expect(fromWait.effects).toEqual([]);
    expect(fromWait.state.stage).toBe('perform');
    expect(kinds(run(list, fromWait.state, { performed: true }).effects)).toEqual(['finish']);
    // A beat that does not wait keeps its hold even once its outcome holds:
    // the card narrates on, and the perform is a no-op for the host.
    const plain: BeatRunState = { index: 0, stage: 'hold', heldMs: 50, pressedMs: 0 };
    expect(run(beats, plain, { performed: true }).state.stage).toBe('hold');
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

  it('local totality ends inside the event, after the peak, well before the partial tail runs out', () => {
    const end = totalityEndUtcMs(event!.peakUtcMs);
    expect(end).toBeGreaterThan(event!.peakUtcMs);
    expect(end).toBeLessThan(event!.endUtcMs - 60 * MIN);
  });

  it('the tutorial rates render as clean rate labels', () => {
    // The eclipse approach rides the "20 min/s" preset; the time-lapse rate is
    // deliberately off the preset ladder (see its comment), which the UI
    // supports: every readout formats the live rate, and the −/+ stepper snaps
    // off-ladder magnitudes back onto the ladder. Pin the labels so neither
    // rate drifts somewhere the formatter renders raggedly.
    expect(formatTimeRateLabel(TUTORIAL_TIMELAPSE_RATE, false)).toBe('1 hr/s');
    expect(formatTimeRateLabel(TUTORIAL_ECLIPSE_APPROACH_RATE, false)).toBe('20 min/s');
    const presets = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
    expect(presets).toContain(TUTORIAL_ECLIPSE_APPROACH_RATE);
  });
});

describe('eclipseClockPhase', () => {
  const peak = Date.parse('2027-08-02T10:06:41Z');
  const event = { startUtcMs: peak - 150 * MIN, peakUtcMs: peak, endUtcMs: peak + 150 * MIN };
  const settle = totalitySettleUtcMs(peak);

  it('approaches from first contact (and a little before) up to the settle instant', () => {
    expect(eclipseClockPhase(event.startUtcMs, event)).toBe('approach');
    expect(eclipseClockPhase(event.startUtcMs - TUTORIAL_ECLIPSE_APPROACH_MARGIN_MS, event)).toBe('approach');
    expect(eclipseClockPhase(settle - 1, event)).toBe('approach');
  });

  it('is totality from the settle instant to the end of local totality, the same lead past the peak', () => {
    expect(eclipseClockPhase(settle, event)).toBe('totality');
    expect(eclipseClockPhase(peak, event)).toBe('totality');
    expect(eclipseClockPhase(totalityEndUtcMs(peak), event)).toBe('totality');
    expect(totalityEndUtcMs(peak) - peak).toBe(peak - settle);
  });

  it('is away past totality — the partial tail where the Sun is back — and before the approach: a Now press, a date in 2028, a reverse run', () => {
    expect(eclipseClockPhase(totalityEndUtcMs(peak) + 1, event)).toBe('away');
    expect(eclipseClockPhase(peak + 30 * MIN, event)).toBe('away');
    expect(eclipseClockPhase(event.endUtcMs, event)).toBe('away');
    expect(eclipseClockPhase(Date.parse('2026-10-13T12:00:00Z'), event)).toBe('away');
    expect(eclipseClockPhase(Date.parse('2028-01-26T12:00:00Z'), event)).toBe('away');
    expect(eclipseClockPhase(event.startUtcMs - TUTORIAL_ECLIPSE_APPROACH_MARGIN_MS - 1, event)).toBe('away');
    expect(eclipseClockPhase(event.endUtcMs + 1, event)).toBe('away');
  });
});

describe('eclipseClimaxShown', () => {
  const peak = Date.parse('2027-08-02T10:06:41Z');
  const event = { startUtcMs: peak - 150 * MIN, peakUtcMs: peak, endUtcMs: peak + 150 * MIN };
  const settle = totalitySettleUtcMs(peak);

  it('never before totality was reached, even with the clock inside the window', () => {
    expect(eclipseClimaxShown(false, peak, event)).toBe(false);
  });

  it('shows while the reached totality still stands on the clock', () => {
    expect(eclipseClimaxShown(true, settle, event)).toBe(true);
    expect(eclipseClimaxShown(true, peak, event)).toBe(true);
    expect(eclipseClimaxShown(true, totalityEndUtcMs(peak), event)).toBe(true);
  });

  it('comes down when six minutes of realtime, a Now press, a date or a fast run carry the clock out, and back when the clock returns', () => {
    expect(eclipseClimaxShown(true, totalityEndUtcMs(peak) + 1, event)).toBe(false);
    expect(eclipseClimaxShown(true, peak + 10 * MIN, event)).toBe(false);
    expect(eclipseClimaxShown(true, event.endUtcMs, event)).toBe(false);
    expect(eclipseClimaxShown(true, Date.parse('2026-10-14T08:00:00Z'), event)).toBe(false);
    expect(eclipseClimaxShown(true, event.endUtcMs + 1, event)).toBe(false);
    expect(eclipseClimaxShown(true, settle - 1, event)).toBe(false);
    expect(eclipseClimaxShown(true, peak, event)).toBe(true);
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
