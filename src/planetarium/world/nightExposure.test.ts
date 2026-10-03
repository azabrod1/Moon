import { afterEach, describe, expect, it } from 'vitest';
import {
  NIGHT_EXPOSURE,
  NIGHT_EXPOSURE_CEILING,
  NIGHT_EXPOSURE_FALLOFF,
  NIGHT_EXPOSURE_FULL_LIT,
  NIGHT_EXPOSURE_MIN_SIN_CAP,
  NIGHT_EXPOSURE_NONE_LIT,
  NIGHT_EXPOSURE_RATE_TO_DAY,
  NIGHT_EXPOSURE_RATE_TO_NIGHT,
  NIGHT_EXPOSURE_SNAP_GAP_MS,
  advanceNightExposure,
  makeNightExposureState,
  nightExposureFactor,
  nightExposureParams,
  nightExposureRamp,
  parseNightExposureParam,
  setDevNightExposure,
  visibleCapLitFraction,
} from './nightExposure';

const DEG = Math.PI / 180;
const cosDeg = (deg: number): number => Math.cos(deg * DEG);

describe('the visible cap’s lit fraction', () => {
  it('is the lit fraction of the disc from far away', () => {
    // The cap is the hemisphere, and the lit share of a disc at phase angle
    // alpha is (1 + cos alpha) / 2.
    for (const phase of [0, 60, 90, 120, 180]) {
      expect(visibleCapLitFraction(cosDeg(phase), 0), `${phase}`)
        .toBeCloseTo((1 + cosDeg(phase)) / 2, 12);
    }
    expect(visibleCapLitFraction(1, 0)).toBe(1);
    expect(visibleCapLitFraction(-1, 0)).toBe(0);
  });

  it('ends at 90 degrees either side of the cap’s own radius close in', () => {
    // At 1.05 R the cap reaches arccos(1/1.05) = 17.75 degrees from the point
    // under the camera: all of it lit up to a phase of 72.25, none past 107.75.
    const k = 1 / 1.05;
    const cap = Math.acos(k) / DEG;
    expect(cap).toBeCloseTo(17.75, 2);
    expect(visibleCapLitFraction(cosDeg(90 - cap - 0.01), k)).toBe(1);
    expect(visibleCapLitFraction(cosDeg(90 + cap + 0.01), k)).toBe(0);
    expect(visibleCapLitFraction(cosDeg(90), k)).toBeCloseTo(0.5, 12);
    // Monotone in the phase, all the way across.
    let prev = Infinity;
    for (let phase = 0; phase <= 180; phase += 0.5) {
      const lit = visibleCapLitFraction(cosDeg(phase), k);
      expect(lit).toBeLessThanOrEqual(prev);
      prev = lit;
    }
  });

  it('keeps a ramp at the ground instead of a step', () => {
    // Standing on the surface the cap is a point; the floor on its sine holds
    // the crossing to the night sources' own twilight width.
    const at = (deg: number): number => visibleCapLitFraction(cosDeg(deg), 1);
    const edge = Math.asin(NIGHT_EXPOSURE_MIN_SIN_CAP) / DEG;
    expect(edge).toBeCloseTo(2.87, 2);
    expect(at(90 - edge - 0.01)).toBe(1);
    expect(at(90 + edge + 0.01)).toBe(0);
    expect(at(90)).toBeCloseTo(0.5, 12);
    expect(at(89)).toBeGreaterThan(0.5);
    expect(at(89)).toBeLessThan(1);
    // Inside the body is not a reading, but it must not be a NaN either.
    expect(visibleCapLitFraction(0.2, 1.3)).toBe(1);
  });

  it('reads the worked poses the rule was set against', () => {
    // A crescent from 5 R at 130 degrees of phase: under a fifth of the cap lit.
    expect(visibleCapLitFraction(cosDeg(130), 1 / 5)).toBeCloseTo(0.172, 3);
    // The terminator face-on from 1.08 R at 88 degrees: half lit and a bit,
    // which is past the ramp's far end — the day exposure, exactly.
    const terminator = visibleCapLitFraction(cosDeg(88), 1 / 1.08);
    expect(terminator).toBeCloseTo(0.546, 3);
    expect(nightExposureFactor(nightExposureRamp(terminator))).toBe(0);
    // ...and the crescent sits a fifth of the way up the ramp, which the cube
    // turns into about half the long exposure: half of the ceiling.
    const crescent = visibleCapLitFraction(cosDeg(130), 1 / 5);
    expect(nightExposureRamp(crescent)).toBeCloseTo(0.201, 3);
    expect(nightExposureFactor(nightExposureRamp(crescent)) / NIGHT_EXPOSURE_CEILING).toBeCloseTo(0.510, 3);
    expect(nightExposureFactor(nightExposureRamp(crescent))).toBeCloseTo(0.1275, 3); // 0.25 × 0.510
    // The night side from 1.12 R at 150 degrees: the cap reaches 26.8 degrees
    // and none of it is lit, so the long exposure stands — at the ceiling.
    const night = visibleCapLitFraction(cosDeg(150), 1 / 1.12);
    expect(night).toBe(0);
    expect(nightExposureFactor(nightExposureRamp(night))).toBe(NIGHT_EXPOSURE_CEILING);
  });
});

