/**
 * Ride frame: near a body the ship rides along with it.
 *
 * The ship's position is heliocentric and only its own thrust integrates it
 * (PlayerShip.update), so a ship parked beside Earth is swept by Earth's
 * 30 km/s around the Sun: the collision shell re-parks it every frame and
 * walks it around the limb, the ground streams past at orbital speed while
 * the readout says 0 km/s, and the sector streamer never idles because the
 * ground under the ship keeps changing. Landed mode already snaps the ship to
 * its body every frame; this module does the same for cruise, by weight.
 *
 * Every frame the caller offers each candidate body (planets, painted moons)
 * with its CURRENT world position. The module keeps, per body, an ANCHOR —
 * where that body was at the last ride — so a body's step this frame is
 * simply `now − anchor`, however many rebuilds moved it in between (a clock
 * jump, a typed date, a rate change all arrive whole), and the ship teleports
 * with a body it fully rides the way landed mode does.
 *
 * Weights read the anchor datum (the ship against where the body WAS), so a
 * warp frame whose step exceeds the band cannot read zero and leave the ship
 * behind. A planet's band is its moon system's reach; a moon's is a few of
 * its rendered radii, capped at half the gap to its parent's shell so it never
 * reaches the planet. The weight EASES in time (never the velocity: an eased
 * velocity lags v·τ behind the body and slides the ship across every pause),
 * so a moonlet sweeping through its own band at 30 km/s lifts the weight only
 * a little for a moment — a nudge, not a yank.
 *
 * Composition is ordered dominance over FULL world steps (a moon's step
 * already carries its parent's): moons first by weight, then planets, each
 * taking `w · Π(1 − w_earlier)` of its step. Near Io the planet term is
 * multiplied by zero and the ride is Io's step; at the Moon the ride is the
 * Moon's step, which carries Earth's 30 km/s whatever Earth's own weight; two
 * co-orbitals both at 1 cannot dilute each other. Deep space rides nothing.
 *
 * Reposes are detected, not listed: the frame captures the ship's position
 * before its thrust step, and if that is not the position the previous frame
 * left after the resolvers, something else moved the ship (a jump, a restore,
 * takeoff, a scripted transfer, a dev frame). The frame then REBASES — anchors
 * to now, weights seeded to their targets, no displacement — so an arrival
 * never slips and a transfer's arc is never disturbed.
 *
 * The caller applies the displacement to the ship AND to the previous
 * position it captured, so the collision sweep still sees only the ship's own
 * step relative to the body: a pressing hull parks, an unresisting one is no
 * longer walked, because the shell no longer advances into it. The governor's
 * moving-body credits read `velocity()` and subtract it from each body's
 * velocity: a ridden body credits nothing, an unridden one credits in full,
 * and through the fade band the residual credit plus the ride sum to today's
 * world-frame allowance.
 */
import { smoothstepUnclamped } from '../shared/math/smoothstep';

/** A planet's band: full ride inside its system reach, none past this
 *  multiple of it — the release ramp sits at the system's edge, where the
 *  planet is a dot and a lateral 30 km/s is invisible. */
export const RIDE_PLANET_OFF_FACTOR = 1.5;
/** A moon's band in rendered radii: full ride inside RIDE_MOON_FULL_RADII,
 *  none past RIDE_MOON_OFF_RADII. Proximity, not the 5° framing standoff —
 *  that one is built on the inflated render radius and would let a moonlet
 *  reach tens of thousands of kilometres out. */
export const RIDE_MOON_FULL_RADII = 6;
export const RIDE_MOON_OFF_RADII = 15;
/** A moon's outer edge is capped at this fraction of the gap between its
 *  orbit and its parent's shell, so no moon's band reaches the planet. */
export const RIDE_MOON_GAP_FRACTION = 0.5;
/** The outer edge never sits closer than this to the full-ride edge, so the
 *  fade always has some width. */
export const RIDE_MOON_MIN_OFF_FACTOR = 1.2;
/** Time constant of the weight ease. A moonlet crossing its own band at
 *  30 km/s takes ~0.2 s; at this τ the weight reaches ~0.25 for a moment. */
export const RIDE_WEIGHT_TAU_S = 0.7;
/** Below this an eased weight whose target is zero snaps to zero (the ease
 *  alone never gets there): about five time constants after leaving. */
export const RIDE_WEIGHT_FLOOR = 1e-3;

/** 1 at or inside `fullAU`, 0 at or past `offAU`, smoothstep between. */
export function bandWeight(distAU: number, fullAU: number, offAU: number): number {
  if (distAU <= fullAU) return 1;
  if (distAU >= offAU) return 0;
  return smoothstepUnclamped((offAU - distAU) / (offAU - fullAU));
}

