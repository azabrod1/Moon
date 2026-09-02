/**
 * Where the ship's own marker belongs on the chart — pure math, no THREE, no
 * scene state.
 *
 * The chart draws two spaces at once. Heliocentric radii are squeezed toward
 * the Sun by the radial curve (mapProjection), and a revealed moon system is
 * drawn in a space of its own: every moon sits at the offset policy's charted
 * radius in units of the parent's DRAWN globe, which at chart distances is many
 * times the parent's true size. A ship carried through the heliocentric
 * compression alone therefore draws on the parent's limb while the moon it is
 * standing on draws tens of px away — the two are not the same map, and a
 * marker that reads only the first one is in the wrong space whenever the
 * second one is on screen.
 *
 * This is the one transform that answers for the ship, and both the marker and
 * the heading probe go through it. That is what keeps the chevron pointing
 * along the course rather than at the parent: the probe point is the image of a
 * point one step ahead under exactly the map the marker itself was drawn by,
 * never a second opinion about where the ship is.
 *
 *   P = lerp(G, L, wView · wEnvelope)
 *
 *   G — the plain chart point: the radial compression, and nothing else.
 *   L — the system-local point: the parent's charted position plus the ship's
 *       own direction at the moons' charted distance, in the moons' own units.
 *   wEnvelope — 1 while the ship is inside the system's moon envelope, fading
 *       to 0 past the widest apoapsis the system has. Outside it there are no
 *       moons for the marker to agree with, and the chart's own compression is
 *       the honest answer.
 *   wView — 1 where the system IS the view, fading to 0 by the shell its moons
 *       appear at, so the marker joins the amplified space exactly as that
 *       space appears rather than snapping into it. Zero in the corner chart
 *       and at an unrevealed overview: neither draws a moon, so neither has a
 *       second space to join.
 *
 * Both weights are smooth and both endpoints are the plain point, so the marker
 * cannot jump when a system reveals, when the camera crosses a shell, or when
 * the ship leaves the envelope — the transform is continuous everywhere it is
 * evaluated.
 *
 * ## The policy, extended to the parent's centre
 *
 * The moons' policy is not defined at the parent: a packed inner family is
 * lifted clear of the globe by an affine squeeze, which leaves the curve with a
 * POSITIVE value at x = 0. Used as it stands, a ship at the parent's own centre
 * would chart a radius out from it, and a ship crossing the system would be
 * displaced by that intercept the whole way. Below the innermost periapsis the
 * policy is therefore extended by a monotone cubic Hermite segment running from
 * the centre (exactly 0) to the policy's own value where the moons begin —
 * continuous at the join, and increasing throughout, so radial ordering holds
 * across the whole extended domain. At and above that point the policy governs
 * unchanged, which is what makes a ship standing on a moon degenerate to
 * exactly that moon's drawn position.
 */

import {
  blendChartedR,
  mapMoonOffsetR,
  moonOffsetEntries,
  type MoonOffsetPolicy,
} from './mapMoonOffset';
import {
  projectMapPoint,
  MAP_BLEND_TRUE,
  type MapCurve,
  type MapVec3,
} from './mapProjection';
import { smoothstepUnclamped } from '../../shared/math/smoothstep';

/**
 * How far past the system's widest apoapsis the ship's charted space fades out,
 * as a fraction of that apoapsis. Wide on purpose: the envelope's edge is the
 * one place the transform moves the marker fast, and a broad fade spends that
 * motion over a distance rather than over a frame.
 */
export const MAP_SHIP_ENVELOPE_FADE_FRAC = 0.5;

/**
 * Largest end slope the Hermite extension may take, as a multiple of its own
 * secant slope. The Fritsch–Carlson condition for a monotone cubic is
 * (m0/Δ)² + (m1/Δ)² ≤ 9; the start slope is pinned at the secant (m0 = Δ), so
 * anything up to √8 ≈ 2.83 at the far end keeps the segment increasing. The
 * real systems land far below this — the clamp exists so a retuned policy
 * cannot produce a curve that doubles back.
 */
const HERMITE_END_SLOPE_MAX = 2.8;

/** The system the ship is charted inside, and everything the transform needs
 *  from it. Filled in place once per frame by the chart. */
export interface ShipAnchorSystem {
  /** The system's own offset policy — the moons' charted radii come from it,
   *  and so does the ship's. */
  policy: MoonOffsetPolicy;
  /** The parent's TRUE radius in AU: the unit the policy's x is measured in. */
  parentRadiusAU: number;
  /** The parent's true heliocentric position (AU), which the ship's
   *  planetocentric offset is taken against. */
  parentHelioX: number;
  parentHelioY: number;
  parentHelioZ: number;
  /** Where the chart has drawn that parent this frame. */
  parentMapX: number;
  parentMapY: number;
  parentMapZ: number;
  /** AU per charted parent radius — the moons' own scale, already blended
   *  toward true scale. */
  scaleBlendedAU: number;
  /** The widest apoapsis in the system, in parent TRUE radii: the envelope the
   *  amplified space covers. */
  maxApoX: number;
  /** How much this view amplifies at all, in [0, 1]. */
  viewWeight: number;
}

