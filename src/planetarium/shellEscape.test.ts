/**
 * Emergent escape dynamics at a planet's collision shell: a frame-loop
 * simulation mirroring PlanetariumMode's cruise order (governor → integrate →
 * planet motion → swept-shell contact) for one Earth-class planet. The
 * per-law behavior is pinned in arrivalLogic.test.ts; what only this loop can
 * pin is that the pieces COMPOSE under the two contact rules — a contact
 * NEVER rotates the ship (the heading is the pilot's alone; the park is
 * position-only), and a ship THRUSTING into the shell holds station there
 * while only an unresisting hull is moved by the shell's own advance. So the
 * demands split:
 *
 * - Pressing the shell is STATION, on every face of a body moving or not:
 *   the ship reaches the shell, sits there without creep or growing
 *   penetration, and the body keeps the place on screen the pilot flew it
 *   to. It stays escapable because the heading is untouched (the pilot
 *   steers off whenever they choose — the leave law and credits are pinned
 *   elsewhere).
 * - A face ADVANCING into a hull that is NOT thrusting into it must never
 *   pin it: the shove's own advance walks the hull around the limb and off
 *   (the bulldozer rescue).
 *
 * Station is not a freeze: a parked ship beside a body crossing at orbital
 * speed is re-projected onto a shell that keeps moving, so the body's
 * bearing creeps — degrees per minute at 1x, which is the body's own passage
 * and not the app steering. The pins below measure that bearing.
 *
 * With the ride frame on (rideFrame.ts — the product's flight; `?ride=0` is
 * the world-frame flight the first describe pins) the ship near a body moves
 * WITH it, so a face never advances into a hull that is not thrusting into
 * it: a hull with the dial at zero rides instead of being walked, a press at
 * warp is a station instead of a release, and leaving is the pilot's own
 * departure. The harness mirrors the mode's order for it too: the ride is
 * applied after the planet moves and before the sweep, to the ship AND to
 * the frame's pre-thrust position, and the credits see the body's velocity
 * minus the ride's.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceBodyCap,
  initialBodyCapState,
  movingBodySpeedCap,
  resolveShellContactPark,
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

/** A shoved ship must be walked off the shell comfortably within this; a
 *  pressing pilot's park must be stable on the same clock. */
const ESCAPE_DEADLINE_S = 60;

interface ContactRun {
  /** Sim time of one collision radius of clear sky, or null if never. */
  escapeAtS: number | null;
  /** Sim time of first shell contact, or null if the shell was never reached. */
  contactAtS: number | null;
  /** Sim time of the LAST shell contact — a bulldozer rescue is this going
   *  quiet: the walked-off ship is one the shell has stopped holding. */
  lastContactAtS: number | null;
  /** Deepest the ATTEMPTED position ever sat inside the shell, in shell radii —
   *  a growing value is a resolver failing to hold the surface. */
  maxPenetrationFrac: number;
  /** How far the body's direction has swung, in degrees, since the frame the
   *  ship first touched its shell. The heading never moves, so this IS how
   *  far the body has travelled across the screen — a station that lets the
   *  destination slide out of the view is not a station. */
  bodySwingDeg: number;
  /** Sim time of the last frame of the run, so a pin can say the shell was
   *  STILL holding the ship when the clock ran out. */
  endS: number;
}

/**
 * Fly the cruise frame loop hands-off: ship at `startPos` heading `heading`,
 * planet from the origin with velocity `planetVel`.
 */
