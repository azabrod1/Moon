/**
 * Emergent escape dynamics at a planet's collision shell: a frame-loop
 * simulation mirroring PlanetariumMode's cruise order (contact-aim swing →
 * governor → integrate → planet motion → swept-shell contact) for one
 * Earth-class planet. The per-law behavior is pinned in arrivalLogic.test.ts;
 * what only this loop can pin is that the pieces COMPOSE into an escape —
 * three shell traps lived exactly in their composition:
 *
 * - Leading face: the sweep saw the moved shell over the segment START and
 *   re-parked a ship whose endpoint was already clear, cancelling every
 *   frame's escape progress — pinned forever at the leave-law creep (the
 *   reported "stuck up close at ~330 km/s" on Earth).
 * - Trailing face: the approach credit tapered to zero head-on, so the
 *   world-frame glide could never out-close a planet fleeing at orbital
 *   speed — a permanent ~30 km/s tailgate that never reached the shell.
 * - Tangent park against a closing face: both of the above at once.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceBodyCap,
  contactAimStep,
  CONTACT_AIM_TTL_S,
  CONTACT_ALIGN_OUT_MAX,
  grazeDeflectAim,
  initialBodyCapState,
  movingBodySpeedCap,
  BODY_APPROACH_K_PER_S,
  BODY_APPROACH_V_MIN_AU_S,
  sweepSegmentSphere,
  type BodyCapState,
} from './arrivalLogic';
import { SHIP_CLEARANCE_AU } from './cruiseView';
import { KM_PER_AU } from '../astronomy/constants';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';

const EARTH_ENVELOPE = (6378 / KM_PER_AU) * 1.012; // solid radius × atmosphere shell
const COLLISION_R = EARTH_ENVELOPE + SHIP_CLEARANCE_AU;
const EARTH_V_AU_S = 29.78 / KM_PER_AU;
const COMMANDED = LIGHT_SPEED_AU_PER_S * 0.083; // the deep-in-system dialed speed

/** A hands-off bump-and-escape must complete comfortably within this. The
 *  stationary-planet baseline (the QA-tuned graze feel) runs ~30 s; a moving
 *  planet must not change the class of the outcome. */
const ESCAPE_DEADLINE_S = 60;

/**
 * Fly the cruise frame loop hands-off: ship at `startPos` heading `heading`,
 * planet from the origin with velocity `planetVel`. Returns the sim time at
 * which the ship got one collision radius of clear sky, or null if it never
 * did — a null is a ship the player would call stuck.
 */
function timeToEscape(
  startPos: THREE.Vector3,
  heading: THREE.Vector3,
  planetVelAUPerS: THREE.Vector3,
  maxS = 120,
  dt = 1 / 60,
): number | null {
  const pos = startPos.clone();
  const fwd = heading.clone().normalize();
  const planet = new THREE.Vector3(0, 0, 0);
  let bodyCap: BodyCapState = initialBodyCapState();
  const aimTarget = new THREE.Vector3();
  let aimActive = false;
  let aimAge = 0;

  for (let t = 0; t < maxS; t += dt) {
    // Contact-aim swing (PlanetariumMode.applyContactAim, hands off).
    if (aimActive) {
      aimAge += dt;
      const done = contactAimStep(fwd, aimTarget, dt, fwd);
      if (done || aimAge >= CONTACT_AIM_TTL_S) aimActive = false;
    }

    // Body governor (computeBodySpeedCap + advanceBodyCap, no bypass).
    const to = planet.clone().sub(pos);
    const dist = to.length();
    const cos = to.dot(fwd) / dist;
    const geomCap = movingBodySpeedCap(
      dist - EARTH_ENVELOPE, EARTH_ENVELOPE, cos,
      planetVelAUPerS.dot(fwd),
      planetVelAUPerS.dot(to) / dist,
      BODY_APPROACH_K_PER_S, BODY_APPROACH_V_MIN_AU_S,
    );
    bodyCap = advanceBodyCap(bodyCap, geomCap, COMMANDED, false, dt);

    // Integrate the ship, then the world (rebuildPlanetPositions runs after
    // player.update), then resolve the swept contact against the moved shell.
    const speed = Math.min(COMMANDED, bodyCap.applied);
    const prev = pos.clone();
    pos.addScaledVector(fwd, speed * dt);
    planet.addScaledVector(planetVelAUPerS, dt);

    const hit = sweepSegmentSphere(
      prev.x, prev.y, prev.z, pos.x, pos.y, pos.z,
      planet.x, planet.y, planet.z, COLLISION_R,
    );
    if (hit) {
      // applyShellContact: park on the shell, arm the graze when the nose
      // still points at/along the body.
      pos.set(
        planet.x + hit.ox * COLLISION_R,
        planet.y + hit.oy * COLLISION_R,
        planet.z + hit.oz * COLLISION_R,
      );
      if (fwd.x * hit.ox + fwd.y * hit.oy + fwd.z * hit.oz < CONTACT_ALIGN_OUT_MAX) {
        grazeDeflectAim(fwd.x, fwd.y, fwd.z, hit.ox, hit.oy, hit.oz, aimTarget);
        aimActive = true;
        aimAge = 0;
      }
    }

    if (pos.distanceTo(planet) - COLLISION_R > COLLISION_R) return t;
  }
  return null;
}

describe('hands-off shell bumps always escape', () => {
  // Near-dead-center approach from one shell radius of clear sky; the 0.02
  // lean keeps the graze off its dead-center special case.
  const start = () => new THREE.Vector3(COLLISION_R * 2, 0, 0);
  const inbound = () => new THREE.Vector3(-1, 0.02, 0);

  it('on a stationary planet (the baseline graze feel)', () => {
    const t = timeToEscape(start(), inbound(), new THREE.Vector3());
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('chasing the TRAILING face — the receding shell must still be reachable, then left', () => {
    // Pre-fix: the head-on credit was zero, so the ship tailgated the fleeing
    // planet ~30 km/s short of the shell forever and this returned null.
    const vel = new THREE.Vector3(-EARTH_V_AU_S, 0, 0);
    const t = timeToEscape(start(), inbound(), vel);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('bumped by the LEADING face at 1× time — the bulldozer must not pin', () => {
    // Pre-fix: every frame the advanced shell covered the segment start, the
    // sweep re-parked the ship, and the escape progress was discarded —
    // pinned at the ~330 km/s creep forever.
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const t = timeToEscape(start(), inbound(), vel);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('bumped by the LEADING face at 10× time warp', () => {
    const vel = new THREE.Vector3(EARTH_V_AU_S * 10, 0, 0);
    const t = timeToEscape(start(), inbound(), vel);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('bumped on the SIDE face (planet motion across the contact normal)', () => {
    const vel = new THREE.Vector3(0, 0, EARTH_V_AU_S);
    const t = timeToEscape(start(), inbound(), vel);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('parked ON the shell nose near-tangent, leading face closing at 1×', () => {
    const t = timeToEscape(
      new THREE.Vector3(COLLISION_R, 0, 0),
      new THREE.Vector3(-0.05, 1, 0),
      new THREE.Vector3(EARTH_V_AU_S, 0, 0),
    );
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(ESCAPE_DEADLINE_S);
  });
});
