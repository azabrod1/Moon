import { describe, it, expect } from 'vitest';
import {
  apparentDepthAU,
  clampFollowDistanceAU,
  followBounds,
  mapCameraInitialState,
  mapCameraOwnsPose,
  mapCameraReduce,
  mapDiveEndFraction,
  mapFlightFramingDistanceAU,
  mapFocusEase,
  mapOverviewChipVisible,
  mapWorldPerPxAtUnitDepth,
  revealDistanceAU,
  MAP_FOCUS_MIN_PX,
  MAP_FOCUS_REVEAL_PX,
  MAP_FOV_DEG,
  MAP_OVERVIEW_NEAR_FRAC,
  type MapCameraState,
} from './mapCamera';
import { MAP_BODY_SIZE_DEFAULTS, mapMarkerRadiusPx } from './mapBodySize';
import { fitDistanceAU } from './mapProjection';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { MOONS } from '../planets/moonData';

const H = 900;
const SIZE = MAP_BODY_SIZE_DEFAULTS;

// True radii in AU, and the map-space distance from the Sun each body sits at
// on the compressed chart (0.6·asinh(r/0.6)) — the two facts the bounds policy
// meters a subject with.
const JUPITER_R = 4.673e-4;
const JUPITER_MAP_R = 1.712;
const PLUTO_R = 7.941e-6;
const PLUTO_MAP_R = 2.93;
const EARTH_R = 4.259e-5;
const EARTH_MAP_R = 0.7764;
// The compressed chart reaches Pluto's aphelion; true scale reaches ~49 AU.
const EXTENT_COMPRESSED = 2.93;
const EXTENT_TRUE = 49.4;

/** Screen radius (px) a body's true disc subtends at a camera depth. */
function discPx(radiusAU: number, depthAU: number): number {
  return radiusAU / (mapWorldPerPxAtUnitDepth(H, MAP_FOV_DEG) * depthAU);
}

/** The bounds a body gets when the camera is parked at `camDist` from it. */
function boundsAt(
  radiusAU: number,
  subjectMapRadius: number,
  camDist: number,
  extent: number,
) {
  return followBounds(
    radiusAU,
    camDist - radiusAU,
    subjectMapRadius,
    subjectMapRadius,
    extent,
    H,
    MAP_FOV_DEG,
    SIZE,
    { minDist: 0, maxDist: 0, near: 0, far: 0 },
  );
}

