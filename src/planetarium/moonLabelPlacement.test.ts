import { describe, expect, it } from 'vitest';
import {
  EDGE_LABEL_MIN_CANVAS_W_PX,
  LABEL_DOT_MIN_ALPHA,
  MOON_LABEL_PLACEMENT_PARAMS,
  NARROW_EDGE_LABELS_PER_SYSTEM,
  clampAnchorClearOfDisc,
  edgeLabelSystemCap,
  placeMoonLabels,
  type AnchorSlide,
  type MoonLabelCandidate,
} from './moonLabelPlacement';

const P = MOON_LABEL_PLACEMENT_PARAMS;

/** A candidate at the origin, on screen, plain tier, 40 px wide. */
const cand = (name: string, over: Partial<MoonLabelCandidate> = {}): MoonLabelCandidate => ({
  name,
  parent: 'Jupiter',
  sx: 0,
  sy: 0,
  onScreen: true,
  priorityPx: 1,
  halfW: 20,
  isTarget: false,
  isRevealed: false,
  isUnlit: false,
  placed: false,
  ...over,
});

const NONE: ReadonlySet<string> = new Set<string>();

/** placeMoonLabels sorts in place, so read the answer off the objects. */
const placed = (cs: MoonLabelCandidate[]): string[] =>
  cs.filter((c) => c.placed).map((c) => c.name).sort();

const run = (cs: MoonLabelCandidate[], prev: ReadonlySet<string> = NONE, params = P): string[] => {
  placeMoonLabels(cs, prev, params);
  return placed(cs);
};

describe('moonLabelPlacement — the dark-label band', () => {
  it('enters exactly where the label-keep gate lets a dark moon live', () => {
    // Any gap between the two would leave a label kept alive by the lit twin
    // yet neither styled as dark nor held to the centre-unoccluded proof —
    // a name at full strength over something that may be hidden.
    expect(P.unlitEnterAlpha).toBe(LABEL_DOT_MIN_ALPHA);
  });

  it('leaves above where it enters, so the style cannot pulse with the dot', () => {
    expect(P.unlitLeaveAlpha).toBeGreaterThan(P.unlitEnterAlpha);
  });
});

describe('moonLabelPlacement — the phone edge-label cap', () => {
  // Well-separated rows, so the cap — not rect collision — decides each case.
  const row = (name: string, i: number, over: Partial<MoonLabelCandidate> = {}) =>
    cand(name, { sy: i * 3 * P.labelHeightPx, onScreen: false, priorityPx: 10 - i, ...over });

  it('is uncapped at desktop width, one per system at phone width', () => {
    expect(edgeLabelSystemCap(EDGE_LABEL_MIN_CANVAS_W_PX)).toBe(Infinity);
    expect(edgeLabelSystemCap(EDGE_LABEL_MIN_CANVAS_W_PX - 1)).toBe(NARROW_EDGE_LABELS_PER_SYSTEM);
    // 641 is the far side of the UI's shared 640px line, and one edge label is
    // wayfinding where a column of them is noise.
    expect(EDGE_LABEL_MIN_CANVAS_W_PX).toBe(641);
    expect(NARROW_EDGE_LABELS_PER_SYSTEM).toBe(1);
  });

  it('keeps a lone moon system’s edge label — Earth stays wayfindable', () => {
    const cs = [row('Moon', 0, { parent: 'Earth' })];
    placeMoonLabels(cs, NONE, P, 1);
    expect(placed(cs)).toEqual(['Moon']);
  });

  it('thins a crowded system to its top-ranked moon', () => {
    const cs = [row('Rhea', 0), row('Dione', 1), row('Tethys', 2)];
    placeMoonLabels(cs, NONE, P, 1);
    expect(placed(cs)).toEqual(['Rhea']);
  });

  it('caps per system, not across the sky', () => {
    const cs = [
      row('Rhea', 0, { parent: 'Saturn' }),
      row('Dione', 1, { parent: 'Saturn' }),
      row('Moon', 2, { parent: 'Earth' }),
    ];
    placeMoonLabels(cs, NONE, P, 1);
    expect(placed(cs)).toEqual(['Moon', 'Rhea']);
  });

  it('never touches on-screen labels', () => {
    const cs = [row('Rhea', 0), row('Dione', 1, { onScreen: true }), row('Tethys', 2, { onScreen: true })];
    placeMoonLabels(cs, NONE, P, 1);
    expect(placed(cs)).toEqual(['Dione', 'Rhea', 'Tethys']);
  });

  it('always places the target and the reveal, and they fill the cap', () => {
    // The player asked for these by hand — but a system already represented at
    // the margin by the moon you are flying at needs no second name there.
    const cs = [row('Rhea', 0), row('Iapetus', 1, { isTarget: true }), row('Dione', 2, { isRevealed: true })];
    placeMoonLabels(cs, NONE, P, 1);
    expect(placed(cs)).toEqual(['Dione', 'Iapetus']);
  });

  it('defaults to uncapped when no cap is passed — desktop is untouched', () => {
    const cs = [row('Rhea', 0), row('Dione', 1), row('Tethys', 2)];
    placeMoonLabels(cs, NONE);
    expect(placed(cs)).toEqual(['Dione', 'Rhea', 'Tethys']);
  });
});

