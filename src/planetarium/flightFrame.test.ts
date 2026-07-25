import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FLIGHT_PITCH_LIMIT_RAD,
  FLIGHT_UP_SCENE,
  eclipticHeadingPitchFromEquatorial,
  flightAnglesFromSceneDirection,
  flightDirectionFromAngles,
  shipOrientationFromFlight,
} from './flightFrame';
import { ECLIPTIC_NORTH_EQUATORIAL, eclipticToEquatorial } from '../astronomy/planetary';
import { OBLIQUITY_DEG, DEG } from '../astronomy/constants';

/** The pre-change forward formula: heading/pitch read as scene-equatorial
 *  angles. Saves written by that build hold these angles. */
function legacyForward(headingRad: number, pitchRad: number): THREE.Vector3 {
  const cosPitch = Math.cos(pitchRad);
  return new THREE.Vector3(
    Math.cos(headingRad) * cosPitch,
    Math.sin(pitchRad),
    Math.sin(headingRad) * cosPitch,
  ).normalize();
}

const HEADINGS = [0, 0.4, 1.1, Math.PI / 2, 2.3, Math.PI, -0.9, -2.7];

describe('the cruise flight horizon', () => {
  it('is the astronomy module\'s ecliptic north — one definition site, not a copy', () => {
    // A second inlined obliquity rotation is exactly the drift the frame
    // contract forbids: the flight frame must BE the astronomy vector.
    expect(FLIGHT_UP_SCENE).toBe(ECLIPTIC_NORTH_EQUATORIAL);
  });

  it('is a unit vector', () => {
    expect(FLIGHT_UP_SCENE.length()).toBeCloseTo(1, 12);
  });

  it('sits at the obliquity from celestial north, tilted toward +Z', () => {
    // RotX(+ε) carries the ecliptic pole to (0, cos ε, sin ε) — the J2000
    // equatorial position of the north ecliptic pole (RA 270°, Dec 90°−ε).
    const eps = OBLIQUITY_DEG * DEG;
    expect(FLIGHT_UP_SCENE.x).toBeCloseTo(0, 12);
    expect(FLIGHT_UP_SCENE.y).toBeCloseTo(Math.cos(eps), 12);
    expect(FLIGHT_UP_SCENE.z).toBeCloseTo(Math.sin(eps), 12);
    // And it is genuinely tilted — a horizon change that silently reverted to
    // world-up would otherwise pass every level-flight assertion.
    const tiltDeg = THREE.MathUtils.radToDeg(
      FLIGHT_UP_SCENE.angleTo(new THREE.Vector3(0, 1, 0)),
    );
    expect(tiltDeg).toBeCloseTo(OBLIQUITY_DEG, 9);
  });
});

describe('flightDirectionFromAngles', () => {
  it('carries the ecliptic basis into the scene with the right sign', () => {
    // A sign-bearing pin: heading 0 lies ON the obliquity rotation axis (+X)
    // and survives a flipped rotation unchanged, so pin a heading that does
    // not. Heading π/2 is the ecliptic frame's +Z, which the astronomy
    // transform carries to (0, −sin ε, cos ε).
    const quarter = flightDirectionFromAngles(Math.PI / 2, 0, new THREE.Vector3());
    const expected = eclipticToEquatorial(new THREE.Vector3(0, 0, 1));
    expect(quarter.x).toBeCloseTo(expected.x, 12);
    expect(quarter.y).toBeCloseTo(expected.y, 12);
    expect(quarter.z).toBeCloseTo(expected.z, 12);
    expect(quarter.y).toBeLessThan(0); // the sign a flipped obliquity would invert
  });

  it('turns the same way the scene does: forward(0) × forward(−π/2) = up', () => {
    const a = flightDirectionFromAngles(0, 0, new THREE.Vector3());
    const b = flightDirectionFromAngles(-Math.PI / 2, 0, new THREE.Vector3());
    const cross = new THREE.Vector3().crossVectors(a, b);
    expect(cross.x).toBeCloseTo(FLIGHT_UP_SCENE.x, 12);
    expect(cross.y).toBeCloseTo(FLIGHT_UP_SCENE.y, 12);
    expect(cross.z).toBeCloseTo(FLIGHT_UP_SCENE.z, 12);
  });

  it('flies level at pitch 0: every heading is perpendicular to the horizon', () => {
    // The whole point of the frame. At pitch 0 the ship never climbs or dips
    // relative to the system's plane, whatever direction it faces.
    for (const heading of HEADINGS) {
      const forward = flightDirectionFromAngles(heading, 0, new THREE.Vector3());
      expect(Math.abs(forward.dot(FLIGHT_UP_SCENE))).toBeLessThan(1e-12);
      expect(forward.length()).toBeCloseTo(1, 12);
    }
  });

  it('pitch is ecliptic latitude, not declination', () => {
    for (const pitch of [-1.2, -0.3, 0.15, 0.8, 1.5]) {
      const forward = flightDirectionFromAngles(1.1, pitch, new THREE.Vector3());
      expect(Math.asin(forward.dot(FLIGHT_UP_SCENE))).toBeCloseTo(pitch, 12);
    }
  });

  it('writes into the caller\'s vector when one is supplied', () => {
    const out = new THREE.Vector3();
    expect(flightDirectionFromAngles(0.5, 0.2, out)).toBe(out);
  });
});

