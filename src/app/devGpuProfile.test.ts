import { describe, expect, it } from 'vitest';
import { objectLabel, rankObjects, rankPasses } from './devGpuProfile';

describe('objectLabel', () => {
  it('folds streamed sectors, markers and orbit lines into one row each', () => {
    expect(objectLabel({ name: 'Earth sector 3_7/e', type: 'Mesh', parent: null }, 'ShaderMaterial')).toBe('Earth sectors');
    expect(objectLabel({ name: 'marker-Mars', type: 'Sprite', parent: null }, 'SpriteMaterial')).toBe('body markers');
    expect(objectLabel({ name: 'orbit-Venus', type: 'Line', parent: null }, 'LineBasicMaterial')).toBe('orbit lines');
  });

  it('names an unnamed object after its nearest named ancestor, else its type and material', () => {
    const earth = { name: 'Earth', parent: null };
    const group = { name: '', parent: earth };
    expect(objectLabel({ name: '', type: 'Mesh', parent: group }, 'MeshStandardMaterial')).toBe('Earth › Mesh (MeshStandardMaterial)');
    expect(objectLabel({ name: '', type: 'Points', parent: null }, 'PointsMaterial')).toBe('Points (PointsMaterial)');
  });
});

describe('rankObjects', () => {
  it('averages per frame, takes the clock overhead off per draw, and ranks by what is left', () => {
    // Two frames. The scene pass measured 10 ms; the object spans sum to 14 ms
    // per frame over 4 draws, so the clock costs 1 ms per draw.
    const records = [
      { label: 'Earth', ms: 8 }, { label: 'clouds', ms: 3 }, { label: 'ship', ms: 1.5 }, { label: 'ship', ms: 1.5 },
      { label: 'Earth', ms: 8 }, { label: 'clouds', ms: 3 }, { label: 'ship', ms: 1.5 }, { label: 'ship', ms: 1.5 },
    ];
    const { rows, sum } = rankObjects(records, 2, 10, 10);
    expect(sum.draws).toBe(4);
    expect(sum.ms).toBeCloseTo(14);
    expect(sum.overheadPerDrawMs).toBeCloseTo(1);
    expect(rows.map((r) => r.label)).toEqual(['Earth', 'clouds', 'ship']);
    expect(rows[0].netMs).toBeCloseTo(7);
    expect(rows[2].draws).toBe(2);
    expect(rows[2].netMs).toBeCloseTo(1);
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
  });

  it('never estimates a negative overhead and folds the tail into one row', () => {
    const records = [{ label: 'a', ms: 3 }, { label: 'b', ms: 2 }, { label: 'c', ms: 1 }];
    const { rows, sum } = rankObjects(records, 1, 9, 2);
    expect(sum.overheadPerDrawMs).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[2].label).toBe('everything else (1 rows)');
    expect(rows[2].netMs).toBe(1);
  });
});

describe('rankPasses', () => {
  it('keeps composer order and averages per frame', () => {
    const { rows, sumMs } = rankPasses([
      { name: 'RenderPass', ms: 6 }, { name: 'Bloom', ms: 2 },
      { name: 'RenderPass', ms: 4 }, { name: 'Bloom', ms: 2 },
    ], 2);
    expect(rows.map((r) => r.name)).toEqual(['RenderPass', 'Bloom']);
    expect(rows[0].ms).toBe(5);
    expect(sumMs).toBe(7);
    expect(rows[1].share).toBeCloseTo(2 / 7);
  });
});
