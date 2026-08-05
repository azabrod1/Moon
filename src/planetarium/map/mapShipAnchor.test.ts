/**
 * The ship's chart transform: the extended policy, the two weights, and the one
 * map both the marker and the heading probe are charted through.
 *
 * The properties here ARE the contract. Continuity is asserted across both
 * edges the transform has (the reveal shell and the envelope), because a marker
 * that jumps is exactly the failure the weights exist to prevent; degeneracy is
 * asserted against the chart's own moon arithmetic, written out, because "the
 * ship stands where the moon is drawn" is the whole point of the item.
 */
import { describe, it, expect } from 'vitest';
import {
  chartShipPoint,
  shipAnchorWeight,
  shipChartedR,
  shipEnvelopeWeight,
  shipHeadingProbeStepAU,
  shipOffsetR,
  shipViewWeight,
  MAP_SHIP_ENVELOPE_FADE_FRAC,
  type ShipAnchorFrame,
  type ShipAnchorSystem,
} from './mapShipAnchor';
import {
  mapMoonOffsetR,
  moonOffsetEntries,
  moonOffsetPolicyFor,
  type MoonOffsetPolicy,
} from './mapMoonOffset';
import { defaultMapCurve, projectMapPoint, type MapVec3 } from './mapProjection';
import { PLANETARIUM_BODIES } from '../planets/planetData';

const CURVE = defaultMapCurve();
const SYSTEMS = PLANETARIUM_BODIES.filter((p) => moonOffsetEntries(p.name).length > 0);

const radiusAUOf = (name: string): number =>
  PLANETARIUM_BODIES.find((p) => p.name === name)!.radiusAU;

/** The innermost periapsis of a system, in parent true radii — where the
 *  extension meets the policy. */
function innermostPeriX(parentPlanet: string): number {
  let x0 = Infinity;
  for (const e of moonOffsetEntries(parentPlanet)) x0 = Math.min(x0, e.periX);
  return x0;
}

/** The chart's own moon arithmetic, written out: what SystemMap places a moon
 *  at, in parent drawn radii, at a given blend. */
function moonChartedR(policy: MoonOffsetPolicy, x: number, blend: number): number {
  return blend >= 1 ? x : mapMoonOffsetR(policy, x) * (1 - blend) + x * blend;
}

/** A system frame for Jupiter, with the knobs the tests vary handed in. */
function jupiterSystem(over: Partial<ShipAnchorSystem> = {}): ShipAnchorSystem {
  const parentRadiusAU = radiusAUOf('Jupiter');
  const helio = { x: 5.2, y: 0.31, z: -1.4 };
  const map = projectMapPoint(helio.x, helio.y, helio.z, 0, CURVE, { x: 0, y: 0, z: 0 });
  let maxApoX = 0;
  for (const e of moonOffsetEntries('Jupiter')) maxApoX = Math.max(maxApoX, e.apoX);
  return {
    policy: moonOffsetPolicyFor('Jupiter'),
    parentRadiusAU,
    parentHelioX: helio.x,
    parentHelioY: helio.y,
    parentHelioZ: helio.z,
    parentMapX: map.x,
    parentMapY: map.y,
    parentMapZ: map.z,
    // The parent floored to a legible marker: the amplification the moons are
    // drawn with, and the reason a plain-charted ship reads in the wrong place.
    scaleBlendedAU: parentRadiusAU * 40,
    maxApoX,
    viewWeight: 1,
    ...over,
  };
}

function frameOf(system: ShipAnchorSystem | null, blend = 0): ShipAnchorFrame {
  return { blend, curve: CURVE, system };
}

/** A heliocentric point `x` parent radii from the system's parent, along a unit
 *  direction. */
function pointAtX(system: ShipAnchorSystem, x: number, dir: MapVec3): MapVec3 {
  const d = x * system.parentRadiusAU;
  return {
    x: system.parentHelioX + dir.x * d,
    y: system.parentHelioY + dir.y * d,
    z: system.parentHelioZ + dir.z * d,
  };
}

const unit = (x: number, y: number, z: number): MapVec3 => {
  const n = Math.hypot(x, y, z);
  return { x: x / n, y: y / n, z: z / n };
};

const chart = (p: MapVec3, frame: ShipAnchorFrame): MapVec3 =>
  chartShipPoint(p.x, p.y, p.z, frame, { x: 0, y: 0, z: 0 });

