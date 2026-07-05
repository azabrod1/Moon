import { describe, expect, it } from 'vitest';
import {
  TOUR_STEPS,
  TOUR_ECLIPSE,
  TOUR_TIMELAPSE_RATE,
  TOUR_ECLIPSE_APPROACH_RATE,
  TOUR_SETTLE_DWELL_MS,
  totalitySettleUtcMs,
  tourTransition,
  isStepSettled,
  restorePlan,
  canStartTour,
} from './tourLogic';
import type { RestoreContext, SettleSignals, TourPhase, TourTransitionEvent } from './tourLogic';
import { findShadowEvent } from '../astronomy/shadows';

const MIN = 60_000;

describe('TOUR_STEPS', () => {
  it('is the six-card deck in order, ids unique', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      'welcome',
      'saturn',
      'moon',
      'timelapse',
      'eclipse',
      'wrap',
    ]);
  });

  it('stages match the cards: bookends card-only, the middle four scene-staged', () => {
    expect(TOUR_STEPS.map((s) => s.stage)).toEqual([
      'none',
      'saturn',
      'moon',
      'timelapse',
      'eclipse',
      'none',
    ]);
  });

  it('card-only steps settle instantly; staged steps wait out arrivals and dwell', () => {
    for (const step of TOUR_STEPS) {
      if (step.stage === 'none') {
        expect(step.settle).toEqual({ arrival: false, fov: false, dwellMs: 0 });
      } else {
        expect(step.settle.arrival).toBe(true);
        expect(step.settle.dwellMs).toBe(TOUR_SETTLE_DWELL_MS);
      }
    }
  });

  it('surface-view steps (timelapse, eclipse) also wait out the FOV glide', () => {
    for (const step of TOUR_STEPS) {
      const surface = step.stage === 'timelapse' || step.stage === 'eclipse';
      expect(step.settle.fov).toBe(surface);
    }
  });

  it('only the eclipse card swaps bodies at totality; only the wrap card has a caption', () => {
    for (const step of TOUR_STEPS) {
      expect(step.totalityBody !== undefined).toBe(step.id === 'eclipse');
      expect(step.caption !== undefined).toBe(step.id === 'wrap');
    }
  });

  it('every card has complete copy', () => {
    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.primaryLabel.length).toBeGreaterThan(0);
      expect(step.ghostLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('tourTransition', () => {
  const PHASES: TourPhase[] = ['staging', 'settling', 'ready', 'ending'];

  it('next stages only from ready', () => {
    expect(tourTransition('ready', 'next')).toBe('staging');
    for (const phase of PHASES.filter((p) => p !== 'ready')) {
      expect(tourTransition(phase, 'next')).toBe(phase);
    }
  });

  it('staged moves staging → settling and nothing else', () => {
    expect(tourTransition('staging', 'staged')).toBe('settling');
    for (const phase of PHASES.filter((p) => p !== 'staging')) {
      expect(tourTransition(phase, 'staged')).toBe(phase);
    }
  });

  it('settled moves settling → ready and nothing else', () => {
    expect(tourTransition('settling', 'settled')).toBe('ready');
    for (const phase of PHASES.filter((p) => p !== 'settling')) {
      expect(tourTransition(phase, 'settled')).toBe(phase);
    }
  });

  it('skip and abort end the tour from any phase', () => {
    for (const phase of PHASES) {
      for (const event of ['skip', 'abort'] as TourTransitionEvent[]) {
        expect(tourTransition(phase, event)).toBe('ending');
      }
    }
  });
});

describe('isStepSettled', () => {
  const IDLE: SettleSignals = {
    arrivalInFlight: false,
    veilCovering: false,
    fovAnimating: false,
    sinceStagedMs: TOUR_SETTLE_DWELL_MS,
  };
  const FULL = { arrival: true, fov: true, dwellMs: TOUR_SETTLE_DWELL_MS };

  it('settles when every required signal is idle and the dwell has passed', () => {
    expect(isStepSettled(IDLE, FULL)).toBe(true);
  });

  it('dwell boundary: the exact dwell settles, one ms short does not', () => {
    expect(isStepSettled({ ...IDLE, sinceStagedMs: TOUR_SETTLE_DWELL_MS - 1 }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, sinceStagedMs: TOUR_SETTLE_DWELL_MS }, FULL)).toBe(true);
  });

  it('an in-flight arrival or a covering veil blocks when arrival is required', () => {
    expect(isStepSettled({ ...IDLE, arrivalInFlight: true }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, veilCovering: true }, FULL)).toBe(false);
  });

  it('the FOV glide blocks only when required', () => {
    expect(isStepSettled({ ...IDLE, fovAnimating: true }, FULL)).toBe(false);
    expect(isStepSettled({ ...IDLE, fovAnimating: true }, { ...FULL, fov: false })).toBe(true);
  });

  it('signals not required are ignored (card-only steps settle immediately)', () => {
    const busy: SettleSignals = {
      arrivalInFlight: true,
      veilCovering: true,
      fovAnimating: true,
      sinceStagedMs: 0,
    };
    expect(isStepSettled(busy, { arrival: false, fov: false, dwellMs: 0 })).toBe(true);
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

describe('canStartTour', () => {
  it('starts only when nothing else owns the session', () => {
    expect(
      canStartTour({ missionActive: false, resumePromptVisible: false, alreadyActive: false }),
    ).toBe(true);
    expect(
      canStartTour({ missionActive: true, resumePromptVisible: false, alreadyActive: false }),
    ).toBe(false);
    expect(
      canStartTour({ missionActive: false, resumePromptVisible: true, alreadyActive: false }),
    ).toBe(false);
    expect(
      canStartTour({ missionActive: false, resumePromptVisible: false, alreadyActive: true }),
    ).toBe(false);
  });
});

describe('the showcase eclipse', () => {
  // Deliberately redundant with the EclipseWise pin in shadows.test.ts: if the
  // engine drifts, this failure points straight at the tour's staging inputs.
  const event = findShadowEvent(TOUR_ECLIPSE.spec, TOUR_ECLIPSE.searchFromUtcMs, 1);

  it('the fixed search finds the 2027-08-02 total solar eclipse', () => {
    expect(event).not.toBeNull();
    expect(event!.classification).toBe('total');
    expect(Math.abs(event!.peakUtcMs - TOUR_ECLIPSE.expectedPeakUtcMs)).toBeLessThan(20 * MIN);
  });

  it('the totality settle instant lands inside the event, before the peak', () => {
    const settle = totalitySettleUtcMs(event!.peakUtcMs);
    expect(settle).toBeGreaterThan(event!.startUtcMs);
    expect(settle).toBeLessThan(event!.peakUtcMs);
  });

  it('the tour rates are transport-strip presets', () => {
    // PlanetariumMode's TIME_RATE_PRESETS — the strip labels them "1 hr/s" and
    // "20 min/s"; a non-preset rate would render an unlabeled notch.
    const presets = [1, 60, 1200, 3600, 21600, 86400, 604800, 2592000, 31557600];
    expect(presets).toContain(TOUR_TIMELAPSE_RATE);
    expect(presets).toContain(TOUR_ECLIPSE_APPROACH_RATE);
  });
});
