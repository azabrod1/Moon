import { afterEach, describe, expect, it } from 'vitest';
import {
  NIGHT_EXPOSURE,
  NIGHT_EXPOSURE_FALLOFF,
  NIGHT_EXPOSURE_FULL_LIT,
  NIGHT_EXPOSURE_MIN_SIN_CAP,
  NIGHT_EXPOSURE_NONE_LIT,
  NIGHT_EXPOSURE_SMOOTHING,
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
    // turns into about half the long exposure.
    const crescent = visibleCapLitFraction(cosDeg(130), 1 / 5);
    expect(nightExposureRamp(crescent)).toBeCloseTo(0.201, 3);
    expect(nightExposureFactor(nightExposureRamp(crescent))).toBeCloseTo(0.510, 3);
    // The night side from 1.12 R at 150 degrees: the cap reaches 26.8 degrees
    // and none of it is lit.
    expect(visibleCapLitFraction(cosDeg(150), 1 / 1.12)).toBe(0);
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

  it('shapes the ramp so the fade spends its stops evenly', () => {
    expect(nightExposureFactor(0)).toBe(1);
    expect(nightExposureFactor(1)).toBe(0);
    // Three stops down at the midpoint, where a straight line is one.
    expect(NIGHT_EXPOSURE_FALLOFF).toBe(3);
    expect(nightExposureFactor(0.5)).toBeCloseTo(0.125, 12);
    // Out-of-range positions are the ends, never a negative or a gain.
    expect(nightExposureFactor(-0.2)).toBe(1);
    expect(nightExposureFactor(1.2)).toBe(0);
  });

  it('leaves the night side alone where the rule was calibrated', () => {
    // The night side from 1.12 R with no daylight on the cap: the factor is 1,
    // which is the picture as it was.
    const lit = visibleCapLitFraction(cosDeg(150), 1 / 1.12);
    expect(nightExposureFactor(nightExposureRamp(lit))).toBe(1);
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

  it('moves at most the limiter’s pace in a frame', () => {
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 1000);
    expect(state.ramp).toBe(0);
    advanceNightExposure(state, 1, 1016);
    expect(state.ramp).toBeCloseTo((NIGHT_EXPOSURE_SMOOTHING.maxRatePerSec * 16) / 1000, 12);
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
    expect(frames).toBe(Math.ceil(1000 / (NIGHT_EXPOSURE_SMOOTHING.maxRatePerSec * 16)));
  });

  it('snaps across a gap, and when told the scene jumped', () => {
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 1000);
    advanceNightExposure(state, 1, 1000 + NIGHT_EXPOSURE_SMOOTHING.snapGapMs + 100);
    expect(state.ramp).toBe(1);
    // A jump inside the gap: the flag, not the clock, decides.
    advanceNightExposure(state, 0, 1616, true);
    expect(state.ramp).toBe(0);
    expect(state.applied).toBe(1);
  });

  it('reads a pace from the parameters it is handed', () => {
    const state = makeNightExposureState();
    advanceNightExposure(state, 0, 0);
    advanceNightExposure(state, 1, 100, false, { ...NIGHT_EXPOSURE, maxRatePerSec: 4 });
    expect(state.ramp).toBeCloseTo(0.4, 12);
  });
});

describe('the knobs', () => {
  afterEach(() => { setDevNightExposure(null); });

  it('reads `0` as the rule off in any build', () => {
    expect(parseNightExposureParam('?nightexposure=0', false)).toEqual({ off: true });
    expect(parseNightExposureParam('?nightexposure=0', true)).toEqual({ off: true });
    expect(parseNightExposureParam('?auto=planetarium&nightexposure=0', false).off).toBe(true);
  });

  it('reads a curve only in a development build', () => {
    expect(parseNightExposureParam('?nightexposure=0.1,0.35', true))
      .toEqual({ off: false, full: 0.1, none: 0.35 });
    expect(parseNightExposureParam('?nightexposure=0.1,0.35,4', true))
      .toEqual({ off: false, full: 0.1, none: 0.35, rate: 4 });
    expect(parseNightExposureParam('?nightexposure=0.1,0.35', false)).toEqual({ off: false });
  });

  it('asks for nothing on a malformed or missing value', () => {
    for (const search of ['?nightexposure=x', '?nightexposure=', '', '?nightexposure=0.1',
      '?nightexposure=0.1,', '?nightexposure=0.1,0.35,0', '?nightexposure=0.1,0.35,4,5',
      '?nightexposure=a,b', '?nightexposure=1']) {
      expect(parseNightExposureParam(search, true), search).toEqual({ off: false });
    }
  });

  it('moves the curve live and puts it back', () => {
    expect(nightExposureParams()).toBe(NIGHT_EXPOSURE);
    const set = setDevNightExposure({ full: 0.05, none: 0.2, rate: 4 });
    expect(set.fullLit).toBe(0.05);
    expect(set.noneLit).toBe(0.2);
    expect(set.maxRatePerSec).toBe(4);
    expect(set.snapGapMs).toBe(NIGHT_EXPOSURE.snapGapMs);
    expect(nightExposureParams()).toBe(set);
    // One knob back to its authored value, the others kept.
    const partial = setDevNightExposure({ none: null });
    expect(partial.fullLit).toBe(0.05);
    expect(partial.noneLit).toBe(NIGHT_EXPOSURE.noneLit);
    expect(partial.maxRatePerSec).toBe(4);
    // Nonsense is ignored; ends are held to 0..1.
    const held = setDevNightExposure({ full: 7, rate: -1 });
    expect(held.fullLit).toBe(1);
    expect(held.maxRatePerSec).toBe(4);
    // All of it back, and a curve set back to the authored numbers is no
    // override at all.
    expect(setDevNightExposure(null)).toBe(NIGHT_EXPOSURE);
    setDevNightExposure({ full: 0.2 });
    expect(setDevNightExposure({ full: null })).toBe(NIGHT_EXPOSURE);
    expect(nightExposureParams()).toBe(NIGHT_EXPOSURE);
  });
});
