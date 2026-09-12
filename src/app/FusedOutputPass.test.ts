import { describe, expect, it } from 'vitest';
import { fusedFragmentIsWired } from './FusedOutputPass';

describe('the fused final pass', () => {
  it('really carries the glow it folds in', () => {
    // The fused shader is three's own OutputShader text with two lines put
    // into it by string replacement, so a three release that reformats that
    // shader would leave a pass which tone-maps the lens result and drops the
    // bloom silently — a frame with no glow and no error anywhere.
    expect(fusedFragmentIsWired()).toBe(true);
  });
});
