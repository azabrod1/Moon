import { describe, it, expect } from 'vitest';
import {
  markerBehindDisc,
  markerInFrontOfDisc,
  markerSeparationPx,
  occlusionMarginPx,
  OCCLUSION_HYSTERESIS_MIN_PX,
} from './mapOcclusion';

// A chart-sized scene: 800 px tall at the map's 60° field, so one px at unit
// depth spans this much world. Every figure below is derived from it rather
// than assumed, so the numbers say what they mean at any viewport.
const WORLD_PER_PX_AT_UNIT = (2 * Math.tan((60 * Math.PI) / 180 / 2)) / 800;

/** World span of one screen px at `depth`. */
function perPx(depth: number): number {
  return WORLD_PER_PX_AT_UNIT * depth;
}

describe('markerSeparationPx', () => {
  it('measures the transverse offset, so depth along the view axis does not count', () => {
    // Same transverse position, 3 AU apart along the view axis: they project on
    // top of each other however far apart in space they are.
    expect(markerSeparationPx(0, 0, 5, 0, 0, 2, WORLD_PER_PX_AT_UNIT)).toBeCloseTo(0, 9);
  });

  it('scales each point by the world-per-px at its OWN depth', () => {
    // Ten px of offset at the disc's depth; the same world offset twice as far
    // away is five px. Reading both at one depth is the error this exists to
    // prevent.
    const near = markerSeparationPx(10 * perPx(2), 0, 2, 0, 0, 2, WORLD_PER_PX_AT_UNIT);
    const far = markerSeparationPx(10 * perPx(2), 0, 4, 0, 0, 2, WORLD_PER_PX_AT_UNIT);
    expect(near).toBeCloseTo(10, 6);
    expect(far).toBeCloseTo(5, 6);
  });

  it('answers "nowhere near" for a degenerate depth rather than a bogus hit', () => {
    expect(markerSeparationPx(0, 0, 0, 0, 0, 2, WORLD_PER_PX_AT_UNIT)).toBe(Infinity);
    expect(markerSeparationPx(0, 0, 2, 0, 0, -1, WORLD_PER_PX_AT_UNIT)).toBe(Infinity);
  });
});

describe('occlusionMarginPx', () => {
  it('bands at half the marker, with a floor for a sub-pixel one', () => {
    expect(occlusionMarginPx(9)).toBe(4.5);
    expect(occlusionMarginPx(0.2)).toBe(OCCLUSION_HYSTERESIS_MIN_PX);
    expect(occlusionMarginPx(0)).toBe(OCCLUSION_HYSTERESIS_MIN_PX);
  });
});

describe('markerBehindDisc', () => {
  // A moon sized like Io against a Jupiter drawn 18 px across the chart, one
  // parent-drawn-radius off to the side — the geometry the bug lived in.
  const PARENT_PX = 18;
  const MOON_PX = 4;
  const PARENT_DEPTH = 3;

  /** The moon at `offsetPx` from the parent's centre, `behind` or in front. */
  function moon(offsetPx: number, behind: boolean) {
    const depth = behind ? PARENT_DEPTH + 0.01 : PARENT_DEPTH - 0.01;
    const sep = markerSeparationPx(
      offsetPx * perPx(depth), 0, depth,
      0, 0, PARENT_DEPTH,
      WORLD_PER_PX_AT_UNIT,
    );
    return { depth, sep };
  }

  it('hides the marker behind the disc and keeps the one in front, at the same 3D distance', () => {
    // The failure exactly: both sit on the parent's centre on screen and the
    // same distance from it in space. Only the view-axis side differs, and the
    // old gate could not see it — its 3D-distance test was LARGEST for the one
    // that must be hidden.
    const back = moon(0, true);
    const front = moon(0, false);
    expect(back.sep).toBeCloseTo(front.sep, 6);
    expect(markerBehindDisc(
      true, back.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, back.sep, false,
    )).toBe(true);
    expect(markerBehindDisc(
      true, front.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, front.sep, false,
    )).toBe(false);
  });

  it('never hides a marker in front, whatever the last frame answered', () => {
    const front = moon(0, false);
    expect(markerBehindDisc(
      true, front.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, front.sep, true,
    )).toBe(false);
  });

  it('holds the last answer inside the limb band, and resolves it at both edges', () => {
    const margin = occlusionMarginPx(MOON_PX);
    const at = (offsetPx: number) => moon(offsetPx, true);
    // Inside the band: whichever way it arrived is what it stays.
    const edge = at(PARENT_PX);
    expect(markerBehindDisc(
      true, edge.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, edge.sep, true,
    )).toBe(true);
    expect(markerBehindDisc(
      true, edge.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, edge.sep, false,
    )).toBe(false);
    // Past the inner edge it is hidden even coming from shown; past the outer
    // edge it is shown even coming from hidden.
    const inside = at(PARENT_PX - margin - 0.5);
    expect(markerBehindDisc(
      true, inside.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, inside.sep, false,
    )).toBe(true);
    const outside = at(PARENT_PX + margin + 0.5);
    expect(markerBehindDisc(
      true, outside.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, outside.sep, true,
    )).toBe(false);
  });

  it('a parent drawn as a marker occludes nothing', () => {
    // The reveal regime the chart actually runs in: moons arrive while their
    // planet is still a dot, and a dot is a symbol — it hides nothing behind it.
    const back = moon(0, true);
    expect(markerBehindDisc(
      false, back.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, back.sep, false,
    )).toBe(false);
    // And a latch set while the parent was a globe does not survive the swap.
    expect(markerBehindDisc(
      false, back.depth, MOON_PX, PARENT_DEPTH, PARENT_PX, back.sep, true,
    )).toBe(false);
  });

  it('a disc no bigger than the marker cannot swallow it', () => {
    const back = moon(0, true);
    expect(markerBehindDisc(
      true, back.depth, PARENT_PX, PARENT_DEPTH, PARENT_PX, back.sep, false,
    )).toBe(false);
    expect(markerBehindDisc(
      true, back.depth, PARENT_PX + 1, PARENT_DEPTH, PARENT_PX, back.sep, false,
    )).toBe(false);
  });
});

