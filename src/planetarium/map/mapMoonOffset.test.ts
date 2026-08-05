/**
 * The moon-offset contract, swept over the whole catalog.
 *
 * This is the shape of the policy, not a spot-check: every one of the 65 moons
 * is evaluated at periapsis, mean and apoapsis, in every system, and the
 * properties asserted here ARE the contract — monotonicity through the bound
 * runs and the squeeze's fixed point and the zone kink, clearance and cap,
 * near-real adjacent steps among the regulars, and the interval-overlap
 * fidelity that separates a chart from an orrery.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildMoonOffsetPolicy,
  mapMoonCurveR,
  mapMoonOffsetR,
  moonOffsetEntries,
  moonOffsetPolicyFor,
  setMapMoonOffsetParams,
  mapMoonOffsetParams,
  setMapRingOuterFactors,
  effectiveClearanceR,
  mapRingOuterFactor,
  sanitizeMoonOffsetParams,
  MAP_MOON_OFFSET_DEFAULTS,
  type MoonOffsetEntry,
} from './mapMoonOffset';
import goldens from './moonOffset.goldens.json';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { MOONS } from '../planets/moonData';
import {
  clampFollowDistanceAU,
  followBounds,
  mapWorldPerPxAtUnitDepth,
  revealDistanceAU,
  MAP_FOV_DEG,
} from './mapCamera';
import { mapBodyRadiusAU, MAP_BODY_SIZE_DEFAULTS } from './mapBodySize';

const P = MAP_MOON_OFFSET_DEFAULTS;
const SIZE = MAP_BODY_SIZE_DEFAULTS;
/** Systems with at least one moon, which is every planet but Mercury and Venus. */
const SYSTEMS = PLANETARIUM_BODIES.filter((p) => moonOffsetEntries(p.name).length > 0);
/** The compressed chart reaches Pluto's aphelion. */
const EXTENT_COMPRESSED = 2.93;
/** The map's compressed radial curve, for a parent's own map-space radius. */
const mapRadiusOf = (semiMajorAxisAU: number) => 0.6 * Math.asinh(semiMajorAxisAU / 0.6);

/** Two moons ride one orbit when their mean distances agree to within 1%. The
 *  catalog holds real co-orbital groups — Telesto and Calypso on Tethys's
 *  orbit, Helene on Dione's, Janus and Epimetheus swapping theirs — and any
 *  strictly increasing map sends equal x to equal r. Ordering is asserted
 *  ACROSS groups and never within one. */
function coOrbitalGroups(entries: readonly MoonOffsetEntry[]): MoonOffsetEntry[][] {
  const groups: MoonOffsetEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && Math.abs(e.meanX - prev.meanX) / ((e.meanX + prev.meanX) / 2) < 0.01) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

/** Where a focus flight on this parent lands, and how many screen px one drawn
 *  parent radius is worth there — the framing the rings are read at. */
function revealFraming(parent: { radiusAU: number; semiMajorAxisAU: number }, viewportH: number) {
  const mapR = mapRadiusOf(parent.semiMajorAxisAU);
  const bounds = followBounds(
    parent.radiusAU, 1e-3, mapR, mapR, EXTENT_COMPRESSED, viewportH, MAP_FOV_DEG, SIZE, parent.radiusAU, 0,
  );
  const perPxUnit = mapWorldPerPxAtUnitDepth(viewportH, MAP_FOV_DEG);
  const dist = clampFollowDistanceAU(
    revealDistanceAU(parent.radiusAU, viewportH, MAP_FOV_DEG), bounds,
  );
  const drawnAU = mapBodyRadiusAU(parent.radiusAU, dist, perPxUnit, SIZE);
  return { bounds, dist, drawnAU, pxPerRadius: drawnAU / (perPxUnit * dist) };
}

