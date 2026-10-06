/**
 * The lens's proximity factor: how much of the requested stereographic
 * strength survives when one body fills the view.
 *
 * The stereographic lens (lensProjection.ts) exists so a SMALL, OFF-AXIS
 * sphere renders as a circle rather than the 1/cos θ egg a pinhole draws. A
 * large, centred disc is a circle under either projection — but the lens
 * compresses everything off-axis, harder the farther out, and a body that
 * fills the frame has its limb far off-axis. Measured against the renderer
 * (tools/approach-probe.mjs): at the 60° design FOV a
 * centred disc's drawn radius under the lens has a hard ceiling of
 * 2 / (2·tan 15°) = 3.73 frame half-heights, so over Earth's last 6,371 km
 * the limb grows ×2.9 where a pinhole gives ×6.9 while the ground straight
 * ahead rushes ×32 under both, and the ground at the frame's corners is drawn
 * at ~38 % of the centre's scale. That is the "getting bigger looks odd" of
 * a close approach: the picture inflates from the middle instead of growing.
 *
 * So the strength fades with the largest angular radius any body's RENDERED
 * SURFACE subtends — full at and below LENS_PROXIMITY_FULL_DEG, gone at and
 * above LENS_PROXIMITY_OFF_DEG, a Hermite ease between. A pure function of
 * the pose, with no easing over time, so a teleport lands at the right
 * strength on its first frame. Keyed on angular RADIUS rather than on where
 * the body sits in the frame, and read from the SHIP's distance plus the
 * boom the chase rig INTENDS rather than from the camera (cruiseView.ts,
 * largestDiscAngles; PlanetariumMode.intendedCameraRadiusAU): in this app
 * looking around orbits the camera round the ship on a ~233 km boom, and read
 * from the camera the strength swung 0.5 ↔ 0.2 on a plain drag over Earth.
 * Read from the camera's actual distance to the ship it held on that drag
 * but not on one that met a body's padded shell, where the safety pass
 * pushes the camera out and shortens the boom — at the Moon's park that took
 * the lens from 0.47 to off with the ship never moving. So neither turning
 * the head, nor orbiting the chase camera, nor a collision moving it changes
 * the projection; the wheel under a drag orbit, which scales the intended
 * boom, still brings the lens back.
 *
 * Why 45°: every authored flyby closes to ARRIVAL_IMPACT_RADII = 1.8 rendered
 * radii, an angular radius of 33.7°, and on the receding leg the camera eases
 * back to the ship heading while the body is still that large and drifting
 * off-axis — the exact case the lens exists for. A ramp that started at 30°
 * would put an egg on every departure; 45° leaves an 11° margin. Because the
 * driving angle is read from the ship's distance plus the boom, it never
 * reads past that 33.7° either — the bound is on the DRIVING angle: the
 * camera sits off the ship's line and can pass nearer the body than the ship
 * does, its own angle reaches 42.4° on Cordelia's pass, and it drives
 * nothing; the colocated tests pin both.
 * What DOES ramp on a flyby is the parent: the departure from an inner moon
 * clears its giant's collision surface by 1.1×, and Uranus after Cordelia or
 * Jupiter after Metis fills the view to ~65° on the way out — a giant filling
 * the view is the case the ramp is for, and the recording should include one.
 * Why 70°: 409 km over Earth, a plain pinhole well before the 198 km park. The
 * 11 % size deficit the lens still has at 45° (2,639 km over Earth) is the
 * accepted trade.
 *
 * The cost, accepted and stated: parked close and looking AWAY, the whole
 * scene is drawn pinhole, so a small disc near the frame edge (the Moon from
 * Earth's neighbourhood, ~8 px across: ~1 px of stretch) and, more visibly,
 * constellation shapes near the corners (a pinhole's anisotropy is sec θ,
 * 1.55:1 at a 16:9 corner) lose what the lens gave them. A view-aware factor
 * would fix that and swim on every pan; it is not attempted.
 *
 * On by default; `?lensramp=0` (any build) is the kill switch and the A/B.
 * Pure math only — no three.js — so the ramp is unit-tested in isolation and
 * the probe that measures it reads the same two numbers off the app.
 *
 * The A/B's two candidate arms ride the same law as switches, any build, so a
 * phone can fly them from an address bar (`parseLensRampConfig`):
 * `?lensband=<full>,<off>` moves the two knees — the ship-plus-boom driver
 * never reads past ~60° at the Moon's clearance shell (ship 41 km up, boom
 * 233 km), so the default band ends at 58°: every park reaches a pinhole and
 * the flyby keeps its 11° margin, where the first band, 45/70 (still
 * `?lensband=45,70`), left the Moon's park 0.37 of the lens and brought
 * nothing smaller than Venus to a pinhole — and `?lensdrive=ship` reads the
 * driving angle from the ship's distance ALONE, no boom, which reaches a
 * pinhole at every park ≥ Europa and cannot move on a drag or a push, at the
 * price of holding the pinhole while a wheel zooms the camera far out from a
 * parked ship, where a small disc near the frame edge is the egg the lens
 * exists for. The band was judged on the capture sheet; the ship-only driver
 * stays a switch.
 */

