/**
 * The night side's long exposure, granted only while there is (almost) no
 * daylight in view, and never at the full level it was authored at.
 *
 * One frame carries two exposures. The sunlit side of a body is drawn
 * physically, at the renderer's one exposure; the night side is drawn as a long
 * exposure — its non-solar light (world/nightSources) is authored at a stated
 * gain over physical, so a full Moon lights the ground at four tenths of
 * sunlight and moonlit cloud tops read the way an ISS night frame shows them.
 * That gain was calibrated with no daylight anywhere in the frame, and on its
 * own terms it is right. Put the sunlit disc in the same frame and no camera
 * takes the picture: exposed for the day side, the moonlit side is black;
 * exposed for the moonlit side, the day side is white. Earth from far out with
 * the Moon past full shows a sunlit third, a thin strip of true night, and two
 * moonlit thirds at nearly half the Sun's brightness.
 *
 * So the long exposure is conditional, the way a camera's metering is. With
 * daylight in view the camera exposes for it and the night side's own light
 * sinks toward black; parked over the night side, it comes back. What this file
 * produces is one number per body per frame that the night terms are
 * multiplied by: NIGHT_EXPOSURE_CEILING with no daylight in view, which is the
 * long exposure, and 0 the day exposure (the night side's non-solar light
 * gone). 1 is the level the gain was authored at, which a slot holds only with
 * the rule off. Nothing solar reads it.
 *
 * The ceiling is a decision made on pictures, not a measurement: a night side
 * is never as bright as the authored long exposure drew it. It holds two stops
 * under that, a quarter, and the gain itself stays authored, so
 * `?nightexposure=0` keeps the old level by construction — every slot at 1 —
 * and so does Night sides: Brightened, which stands this rule down so the
 * reader's lift joins the level it was made beside.
 *
 * The meter reads the VISIBLE CAP, not the screen: the part of the sphere the
 * camera can see, from wherever it stands, and how much of that is sunlit.
 * From far away the cap is the hemisphere and the answer is the lit fraction
 * of the disc, (1 + cos phase) / 2, exactly. Close in the cap shrinks, and the
 * answer is a linear stand-in for the cap's overlap with the lit hemisphere
 * that is exact at both ends — all of the cap lit, none of it. It does not
 * look where the camera points: low over the terminator, looking only at the
 * night half, the day half still counts. So does sunlit ground past the
 * horizon: the surface view stands 374 km over Earth, where the cap reaches
 * 19° of arc in every direction, so there the long exposure starts to go with
 * the Sun still 15° below the horizon under the camera and is gone by 6°. A
 * screen-aware meter, counting only the lit ground actually on screen, is the
 * better camera and a larger change, and the next one; the cap is the honest
 * first one.
 *
 * The curve from lit fraction to exposure is a ramp between two lit fractions,
 * NIGHT_EXPOSURE_FULL_LIT and NIGHT_EXPOSURE_NONE_LIT, eased in wall time and
 * then shaped. The eased quantity is the ramp's position (0 = long exposure,
 * 1 = day exposure), and it moves at two speeds, the way eyes do. Toward the
 * day it is quick, a full swing in about a second: daylight coming into view
 * is itself the change the eye follows, the night side's light has gone with
 * it before it can read as a second one, and a moonlit night side never
 * lingers beside the sunlit disc. Toward the night it is slow, a full swing in
 * about ten seconds, the way eyes adapt to the dark: too slow to be seen
 * moving, so the night side is simply brighter once the eye has settled rather
 * than seen brightening. A scene discontinuity snaps either way, so a jump
 * never ramps from the sky it left. The factor written is the ceiling times
 * that position through a cube, ceiling × (1 − t)³: exactly the ceiling and
 * exactly 0 at the ends, and between them a fade that spends its stops evenly
 * — at the ramp's midpoint it is three stops under the ceiling, where a
 * straight line would still be one stop under and fall off a cliff at the end.
 *
 * The two ends are a starting guess, not a measurement. The physical curve —
 * exposure in proportion to 1/lit — reaches the day exposure with a few percent
 * of the cap lit, which puts a black night side behind every crescent; whether
 * a crescent keeps its earthshine is a decision made on pictures, so the ends,
 * the two speeds and the ceiling are knobs (`__moon.nightExposure`, and
 * `?nightexposure=<full>,<none>[,<rateToDay>[,<rateToNight>[,<ceiling>]]]` in a
 * development build) and `?nightexposure=0` switches the rule off in any
 * build, which is the picture before the rule, authored level and all.
 */

