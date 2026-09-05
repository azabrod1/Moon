import { describe, expect, it } from 'vitest';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Line2 } from 'three/addons/lines/Line2.js';
import { createShadowVisualsWarmupProbes } from './ShadowVisuals';

describe('shadow visuals warm-up probes', () => {
  it('compile the programs the live guides draw with, lens augmentation included, and are never pickable', () => {
    const { group, dispose } = createShadowVisualsWarmupProbes();
    const lines = group.children.filter((o) => (o as { material?: unknown }).material instanceof LineMaterial);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const mat = (line as Line2).material;
      // The lens augmentation is part of the program key; without it a probe
      // compiles a program no guide ever draws.
      expect(mat.customProgramCacheKey()).toBe('fixed-screen-line-lens-v2');
    }
    for (const child of group.children) {
      const hits: unknown[] = [];
      (child.raycast as (r: unknown, hits: unknown[]) => void)(null, hits);
      expect(hits).toEqual([]);
    }
    expect(group.visible).toBe(false);
    dispose();
  });
});