describe('flightAnglesFromSceneDirection', () => {
  it('round-trips angles → direction → angles', () => {
    for (const heading of HEADINGS) {
      for (const pitch of [-1.4, -0.5, 0, 0.33, 1.2]) {
        const dir = flightDirectionFromAngles(heading, pitch, new THREE.Vector3());
        const back = flightAnglesFromSceneDirection(dir.x, dir.y, dir.z);
        expect(back.pitchRad).toBeCloseTo(pitch, 10);
        // Heading is only defined modulo 2π.
        const dh = Math.atan2(
          Math.sin(back.headingRad - heading),
          Math.cos(back.headingRad - heading),
        );
        expect(dh).toBeCloseTo(0, 10);
      }
    }
  });

  it('clamps to the steering pitch bound so no caller can park on the pole', () => {
    // Reachable through vertical collision pushback and the polar departure
    // radial: straight up. At the pole heading is undefined and the next yaw
    // input would swing the nose through a right angle.
    for (const sign of [1, -1]) {
      const up = flightAnglesFromSceneDirection(
        FLIGHT_UP_SCENE.x * sign,
        FLIGHT_UP_SCENE.y * sign,
        FLIGHT_UP_SCENE.z * sign,
      );
      expect(Math.abs(up.pitchRad)).toBeLessThanOrEqual(FLIGHT_PITCH_LIMIT_RAD);
      expect(Math.abs(up.pitchRad)).toBeCloseTo(FLIGHT_PITCH_LIMIT_RAD, 12);
    }
    // Scene-vertical (celestial north) is 23.4° off the flight pole, so it
    // does NOT clamp — the bound is about the flight basis, not world-Y.
    const worldUp = flightAnglesFromSceneDirection(0, 1, 0);
    expect(Math.abs(worldUp.pitchRad)).toBeLessThan(FLIGHT_PITCH_LIMIT_RAD);
  });

  it('is scale-invariant — callers pass raw world deltas of any magnitude', () => {
    // Deltas span metres-to-a-moon (1e-12 AU is ~150 m) up to interstellar
    // reach. Reading a direction from the raw components put the small end
    // under the pole guard's floor and returned a near-level pitch for a
    // steeply climbing aim.
    const ref = flightAnglesFromSceneDirection(0.3, -0.1, 0.9);
    for (const scale of [1e12, 1e6, 1e-6, 1e-12]) {
      const scaled = flightAnglesFromSceneDirection(0.3 * scale, -0.1 * scale, 0.9 * scale);
      expect(scaled.headingRad, `scale ${scale}`).toBeCloseTo(ref.headingRad, 10);
      expect(scaled.pitchRad, `scale ${scale}`).toBeCloseTo(ref.pitchRad, 10);
    }
  });

  it('returns level-ahead for a delta with no direction', () => {
    for (const d of [[0, 0, 0], [NaN, 1, 0], [Infinity, 0, 0]]) {
      const a = flightAnglesFromSceneDirection(d[0], d[1], d[2]);
      expect(Number.isFinite(a.headingRad)).toBe(true);
      expect(Number.isFinite(a.pitchRad)).toBe(true);
      expect(a.headingRad).toBe(0);
      expect(a.pitchRad).toBe(0);
    }
  });
});