describe('the two-zone curve', () => {
  it('pins Io on its anchor, which is what fixes zone 1', () => {
    const io = moonOffsetEntries('Jupiter').find((e) => e.name === 'Io')!;
    expect(mapMoonCurveR(io.meanX)).toBeCloseTo(P.ioAnchorR, 12);
  });

  it('puts the catalog\'s farthest apoapsis exactly on the cap', () => {
    let farthest = { name: '', apoX: 0 };
    for (const planet of SYSTEMS) {
      for (const e of moonOffsetEntries(planet.name)) {
        if (e.apoX > farthest.apoX) farthest = { name: e.name, apoX: e.apoX };
      }
    }
    // Neso, on an orbit half as wide again as its mean distance.
    expect(farthest.name).toBe('Neso');
    expect(mapMoonCurveR(farthest.apoX)).toBeCloseTo(P.capR, 12);
  });

  it('is continuous across the zone boundary', () => {
    const at = mapMoonCurveR(P.x0);
    expect(mapMoonCurveR(P.x0 - 1e-9)).toBeCloseTo(at, 9);
    expect(mapMoonCurveR(P.x0 + 1e-9)).toBeCloseTo(at, 9);
  });

  it('is strictly increasing from the parent\'s surface to past the farthest moon', () => {
    let prev = -Infinity;
    for (let x = 0.01; x < 3200; x *= 1.01) {
      const r = mapMoonCurveR(x);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });
});

describe('every system, swept', () => {
  it('charts one strictly increasing function of x — through the bound run, the squeeze\'s fixed point and the kink', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const entries = moonOffsetEntries(planet.name);
      const lo = Math.min(...entries.map((e) => e.periX)) * 0.9;
      const hi = Math.max(...entries.map((e) => e.apoX)) * 1.1;
      let prev = -Infinity;
      for (let x = lo; x < hi; x *= 1.005) {
        const r = mapMoonOffsetR(policy, x);
        expect(r, `${planet.name} at x=${x}`).toBeGreaterThan(prev);
        prev = r;
      }
    }
  });

  it('holds every moon outside the parent, at periapsis as well as on average', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      for (const e of moonOffsetEntries(planet.name)) {
        expect(mapMoonOffsetR(policy, e.periX), `${e.name} periapsis`)
          .toBeGreaterThanOrEqual(P.clearanceR);
      }
    }
  });

  it('holds every moon inside the cap, at apoapsis as well as on average', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      for (const e of moonOffsetEntries(planet.name)) {
        expect(mapMoonOffsetR(policy, e.apoX), `${e.name} apoapsis`)
          .toBeLessThanOrEqual(P.capR + 1e-12);
      }
    }
  });

  it('orders the moons of a system across co-orbital groups, and never inside one', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const groups = coOrbitalGroups(moonOffsetEntries(planet.name));
      for (let i = 1; i < groups.length; i++) {
        const inner = groups[i - 1][groups[i - 1].length - 1];
        const outer = groups[i][0];
        expect(mapMoonOffsetR(policy, outer.meanX), `${planet.name} ${inner.name}→${outer.name}`)
          .toBeGreaterThan(mapMoonOffsetR(policy, inner.meanX));
      }
      // Inside a group nothing is ordered, because there is no order to claim:
      // the members' mean rings land within a pixel of each other at the
      // framing a focus arrives on, which is what "sharing a ring" means on a
      // chart.
      const { pxPerRadius } = revealFraming(planet, 844);
      for (const group of groups) {
        if (group.length < 2) continue;
        const r0 = mapMoonOffsetR(policy, group[0].meanX);
        for (const e of group) {
          const gapPx = Math.abs(mapMoonOffsetR(policy, e.meanX) - r0) * pxPerRadius;
          expect(gapPx, `${planet.name} ${group[0].name}/${e.name}`).toBeLessThan(1);
        }
      }
    }
  });

  it('shares one ring between the catalog\'s true co-orbitals', () => {
    const saturn = moonOffsetPolicyFor('Saturn');
    const x = (name: string) => moonOffsetEntries('Saturn').find((e) => e.name === name)!.meanX;
    const r = (name: string) => mapMoonOffsetR(saturn, x(name));
    // Telesto and Calypso ride Tethys's orbit; Helene rides Dione's.
    expect(r('Telesto')).toBeCloseTo(r('Tethys'), 6);
    expect(r('Calypso')).toBeCloseTo(r('Tethys'), 6);
    expect(r('Helene')).toBeCloseTo(r('Dione'), 3);
    // Janus and Epimetheus swap nearly-identical orbits.
    expect(r('Janus')).toBeCloseTo(r('Epimetheus'), 3);
  });
});

describe('near-real adjacent steps among the regulars', () => {
  // Both moons of an adjacent unbound zone-1 pair sit in the identity region,
  // so the mapped ratio is the true ratio to the power γ, exactly. The step
  // error is what "near-real" means as a measured claim; non-adjacent pairs
  // compound by design (Io→Callisto reads ~26% compressed) and nothing is
  // claimed about them.
  const STEP_CEILING = 0.21;

  function adjacentZone1Pairs(planetName: string) {
    const policy = moonOffsetPolicyFor(planetName);
    const groups = coOrbitalGroups(moonOffsetEntries(planetName))
      .map((g) => g[0])
      .filter((e) => e.meanX <= P.x0 && mapMoonCurveR(e.meanX) >= policy.fixedPoint);
    const pairs: Array<[MoonOffsetEntry, MoonOffsetEntry]> = [];
    for (let i = 1; i < groups.length; i++) pairs.push([groups[i - 1], groups[i]]);
    return pairs;
  }

  it('maps an adjacent unbound zone-1 step to exactly the true ratio to the power gamma', () => {
    let checked = 0;
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      for (const [inner, outer] of adjacentZone1Pairs(planet.name)) {
        const mapped = mapMoonOffsetR(policy, outer.meanX) / mapMoonOffsetR(policy, inner.meanX);
        const truth = outer.meanX / inner.meanX;
        expect(mapped, `${inner.name}→${outer.name}`).toBeCloseTo(Math.pow(truth, P.gamma), 10);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it('keeps every one of those steps inside the 21% ceiling', () => {
    const worst = { pair: '', err: 0 };
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      for (const [inner, outer] of adjacentZone1Pairs(planet.name)) {
        const mapped = mapMoonOffsetR(policy, outer.meanX) / mapMoonOffsetR(policy, inner.meanX);
        const truth = outer.meanX / inner.meanX;
        const err = 1 - mapped / truth;
        if (err > worst.err) { worst.err = err; worst.pair = `${inner.name}→${outer.name}`; }
      }
    }
    // The catalog's worst adjacent gap is Proteus→Triton; the Galileans run 9–11%.
    expect(worst.pair).toBe('Proteus→Triton');
    expect(worst.err).toBeLessThan(STEP_CEILING);
  });

  it('holds the Galilean steps near-real', () => {
    const policy = moonOffsetPolicyFor('Jupiter');
    const e = (name: string) => moonOffsetEntries('Jupiter').find((x) => x.name === name)!;
    const step = (a: string, b: string) =>
      1 - (mapMoonOffsetR(policy, e(b).meanX) / mapMoonOffsetR(policy, e(a).meanX))
        / (e(b).meanX / e(a).meanX);
    for (const [a, b] of [['Io', 'Europa'], ['Europa', 'Ganymede'], ['Ganymede', 'Callisto']]) {
      expect(step(a, b), `${a}→${b}`).toBeGreaterThan(0.08);
      expect(step(a, b), `${a}→${b}`).toBeLessThan(0.12);
    }
  });
});

describe('interval-overlap fidelity', () => {
  it('overlaps two moons\' charted ranges exactly when their true ranges overlap', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const entries = moonOffsetEntries(planet.name);
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i];
          const b = entries[j];
          const trueOverlap = a.periX <= b.apoX && b.periX <= a.apoX;
          const mapped = (e: MoonOffsetEntry) =>
            [mapMoonOffsetR(policy, e.periX), mapMoonOffsetR(policy, e.apoX)] as const;
          const [aLo, aHi] = mapped(a);
          const [bLo, bHi] = mapped(b);
          const mappedOverlap = aLo <= bHi && bLo <= aHi;
          expect(mappedOverlap, `${a.name} vs ${b.name} in ${planet.name}`).toBe(trueOverlap);
        }
      }
    }
  });

  it('keeps Nereid\'s real interleaving with the outer Neptunian irregulars', () => {
    const policy = moonOffsetPolicyFor('Neptune');
    const e = (name: string) => moonOffsetEntries('Neptune').find((x) => x.name === name)!;
    const nereid = e('Nereid');
    const halimede = e('Halimede');
    // True: Nereid's eccentric sweep reaches past Halimede's periapsis.
    expect(nereid.apoX).toBeGreaterThan(halimede.periX);
    expect(mapMoonOffsetR(policy, nereid.apoX))
      .toBeGreaterThan(mapMoonOffsetR(policy, halimede.periX));
  });
});

