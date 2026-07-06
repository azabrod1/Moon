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
} from './tutorialLogic';
import type { RestoreContext, SettleSignals, TutorialPhase, TutorialTransitionEvent } from './tutorialLogic';
import { findShadowEvent } from '../astronomy/shadows';
import { formatTimeRateLabel } from '../astronomy/planetary';

const MIN = 60_000;

describe('TUTORIAL_STEPS', () => {
  it('is the six-card deck in order, ids unique', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      'welcome',
      'saturn',
      'moon',
      'timelapse',
      'eclipse',
      'wrap',
    ]);
  });

  it('stages match the cards: bookends card-only, the middle four scene-staged', () => {
    expect(TUTORIAL_STEPS.map((s) => s.stage)).toEqual([
      'none',
      'saturn',
      'moon',
      'timelapse',
      'eclipse',
      'none',
    ]);
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

  it('only the eclipse enters surface view, so only it waits out the FOV glide', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.settle.fov).toBe(step.stage === 'eclipse');
    }
  });

  it('only the eclipse holds Next for the totality moment', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.settle.totality).toBe(step.stage === 'eclipse');
    }
  });

  it('only the eclipse card swaps bodies at totality', () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.totalityBody !== undefined).toBe(step.id === 'eclipse');
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

  it('next stages only from ready', () => {
    expect(tutorialTransition('ready', 'next')).toBe('staging');
    for (const phase of PHASES.filter((p) => p !== 'ready')) {
      expect(tutorialTransition(phase, 'next')).toBe(phase);
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
    });
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
