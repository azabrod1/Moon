import { describe, expect, it } from 'vitest';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { createShadowVisualsWarmupProbes } from './ShadowVisuals';

describe('shadow visuals warm-up probes', () => {
  it('compile the programs the live guides draw with, lens augmentation included', () => {
    const { group, dispose } = createShadowVisualsWarmupProbes();
    const lines = group.children.filter((o) => (o as { material?: unknown }).material instanceof LineMaterial);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const mat = (line as Line2).material;
      // The lens augmentation tags the program key; without it a probe
      // compiles a program no guide ever draws.
      expect(mat.customProgramCacheKey()).toBe('fixed-screen-line-lens-v2');
    }
    expect(group.children.map((o) => o.raycast.length)).toEqual(group.children.map(() => 0));
    expect(group.visible).toBe(false);
    dispose();
  });
});
