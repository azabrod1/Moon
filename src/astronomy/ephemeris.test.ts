/**
 * Golden tests for the Meeus-based ephemeris. Fixtures come from worked
 * examples in Meeus, "Astronomical Algorithms" (2nd ed.), and from published
 * event catalogs (USNO / NASA eclipse pages). The Meeus examples quote
 * Terrestrial Time JDs, so they exercise the theories directly; the event
 * searches run on UTC dates, where ΔT (~70 s) is far inside the tolerances.
 */
import { describe, expect, it } from 'vitest';
import {
  computeOrbitalState,
  dateToJD,
  findEvent,
  moonPosition,
  sunPosition,
} from './ephemeris';

const HOUR_MS = 3_600_000;

function utc(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`bad fixture date: ${iso}`);
  return date;
}

function expectWithinHours(found: Date | null, expectedIso: string, hours: number): void {
  expect(found).not.toBeNull();
  const deltaHours = Math.abs(found!.getTime() - utc(expectedIso).getTime()) / HOUR_MS;
  expect(deltaHours, `found ${found!.toISOString()}, expected ~${expectedIso}`).toBeLessThan(hours);
}

describe('dateToJD', () => {
  it('matches the J2000.0 epoch definition', () => {
    expect(dateToJD(utc('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 6);
  });

  it('matches Meeus example 7.a (Sputnik launch, 1957 Oct 4.81)', () => {
    expect(dateToJD(utc('1957-10-04T19:26:24Z'))).toBeCloseTo(2436116.31, 5);
  });

  it('handles January dates (the month-shift branch)', () => {
    expect(dateToJD(utc('1987-01-27T00:00:00Z'))).toBeCloseTo(2446822.5, 6);
  });
});

describe('sunPosition', () => {
  // Meeus example 25.a — 1992 Oct 13.0 TD (JDE 2448908.5):
  // apparent longitude 199°.90895, R = 0.99766 AU.
  it('matches Meeus example 25.a', () => {
    const sun = sunPosition(2448908.5);
    expect(sun.longitude).toBeCloseTo(199.90895, 2);
    expect(sun.distance).toBeCloseTo(0.99766, 4);
  });
});

describe('moonPosition', () => {
  // Meeus example 47.a — 1992 Apr 12.0 TD (JDE 2448724.5). Full-series truth:
  // λ = 133.162655°, β = −3.229126°, Δ = 368 409.7 km, mean node Ω = 274.4005°.
  // This module's series is truncated; measured deltas at this date are
  // +0.0009° lon, +0.0105° lat, −5.0 km — bounds are set just above that so
  // any term change trips deliberately.
  it('matches Meeus example 47.a within truncation error', () => {
    const moon = moonPosition(2448724.5);
    expect(Math.abs(moon.longitude - 133.162655)).toBeLessThan(0.005);
    expect(Math.abs(moon.latitude - -3.229126)).toBeLessThan(0.02);
    expect(Math.abs(moon.distance - 368409.7)).toBeLessThan(25);
    expect(moon.ascending_node).toBeCloseTo(274.4005, 1);
  });
});

describe('findEvent against published catalogs (UTC, ±6 h)', () => {
  it('finds the 2025-01-13 full moon', () => {
    expectWithinHours(findEvent('full-moon', utc('2025-01-01T00:00:00Z'), 1), '2025-01-13T22:27:00Z', 6);
  });

  it('finds the previous full moon across a month boundary', () => {
    expectWithinHours(findEvent('full-moon', utc('2025-01-01T00:00:00Z'), -1), '2024-12-15T09:02:00Z', 6);
  });

  it('finds the 2025-01-29 new moon', () => {
    expectWithinHours(findEvent('new-moon', utc('2025-01-01T00:00:00Z'), 1), '2025-01-29T12:36:00Z', 6);
  });

  it('finds the 2025-03-14 total lunar eclipse, skipping two eclipse-free full moons', () => {
    expectWithinHours(findEvent('lunar-eclipse', utc('2025-01-01T00:00:00Z'), 1), '2025-03-14T06:59:00Z', 6);
  });

  it('finds the 2025-09-07 total lunar eclipse', () => {
    expectWithinHours(findEvent('lunar-eclipse', utc('2025-04-01T00:00:00Z'), 1), '2025-09-07T18:12:00Z', 6);
  });

  it('finds the 2026-02-17 annular solar eclipse', () => {
    expectWithinHours(findEvent('solar-eclipse', utc('2026-01-01T00:00:00Z'), 1), '2026-02-17T12:12:00Z', 6);
  });

  it('finds the 2026-08-12 total solar eclipse, skipping five eclipse-free new moons', () => {
    expectWithinHours(findEvent('solar-eclipse', utc('2026-03-01T00:00:00Z'), 1), '2026-08-12T17:46:00Z', 6);
  });
});

describe('search ↔ state self-consistency', () => {
  // "Jump to event" must land on a picture that matches the event: the state
  // the renderer derives at a found date has to agree with the search.
  it('a found full moon renders as full', () => {
    const fullMoon = findEvent('full-moon', utc('2026-01-01T00:00:00Z'), 1)!;
    const state = computeOrbitalState(fullMoon);
    expect(state.illumination).toBeGreaterThan(0.98);
    expect(state.phaseName).toBe('Full Moon');
  });

  it('a found lunar eclipse is a full moon near the ecliptic', () => {
    const eclipse = findEvent('lunar-eclipse', utc('2025-01-01T00:00:00Z'), 1)!;
    const state = computeOrbitalState(eclipse);
    expect(state.illumination).toBeGreaterThan(0.98);
    expect(Math.abs(state.moonLatitude)).toBeLessThan(1.5);
    expect(state.eclipseType).toBe('lunar');
  });

  it('a found solar eclipse is a new moon near the ecliptic', () => {
    const eclipse = findEvent('solar-eclipse', utc('2026-03-01T00:00:00Z'), 1)!;
    const state = computeOrbitalState(eclipse);
    expect(state.illumination).toBeLessThan(0.02);
    expect(Math.abs(state.moonLatitude)).toBeLessThan(1.5);
    expect(state.eclipseType).toBe('solar');
  });
});