describe('moonLabelPlacement — the greedy contest', () => {
  it('answers for an empty list and for a lone label', () => {
    const empty: MoonLabelCandidate[] = [];
    expect(run(empty)).toEqual([]);
    expect(run([cand('Io')])).toEqual(['Io']);
  });

  it('marks placed on every candidate, winners and losers alike', () => {
    // The controller reads the flag on each object; leaving a loser's stale
    // `true` behind would keep a hidden label pickable.
    const cs = [cand('Io', { priorityPx: 10 }), cand('Metis', { priorityPx: 1 })];
    placeMoonLabels(cs, NONE);
    expect(cs.find((c) => c.name === 'Io')!.placed).toBe(true);
    expect(cs.find((c) => c.name === 'Metis')!.placed).toBe(false);
  });

  it('gives an overlapping pair to the bigger apparent moon', () => {
    expect(run([
      cand('Metis', { priorityPx: 1 }),
      cand('Io', { priorityPx: 40 }),
    ])).toEqual(['Io']);
  });

  it('lets a chain place its ends: the middle label is the one that yields', () => {
    // A—B overlap and B—C overlap, but A and C clear each other.
    const cs = [
      cand('A', { sx: 0, priorityPx: 30 }),
      cand('B', { sx: 30, priorityPx: 20 }),
      cand('C', { sx: 60, priorityPx: 10 }),
    ];
    expect(run(cs)).toEqual(['A', 'C']);
  });

  it('breaks an exact priority tie in catalog order', () => {
    const cs = [cand('Amalthea', { priorityPx: 5 }), cand('Thebe', { priorityPx: 5 })];
    expect(run(cs)).toEqual(['Amalthea']);
    // The order of arrival is the only tiebreak, so reversing it flips the win.
    const flipped = [cand('Thebe', { priorityPx: 5 }), cand('Amalthea', { priorityPx: 5 })];
    expect(run(flipped)).toEqual(['Thebe']);
  });

  it('suppresses a neighbour a shorter name would have cleared', () => {
    const short = [cand('Io', { sx: 0, halfW: 10, priorityPx: 9 }), cand('Metis', { sx: 25, priorityPx: 8, halfW: 10 })];
    expect(run(short)).toEqual(['Io', 'Metis']);
    const long = [cand('Io', { sx: 0, halfW: 40, priorityPx: 9 }), cand('Metis', { sx: 25, priorityPx: 8, halfW: 10 })];
    expect(run(long)).toEqual(['Io']);
  });

  it('ignores names in prevPlaced that are no longer candidates', () => {
    const gone: ReadonlySet<string> = new Set(['Callisto', 'Ganymede']);
    expect(run([cand('Io', { priorityPx: 3 }), cand('Metis', { priorityPx: 9 })], gone)).toEqual(['Metis']);
  });
});

