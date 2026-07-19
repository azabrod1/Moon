import { describe, expect, it } from 'vitest';
import { isRepeatedSurfacePauseActivation } from './ObservatoryHUD';

describe('surface Pause activation timing', () => {
  it('rejects a queued second activation by physical event time', () => {
    expect(isRepeatedSurfacePauseActivation(1_000, 1_240)).toBe(true);
    expect(isRepeatedSurfacePauseActivation(1_000, 1_350)).toBe(true);
  });

  it('accepts a later deliberate Resume', () => {
    expect(isRepeatedSurfacePauseActivation(1_000, 1_351)).toBe(false);
  });

  it('accepts first and reset-timeline activations', () => {
    expect(isRepeatedSurfacePauseActivation(null, 1_000)).toBe(false);
    expect(isRepeatedSurfacePauseActivation(1_000, 20)).toBe(false);
  });
});