const dist = (a: MapVec3, b: MapVec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('shipOffsetR — the policy extended to the parent centre', () => {
  it('the policy it extends really does start off the centre', () => {
    // The premise of the extension: a squeezed system lifts its packed inner
    // family clear of the globe, so the policy's value at the parent's own
    // centre is a positive radius. Used raw for the ship, that intercept is a
    // permanent displacement.
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      if (!policy.squeezed) continue;
      expect(mapMoonOffsetR(policy, 0)).toBeGreaterThan(0);
    }
  });

  it('is exactly zero at the parent centre, in every system', () => {
    for (const planet of SYSTEMS) {
      expect(shipOffsetR(moonOffsetPolicyFor(planet.name), 0)).toBe(0);
    }
  });

  it('joins the policy exactly at the innermost periapsis, and follows it above', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const x0 = innermostPeriX(planet.name);
      const join = mapMoonOffsetR(policy, x0);
      expect(shipOffsetR(policy, x0)).toBeCloseTo(join, 12);
      // Continuous ACROSS the join, not merely equal at it.
      const below = shipOffsetR(policy, x0 * (1 - 1e-9));
      expect(Math.abs(below - join)).toBeLessThan(join * 1e-7);
      for (const x of [x0 * 1.0001, x0 * 2, x0 * 10, x0 * 100]) {
        expect(shipOffsetR(policy, x)).toBe(mapMoonOffsetR(policy, x));
      }
    }
  });

  it('increases strictly from the centre out, through the join', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const x0 = innermostPeriX(planet.name);
      let prev = -Infinity;
      for (let i = 0; i <= 400; i++) {
        const x = (i / 200) * x0; // across the join and well past it
        const r = shipOffsetR(policy, x);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThan(prev);
        prev = r;
      }
    }
  });

  it('reads a negative distance as the centre', () => {
    const policy = moonOffsetPolicyFor('Jupiter');
    expect(shipOffsetR(policy, -3)).toBe(0);
  });
});

describe('shipChartedR — the moons own blend rule', () => {
  const policy = moonOffsetPolicyFor('Jupiter');
  const x = moonOffsetEntries('Jupiter').find((e) => e.name === 'Io')!.meanX;

  it('is the extended policy fully compressed', () => {
    expect(shipChartedR(policy, x, 0)).toBe(shipOffsetR(policy, x));
  });

  it('is the true distance at true scale', () => {
    expect(shipChartedR(policy, x, 1)).toBe(x);
  });

  it('matches the chart moon arithmetic at every blend, above the knee', () => {
    for (const blend of [0, 0.25, 0.5, 0.75, 1]) {
      expect(shipChartedR(policy, x, blend)).toBeCloseTo(moonChartedR(policy, x, blend), 12);
    }
  });
});

describe('shipEnvelopeWeight', () => {
  const maxApoX = 300;

  it('is all of it inside the system, and none of it past the fade', () => {
    expect(shipEnvelopeWeight(0, maxApoX)).toBe(1);
    expect(shipEnvelopeWeight(maxApoX, maxApoX)).toBe(1);
    expect(shipEnvelopeWeight(maxApoX * (1 + MAP_SHIP_ENVELOPE_FADE_FRAC), maxApoX)).toBe(0);
    expect(shipEnvelopeWeight(maxApoX * 10, maxApoX)).toBe(0);
  });

  it('crosses the edge without a step, and never turns back', () => {
    const at = (x: number) => shipEnvelopeWeight(x, maxApoX);
    expect(at(maxApoX * (1 + 1e-9))).toBeCloseTo(1, 8);
    expect(at(maxApoX * (1 + MAP_SHIP_ENVELOPE_FADE_FRAC - 1e-9))).toBeCloseTo(0, 8);
    let prev = 1;
    for (let i = 0; i <= 200; i++) {
      const x = maxApoX * (1 + (i / 100) * MAP_SHIP_ENVELOPE_FADE_FRAC);
      const w = at(x);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      prev = w;
    }
  });

  it('answers nothing for a system with no envelope, and for a NaN distance', () => {
    expect(shipEnvelopeWeight(1, 0)).toBe(0);
    expect(shipEnvelopeWeight(Number.NaN, maxApoX)).toBe(0);
  });
});