describe('mapCameraReduce', () => {
  const initial = mapCameraInitialState();

  it('starts parked on the overview with nothing focused', () => {
    expect(initial).toEqual({
      camState: 'overview',
      flyGoal: null,
      focusName: null,
      diveOrigin: null,
    });
  });

  it('flies toward a body and lands in follow', () => {
    const flying = mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' });
    expect(flying.camState).toBe('focusFly');
    expect(flying.flyGoal).toBe('follow');
    expect(flying.focusName).toBe('Jupiter');
    const landed = mapCameraReduce(flying, { kind: 'flyLanded' });
    expect(landed.camState).toBe('following');
    expect(landed.flyGoal).toBe(null);
    expect(landed.focusName).toBe('Jupiter');
  });

  it('treats re-asking for the body you are already on as nothing to do', () => {
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' }),
      { kind: 'flyLanded' },
    );
    expect(mapCameraReduce(following, { kind: 'focus', name: 'Jupiter' })).toBe(following);
    const flying = mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' });
    expect(mapCameraReduce(flying, { kind: 'focus', name: 'Jupiter' })).toBe(flying);
  });

  it('retargets to a different body from a follow or from either flight', () => {
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' }),
      { kind: 'flyLanded' },
    );
    const retargeted = mapCameraReduce(following, { kind: 'focus', name: 'Saturn' });
    expect(retargeted.camState).toBe('focusFly');
    expect(retargeted.flyGoal).toBe('follow');
    expect(retargeted.focusName).toBe('Saturn');

    const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' });
    expect(mapCameraReduce(inbound, { kind: 'focus', name: 'Saturn' }).focusName).toBe('Saturn');
  });

  it('lets a fresh focus supersede a release already under way', () => {
    const leaving = mapCameraReduce(
      mapCameraReduce(
        mapCameraReduce(initial, { kind: 'focus', name: 'Jupiter' }),
        { kind: 'flyLanded' },
      ),
      { kind: 'release' },
    );
    expect(leaving.flyGoal).toBe('overview');
    const again = mapCameraReduce(leaving, { kind: 'focus', name: 'Jupiter' });
    expect(again.camState).toBe('focusFly');
    expect(again.flyGoal).toBe('follow');
    expect(again.focusName).toBe('Jupiter');
  });

  it('releases from a follow and from an inbound flight, and lands on the overview', () => {
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Earth' }),
      { kind: 'flyLanded' },
    );
    const leaving = mapCameraReduce(following, { kind: 'release' });
    expect(leaving.camState).toBe('focusFly');
    expect(leaving.flyGoal).toBe('overview');
    // The body stays named while the camera is still leaving it — the clip
    // planes meter against that subject for the whole flight.
    expect(leaving.focusName).toBe('Earth');
    expect(mapCameraReduce(leaving, { kind: 'flyLanded' })).toEqual(initial);

    const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Earth' });
    expect(mapCameraReduce(inbound, { kind: 'release' }).flyGoal).toBe('overview');
  });

  it('ignores a release that is already leaving, or was never focused', () => {
    expect(mapCameraReduce(initial, { kind: 'release' })).toBe(initial);
    const leaving = mapCameraReduce(
      mapCameraReduce(
        mapCameraReduce(initial, { kind: 'focus', name: 'Earth' }),
        { kind: 'flyLanded' },
      ),
      { kind: 'release' },
    );
    expect(mapCameraReduce(leaving, { kind: 'release' })).toBe(leaving);
  });

  it('leaves the machine untouched for the autopilot fade', () => {
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Mars' }),
      { kind: 'flyLanded' },
    );
    expect(mapCameraReduce(following, { kind: 'diveStart', camera: false })).toBe(following);
    expect(mapCameraReduce(initial, { kind: 'diveStart', camera: false })).toBe(initial);
  });

  it('memos what a camera dive interrupted, flight goal included', () => {
    const leaving = mapCameraReduce(
      mapCameraReduce(
        mapCameraReduce(initial, { kind: 'focus', name: 'Mars' }),
        { kind: 'flyLanded' },
      ),
      { kind: 'release' },
    );
    const diving = mapCameraReduce(leaving, { kind: 'diveStart', camera: true });
    expect(diving.camState).toBe('dive');
    expect(diving.diveOrigin).toEqual({
      camState: 'focusFly',
      flyGoal: 'overview',
      focusName: 'Mars',
    });
  });

  it('restores per origin when a dive is cancelled', () => {
    const cancel = (state: MapCameraState) =>
      mapCameraReduce(
        mapCameraReduce(state, { kind: 'diveStart', camera: true }),
        { kind: 'diveCancel' },
      );

    // From the overview: straight back to the overview.
    expect(cancel(initial)).toEqual(initial);

    // From a follow: back onto the same body.
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Io' }),
      { kind: 'flyLanded' },
    );
    expect(cancel(following)).toEqual({
      camState: 'following',
      flyGoal: null,
      focusName: 'Io',
      diveOrigin: null,
    });

    // From an inbound flight: the approach completes instead of stalling.
    const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Io' });
    expect(cancel(inbound)).toEqual({
      camState: 'following',
      flyGoal: null,
      focusName: 'Io',
      diveOrigin: null,
    });

    // From a release: the departure completes. Restoring the follow here would
    // reverse the very gesture the user made.
    const leaving = mapCameraReduce(following, { kind: 'release' });
    expect(cancel(leaving)).toEqual(initial);
  });

  it('ignores a cancel that no dive is running, and a focus during one', () => {
    expect(mapCameraReduce(initial, { kind: 'diveCancel' })).toBe(initial);
    const diving = mapCameraReduce(initial, { kind: 'diveStart', camera: true });
    expect(mapCameraReduce(diving, { kind: 'focus', name: 'Venus' })).toBe(diving);
    expect(mapCameraReduce(diving, { kind: 'diveStart', camera: true })).toBe(diving);
  });

  it('resets everything on close', () => {
    const following = mapCameraReduce(
      mapCameraReduce(initial, { kind: 'focus', name: 'Venus' }),
      { kind: 'flyLanded' },
    );
    expect(mapCameraReduce(following, { kind: 'close' })).toEqual(initial);
    const diving = mapCameraReduce(following, { kind: 'diveStart', camera: true });
    expect(mapCameraReduce(diving, { kind: 'close' })).toEqual(initial);
  });
});