describe('legibility at the framing a focus lands on', () => {
  // A focus flight lands with the parent's disc at the reveal size, and the
  // offsets are in drawn parent radii — so one radius is worth a fixed number
  // of screen px there, and a ring gap in radii converts straight to px.
  const MIN_RING_GAP_PX = 2;

  it('separates adjacent regular rings by at least two px, on a phone', () => {
    const worst = { pair: '', px: Infinity };
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const { pxPerRadius } = revealFraming(planet, 844);
      const groups = coOrbitalGroups(moonOffsetEntries(planet.name))
        .map((g) => g[0])
        .filter((e) => e.meanX <= P.x0 && mapMoonCurveR(e.meanX) >= policy.fixedPoint);
      for (let i = 1; i < groups.length; i++) {
        const gap = (mapMoonOffsetR(policy, groups[i].meanX)
          - mapMoonOffsetR(policy, groups[i - 1].meanX)) * pxPerRadius;
        if (gap < worst.px) { worst.px = gap; worst.pair = `${groups[i - 1].name}→${groups[i].name}`; }
      }
    }
    expect(worst.px, worst.pair).toBeGreaterThanOrEqual(MIN_RING_GAP_PX);
  });

  it('orders the irregular tail even where two families nearly share an orbit', () => {
    // The tail's job is honest ordering, not honest spacing: the Himalia family
    // really does sit within 2% of itself, and a chart that pushed its members
    // apart to make them individually tappable would be inventing a gap that is
    // not there. Ordering is what is promised, and zoom is what separates.
    const policy = moonOffsetPolicyFor('Jupiter');
    const e = (name: string) => moonOffsetEntries('Jupiter').find((x) => x.name === name)!;
    for (const [a, b] of [['Himalia', 'Lysithea'], ['Carme', 'Pasiphae'], ['Pasiphae', 'Sinope']]) {
      expect(mapMoonOffsetR(policy, e(b).meanX), `${a}→${b}`)
        .toBeGreaterThan(mapMoonOffsetR(policy, e(a).meanX));
    }
  });

  it('fits the whole cap in frame at the follow shell\'s far limit, in portrait', () => {
    // The cap is negotiated against the camera policy, and both ends move: if a
    // marker retune inflates parents, the outermost ring leaves the frame. This
    // is the assertion that makes that fail loudly instead of clipping Neso.
    const viewportW = 390;
    const viewportH = 844;
    const aspect = viewportW / viewportH;
    const perPxUnit = mapWorldPerPxAtUnitDepth(viewportH, MAP_FOV_DEG);
    for (const planet of SYSTEMS) {
      const { bounds } = revealFraming(planet, viewportH);
      const dist = bounds.maxDist;
      const drawnAU = mapBodyRadiusAU(planet.radiusAU, dist, perPxUnit, SIZE);
      const halfWidthAU = dist * Math.tan((MAP_FOV_DEG * Math.PI) / 180 / 2) * aspect;
      expect(halfWidthAU / drawnAU, `${planet.name} portrait half-width in drawn radii`)
        .toBeGreaterThanOrEqual(P.capR);
    }
  });
});