describe('shipViewWeight', () => {
  const inner = 0.01;
  const reveal = 0.022;

  it('is none at the shell the moons appear at, and all of it inside', () => {
    expect(shipViewWeight(reveal, inner, reveal)).toBe(0);
    expect(shipViewWeight(reveal * 4, inner, reveal)).toBe(0);
    expect(shipViewWeight(inner, inner, reveal)).toBe(1);
    expect(shipViewWeight(inner / 10, inner, reveal)).toBe(1);
  });

  it('crosses both ends without a step, and never turns back', () => {
    expect(shipViewWeight(reveal * (1 - 1e-9), inner, reveal)).toBeCloseTo(0, 8);
    expect(shipViewWeight(inner * (1 + 1e-9), inner, reveal)).toBeCloseTo(1, 8);
    let prev = 1;
    for (let i = 0; i <= 200; i++) {
      const d = inner + ((reveal - inner) * i) / 200;
      const w = shipViewWeight(d, inner, reveal);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      prev = w;
    }
  });

  it('degenerates to the reveal itself when there is no room to ramp', () => {
    expect(shipViewWeight(0.5, 1, 1)).toBe(1);
    expect(shipViewWeight(2, 1, 1)).toBe(0);
    expect(shipViewWeight(0.5, 2, 1)).toBe(1);
  });

  it('answers nothing without a shell, or for a distance it cannot read', () => {
    expect(shipViewWeight(0.1, 0, 0)).toBe(0);
    expect(shipViewWeight(Number.NaN, inner, reveal)).toBe(0);
  });
});

