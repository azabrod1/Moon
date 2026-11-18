/**
 * The phase as drawn, against published values:
 *  - lit fraction: JPL Horizons' observer table (Moon from Earth's centre,
 *    quantity 10 "Illu%"), fetched 2026-11-17;
 *  - full and new moon: the instants ephemeris.test.ts already cites from the
 *    published catalogs, to the minute.
 */
import { describe, expect, it } from 'vitest';
import { findLunarPhaseEvent, lunarPhaseAt } from './lunarPhase';

describe('lunarPhaseAt', () => {
  it.each([
    { utc: '2025-01-14T00:00:00Z', percent: 99.83749 },
    { utc: '2025-01-24T18:00:00Z', percent: 23.7461 },
    { utc: '2025-02-04T06:00:00Z', percent: 37.84878 },
    { utc: '2026-11-17T00:00:00Z', percent: 45.37378 },
    { utc: '2026-11-30T15:00:00Z', percent: 57.04863 },
  ])('lights $percent% of the disc at $utc, as Horizons has it', ({ utc, percent }) => {
    expect(Math.abs(lunarPhaseAt(Date.parse(utc)).illumination * 100 - percent)).toBeLessThan(0.05);
  });

  it('names the phase from the side of the Sun the Moon is on', () => {
    expect(lunarPhaseAt(Date.parse('2025-01-14T00:00:00Z')).phaseName).toBe('Full Moon');
    // Horizons' 2025-01-24 18:00 Moon is a 24% crescent after full: waning.
    expect(lunarPhaseAt(Date.parse('2025-01-24T18:00:00Z')).phaseName).toBe('Waning Crescent');
    expect(lunarPhaseAt(Date.parse('2025-02-04T06:00:00Z')).phaseName).toBe('Waxing Crescent');
  });
});

describe('findLunarPhaseEvent', () => {
  const minutesFrom = (foundMs: number | null, published: string) =>
    Math.abs((foundMs ?? Number.NaN) - Date.parse(published)) / 60_000;

  it('finds the published full and new moons to the minute', () => {
    expect(minutesFrom(findLunarPhaseEvent('full-moon', Date.parse('2025-01-01T00:00:00Z'), 1), '2025-01-13T22:27:00Z')).toBeLessThan(1);
    expect(minutesFrom(findLunarPhaseEvent('full-moon', Date.parse('2025-01-01T00:00:00Z'), -1), '2024-12-15T09:02:00Z')).toBeLessThan(1);
    expect(minutesFrom(findLunarPhaseEvent('new-moon', Date.parse('2025-01-01T00:00:00Z'), 1), '2025-01-29T12:36:00Z')).toBeLessThan(1);
  });

  it('lands where the drawn Moon is exactly opposite the Sun in longitude', () => {
    const fullMs = findLunarPhaseEvent('full-moon', Date.parse('2026-11-17T00:00:00Z'), 1)!;
    expect(Math.abs(Math.abs(lunarPhaseAt(fullMs).elongationDeg) - 180)).toBeLessThan(1e-4);
  });
});
