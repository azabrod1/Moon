import { describe, expect, it } from 'vitest';
import { BLOOM_THRESHOLD } from '../../app/bloomConfig';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { starRenderColor } from './starfield';

// Rec.709 luminance weights — the same coefficients three's bloom high-pass
// (LuminosityHighPassShader) uses for the working sRGB colour space.
const REC709 = [0.2126, 0.7152, 0.0722] as const;

describe('starfield bloom-threshold invariant', () => {
  it('keeps every catalog star below the bloom cutoff, with headroom to spare', () => {
    // The starfield is the only star population — Constellations reuse the same
    // catalog for line endpoints, and the asteroid belt is a separate material —
    // so this single sweep governs what can bloom.
    const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10); // Sol drawn as a mesh
    let maxLuma = 0;
    let brightest = '';
    for (const star of catalog) {
      const c = starRenderColor(star.colorIndex, star.magnitude);
      const luma = REC709[0] * c.r + REC709[1] * c.g + REC709[2] * c.b;
      if (luma > maxLuma) {
        maxLuma = luma;
        brightest = star.name ?? `mag ${star.magnitude}`;
      }
    }

    // The invariant: no star reaches the bloom high-pass, so none survives as a
    // star-shaped glint near the Sun. Failure message names the offender.
    expect(maxLuma, `brightest star: ${brightest} (luma ${maxLuma.toFixed(4)})`).toBeLessThan(
      BLOOM_THRESHOLD,
    );
    // Yet the field genuinely rides near the cutoff — the threshold move earns
    // its keep. If a brightness retune drops this floor, the guard is going slack.
    expect(maxLuma).toBeGreaterThan(0.85);
  });
});