describe('chartShipPoint', () => {
  const io = moonOffsetEntries('Jupiter').find((e) => e.name === 'Io')!;
  const dir = unit(0.3, 0.8, -0.5);

  it('is the plain chart point with no system at all — the corner chart', () => {
    const system = jupiterSystem();
    const p = pointAtX(system, io.meanX, dir);
    const plain = projectMapPoint(p.x, p.y, p.z, 0, CURVE, { x: 0, y: 0, z: 0 });
    expect(chart(p, frameOf(null))).toEqual(plain);
  });

  it('is the plain chart point at an unrevealed view', () => {
    const system = jupiterSystem({ viewWeight: 0 });
    const p = pointAtX(system, io.meanX, dir);
    const plain = projectMapPoint(p.x, p.y, p.z, 0, CURVE, { x: 0, y: 0, z: 0 });
    expect(chart(p, frameOf(system))).toEqual(plain);
  });

  it('is the plain chart point outside the system envelope', () => {
    const system = jupiterSystem();
    const p = pointAtX(system, system.maxApoX * 2, dir);
    const plain = projectMapPoint(p.x, p.y, p.z, 0, CURVE, { x: 0, y: 0, z: 0 });
    expect(chart(p, frameOf(system))).toEqual(plain);
  });

  it('lands a ship standing on a moon exactly where the chart draws that moon', () => {
    const system = jupiterSystem();
    for (const blend of [0, 0.4, 1]) {
      const frame = frameOf(system, blend);
      const p = pointAtX(system, io.meanX, dir);
      const got = chart(p, frame);
      // The chart's own moon placement: the parent's drawn position, plus the
      // moon's direction at the policy's charted distance in the group's units.
      const r = moonChartedR(system.policy, io.meanX, blend) * system.scaleBlendedAU;
      const want = {
        x: system.parentMapX + dir.x * r,
        y: system.parentMapY + dir.y * r,
        z: system.parentMapZ + dir.z * r,
      };
      // A metre and a half in AU: the residue is the offset's own round trip
      // through the parent's heliocentric position, not a difference of policy.
      expect(dist(got, want)).toBeLessThan(1e-11);
    }
  });

  it('puts a ship at the parent centre on the parent, not a radius off it', () => {
    const system = jupiterSystem();
    const p = {
      x: system.parentHelioX,
      y: system.parentHelioY,
      z: system.parentHelioZ,
    };
    const got = chart(p, frameOf(system));
    expect(dist(got, {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    })).toBeLessThan(1e-15);
    // The un-extended policy would have parked it a whole charted radius out.
    const intercept = mapMoonOffsetR(system.policy, 0) * system.scaleBlendedAU;
    expect(intercept).toBeGreaterThan(1e-4);
  });

  it('lifts the marker off the parent limb the plain chart pinned it to', () => {
    // The bug this transform exists for: the moons draw amplified while the
    // marker draws plain, so a ship on Io is charted onto Jupiter's limb.
    const system = jupiterSystem();
    const p = pointAtX(system, io.meanX, dir);
    const plain = projectMapPoint(p.x, p.y, p.z, 0, CURVE, { x: 0, y: 0, z: 0 });
    const charted = chart(p, frameOf(system));
    const parentMap = {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    };
    // Plain, the ship is within the parent's own true radius of its dot; the
    // charted point stands off it the way Io's marker does.
    expect(dist(plain, parentMap)).toBeLessThan(system.parentRadiusAU * io.meanX);
    expect(dist(charted, parentMap)).toBeGreaterThan(dist(plain, parentMap) * 10);
  });

  it('crosses the reveal shell without moving the marker', () => {
    const p = pointAtX(jupiterSystem(), io.meanX, dir);
    let prev: MapVec3 | null = null;
    let maxStep = 0;
    for (let i = 0; i <= 100; i++) {
      const system = jupiterSystem({ viewWeight: i / 100 });
      const got = chart(p, frameOf(system));
      if (prev) maxStep = Math.max(maxStep, dist(got, prev));
      prev = got;
    }
    // A hundred steps across the whole ramp, and the largest of them is a
    // hundredth of the span: the marker slides, it never jumps.
    const span = dist(
      chart(p, frameOf(jupiterSystem({ viewWeight: 0 }))),
      chart(p, frameOf(jupiterSystem({ viewWeight: 1 }))),
    );
    expect(span).toBeGreaterThan(0);
    expect(maxStep).toBeLessThan(span * 0.03);
  });

  it('crosses the envelope edge without moving the marker', () => {
    const system = jupiterSystem();
    const edge = system.maxApoX;
    const frame = frameOf(system);
    let prev: MapVec3 | null = null;
    let maxStep = 0;
    let first: MapVec3 | null = null;
    let last: MapVec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= 400; i++) {
      const x = edge * (0.9 + (i / 400) * (0.2 + MAP_SHIP_ENVELOPE_FADE_FRAC));
      const got = chart(pointAtX(system, x, dir), frame);
      if (prev) maxStep = Math.max(maxStep, dist(got, prev));
      if (!first) first = got;
      last = got;
      prev = got;
    }
    // The whole sweep travels a long way (the ship really is crossing the
    // system's edge); no single step of it is a jump.
    expect(maxStep).toBeLessThan(dist(first!, last) * 0.05);
  });

  it("holds the heading probe in the marker's own space", () => {
    // The failure this pins: chart the marker through the system and the probe
    // through the plain compression, and the delta between them points at the
    // parent instead of along the course — the chevron would spin to face the
    // planet. Both endpoints go through one transform, so a small step along
    // the course stays a small step on the chart.
    const system = jupiterSystem();
    const frame = frameOf(system);
    const p = pointAtX(system, io.meanX, dir);
    const parentMap = {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    };
    const marker = chart(p, frame);
    const stand = dist(marker, parentMap);

    for (const forward of [dir, unit(-dir.y, dir.x, 0), unit(1, 0, 0)]) {
      const step = shipHeadingProbeStepAU(Math.hypot(p.x, p.y, p.z));
      const probe = chart(
        { x: p.x + forward.x * step, y: p.y + forward.y * step, z: p.z + forward.z * step },
        frame,
      );
      expect(dist(probe, marker)).toBeGreaterThan(0);
      expect(dist(probe, marker)).toBeLessThan(stand * 0.05);
    }
  });

  it('carries a radial course outward and a tangential course across', () => {
    const system = jupiterSystem();
    const frame = frameOf(system);
    const p = pointAtX(system, io.meanX, dir);
    const marker = chart(p, frame);
    const step = shipHeadingProbeStepAU(Math.hypot(p.x, p.y, p.z));
    const radial = dist(marker, {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    });

    const outward = chart(
      { x: p.x + dir.x * step, y: p.y + dir.y * step, z: p.z + dir.z * step },
      frame,
    );
    expect(dist(outward, {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    })).toBeGreaterThan(radial);

    const across = unit(-dir.y, dir.x, 0);
    const sideways = chart(
      { x: p.x + across.x * step, y: p.y + across.y * step, z: p.z + across.z * step },
      frame,
    );
    // A tangential course keeps the standoff: the charted radius is unchanged
    // to first order, so the marker slides around the parent rather than away.
    const sideRadial = dist(sideways, {
      x: system.parentMapX, y: system.parentMapY, z: system.parentMapZ,
    });
    expect(Math.abs(sideRadial - radial)).toBeLessThan(dist(sideways, marker) * 0.2);
  });

  it('probes a step short enough to stay inside one moon system', () => {
    // The step has to be straight-line short where the transform bends hardest,
    // which is inside a parent's own moon system: a step comparable to the
    // parent's radius would answer with a chord across the amplified space.
    const jupiterRadiusAU = radiusAUOf('Jupiter');
    expect(shipHeadingProbeStepAU(5.2)).toBeLessThan(jupiterRadiusAU * 0.05);
    // And long enough to be a real difference rather than rounding: many orders
    // of magnitude above the double precision of the position it is added to.
    expect(shipHeadingProbeStepAU(5.2)).toBeGreaterThan(5.2 * 1e-12);
    // Scale-proportional, with a floor so a ship at the Sun still has a course.
    expect(shipHeadingProbeStepAU(40)).toBeGreaterThan(shipHeadingProbeStepAU(0.4));
    expect(shipHeadingProbeStepAU(0)).toBeGreaterThan(0);
    expect(shipHeadingProbeStepAU(Number.NaN)).toBeGreaterThan(0);
  });

  it('weighs the two ramps together', () => {
    const system = jupiterSystem({ viewWeight: 0.5 });
    expect(shipAnchorWeight(system, 0)).toBeCloseTo(0.5, 12);
    expect(shipAnchorWeight(system, system.maxApoX * 10)).toBe(0);
    expect(shipAnchorWeight({ ...system, viewWeight: 0 }, 0)).toBe(0);
  });
});

