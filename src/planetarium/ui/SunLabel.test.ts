import { describe, expect, it } from 'vitest';
import { shouldShowSunLabel, SUN_LABEL_MIN_DISTANCE_AU } from './SunLabel';

describe('shouldShowSunLabel', () => {
  it('hides the label throughout Mars orbit and closer to the Sun', () => {
    expect(shouldShowSunLabel(0.05)).toBe(false);
    expect(shouldShowSunLabel(1.524)).toBe(false);
    expect(shouldShowSunLabel(SUN_LABEL_MIN_DISTANCE_AU)).toBe(false);
  });

  it('shows the label after travelling beyond Mars orbit', () => {
    expect(shouldShowSunLabel(SUN_LABEL_MIN_DISTANCE_AU + 0.001)).toBe(true);
    expect(shouldShowSunLabel(5.2)).toBe(true);
  });
});