function runContact(
  startPos: THREE.Vector3,
  heading: THREE.Vector3,
  planetVelAUPerS: THREE.Vector3,
  maxS = 120,
  dt = 1 / 60,
  commanded = COMMANDED,
  opts: {
    /** The ride weight on this one body (rideFrame.ts composes it the same
     *  way for a single carrier): the ship takes this share of the planet's
     *  step each frame, and the credits see the remainder of its velocity. */
    rideWeight?: number;
    /** A time-rate change mid-run: from this sim second the planet moves
     *  `rateFactor` times faster, as a pilot cranking the clock would see. */
    rateChangeAtS?: number;
    rateFactor?: number;
  } = {},
): ContactRun {
  const rideWeight = opts.rideWeight ?? 0;
  const pos = startPos.clone();
  const fwd = heading.clone().normalize();
  const fwd0 = fwd.clone();
  const planet = new THREE.Vector3(0, 0, 0);
  let bodyCap: BodyCapState = initialBodyCapState();
  const park = new THREE.Vector3();
  const run: ContactRun = {
    escapeAtS: null, contactAtS: null, lastContactAtS: null, maxPenetrationFrac: 0,
    bodySwingDeg: 0, endS: 0,
  };
  const bearing0 = new THREE.Vector3();
  const bearing = new THREE.Vector3();

  const vel = planetVelAUPerS.clone();
  const relVel = new THREE.Vector3();
  const rideStep = new THREE.Vector3();
  for (let t = 0; t < maxS; t += dt) {
    if (opts.rateChangeAtS !== undefined && t >= opts.rateChangeAtS) {
      vel.copy(planetVelAUPerS).multiplyScalar(opts.rateFactor ?? 1);
    }
    // Body governor (computeBodySpeedCap + advanceBodyCap, no bypass). The
    // credits see the body's velocity minus the ride's.
    relVel.copy(vel).multiplyScalar(1 - rideWeight);
    const to = planet.clone().sub(pos);
    const dist = to.length();
    const cos = to.dot(fwd) / dist;
    const geomCap = movingBodySpeedCap(
      dist - EARTH_ENVELOPE, EARTH_ENVELOPE, cos,
      relVel.dot(fwd),
      relVel.dot(to) / dist,
      BODY_APPROACH_K_PER_S, BODY_APPROACH_V_MIN_AU_S,
    );
    bodyCap = advanceBodyCap(bodyCap, geomCap, commanded, false, dt);

    // Integrate the ship, then the world (rebuildPlanetPositions runs after
    // player.update), then resolve the swept contact against the moved shell.
    const speed = Math.min(commanded, bodyCap.applied);
    const prev = pos.clone();
    pos.addScaledVector(fwd, speed * dt);
    planet.addScaledVector(vel, dt);
    // The ride: the ship and the frame's pre-thrust position take the
    // weighted planet step, so the sweep sees only the ship's own step.
    if (rideWeight > 0) {
      rideStep.copy(vel).multiplyScalar(dt * rideWeight);
      pos.add(rideStep);
      prev.add(rideStep);
    }

    const hit = sweepSegmentSphere(
      prev.x, prev.y, prev.z, pos.x, pos.y, pos.z,
      planet.x, planet.y, planet.z, COLLISION_R,
    );
    if (hit) {
      if (run.contactAtS === null) {
        run.contactAtS = t;
        bearing0.copy(planet).sub(pos).normalize();
      }
      run.lastContactAtS = t;
      run.maxPenetrationFrac = Math.max(
        run.maxPenetrationFrac,
        (COLLISION_R - pos.distanceTo(planet)) / COLLISION_R,
      );
      // applyShellContact: position-only — a pilot's press parks; only the
      // shell's own advance walks the ship; the heading is never touched.
      resolveShellContactPark(
        pos.x, pos.y, pos.z, prev.x, prev.y, prev.z,
        planet.x, planet.y, planet.z, COLLISION_R, hit, dt, park,
      );
      pos.copy(park);
    }

    // The contract the whole file exists to pin: the ship's heading is
    // written once, above the loop, and nothing inside it may steer. Every
    // station pin below would be meaningless if the loop turned the ship
    // toward its escape; the resolver itself cannot, since it is handed no
    // heading and hands back a position.
    if (fwd.distanceTo(fwd0) !== 0) throw new Error('the loop steered the ship');

    if (run.contactAtS !== null) {
      bearing.copy(planet).sub(pos).normalize();
      const swing = Math.acos(clamp1(bearing.dot(bearing0))) * (180 / Math.PI);
      if (swing > run.bodySwingDeg) run.bodySwingDeg = swing;
    }
    if (run.escapeAtS === null && pos.distanceTo(planet) - COLLISION_R > COLLISION_R) {
      run.escapeAtS = t;
    }
    run.endS = t;
  }
  return run;
}

const clamp1 = (x: number) => Math.min(1, Math.max(-1, x));