describe('the squeeze', () => {
  it('lifts a packed inner family off the parent without collapsing it to one radius', () => {
    // A flat floor would put Metis, Amalthea and Thebe on a single ring. The
    // affine squeeze keeps them ordered and distinct.
    const policy = moonOffsetPolicyFor('Jupiter');
    expect(policy.boundRun).toEqual(['Metis', 'Amalthea', 'Thebe']);
    const e = (name: string) => moonOffsetEntries('Jupiter').find((x) => x.name === name)!;
    const rs = policy.boundRun.map((n) => mapMoonOffsetR(policy, e(n).meanX));
    expect(rs[0]).toBeGreaterThanOrEqual(P.clearanceR);
    expect(rs[1]).toBeGreaterThan(rs[0]);
    expect(rs[2]).toBeGreaterThan(rs[1]);
  });

  it('is a fixed point at the first unbound moon, so nothing cascades outward', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      if (!policy.squeezed) continue;
      const entries = moonOffsetEntries(planet.name);
      const firstUnbound = entries[policy.boundRun.length];
      expect(mapMoonOffsetR(policy, firstUnbound.meanX))
        .toBeCloseTo(mapMoonCurveR(firstUnbound.meanX), 12);
      // And every ring beyond it is the curve exactly.
      for (const e of entries.slice(policy.boundRun.length)) {
        expect(mapMoonOffsetR(policy, e.meanX), `${planet.name} ${e.name}`)
          .toBeCloseTo(mapMoonCurveR(e.meanX), 12);
      }
    }
  });

  it('binds exactly the systems with a packed inner family', () => {
    const bound = Object.fromEntries(
      SYSTEMS.map((p) => [p.name, moonOffsetPolicyFor(p.name).boundRun.length]),
    );
    expect(bound).toEqual({
      Earth: 0, Mars: 1, Jupiter: 3, Saturn: 8, Uranus: 8, Neptune: 5, Pluto: 0,
    });
  });

  it('opens a band for a system where every moon is bound', () => {
    // No catalog system is like this; the fallback exists so the policy is
    // total, and a synthetic fixture is the only way to reach it.
    const entries: MoonOffsetEntry[] = [
      { name: 'a', meanX: 1.2, periX: 1.1, apoX: 1.3 },
      { name: 'b', meanX: 1.6, periX: 1.55, apoX: 1.65 },
      { name: 'c', meanX: 2.0, periX: 1.9, apoX: 2.1 },
    ];
    const policy = buildMoonOffsetPolicy('Synthetic', entries, P);
    expect(policy.boundRun).toEqual(['a', 'b', 'c']);
    expect(policy.slope).toBeGreaterThan(0);
    let prev = -Infinity;
    for (const e of entries) {
      for (const x of [e.periX, e.meanX, e.apoX]) {
        const r = mapMoonOffsetR(policy, x);
        expect(r).toBeGreaterThanOrEqual(P.clearanceR);
        expect(r).toBeLessThanOrEqual(P.clearanceR + P.bandR + 1e-12);
        expect(r).toBeGreaterThan(prev);
        prev = r;
      }
    }
  });

  it('still increases for a single circular moon with no span to open', () => {
    const policy = buildMoonOffsetPolicy(
      'Synthetic', [{ name: 'only', meanX: 1.2, periX: 1.2, apoX: 1.2 }], P,
    );
    expect(policy.slope).toBeGreaterThan(0);
    const r = mapMoonOffsetR(policy, 1.2);
    expect(r).toBeCloseTo(P.clearanceR + P.bandR / 2, 12);
    expect(mapMoonOffsetR(policy, 1.3)).toBeGreaterThan(r);
  });

  it('leaves a system with nothing bound entirely alone', () => {
    const policy = moonOffsetPolicyFor('Pluto');
    expect(policy.squeezed).toBe(false);
    for (const e of moonOffsetEntries('Pluto')) {
      expect(mapMoonOffsetR(policy, e.meanX)).toBeCloseTo(mapMoonCurveR(e.meanX), 12);
    }
  });
});

describe('the catalog side', () => {
  it('reads an orbit for all 65 moons, and none of them a degenerate one', () => {
    let count = 0;
    for (const planet of PLANETARIUM_BODIES) {
      for (const e of moonOffsetEntries(planet.name)) {
        expect(e.periX, e.name).toBeGreaterThan(0);
        expect(e.meanX, e.name).toBeGreaterThanOrEqual(e.periX);
        expect(e.apoX, e.name).toBeGreaterThanOrEqual(e.meanX);
        count++;
      }
    }
    expect(count).toBe(MOONS.length);
  });

  it('has no moon charted inside the parent it orbits, anywhere in the catalog', () => {
    for (const planet of SYSTEMS) {
      const policy = moonOffsetPolicyFor(planet.name);
      const entries = moonOffsetEntries(planet.name);
      const lo = Math.min(...entries.map((e) => e.periX));
      const hi = Math.max(...entries.map((e) => e.apoX));
      for (let x = lo; x <= hi; x *= 1.01) {
        expect(mapMoonOffsetR(policy, x), `${planet.name} at x=${x}`)
          .toBeGreaterThanOrEqual(P.clearanceR);
      }
    }
  });

  it('retunes live and puts the defaults back', () => {
    const before = mapMoonOffsetR(moonOffsetPolicyFor('Jupiter'), 5.9);
    expect(setMapMoonOffsetParams({ ioAnchorR: 2.4 })).toBe(true);
    const after = mapMoonOffsetR(moonOffsetPolicyFor('Jupiter'), 5.9);
    expect(after).toBeGreaterThan(before * 1.4);
    expect(setMapMoonOffsetParams(null)).toBe(true);
    expect(mapMoonOffsetR(moonOffsetPolicyFor('Jupiter'), 5.9)).toBeCloseTo(before, 12);
  });
});

