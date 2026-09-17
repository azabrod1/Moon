import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import mode from './PlanetariumMode.ts?raw';

// The ☰ panel's settings rows are vanilla HTML and the mode reaches them by
// id, so nothing but a running app connects the two: a row renamed in the HTML
// leaves a button that does nothing, and a row read by the mode with no
// element leaves a setting with no control. These tests read both files as
// text and pin the id sets against each other.
//
// Scoped to the `settings-…-toggle` / `settings-…-label` pairs, which are one
// shape with one owner (PlanetariumMode's wireUpUI and its sync helpers). The
// panel's other ids are read from several places and would make this a
// whole-app id audit instead.

function idsIn(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(pattern)].map((m) => m[1]));
}

const declared = idsIn(html, /id="(settings-[a-z-]+-(?:toggle|label))"/g);
const read = idsIn(mode, /'(settings-[a-z-]+-(?:toggle|label))'/g);

describe('☰ settings rows', () => {
  it('declares every id the mode reads', () => {
    expect([...read].filter((id) => !declared.has(id))).toEqual([]);
  });

  it('reads every id it declares', () => {
    expect([...declared].filter((id) => !read.has(id))).toEqual([]);
  });

  it('pairs a label with every toggle', () => {
    for (const id of declared) {
      const twin = id.endsWith('-toggle')
        ? id.replace(/-toggle$/, '-label')
        : id.replace(/-label$/, '-toggle');
      expect(declared.has(twin), `${id} has no ${twin}`).toBe(true);
    }
  });
});

describe('the graphics-quality row', () => {
  it('sits last in the panel, after "Slower near planets"', () => {
    const throttle = html.indexOf('id="settings-throttle-toggle"');
    const quality = html.indexOf('id="settings-quality-toggle"');
    const build = html.indexOf('id="menu-build"');
    expect(throttle).toBeGreaterThan(0);
    expect(quality).toBeGreaterThan(throttle);
    expect(build).toBeGreaterThan(quality);
  });

  it('is one cycling button in the multi-state idiom', () => {
    // One `.settings-toggle`, not a row of four: four buttons reading Low /
    // Medium / High / Dynamic want about 357 px, and the panel has no
    // max-width, so on a 315 px phone the row would push the panel off the
    // left edge. `aria-pressed` is what "Label distances" carries.
    const row = html.match(/<div class="settings-row">\s*<span class="settings-label">Graphics quality<\/span>[\s\S]*?<\/div>/);
    expect(row).not.toBeNull();
    const markup = row?.[0] ?? '';
    expect([...markup.matchAll(/<button/g)]).toHaveLength(1);
    expect(markup).toContain('class="settings-toggle"');
    expect(markup).toContain('aria-pressed=');
  });
});
