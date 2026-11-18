import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETRO_ICONS, RETRO_ICON_COLOURS, retroIconSvg, retroIconUrl } from './retroIcons';

describe('the retro pixel icons', () => {
  it('are all 12 × 12, in colours the key names', () => {
    for (const [name, rows] of Object.entries(RETRO_ICONS)) {
      expect(rows, name).toHaveLength(12);
      for (const row of rows) {
        expect(row, name).toHaveLength(12);
        for (const letter of row) if (letter !== '.') expect(RETRO_ICON_COLOURS[letter], `${name} ${letter}`).toBeDefined();
      }
    }
  });

  it('draw one crisp square per cell, runs of a colour joined along a row', () => {
    const svg = retroIconSvg(['kk.', '.w.', '...']);
    expect(svg).toContain('viewBox="0 0 3 3" shape-rendering="crispEdges"');
    expect(svg).toContain('<rect x="0" y="0" width="2" height="1" fill="#000000"/>');
    expect(svg).toContain('<rect x="1" y="1" width="1" height="1" fill="#ffffff"/>');
    expect((svg.match(/<rect/g) ?? []).length).toBe(2);
    expect(retroIconUrl(['k'])).toMatch(/^url\("data:image\/svg\+xml,%3Csvg/);
  });

  it('cover every icon the retro block in index.html asks for', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const asked = new Set([...html.matchAll(/var\(--rt-icon-([a-z]+)\)/g)].map((match) => match[1]));
    expect(asked.size).toBeGreaterThan(10);
    for (const name of asked) expect(RETRO_ICONS[name], name).toBeDefined();
  });
});