/** Up to this fraction of the visible cap sunlit, the long exposure stands in
 *  full. */
export const NIGHT_EXPOSURE_FULL_LIT = 0.10;
/** From this fraction of the visible cap sunlit, the camera exposes for the
 *  day and the night side's non-solar light is gone. */
export const NIGHT_EXPOSURE_NONE_LIT = 0.35;
/** The power the eased ramp is shaped by: the factor is ceiling × (1 − t)^this. */
export const NIGHT_EXPOSURE_FALLOFF = 3;
/** The sine of the visible cap's angular radius is never taken below this.
 *  As a camera comes down onto the ground the cap collapses to a point and the
 *  lit fraction would be a step at the terminator; held here the ramp is ±2.9
 *  degrees of the Sun's elevation wide — the width of the twilight ramps the
 *  night sources themselves fade on — so a sunrise at time warp is a ramp, not
 *  a cut. It binds only within an eight-hundredth of a radius of the ground
 *  (about 8 km over Earth), so only where a camera really reaches the surface:
 *  the surface view stands 2 % of the body's radius up and never under 374 km,
 *  where the cap is at least 11° of arc and on Earth 19°, and its sunrise is
 *  that much wider a ramp on its own. */
export const NIGHT_EXPOSURE_MIN_SIN_CAP = 0.05;
/** Toward the day exposure, in ramp positions a second: a full swing in about a
 *  second, the pace eyes stop down at for light, so the night side's light
 *  leaves as daylight comes into view and never lingers beside the sunlit
 *  disc. */
export const NIGHT_EXPOSURE_RATE_TO_DAY = 1;
/** Toward the long exposure, in ramp positions a second: a full swing in about
 *  ten seconds, the way eyes adapt to the dark — too slow to be seen moving. */
export const NIGHT_EXPOSURE_RATE_TO_NIGHT = 0.1;
/** A body not advanced for this long, in ms, takes its target outright: a
 *  hidden tab, a stalled frame or a moon that has just come into view never
 *  ramps from a sky it has not been looking at. */
export const NIGHT_EXPOSURE_SNAP_GAP_MS = 500;
/** The long exposure's own level, as a fraction of the level its gain was
 *  authored at: two stops under it, so a night view is never as bright as the
 *  picture was. The rule off keeps the authored level — every slot at 1. */
export const NIGHT_EXPOSURE_CEILING = 0.25;

/** The curve, its two speeds and its ceiling. */
export interface NightExposureParams {
  /** Lit fraction at and below which the long exposure stands in full. */
  fullLit: number;
  /** Lit fraction at and above which the day exposure stands. */
  noneLit: number;
  /** Ramp positions a second toward the day exposure (a larger position). */
  rateToDay: number;
  /** Ramp positions a second toward the long exposure (a smaller position). */
  rateToNight: number;
  /** A body not advanced for longer than this, in ms, takes its target
   *  outright. */
  snapGapMs: number;
  /** The factor at the long exposure, as a fraction of the authored level. */
  ceiling: number;
}

export const NIGHT_EXPOSURE: Readonly<NightExposureParams> = {
  fullLit: NIGHT_EXPOSURE_FULL_LIT,
  noneLit: NIGHT_EXPOSURE_NONE_LIT,
  rateToDay: NIGHT_EXPOSURE_RATE_TO_DAY,
  rateToNight: NIGHT_EXPOSURE_RATE_TO_NIGHT,
  snapGapMs: NIGHT_EXPOSURE_SNAP_GAP_MS,
  ceiling: NIGHT_EXPOSURE_CEILING,
};

/**
 * How much of the cap a camera can see is sunlit, 0..1.
 *
 * `cosPhase` is the cosine of the phase angle at the body — between the
 * directions to the camera and to the Sun — and `radiusOverDistance` is the
 * body's radius over the camera's distance from its centre. The visible cap's
 * angular radius, seen from the centre, is arccos(R/d); all of it is lit when
 * the phase is at most 90° minus that, none of it when the phase is at least
 * 90° plus that, and the answer is linear in cosPhase between. From far away
 * that is exactly the lit fraction of the disc.
 */