describe('the exposure the camera picks', () => {
  it('holds the long exposure below the first end and the day one past the second', () => {
    expect(nightExposureRamp(0)).toBe(0);
    expect(nightExposureRamp(NIGHT_EXPOSURE_FULL_LIT)).toBe(0);
    expect(nightExposureRamp(NIGHT_EXPOSURE_NONE_LIT)).toBe(1);
    expect(nightExposureRamp(1)).toBe(1);
    expect(NIGHT_EXPOSURE_FULL_LIT).toBeLessThan(NIGHT_EXPOSURE_NONE_LIT);
  });

  it('is a smoothstep between the two, flat at both ends', () => {
    const mid = (NIGHT_EXPOSURE_FULL_LIT + NIGHT_EXPOSURE_NONE_LIT) / 2;
    expect(nightExposureRamp(mid)).toBeCloseTo(0.5, 12);
    // C1 at the ends: the slope one hair inside each end is next to nothing.
    const h = 1e-6;
    expect(nightExposureRamp(NIGHT_EXPOSURE_FULL_LIT + h) / h).toBeLessThan(1e-4);
    expect((1 - nightExposureRamp(NIGHT_EXPOSURE_NONE_LIT - h)) / h).toBeLessThan(1e-4);
    let prev = -Infinity;
    for (let lit = 0; lit <= 1; lit += 0.01) {
      const t = nightExposureRamp(lit);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('is a step when the ends meet or cross', () => {
    const params = { ...NIGHT_EXPOSURE, fullLit: 0.3, noneLit: 0.3 };
    expect(nightExposureRamp(0.3, params)).toBe(0);
    expect(nightExposureRamp(0.31, params)).toBe(1);
  });

  it('holds the long exposure two stops under the authored level', () => {
    expect(NIGHT_EXPOSURE_CEILING).toBe(0.25);
    expect(Math.log2(NIGHT_EXPOSURE_CEILING)).toBe(-2);
    expect(NIGHT_EXPOSURE.ceiling).toBe(NIGHT_EXPOSURE_CEILING);
    // Exactly the ceiling at the long exposure and exactly nothing at the day.
    expect(nightExposureFactor(0)).toBe(NIGHT_EXPOSURE_CEILING);
    expect(nightExposureFactor(1)).toBe(0);
    // A ceiling handed in is the one used.
    expect(nightExposureFactor(0, { ...NIGHT_EXPOSURE, ceiling: 0.5 })).toBe(0.5);
    expect(nightExposureFactor(1, { ...NIGHT_EXPOSURE, ceiling: 0.5 })).toBe(0);
  });

  it('shapes the ramp so the fade spends its stops evenly', () => {
    // Three stops under the ceiling at the midpoint, where a straight line is one.
    expect(NIGHT_EXPOSURE_FALLOFF).toBe(3);
    expect(nightExposureFactor(0.5) / NIGHT_EXPOSURE_CEILING).toBeCloseTo(0.125, 12);
    // Out-of-range positions are the ends, never a negative or a gain.
    expect(nightExposureFactor(-0.2)).toBe(NIGHT_EXPOSURE_CEILING);
    expect(nightExposureFactor(1.2)).toBe(0);
  });

  it('holds the night side at the ceiling where the rule was calibrated', () => {
    // The night side from 1.12 R with no daylight on the cap: the long
    // exposure, at its ceiling.
    const lit = visibleCapLitFraction(cosDeg(150), 1 / 1.12);
    expect(nightExposureFactor(nightExposureRamp(lit))).toBe(NIGHT_EXPOSURE_CEILING);
    // A disc two fifths sunlit takes the day exposure outright.
    expect(visibleCapLitFraction(cosDeg(100), 0)).toBeCloseTo(0.41, 2);
    expect(nightExposureFactor(nightExposureRamp(visibleCapLitFraction(cosDeg(100), 0)))).toBe(0);
  });
});

describe('the eased meter', () => {
  it('takes its first reading outright', () => {
    const state = makeNightExposureState();
    expect(state.applied).toBe(1);
    const applied = advanceNightExposure(state, 0.6, 1000);
    expect(state.ramp).toBe(1);
    expect(applied).toBe(0);
    expect(state.target).toBe(1);
    expect(state.lit).toBe(0.6);
    expect(state.stampMs).toBe(1000);
  });

  it('goes toward the day at rateToDay, a full swing in about a second', () => {
    expect(NIGHT_EXPOSURE_RATE_TO_DAY).toBe(1);
    expect(NIGHT_EXPOSURE.rateToDay).toBe(NIGHT_EXPOSURE_RATE_TO_DAY);
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 1000);
    expect(state.ramp).toBe(0);
    expect(state.applied).toBe(NIGHT_EXPOSURE_CEILING);
    advanceNightExposure(state, 1, 1016);
    expect(state.ramp).toBeCloseTo((NIGHT_EXPOSURE_RATE_TO_DAY * 16) / 1000, 12);
    expect(state.target).toBe(1);
    // The factor is the eased position shaped, not the target's.
    expect(state.applied).toBeCloseTo(nightExposureFactor(state.ramp), 12);
    // A full swing takes 1/rate seconds of frames.
    let frames = 1;
    let now = 1016;
    while (state.ramp < 1 && frames < 200) {
      now += 16;
      advanceNightExposure(state, 1, now);
      frames++;
    }
    expect(state.ramp).toBe(1);
    expect(state.applied).toBe(0);
    expect(frames).toBe(Math.ceil(1000 / (NIGHT_EXPOSURE_RATE_TO_DAY * 16)));
  });

  it('comes back toward the night at rateToNight, a full swing in about ten seconds', () => {
    expect(NIGHT_EXPOSURE_RATE_TO_NIGHT).toBe(0.1);
    expect(NIGHT_EXPOSURE.rateToNight).toBe(NIGHT_EXPOSURE_RATE_TO_NIGHT);
    const state = makeNightExposureState();
    advanceNightExposure(state, 1, 1000);
    expect(state.ramp).toBe(1);
    advanceNightExposure(state, 0, 1016);
    expect(state.ramp).toBeCloseTo(1 - (NIGHT_EXPOSURE_RATE_TO_NIGHT * 16) / 1000, 12);
    let now = 1016;
    while (state.ramp > 0 && now < 30_000) {
      now += 16;
      advanceNightExposure(state, 0, now);
    }
    expect(state.ramp).toBe(0);
    expect(state.applied).toBe(NIGHT_EXPOSURE_CEILING);
    // Ten seconds from the first step, to within a frame.
    expect(Math.abs((now - 1000) - 1000 / NIGHT_EXPOSURE_RATE_TO_NIGHT)).toBeLessThanOrEqual(16);
  });

  it('never moves further in a frame than the speed for its direction allows', () => {
    // A lit fraction that wanders across the whole ramp at uneven frame times,
    // every one inside the snap gap: each step is held to its own direction's
    // rate times that frame's dt.
    const state = makeNightExposureState();
    let now = 0;
    advanceNightExposure(state, 0.5, now);
    let seed = 7;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let ups = 0;
    let downs = 0;
    for (let i = 0; i < 2000; i++) {
      const dt = 4 + next() * 60;
      const prev = state.ramp;
      now += dt;
      advanceNightExposure(state, next() * 0.5, now);
      const moved = state.ramp - prev;
      if (moved > 0) ups++;
      if (moved < 0) downs++;
      expect(moved).toBeLessThanOrEqual((NIGHT_EXPOSURE_RATE_TO_DAY * dt) / 1000 + 1e-12);
      expect(moved).toBeGreaterThanOrEqual(-(NIGHT_EXPOSURE_RATE_TO_NIGHT * dt) / 1000 - 1e-12);
      // Never past the target it moves toward.
      if (moved > 0) expect(state.ramp).toBeLessThanOrEqual(state.target);
      if (moved < 0) expect(state.ramp).toBeGreaterThanOrEqual(state.target);
    }
    expect(ups).toBeGreaterThan(100);
    expect(downs).toBeGreaterThan(100);
  });

  it('snaps across a gap, on a clock that did not move forward, and when told the scene jumped', () => {
    expect(NIGHT_EXPOSURE.snapGapMs).toBe(NIGHT_EXPOSURE_SNAP_GAP_MS);
    expect(NIGHT_EXPOSURE_SNAP_GAP_MS).toBe(500);
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 1000);
    advanceNightExposure(state, 1, 1000 + NIGHT_EXPOSURE_SNAP_GAP_MS + 100);
    expect(state.ramp).toBe(1);
    // A jump inside the gap: the flag, not the clock, decides — and the slow
    // way back to the night is skipped outright.
    advanceNightExposure(state, 0, 1616, true);
    expect(state.ramp).toBe(0);
    expect(state.applied).toBe(NIGHT_EXPOSURE_CEILING);
    // The same stamp again, and one behind it: no dt to limit by, so the target.
    advanceNightExposure(state, 1, 1616);
    expect(state.ramp).toBe(1);
    advanceNightExposure(state, 0, 1600);
    expect(state.ramp).toBe(0);
  });

  it('reads its speeds and its ceiling from the parameters it is handed', () => {
    const params = { ...NIGHT_EXPOSURE, rateToDay: 4, rateToNight: 2, ceiling: 0.5 };
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 0, false, params);
    expect(state.applied).toBe(0.5);
    advanceNightExposure(state, 1, 100, false, params);
    expect(state.ramp).toBeCloseTo(0.4, 12);
    advanceNightExposure(state, 0, 200, false, params);
    expect(state.ramp).toBeCloseTo(0.2, 12);
    expect(state.applied).toBeCloseTo(0.5 * 0.8 ** 3, 12);
  });
});

