import { describe, expect, it } from 'vitest';
import { BLOOM_THRESHOLD } from '../../app/bloomConfig';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { starfieldFaintLimitMag, starRenderColor } from './starfield';
import { STAR_FAINT_ANCHOR_MAG } from './starPointMapping';

// Rec.709 luminance weights — the same coefficients three's bloom high-pass
// (LuminosityHighPassShader) uses for the working sRGB colour space.
const REC709 = [0.2126, 0.7152, 0.0722] as const;

describe('starfield faint anchor', () => {
  it('is pinned, not read off the catalog', () => {
    // The catalog now runs deeper than the anchor. If the faint limit tracked
    // the catalog again, every star in the last 1.6 magnitudes would brighten
    // and the moon dots' handoff would slide with it.
    expect(starfieldFaintLimitMag()).toBe(STAR_FAINT_ANCHOR_MAG);
    const faintest = BRIGHT_STAR_CATALOG.reduce(
      (dimmest, s) => (s.magnitude > -10 && s.magnitude > dimmest ? s.magnitude : dimmest),
      -Infinity,
    );
    expect(faintest).toBeGreaterThan(STAR_FAINT_ANCHOR_MAG);
  });
});

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