export function visibleCapLitFraction(cosPhase: number, radiusOverDistance: number): number {
  const k = Math.min(1, Math.max(0, radiusOverDistance));
  const sinCap = Math.min(1, Math.max(NIGHT_EXPOSURE_MIN_SIN_CAP, Math.sqrt(Math.max(0, 1 - k * k))));
  const c = Math.min(1, Math.max(-1, cosPhase));
  return Math.min(1, Math.max(0, (c + sinCap) / (2 * sinCap)));
}

/**
 * Where on the ramp the camera wants to be for this lit fraction: 0 = the long
 * exposure, 1 = the day exposure, a smoothstep between the two ends. Ends that
 * meet or cross are a step at `fullLit`.
 */
export function nightExposureRamp(lit: number, params: NightExposureParams = NIGHT_EXPOSURE): number {
  const span = params.noneLit - params.fullLit;
  if (!(span > 0)) return lit > params.fullLit ? 1 : 0;
  const x = Math.min(1, Math.max(0, (lit - params.fullLit) / span));
  return x * x * (3 - 2 * x);
}

/** The factor the night terms are multiplied by at a ramp position: exactly
 *  the ceiling at 0, exactly 0 at 1, and a fade that spends its stops evenly
 *  between. */
export function nightExposureFactor(ramp: number, params: NightExposureParams = NIGHT_EXPOSURE): number {
  const keep = 1 - Math.min(1, Math.max(0, ramp));
  return params.ceiling * keep ** NIGHT_EXPOSURE_FALLOFF;
}

/** One body's meter, kept across frames. Made once per body and written in
 *  place. */
export interface NightExposureState {
  /** Whether this body has been advanced before; the first advance snaps. */
  seeded: boolean;
  /** Wall-clock ms of the last advance, for the limiter's dt. */
  stampMs: number;
  /** The lit fraction of the visible cap, as last read. */
  lit: number;
  /** The ramp position that lit fraction asks for. */
  target: number;
  /** The eased ramp position. */
  ramp: number;
  /** The factor written to the body's slot: the eased ramp, shaped. Before
   *  the first advance it is the slot's own starting value, the authored
   *  level. */
  applied: number;
}

export function makeNightExposureState(): NightExposureState {
  return { seeded: false, stampMs: 0, lit: 0, target: 0, ramp: 0, applied: 1 };
}

/**
 * Advance one body's meter a frame: read the ramp position the lit fraction
 * asks for, move the eased position toward it — at `rateToDay` toward a larger
 * position, at `rateToNight` toward a smaller one — or take it outright on the
 * first advance, after a gap longer than `snapGapMs` or a clock that did not
 * move forward, or when `snap` says the scene just jumped; then shape it into
 * the factor. Returns the factor.
 */
export function advanceNightExposure(
  state: NightExposureState,
  lit: number,
  nowMs: number,
  snap = false,
  params: NightExposureParams = NIGHT_EXPOSURE,
): number {
  const target = nightExposureRamp(lit, params);
  const dtMs = nowMs - state.stampMs;
  if (!state.seeded || snap || !(dtMs > 0) || dtMs > params.snapGapMs) {
    state.ramp = target;
  } else {
    const up = (params.rateToDay * dtMs) / 1000;
    const down = (params.rateToNight * dtMs) / 1000;
    const delta = target - state.ramp;
    state.ramp = delta > up ? state.ramp + up : delta < -down ? state.ramp - down : target;
  }
  state.seeded = true;
  state.stampMs = nowMs;
  state.lit = lit;
  state.target = target;
  state.applied = nightExposureFactor(state.ramp, params);
  return state.applied;
}

/** A development build's hand on the curve, the two speeds and the ceiling. */
export interface NightExposureOverride {
  full?: number | null;
  none?: number | null;
  rateToDay?: number | null;
  rateToNight?: number | null;
  ceiling?: number | null;
}

let devParams: NightExposureParams | null = null;

/**
 * Set the curve's ends, the ramp's two speeds and the ceiling from now on
 * (`__moon.nightExposure`,
 * `?nightexposure=<full>,<none>[,<rateToDay>[,<rateToNight>[,<ceiling>]]]`).
 * Each knob left out keeps the value in force; null puts that knob's authored
 * value back, and a null override puts them all back. Ends and the ceiling are
 * held to 0..1 and a speed must be a positive number, or that knob is ignored.
 * Reads back the parameters in force. Development builds only: a production
 * build always reads the authored ones.
 */
