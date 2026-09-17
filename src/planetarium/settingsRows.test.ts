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

describe('the graphics-quality and frame-rate rows', () => {
  it('sit at the end of the panel, after "Slower near planets", quality then frame rate', () => {
    const throttle = html.indexOf('id="settings-throttle-toggle"');
    const quality = html.indexOf('id="settings-quality-toggle"');
    const fps = html.indexOf('id="settings-fps-toggle"');
    const build = html.indexOf('id="menu-build"');
    expect(throttle).toBeGreaterThan(0);
    expect(quality).toBeGreaterThan(throttle);
    expect(fps).toBeGreaterThan(quality);
    expect(build).toBeGreaterThan(fps);
  });

  for (const label of ['Graphics quality', 'Frame rate']) {
    it(`"${label}" is one cycling button in the multi-state idiom`, () => {
      // One `.settings-toggle`, not a row of four: four buttons reading Low /
      // Medium / High / Dynamic want about 357 px, and the panel has no
      // max-width, so on a 315 px phone the row would push the panel off the
      // left edge. `aria-pressed` is what "Label distances" carries.
      const row = html.match(
        new RegExp(`<div class="settings-row">\\s*<span class="settings-label">${label}</span>[\\s\\S]*?</div>`),
      );
      expect(row).not.toBeNull();
      const markup = row?.[0] ?? '';
      expect([...markup.matchAll(/<button/g)]).toHaveLength(1);
      expect(markup).toContain('class="settings-toggle"');
      expect(markup).toContain('aria-pressed=');
    });
  }

  it('the panel scrolls, so the last row is reachable on a small phone', () => {
    // Eleven settings rows put the panel's bottom around 578 px by the CSS
    // arithmetic, and the page itself cannot scroll (html, body are
    // overflow: hidden), so without this the last row is simply unreachable
    // at 320x568.
    const panel = html.match(/#planetarium-menu-panel \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(panel).toContain('overflow-y: auto');
    expect(panel).toContain('overscroll-behavior: contain');
    expect(panel).toContain('touch-action: pan-y');
    // The dvh line with a vh fallback before it: an engine without dvh would
    // drop the whole declaration and restore the unreachable row.
    expect(panel).toContain('max-height: calc(100vh - 68px)');
    expect(panel.indexOf('max-height: calc(100vh - 68px)'))
      .toBeLessThan(panel.indexOf('max-height: calc(100dvh - 68px)'));
  });
});