describe('mapOverviewChipVisible', () => {
  const initial = mapCameraInitialState();
  const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Saturn' });
  const following = mapCameraReduce(inbound, { kind: 'flyLanded' });
  const leaving = mapCameraReduce(following, { kind: 'release' });

  it('shows while flying to a body and while following it', () => {
    expect(mapOverviewChipVisible(inbound)).toBe(true);
    expect(mapOverviewChipVisible(following)).toBe(true);
  });

  it('hides on the overview, on the way back out, and during a dive', () => {
    expect(mapOverviewChipVisible(initial)).toBe(false);
    expect(mapOverviewChipVisible(leaving)).toBe(false);
    expect(mapOverviewChipVisible(
      mapCameraReduce(following, { kind: 'diveStart', camera: true }),
    )).toBe(false);
  });
});

describe('mapCameraOwnsPose', () => {
  const initial = mapCameraInitialState();
  const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Saturn' });

  it('stands the pointer down while the camera writes its own pose', () => {
    expect(mapCameraOwnsPose(inbound)).toBe(true);
    expect(mapCameraOwnsPose(mapCameraReduce(inbound, { kind: 'release' }))).toBe(true);
    expect(mapCameraOwnsPose(
      mapCameraReduce(initial, { kind: 'diveStart', camera: true }),
    )).toBe(true);
  });

  it('leaves picking live on the overview and in a settled follow', () => {
    expect(mapCameraOwnsPose(initial)).toBe(false);
    expect(mapCameraOwnsPose(mapCameraReduce(inbound, { kind: 'flyLanded' }))).toBe(false);
  });
});

describe('mapFocusEase', () => {
  it('starts and ends at rest, and clamps outside the flight', () => {
    expect(mapFocusEase(0)).toBe(0);
    expect(mapFocusEase(1)).toBe(1);
    expect(mapFocusEase(-0.5)).toBe(0);
    expect(mapFocusEase(2)).toBe(1);
    expect(mapFocusEase(0.5)).toBeCloseTo(0.5, 12);
  });

  it('is monotonic across the flight', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const k = mapFocusEase(i / 20);
      expect(k).toBeGreaterThan(prev);
      prev = k;
    }
  });
});