describe('the probe step inside small systems', () => {
  function systemAt(name: string): ShipAnchorSystem {
    const body = PLANETARIUM_BODIES.find((p) => p.name === name)!;
    const helio = { x: body.semiMajorAxisAU, y: body.semiMajorAxisAU * 0.02, z: -body.semiMajorAxisAU * 0.25 };
    const map = projectMapPoint(helio.x, helio.y, helio.z, 0, CURVE, { x: 0, y: 0, z: 0 });
    let maxApoX = 0;
    for (const e of moonOffsetEntries(name)) maxApoX = Math.max(maxApoX, e.apoX);
    return {
      policy: moonOffsetPolicyFor(name),
      parentRadiusAU: body.radiusAU,
      parentHelioX: helio.x,
      parentHelioY: helio.y,
      parentHelioZ: helio.z,
      parentMapX: map.x,
      parentMapY: map.y,
      parentMapZ: map.z,
      scaleBlendedAU: body.radiusAU * 40,
      maxApoX,
      viewWeight: 1,
    };
  }

  /** Chart the marker and an outbound probe from `x` parent radii, and return
   *  the change in charted distance from the parent — the sign the chevron
   *  reads. */
  function outboundReading(name: string, x: number): number {
    const system = systemAt(name);
    const frame: ShipAnchorFrame = { blend: 0, curve: CURVE, system };
    // Radially outward along +x from the parent, in true space.
    const px = system.parentHelioX + system.parentRadiusAU * x;
    const py = system.parentHelioY;
    const pz = system.parentHelioZ;
    const shipR = Math.hypot(px, py, pz);
    const step = shipHeadingProbeStepAU(shipR, system.parentRadiusAU);
    const marker = chartShipPoint(px, py, pz, frame, { x: 0, y: 0, z: 0 });
    const md = Math.hypot(marker.x - system.parentMapX, marker.y - system.parentMapY, marker.z - system.parentMapZ);
    const probe = chartShipPoint(px + step, py, pz, frame, { x: 0, y: 0, z: 0 });
    const pd = Math.hypot(probe.x - system.parentMapX, probe.y - system.parentMapY, probe.z - system.parentMapZ);
    return pd - md;
  }

  it('keeps an outward course reading outward at Pluto, where the heliocentric yardstick fails', () => {
    // r·1e-6 at Pluto's distance is ~5 Pluto radii: an uncapped probe launched
    // from just inside the envelope lands in the fade, charts at a lesser
    // weight, and lands BEHIND the marker — a chevron flipped by π. The cap by
    // the parent's own radius is what this pins.
    const system = systemAt('Pluto');
    const inside = system.maxApoX * 0.975;
    const uncapped = shipHeadingProbeStepAU(39.5);
    expect(uncapped).toBeGreaterThan(system.parentRadiusAU); // the failure's premise
    expect(outboundReading('Pluto', inside)).toBeGreaterThan(0);
  });

  it('reads an outward course as outward just inside every system envelope', () => {
    for (const p of SYSTEMS) {
      expect(outboundReading(p.name, systemAtApo(p.name) * 0.975), p.name).toBeGreaterThan(0);
    }
  });

  function systemAtApo(name: string): number {
    let maxApoX = 0;
    for (const e of moonOffsetEntries(name)) maxApoX = Math.max(maxApoX, e.apoX);
    return maxApoX;
  }

  it('caps inside a system and keeps the heliocentric rule outside one', () => {
    const pluto = PLANETARIUM_BODIES.find((p) => p.name === 'Pluto')!;
    expect(shipHeadingProbeStepAU(39.5, pluto.radiusAU)).toBeLessThanOrEqual(pluto.radiusAU * 0.01);
    expect(shipHeadingProbeStepAU(39.5, null)).toBeCloseTo(39.5e-6, 12);
  });
});
