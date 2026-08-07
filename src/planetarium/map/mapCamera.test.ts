import { describe, it, expect } from 'vitest';
import {
  apparentDepthAU,
  clampFollowDistanceAU,
  followBounds,
  MAP_FOLLOW_MIN_SPREAD,
  mapCameraInitialState,
  mapCameraOwnsPose,
  mapCameraReduce,
  mapDiveEndFraction,
  mapFlightFramingDistanceAU,
  mapFocusEase,
  mapFocusLandPulse,
  mapOverviewBounds,
  mapFocusReleasable,
  mapOverviewAvailable,
  mapOverviewPivotDistanceAU,
  mapWorldPerPxAtUnitDepth,
  mapZoomAvailability,
  mapZoomNotchAvailable,
  mapZoomNotchDistanceAU,
  MAP_ZOOM_NOTCH_FACTOR,
  revealDistanceAU,
  moonRevealThresholdAU,
  MOON_REVEAL_PX,
  MAP_FOCUS_MIN_PX,
  MAP_FOCUS_PULSE_MS,
  MAP_FOCUS_REVEAL_PX,
  MAP_FOV_DEG,
  MAP_OVERVIEW_MIN_DIST_AU,
  MAP_OVERVIEW_MIN_DIST_FRAC,
  MAP_OVERVIEW_NEAR_FRAC,
  MAP_POLAR_MIN_RAD,
  MAP_POLAR_MAX_RAD,
  type MapCameraState,
} from './mapCamera';
import { MAP_BODY_SIZE_DEFAULTS, mapBodyRadiusAU, mapMarkerRadiusPx, mapSunRadiusAU } from './mapBodySize';
import { fitDistanceAU } from './mapProjection';
import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS, getMoonsByPlanet } from '../planets/moonData';
import { RING_CONFIGS } from '../planets/rings';

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
  ceilingRadiusAU = radiusAU,
  fitDistAU = 0,
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
    ceilingRadiusAU,
    fitDistAU,
    null,
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

describe('mapFocusReleasable', () => {
  const initial = mapCameraInitialState();
  const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Saturn' });
  const following = mapCameraReduce(inbound, { kind: 'flyLanded' });
  const leaving = mapCameraReduce(following, { kind: 'release' });
  const diving = mapCameraReduce(following, { kind: 'diveStart', camera: true });

  it('is true while flying to a body and while following it', () => {
    expect(mapFocusReleasable(inbound)).toBe(true);
    expect(mapFocusReleasable(following)).toBe(true);
  });

  it('is false on the overview, on the way back out, and during a dive', () => {
    expect(mapFocusReleasable(initial)).toBe(false);
    expect(mapFocusReleasable(leaving)).toBe(false);
    expect(mapFocusReleasable(diving)).toBe(false);
  });

  it('does not care whether the overview zoom has wandered', () => {
    // This is Esc's rung. A drifted overview is not a focus, so Esc closes the
    // map there — the whole reason this is a separate function from the chip's.
    expect(mapFocusReleasable(initial)).toBe(false);
  });
});

