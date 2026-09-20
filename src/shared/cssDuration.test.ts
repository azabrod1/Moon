import { describe, expect, it } from 'vitest';
import { parseCssDurationMs } from './cssDuration';

describe('a CSS time read back off an element', () => {
  it('reads seconds and milliseconds', () => {
    expect(parseCssDurationMs('0.25s')).toBe(250);
    expect(parseCssDurationMs('0.3s')).toBeCloseTo(300, 9);
    expect(parseCssDurationMs('250ms')).toBe(250);
    expect(parseCssDurationMs('0s')).toBe(0);
    expect(parseCssDurationMs('  0.2s ')).toBeCloseTo(200, 9);
  });

  it('takes the first of a list: one property is what is being waited on', () => {
    expect(parseCssDurationMs('0.3s, 0.1s')).toBeCloseTo(300, 9);
    expect(parseCssDurationMs('120ms,0.5s')).toBe(120);
  });

  it('gives null where there is no time to read, so the caller can choose its own', () => {
    expect(parseCssDurationMs('')).toBeNull();
    expect(parseCssDurationMs('   ')).toBeNull();
    expect(parseCssDurationMs('normal')).toBeNull();
    expect(parseCssDurationMs('12')).toBeNull(); // a unitless number is not a time
    expect(parseCssDurationMs('-1s')).toBeNull();
  });
});