describe('eclipticHeadingPitchFromEquatorial (legacy-save conversion)', () => {
  it('preserves the world direction the ship was pointing', () => {
    for (const heading of HEADINGS) {
      for (const pitch of [-1.0, -0.2, 0, 0.6, 1.3]) {
        const before = legacyForward(heading, pitch);
        const converted = eclipticHeadingPitchFromEquatorial(heading, pitch);
        const after = flightDirectionFromAngles(
          converted.headingRad,
          converted.pitchRad,
          new THREE.Vector3(),
        );
        expect(after.angleTo(before)).toBeLessThan(1e-7);
      }
    }
  });

  it('actually changes the angles — an identity conversion would be the bug', () => {
    const converted = eclipticHeadingPitchFromEquatorial(0.8, 0);
    expect(Math.abs(converted.pitchRad)).toBeGreaterThan(0.01);
  });

  it('gives up at most the clamp residual on a save aimed at the flight pole', () => {
    // Documented, deliberate: a restored aim within (π/2 − limit) of ecliptic
    // north or south comes back at the clamp, because the pitch bound is what
    // keeps the chase camera's up axis off its own view direction.
    const residualRad = Math.PI / 2 - FLIGHT_PITCH_LIMIT_RAD;
    expect(THREE.MathUtils.radToDeg(residualRad)).toBeLessThan(1.9);

    for (const sign of [1, -1]) {
      // The old basis' angles for an aim straight at the ecliptic pole.
      const poleDir = FLIGHT_UP_SCENE.clone().multiplyScalar(sign);
      const legacyHeading = Math.atan2(poleDir.z, poleDir.x);
      const legacyPitch = Math.atan2(poleDir.y, Math.hypot(poleDir.x, poleDir.z));

      const converted = eclipticHeadingPitchFromEquatorial(legacyHeading, legacyPitch);
      expect(converted.pitchRad).toBe(sign * FLIGHT_PITCH_LIMIT_RAD);
      const restored = flightDirectionFromAngles(
        converted.headingRad,
        converted.pitchRad,
        new THREE.Vector3(),
      );
      expect(restored.angleTo(poleDir)).toBeLessThanOrEqual(residualRad + 1e-9);
      expect(Number.isFinite(converted.headingRad)).toBe(true);
    }
  });

  it('loses only the clamp residual just outside the bound, and is deterministic there', () => {
    // 1° off the pole: still inside the clamp, so the restored aim sits at the
    // bound — the error is the geometry of the clamp, nothing else. Heading
    // stays the real azimuth (not float residue) because the direction is not
    // degenerate.
    const oneDeg = 1 * Math.PI / 180;
    const tilted = FLIGHT_UP_SCENE.clone()
      .multiplyScalar(Math.cos(oneDeg))
      .addScaledVector(flightDirectionFromAngles(0.7, 0, new THREE.Vector3()), Math.sin(oneDeg))
      .normalize();
    const legacyHeading = Math.atan2(tilted.z, tilted.x);
    const legacyPitch = Math.atan2(tilted.y, Math.hypot(tilted.x, tilted.z));

    const a = eclipticHeadingPitchFromEquatorial(legacyHeading, legacyPitch);
    const b = eclipticHeadingPitchFromEquatorial(legacyHeading, legacyPitch);
    expect(a.headingRad).toBe(b.headingRad); // deterministic, not residue-driven
    expect(a.pitchRad).toBe(FLIGHT_PITCH_LIMIT_RAD);
    expect(a.headingRad).toBeCloseTo(0.7, 6); // the real azimuth survives

    const restored = flightDirectionFromAngles(a.headingRad, a.pitchRad, new THREE.Vector3());
    const errorRad = restored.angleTo(tilted);
    expect(errorRad).toBeLessThanOrEqual(Math.PI / 2 - FLIGHT_PITCH_LIMIT_RAD - oneDeg + 1e-9);
  });

  it('is not idempotent, which is why the flag decides (converting twice drifts)', () => {
    const once = eclipticHeadingPitchFromEquatorial(0.8, 0);
    const twice = eclipticHeadingPitchFromEquatorial(once.headingRad, once.pitchRad);
    const a = flightDirectionFromAngles(once.headingRad, once.pitchRad, new THREE.Vector3());
    const b = flightDirectionFromAngles(twice.headingRad, twice.pitchRad, new THREE.Vector3());
    expect(THREE.MathUtils.radToDeg(a.angleTo(b))).toBeGreaterThan(1);
  });
});