describe('the live knobs', () => {
  /** Every property the contract rests on, checked over a real system. */
  function chartsAsystem(): boolean {
    const policy = moonOffsetPolicyFor('Jupiter');
    const entries = moonOffsetEntries('Jupiter');
    let prev = -Infinity;
    // Over the range the system's moons actually occupy: the clearance is a
    // promise about where a MOON can be, and x below the innermost periapsis
    // is not somewhere any of them goes.
    const lo = Math.min(...entries.map((e) => e.periX));
    const hi = Math.max(...entries.map((e) => e.apoX));
    for (let x = lo; x <= hi; x *= 1.01) {
      const r = mapMoonOffsetR(policy, x);
      if (!Number.isFinite(r) || r <= prev) return false;
      if (r < policy.params.clearanceR || r > policy.params.capR + 1e-9) return false;
      prev = r;
    }
    return true;
  }

  const REFUSED: Array<[string, Partial<typeof MAP_MOON_OFFSET_DEFAULTS>]> = [
    // Zone 1 collapses onto one radius: every regular on the same ring.
    ['gamma 0', { gamma: 0 }],
    ['gamma negative', { gamma: -0.8 }],
    // Above 1 the law expands rather than compresses, and overruns the cap.
    ['gamma 1.4', { gamma: 1.4 }],
    // A logarithm of x/0: NaN into every position on the chart.
    ['x0 0', { x0: 0 }],
    ['x0 inside the parent', { x0: 0.5 }],
    // The tail flattens: Himalia and Sinope land on one ring.
    ['cap under the boundary value', { capR: 1 }],
    ['cap under the clearance band', { capR: 1.5 }],
    // The order inverts outright.
    ['negative anchor', { ioAnchorR: -1 }],
    ['zero anchor', { ioAnchorR: 0 }],
    // Everything past the cap.
    ['clearance 20', { clearanceR: 20 }],
    // Inside the parent it orbits.
    ['clearance under the limb', { clearanceR: 0.5 }],
    // Exactly on a first unbound moon's own curve value: the squeeze's two
    // anchors coincide, its slope is zero, and Jupiter's packed inner family
    // charts onto one ring with Io. A window on the knob alone cannot see this
    // — only building the policy can.
    ['clearance exactly on Io', { clearanceR: 1.7 }],
    ['not a number', { gamma: Number.NaN }],
    ['infinite', { capR: Number.POSITIVE_INFINITY }],
  ];

  it('refuses a knob set that would not draw a chart, and keeps drawing the old one', () => {
    const reference = moonOffsetEntries('Jupiter')
      .map((e) => mapMoonOffsetR(moonOffsetPolicyFor('Jupiter'), e.meanX));
    for (const [label, partial] of REFUSED) {
      expect(setMapMoonOffsetParams(partial), label).toBe(false);
      const after = moonOffsetEntries('Jupiter')
        .map((e) => mapMoonOffsetR(moonOffsetPolicyFor('Jupiter'), e.meanX));
      expect(after, label).toEqual(reference);
      expect(chartsAsystem(), label).toBe(true);
    }
    setMapMoonOffsetParams(null);
  });

  it('accepts the taste-round knobs, and still charts a system with each', () => {
    for (const partial of [
      { gamma: 0.7 }, { gamma: 0.9 }, { x0: 20 }, { x0: 45 }, { ioAnchorR: 1.4 },
      { ioAnchorR: 2.4 }, { capR: 9 }, { capR: 13 }, { clearanceR: 1.2 },
      { clearanceR: 2 }, { bandR: 0.8 }, { marginMax: 0.05 },
    ]) {
      expect(setMapMoonOffsetParams(partial), JSON.stringify(partial)).toBe(true);
      expect(chartsAsystem(), JSON.stringify(partial)).toBe(true);
      setMapMoonOffsetParams(null);
    }
  });

  it('refuses a clearance that collapses a system\'s squeeze, and says where', () => {
    // The boundary itself: Io's curve value is the anchor the whole zone-1
    // scale is pinned to, so a clearance set to it leaves the squeeze nothing
    // to open into.
    const io = moonOffsetEntries('Jupiter').find((e) => e.name === 'Io')!;
    expect(mapMoonCurveR(io.meanX)).toBeCloseTo(1.7, 12);
    expect(setMapMoonOffsetParams({ clearanceR: 1.7 })).toBe(false);
    // And the standing policy still charts Jupiter's inner family apart.
    const policy = moonOffsetPolicyFor('Jupiter');
    const at = (name: string) =>
      mapMoonOffsetR(policy, moonOffsetEntries('Jupiter').find((e) => e.name === name)!.meanX);
    expect(at('Metis')).toBeLessThan(at('Amalthea'));
    expect(at('Amalthea')).toBeLessThan(at('Thebe'));
    expect(at('Thebe')).toBeLessThan(at('Io'));
  });

  it('sanitizes the merged set, not the partial — one knob can spoil another', () => {
    // A cap of 8 is legal on its own, and so is Io at 2.2. Together the curve's
    // value at the zone boundary is 8.08 — already past the cap — and the tail
    // would have nowhere left to go.
    expect(setMapMoonOffsetParams({ capR: 8 })).toBe(true);
    setMapMoonOffsetParams(null);
    expect(setMapMoonOffsetParams({ ioAnchorR: 2.2 })).toBe(true);
    setMapMoonOffsetParams(null);
    expect(setMapMoonOffsetParams({ capR: 8 })).toBe(true);
    expect(setMapMoonOffsetParams({ ioAnchorR: 2.2 })).toBe(false);
    setMapMoonOffsetParams(null);
  });

  it('refuses a gamma so small the curve stops separating anything', () => {
    // The collapse a squeeze's slope cannot see, because it is in the BASE
    // curve: as gamma goes to zero, x^gamma goes to 1 and A·x^gamma goes to A,
    // so every regular in a system charts on the anchor together. Io and
    // Callisto sit four and a half times apart in x and land on the same
    // double — distinct orbits drawn as one ring.
    const degenerate = { ...MAP_MOON_OFFSET_DEFAULTS, gamma: 1e-20 };
    const entries = moonOffsetEntries('Jupiter');
    const io = entries.find((e) => e.name === 'Io')!;
    const callisto = entries.find((e) => e.name === 'Callisto')!;
    const policy = buildMoonOffsetPolicy('Jupiter', entries, degenerate);
    expect(callisto.meanX / io.meanX).toBeGreaterThan(4);
    expect(mapMoonOffsetR(policy, io.meanX)).toBe(mapMoonOffsetR(policy, callisto.meanX));
    expect(mapMoonOffsetR(policy, io.meanX)).toBe(MAP_MOON_OFFSET_DEFAULTS.ioAnchorR);
    // So the knobs are refused, and the standing chart is untouched.
    expect(setMapMoonOffsetParams({ gamma: 1e-20 })).toBe(false);
    const standing = moonOffsetPolicyFor('Jupiter');
    expect(mapMoonOffsetR(standing, callisto.meanX))
      .toBeGreaterThan(mapMoonOffsetR(standing, io.meanX));
  });

  it('accepts a gamma that merely compresses hard, because ordering survives it', () => {
    // The line is drawn at collapse, not at taste: at 0.05 the Jovian system is
    // squashed into a fifth of a parent radius and still strictly ordered, so
    // it is a knob a taste round may turn.
    expect(setMapMoonOffsetParams({ gamma: 0.05 })).toBe(true);
    const policy = moonOffsetPolicyFor('Jupiter');
    const at = (name: string) =>
      mapMoonOffsetR(policy, moonOffsetEntries('Jupiter').find((e) => e.name === name)!.meanX);
    expect(at('Io')).toBeCloseTo(1.7, 9);
    expect(at('Callisto')).toBeCloseTo(1.832030285398708, 9);
    for (const [inner, outer] of [['Metis', 'Io'], ['Io', 'Europa'], ['Europa', 'Callisto']]) {
      expect(at(outer), `${inner}→${outer}`).toBeGreaterThan(at(inner));
    }
    setMapMoonOffsetParams(null);
  });

  it('refuses an anchor that charts a moon\'s closest approach inside its parent', () => {
    // Clearance is promised at PERIAPSIS — the squeeze is anchored on the bound
    // run's innermost periapsis for exactly that reason. Phobos is the catalog's
    // tightest case: past a certain anchor its MEAN distance leaves the bound
    // run, so nothing lifts it, while its periapsis still wants to be inside.
    // Nothing else about these knobs is out of range — the cap is untouched —
    // so this is the periapsis check and nothing else.
    const entries = moonOffsetEntries('Mars');
    const phobos = entries.find((e) => e.name === 'Phobos')!;
    const periAt = (anchor: number) => {
      const candidate = { ...MAP_MOON_OFFSET_DEFAULTS, ioAnchorR: anchor };
      const policy = buildMoonOffsetPolicy('Mars', entries, candidate);
      return { policy, r: mapMoonOffsetR(policy, phobos.periX) };
    };

    const held = periAt(2.4);
    expect(held.policy.boundRun).toEqual(['Phobos']);
    expect(held.r).toBeCloseTo(1.3700000000000003, 15);
    expect(held.r).toBeGreaterThanOrEqual(MAP_MOON_OFFSET_DEFAULTS.clearanceR);
    expect(setMapMoonOffsetParams({ ioAnchorR: 2.4 })).toBe(true);
    setMapMoonOffsetParams(null);

    const dropped = periAt(2.5);
    expect(dropped.policy.boundRun).toEqual([]);
    expect(dropped.r).toBeCloseTo(1.3452796291769045, 15);
    expect(dropped.r).toBeLessThan(MAP_MOON_OFFSET_DEFAULTS.clearanceR);
    expect(setMapMoonOffsetParams({ ioAnchorR: 2.5 })).toBe(false);
    setMapMoonOffsetParams(null);
  });
});