describe('shell contacts: a pressing ship holds station, an unresisting one is walked off', () => {
  // Near-dead-center approach from one shell radius of clear sky; the 0.02
  // lean gives the walk a real tangential direction to continue.
  const start = () => new THREE.Vector3(COLLISION_R * 2, 0, 0);
  const inbound = () => new THREE.Vector3(-1, 0.02, 0);

  it('pressing a stationary shell with the dial up: parked, stable, no creep-off', () => {
    const run = runContact(start(), inbound(), new THREE.Vector3());
    expect(run.contactAtS).not.toBeNull();
    expect(run.contactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    expect(run.escapeAtS).toBeNull(); // the park IS the outcome
    // The park holds the surface: penetration never grows past a frame's step.
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
  });

  it('dial at zero on a stationary planet: parked at the shell IS the outcome', () => {
    const run = runContact(start(), inbound(), new THREE.Vector3(), 10, 1 / 60, 0);
    expect(run.escapeAtS).toBeNull();
  });

  it('chasing the TRAILING face: the receding shell is reachable, then ridden as station', () => {
    // Pre-credit-fix the ship tailgated ~30 km/s short forever and never
    // touched the shell at all — reaching it is the half this pins.
    const vel = new THREE.Vector3(-EARTH_V_AU_S, 0, 0);
    const run = runContact(start(), inbound(), vel);
    expect(run.contactAtS).not.toBeNull();
    expect(run.contactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
  });

  it('PRESSING the LEADING face at 1× — station, and Earth stays where it was flown to', () => {
    // The case a pilot actually flies: nose on the planet, dial up, into the
    // face that is coming at them. Holding the stick is how a pilot parks at
    // a body, so the shell just stops the ship. The body's own passage
    // creeps its bearing by a degree or so a minute — the world moving, not
    // the app steering — and it never leaves the view.
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(start(), inbound(), vel);
    expect(run.contactAtS).not.toBeNull();
    expect(run.contactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    expect(run.escapeAtS).toBeNull(); // the park IS the outcome
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    // Still held when the clock ran out: nothing walked the ship off.
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
    // ...and the planet is still framed where the pilot put it.
    expect(run.bodySwingDeg).toBeLessThan(3);
  });

  it('the same face with the dial at ZERO — an unresisting hull is walked off', () => {
    // The twin of the pin above, and the one difference is the dial: with no
    // thrust into the shell nothing holds this hull against the advancing
    // face, so the advance walks it around the limb and lets go.
    // Start just off the shell: a drifting ship does not close distance
    // itself, so the interesting clock starts when the advancing face
    // arrives, not after a 3,000-second coast.
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(
      new THREE.Vector3(COLLISION_R * 1.01, 0, 0), inbound(), vel, 120, 1 / 60, 0,
    );
    // A drifting ship cannot fly itself a radius of clear sky — rescue is
    // the advancing shell walking it off and letting go for good.
    expect(run.contactAtS).not.toBeNull();
    expect(run.lastContactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    // Walked right around the limb, which is what "let go" looks like from
    // the cockpit: the planet swings across the view and away.
    expect(run.bodySwingDeg).toBeGreaterThan(45);
  });

  it('pressing the LEADING face at 10× time warp — held to the surface, never trapped', () => {
    // At warp the face crosses at hundreds of km/s against a press governed
    // to 2 km/s, so the park cannot hold one point of a shell going by that
    // fast: re-projecting onto the moving shell rounds the ship along it and
    // eventually releases it. Nothing walks it — this is the body's own
    // passage — and the pins are that the surface holds and the shell is
    // never a trap.
    const vel = new THREE.Vector3(EARTH_V_AU_S * 10, 0, 0);
    const run = runContact(start(), inbound(), vel, 180);
    expect(run.contactAtS).not.toBeNull();
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.lastContactAtS!).toBeLessThan(150);
    expect(run.escapeAtS).not.toBeNull();
  });

  it('bumped on the SIDE face (planet motion across the contact normal): stable pursuit station', () => {
    // The face the ship rides is neither advancing nor receding along its
    // normal, so nothing walks the ship and nothing pins it — it chases the
    // shearing shell as a station. The pin is stability, not escape.
    const vel = new THREE.Vector3(0, 0, EARTH_V_AU_S);
    const run = runContact(start(), inbound(), vel);
    expect(run.contactAtS).not.toBeNull();
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
  });

  it('parked ON the shell nose near-tangent, leading face closing at 1×', () => {
    // A nose 3° inside tangent still counts as pressing, so nothing walks
    // this ship — it leaves on its own thrust, sliding along the shell until
    // the sightline opens and the governor lets the dial through. The pilot
    // steering off is always available; that is the whole reason a press is
    // allowed to park.
    const run = runContact(
      new THREE.Vector3(COLLISION_R, 0, 0),
      new THREE.Vector3(-0.05, 1, 0),
      new THREE.Vector3(EARTH_V_AU_S, 0, 0),
    );
    expect(run.lastContactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    expect(run.escapeAtS).not.toBeNull();
  });
});

describe('with the ride frame on: a body never advances into a hull that is not pressing it', () => {
  const start = () => new THREE.Vector3(COLLISION_R * 2, 0, 0);
  const inbound = () => new THREE.Vector3(-1, 0.02, 0);
  const ride = { rideWeight: 1 };

  it('the LEADING face with the dial at ZERO — the hull rides along: no walk, the planet stays put', () => {
    // The twin of the world-frame walk-off above. Riding the planet, the
    // face never reaches this hull: it sits a hair off the shell with the
    // planet framed exactly where it was, for as long as the clock runs.
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(
      new THREE.Vector3(COLLISION_R * 1.01, 0, 0), inbound(), vel, 120, 1 / 60, 0, ride,
    );
    expect(run.contactAtS).toBeNull();
    expect(run.escapeAtS).toBeNull();
  });

  it('PRESSING the LEADING face at 1× — station, exactly as without the ride', () => {
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(start(), inbound(), vel, 120, 1 / 60, COMMANDED, ride);
    expect(run.contactAtS).not.toBeNull();
    expect(run.escapeAtS).toBeNull();
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
    expect(run.bodySwingDeg).toBeLessThan(0.5);
  });

  it('pressing the LEADING face at 10× time warp — station now, not a release; leaving is the pilot\'s own', () => {
    // Without the ride the passage at warp rounds the ship off the shell.
    // Riding the planet there is no passage: the press parks and holds.
    const vel = new THREE.Vector3(EARTH_V_AU_S * 10, 0, 0);
    const run = runContact(start(), inbound(), vel, 180, 1 / 60, COMMANDED, ride);
    expect(run.contactAtS).not.toBeNull();
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.escapeAtS).toBeNull();
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
    // The 0.02 lean of the press slides the parked ship along the shell on
    // its OWN thrust — under a degree over three minutes, and none of it the
    // planet's passage, which the ride has taken out entirely.
    expect(run.bodySwingDeg).toBeLessThan(1);
    // Pulling back is the way out — the departure law, from the parked spot.
    const away = runContact(
      new THREE.Vector3(COLLISION_R, 0, 0), new THREE.Vector3(1, 0, 0), vel, 120, 1 / 60, COMMANDED, ride,
    );
    expect(away.escapeAtS).not.toBeNull();
    expect(away.escapeAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
  });

  it('a rate change mid-station (1× → 60×) neither walks the ship nor breaks the surface', () => {
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(
      start(), inbound(), vel, 120, 1 / 60, COMMANDED, { rideWeight: 1, rateChangeAtS: 40, rateFactor: 60 },
    );
    expect(run.contactAtS).not.toBeNull();
    expect(run.contactAtS!).toBeLessThan(40);
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.escapeAtS).toBeNull();
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
    expect(run.bodySwingDeg).toBeLessThan(0.5);
  });

  it('in the fade band (half weight) the residual credit and the half ride together still hold station', () => {
    // Half the planet's motion is ridden and the credit sees the other half:
    // together they are the world-frame allowance, so a press still parks.
    const vel = new THREE.Vector3(EARTH_V_AU_S, 0, 0);
    const run = runContact(start(), inbound(), vel, 120, 1 / 60, COMMANDED, { rideWeight: 0.5 });
    expect(run.contactAtS).not.toBeNull();
    expect(run.escapeAtS).toBeNull();
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
    expect(run.bodySwingDeg).toBeLessThan(3);
  });

  it('the TRAILING face is still reachable, and then a station', () => {
    const vel = new THREE.Vector3(-EARTH_V_AU_S, 0, 0);
    const run = runContact(start(), inbound(), vel, 120, 1 / 60, COMMANDED, ride);
    expect(run.contactAtS).not.toBeNull();
    expect(run.contactAtS!).toBeLessThan(ESCAPE_DEADLINE_S);
    expect(run.maxPenetrationFrac).toBeLessThan(0.01);
    expect(run.lastContactAtS!).toBeGreaterThan(run.endS - 1);
  });
});
