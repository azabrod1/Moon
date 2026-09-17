import { describe, expect, it } from 'vitest';
import { fusedFragmentIsWired, fusedFragmentText, parseFusedParam } from './FusedOutputPass';

const VARIANTS = [
  { lens: false, glow: false },
  { lens: false, glow: true },
  { lens: true, glow: false },
  { lens: true, glow: true },
];

describe('the finishing pass’s four shader texts', () => {
  it('each carries exactly the edits its variant is made of', () => {
    // Every one of them is a string replacement into three's own OutputShader,
    // and a replacement that found nothing is silent: a pass that drops the
    // glow, one that reads its whole allocation where the frame is a corner of
    // it, or one whose warp is missing so the frame comes out rectilinear.
    for (const variant of VARIANTS) {
      expect(fusedFragmentIsWired(variant)).toBe(true);
    }
  });

  it('keeps the four apart, so one mode’s text never reaches another', () => {
    // There is one composer in the app, rebuilt per camera: the planetarium
    // wants the warp and the other three modes do not. A single memoised text
    // would hand whichever mode was entered first its own text to every later
    // one — silently: three uploads only the uniforms a material carries, so a
    // warped text on a material without the warp uniforms draws the plain read
    // at a strength of zero, and a text without the glow line on a composer
    // with a bloom chain draws no glow at all.
    const texts = VARIANTS.map((v) => fusedFragmentText(v));
    expect(new Set(texts).size).toBe(4);
    for (const [i, variant] of VARIANTS.entries()) {
      expect(texts[i].includes('lensSourceUv')).toBe(variant.lens);
      expect(texts[i].includes('tBloom')).toBe(variant.glow);
      // And a text held against the wrong variant is reported as unwired.
      for (const other of VARIANTS) {
        const same = other.lens === variant.lens && other.glow === variant.glow;
        expect(fusedFragmentIsWired(other, { fragmentShader: texts[i] } as never)).toBe(same);
      }
    }
  });

  it('is assembled once and kept', () => {
    // A module-level string edit is work a bundler keeps, so the texts are lazy
    // — and then they must be memoised, or every composer rebuild pays for four
    // string passes over three's shader.
    expect(fusedFragmentText({ lens: true, glow: true }))
      .toBe(fusedFragmentText({ lens: true, glow: true }));
  });

  it('tone-maps with three’s own text, untouched', () => {
    // Exposure, the tone curve and the output colour transform are OutputPass's
    // own, re-derived from the renderer per render: the fold adds lines to that
    // shader and changes none of them.
    const text = fusedFragmentText({ lens: true, glow: true });
    expect(text).toContain('#include <tonemapping_pars_fragment>');
    expect(text).toContain('#include <colorspace_pars_fragment>');
    expect(text).toContain('ACESFilmicToneMapping( gl_FragColor.rgb )');
    expect(text).toContain('sRGBTransferOETF( gl_FragColor )');
  });
});

describe('the ?fused= kill switch', () => {
  it('is on unless a URL says 0', () => {
    expect(parseFusedParam('')).toBe(true);
    expect(parseFusedParam('?auto=planetarium')).toBe(true);
    expect(parseFusedParam('?fused=1')).toBe(true);
    expect(parseFusedParam('?fused=0')).toBe(false);
    expect(parseFusedParam('?debug=1&fused=0&quality=medium')).toBe(false);
  });
});