describe('the knobs', () => {
  afterEach(() => { setDevNightExposure(null); });

  it('reads `0` as the rule off in any build', () => {
    expect(parseNightExposureParam('?nightexposure=0', false)).toEqual({ off: true });
    expect(parseNightExposureParam('?nightexposure=0', true)).toEqual({ off: true });
    expect(parseNightExposureParam('?auto=planetarium&nightexposure=0', false).off).toBe(true);
  });

  it('reads a curve of two to five numbers only in a development build', () => {
    expect(parseNightExposureParam('?nightexposure=0.1,0.35', true))
      .toStrictEqual({ off: false, full: 0.1, none: 0.35 });
    expect(parseNightExposureParam('?nightexposure=0.1,0.35,4', true))
      .toStrictEqual({ off: false, full: 0.1, none: 0.35, rateToDay: 4 });
    expect(parseNightExposureParam('?nightexposure=0.1,0.35,4,0.2', true))
      .toStrictEqual({ off: false, full: 0.1, none: 0.35, rateToDay: 4, rateToNight: 0.2 });
    expect(parseNightExposureParam('?nightexposure=0.1,0.35,4,0.2,0.5', true))
      .toStrictEqual({ off: false, full: 0.1, none: 0.35, rateToDay: 4, rateToNight: 0.2, ceiling: 0.5 });
    // A ceiling of nothing is a night side with no light of its own: a knob,
    // not junk.
    expect(parseNightExposureParam('?nightexposure=0.1,0.35,1,0.1,0', true).ceiling).toBe(0);
    for (const search of ['?nightexposure=0.1,0.35', '?nightexposure=0.1,0.35,4',
      '?nightexposure=0.1,0.35,4,0.2', '?nightexposure=0.1,0.35,4,0.2,0.5']) {
      expect(parseNightExposureParam(search, false), search).toStrictEqual({ off: false });
    }
  });

  it('asks for nothing on a malformed or missing value', () => {
    for (const search of ['?nightexposure=x', '?nightexposure=', '', '?nightexposure=0.1',
      '?nightexposure=0.1,', '?nightexposure=0.1,0.35,0', '?nightexposure=0.1,0.35,-1',
      '?nightexposure=0.1,0.35,4,0', '?nightexposure=0.1,0.35,4,-0.1',
      '?nightexposure=0.1,0.35,4,0.1,x', '?nightexposure=0.1,0.35,4,0.1,0.25,9',
      '?nightexposure=0.1,0.35,,0.1', '?nightexposure=0.1,0.35,4,0.1,',
      '?nightexposure=a,b', '?nightexposure=1', '?nightexposure=0.1,Infinity']) {
      expect(parseNightExposureParam(search, true), search).toStrictEqual({ off: false });
    }
  });

  it('moves the curve live and puts it back', () => {
    expect(nightExposureParams()).toBe(NIGHT_EXPOSURE);
    const set = setDevNightExposure({ full: 0.05, none: 0.2, rateToDay: 4, rateToNight: 0.5, ceiling: 0.5 });
    expect(set.fullLit).toBe(0.05);
    expect(set.noneLit).toBe(0.2);
    expect(set.rateToDay).toBe(4);
    expect(set.rateToNight).toBe(0.5);
    expect(set.ceiling).toBe(0.5);
    expect(set.snapGapMs).toBe(NIGHT_EXPOSURE.snapGapMs);
    expect(nightExposureParams()).toBe(set);
    // One knob back to its authored value, the others kept.
    const partial = setDevNightExposure({ none: null, rateToNight: null });
    expect(partial.fullLit).toBe(0.05);
    expect(partial.noneLit).toBe(NIGHT_EXPOSURE.noneLit);
    expect(partial.rateToDay).toBe(4);
    expect(partial.rateToNight).toBe(NIGHT_EXPOSURE.rateToNight);
    expect(partial.ceiling).toBe(0.5);
    // Nonsense is ignored; ends and the ceiling are held to 0..1.
    const held = setDevNightExposure({ full: 7, rateToDay: -1, rateToNight: 0, ceiling: 3 });
    expect(held.fullLit).toBe(1);
    expect(held.rateToDay).toBe(4);
    expect(held.rateToNight).toBe(NIGHT_EXPOSURE.rateToNight);
    expect(held.ceiling).toBe(1);
    expect(setDevNightExposure({ ceiling: -2 }).ceiling).toBe(0);
    expect(setDevNightExposure({ ceiling: Number.NaN }).ceiling).toBe(0);
    // All of it back, and a curve set back to the authored numbers is no
    // override at all.
    expect(setDevNightExposure(null)).toBe(NIGHT_EXPOSURE);
    setDevNightExposure({ full: 0.2, ceiling: 1 });
    expect(setDevNightExposure({ full: null, ceiling: null })).toBe(NIGHT_EXPOSURE);
    expect(nightExposureParams()).toBe(NIGHT_EXPOSURE);
  });
});