describe('followBounds', () => {
  it('gives a big planet the framing it asks for', () => {
    const b = boundsAt(JUPITER_R, JUPITER_MAP_R, 0.01, EXTENT_COMPRESSED);
    expect(discPx(JUPITER_R, b.minDist)).toBeCloseTo(MAP_FOCUS_MIN_PX, 6);
  });

  it('caps a small body short of that rather than clipping it', () => {
    const b = boundsAt(PLUTO_R, PLUTO_MAP_R, 0.001, EXTENT_COMPRESSED);
    const px = discPx(PLUTO_R, b.minDist);
    expect(px).toBeLessThan(MAP_FOCUS_MIN_PX);
    // Still a resolved globe rather than a symbol: past its own marker.
    expect(px).toBeGreaterThan(mapMarkerRadiusPx(PLUTO_R, SIZE));
  });

  it('keeps the subject in front of the near plane at the closest framing', () => {
    for (const [r, mapR] of [
      [JUPITER_R, JUPITER_MAP_R],
      [EARTH_R, EARTH_MAP_R],
      [PLUTO_R, PLUTO_MAP_R],
    ] as const) {
      for (const extent of [EXTENT_COMPRESSED, EXTENT_TRUE]) {
        const shell = boundsAt(r, mapR, 1, extent);
        const b = boundsAt(r, mapR, shell.minDist, extent);
        const surface = shell.minDist - r;
        expect(b.near).toBeLessThanOrEqual(surface * 0.5 + 1e-12);
        expect(b.near).toBeGreaterThan(0);
      }
    }
  });

  it('clears the nearest surface it is handed, not the framing body', () => {
    // Mid-transition the camera is an AU from where it is headed and a
    // thousandth of one from where it started. Handed that near surface, the
    // near plane has to sit in front of it — the body being left is still the
    // one filling the frame.
    const leavingSurface = 1.8e-3;
    const b = followBounds(
      JUPITER_R, leavingSurface, 1.5, 2.07, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE,
    );
    expect(b.near).toBeLessThan(leavingSurface);
  });

  it('is the near floor that stops the approach on the small bodies', () => {
    const shell = boundsAt(PLUTO_R, PLUTO_MAP_R, 1, EXTENT_COMPRESSED);
    const b = boundsAt(PLUTO_R, PLUTO_MAP_R, shell.minDist, EXTENT_COMPRESSED);
    // Exactly at the clearance the floor is derived from: half the way to the
    // subject's surface, which is what makes minDist the closest honest framing.
    expect(b.near).toBeCloseTo((shell.minDist - PLUTO_R) * 0.5, 12);
  });

  it('holds the whole system inside the far plane from wherever the camera is', () => {
    for (const camOrigin of [0.01, 1, 5, 40]) {
      const b = followBounds(
        EARTH_R, 0.001, camOrigin, EARTH_MAP_R, EXTENT_TRUE, H, MAP_FOV_DEG, SIZE,
      );
      expect(b.far).toBeGreaterThan(camOrigin + EXTENT_TRUE);
    }
  });

  it('never opens the near plane past the overview\'s own during a flight', () => {
    // A flight starts at the whole-system fit: a quarter of THAT distance would
    // be a near plane slicing through the foreground.
    const b = followBounds(
      EARTH_R, 7, 7, EARTH_MAP_R, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE,
    );
    expect(b.near).toBeCloseTo(EXTENT_COMPRESSED * MAP_OVERVIEW_NEAR_FRAC, 12);
  });

  it('backs the approach off as the chart grows behind the subject', () => {
    const compressed = boundsAt(EARTH_R, EARTH_MAP_R, 1, EXTENT_COMPRESSED);
    const trueScale = boundsAt(EARTH_R, EARTH_MAP_R, 1, EXTENT_TRUE);
    expect(trueScale.minDist).toBeGreaterThan(compressed.minDist);
  });

  it('stops the zoom-out where the true disc meets the chart marker', () => {
    for (const [r, mapR] of [
      [JUPITER_R, JUPITER_MAP_R],
      [EARTH_R, EARTH_MAP_R],
    ] as const) {
      const b = boundsAt(r, mapR, 0.01, EXTENT_COMPRESSED);
      // At the limit the true disc has fallen to half its marker, so the marker
      // is what draws — the subject can never shrink below the symbol it would
      // have had anyway.
      expect(discPx(r, b.maxDist)).toBeLessThanOrEqual(mapMarkerRadiusPx(r, SIZE));
    }
  });

  it('never inverts the shell, even where the floor overshoots the crossover', () => {
    for (const [r, mapR] of [
      [JUPITER_R, JUPITER_MAP_R],
      [EARTH_R, EARTH_MAP_R],
      [PLUTO_R, PLUTO_MAP_R],
    ] as const) {
      for (const extent of [EXTENT_COMPRESSED, EXTENT_TRUE]) {
        const b = boundsAt(r, mapR, 1, extent);
        expect(b.maxDist).toBeGreaterThan(b.minDist);
        expect(b.minDist).toBeGreaterThan(r);
      }
    }
  });

  it('holds the shell still while the camera moves inside it', () => {
    const near = boundsAt(JUPITER_R, JUPITER_MAP_R, 0.003, EXTENT_COMPRESSED);
    const min = near.minDist;
    const max = near.maxDist;
    const far = boundsAt(JUPITER_R, JUPITER_MAP_R, 0.05, EXTENT_COMPRESSED);
    expect(far.minDist).toBeCloseTo(min, 15);
    expect(far.maxDist).toBeCloseTo(max, 15);
  });
});

