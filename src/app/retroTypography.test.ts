import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { retroFaceFor, retroTypographyCss } from './retroTypography';

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

  it('sets family and size together, for the element and what is inside it, in its media query', () => {
    const css = retroTypographyCss([
      { selector: '.small, .tiny b', fontSizePx: 9.5, media: null },
      { selector: '.body', fontSizePx: 12, media: null },
      { selector: '.title::before', fontSizePx: 22, media: '(max-width: 640px)' },
    ]);
    expect(css).toContain("html.retro .small, html.retro .small *, html.retro .tiny b, html.retro .tiny b * { font-family: 'Retro Sans 8', monospace !important; font-size: calc(8 * var(--ui-px)) !important; }");
    // The default face is the retro block's own: no rule for it.
    expect(css).not.toContain('.body');
    // A pseudo-element has no descendants to add.
    expect(css).toContain("@media (max-width: 640px) { html.retro .title::before { font-family: 'Retro Sans 14'");
    expect(css).not.toContain('::before *');
  });

  it('has a face for every font size in the stylesheet, and every face is declared there', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const sizes = [...html.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(100);
    const families = new Set(sizes.map((size) => retroFaceFor(size).family));
    for (const family of families) expect(html).toContain(`font-family: '${family}'; src: url(`);
  });
});