/**
 * The ring-clearance knob and the registry it reads.
 *
 * The registry is module state, so every test here seeds what it needs and
 * hands it back — a leaked Saturn factor would move a later suite's radii.
 */
describe('the drawn-ring registry', () => {
  /** What the chart actually builds: an annulus for Saturn, nothing else. */
  const CHART_RINGS = { Saturn: 2.27 };
  const PLANETS = ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Earth'];

  afterEach(() => {
    setMapRingOuterFactors({});
    setMapMoonOffsetParams(null);
  });

  it('answers 1 for everything while it is unseeded', () => {
    setMapRingOuterFactors({});
    for (const planet of PLANETS) expect(mapRingOuterFactor(planet)).toBe(1);
    // And a factor at or below the globe is no ring at all.
    setMapRingOuterFactors({ Saturn: 1, Uranus: 0.5, Mars: Number.NaN });
    expect(mapRingOuterFactor('Saturn')).toBe(1);
    expect(mapRingOuterFactor('Uranus')).toBe(1);
    expect(mapRingOuterFactor('Mars')).toBe(1);
  });

  it('carries the clearance out to the ring in a straight line', () => {
    setMapRingOuterFactors(CHART_RINGS);
    const base = MAP_MOON_OFFSET_DEFAULTS.clearanceR;
    const at = (mul: number) =>
      effectiveClearanceR('Saturn', { ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: mul });
    expect(at(0)).toBeCloseTo(base, 12);
    expect(at(1)).toBeCloseTo(2.27, 12);
    expect(at(0.5)).toBeCloseTo(base + 0.5 * (2.27 - base), 12);
    // Every step of the knob moves it — no dead zone waiting for a max to win.
    expect(at(0.25)).toBeGreaterThan(at(0));
    expect(at(0.75)).toBeGreaterThan(at(0.5));
  });

  it('leaves a ringless planet alone at every value of the knob', () => {
    setMapRingOuterFactors(CHART_RINGS);
    for (const mul of [0, 0.25, 0.5, 0.75, 1]) {
      for (const planet of ['Jupiter', 'Uranus', 'Neptune', 'Mars', 'Pluto', 'Earth']) {
        expect(
          effectiveClearanceR(planet, { ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: mul }),
          `${planet} at ${mul}`,
        ).toBe(MAP_MOON_OFFSET_DEFAULTS.clearanceR);
      }
    }
  });

  it('drops every built policy when it is seeded, or the next one is stale', () => {
    setMapRingOuterFactors({});
    setMapMoonOffsetParams({ ringClearanceMul: 1 });
    const before = moonOffsetPolicyFor('Saturn');
    expect(before.boundRun.length).toBe(8);
    // Seeding AFTER a policy was built has to change the rebuilt one.
    setMapRingOuterFactors(CHART_RINGS);
    const after = moonOffsetPolicyFor('Saturn');
    expect(after).not.toBe(before);
    expect(after.boundRun.length).toBe(13);
  });
});

