import { describe, expect, it } from 'vitest';
import {
  RIDE_MOON_FULL_RADII,
  RIDE_MOON_MIN_OFF_FACTOR,
  RIDE_MOON_OFF_RADII,
  RIDE_PLANET_OFF_FACTOR,
  RIDE_WEIGHT_TAU_S,
  RideFrame,
  bandWeight,
  easeWeight,
  moonRideOffAU,
  moonRideWeight,
  planetRideWeight,
  relativeBodyVelocity,
} from './rideFrame';

const KM_PER_AU = 149597870.7;
const km = (v: number) => v / KM_PER_AU;
const v3 = () => ({ x: 0, y: 0, z: 0 });

describe('the ride bands', () => {
  it('a planet rides fully inside its system reach and not at all past the off factor', () => {
    const reach = km(468_000);
    expect(planetRideWeight(0, reach)).toBe(1);
    expect(planetRideWeight(reach, reach)).toBe(1);
    expect(planetRideWeight(reach * RIDE_PLANET_OFF_FACTOR, reach)).toBe(0);
    expect(planetRideWeight(reach * 3, reach)).toBe(0);
    const mid = planetRideWeight(reach * (1 + RIDE_PLANET_OFF_FACTOR) / 2, reach);
    expect(mid).toBeCloseTo(0.5, 6);
  });

  it('the fade is monotone and continuous across both edges', () => {
    const reach = 1;
    let prev = 1;
    for (let d = 0.5; d <= 2; d += 0.01) {
      const w = planetRideWeight(d, reach);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(planetRideWeight(1 + 1e-9, reach)).toBeCloseTo(1, 6);
    expect(planetRideWeight(RIDE_PLANET_OFF_FACTOR - 1e-9, reach)).toBeCloseTo(0, 6);
  });

  it('a moon rides fully inside a few rendered radii and fades out over its band', () => {
    const r = km(1737);
    const orbit = km(384_400);
    const shell = km(6_400 + 41);
    expect(moonRideWeight(r * RIDE_MOON_FULL_RADII, r, orbit, shell)).toBe(1);
    expect(moonRideWeight(r * RIDE_MOON_OFF_RADII, r, orbit, shell)).toBe(0);
    expect(moonRideWeight(r * 10, r, orbit, shell)).toBeGreaterThan(0);
    expect(moonRideWeight(r * 10, r, orbit, shell)).toBeLessThan(1);
  });

  it("a moon's band is capped at half the gap to its parent's shell — Charon's cannot reach Pluto", () => {
    const charon = km(606);
    const orbit = km(19_600);
    const plutoShell = km(1188 + 41);
    const off = moonRideOffAU(charon, orbit, plutoShell);
    expect(off).toBeLessThanOrEqual(0.5 * (orbit - plutoShell) + 1e-15);
    expect(off).toBeLessThanOrEqual(charon * RIDE_MOON_OFF_RADII);
    // A moonlet hugging its planet still keeps a fade of some width.
    const tight = moonRideOffAU(km(100), km(1_000), km(800));
    expect(tight).toBeCloseTo(km(100) * RIDE_MOON_FULL_RADII * RIDE_MOON_MIN_OFF_FACTOR, 12);
  });

  it('bandWeight handles a degenerate band without dividing by zero', () => {
    expect(bandWeight(0.5, 1, 1)).toBe(1);
    expect(bandWeight(1.5, 1, 1)).toBe(0);
  });
});

describe('the weight ease', () => {
  it('is frame-rate invariant', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = easeWeight(a, 1, 1 / 60);
    const b = easeWeight(0, 1, 1);
    expect(a).toBeCloseTo(b, 9);
    expect(b).toBeCloseTo(1 - Math.exp(-1 / RIDE_WEIGHT_TAU_S), 12);
  });

  it('holds still on a zero step and settles on the target', () => {
    expect(easeWeight(0.3, 1, 0)).toBe(0.3);
    let w = 0;
    for (let i = 0; i < 600; i++) w = easeWeight(w, 1, 1 / 60);
    expect(w).toBeCloseTo(1, 4);
  });
});

