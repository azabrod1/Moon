import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETRO_FIXED_FACE_INSIDE, RETRO_FIXED_FACE_REGIONS, retroFaceFor, retroTypographyCss, splitSelectorList } from './retroTypography';

const rule = (selector: string, fontSize: string, setsFamily = false, media: string | null = null) => ({ selector, fontSize, setsFamily, media });

describe('the retro type sizes', () => {
  it('maps every modern size to the nearest bitmap face', () => {
    expect(retroFaceFor(7.5)).toEqual({ family: 'Retro Sans 8', pixels: 8 });
    expect(retroFaceFor(10.5)).toEqual({ family: 'Retro Sans 8', pixels: 8 });
    expect(retroFaceFor(11)).toEqual({ family: 'Retro Sans 10', pixels: 10 });
    expect(retroFaceFor(13)).toEqual({ family: 'Retro Sans 10', pixels: 10 });
    expect(retroFaceFor(15)).toEqual({ family: 'Retro Sans 12', pixels: 12 });
    expect(retroFaceFor(18)).toEqual({ family: 'Retro Sans 14', pixels: 14 });
    expect(retroFaceFor(40)).toEqual({ family: 'Retro Sans 18', pixels: 18 });
  });

  it('sets family and size together on the element itself, every size included, media kept', () => {
    const css = retroTypographyCss([
      rule('.small, .tiny b', '9.5px'),
      rule('.body', '12px'),
      rule('.title::before', '22px', false, '(max-width: 640px)'),
    ]);
    expect(css).toContain("html.retro .small, html.retro .tiny b { font-family: 'Retro Sans 8', monospace !important; font-size: calc(8 * var(--ui-px)) !important; }");
    // The default face is written too, so a Sans 10 element inside a larger parent keeps its own size.
    expect(css).toContain("html.retro .body { font-family: 'Retro Sans 10'");
    expect(css).toContain("@media (max-width: 640px) { html.retro .title::before { font-family: 'Retro Sans 14'");
    // No descendant rules: inheritance carries a face into what an element holds.
    expect(css).not.toMatch(/ \* \{|\*,/);
  });

  it('keeps a family-only rule or a relative size from splitting family and size', () => {
    const css = retroTypographyCss([rule('.mono', '', true), rule('.smaller', '0.85em'), rule('.gone', '0'), rule('.plain', '')]);
    expect(css).toContain('html.retro .mono { font-family: inherit !important; }');
    expect(css).toContain('html.retro .smaller { font-family: inherit !important; font-size: inherit !important; }');
    expect(css).not.toContain('.gone');
    expect(css).not.toContain('.plain');
  });

  it('leaves the regions with a hand-set face, and the retro block itself, alone', () => {
    const css = retroTypographyCss([
      rule('.tr-clock .t, .menu-note', '10.5px'),
      rule('#top-bar h1', '18px'),
      rule('html.retro .x', '12px'),
    ]);
    expect(css).toBe("html.retro .menu-note { font-family: 'Retro Sans 8', monospace !important; font-size: calc(8 * var(--ui-px)) !important; }");
  });

  it('splits a selector list on its top-level commas only', () => {
    expect(splitSelectorList('.a:is(.b, .c) span, .d[data-x="1,2"] , :not(.e,.f)')).toEqual(['.a:is(.b, .c) span', '.d[data-x="1,2"]', ':not(.e,.f)']);
    expect(retroTypographyCss([rule('.a:is(.b, .c)', '16px')])).toContain('html.retro .a:is(.b, .c) {');
  });

  it('has a face for every font size in the stylesheet, every face declared, and every fixed region set by the retro block', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const sizes = [...html.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(100);
    for (const family of new Set(sizes.map((size) => retroFaceFor(size).family))) expect(html).toContain(`font-family: '${family}'; src: url(`);
    for (const region of RETRO_FIXED_FACE_REGIONS) expect(html, region).toMatch(new RegExp(`(html\\.retro )?${region.replace(/[.#]/g, '\\$&')}[^{]*\\{[^}]*font-family: 'Retro`));
    // The ids skipped as inside a region really sit inside the speed readout.
    for (const id of RETRO_FIXED_FACE_INSIDE) expect(html, id).toMatch(new RegExp(`class="speed-center">[\\s\\S]{0,200}id="${id.slice(1)}"`));
  });
});