import { RAD2DEG } from './angles';
import { smoothstepEdges } from './smoothstep';

/** At or below this angular radius the requested strength applies in full —
 *  every far pose, every flyby, byte for byte what it was. */
export const LENS_PROXIMITY_FULL_DEG = 45;

/** At or above this angular radius the lens is off: a plain pinhole. Under
 *  the shell-reading the ship-plus-boom driver gives at the Moon (~60°), so
 *  every park reaches it. */
export const LENS_PROXIMITY_OFF_DEG = 58;

/**
 * Factor on the requested lens strength for the largest angular radius (rad)
 * any body's rendered surface subtends from the camera: exactly 1 at and
 * below the full knee, exactly 0 at and above the off knee, a smoothstep
 * between. A non-finite input reads as far away (factor 1).
 */
export function lensProximityFactor(
  largestAngularRadiusRad: number,
  band: LensRampBand = LENS_PROXIMITY_DEFAULT_BAND,
): number {
  const angularRadiusDeg = largestAngularRadiusRad * RAD2DEG;
  if (!Number.isFinite(angularRadiusDeg) || !(angularRadiusDeg > band.fullDeg)) return 1;
  if (angularRadiusDeg >= band.offDeg) return 0;
  return 1 - smoothstepEdges(band.fullDeg, band.offDeg, angularRadiusDeg);
}

/** The two knees, in degrees of angular radius: full strength at and below
 *  `fullDeg`, off at and above `offDeg`. */
export interface LensRampBand {
  fullDeg: number;
  offDeg: number;
}

export const LENS_PROXIMITY_DEFAULT_BAND: LensRampBand = Object.freeze({
  fullDeg: LENS_PROXIMITY_FULL_DEG,
  offDeg: LENS_PROXIMITY_OFF_DEG,
});

/** What the driving angle is read from: the ship's distance plus the boom the
 *  rig intends (the shipped rule), or the ship's distance alone. */
export type LensRampDriver = 'ship+boom' | 'ship';

export interface LensRampConfig {
  driver: LensRampDriver;
  band: LensRampBand;
}

export const LENS_RAMP_DEFAULT_CONFIG: LensRampConfig = Object.freeze({
  driver: 'ship+boom',
  band: LENS_PROXIMITY_DEFAULT_BAND,
});

/**
 * The A/B arms off a URL: `lensdrive=ship` (anything else, or absent, is the
 * shipped driver) and `lensband=<full>,<off>` in degrees — refused, with the
 * default kept, unless both numbers are finite, 0 < full < off ≤ 90. Pure,
 * so a bad value is pinned to fall back rather than to NaN the projection.
 */
export function parseLensRampConfig(search: string, base: LensRampConfig = LENS_RAMP_DEFAULT_CONFIG): LensRampConfig {
  const params = new URLSearchParams(search);
  const driver: LensRampDriver = params.get('lensdrive') === 'ship' ? 'ship' : base.driver;
  let band = base.band;
  const bandText = params.get('lensband');
  if (bandText !== null) {
    const parts = bandText.split(',').map((part) => Number(part.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite) && parts[0] > 0 && parts[0] < parts[1] && parts[1] <= 90) {
      band = { fullDeg: parts[0], offDeg: parts[1] };
    }
  }
  return { driver, band };
}

/** The angular radius (rad) a sphere of `radiusAU` subtends from `distanceAU`
 *  off its centre — the true silhouette, asin(r/d) — reading a full 90° from
 *  inside it and 0 for no sphere at all. */
export function sphereAngularRadius(radiusAU: number, distanceAU: number): number {
  if (!(radiusAU > 0) || !Number.isFinite(distanceAU)) return 0;
  if (!(distanceAU > radiusAU)) return Math.PI / 2;
  return Math.asin(radiusAU / distanceAU);
}