describe('revealDistanceAU', () => {
  it('lands the subject at a resolved disc, not a symbol', () => {
    const d = revealDistanceAU(JUPITER_R, H, MAP_FOV_DEG);
    expect(discPx(JUPITER_R, d)).toBeCloseTo(MAP_FOCUS_REVEAL_PX, 6);
    expect(MAP_FOCUS_REVEAL_PX).toBeGreaterThan(mapMarkerRadiusPx(JUPITER_R, SIZE));
  });

  it('is held inside the follow shell where the body cannot be reached', () => {
    const b = boundsAt(PLUTO_R, PLUTO_MAP_R, 1, EXTENT_COMPRESSED);
    const raw = revealDistanceAU(PLUTO_R, H, MAP_FOV_DEG);
    expect(raw).toBeLessThan(b.minDist);
    expect(clampFollowDistanceAU(raw, b)).toBe(b.minDist);
  });

  it('leaves the reveal distance alone on a body that can be reached', () => {
    const b = boundsAt(JUPITER_R, JUPITER_MAP_R, 0.01, EXTENT_COMPRESSED);
    const raw = revealDistanceAU(JUPITER_R, H, MAP_FOV_DEG);
    expect(clampFollowDistanceAU(raw, b)).toBe(raw);
  });
});

describe('mapFlightFramingDistanceAU', () => {
  const ASPECT = 16 / 10;
  const halfFov = (MAP_FOV_DEG * Math.PI) / 180 / 2;
  const frame = (base: number, aimGap: number, extent = EXTENT_COMPRESSED) =>
    mapFlightFramingDistanceAU(base, aimGap, extent, MAP_FOV_DEG, ASPECT);

  it('leaves a move alone while its aim is on a body', () => {
    // Both ends of a flight put the aim ON its body, so nothing is owed there
    // and the move starts and lands exactly where its own math says.
    expect(frame(0.00024, 0)).toBe(0.00024);
    expect(frame(0.011, 0)).toBe(0.011);
  });

  it('frames whatever the aim is nearest, all the way across', () => {
    for (const gap of [0.001, 0.05, 0.45, 0.9]) {
      const d = frame(0.00024, gap);
      expect(Math.atan(gap / d)).toBeLessThan(halfFov);
    }
  });

  it('covers both requirements at once when they are composed', () => {
    // A move has to keep an END of the trip framed (so you can see where you
    // came from or are going) AND whatever body is nearest the aim (so a
    // redirect starting in empty space still shows something). Handing it the
    // larger of the two gaps satisfies both.
    const endpointGap = 0.05;
    const nearestBodyGap = 0.4;
    const d = frame(0.002, Math.max(endpointGap, nearestBodyGap));
    expect(Math.atan(endpointGap / d)).toBeLessThan(halfFov);
    expect(Math.atan(nearestBodyGap / d)).toBeLessThan(halfFov);
  });

  it('holds a redirected move to what is actually near it', () => {
    // A move retargeted mid-way begins in empty space. Framing its start point
    // would frame nothing; framing the nearest body keeps that body on screen.
    const nearestBodyGap = 0.055;
    const d = frame(0.14, nearestBodyGap);
    expect(Math.atan(nearestBodyGap / d)).toBeLessThan(halfFov);
  });

  it('contains a body\'s drawn reach, not just where its centre sits', () => {
    // The fit margin is thin — at a portrait viewport it is about 15% of the
    // half-width — so a ringed body framed by its centre alone loses its rings
    // over the frame edge. Framing centre PLUS reach is what holds it whole.
    const centreGap = 0.4;
    const reach = 0.09;                       // a ring out at ~2.3 globe radii
    const narrow = 390 / 844;
    const byCentre = mapFlightFramingDistanceAU(
      0.002, centreGap, EXTENT_COMPRESSED, MAP_FOV_DEG, narrow,
    );
    const byReach = mapFlightFramingDistanceAU(
      0.002, centreGap + reach, EXTENT_COMPRESSED, MAP_FOV_DEG, narrow,
    );
    const halfFrame = Math.atan(Math.tan(halfFov) * narrow);
    expect(Math.atan((centreGap + reach) / byCentre)).toBeGreaterThan(halfFrame);
    expect(Math.atan((centreGap + reach) / byReach)).toBeLessThan(halfFrame);
  });

  it('never climbs past the overview fit', () => {
    const fit = fitDistanceAU(EXTENT_COMPRESSED, MAP_FOV_DEG, ASPECT);
    expect(frame(0.002, 50 * EXTENT_COMPRESSED)).toBeCloseTo(fit, 12);
  });

  it('never pulls a move IN, only out', () => {
    // A move that begins at the overview is already further out than any aim
    // could ask for, so it keeps its straight path bit for bit.
    for (const gap of [0, 0.1, 0.85, 1.7]) {
      expect(frame(7.75, gap)).toBe(7.75);
    }
  });

  it('answers to the chart it is asked about', () => {
    // The same gap on a chart 17x wider is capped 17x further out, so a scale
    // toggle under a move moves the framing with it.
    const wide = frame(0.002, 50 * EXTENT_TRUE, EXTENT_TRUE);
    const narrow = frame(0.002, 50 * EXTENT_COMPRESSED, EXTENT_COMPRESSED);
    expect(wide / narrow).toBeCloseTo(EXTENT_TRUE / EXTENT_COMPRESSED, 6);
  });

  it('is a smooth climb and fall across a whole crossing', () => {
    // The aim's distance to the nearer body rises to the halfway point and
    // falls again, so the framing does too — out, across, back in.
    const SEP = 0.9;
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const k = i / 20;
      const d = frame(0.00024, Math.min(k, 1 - k) * SEP);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    for (let i = 10; i <= 20; i++) {
      const k = i / 20;
      const d = frame(0.00024, Math.min(k, 1 - k) * SEP);
      expect(d).toBeLessThanOrEqual(prev + 1e-12);
      prev = d;
    }
  });
});