describe('the ring-clearance knob', () => {
  const CHART_RINGS = { Saturn: 2.27 };
  const PLANETS = ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Earth'];

  const radiiOf = (planet: string, mul: number, rings: Record<string, number>): number[] => {
    setMapRingOuterFactors(rings);
    const entries = moonOffsetEntries(planet);
    const policy = buildMoonOffsetPolicy(planet, entries, {
      ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: mul,
    });
    const out: number[] = [];
    for (const e of entries) {
      out.push(
        mapMoonOffsetR(policy, e.periX),
        mapMoonOffsetR(policy, e.meanX),
        mapMoonOffsetR(policy, e.apoX),
      );
    }
    return out;
  };

  afterEach(() => {
    setMapRingOuterFactors({});
    setMapMoonOffsetParams(null);
  });

  it('ships the clearance half way out to the ring', () => {
    // The pick: Saturn's inner family lifted off the globe's limb and spread
    // through the annulus, still charted over the rings the way it orbits.
    expect(MAP_MOON_OFFSET_DEFAULTS.ringClearanceMul).toBe(0.5);
  });

  it('draws exactly the chart it drew BEFORE the knob existed, at zero', () => {
    // Pinned against radii captured from the commit before this one, not
    // against this implementation run twice: the params grew a field, so
    // comparing the new code with itself passes a regression common to both
    // paths — and object identity would pass a knob that did nothing and one
    // that did too much alike. Float precision, no tolerance: these are outputs
    // of a pure function, so anything but equality is a change.
    setMapRingOuterFactors(CHART_RINGS);
    const params = { ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: 0 };
    let checked = 0;
    for (const [planet, rows] of Object.entries(goldens.systems)) {
      const entries = moonOffsetEntries(planet);
      const policy = buildMoonOffsetPolicy(planet, entries, params);
      for (const [name, peri, mean, apo] of rows as [string, number, number, number][]) {
        const e = entries.find((x) => x.name === name);
        expect(e, `${planet}: the catalog no longer has ${name}`).toBeDefined();
        expect(mapMoonOffsetR(policy, e!.periX), `${name} periapsis`).toBe(peri);
        expect(mapMoonOffsetR(policy, e!.meanX), `${name} mean`).toBe(mean);
        expect(mapMoonOffsetR(policy, e!.apoX), `${name} apoapsis`).toBe(apo);
        checked += 3;
      }
    }
    // Every moon in the catalog, at all three of its breakpoints.
    expect(checked).toBe(195);
  });

  it('charts the same radii whether or not the rings are registered, at zero', () => {
    // A property of its own, and not the pin above: at zero the ring factor is
    // multiplied by nothing, so a seeded registry may not move a single moon.
    for (const planet of PLANETS) {
      const withRings = radiiOf(planet, 0, CHART_RINGS);
      const without = radiiOf(planet, 0, {});
      expect(withRings.length, planet).toBeGreaterThan(0);
      for (let i = 0; i < withRings.length; i++) {
        expect(withRings[i], `${planet}[${i}]`).toBe(without[i]);
      }
    }
  });

  it('pushes Saturn\'s whole bound run outside the rings at one', () => {
    setMapRingOuterFactors(CHART_RINGS);
    const params = { ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: 1 };
    const entries = moonOffsetEntries('Saturn');
    const policy = buildMoonOffsetPolicy('Saturn', entries, params);
    for (const name of policy.boundRun) {
      const e = entries.find((x) => x.name === name)!;
      expect(mapMoonOffsetR(policy, e.periX), name).toBeGreaterThanOrEqual(2.27 - 1e-12);
    }
  });

  it('grows the bound run from eight to thirteen, and says which moons', () => {
    // The count is paired with the boundary it encodes, so a future gen:moons
    // regeneration that moves a semi-major axis fails with a diagnosis rather
    // than an off-by-one. Tethys and Dione join at full clearance and bring
    // their Trojan co-orbitals with them; Rhea is the first still outside.
    // Both ends of the knob are set explicitly: this pins what the knob does,
    // not wherever the shipped default happens to stand.
    setMapRingOuterFactors(CHART_RINGS);
    const entries = moonOffsetEntries('Saturn');
    const off = buildMoonOffsetPolicy('Saturn', entries, {
      ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: 0,
    });
    const on = buildMoonOffsetPolicy('Saturn', entries, {
      ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: 1,
    });
    expect(off.boundRun.length).toBe(8);
    expect(on.boundRun.length).toBe(13);
    for (const name of ['Tethys', 'Calypso', 'Telesto', 'Dione', 'Helene']) {
      expect(off.boundRun, `${name} off`).not.toContain(name);
      expect(on.boundRun, `${name} on`).toContain(name);
    }
    expect(on.boundRun).toContain('Helene');
    expect(on.boundRun).not.toContain('Rhea');
  });

  it('moves no other system, whatever the knob is set to', () => {
    for (const planet of PLANETS) {
      if (planet === 'Saturn') continue;
      const base = radiiOf(planet, 0, CHART_RINGS);
      for (const mul of [0.25, 0.5, 1]) {
        const moved = radiiOf(planet, mul, CHART_RINGS);
        for (let i = 0; i < base.length; i++) {
          expect(moved[i], `${planet} at ${mul}[${i}]`).toBe(base[i]);
        }
      }
    }
  });

  it('keeps every invariant at nothing, half and full', () => {
    setMapRingOuterFactors(CHART_RINGS);
    for (const mul of [0, 0.5, 1]) {
      const candidate = { ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: mul };
      expect(sanitizeMoonOffsetParams(candidate), `mul ${mul}`).not.toBeNull();
      // And the charted radii themselves: strictly increasing in x, inside the
      // cap, and never inside the clearance this system is charted against.
      for (const planet of PLANETS) {
        const entries = moonOffsetEntries(planet);
        if (entries.length === 0) continue;
        const policy = buildMoonOffsetPolicy(planet, entries, candidate);
        const clearance = effectiveClearanceR(planet, candidate);
        const xs = entries.flatMap((e) => [e.periX, e.meanX, e.apoX]).sort((a, b) => a - b);
        let prevR = -Infinity;
        let prevX = -Infinity;
        for (const x of xs) {
          const r = mapMoonOffsetR(policy, x);
          expect(Number.isFinite(r), `${planet} ${x}`).toBe(true);
          expect(r, `${planet} cap`).toBeLessThanOrEqual(candidate.capR + 1e-9);
          expect(r, `${planet} clearance at mul ${mul}`).toBeGreaterThanOrEqual(clearance - 1e-9);
          if (x > prevX) expect(r, `${planet} order`).toBeGreaterThan(prevR - 1e-12);
          prevR = r;
          prevX = x;
        }
      }
    }
  });

  it('sanitizes the shipped defaults against the rings the chart draws', () => {
    // Named through the constant rather than a literal, so it tracks whatever
    // ships: the null reset installs MAP_MOON_OFFSET_DEFAULTS without running
    // them through the sanitizer, so nothing else checks that the shipped set
    // draws a chart. Seeded first — with no rings registered the clearance
    // never leaves the globe and the knob is not under test at all.
    setMapRingOuterFactors(CHART_RINGS);
    expect(sanitizeMoonOffsetParams(MAP_MOON_OFFSET_DEFAULTS)).not.toBeNull();
  });

  it('refuses a knob outside its window and keeps the standing chart', () => {
    setMapRingOuterFactors(CHART_RINGS);
    for (const bad of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        sanitizeMoonOffsetParams({ ...MAP_MOON_OFFSET_DEFAULTS, ringClearanceMul: bad }),
        String(bad),
      ).toBeNull();
      expect(setMapMoonOffsetParams({ ringClearanceMul: bad }), String(bad)).toBe(false);
    }
    // The refusals left the standing value alone.
    expect(mapMoonOffsetParams().ringClearanceMul)
      .toBe(MAP_MOON_OFFSET_DEFAULTS.ringClearanceMul);
    // And the ends of the window are accepted.
    expect(setMapMoonOffsetParams({ ringClearanceMul: 0 })).toBe(true);
    expect(setMapMoonOffsetParams({ ringClearanceMul: 1 })).toBe(true);
  });
});
