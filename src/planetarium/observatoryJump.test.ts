import { describe, expect, it } from 'vitest';
import { resolveShowVantage, type ShowVantageInput } from './observatoryJump';
import type { SurfaceLandedInfo } from './surfaceView';

const EARTH: SurfaceLandedInfo = { type: 'planet', name: 'Earth' };
const MOON: SurfaceLandedInfo = { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
const MARS: SurfaceLandedInfo = { type: 'planet', name: 'Mars' };
const IO: SurfaceLandedInfo = { type: 'moon', name: 'Io', parentPlanet: 'Jupiter' };
const CALLISTO: SurfaceLandedInfo = { type: 'moon', name: 'Callisto', parentPlanet: 'Jupiter' };

function relocates(over: Partial<ShowVantageInput>): boolean {
  return resolveShowVantage({
    eventParentPlanet: 'Earth',
    eventMoonName: 'Moon',
    landed: EARTH,
    ...over,
  }).relocateToParent;
}

describe('resolveShowVantage', () => {
  it('standing on the Moon during an Earth eclipse, Earth is the better seat', () => {
    expect(relocates({ landed: MOON })).toBe(true);
  });

  it('standing on Earth already has that seat', () => {
    expect(relocates({ landed: EARTH })).toBe(false);
  });

  it('never relocates in a generic system — the local view is the show', () => {
    expect(
      relocates({ landed: IO, eventParentPlanet: 'Jupiter', eventMoonName: 'Io' }),
    ).toBe(false);
    // A sibling watching another moon's event stays put too.
    expect(
      relocates({ landed: CALLISTO, eventParentPlanet: 'Jupiter', eventMoonName: 'Io' }),
    ).toBe(false);
  });

  it('never relocates across systems — the destination could be unpainted', () => {
    expect(relocates({ landed: IO })).toBe(false);
    expect(
      relocates({ landed: MOON, eventParentPlanet: 'Jupiter', eventMoonName: 'Io' }),
    ).toBe(false);
  });

  it('never relocates off another planet — only a moon has a one-tap return', () => {
    expect(relocates({ landed: MARS })).toBe(false);
    expect(
      relocates({ landed: MARS, eventParentPlanet: 'Mars', eventMoonName: 'Phobos' }),
    ).toBe(false);
  });

  it('treats a moon with no recorded parent as a non-match, not a wildcard', () => {
    const orphan: SurfaceLandedInfo = { type: 'moon', name: 'Moon' };
    expect(relocates({ landed: orphan })).toBe(false);
  });

  it('is the Earth-almanac pair specifically, not any event in Earth’s system', () => {
    // Defensive: a hypothetical second Earth moon would not carry the
    // corona/blood-moon promise the relocation is made for.
    expect(relocates({ landed: MOON, eventMoonName: 'Cruithne' })).toBe(false);
  });
});