export function planetRideWeight(distAU: number, reachAU: number): number {
  return bandWeight(distAU, reachAU, reachAU * RIDE_PLANET_OFF_FACTOR);
}

/** Where a moon's band ends, given its orbit and its parent's shell. */
export function moonRideOffAU(renderedRadiusAU: number, orbitRadiusAU: number, parentShellAU: number): number {
  const full = renderedRadiusAU * RIDE_MOON_FULL_RADII;
  const gapCap = RIDE_MOON_GAP_FRACTION * (orbitRadiusAU - parentShellAU);
  return Math.max(full * RIDE_MOON_MIN_OFF_FACTOR, Math.min(renderedRadiusAU * RIDE_MOON_OFF_RADII, gapCap));
}

export function moonRideWeight(
  distAU: number, renderedRadiusAU: number, orbitRadiusAU: number, parentShellAU: number,
): number {
  return bandWeight(distAU, renderedRadiusAU * RIDE_MOON_FULL_RADII, moonRideOffAU(renderedRadiusAU, orbitRadiusAU, parentShellAU));
}

/** Exponential ease of a weight toward its target — frame-rate invariant. */
export function easeWeight(prev: number, target: number, dtS: number, tauS = RIDE_WEIGHT_TAU_S): number {
  if (dtS <= 0) return prev;
  return prev + (target - prev) * (1 - Math.exp(-dtS / tauS));
}

export type RideKind = 'planet' | 'moon';

interface Carrier {
  key: string;
  kind: RideKind;
  /** The body's position at the last ride (AU). */
  ax: number; ay: number; az: number;
  wEff: number;
  /** Per-frame scratch. */
  sx: number; sy: number; sz: number;
  wTarget: number;
  radii: number;
  seen: boolean;
  fresh: boolean;
}

export interface Vec3Like { x: number; y: number; z: number }

/** Sort key for ordered dominance: moons before planets, higher weight first,
 *  fewer rendered radii away first. */
function dominates(a: Carrier, b: Carrier): boolean {
  if (a.kind !== b.kind) return a.kind === 'moon';
  if (a.wEff !== b.wEff) return a.wEff > b.wEff;
  return a.radii < b.radii;
}

export class RideFrame {
  /** `?ride=0`: every weight held at zero — today's flight, exactly. */
  enabled = true;

  private readonly carriers = new Map<string, Carrier>();
  private readonly order: Carrier[] = [];
  private lastResolved: Vec3Like | null = null;
  private rebase = true;
  private dtS = 0;
  private shipX = 0; private shipY = 0; private shipZ = 0;
  private rideX = 0; private rideY = 0; private rideZ = 0;
  private velX = 0; private velY = 0; private velZ = 0;
  private maxWeight = 0;

  /**
   * Start a frame. `ship*` is the ship after its own thrust step and before
   * the ride; `prev*` is the position the frame captured before that step.
   * If `prev*` is not where the previous frame left the ship, something else
   * re-posed it and this frame rebases.
   */
  beginFrame(
    shipX: number, shipY: number, shipZ: number,
    prevX: number, prevY: number, prevZ: number,
    dtS: number,
  ): void {
    const lr = this.lastResolved;
    this.rebase = lr === null || prevX !== lr.x || prevY !== lr.y || prevZ !== lr.z;
    this.dtS = dtS;
    this.shipX = shipX; this.shipY = shipY; this.shipZ = shipZ;
    for (const c of this.carriers.values()) c.seen = false;
  }

  /** Whether this frame rebases (a repose was detected, or it is the first). */
  get rebasing(): boolean { return this.rebase; }

  /**
   * Offer a body for this frame with its CURRENT world position and its band
   * (full ride at or inside `fullAU`, none at or past `offAU`). The band is
   * read at the ship's distance to the body's ANCHOR (where the body was at
   * the last ride), the pre-step datum. `renderedRadiusAU` only breaks ties
   * between moons. Plain numbers, so a steady-state frame allocates nothing.
   */
  consider(
    key: string, kind: RideKind,
    posX: number, posY: number, posZ: number,
    fullAU: number, offAU: number,
    renderedRadiusAU: number,
  ): void {
    let c = this.carriers.get(key);
    if (!c) {
      c = { key, kind, ax: posX, ay: posY, az: posZ, wEff: 0, sx: 0, sy: 0, sz: 0, wTarget: 0, radii: 0, seen: false, fresh: true };
      this.carriers.set(key, c);
    }
    if (this.rebase) { c.ax = posX; c.ay = posY; c.az = posZ; }
    const dx = this.shipX - c.ax;
    const dy = this.shipY - c.ay;
    const dz = this.shipZ - c.az;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    c.wTarget = this.enabled ? bandWeight(dist, fullAU, offAU) : 0;
    c.radii = renderedRadiusAU > 0 ? dist / renderedRadiusAU : Infinity;
    c.sx = posX - c.ax; c.sy = posY - c.ay; c.sz = posZ - c.az;
    c.seen = true;
  }

