import { describe, expect, it } from 'vitest';
import {
  PLANET_LABEL_ENTER_EXPAND_PX,
  PLANET_LABEL_EVICT_MARGIN,
  PLANET_LABEL_SETTLED_INSET_PX,
  resolvePlanetLabelContest,
  type PlanetLabelContestant,
} from './planetLabelPlacement';

function contestant(
  name: string,
  x: number,
  priority: number,
  overrides: Partial<PlanetLabelContestant> = {},
): PlanetLabelContestant {
  return {
    name,
    x,
    y: 0,
    w: 60,
    h: 24,
    priority,
    incumbent: false,
    exempt: false,
    place: false,
    ...overrides,
  };
}

function placed(contestants: PlanetLabelContestant[]): string[] {
  return contestants.filter((c) => c.place).map((c) => c.name).sort();
}

describe('resolvePlanetLabelContest', () => {
  it('places everything when nothing overlaps', () => {
    const cs = [contestant('Venus', 0, -4), contestant('Earth', 200, -3), contestant('Mars', 400, -1)];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Earth', 'Mars', 'Venus']);
  });

  // Priority is NEGATED apparent magnitude — brighter body = larger number.
  // Venus at mag -4.2 arrives as priority 4.2 and outranks Earth's 3.5.
  it('drops the fainter of an overlapping pair', () => {
    // The whole-system pileup: Venus and Earth labels on near-identical pixels.
    const cs = [contestant('Earth', 10, 3.5), contestant('Venus', 0, 4.2)];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Venus']);
  });

  it('an incumbent defends its slot against a marginally brighter newcomer', () => {
    const cs = [
      contestant('Earth', 10, 3.5, { incumbent: true }),
      contestant('Venus', 0, 3.5 + PLANET_LABEL_EVICT_MARGIN * 0.5),
    ];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Earth']);
  });

  it('a challenger beyond the evict margin takes the slot', () => {
    const cs = [
      contestant('Earth', 10, 3.5, { incumbent: true }),
      contestant('Venus', 0, 3.5 + PLANET_LABEL_EVICT_MARGIN * 1.5),
    ];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Venus']);
  });

  it('hysteresis: a gap wide enough for a settled pair is too narrow to enter', () => {
    // Two boxes with a small positive gap: as a settled pair both survive; the
    // same geometry denies a newcomer, which must clear the enter expansion.
    const gap = PLANET_LABEL_ENTER_EXPAND_PX - 1;
    const settled = [
      contestant('Venus', 0, 4, { incumbent: true }),
      contestant('Earth', 60 + gap, 3, { incumbent: true }),
    ];
    resolvePlanetLabelContest(settled);
    expect(placed(settled)).toEqual(['Earth', 'Venus']);

    const entering = [
      contestant('Venus', 0, 4, { incumbent: true }),
      contestant('Earth', 60 + gap, 3),
    ];
    resolvePlanetLabelContest(entering);
    expect(placed(entering)).toEqual(['Venus']);
  });

  it('a settled pair tolerates mild overlap before one drops', () => {
    const overlap = PLANET_LABEL_SETTLED_INSET_PX * 2 - 1;
    const cs = [
      contestant('Venus', 0, 4, { incumbent: true }),
      contestant('Earth', 60 - overlap, 3, { incumbent: true }),
    ];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Earth', 'Venus']);
  });

  it('a blocker rect denies overlapping labels regardless of rank', () => {
    // The Sun's label: "SMercury" was Mercury's label printing into it.
    const cs = [contestant('Mercury', 10, 5, { incumbent: true })];
    resolvePlanetLabelContest(cs, [{ x: 0, y: 0, w: 60, h: 24 }]);
    expect(placed(cs)).toEqual([]);
  });

  it('an exempt label always places and still blocks lower ranks', () => {
    const cs = [
      contestant('Mercury', 0, 6, { exempt: true }),
      contestant('Venus', 10, -4, { incumbent: true }),
    ];
    resolvePlanetLabelContest(cs, [{ x: -5, y: 0, w: 60, h: 24 }]);
    expect(placed(cs)).toEqual(['Mercury']);
  });

  it('breaks exact ties deterministically by name', () => {
    const cs = [contestant('Neptune', 10, -2), contestant('Jupiter', 0, -2)];
    resolvePlanetLabelContest(cs);
    expect(placed(cs)).toEqual(['Jupiter']);
  });
});