describe('mapDiveEndFraction', () => {
  // The dive's shipped fraction, and the largest body it can be aimed at.
  const BASE = 0.14;
  const SUN_R = 4.653e-3;
  const SATURN_R = 3.893e-4;

  it('leaves an overview dive exactly where it was', () => {
    // The overview clamps the camera no closer than 0.12 of the extent, so this
    // is the tightest a dive can begin from there — and the floor still cannot
    // reach it, for any destination. Bit-for-bit: these dives must not move.
    const closest = EXTENT_COMPRESSED * 0.12;
    for (const r of [SUN_R, JUPITER_R, EARTH_R, PLUTO_R]) {
      expect(mapDiveEndFraction(closest, r, BASE)).toBe(BASE);
    }
    // And at the far end of the same clamp, where dives normally start.
    for (const r of [SUN_R, JUPITER_R, EARTH_R, PLUTO_R]) {
      expect(mapDiveEndFraction(7.75, r, BASE)).toBe(BASE);
    }
  });

  it('cannot bind while a body draws as its chart marker', () => {
    // A marker is a fixed screen size, so its radius in AU is a small constant
    // fraction of the camera distance — far under the fraction the dive ends
    // at, whatever the distance.
    const markerAU = (dist: number) =>
      MAP_BODY_SIZE_DEFAULTS.maxPx * mapWorldPerPxAtUnitDepth(H, MAP_FOV_DEG) * dist;
    for (const dist of [0.35, 1, 7.75, 120]) {
      expect(mapDiveEndFraction(dist, markerAU(dist), BASE)).toBe(BASE);
    }
  });

  it('floors a dive that would otherwise end inside its destination', () => {
    // A 200 px Saturn follow sits ~5 true radii out, and 0.14 of that is 0.7
    // radii — under the surface, where a front-face-culled globe is not there.
    const start = 1.944e-3;
    expect(start * BASE / SATURN_R).toBeLessThan(1);
    const frac = mapDiveEndFraction(start, SATURN_R, BASE);
    expect(frac).toBeGreaterThan(BASE);
    expect(start * frac / SATURN_R).toBeGreaterThan(1);
  });

  it('recedes when the dive begins inside its destination', () => {
    // Following Mercury and then aiming at the Sun: the camera is riding a
    // body a hundredth the Sun's size, so it already sits deep inside the
    // Sun's own shell. Ending "closer" would park it under the photosphere —
    // the dive has to back out to clear the destination instead.
    const mercuryFollow = 2.542e-4;
    expect(mercuryFollow).toBeLessThan(SUN_R);
    const frac = mapDiveEndFraction(mercuryFollow, SUN_R, BASE);
    expect(frac).toBeGreaterThan(1);
    expect(mercuryFollow * frac / SUN_R).toBeGreaterThan(1);
  });

  it('clears a ring, not just the globe inside it', () => {
    // The clearance radius a ringed body reports spans its drawn annulus, so
    // the same floor keeps the dive outside the rings rather than through them.
    const start = 1.944e-3;
    const ringOuter = 2.27;
    const globeStop = start * mapDiveEndFraction(start, SATURN_R, BASE) / SATURN_R;
    const ringStop = start * mapDiveEndFraction(start, SATURN_R * ringOuter, BASE) / SATURN_R;
    expect(globeStop).toBeLessThan(ringOuter);   // the globe-only stop is inside it
    expect(ringStop).toBeGreaterThan(ringOuter); // the drawn extent clears it
  });

  it('holds still on a degenerate start distance', () => {
    expect(mapDiveEndFraction(0, SATURN_R, BASE)).toBe(BASE);
    expect(mapDiveEndFraction(-1, SATURN_R, BASE)).toBe(BASE);
  });
});