describe('mapOverviewAvailable', () => {
  const initial = mapCameraInitialState();
  const inbound = mapCameraReduce(initial, { kind: 'focus', name: 'Saturn' });
  const following = mapCameraReduce(inbound, { kind: 'flyLanded' });
  const leaving = mapCameraReduce(following, { kind: 'release' });
  const diving = mapCameraReduce(following, { kind: 'diveStart', camera: true });

  it('offers the way home while following a body, zoomed or not', () => {
    expect(mapOverviewAvailable(following, false)).toBe(true);
    expect(mapOverviewAvailable(following, true)).toBe(true);
  });

  it('shows at an overview whose zoom has wandered, and hides at a clean one', () => {
    expect(mapOverviewAvailable(initial, true)).toBe(true);
    expect(mapOverviewAvailable(initial, false)).toBe(false);
  });

  it('greys out while any move owns the camera, however the zoom sits', () => {
    for (const free of [false, true]) {
      // An inbound flight is releasable, but seating the overview on top of one
      // would fight the ease writing the pose that frame.
      expect(mapOverviewAvailable(inbound, free)).toBe(false);
      expect(mapOverviewAvailable(leaving, free)).toBe(false);
      expect(mapOverviewAvailable(diving, free)).toBe(false);
    }
  });

  it('offers everything the releasable predicate does, and one thing more', () => {
    for (const state of [initial, following, leaving, diving]) {
      if (mapFocusReleasable(state)) expect(mapOverviewAvailable(state, false)).toBe(true);
    }
    // The one thing more, and the only one.
    expect(mapFocusReleasable(initial)).toBe(false);
    expect(mapOverviewAvailable(initial, true)).toBe(true);
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

describe('the polar band', () => {
  it('is one contiguous interval: the full orbit minus a guard at each pole', () => {
    expect(MAP_POLAR_MIN_RAD).toBe(0.08);
    expect(MAP_POLAR_MAX_RAD).toBe(Math.PI - MAP_POLAR_MIN_RAD);
  });

  it('contains the canonical fit pose and both the edge-on and mirrored views', () => {
    // The open pose (0, 0.82, 0.57): polar = atan2(horizontal, north).
    const fitPolar = Math.atan2(0.57, 0.82);
    for (const polar of [fitPolar, Math.PI / 2, Math.PI - fitPolar]) {
      expect(polar).toBeGreaterThan(MAP_POLAR_MIN_RAD);
      expect(polar).toBeLessThan(MAP_POLAR_MAX_RAD);
    }
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
      JUPITER_R, leavingSurface, 1.5, 2.07, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE, JUPITER_R, 0,
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
        EARTH_R, 0.001, camOrigin, EARTH_MAP_R, EXTENT_TRUE, H, MAP_FOV_DEG, SIZE, EARTH_R, 0,
      );
      expect(b.far).toBeGreaterThan(camOrigin + EXTENT_TRUE);
    }
  });

  it('never opens the near plane past the overview\'s own during a flight', () => {
    // A flight starts at the whole-system fit: a quarter of THAT distance would
    // be a near plane slicing through the foreground.
    const b = followBounds(
      EARTH_R, 7, 7, EARTH_MAP_R, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE, EARTH_R, 0,
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

describe('moonRevealThresholdAU', () => {
  it('meets the moons at its own gate, exactly the px it declares', () => {
    const d = moonRevealThresholdAU(JUPITER_R, H, MAP_FOV_DEG);
    expect(discPx(JUPITER_R, d)).toBeCloseTo(MOON_REVEAL_PX, 6);
  });

  it('reveals farther out than the focus flight lands — the free approach meets moons first', () => {
    const reveal = moonRevealThresholdAU(JUPITER_R, H, MAP_FOV_DEG);
    const landing = revealDistanceAU(JUPITER_R, H, MAP_FOV_DEG);
    expect(reveal).toBeGreaterThan(landing);
  });

  it('keeps the whole-system overview planets-only: no planet crosses the gate at the fit', () => {
    // The overview fit for the compressed extent, desktop and portrait phone.
    for (const [w, h] of [[1280, 800], [390, 844]] as const) {
      const fit = fitDistanceAU(EXTENT_COMPRESSED, MAP_FOV_DEG, w / h);
      // Jupiter is the largest disc; if IT stays under the gate at the fit,
      // every planet does.
      const reveal = moonRevealThresholdAU(JUPITER_R, h, MAP_FOV_DEG);
      expect(reveal).toBeLessThan(fit);
    }
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
      m.radiusAU,
      0,
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
      JUPITER_R, 1e-3, JUPITER_MAP_R, JUPITER_MAP_R, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE, JUPITER_R, 0,
    );
    expect(JUPITER_MAP_R - bounds.minDist).toBeGreaterThan(1);
  });

  it('meters the zoom-out ceiling on a handed-in crossover, for a subject on its own size branch', () => {
    // The Sun crosses marker↔truth at its size branch's pivot, not at the
    // generic marker cap. The ceiling must ride the crossover it is handed:
    // retuning the pivot otherwise moves the drawn curve while the zoom clamp
    // stays on a disc the chart no longer draws.
    const at = (crossoverPx: number | null) => followBounds(
      SUN_DATA.radiusAU, 1e-3, 0.5, 0.5, EXTENT_COMPRESSED, H, MAP_FOV_DEG, SIZE,
      SUN_DATA.radiusAU, 0, crossoverPx,
    ).maxDist;
    // Null falls back to the generic marker — the pre-existing behaviour.
    expect(at(null)).toBeCloseTo(at(mapMarkerRadiusPx(SUN_DATA.radiusAU, SIZE)), 12);
    // A larger crossover px crosses NEARER the subject: the ceiling tightens.
    expect(at(36)).toBeLessThan(at(18));
    expect(at(18)).toBeCloseTo(at(null), 12); // pivot 18 == old cap: no drift at defaults
  });
});

describe('mapOverviewBounds', () => {
  const ASPECT = 16 / 9;
  const FIT = fitDistanceAU(EXTENT_COMPRESSED, MAP_FOV_DEG, ASPECT);
  // Parked on the opening fit, the only surface anywhere near the camera is
  // the Sun's drawn disc at the far end of the view — sized on the Sun's OWN
  // zoom-responsive branch, exactly as the chart draws it.
  const SUN_DRAWN = mapSunRadiusAU(
    SUN_DATA.radiusAU, FIT, mapWorldPerPxAtUnitDepth(H, MAP_FOV_DEG),
  );
  const PARKED_CLEARANCE = FIT - SUN_DRAWN;
  const parked = (clearance = PARKED_CLEARANCE) =>
    mapOverviewBounds(EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, FIT, clearance);

  it('leaves the parked overview\'s near plane and zoom-out limit exactly as they were', () => {
    // The chart's own near plane and a little past the fit: the figures the map
    // has always framed the parked overview with, unchanged to the last bit.
    const b = parked();
    expect(b.near).toBe(Math.max(EXTENT_COMPRESSED * MAP_OVERVIEW_NEAR_FRAC, 1e-4));
    expect(b.maxDist).toBe(FIT * 1.8);
  });

  it('holds the whole drawn scene inside the far plane from wherever the camera is', () => {
    for (const camOrigin of [0.01, 1, FIT, 40]) {
      const b = mapOverviewBounds(
        EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, camOrigin, PARKED_CLEARANCE,
      );
      expect(b.far).toBeGreaterThan(camOrigin + EXTENT_COMPRESSED);
    }
  });

  it('reaches past a revealed system\'s rings, not just its parent\'s orbit', () => {
    // A moon system stands its drawn orbits off its parent, and the frame a
    // release flight lands on still draws them.
    const ringReach = 6e-3;
    const camOrigin = JUPITER_MAP_R;
    const b = mapOverviewBounds(
      EXTENT_COMPRESSED, EXTENT_COMPRESSED + ringReach, FIT, camOrigin, 1e-3,
    );
    expect(b.far).toBeGreaterThan(camOrigin + EXTENT_COMPRESSED + ringReach);
    // A rendered extent narrower than the chart cannot pull the far plane in
    // behind the chart itself.
    const narrowed = mapOverviewBounds(EXTENT_COMPRESSED, 0, FIT, camOrigin, 1e-3);
    expect(narrowed.far).toBeGreaterThan(camOrigin + EXTENT_COMPRESSED);
  });

  it('tightens the near plane once the camera is genuinely close to something', () => {
    const surface = 4e-3;
    const b = mapOverviewBounds(
      EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, JUPITER_MAP_R, surface,
    );
    expect(b.near).toBe(surface * 0.25);
    expect(b.near).toBeLessThan(parked().near);
  });

  it('never lets the near plane collapse: the ratio floor and an absolute one', () => {
    // A chart small enough that a thousandth of it is nothing, seen from far
    // out: the depth buffer's ratio is what holds the plane up.
    const ratioBound = mapOverviewBounds(1e-3, 50, FIT, 50, 1e-9);
    expect(ratioBound.near).toBeCloseTo(ratioBound.far / 3e4, 15);
    // And the absolute floor underneath that.
    const tiny = mapOverviewBounds(1e-3, 1e-3, FIT, 0, 1e-9);
    expect(tiny.near).toBe(1e-4);
  });

  it('drops the near plane to its floors when the camera is inside a shell', () => {
    // Threading past a body puts the nearest clearance at zero or below. The
    // chart's own term is a thousandth of the whole system — from inside a
    // shell that plane would cut the body away along with everything else near
    // it, so only the floors are left standing.
    for (const clearance of [0, -1e-3, -5, Number.NaN]) {
      const b = parked(clearance);
      expect(b.near).toBe(Math.max(b.far / 3e4, 1e-4));
      expect(b.near).toBeGreaterThan(0);
      expect(b.near).toBeLessThan(parked().near);
    }
  });

  it('keeps a body drawable from inside its own drawn shell', () => {
    // Saturn wears an annulus more than twice its radius, so a camera can be
    // inside the drawn shell and still an appreciable distance off the globe.
    // The near plane has to sit well in front of that surface or the frame goes
    // empty exactly where the subject is.
    const saturnGlobe = 3.893e-4;
    const insideTheRing = 5e-4;                   // camera this far off the globe
    const b = mapOverviewBounds(
      EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, 1.9, -4e-4,
    );
    expect(b.near).toBeLessThan(insideTheRing);
    expect(b.near).toBeLessThan(saturnGlobe);
  });

  it('leaves the chart\'s own term standing when nothing can be metered', () => {
    // Infinity is not "inside a shell", it is "no surface known" — a chart with
    // nothing drawn to measure against keeps the parked plane.
    expect(parked(Infinity).near).toBe(parked().near);
  });

  it('caps how close the camera may come in absolute AU, not only as a fraction', () => {
    // On the compressed chart the fraction is thirty times the cap, and at true
    // scale five hundred times: without the cap the small systems would sit
    // permanently outside the zoom's reach.
    for (const extent of [EXTENT_COMPRESSED, EXTENT_TRUE, 120]) {
      const b = mapOverviewBounds(extent, extent, FIT, FIT, PARKED_CLEARANCE);
      expect(b.minDist).toBe(MAP_OVERVIEW_MIN_DIST_AU);
    }
    // A chart small enough for the fraction to bind first still gets it.
    const tiny = mapOverviewBounds(0.05, 0.05, FIT, FIT, PARKED_CLEARANCE);
    expect(tiny.minDist).toBe(0.05 * MAP_OVERVIEW_MIN_DIST_FRAC);
  });

  it('moves each number in one direction only', () => {
    let prevFar = 0;
    for (const camOrigin of [0, 1, 5, 40]) {
      const b = mapOverviewBounds(
        EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, camOrigin, PARKED_CLEARANCE,
      );
      expect(b.far).toBeGreaterThan(prevFar);
      prevFar = b.far;
    }
    let prevNear = 0;
    for (const surface of [1e-4, 1e-3, 1e-2, 1, 100]) {
      const b = parked(surface);
      expect(b.near).toBeGreaterThanOrEqual(prevNear);
      prevNear = b.near;
    }
    let prevMax = 0;
    for (const extent of [0.5, EXTENT_COMPRESSED, EXTENT_TRUE]) {
      const fit = fitDistanceAU(extent, MAP_FOV_DEG, ASPECT);
      const b = mapOverviewBounds(extent, extent, fit, fit, PARKED_CLEARANCE);
      expect(b.maxDist).toBeGreaterThan(prevMax);
      prevMax = b.maxDist;
    }
  });

  it('fills a caller\'s object instead of allocating one', () => {
    const out = { minDist: 0, maxDist: 0, near: 0, far: 0 };
    expect(mapOverviewBounds(
      EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, FIT, PARKED_CLEARANCE, out,
    )).toBe(out);
    expect(out.far).toBeGreaterThan(0);
  });
});

describe('mapOverviewPivotDistanceAU', () => {
  const ASPECT = 16 / 9;
  const FIT = fitDistanceAU(EXTENT_COMPRESSED, MAP_FOV_DEG, ASPECT);
  const BOUNDS = mapOverviewBounds(EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, FIT, FIT);
  const pivot = (clearance: number) =>
    mapOverviewPivotDistanceAU(clearance, BOUNDS.minDist, BOUNDS.maxDist);

  it('takes over from the parked pose without moving the frame', () => {
    // Parked, the nearest surface is the Sun's own drawn disc at the far end of
    // the view, so the first re-seat lands the pivot within that disc of where
    // the target already sat — a hair, not a jump.
    const sunDrawn = mapSunRadiusAU(
      SUN_DATA.radiusAU, FIT, mapWorldPerPxAtUnitDepth(H, MAP_FOV_DEG),
    );
    const moved = Math.abs(pivot(FIT - sunDrawn) - FIT);
    expect(moved).toBeCloseTo(sunDrawn, 12);
    expect(moved / FIT).toBeLessThan(0.03);
  });

  it('is held inside the shell the overview may orbit in', () => {
    expect(pivot(1e-9)).toBe(BOUNDS.minDist);
    expect(pivot(1e6)).toBe(BOUNDS.maxDist);
    expect(pivot(0.5)).toBe(0.5);
  });

  it('floors a camera inside the nearest surface rather than inverting the pivot', () => {
    for (const clearance of [0, -1e-3, -50, Number.NaN]) {
      expect(pivot(clearance)).toBe(BOUNDS.minDist);
    }
  });

  it('survives a shell handed over inside out', () => {
    expect(mapOverviewPivotDistanceAU(1, 5, 2)).toBe(5);
    expect(mapOverviewPivotDistanceAU(1, -3, -1)).toBe(0);
  });
});

describe('the zoom buttons', () => {
  // The shells a press is actually clamped into: the free overview's, and the
  // ones a follow gets on a planet and on a moon. Catalog figures throughout —
  // a notch is a fraction, so the only way to know a press does something
  // visible is to spend it inside a real shell.
  const ASPECT = 16 / 9;
  const FIT = fitDistanceAU(EXTENT_COMPRESSED, MAP_FOV_DEG, ASPECT);
  const OVERVIEW = mapOverviewBounds(EXTENT_COMPRESSED, EXTENT_COMPRESSED, FIT, FIT, FIT);
  // Following Jupiter from the reveal landing, with the ε-12 ceiling in place:
  // the shell is bounded by the marker crossover, capped at the overview fit.
  const JUPITER_FOLLOW = boundsAt(
    JUPITER_R, JUPITER_MAP_R, revealDistanceAU(JUPITER_R, H, MAP_FOV_DEG),
    EXTENT_COMPRESSED, JUPITER_R, FIT,
  );
  const io = MOONS.find((m) => m.name === 'Io')!;
  // A moon rides its parent's map position, and its own shell is metered on a
  // body two orders of magnitude smaller — the regime the same predicate has to
  // hold in at the other end of the chart.
  const IO_FOLLOW = boundsAt(
    io.radiusAU, JUPITER_MAP_R, io.radiusAU * 200, EXTENT_COMPRESSED, io.radiusAU, FIT,
  );

  const availAt = (dist: number, b: { minDist: number; maxDist: number }) =>
    mapZoomAvailability(dist, b.minDist, b.maxDist);

  it('spends one factor per notch, in the direction asked for', () => {
    const d = 1;
    expect(mapZoomNotchDistanceAU(d, 1, 0, 1e9)).toBeCloseTo(d / MAP_ZOOM_NOTCH_FACTOR, 12);
    expect(mapZoomNotchDistanceAU(d, -1, 0, 1e9)).toBeCloseTo(d * MAP_ZOOM_NOTCH_FACTOR, 12);
  });

  it('compounds, so a held repeat is the same arithmetic run several times', () => {
    let stepped = 1;
    for (let i = 0; i < 7; i++) stepped = mapZoomNotchDistanceAU(stepped, 1, 0, 1e9);
    expect(mapZoomNotchDistanceAU(1, 7, 0, 1e9)).toBeCloseTo(stepped, 12);
  });

  it('is a step worth pressing for and not a jump — a quarter of the way', () => {
    // The whole point of the pair: one press has to be visible. A twentieth
    // (the wheel's own notch) would read as a dead button.
    const moved = 1 - 1 / MAP_ZOOM_NOTCH_FACTOR;
    expect(moved).toBeGreaterThan(0.1);
    expect(moved).toBeLessThan(0.35);
  });

  it('never leaves the shell it was handed', () => {
    expect(mapZoomNotchDistanceAU(0.5, 40, 0.2, 3)).toBe(0.2);
    expect(mapZoomNotchDistanceAU(0.5, -40, 0.2, 3)).toBe(3);
    // A shell handed over inside out still answers with a distance inside it.
    expect(mapZoomNotchDistanceAU(1, 1, 5, 2)).toBe(5);
  });

  it('answers a distance that is not one with the floor, not a NaN', () => {
    for (const d of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = mapZoomNotchDistanceAU(d, 1, 0.2, 3);
      expect(Number.isFinite(out)).toBe(true);
    }
    expect(mapZoomNotchDistanceAU(0, 1, 0.2, 3)).toBe(0.2);
  });

  it('offers both ways at the parked overview fit', () => {
    const a = availAt(FIT, OVERVIEW);
    expect(a.zoomIn).toBe(true);
    expect(a.zoomOut).toBe(true);
    // Non-vacuous: the fit really is inside the overview shell.
    expect(FIT).toBeGreaterThan(OVERVIEW.minDist);
    expect(FIT).toBeLessThan(OVERVIEW.maxDist);
  });

  it('stops zooming out at the overview ceiling, and in at its floor', () => {
    const out = availAt(OVERVIEW.maxDist, OVERVIEW);
    expect(out.zoomOut).toBe(false);
    expect(out.zoomIn).toBe(true);
    const inn = availAt(OVERVIEW.minDist, OVERVIEW);
    expect(inn.zoomIn).toBe(false);
    expect(inn.zoomOut).toBe(true);
  });

  it('reaches the overview floor from the fit in a countable run of presses', () => {
    // What a held button actually does. It has to terminate, and it has to
    // terminate at the floor rather than short of it.
    let dist = FIT;
    let presses = 0;
    while (mapZoomNotchAvailable(dist, 1, OVERVIEW.minDist, OVERVIEW.maxDist)) {
      dist = mapZoomNotchDistanceAU(dist, 1, OVERVIEW.minDist, OVERVIEW.maxDist);
      presses++;
      expect(presses).toBeLessThan(500);
    }
    expect(dist).toBe(OVERVIEW.minDist);
    // Five decades of chart in a run a held button covers in a few seconds.
    expect(presses).toBeGreaterThan(20);
    expect(presses).toBeLessThan(80);
  });

  it('holds a planet follow inside the ε-12 ceiling', () => {
    const landed = revealDistanceAU(JUPITER_R, H, MAP_FOV_DEG);
    const a = availAt(landed, JUPITER_FOLLOW);
    expect(a.zoomIn).toBe(true);
    expect(a.zoomOut).toBe(true);
    // At the ceiling the way out is shut — the stress probe's 2,275 AU ride
    // was exactly this predicate having nothing to bind against.
    expect(availAt(JUPITER_FOLLOW.maxDist, JUPITER_FOLLOW).zoomOut).toBe(false);
    expect(availAt(JUPITER_FOLLOW.minDist, JUPITER_FOLLOW).zoomIn).toBe(false);
    expect(JUPITER_FOLLOW.maxDist).toBeLessThanOrEqual(FIT);
  });

  it('holds a moon follow inside its own, much smaller shell', () => {
    // A different scale of shell entirely — a hundredth of the whole chart's.
    expect(IO_FOLLOW.maxDist).toBeLessThan(FIT / 50);
    expect(availAt(IO_FOLLOW.maxDist, IO_FOLLOW).zoomOut).toBe(false);
    expect(availAt(IO_FOLLOW.minDist, IO_FOLLOW).zoomIn).toBe(false);
    const mid = Math.sqrt(IO_FOLLOW.minDist * IO_FOLLOW.maxDist);
    const a = availAt(mid, IO_FOLLOW);
    expect(a.zoomIn).toBe(true);
    expect(a.zoomOut).toBe(true);
  });

  it('sends a camera outside its shell back IN, and refuses to call that a way out', () => {
    // The shell can move under a parked camera (the chart's extent changes with
    // the scale blend). Asking to go further must not be answered by a step
    // that goes closer.
    const stranded = JUPITER_FOLLOW.maxDist * 4;
    const a = availAt(stranded, JUPITER_FOLLOW);
    expect(a.zoomOut).toBe(false);
    expect(a.zoomIn).toBe(true);
    expect(mapZoomNotchDistanceAU(stranded, 1, JUPITER_FOLLOW.minDist, JUPITER_FOLLOW.maxDist))
      .toBe(JUPITER_FOLLOW.maxDist);
  });

  it('treats no notch at all as no movement', () => {
    for (const n of [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(mapZoomNotchAvailable(FIT, n, OVERVIEW.minDist, OVERVIEW.maxDist)).toBe(false);
    }
  });

  it('refuses to move a camera that is nowhere', () => {
    for (const d of [0, -1, Number.NaN]) {
      expect(mapZoomNotchAvailable(d, 1, OVERVIEW.minDist, OVERVIEW.maxDist)).toBe(false);
      expect(mapZoomNotchAvailable(d, -1, OVERVIEW.minDist, OVERVIEW.maxDist)).toBe(false);
    }
  });

  it('fills a caller scratch rather than allocating one per frame', () => {
    const scratch = { zoomIn: false, zoomOut: false };
    const returned = mapZoomAvailability(FIT, OVERVIEW.minDist, OVERVIEW.maxDist, scratch);
    expect(returned).toBe(scratch);
    expect(scratch.zoomIn).toBe(true);
  });
});

describe('the overview zoom against every moon system', () => {
  // The compressed chart's radial curve, and the two viewports the map ships
  // for: a desktop window and a phone held upright.
  const mapRadiusOf = (semiMajorAxisAU: number) => 0.6 * Math.asinh(semiMajorAxisAU / 0.6);
  const ASPECT = 16 / 9;
  const parents = PLANETARIUM_BODIES.filter((p) => getMoonsByPlanet(p.name).length > 0);

  /** How close the camera has to be for a parent's moons to appear, and how
   *  much of that distance the parent's own drawn body (ring included) takes
   *  up. Everything is evaluated AT the shell, which is the tightest the pair
   *  ever gets: the reveal margin the map actually carries is above 1, and the
   *  drawn body is larger the further out you measure it. */
  function shellAndClearance(
    name: string,
    radiusAU: number,
    subjectMapR: number,
    viewportH: number,
    extentAU: number,
  ): { shell: number; clearance: number } {
    const perPx = mapWorldPerPxAtUnitDepth(viewportH, MAP_FOV_DEG);
    const reveal = revealDistanceAU(radiusAU, viewportH, MAP_FOV_DEG);
    const drawn = mapBodyRadiusAU(radiusAU, reveal, perPx, SIZE);
    const bounds = followBounds(
      drawn, 1e-3, subjectMapR, subjectMapR, extentAU, viewportH, MAP_FOV_DEG, SIZE, drawn, 0,
    );
    const shell = Math.max(reveal, bounds.minDist);
    const clearance = mapBodyRadiusAU(radiusAU, shell, perPx, SIZE)
      * (RING_CONFIGS[name]?.outerFactor ?? 1);
    return { shell, clearance };
  }

  /** Every combination the shipped map can be in: both viewports, the
   *  compressed chart, true scale, and a chart widened by a ship far past
   *  Pluto. */
  function sweep(visit: (p: {
    name: string; shell: number; clearance: number; minDist: number; maxDist: number; label: string;
  }) => void): void {
    for (const planet of parents) {
      for (const viewportH of [900, 844]) {
        for (const [extent, mapR] of [
          [EXTENT_COMPRESSED, mapRadiusOf(planet.semiMajorAxisAU)],
          [EXTENT_TRUE, planet.semiMajorAxisAU],
          [120, mapRadiusOf(planet.semiMajorAxisAU)],
        ] as const) {
          const { shell, clearance } = shellAndClearance(
            planet.name, planet.radiusAU, mapR, viewportH, extent,
          );
          const fit = fitDistanceAU(extent, MAP_FOV_DEG, ASPECT);
          const b = mapOverviewBounds(extent, extent, fit, mapR, shell - clearance);
          visit({
            name: planet.name,
            shell,
            clearance,
            minDist: b.minDist,
            maxDist: b.maxDist,
            label: `${planet.name} h${viewportH} extent ${extent}`,
          });
        }
      }
    }
  }

  it('covers the systems the chart actually draws', () => {
    expect(parents.map((p) => p.name)).toEqual([
      'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
    ]);
  });

  it('can be clamped closer than every system\'s reveal shell', () => {
    // The zoom stops at minDist from the nearest drawn surface, so the moons
    // are reachable exactly when that stop is inside the shell — for every
    // parent, on both viewports, at both scales, and on a widened chart.
    sweep(({ shell, clearance, minDist, label }) => {
      expect(minDist, label).toBeLessThan(shell - clearance);
    });
  });

  it('still has somewhere to go at the shell, so no notch is a dead one', () => {
    // The pivot at the shell sits strictly above the floor, so the next notch
    // closes a fraction of a real gap rather than clamping onto itself.
    sweep(({ shell, clearance, minDist, maxDist, label }) => {
      const gap = shell - clearance;
      const p = mapOverviewPivotDistanceAU(gap, minDist, maxDist);
      expect(p, label).toBeGreaterThan(minDist);
      // A 5% notch closes 5% of the gap: the travel budget refills instead of
      // running out at the frame the zoom started from.
      expect(p * 0.05, label).toBeGreaterThan(0);
      expect(p, label).toBeCloseTo(gap, 12);
    });
  });
});

describe('mapFocusLandPulse', () => {
  it('is nothing before it starts and nothing after it ends', () => {
    expect(mapFocusLandPulse(-1)).toBe(0);
    expect(mapFocusLandPulse(-0.0001)).toBe(0);
    expect(mapFocusLandPulse(Number.NaN)).toBe(0);
    expect(mapFocusLandPulse(MAP_FOCUS_PULSE_MS)).toBe(0);
    expect(mapFocusLandPulse(MAP_FOCUS_PULSE_MS + 1)).toBe(0);
    expect(mapFocusLandPulse(1e6)).toBe(0);
  });

  it('starts at nothing and reaches full on the first swell', () => {
    expect(mapFocusLandPulse(0)).toBeCloseTo(0, 12);
    expect(mapFocusLandPulse(MAP_FOCUS_PULSE_MS / 4)).toBeCloseTo(1, 12);
  });

  it('swells twice, the second time smaller', () => {
    const first = mapFocusLandPulse(MAP_FOCUS_PULSE_MS / 4);
    const second = mapFocusLandPulse((3 * MAP_FOCUS_PULSE_MS) / 4);
    expect(first).toBeCloseTo(1, 12);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
    // And it touches nothing between them, which is what makes it two swells
    // rather than one long one.
    expect(mapFocusLandPulse(MAP_FOCUS_PULSE_MS / 2)).toBeCloseTo(0, 12);
  });

  it('never leaves [0, 1], and peaks only twice', () => {
    let peaks = 0;
    let prev = mapFocusLandPulse(-10);
    let rising = false;
    for (let t = 0; t <= MAP_FOCUS_PULSE_MS + 20; t += 1) {
      const v = mapFocusLandPulse(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v > prev) rising = true;
      else if (rising && v < prev) { peaks++; rising = false; }
      prev = v;
    }
    expect(peaks).toBe(2);
  });
});

describe('the follow ceiling stands still', () => {
  // The stress probe rode a planet-follow to 2,275 AU: the ceiling was metered
  // on the DRAWN radius, which pins to its pixel floor and grows with camera
  // depth, so maxDistance stayed 1.836× the current distance through four
  // decades and the clamp never bound. These pin the fix: the ceiling reads
  // the camera-independent radius and the overview fit, and only the shell's
  // near side follows the drawn regime.
  const TRUE_R = JUPITER_R;

  it('holds one ceiling while the drawn radius rides the camera out', () => {
    // The same body seen at two depths: the px floor makes the drawn radius
    // grow tenfold; the ceiling must not move with it.
    const nearSeat = boundsAt(TRUE_R, 5.2, 0.05, EXTENT_COMPRESSED, TRUE_R);
    const farSeat = boundsAt(TRUE_R * 10, 5.2, 0.5, EXTENT_COMPRESSED, TRUE_R);
    expect(farSeat.maxDist).toBeCloseTo(nearSeat.maxDist, 12);
  });

  it('answers the probe: the clamp binds instead of chasing', () => {
    // At the failure's geometry the old ceiling was ~1.8× whatever the camera
    // did. With the true radius metering it, the ceiling is a fixed depth a
    // wheel can actually reach.
    const b = boundsAt(TRUE_R, 5.2, 0.05, EXTENT_COMPRESSED, TRUE_R);
    expect(Number.isFinite(b.maxDist)).toBe(true);
    expect(b.maxDist).toBeLessThan(EXTENT_COMPRESSED);
  });

  it('never follows past the overview fit', () => {
    const fit = 2.5;
    const b = boundsAt(TRUE_R, 5.2, 0.05, EXTENT_COMPRESSED, TRUE_R * 500, fit);
    expect(b.maxDist).toBe(fit);
  });

  it('keeps the shell wider than its own floor even under a tiny fit', () => {
    const b = boundsAt(TRUE_R, 5.2, 0.05, EXTENT_COMPRESSED, TRUE_R, 1e-9);
    expect(b.maxDist).toBeGreaterThanOrEqual(b.minDist * MAP_FOLLOW_MIN_SPREAD);
  });
});