/** Everything the ship's transform is evaluated against for one frame. */
export interface ShipAnchorFrame {
  /** How far the chart is blended toward true scale. */
  blend: number;
  curve: MapCurve;
  /** The system the ship is charted inside, or null for the plain chart. */
  system: ShipAnchorSystem | null;
}

/** The innermost knee of one system's extended policy, memoized on the policy
 *  object. A policy is built once per system and dropped wholesale when the
 *  knobs move, so identity is the whole of the invalidation. */
interface PolicyKnee {
  /** The innermost periapsis in the system, in parent true radii. 0 for a
   *  system with no moons at all, which leaves the policy unextended. */
  x0: number;
  /** The policy's value there. */
  r0: number;
  /** The Hermite's end slope, in the segment's own parameter. */
  m1: number;
}

let kneeFor: MoonOffsetPolicy | null = null;
let knee: PolicyKnee = { x0: 0, r0: 0, m1: 0 };

function policyKnee(policy: MoonOffsetPolicy): PolicyKnee {
  if (kneeFor === policy) return knee;
  let x0 = Infinity;
  for (const entry of moonOffsetEntries(policy.parentPlanet)) {
    if (entry.periX < x0) x0 = entry.periX;
  }
  if (!(x0 > 0) || !Number.isFinite(x0)) {
    knee = { x0: 0, r0: 0, m1: 0 };
  } else {
    const r0 = mapMoonOffsetR(policy, x0);
    // The policy's slope just above the knee, measured rather than re-derived:
    // the curve's coefficients and the squeeze's affine map are the policy's
    // own business, and a difference quotient cannot fall out of step with
    // them. The knee sits well inside the squeezed run, so the neighbourhood
    // sampled here is smooth.
    const h = x0 * 1e-5;
    const slope = (mapMoonOffsetR(policy, x0 + h) - r0) / h;
    const m1 = Math.min(Math.max(slope * x0, 0), HERMITE_END_SLOPE_MAX * r0);
    knee = { x0, r0, m1 };
  }
  kneeFor = policy;
  return knee;
}

/**
 * Where the chart puts a point x parent-true-radii out, in parent drawn radii —
 * the moons' policy above the innermost periapsis, and the monotone extension
 * to the parent's centre below it.
 */
export function shipOffsetR(policy: MoonOffsetPolicy, x: number): number {
  const safeX = Math.max(x, 0);
  const k = policyKnee(policy);
  if (!(k.x0 > 0) || safeX >= k.x0) return mapMoonOffsetR(policy, safeX);
  // Cubic Hermite on t = x / x0 with p(0) = 0, p(1) = r0, p'(0) = r0 (the
  // secant slope) and p'(1) = the policy's own slope, clamped monotone.
  const t = safeX / k.x0;
  const t2 = t * t;
  const t3 = t2 * t;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return k.r0 * (h10 + h01) + k.m1 * h11;
}

/**
 * The ship's charted radius at the live blend, in parent drawn radii — the same
 * rule the moons themselves are placed by, so a ship standing on one lands on
 * it exactly. At true scale this is x, and the caller's scale is the parent's
 * true radius, so the product is the raw offset by construction.
 */
export function shipChartedR(policy: MoonOffsetPolicy, x: number, blend: number): number {
  const safeX = Math.max(x, 0);
  if (blend >= MAP_BLEND_TRUE) return safeX;
  return blendChartedR(shipOffsetR(policy, safeX), safeX, blend);
}

/**
 * How much of the system's own space the ship is drawn in at a planetocentric
 * distance of `x` parent radii: all of it inside the system's widest apoapsis,
 * fading to none past it.
 */
export function shipEnvelopeWeight(x: number, maxApoX: number): number {
  if (!Number.isFinite(x) || !(maxApoX > 0)) return 0;
  if (x <= maxApoX) return 1;
  const fade = maxApoX * MAP_SHIP_ENVELOPE_FADE_FRAC;
  if (!(fade > 0)) return 0;
  const t = (x - maxApoX) / fade;
  if (t >= 1) return 0;
  return 1 - smoothstepUnclamped(t);
}

/**
 * How much the VIEW amplifies: none at the shell where a system's moons first
 * appear, all of it once the camera is inside the distance a focus on the
 * parent lands at. Both ends matter — the far one is what makes a reveal
 * invisible to the marker, and the near one is where the ship has to be in the
 * same space as the moons it is flying among.
 */