  /**
   * Finish the frame: ease or seed the weights, compose the displacement by
   * ordered dominance, advance every anchor to now, drop bodies not offered
   * this frame. Writes and returns `out`.
   */
  finish<T extends Vec3Like>(out: T): T {
    const order = this.order;
    order.length = 0;
    for (const c of this.carriers.values()) {
      if (!c.seen) { this.carriers.delete(c.key); continue; }
      c.wEff = this.rebase || c.fresh
        ? (this.rebase ? c.wTarget : 0)
        : easeWeight(c.wEff, c.wTarget, this.dtS);
      // The ease only approaches its target; a body the ship has left must
      // read exactly zero, or "riding anything?" stays true forever.
      if (c.wTarget === 0 && c.wEff < RIDE_WEIGHT_FLOOR) c.wEff = 0;
      c.fresh = false;
      // Insertion sort — a handful of bodies, no allocation.
      let i = order.length;
      order.push(c);
      while (i > 0 && dominates(c, order[i - 1])) { order[i] = order[i - 1]; i--; }
      order[i] = c;
    }
    let x = 0, y = 0, z = 0, room = 1, maxW = 0;
    for (const c of order) {
      const share = c.wEff * room;
      if (share > 0) { x += share * c.sx; y += share * c.sy; z += share * c.sz; }
      room *= 1 - c.wEff;
      if (c.wEff > maxW) maxW = c.wEff;
      c.ax += c.sx; c.ay += c.sy; c.az += c.sz;
    }
    if (this.rebase) { x = 0; y = 0; z = 0; }
    this.rideX = x; this.rideY = y; this.rideZ = z;
    this.maxWeight = maxW;
    if (this.dtS > 0 && !this.rebase) {
      this.velX = x / this.dtS; this.velY = y / this.dtS; this.velZ = z / this.dtS;
    } else {
      this.velX = 0; this.velY = 0; this.velZ = 0;
    }
    out.x = x; out.y = y; out.z = z;
    return out;
  }

  /** Record where the frame left the ship after the resolvers. */
  endFrame(resolvedX: number, resolvedY: number, resolvedZ: number): void {
    if (this.lastResolved === null) this.lastResolved = { x: resolvedX, y: resolvedY, z: resolvedZ };
    else { this.lastResolved.x = resolvedX; this.lastResolved.y = resolvedY; this.lastResolved.z = resolvedZ; }
  }

  /** The last frame's ride as a velocity (AU per real second) — what the
   *  moving-body credits subtract from each body's velocity. */
  velocity<T extends Vec3Like>(out: T): T {
    out.x = this.velX; out.y = this.velY; out.z = this.velZ;
    return out;
  }

  /** The last frame's displacement (AU). */
  displacement<T extends Vec3Like>(out: T): T {
    out.x = this.rideX; out.y = this.rideY; out.z = this.rideZ;
    return out;
  }

  /** The largest eased weight this frame — zero means the ship rides nothing. */
  get weight(): number { return this.maxWeight; }

  /** A body's eased weight, 0 when it is not a carrier. */
  weightOf(key: string): number { return this.carriers.get(key)?.wEff ?? 0; }

  /** Carriers with any weight, dominant first — for the dev probe. */
  carriersSnapshot(): { key: string; kind: RideKind; weight: number }[] {
    return this.order.filter((c) => c.wEff > 0).map((c) => ({ key: c.key, kind: c.kind, weight: c.wEff }));
  }

  /** Forget everything: the next frame rebases. */
  reset(): void {
    this.carriers.clear();
    this.order.length = 0;
    this.lastResolved = null;
    this.rebase = true;
    this.rideX = this.rideY = this.rideZ = 0;
    this.velX = this.velY = this.velZ = 0;
    this.maxWeight = 0;
  }
}

/**
 * A body's velocity as the ride frame sees it: its world velocity minus the
 * ride's. Feeds the moving-body credits, so a ridden body credits nothing
 * and an unridden one credits in full.
 */
export function relativeBodyVelocity<T extends Vec3Like>(
  bodyVx: number, bodyVy: number, bodyVz: number,
  rideVel: Vec3Like,
  out: T,
): T {
  out.x = bodyVx - rideVel.x;
  out.y = bodyVy - rideVel.y;
  out.z = bodyVz - rideVel.z;
  return out;
}
