import { describe, it, expect } from 'vitest';
import {
  formatCountdown,
  liveEventVerb,
  observatoryPhaseText,
  observatoryWatchRowState,
  observatoryWindowState,
  phaseGlyphLitPath,
  sheetReleaseTarget,
  type ObservatoryWindowInput,
} from './ObservatoryPanel';
import type { ShadowEvent } from '../../astronomy/shadows';
import type { SurfaceEventInfo, SurfaceLandedInfo } from '../surfaceView';

// Pins for the bottom sheet's free-drag release decision (≤640px form).
// dy is finger travel in px, down positive; target height = start − dy.
// Tap discrimination (|dy| < 6 on the handle) happens at the call site — the
// function only ever sees drags. 'peek'/'full' are tracking states (they
// follow the floor/ceiling as content changes); a number is a hand-picked px.
describe('sheetReleaseTarget', () => {
  const FULL = 500;
  const PEEK = 200;

  it('parks where the finger leaves it — no detent snap', () => {
    expect(sheetReleaseTarget(300, -50, FULL, PEEK)).toBe(350);
    expect(sheetReleaseTarget(300, 91, FULL, PEEK)).toBe(209);
    expect(sheetReleaseTarget(PEEK, -150, FULL, PEEK)).toBe(350);
  });

  it('snaps releases within 8px of an edge onto the tracking state', () => {
    expect(sheetReleaseTarget(300, -192, FULL, PEEK)).toBe('full'); // target 492
    expect(sheetReleaseTarget(300, -191, FULL, PEEK)).toBe(491);
    expect(sheetReleaseTarget(300, 92, FULL, PEEK)).toBe('peek'); // target 208
    expect(sheetReleaseTarget(300, 91, FULL, PEEK)).toBe(209);
  });

  it('clamps overshoot past the ceiling to the tracking full state', () => {
    expect(sheetReleaseTarget(300, -300, FULL, PEEK)).toBe('full'); // target 600
    expect(sheetReleaseTarget(FULL, -1, FULL, PEEK)).toBe('full');
  });

  it('from the floor: a >80px pull down dismisses, exactly 80 settles back', () => {
    expect(sheetReleaseTarget(PEEK, 81, FULL, PEEK)).toBe('dismiss');
    expect(sheetReleaseTarget(PEEK, 80, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseTarget(PEEK, 0, FULL, PEEK)).toBe('peek');
  });

  it('from height: a dismiss must travel the whole stack plus the threshold', () => {
    // start 500 → target must fall below 200 − 80 = 120: dy > 380.
    expect(sheetReleaseTarget(FULL, 380, FULL, PEEK)).toBe('peek');
    expect(sheetReleaseTarget(FULL, 381, FULL, PEEK)).toBe('dismiss');
  });

  it('between-floor-and-ceiling pulls below the floor settle at peek', () => {
    expect(sheetReleaseTarget(300, 150, FULL, PEEK)).toBe('peek'); // target 150
    expect(sheetReleaseTarget(300, 179, FULL, PEEK)).toBe('peek'); // target 121
    expect(sheetReleaseTarget(300, 181, FULL, PEEK)).toBe('dismiss'); // target 119
  });

  it('degenerate (content no taller than the peek): only dismiss acts', () => {
    expect(sheetReleaseTarget(200, 81, 200, 200)).toBe('dismiss');
    expect(sheetReleaseTarget(200, 80, 200, 200)).toBe('peek');
    expect(sheetReleaseTarget(200, -200, 200, 200)).toBe('peek');
  });

  it('clamps a peek measurement that exceeds full (measurement race)', () => {
    // Effective floor = min(600, 500) = 500 = ceiling → degenerate.
    expect(sheetReleaseTarget(500, 81, 500, 600)).toBe('dismiss');
    expect(sheetReleaseTarget(500, 80, 500, 600)).toBe('peek');
    expect(sheetReleaseTarget(500, -100, 500, 600)).toBe('peek');
  });

  it('nearly-degenerate range resolves every park to a tracking state — peek wins the overlap', () => {
    // floor 490, ceiling 500: the two 8px snap ranges cover the whole range
    // (peek's reaches 498, full's starts at 492); peek wins where they overlap.
    expect(sheetReleaseTarget(495, -3, 500, 490)).toBe('peek'); // target 498: both
    expect(sheetReleaseTarget(495, 3, 500, 490)).toBe('peek'); // target 492: both
    expect(sheetReleaseTarget(495, -4, 500, 490)).toBe('full'); // target 499: full only
  });
});

describe('observatoryPhaseText subject kinds', () => {
  const T = Date.UTC(2026, 6, 4);

  it('phase-less subjects have no phase line (their heroes render otherwise)', () => {
    expect(observatoryPhaseText(T, { kind: 'events-only', parentName: 'Jupiter' })).toBeNull();
    expect(
      observatoryPhaseText(T, { kind: 'companionless', planetName: 'Mercury', tintCss: '#8c8c94' }),
    ).toBeNull();
  });

  it('phase subjects do', () => {
    expect(
      observatoryPhaseText(T, { kind: 'earth', subject: 'Moon', angularDiameterDeg: 0.5, distanceKm: 384_400 }),
    ).not.toBeNull();
  });
});

// The sky window's copy table. Titles are observer-true — they name the
// sight from where the player stands — and the sub-line carries the offer,
// naming a destination only when stepping through moves you there.
describe('observatoryWindowState', () => {
  const onEarth: SurfaceLandedInfo = { type: 'planet', name: 'Earth' };
  const onMoon: SurfaceLandedInfo = { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
  const onMars: SurfaceLandedInfo = { type: 'planet', name: 'Mars' };
  const onJupiter: SurfaceLandedInfo = { type: 'planet', name: 'Jupiter' };
  const onEuropa: SurfaceLandedInfo = { type: 'moon', name: 'Europa', parentPlanet: 'Jupiter' };
  const solar: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' };
  const lunar: SurfaceEventInfo = { kind: 'eclipse', parentPlanet: 'Earth', moonName: 'Moon' };
  const ioTransit: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Jupiter', moonName: 'Io' };

  const state = (over: Partial<ObservatoryWindowInput>) =>
    observatoryWindowState({
      surfaceActive: false,
      lookupOpensMenu: false,
      landed: onEarth,
      live: null,
      relocates: false,
      hasPhase: true,
      ...over,
    });

  it('on the surface the same slot is the way back out', () => {
    const s = state({ surfaceActive: true, live: { spec: solar, classification: 'total' } });
    expect(s.mode).toBe('return');
    expect(s.title).toBe('Return to orbit');
    expect(s.sub).toBe('Leave the surface · Esc');
    expect(s.glyph).toBe('orbit');
    expect(s.showNow).toBe(false);
    expect(s.relocates).toBe(false);
  });

  it('idle names the ground you are standing on', () => {
    expect(state({}).title).toBe('Look up');
    expect(state({}).sub).toBe('See the sky from Earth');
    expect(state({ landed: onMoon }).sub).toBe('See the sky from the Moon');
    expect(state({}).showNow).toBe(false);
  });

  it('idle says so where the step opens the picker first', () => {
    expect(state({ landed: onMars, lookupOpensMenu: true }).sub).toBe(
      'Choose what to watch from Mars',
    );
  });

  it('a vantage with no phase subject shows bare stars, never an invented disc', () => {
    expect(state({}).glyph).toBe('phase');
    expect(state({ landed: onJupiter, hasPhase: false }).glyph).toBe('stars');
  });

  it('standing on Earth, its own events take their almanac names', () => {
    expect(state({ live: { spec: solar, classification: 'total' } }).title).toBe(
      'Total eclipse overhead',
    );
    expect(state({ live: { spec: solar, classification: 'annular' } }).title).toBe(
      'Annular eclipse overhead',
    );
    expect(state({ live: { spec: lunar, classification: 'partial' } }).title).toBe(
      'Lunar eclipse overhead',
    );
  });

  it('elsewhere the title is what an observer there would actually see', () => {
    expect(
      state({ landed: onMoon, live: { spec: solar, classification: 'total' } }).title,
    ).toBe('Your shadow is crossing Earth');
    expect(
      state({ landed: onMoon, live: { spec: lunar, classification: 'total' } }).title,
    ).toBe('Earth is covering the Sun');
    expect(
      state({ landed: onJupiter, live: { spec: ioTransit, classification: 'total' } }).title,
    ).toBe('Io is crossing the Sun');
    expect(
      state({ landed: onEuropa, live: { spec: ioTransit, classification: 'total' } }).title,
    ).toBe("Io's shadow on Jupiter");
  });

  it('the sub names the destination only when the step relocates', () => {
    expect(
      state({ landed: onMoon, relocates: true, live: { spec: solar, classification: 'total' } }).sub,
    ).toBe('stand on Earth to see the eclipse');
    expect(
      state({ landed: onMoon, relocates: true, live: { spec: lunar, classification: 'total' } }).sub,
    ).toBe('stand on Earth to see it turn red');
    expect(
      state({ landed: onMoon, relocates: true, live: { spec: lunar, classification: 'partial' } })
        .sub,
    ).toBe('stand on Earth to watch the eclipse');
    expect(
      state({ landed: onJupiter, live: { spec: ioTransit, classification: 'total' } }).sub,
    ).toBe('see it from the surface');
  });

  it('a lunar eclipse from Earth promises only what its classification delivers', () => {
    expect(state({ live: { spec: lunar, classification: 'total' } }).sub).toBe(
      'see the Moon turn red',
    );
    expect(state({ live: { spec: lunar, classification: 'partial' } }).sub).toBe(
      'the Moon is crossing Earth’s shadow',
    );
    expect(state({ live: { spec: lunar, classification: 'penumbral' } }).sub).toBe(
      'a subtle dimming — easy to miss',
    );
  });

  it('the pictogram follows the sight, never the event kind', () => {
    // Watching the Sun get covered — from the shadow spot, or as the moon.
    expect(state({ live: { spec: solar, classification: 'total' } }).glyph).toBe('sun');
    expect(
      state({ landed: onMoon, live: { spec: lunar, classification: 'total' } }).glyph,
    ).toBe('sun');
    // Watching a body sit inside a shadow.
    expect(state({ live: { spec: lunar, classification: 'total' } }).glyph).toBe('reddened');
    // Watching a shadow crawl a disc.
    expect(
      state({ landed: onMoon, live: { spec: solar, classification: 'total' } }).glyph,
    ).toBe('shadow-dot');
    expect(
      state({ landed: onEuropa, live: { spec: ioTransit, classification: 'total' } }).glyph,
    ).toBe('shadow-dot');
  });

  it('only a live window pulses, and it carries the relocation flag through', () => {
    expect(state({ live: { spec: solar, classification: 'total' } }).showNow).toBe(true);
    expect(
      state({ landed: onMoon, relocates: true, live: { spec: solar, classification: 'total' } })
        .relocates,
    ).toBe(true);
  });
});

// The offer's home on the ground: in orbit the window carries it, and two
// ember rows would dilute what ember means.
describe('observatoryWatchRowState', () => {
  const onMoon: SurfaceLandedInfo = { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
  const solar: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' };

  const row = (over: Partial<ObservatoryWindowInput>) =>
    observatoryWatchRowState({
      surfaceActive: true,
      lookupOpensMenu: false,
      landed: onMoon,
      live: { spec: solar, classification: 'total' },
      relocates: true,
      hasPhase: true,
      ...over,
    });

  it('shows only on the surface, only while live, only when the step relocates', () => {
    expect(row({}).visible).toBe(true);
    expect(row({ surfaceActive: false }).visible).toBe(false);
    expect(row({ live: null }).visible).toBe(false);
    expect(row({ relocates: false }).visible).toBe(false);
  });

  it('names the destination and the classification', () => {
    expect(row({}).title).toBe('Watch from Earth');
    expect(row({}).meta).toBe('total eclipse');
    expect(row({ live: { spec: solar, classification: 'partial' } }).meta).toBe('partial eclipse');
  });
});

describe('liveEventVerb', () => {
  it('from Earth both shadow directions are eclipses', () => {
    expect(liveEventVerb({ kind: 'eclipse', parentPlanet: 'Earth', moonName: 'Moon' })).toBe('eclipse');
    expect(liveEventVerb({ kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' })).toBe('eclipse');
  });

  it('elsewhere a shadow crossing the planet is the transit the panel names it', () => {
    expect(liveEventVerb({ kind: 'shadow-transit', parentPlanet: 'Jupiter', moonName: 'Io' })).toBe('transit');
    expect(liveEventVerb({ kind: 'eclipse', parentPlanet: 'Jupiter', moonName: 'Io' })).toBe('eclipse');
  });
});

// The phase glyph paints the LIT region: r=19 disc at (20,20), the sunward
// semicircle closed by the terminator ellipse. Both arcs run top → bottom →
// top, so the sweep flags are what say which side each one bulges toward.
describe('phaseGlyphLitPath', () => {
  it('full moon lights the whole disc — the two arcs bulge opposite ways', () => {
    expect(phaseGlyphLitPath(1, true)).toBe('M 20 1 A 19 19 0 0 1 20 39 A 19.00 19 0 0 1 20 1 Z');
    expect(phaseGlyphLitPath(1, false)).toBe('M 20 1 A 19 19 0 0 0 20 39 A 19.00 19 0 0 0 20 1 Z');
  });

  it('new moon lights nothing — both arcs bulge the same way', () => {
    expect(phaseGlyphLitPath(0, true)).toBe('M 20 1 A 19 19 0 0 1 20 39 A 19.00 19 0 0 0 20 1 Z');
    expect(phaseGlyphLitPath(0, false)).toBe('M 20 1 A 19 19 0 0 0 20 39 A 19.00 19 0 0 1 20 1 Z');
  });

  it('a quarter is the straight-terminator case (zero semi-minor axis)', () => {
    expect(phaseGlyphLitPath(0.5, true)).toBe('M 20 1 A 19 19 0 0 1 20 39 A 0.00 19 0 0 1 20 1 Z');
  });

  it('the lit limb follows the light, and the terminator bows into it on a crescent', () => {
    // Waning 5%: lit limb on the left, terminator bowed left of centre so the
    // crescent is thin.
    expect(phaseGlyphLitPath(0.05, false)).toBe(
      'M 20 1 A 19 19 0 0 0 20 39 A 17.10 19 0 0 1 20 1 Z',
    );
    // Waxing gibbous 90%: lit limb on the right, terminator bowed the other way.
    expect(phaseGlyphLitPath(0.9, true)).toBe(
      'M 20 1 A 19 19 0 0 1 20 39 A 15.20 19 0 0 1 20 1 Z',
    );
  });

  it('clamps a lit fraction outside 0..1 instead of inverting the terminator', () => {
    expect(phaseGlyphLitPath(1.4, true)).toBe(phaseGlyphLitPath(1, true));
    expect(phaseGlyphLitPath(-0.2, true)).toBe(phaseGlyphLitPath(0, true));
  });
});

// Countdowns read in words at meta size; one unit per rung, and the rung
// boundaries are what keep the right column from growing.
describe('formatCountdown', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const at = (peakOffsetMs: number, spanMs = HOUR) =>
    ({
      startUtcMs: peakOffsetMs - spanMs,
      peakUtcMs: peakOffsetMs,
      endUtcMs: peakOffsetMs + spanMs,
    }) as ShadowEvent;

  it('inside the contacts it is happening; past them it has ended', () => {
    expect(formatCountdown(0, at(0))).toBe('now');
    expect(formatCountdown(0, at(HOUR))).toBe('now'); // first contact is now
    expect(formatCountdown(HOUR + 1, at(0))).toBe('ended');
  });

  it('under an hour counts minutes, and never counts down to zero', () => {
    expect(formatCountdown(0, at(59 * MIN, MIN))).toBe('in 59 min');
    expect(formatCountdown(0, at(2 * MIN, MIN))).toBe('in 2 min');
    // Sub-minute: the row still says something rather than "in 0 min".
    expect(formatCountdown(0, at(90_000, MIN))).toBe('in 1 min');
  });

  it('an hour and up counts whole hours, singular at one', () => {
    expect(formatCountdown(0, at(60 * MIN, MIN))).toBe('in 1 hour');
    expect(formatCountdown(0, at(119 * MIN, MIN))).toBe('in 1 hour');
    expect(formatCountdown(0, at(2 * HOUR, MIN))).toBe('in 2 hours');
    expect(formatCountdown(0, at(47 * HOUR, MIN))).toBe('in 47 hours');
  });

  it('two days and up counts whole days', () => {
    expect(formatCountdown(0, at(48 * HOUR, MIN))).toBe('in 2 days');
    expect(formatCountdown(0, at(364 * DAY, MIN))).toBe('in 364 days');
  });

  it('a year out reads in years, one decimal', () => {
    expect(formatCountdown(0, at(365 * DAY, MIN))).toBe('in 1.0 years');
    expect(formatCountdown(0, at(500 * DAY, MIN))).toBe('in 1.4 years');
  });
});
