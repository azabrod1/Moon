import { describe, expect, it, beforeEach } from 'vitest';
import { INTERIOR_TRANSITION, setInteriorTransition } from './interiorTransition';

const SHIPPED = { openS: 0.5, closeS: 0.25, dissolveS: 0.25, reopenS: 0.5, revealAfterVeil: true };

describe('the ceremony\'s lengths', () => {
  beforeEach(() => { setInteriorTransition(SHIPPED); });

  it('ships candidate A, and the cut waits for the veil', () => {
    expect({ ...INTERIOR_TRANSITION }).toEqual(SHIPPED);
  });

  it('takes a partial patch and leaves the rest alone', () => {
    const after = setInteriorTransition({ closeS: 0.18 });
    expect(after.closeS).toBe(0.18);
    expect(after.openS).toBe(SHIPPED.openS);
    expect(INTERIOR_TRANSITION.closeS).toBe(0.18);
    // What comes back is a copy: writing to it must not move the ceremony.
    after.openS = 99;
    expect(INTERIOR_TRANSITION.openS).toBe(SHIPPED.openS);
  });

  it('ignores anything that is not a length, so a typo leaves the ceremony alone', () => {
    setInteriorTransition({ openS: Number.NaN, closeS: -1, dissolveS: Number.POSITIVE_INFINITY });
    expect(INTERIOR_TRANSITION.openS).toBe(SHIPPED.openS);
    expect(INTERIOR_TRANSITION.closeS).toBe(SHIPPED.closeS);
    expect(INTERIOR_TRANSITION.dissolveS).toBe(SHIPPED.dissolveS);
    setInteriorTransition({ openS: 'quick' as unknown as number });
    expect(INTERIOR_TRANSITION.openS).toBe(SHIPPED.openS);
    // Zero is a length: it is how a move lands at once.
    setInteriorTransition({ reopenS: 0 });
    expect(INTERIOR_TRANSITION.reopenS).toBe(0);
  });

  it('takes only a boolean for the order', () => {
    setInteriorTransition({ revealAfterVeil: 0 as unknown as boolean });
    expect(INTERIOR_TRANSITION.revealAfterVeil).toBe(true);
    setInteriorTransition({ revealAfterVeil: false });
    expect(INTERIOR_TRANSITION.revealAfterVeil).toBe(false);
  });
});
