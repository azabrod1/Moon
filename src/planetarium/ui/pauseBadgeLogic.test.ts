import { describe, expect, it } from 'vitest';
import { pauseBadgeVisible, type PauseBadgeInput } from './pauseBadgeLogic';

const pausedInCruise: PauseBadgeInput = {
  paused: true,
  surfaceView: false,
  helpOpen: false,
  missionActive: false,
  tutorialActive: false,
};

describe('pauseBadgeVisible', () => {
  it('shows for a paused clock in cruise, over the map and on the ground', () => {
    expect(pauseBadgeVisible(pausedInCruise)).toBe(true);
  });

  it('never shows while the clock runs, whatever else is up', () => {
    expect(pauseBadgeVisible({ ...pausedInCruise, paused: false })).toBe(false);
  });

  it('stays down in surface view, whose transport strip already says PAUSED', () => {
    expect(pauseBadgeVisible({ ...pausedInCruise, surfaceView: true })).toBe(false);
  });

  it('stays down under the Help modal, whose own freeze is restored on close', () => {
    expect(pauseBadgeVisible({ ...pausedInCruise, helpOpen: true })).toBe(false);
  });

  it('stays down during a historic mission, whose milestones pause the clock and then fly', () => {
    expect(pauseBadgeVisible({ ...pausedInCruise, missionActive: true })).toBe(false);
  });

  it('stays down during the tutorial, whose card sits where the badge goes on a phone', () => {
    expect(pauseBadgeVisible({ ...pausedInCruise, tutorialActive: true })).toBe(false);
  });
});