/** A frame of the ride against a set of bodies at their current positions. */
function frame(
  ride: RideFrame,
  ship: { x: number; y: number; z: number },
  prev: { x: number; y: number; z: number },
  dtS: number,
  bodies: { key: string; kind: 'planet' | 'moon'; pos: { x: number; y: number; z: number }; band: [number, number]; radius: number }[],
) {
  ride.beginFrame(ship.x, ship.y, ship.z, prev.x, prev.y, prev.z, dtS);
  for (const b of bodies) ride.consider(b.key, b.kind, b.pos.x, b.pos.y, b.pos.z, b.band[0], b.band[1], b.radius);
  const out = ride.finish(v3());
  ship.x += out.x; ship.y += out.y; ship.z += out.z;
  ride.endFrame(ship.x, ship.y, ship.z);
  return out;
}

/** A band the ship is always inside / always outside. */
const always: [number, number] = [Infinity, Infinity];
const never: [number, number] = [-1, -1];
const DT = 1 / 60;
const EARTH_STEP = km(29.8) * DT;

describe('RideFrame', () => {
  it('seeds on the first frame and then rides a fully weighted body step for step', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    let out = frame(ride, ship, { ...ship }, DT, [{ key: 'Earth', kind: 'planet', pos: earth, band: always, radius: km(6371) }]);
    expect(out).toEqual({ x: 0, y: 0, z: 0 }); // the first frame rebases: anchors set, nothing applied
    for (let i = 0; i < 5; i++) {
      earth.y += EARTH_STEP;
      out = frame(ride, ship, { ...ship }, DT, [{ key: 'Earth', kind: 'planet', pos: earth, band: always, radius: km(6371) }]);
      expect(out.y).toBeCloseTo(EARTH_STEP, 15);
      expect(out.x).toBe(0);
    }
    expect(ride.weight).toBe(1);
    expect(ride.velocity(v3()).y).toBeCloseTo(km(29.8), 9);
    expect(ship.y).toBeCloseTo(5 * EARTH_STEP, 15);
  });

  it('rides the whole of a clock jump: the anchor remembers where the body was, however far it moved since', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const body = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, body());
    earth.x += 0.1; // an event jump moved Earth a tenth of an AU between frames
    const out = frame(ride, ship, { ...ship }, DT, body());
    expect(out.x).toBeCloseTo(0.1, 15);
    expect(ship.x).toBeCloseTo(1.1, 15);
  });

  it('weights read the anchor datum, so a step larger than the band still rides', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const reach = km(468_000);
    const body = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: [reach, reach * RIDE_PLANET_OFF_FACTOR] as [number, number], radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, body());
    earth.x += reach * 10; // a warp frame: Earth left the band entirely within one step
    const out = frame(ride, ship, { ...ship }, DT, body());
    expect(out.x).toBeCloseTo(reach * 10, 12);
    expect(ride.weightOf('Earth')).toBe(1);
  });

  it('rebases on a repose: nothing applied that frame, weights seeded, and the next frame rides normally', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const body = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, body());
    earth.y += EARTH_STEP;
    frame(ride, ship, { ...ship }, DT, body());
    // A jump pose moves the ship between frames: prev no longer matches where the last frame left it.
    ship.x = 2; ship.y = 0.5; ship.z = 0;
    earth.y += EARTH_STEP;
    let out = frame(ride, ship, { ...ship }, DT, body());
    expect(ride.rebasing).toBe(true);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(ride.velocity(v3())).toEqual({ x: 0, y: 0, z: 0 });
    expect(ride.weightOf('Earth')).toBe(1); // seeded, not eased from zero
    earth.y += EARTH_STEP;
    out = frame(ride, ship, { ...ship }, DT, body());
    expect(ride.rebasing).toBe(false);
    expect(out.y).toBeCloseTo(EARTH_STEP, 15);
  });

  it('a body entering the frame mid-flight eases in from zero — a new carrier never yanks', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const moonlet = { x: 1, y: 0, z: km(-5_000) };
    const earthOnly = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, earthOnly());
    earth.y += EARTH_STEP;
    frame(ride, ship, { ...ship }, DT, earthOnly());
    // A moonlet crossing at 30 km/s relative shows up for one frame at full target weight.
    earth.y += EARTH_STEP; moonlet.y = earth.y; moonlet.x += km(30) * DT;
    const both = () => [...earthOnly(), { key: 'Metis', kind: 'moon' as const, pos: moonlet, band: always, radius: km(40) }];
    let out = frame(ride, ship, { ...ship }, DT, both());
    expect(ride.weightOf('Metis')).toBe(0); // fresh: starts at zero
    expect(out.x).toBe(0);
    earth.y += EARTH_STEP; moonlet.y = earth.y; moonlet.x += km(30) * DT;
    out = frame(ride, ship, { ...ship }, DT, both());
    const w1 = easeWeight(0, 1, DT);
    expect(ride.weightOf('Metis')).toBeCloseTo(w1, 12);
    expect(out.x).toBeCloseTo(w1 * km(30) * DT, 15); // a nudge of a few metres, not a 30 km/s yank
  });

  it('ordered dominance: a fully ridden moon takes all, its planet none — the ride is the moon\'s full world step', () => {
    const ride = new RideFrame();
    const ship = { x: 5, y: 0, z: 0 };
    const jupiter = { x: 5, y: 0, z: km(-500_000) };
    const io = { x: 5, y: 0, z: km(-3_000) };
    const J = km(13) * DT, O = km(17) * DT;
    const bodies = () => [
      { key: 'Jupiter', kind: 'planet' as const, pos: jupiter, band: always, radius: km(71_492) },
      { key: 'Io', kind: 'moon' as const, pos: io, band: always, radius: km(1_821) },
    ];
    frame(ride, ship, { ...ship }, DT, bodies());
    jupiter.y += J; io.y += J; io.x += O;
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out.y).toBeCloseTo(J, 15);
    expect(out.x).toBeCloseTo(O, 15);
  });

  it('half a moon weight adds half its orbital step on top of the planet\'s full step', () => {
    const ride = new RideFrame();
    const ship = { x: 5, y: 0, z: 0 };
    const jupiter = { x: 5, y: 0, z: km(-500_000) };
    const io = { x: 5, y: 0, z: km(-30_000) };
    const J = km(13) * DT, O = km(17) * DT;
    const bodies = () => [
      { key: 'Jupiter', kind: 'planet' as const, pos: jupiter, band: always, radius: km(71_492) },
      { key: 'Io', kind: 'moon' as const, pos: io, band: [0, 2 * km(30_000)] as [number, number], radius: km(1_821) },
    ];
    frame(ride, ship, { ...ship }, DT, bodies()); // seeds Io at 0.5
    jupiter.y += J; io.y += J; io.x += O;
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out.y).toBeCloseTo(J, 15);       // 0.5·(J) from Io + 0.5·J from Jupiter
    expect(out.x).toBeCloseTo(0.5 * O, 15); // only the moon carries the orbital part
  });

  it('a moon carries its parent\'s motion even when the parent itself has no weight', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-384_400) };
    const moon = { x: 1, y: 0, z: km(-3_000) };
    const E = km(29.8) * DT, M = km(1) * DT;
    const bodies = () => [
      { key: 'Earth', kind: 'planet' as const, pos: earth, band: never, radius: km(6371) },
      { key: 'Moon', kind: 'moon' as const, pos: moon, band: always, radius: km(1737) },
    ];
    frame(ride, ship, { ...ship }, DT, bodies());
    earth.y += E; moon.y += E; moon.x += M;
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out.y).toBeCloseTo(E, 15);
    expect(out.x).toBeCloseTo(M, 15);
  });

  it('two co-orbitals both at full weight: the nearer takes all, the other is not counted', () => {
    const ride = new RideFrame();
    const ship = { x: 9, y: 0, z: 0 };
    const janus = { x: 9, y: 0, z: km(-1_000) };
    const epimetheus = { x: 9, y: km(50), z: km(-1_000) };
    const A = km(16) * DT;
    const bodies = () => [
      { key: 'Janus', kind: 'moon' as const, pos: janus, band: always, radius: km(90) },
      { key: 'Epimetheus', kind: 'moon' as const, pos: epimetheus, band: always, radius: km(58) },
    ];
    frame(ride, ship, { ...ship }, DT, bodies());
    janus.y += A; epimetheus.y += A * 1.5; // they never really differ; make the double count visible
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out.y).toBeCloseTo(A, 15); // Janus's step alone, not 2.5·A and not a diluted half
  });

  it('a body the ship has left reads exactly zero after a few time constants, not a forever-residual', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const reach = km(468_000);
    const band = [reach, reach * RIDE_PLANET_OFF_FACTOR] as [number, number];
    const bodies = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, bodies());
    expect(ride.weight).toBe(1);
    // A burn is the ship's OWN step: the frame's pre-thrust position is where
    // the last frame left it, so nothing rebases and the weight must decay.
    const prev = { ...ship };
    ship.x += reach * 3;
    frame(ride, ship, prev, DT, bodies());
    expect(ride.rebasing).toBe(false);
    for (let i = 0; i < 30; i++) frame(ride, ship, { ...ship }, DT, bodies());
    expect(ride.weight).toBeGreaterThan(0); // still easing out half a second later
    for (let i = 0; i < 60 * 6; i++) frame(ride, ship, { ...ship }, DT, bodies());
    expect(ride.weight).toBe(0);
    expect(ride.weightOf('Earth')).toBe(0);
  });

  it('a clock seam rides the whole displacement but reports no velocity for that frame', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const body = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, body());
    earth.x += 0.05; // an event jump between frames
    ride.beginFrame(ship.x, ship.y, ship.z, ship.x, ship.y, ship.z, DT, false);
    for (const b of body()) ride.consider(b.key, b.kind, b.pos.x, b.pos.y, b.pos.z, b.band[0], b.band[1], b.radius);
    const out = ride.finish(v3());
    expect(out.x).toBeCloseTo(0.05, 15);
    expect(ride.velocity(v3())).toEqual({ x: 0, y: 0, z: 0 });
    ship.x += out.x; ride.endFrame(ship.x, ship.y, ship.z);
    earth.x += EARTH_STEP;
    frame(ride, ship, { ...ship }, DT, body());
    expect(ride.velocity(v3()).x).toBeCloseTo(km(29.8), 9);
  });

  it('deep space rides nothing, and a body no longer offered is forgotten', () => {
    const ride = new RideFrame();
    const ship = { x: 3, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: 0 };
    const bodies = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: never, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, bodies());
    earth.y += EARTH_STEP;
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(ride.weight).toBe(0);
    frame(ride, ship, { ...ship }, DT, []);
    expect(ride.weightOf('Earth')).toBe(0);
    expect(ride.carriersSnapshot()).toEqual([]);
  });

  it('disabled (?ride=0) holds every weight at zero while the anchors keep tracking', () => {
    const ride = new RideFrame();
    ride.enabled = false;
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const bodies = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, bodies());
    earth.y += EARTH_STEP;
    let out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(ride.velocity(v3())).toEqual({ x: 0, y: 0, z: 0 });
    ride.enabled = true;
    earth.y += EARTH_STEP;
    out = frame(ride, ship, { ...ship }, DT, bodies());
    // Re-enabled mid-flight: the weight eases in from zero rather than yanking.
    expect(out.y).toBeCloseTo(easeWeight(0, 1, DT) * EARTH_STEP, 15);
  });

  it('reset forgets the carriers and the next frame rebases', () => {
    const ride = new RideFrame();
    const ship = { x: 1, y: 0, z: 0 };
    const earth = { x: 1, y: 0, z: km(-10_000) };
    const bodies = () => [{ key: 'Earth', kind: 'planet' as const, pos: earth, band: always, radius: km(6371) }];
    frame(ride, ship, { ...ship }, DT, bodies());
    ride.reset();
    earth.y += 1;
    const out = frame(ride, ship, { ...ship }, DT, bodies());
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(ride.weightOf('Earth')).toBe(1);
  });
});

describe('relativeBodyVelocity', () => {
  it('a ridden body credits nothing, an unridden one credits in full', () => {
    const rideVel = { x: 0, y: km(29.8), z: 0 };
    const ridden = relativeBodyVelocity(0, km(29.8), 0, rideVel, v3());
    expect(ridden.y).toBeCloseTo(0, 15);
    const other = relativeBodyVelocity(km(5), km(29.8), km(1), rideVel, v3());
    expect(other).toEqual({ x: km(5), y: 0, z: km(1) });
    const none = relativeBodyVelocity(km(5), km(29.8), km(1), { x: 0, y: 0, z: 0 }, v3());
    expect(none).toEqual({ x: km(5), y: km(29.8), z: km(1) });
  });
});
