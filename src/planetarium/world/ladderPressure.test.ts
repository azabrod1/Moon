import { describe, expect, it } from 'vitest';
import { planLadderPressure, RELEASE_PRESSURE_DWELL_MS, type LadderPressureState } from './ladderPressure';

const MiB = 1024 * 1024;

function state(over: Partial<LadderPressureState> = {}): LadderPressureState {
  return {
    ladderBytes: 100 * MiB,
    ceilingBytes: 200 * MiB,
    blockedDemand: false,
    pressureSinceMs: null,
    nowMs: 0,
    swapInFlight: false,
    restoreQueued: false,
    tilesShort: false,
    tilesShortSinceMs: null,
    ...over,
  };
}

describe('what counts as pressure', () => {
  it('is nothing while the maps fit and nothing is being refused', () => {
    expect(planLadderPressure(state()).pressureSinceMs).toBeNull();
  });

  it('is maps already over the ladder\'s share', () => {
    const plan = planLadderPressure(state({ ladderBytes: 201 * MiB, nowMs: 5_000 }));
    expect(plan.pressureSinceMs).toBe(5_000);
  });

  it('is a rung a body is earning that the ledger will not fit', () => {
    // Without this the ladder would sit exactly at its share refusing every
    // new rung forever, with nothing ever handing a map back.
    const plan = planLadderPressure(state({ blockedDemand: true, nowMs: 5_000 }));
    expect(plan.pressureSinceMs).toBe(5_000);
  });

  it('is not maps exactly at the share, which fit', () => {
    expect(planLadderPressure(state({ ladderBytes: 200 * MiB })).pressureSinceMs).toBeNull();
  });

  it('keeps the start of the spell rather than restamping it every frame', () => {
    const plan = planLadderPressure(state({ blockedDemand: true, pressureSinceMs: 1_000, nowMs: 4_000 }));
    expect(plan.pressureSinceMs).toBe(1_000);
  });

  it('clears the moment the pressure goes, so a fresh spell owes the dwell again', () => {
    expect(planLadderPressure(state({ pressureSinceMs: 1_000, nowMs: 9_000 })).pressureSinceMs).toBeNull();
  });
});

describe('the dwell before anything is given back', () => {
  it('refuses a release while the pressure is younger than the dwell', () => {
    const plan = planLadderPressure(state({
      blockedDemand: true, pressureSinceMs: 1_000, nowMs: 1_000 + RELEASE_PRESSURE_DWELL_MS - 1,
    }));
    expect(plan.releaseDue).toBe(false);
  });

  it('allows one once the dwell is served', () => {
    const plan = planLadderPressure(state({
      blockedDemand: true, pressureSinceMs: 1_000, nowMs: 1_000 + RELEASE_PRESSURE_DWELL_MS,
    }));
    expect(plan.releaseDue).toBe(true);
  });

  it('never allows one with no pressure at all, however long the frame', () => {
    expect(planLadderPressure(state({ nowMs: 10 * RELEASE_PRESSURE_DWELL_MS })).releaseDue).toBe(false);
  });

  it('holds off while a swap is already in the air: one at a time, each holding both maps', () => {
    const plan = planLadderPressure(state({
      blockedDemand: true, pressureSinceMs: 0, nowMs: RELEASE_PRESSURE_DWELL_MS, swapInFlight: true,
    }));
    expect(plan.releaseDue).toBe(false);
  });

  it('takes the dwell from the caller when it is given one', () => {
    const plan = planLadderPressure(state({
      blockedDemand: true, pressureSinceMs: 0, nowMs: 50, dwellMs: 50,
    }));
    expect(plan.releaseDue).toBe(true);
  });
});

describe('a rung waiting on a stand-in comes first', () => {
  it('starts the queued re-fetch before any discretionary release', () => {
    const plan = planLadderPressure(state({
      restoreQueued: true, blockedDemand: true, pressureSinceMs: 0, nowMs: RELEASE_PRESSURE_DWELL_MS,
    }));
    expect(plan.restoreFirst).toBe(true);
  });

  it('starts one even with no pressure at all — a soft globe is not discretionary', () => {
    const plan = planLadderPressure(state({ restoreQueued: true }));
    expect(plan.restoreFirst).toBe(true);
    expect(plan.releaseDue).toBe(false);
  });

  it('waits its turn while a swap is in the air: both take the same slot', () => {
    const plan = planLadderPressure(state({ restoreQueued: true, swapInFlight: true }));
    expect(plan.restoreFirst).toBe(false);
  });

  it('asks for nothing when the queue is empty', () => {
    expect(planLadderPressure(state()).restoreFirst).toBe(false);
  });
});

describe('the tiles\' shortfall', () => {
  it('counts the tiles\' shortfall as pressure after the dwell', () => {
    // A ladder inside its own share, refusing nothing, while the tiles want a
    // set only the maps' bytes keep out: nothing else would ever hand a map
    // back for them.
    const first = planLadderPressure(state({ tilesShort: true, nowMs: 5_000 }));
    expect(first.tilesShortSinceMs).toBe(5_000);
    expect(first.tilesReleaseDue).toBe(false);
    const young = planLadderPressure(state({
      tilesShort: true, tilesShortSinceMs: 5_000, nowMs: 5_000 + RELEASE_PRESSURE_DWELL_MS - 1,
    }));
    expect(young.tilesShortSinceMs).toBe(5_000);
    expect(young.tilesReleaseDue).toBe(false);
    const served = planLadderPressure(state({
      tilesShort: true, tilesShortSinceMs: 5_000, nowMs: 5_000 + RELEASE_PRESSURE_DWELL_MS,
    }));
    expect(served.tilesReleaseDue).toBe(true);
    // ...one swap at a time, like any other release,
    expect(planLadderPressure(state({
      tilesShort: true, tilesShortSinceMs: 0, nowMs: RELEASE_PRESSURE_DWELL_MS, swapInFlight: true,
    })).tilesReleaseDue).toBe(false);
    // ...a fresh spell owes the dwell again,
    expect(planLadderPressure(state({ tilesShortSinceMs: 5_000, nowMs: 9_000 })).tilesShortSinceMs).toBeNull();
    // ...and where the ladder's own pressure is due it plans as it always
    // has, from every candidate rather than the tiles' narrower set.
    const both = planLadderPressure(state({
      blockedDemand: true, pressureSinceMs: 0, tilesShort: true, tilesShortSinceMs: 0,
      nowMs: RELEASE_PRESSURE_DWELL_MS,
    }));
    expect(both.releaseDue).toBe(true);
    expect(both.tilesReleaseDue).toBe(false);
  });

  it('keeps it out of the latch arrival goals read', () => {
    // pressureSinceMs is also what cuts a committed arrival's warm goals
    // short (arrivalWarmGoalsExpired): Earth's tiles short at Earth must not
    // end the climb of Earth's own maps.
    const plan = planLadderPressure(state({
      tilesShort: true, tilesShortSinceMs: 0, nowMs: 10 * RELEASE_PRESSURE_DWELL_MS,
    }));
    expect(plan.tilesReleaseDue).toBe(true);
    expect(plan.pressureSinceMs).toBeNull();
    expect(plan.releaseDue).toBe(false);
  });
});