describe('moonLabelPlacement — a dark moon keeps its rank', () => {
  it('sinks a candidate whose priority collapsed with its dot', () => {
    // Rank follows the bid, and an eclipsed moon's alpha collapses: bidding it
    // loses a contest the same moon's full footprint wins.
    expect(run([
      cand('Metis', { priorityPx: 0 }),
      cand('Adrastea', { priorityPx: 2 }),
    ])).toEqual(['Adrastea']);
  });

  it('holds rank when the dark moon bids its fully-lit footprint instead', () => {
    // The controller substitutes the lit alpha for a dark-kept moon precisely so
    // this outcome does not move with the terminator.
    expect(run([
      cand('Metis', { priorityPx: 6, isUnlit: true }),
      cand('Adrastea', { priorityPx: 2 }),
    ])).toEqual(['Metis']);
  });
});

describe('moonLabelPlacement — the target and the reveal', () => {
  it('sorts the nav target above the hover reveal', () => {
    const cs = [cand('Io', { isRevealed: true }), cand('Metis', { isTarget: true })];
    placeMoonLabels(cs, NONE);
    expect(cs[0].name).toBe('Metis');
  });

  it('draws both when they land on the same pixels', () => {
    // A hover that renders nothing reads as broken, and the moon you are flying
    // at must never vanish — the overlap is the lesser evil.
    expect(run([
      cand('Io', { sx: 0, isTarget: true }),
      cand('Metis', { sx: 5, isRevealed: true }),
    ])).toEqual(['Io', 'Metis']);
  });

  it('still suppresses an ordinary label under either of them', () => {
    expect(run([
      cand('Io', { sx: 0, isTarget: true }),
      cand('Metis', { sx: 5, isRevealed: true }),
      cand('Thebe', { sx: 10, priorityPx: 1000 }),
    ])).toEqual(['Io', 'Metis']);
  });
});

describe('moonLabelPlacement — tiers outrank footprint', () => {
  it('gives the slot to the revealed moon over a much bigger neighbour', () => {
    expect(run([
      cand('Io', { priorityPx: 100 }),
      cand('Metis', { priorityPx: 1, isRevealed: true }),
    ])).toEqual(['Metis']);
  });

  it('gives the slot to the nav target over a much bigger neighbour', () => {
    expect(run([
      cand('Io', { priorityPx: 100 }),
      cand('Metis', { priorityPx: 1, isTarget: true }),
    ])).toEqual(['Metis']);
  });

  it('lets an on-screen label beat a bigger edge-clamped one', () => {
    expect(run([
      cand('Io', { priorityPx: 100, onScreen: false }),
      cand('Metis', { priorityPx: 1, onScreen: true }),
    ])).toEqual(['Metis']);
  });
});

describe('moonLabelPlacement — incumbency', () => {
  const held: ReadonlySet<string> = new Set(['Metis']);

  it('defends a held slot against a marginally bigger challenger', () => {
    // Within the ratio: exactly the frame-to-frame wobble that made two labels
    // trade a slot.
    expect(run([
      cand('Metis', { priorityPx: 10 }),
      cand('Io', { priorityPx: 12 }),
    ], held)).toEqual(['Metis']);
  });

  it('yields once a challenger clears the eviction ratio', () => {
    expect(run([
      cand('Metis', { priorityPx: 10 }),
      cand('Io', { priorityPx: 10 * P.incumbentEvictRatio + 0.1 }),
    ], held)).toEqual(['Io']);
  });

  it('is exactly the ratio, not a fudge either side of it', () => {
    const just = 10 * P.incumbentEvictRatio;
    expect(run([cand('Metis', { priorityPx: 10 }), cand('Io', { priorityPx: just - 0.01 })], held)).toEqual(['Metis']);
    expect(run([cand('Metis', { priorityPx: 10 }), cand('Io', { priorityPx: just + 0.01 })], held)).toEqual(['Io']);
  });

  it('never outranks a tier: any tier upgrade evicts the incumbent outright', () => {
    for (const tier of ['isRevealed', 'isTarget'] as const) {
      expect(run([
        cand('Metis', { priorityPx: 1000 }),
        cand('Io', { priorityPx: 1, [tier]: true }),
      ], held)).toEqual(['Io']);
    }
    // An off-screen incumbent loses to an on-screen challenger the same way.
    expect(run([
      cand('Metis', { priorityPx: 1000, onScreen: false }),
      cand('Io', { priorityPx: 1, onScreen: true }),
    ], held)).toEqual(['Io']);
  });

  it('ranks two incumbents against each other by plain footprint', () => {
    const both: ReadonlySet<string> = new Set(['Metis', 'Io']);
    expect(run([cand('Metis', { priorityPx: 10 }), cand('Io', { priorityPx: 11 })], both)).toEqual(['Io']);
  });

  it('can be turned off by eye through the params', () => {
    expect(run(
      [cand('Metis', { priorityPx: 10 }), cand('Io', { priorityPx: 10.5 })],
      held,
      { ...P, incumbentEvictRatio: 1 },
    )).toEqual(['Io']);
  });
});