export function setDevNightExposure(opts: NightExposureOverride | null): Readonly<NightExposureParams> {
  if (!import.meta.env.DEV) return NIGHT_EXPOSURE;
  if (opts === null) {
    devParams = null;
    return NIGHT_EXPOSURE;
  }
  const next: NightExposureParams = { ...(devParams ?? NIGHT_EXPOSURE) };
  const unit = (v: number): number => Math.min(1, Math.max(0, v));
  if (opts.full === null) next.fullLit = NIGHT_EXPOSURE.fullLit;
  else if (opts.full !== undefined && Number.isFinite(opts.full)) next.fullLit = unit(opts.full);
  if (opts.none === null) next.noneLit = NIGHT_EXPOSURE.noneLit;
  else if (opts.none !== undefined && Number.isFinite(opts.none)) next.noneLit = unit(opts.none);
  if (opts.rateToDay === null) next.rateToDay = NIGHT_EXPOSURE.rateToDay;
  else if (opts.rateToDay !== undefined && Number.isFinite(opts.rateToDay) && opts.rateToDay > 0) {
    next.rateToDay = opts.rateToDay;
  }
  if (opts.rateToNight === null) next.rateToNight = NIGHT_EXPOSURE.rateToNight;
  else if (opts.rateToNight !== undefined && Number.isFinite(opts.rateToNight) && opts.rateToNight > 0) {
    next.rateToNight = opts.rateToNight;
  }
  if (opts.ceiling === null) next.ceiling = NIGHT_EXPOSURE.ceiling;
  else if (opts.ceiling !== undefined && Number.isFinite(opts.ceiling)) next.ceiling = unit(opts.ceiling);
  const authored = next.fullLit === NIGHT_EXPOSURE.fullLit
    && next.noneLit === NIGHT_EXPOSURE.noneLit
    && next.rateToDay === NIGHT_EXPOSURE.rateToDay
    && next.rateToNight === NIGHT_EXPOSURE.rateToNight
    && next.ceiling === NIGHT_EXPOSURE.ceiling;
  devParams = authored ? null : next;
  return devParams ?? NIGHT_EXPOSURE;
}

/** The parameters in force: a development build's override, else the authored
 *  ones. */
export function nightExposureParams(): Readonly<NightExposureParams> {
  return (import.meta.env.DEV ? devParams : null) ?? NIGHT_EXPOSURE;
}

/** What `?nightexposure=` asked for. */
export interface NightExposureParam {
  /** `0`: the rule off, in any build. */
  off: boolean;
  full?: number;
  none?: number;
  rateToDay?: number;
  rateToNight?: number;
  ceiling?: number;
}

/**
 * Read `?nightexposure=` from a query string. `0` switches the rule off in any
 * build — every slot stays at 1 and the picture is the one before the rule. In
 * a development build `<full>,<none>[,<rateToDay>[,<rateToNight>[,<ceiling>]]]`
 * sets the curve for the session, so two curves are two links: two to five
 * numbers, every one finite and each speed positive (the setter holds the ends
 * and the ceiling to 0..1). Anything else asks for nothing.
 */
export function parseNightExposureParam(search: string, dev: boolean = import.meta.env.DEV): NightExposureParam {
  const raw = new URLSearchParams(search).get('nightexposure');
  if (raw === null) return { off: false };
  const value = raw.trim();
  if (value === '0') return { off: true };
  if (!dev) return { off: false };
  const parts = value.split(',');
  if (parts.length < 2 || parts.length > 5 || parts.some((p) => p.trim() === '')) return { off: false };
  const n = parts.map(Number);
  if (!n.every(Number.isFinite)) return { off: false };
  const [full, none, rateToDay, rateToNight, ceiling] = n;
  if (n.length >= 3 && !(rateToDay > 0)) return { off: false };
  if (n.length >= 4 && !(rateToNight > 0)) return { off: false };
  const out: NightExposureParam = { off: false, full, none };
  if (n.length >= 3) out.rateToDay = rateToDay;
  if (n.length >= 4) out.rateToNight = rateToNight;
  if (n.length >= 5) out.ceiling = ceiling;
  return out;
}