export function shipViewWeight(
  cameraDistAU: number,
  innerRevealAU: number,
  revealDistAU: number,
): number {
  if (!Number.isFinite(cameraDistAU) || !(revealDistAU > 0)) return 0;
  const inner = Math.max(innerRevealAU, 0);
  if (cameraDistAU >= revealDistAU) return 0;
  // A shell with no room inside it cannot be ramped across; the reveal itself
  // is then the whole of the answer.
  if (!(revealDistAU > inner)) return 1;
  if (cameraDistAU <= inner) return 1;
  return 1 - smoothstepUnclamped((cameraDistAU - inner) / (revealDistAU - inner));
}

/** The two weights together: how far the ship is carried from the plain chart
 *  into the system's own space. */
export function shipAnchorWeight(system: ShipAnchorSystem, x: number): number {
  const view = Math.min(Math.max(system.viewWeight, 0), 1);
  if (!(view > 0)) return 0;
  return view * shipEnvelopeWeight(x, system.maxApoX);
}

/**
 * Chart one point of ship space: the plain compression, carried toward the
 * owning system's own space by the two weights. Writes into `out` and returns
 * it, so the marker and the heading probe can both be charted per frame without
 * allocating.
 *
 * The same call answers for both, and that is the point: whatever space the
 * marker ends up in, the probe point is in it too.
 */
export function chartShipPoint(
  x: number,
  y: number,
  z: number,
  frame: ShipAnchorFrame,
  out: MapVec3,
): MapVec3 {
  projectMapPoint(x, y, z, frame.blend, frame.curve, out);
  const system = frame.system;
  if (!system || !(system.viewWeight > 0) || !(system.parentRadiusAU > 0)) return out;
  const ox = x - system.parentHelioX;
  const oy = y - system.parentHelioY;
  const oz = z - system.parentHelioZ;
  const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
  // The policy's own input: planetocentric distance in parent TRUE radii.
  const parentRadii = dist / system.parentRadiusAU;
  const weight = shipAnchorWeight(system, parentRadii);
  if (!(weight > 0)) return out;
  // The system-local point, in exactly the units the moons are drawn in: the
  // charted radius in parent drawn radii, times AU per parent drawn radius.
  const charted = shipChartedR(system.policy, parentRadii, frame.blend) * system.scaleBlendedAU;
  const k = dist > 0 ? charted / dist : 0;
  const lx = system.parentMapX + ox * k;
  const ly = system.parentMapY + oy * k;
  const lz = system.parentMapZ + oz * k;
  if (weight >= 1) {
    // The endpoint exactly, not an interpolation that rounds to it: at full
    // weight a ship standing on a moon has to land on that moon's own drawn
    // position, and "to the last bit" is the only version of that claim with no
    // tolerance to argue about.
    out.x = lx;
    out.y = ly;
    out.z = lz;
    return out;
  }
  out.x += (lx - out.x) * weight;
  out.y += (ly - out.y) * weight;
  out.z += (lz - out.z) * weight;
  return out;
}

/**
 * How far ahead of the ship the heading probe is charted, in AU.
 *
 * The chevron's angle is the SCREEN delta between the ship's charted point and
 * a point one step along its course, so the step's only job is to be short
 * enough that the transform is straight over it and long enough that the delta
 * is a real number rather than rounding. Scale-proportional for the second
 * (a chart drawn in AU has no fixed unit of "short"), and small for the first:
 * inside a moon system the transform bends over a fraction of a parent radius,
 * and a step of the size the old chord took — several hundredths of the ship's
 * own heliocentric radius — would cut across that bend and answer with the
 * chord's direction rather than the course's.
 *
 * Near a SMALL system far out, heliocentric scale is the wrong yardstick: at
 * Pluto, a millionth of the Sun distance is still several Pluto radii, wide
 * enough that a probe launched from inside the envelope lands in the fade —
 * charted at a different weight than the marker, which can put it BEHIND the
 * marker and flip the chevron. Inside a system the step is therefore capped by
 * the parent's own radius, keeping both endpoints inside a neighbourhood where
 * the weights are locally uniform.
 */
export const PROBE_STEP_PARENT_RADII = 0.01;

export function shipHeadingProbeStepAU(
  shipRadiusAU: number,
  parentRadiusAU: number | null = null,
): number {
  const r = Number.isFinite(shipRadiusAU) ? Math.abs(shipRadiusAU) : 0;
  let step = r * 1e-6;
  if (parentRadiusAU !== null && parentRadiusAU > 0) {
    step = Math.min(step, parentRadiusAU * PROBE_STEP_PARENT_RADII);
  }
  return Math.max(step, 1e-9);
}
