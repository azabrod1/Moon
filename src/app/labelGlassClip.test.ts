import { beforeEach, describe, expect, it } from 'vitest';
import { WORLD_LABEL_LAYER_IDS, clipWorldLabelsAroundGlass, labelGlassClipPath, resetLabelGlassClipForTests } from './labelGlassClip';

beforeEach(() => resetLabelGlassClipForTests());

describe('labelGlassClipPath', () => {
  it('is empty with no panels, so the labels are not clipped at all', () => {
    expect(labelGlassClipPath([], 1280, 800)).toBe('');
  });

  it('cuts one hole per panel out of the viewport, even-odd', () => {
    const path = labelGlassClipPath(
      [{ left: 934.5, top: 57, right: 1268, bottom: 735 }, { left: 445, top: 747, right: 835, bottom: 788 }],
      1280,
      800,
    );
    expect(path).toBe(
      'path(evenodd, "M0 0H1280V800H0ZM934.5 57H1268V735H934.5ZM445 747H835V788H445Z")',
    );
  });
});

describe('clipWorldLabelsAroundGlass', () => {
  it('clips every label layer, and writes again only when the panels move', () => {
    const layers = new Map(WORLD_LABEL_LAYER_IDS.map((id) => [id, { style: { clipPath: '' } }]));
    let writes = 0;
    const lookup = (id: string) => {
      writes++;
      return layers.get(id as (typeof WORLD_LABEL_LAYER_IDS)[number]) ?? null;
    };
    const panel = [{ left: 10, top: 10, right: 100, bottom: 100 }];
    clipWorldLabelsAroundGlass(panel, 400, 300, lookup);
    for (const layer of layers.values()) expect(layer.style.clipPath).toContain('M10 10H100V100H10Z');
    const afterFirst = writes;
    clipWorldLabelsAroundGlass(panel, 400, 300, lookup);
    expect(writes).toBe(afterFirst);
    clipWorldLabelsAroundGlass([], 400, 300, lookup);
    for (const layer of layers.values()) expect(layer.style.clipPath).toBe('');
  });
});