describe('the Sun, both ways', () => {
  // The star drawn at the size policy's ceiling, a planet marker at the floor.
  const SUN_PX = 18;
  const SUN_DEPTH = 30;
  const PLANET_PX = 6;

  /** A planet `offsetPx` off the Sun's centre, beyond it or this side of it. */
  function planet(offsetPx: number, beyond: boolean) {
    const depth = beyond ? SUN_DEPTH + 5 : SUN_DEPTH - 5;
    const sep = markerSeparationPx(
      offsetPx * perPx(depth), 0, depth,
      0, 0, SUN_DEPTH,
      WORLD_PER_PX_AT_UNIT,
    );
    return { depth, sep };
  }

  it('culls a planet standing beyond the solar disc', () => {
    const far = planet(4, true);
    expect(markerBehindDisc(
      true, far.depth, PLANET_PX, SUN_DEPTH, SUN_PX, far.sep, false,
    )).toBe(true);
    // Beyond the Sun but clear of its disc is just a planet next to a star.
    const clear = planet(40, true);
    expect(markerBehindDisc(
      true, clear.depth, PLANET_PX, SUN_DEPTH, SUN_PX, clear.sep, false,
    )).toBe(false);
  });

  it('keeps a planet on this side of the disc, and composites it above', () => {
    const near = planet(4, false);
    expect(markerBehindDisc(
      true, near.depth, PLANET_PX, SUN_DEPTH, SUN_PX, near.sep, false,
    )).toBe(false);
    expect(markerInFrontOfDisc(
      true, near.depth, PLANET_PX, SUN_DEPTH, SUN_PX, near.sep,
    )).toBe(true);
  });

  it('lifts nothing that the disc was never going to paint over', () => {
    // Clear of the disc by more than the marker's own radius: the two
    // footprints do not touch, so the draw order is nothing to spend a frame on.
    const clear = planet(SUN_PX + PLANET_PX + 2, false);
    expect(markerInFrontOfDisc(
      true, clear.depth, PLANET_PX, SUN_DEPTH, SUN_PX, clear.sep,
    )).toBe(false);
    // Nor is anything lifted from BEYOND the disc — that one is culled, and
    // lifting it would paint the very marker the gate just hid.
    const beyond = planet(4, true);
    expect(markerInFrontOfDisc(
      true, beyond.depth, PLANET_PX, SUN_DEPTH, SUN_PX, beyond.sep,
    )).toBe(false);
  });

  it('lifts a body drawn wider than the disc it stands in front of', () => {
    // Jupiter resolved as a globe, crossing the Sun's chart marker: too big to
    // be hidden by it, and still painted over unless it is lifted.
    const near = planet(2, false);
    expect(markerBehindDisc(
      true, near.depth, 60, SUN_DEPTH, SUN_PX, near.sep, false,
    )).toBe(false);
    expect(markerInFrontOfDisc(
      true, near.depth, 60, SUN_DEPTH, SUN_PX, near.sep,
    )).toBe(true);
  });
});
