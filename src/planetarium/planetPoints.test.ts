import { describe, expect, it } from 'vitest';
import { BLOOM_THRESHOLD } from '../app/bloomConfig';
import { PLANET_POINT_PARAMS, planetColorIndex, planetPointVisual, rec709Luminance } from './planetPoints';
import { getStarColor } from './world/starfield';
import { STAR_FAINT_ANCHOR_MAG, starBeyondAnchorScale, starPointVisual } from './world/starPointMapping';

const chromaLuminance = (colorIndex: number) => {
  const color = getStarColor(colorIndex);
  return rec709Luminance(color.r, color.g, color.b);
};
const point = (magnitude: number, colorIndex: number, discPx = 0, lit = 1) =>
  planetPointVisual(magnitude, discPx, lit, chromaLuminance(colorIndex), BLOOM_THRESHOLD, STAR_FAINT_ANCHOR_MAG);

describe('planet points', () => {
  it('draw as a star of the same magnitude below the bright end', () => {
    for (const magnitude of [-1.4, -1, -0.3, 1, 3.5, 5.7, 7.8]) {
      const planet = point(magnitude, 0.86);
      const star = starPointVisual(magnitude, STAR_FAINT_ANCHOR_MAG);
      expect(planet.sizePx).toBe(star.sizePx);
      expect(planet.brightness).toBe(star.brightness);
      expect(planet.alpha).toBe(star.alpha * starBeyondAnchorScale(magnitude));
    }
  });

  it('keep Venus over Jupiter over Sirius, and never reach the bloom line', () => {
    // Drawn light: the point's brightest pixel times its area.
    const drawnLight = (visual: { brightness: number; sizePx: number; alpha: number }, colorIndex: number) =>
      visual.brightness * chromaLuminance(colorIndex) * visual.sizePx ** 2 * visual.alpha;
    const venus = drawnLight(point(-4.4, planetColorIndex('Venus')), planetColorIndex('Venus'));
    const jupiter = drawnLight(point(-2.5, planetColorIndex('Jupiter')), planetColorIndex('Jupiter'));
    const sirius = drawnLight(starPointVisual(-1.46, STAR_FAINT_ANCHOR_MAG), 0);
    expect(venus).toBeGreaterThan(1.2 * jupiter);
    expect(jupiter).toBeGreaterThan(1.2 * sirius);
    let fainter = 0;
    for (let magnitude = 9; magnitude >= -9; magnitude -= 0.25) {
      const light = drawnLight(point(magnitude, 0.86), 0.86);
      expect(light, `${magnitude}`).toBeGreaterThanOrEqual(fainter);
      fainter = light;
    }
    for (const name of ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
      for (const magnitude of [-9, -5, -3, -1]) {
        const visual = point(magnitude, planetColorIndex(name));
        expect(visual.brightness * chromaLuminance(planetColorIndex(name)), `${name} ${magnitude}`)
          .toBeLessThan(BLOOM_THRESHOLD);
      }
    }
  });

  it('hand over to the drawn disc as it resolves', () => {
    expect(point(-2.5, 0.86, 0).alpha).toBe(1);
    expect(point(-2.5, 0.86, PLANET_POINT_PARAMS.fadeEndPx).alpha).toBe(0);
    let previous = Infinity;
    for (let discPx = 0; discPx <= PLANET_POINT_PARAMS.fadeEndPx; discPx += 0.5) {
      const visual = point(-2.5, 0.86, discPx);
      expect(visual.alpha).toBeLessThanOrEqual(previous);
      expect(visual.sizePx).toBeLessThanOrEqual(point(-2.5, 0.86, 0).sizePx);
      previous = visual.alpha;
    }
    expect(point(Number.NaN, 0.86).alpha).toBe(0);
  });

  it('take B−V from the reference B and V magnitudes', () => {
    expect(planetColorIndex('Mars')).toBeCloseTo(1.36, 10);
    expect(planetColorIndex('Venus')).toBeCloseTo(0.7, 10);
    expect(planetColorIndex('Neptune')).toBeCloseTo(0.39, 10);
    expect(planetColorIndex('Pluto')).toBeNaN();
  });
});