describe('moonLabelPlacement — sliding an anchor clear of its own disc', () => {
  // A 1000x600 viewport with the usual 30 px label margin.
  const MIN_X = 30;
  const MAX_X = 970;
  const MIN_Y = 30;
  const MAX_Y = 570;
  const HALF_W = 20;
  const out: AnchorSlide = { x: 0, y: 0, side: 0 };
  /** Anchor clamped to the top margin, disc centre just below it. */
  const slideTop = (
    over: Partial<{ anchorX: number; discX: number; discY: number; r: number; halfW: number; prevSide: number }> = {},
  ) => {
    const discX = over.discX ?? 200;
    return {
      ok: clampAnchorClearOfDisc(
        over.anchorX ?? discX, MIN_Y, false, true,
        discX, over.discY ?? 60, over.r ?? 100, over.halfW ?? HALF_W,
        MIN_X, MAX_X, MIN_Y, MAX_Y,
        over.prevSide ?? 0, out,
      ),
      out,
    };
  };

  it('leaves an anchor that already clears the limb exactly where it was', () => {
    const ok = clampAnchorClearOfDisc(
      500, MIN_Y, false, true, 500, 400, 100, HALF_W,
      MIN_X, MAX_X, MIN_Y, MAX_Y, 0, out,
    );
    expect(ok).toBe(true);
    expect(out.x).toBe(500);
    expect(out.y).toBe(MIN_Y);
    expect(out.side).toBe(0);
  });

  it('slides along the clamped edge to the chord end plus a pad', () => {
    const { ok } = slideTop();
    // Perpendicular distance 30 from a radius-100 disc: the chord reaches
    // sqrt(100² − 30²) either way from the centre column.
    const expected = 200 + Math.sqrt(100 * 100 - 30 * 30) + P.slidePadPx;
    expect(ok).toBe(true);
    expect(out.x).toBeCloseTo(expected, 6);
    expect(out.y).toBe(MIN_Y);
    expect(out.side).toBe(1);
  });

  it('hides rather than sliding when the anchor is pinned in a corner', () => {
    const ok = clampAnchorClearOfDisc(
      MIN_X, MIN_Y, true, true, 60, 60, 100, HALF_W,
      MIN_X, MAX_X, MIN_Y, MAX_Y, 0, out,
    );
    expect(ok).toBe(false);
  });

  it('hides when no point on the edge clears the disc', () => {
    // A disc wider than the whole margin box: both chord ends are off it.
    const { ok } = slideTop({ discX: 500, r: 900 });
    expect(ok).toBe(false);
  });

  it('hides when clearing would carry the name too far from where it sat', () => {
    // A hair-thin label: the cap is radius + half-width, and the chord end of a
    // dead-centre crossing is a full radius plus the pad.
    const { ok } = slideTop({ discY: MIN_Y, halfW: 1 });
    expect(ok).toBe(false);
  });

  it('holds the side it left on rather than teleporting across the chord', () => {
    const { ok } = slideTop({ prevSide: -1 });
    const expected = 200 - (Math.sqrt(100 * 100 - 30 * 30) + P.slidePadPx);
    expect(ok).toBe(true);
    expect(out.x).toBeCloseTo(expected, 6);
    expect(out.side).toBe(-1);
  });

  it('keeps the held side through drift inside the dead band, and drops it past', () => {
    const inside = P.slideSideDeadBandPx - 1;
    expect(slideTop({ anchorX: 200 + inside, prevSide: -1 }).out.side).toBe(-1);
    const past = P.slideSideDeadBandPx + 1;
    expect(slideTop({ anchorX: 200 + past, prevSide: -1 }).out.side).toBe(1);
  });

  it('takes the other side when the held one runs off the margin box', () => {
    // Disc hard against the right margin: sliding right would leave the screen.
    const { ok } = slideTop({ discX: MAX_X - 20, prevSide: 1 });
    expect(ok).toBe(true);
    expect(out.side).toBe(-1);
    expect(out.x).toBeGreaterThanOrEqual(MIN_X);
    expect(out.x).toBeLessThan(MAX_X - 20);
  });

  it('slides along the vertical margin when that is the clamped edge', () => {
    const ok = clampAnchorClearOfDisc(
      MIN_X, 300, true, false, 60, 300, 100, HALF_W,
      MIN_X, MAX_X, MIN_Y, MAX_Y, -1, out,
    );
    expect(ok).toBe(true);
    expect(out.x).toBe(MIN_X);
    expect(out.y).toBeCloseTo(300 - (Math.sqrt(100 * 100 - 30 * 30) + P.slidePadPx), 6);
    expect(out.side).toBe(-1);
  });
});