describe('shipOrientationFromFlight', () => {
  const localX = new THREE.Vector3(1, 0, 0);
  const localY = new THREE.Vector3(0, 1, 0);
  const localZ = new THREE.Vector3(0, 0, 1);

  it('builds a right-handed basis whose +X is the flight direction', () => {
    // The hull models are authored +X-forward; a literal Matrix4.lookAt
    // (−Z-forward) here would be a 90° error.
    for (const heading of HEADINGS) {
      for (const pitch of [-1.2, -0.4, 0, 0.7, 1.4]) {
        const q = shipOrientationFromFlight(heading, pitch, new THREE.Quaternion());
        const forward = flightDirectionFromAngles(heading, pitch, new THREE.Vector3());
        const x = localX.clone().applyQuaternion(q);
        const y = localY.clone().applyQuaternion(q);
        const z = localZ.clone().applyQuaternion(q);
        expect(x.angleTo(forward)).toBeLessThan(1e-7);
        // Orthonormal…
        expect(x.length()).toBeCloseTo(1, 12);
        expect(y.length()).toBeCloseTo(1, 12);
        expect(z.length()).toBeCloseTo(1, 12);
        expect(x.dot(y)).toBeCloseTo(0, 12);
        expect(y.dot(z)).toBeCloseTo(0, 12);
        expect(x.dot(z)).toBeCloseTo(0, 12);
        // …and right-handed (det +1): a quaternion can't encode a mirror,
        // so this catches a basis built in the wrong order.
        expect(new THREE.Vector3().crossVectors(x, y).dot(z)).toBeCloseTo(1, 12);
      }
    }
  });

  it('rolls with the flight horizon: the hull\'s up stays in the forward/up plane', () => {
    for (const heading of HEADINGS) {
      const q = shipOrientationFromFlight(heading, 0, new THREE.Quaternion());
      const y = localY.clone().applyQuaternion(q);
      // At level flight the hull's up IS the horizon — no roll at all.
      expect(y.angleTo(FLIGHT_UP_SCENE)).toBeLessThan(1e-7);
    }
  });

  it('climbing or diving, the hull\'s up is the horizon\'s — not celestial north', () => {
    // Pitched flight is where a wrong roll reference hides: any twist-minimal
    // basis is smooth and orthonormal too. What must hold is that the hull's
    // up is the FLIGHT horizon projected perpendicular to the nose — so the
    // ship banks with the system's plane, and never rolls past vertical.
    let maxDivergenceDeg = 0;
    for (const pitch of [30 * Math.PI / 180, -30 * Math.PI / 180, 1.2, -1.2]) {
      for (const heading of HEADINGS) {
        const q = shipOrientationFromFlight(heading, pitch, new THREE.Quaternion());
        const forward = flightDirectionFromAngles(heading, pitch, new THREE.Vector3());
        const y = localY.clone().applyQuaternion(q);

        // Upright: never rolled onto its back.
        expect(y.dot(FLIGHT_UP_SCENE), `heading ${heading} pitch ${pitch}`).toBeGreaterThan(0);

        // And it IS the horizon, projected off the nose.
        const horizonPerp = FLIGHT_UP_SCENE.clone()
          .addScaledVector(forward, -FLIGHT_UP_SCENE.dot(forward))
          .normalize();
        expect(y.angleTo(horizonPerp), `heading ${heading} pitch ${pitch}`).toBeLessThan(1e-7);

        // Track how far the same construction on celestial north would land.
        // (It coincides wherever the nose lies in the plane the two poles
        // share — hence the max over the sweep rather than a per-pose bound.)
        const worldPerp = new THREE.Vector3(0, 1, 0)
          .addScaledVector(forward, -forward.y)
          .normalize();
        maxDivergenceDeg = Math.max(
          maxDivergenceDeg,
          THREE.MathUtils.radToDeg(worldPerp.angleTo(horizonPerp)),
        );
      }
    }
    // A celestial-north roll reference would visibly disagree across the
    // sweep — without this the assertions above could pass on either one.
    expect(maxDivergenceDeg).toBeGreaterThan(10);
  });

  it('sweeps continuously at maximum steering pitch — no roll snap near the pole', () => {
    // The degeneracy epsilon sits above every reachable pitch, so a full
    // heading sweep at the steering limit must never cross the fallback seam.
    const prev = new THREE.Quaternion();
    const cur = new THREE.Quaternion();
    for (const pitch of [FLIGHT_PITCH_LIMIT_RAD, -FLIGHT_PITCH_LIMIT_RAD]) {
      shipOrientationFromFlight(0, pitch, prev);
      const step = Math.PI / 180;
      let maxStepDeg = 0;
      for (let heading = step; heading <= 2 * Math.PI + 1e-9; heading += step) {
        shipOrientationFromFlight(heading, pitch, cur);
        const deg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(prev.dot(cur)))));
        maxStepDeg = Math.max(maxStepDeg, deg);
        prev.copy(cur);
      }
      // A seam crossing would show up as a step far larger than the 1° of
      // heading that produced it.
      expect(maxStepDeg).toBeLessThan(3);
    }
  });

  it('writes into the caller\'s quaternion', () => {
    const out = new THREE.Quaternion();
    expect(shipOrientationFromFlight(0.3, 0.1, out)).toBe(out);
  });
});
