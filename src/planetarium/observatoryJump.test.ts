import { describe, expect, it } from 'vitest';
import { resolveJumpPolicy, type JumpPolicyInput } from './observatoryJump';
import type { SurfaceLandedInfo } from './surfaceView';

const EARTH: SurfaceLandedInfo = { type: 'planet', name: 'Earth' };
const MOON: SurfaceLandedInfo = { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
const MARS: SurfaceLandedInfo = { type: 'planet', name: 'Mars' };
const IO: SurfaceLandedInfo = { type: 'moon', name: 'Io', parentPlanet: 'Jupiter' };
const CALLISTO: SurfaceLandedInfo = { type: 'moon', name: 'Callisto', parentPlanet: 'Jupiter' };

function policy(over: Partial<JumpPolicyInput>) {
  return resolveJumpPolicy({
    eventParentPlanet: 'Earth',
    landed: EARTH,
    isStepper: false,
    guidesOn: false,
    ...over,
  });
}

describe('resolveJumpPolicy — relocation', () => {
  it('a stepper standing on the event system\'s moon relocates to the parent', () => {
    expect(policy({ isStepper: true, landed: MOON }).relocateToParent).toBe(true);
    expect(
      policy({ isStepper: true, landed: CALLISTO, eventParentPlanet: 'Jupiter' }).relocateToParent,
    ).toBe(true);
  });

  it('a stepper standing on the parent already has the namesake vantage', () => {
    expect(policy({ isStepper: true, landed: EARTH }).relocateToParent).toBe(false);
  });

  it('never relocates across systems — the destination could be unpainted', () => {
    expect(policy({ isStepper: true, landed: IO }).relocateToParent).toBe(false);
    expect(policy({ isStepper: true, landed: MOON, eventParentPlanet: 'Jupiter' }).relocateToParent)
      .toBe(false);
  });

  it('never relocates off another planet — only a moon has a one-tap return', () => {
    expect(policy({ isStepper: true, landed: MARS }).relocateToParent).toBe(false);
  });

  it('never relocates for an upcoming-list row, which promises this event from here', () => {
    expect(policy({ landed: MOON }).relocateToParent).toBe(false);
    expect(policy({ landed: CALLISTO, eventParentPlanet: 'Jupiter' }).relocateToParent).toBe(false);
  });

  it('treats a moon with no recorded parent as a non-match, not a wildcard', () => {
    const orphan: SurfaceLandedInfo = { type: 'moon', name: 'Moon' };
    expect(policy({ isStepper: true, landed: orphan }).relocateToParent).toBe(false);
  });
});

describe('resolveJumpPolicy — view', () => {
  it('watches from the ground by default, whoever asked and wherever you stand', () => {
    for (const landed of [EARTH, MOON, MARS, IO, CALLISTO]) {
      for (const isStepper of [true, false]) {
        expect(policy({ landed, isStepper }).view).toBe('surface');
      }
    }
  });

  it('stays in orbit while the shadow guides are on — the cones need the outside view', () => {
    for (const landed of [EARTH, MOON, MARS, IO, CALLISTO]) {
      for (const isStepper of [true, false]) {
        expect(policy({ landed, isStepper, guidesOn: true }).view).toBe('orbit');
      }
    }
  });

  it('guides decide the view without touching the vantage', () => {
    expect(policy({ isStepper: true, landed: MOON, guidesOn: true })).toEqual({
      relocateToParent: true,
      view: 'orbit',
    });
  });
});