describe('moonLabelPlacement — enter/leave rect hysteresis', () => {
  // Two 40 px-wide labels: they must be 40 px apart to BOTH appear, but once
  // both are up they tolerate down to 40 − 2·leaveInsetPx before one drops.
  const enterSpan = 40;
  const leaveSpan = enterSpan - 2 * P.leaveInsetPx;
  const settled: ReadonlySet<string> = new Set(['Metis', 'Io']);
  const pair = (dx: number) => [
    cand('Io', { sx: 0, priorityPx: 10 }),
    cand('Metis', { sx: dx, priorityPx: 9 }),
  ];

  it('drops one of a fresh pair at a gap a settled pair keeps', () => {
    const gap = (enterSpan + leaveSpan) / 2;
    expect(run(pair(gap))).toEqual(['Io']);
    expect(run(pair(gap), settled)).toEqual(['Io', 'Metis']);
  });

  it('does not strobe a settled pair across ±1 px of jitter', () => {
    for (const dx of [leaveSpan + 1, leaveSpan + 0.5, leaveSpan, leaveSpan - 0.5, leaveSpan - 1]) {
      const both = run(pair(dx), settled).length === 2;
      // Only the two readings below the leave span may drop a label, and the
      // band is 8 px wide, so a 1 px wobble can never cross it twice.
      expect(both).toBe(dx >= leaveSpan);
    }
  });

  it('gives a newcomer no leave-rect discount against an incumbent', () => {
    // Only a pair that BOTH held their slots gets the smaller rect; a label
    // arriving beside an incumbent must clear the full one.
    const oneHeld: ReadonlySet<string> = new Set(['Io']);
    expect(run(pair(leaveSpan + 1), oneHeld)).toEqual(['Io']);
  });

  it('separates cleanly on the vertical axis too', () => {
    const stacked = [
      cand('Io', { sy: 0, priorityPx: 10 }),
      cand('Metis', { sy: P.labelHeightPx, priorityPx: 9 }),
    ];
    expect(run(stacked)).toEqual(['Io', 'Metis']);
    const overlapping = [
      cand('Io', { sy: 0, priorityPx: 10 }),
      cand('Metis', { sy: P.labelHeightPx - 1, priorityPx: 9 }),
    ];
    expect(run(overlapping)).toEqual(['Io']);
  });
});