describe('apparentDepthAU', () => {
  it('inverts the projection it is named for', () => {
    const d = apparentDepthAU(EARTH_R, 37, H, MAP_FOV_DEG);
    expect(discPx(EARTH_R, d)).toBeCloseTo(37, 9);
  });
});

describe('a follow shell on a body that orbits another', () => {
  // Why the camera goes only to bodies the chart draws with a shell of their
  // own: the shell is ONE scalar distance about its subject, and a subject that
  // orbits something else is carried around inside that distance. When the
  // subject's orbit is comparable to the shell, the azimuth where the subject
  // sits between the camera and its parent leaves the camera at
  // |minDist - orbitRadius| from the PARENT's centre — inside the planet for an
  // inner moon, reached within hours of simulated time at any warp.
  //
  // The map's compressed radial curve is 0.6·asinh(r/0.6), which is where each
  // parent's map radius below comes from.
  const mapRadiusOf = (semiMajorAxisAU: number) => 0.6 * Math.asinh(semiMajorAxisAU / 0.6);
  const planet = (name: string) => PLANETARIUM_BODIES.find((p) => p.name === name)!;
  const moon = (name: string) => MOONS.find((m) => m.name === name)!;

  /** How close a scalar shell of `minDist` about a moon can bring the camera to
   *  the centre of the planet it orbits, over the whole orbit. */
  function closestApproachToParentAU(moonName: string): number {
    const m = moon(moonName);
    const p = planet(m.parentPlanet);
    const bounds = followBounds(
      m.radiusAU,
      1e-3,
      mapRadiusOf(p.semiMajorAxisAU),
      mapRadiusOf(p.semiMajorAxisAU),
      EXTENT_COMPRESSED,
      H,
      MAP_FOV_DEG,
      SIZE,
    );
    return Math.abs(bounds.minDist - m.orbitalRadiusAU);
  }

  it('is carried inside its parent — Cordelia inside Uranus', () => {
    const uranus = planet('Uranus');
    const closest = closestApproachToParentAU('Cordelia');
    expect(closest).toBeLessThan(uranus.radiusAU);
    // Not marginally: the worst azimuth is a quarter of the way in.
    expect(closest / uranus.radiusAU).toBeLessThan(0.5);
  });

  it('is not one unlucky body — a whole family of inner moons is carried in', () => {
    const carried = MOONS.filter((m) => {
      const p = PLANETARIUM_BODIES.find((x) => x.name === m.parentPlanet);
      return !!p && closestApproachToParentAU(m.name) < p.radiusAU;
    }).map((m) => m.name);
    expect(carried).toContain('Cordelia');
    expect(carried).toContain('Naiad');
    expect(carried.length).toBeGreaterThanOrEqual(5);
  });

  it('leaves the planets themselves clear — the shell is honest about the Sun', () => {
    // The same policy on a planet: its shell is a ten-thousandth of its own
    // distance from the Sun, so nothing carries the camera into the star.
    const bounds = followBounds(
      JUPITER_R, 1e-3, JUPITER_MAP_R, JUPITER_MAP_R, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE,
    );
    expect(JUPITER_MAP_R - bounds.minDist).toBeGreaterThan(1);
  });
});
