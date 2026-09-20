import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import mode from './PlanetariumMode.ts?raw';
import panel from './ui/PlanetariumMenuPanel.ts?raw';
import segmented from './ui/SegmentedControl.ts?raw';
import { QUALITY_LEVELS } from '../app/renderQuality';
import { FRAME_RATES } from '../app/frameRateSetting';

// The ☰ panel is vanilla HTML and the TypeScript reaches it by id, so nothing
// but a running app connects the two: a row renamed in the HTML leaves a
// button that does nothing, and an id read by the mode with no element leaves
// a setting with no control. These tests read both sides as text and pin the
// id sets against each other.
//
// The reading side is every module that looks an id up: the mode, the panel
// itself, and the segmented control's wiring.
//
// What these tests CANNOT see is the panel's behaviour — the page slide, the
// focus moves, reset-to-root on hide. There is no jsdom in this repo, and a
// fake DOM would only pin the fake. That behaviour is proved in a real browser
// by the capture run (planning/menu-tiers), on Chromium and on WebKit.

const ts = [mode, panel, segmented].join('\n');

function idsIn(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(pattern)].map((m) => m[1]));
}

const panelMarkup = html.slice(
  html.indexOf('<div id="planetarium-menu-panel"'),
  html.indexOf('<!-- Observatory panel:'),
);
const rootPage = panelMarkup.slice(
  panelMarkup.indexOf('data-page="root"'),
  panelMarkup.indexOf('data-page="graphics"'),
);
const graphicsPage = panelMarkup.slice(panelMarkup.indexOf('data-page="graphics"'));

const declared = idsIn(html, /id="(settings-[a-z-]+-(?:toggle|label))"/g);
const read = idsIn(ts, /'(settings-[a-z-]+-(?:toggle|label))'/g);

describe('☰ settings rows', () => {
  it('declares every id the TypeScript reads', () => {
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

describe('the Graphics page', () => {
  // Every id in the page, and every id the TypeScript asks the page for. The
  // segments are the one set the TypeScript never names: it reads the group
  // and each segment's data-value, so their ids are pinned below against the
  // level and rate lists instead.
  const pageIds = [...idsIn(graphicsPage, /id="([a-z0-9-]+)"/g)]
    .filter((id) => id !== 'menu-page-graphics');
  const pageRead = idsIn(ts, /(?:getElementById|setText)\('(settings-[a-z0-9-]+|menu-page-[a-z0-9-]+)'/g);
  const segmentIds = new Set([
    ...QUALITY_LEVELS.map((level) => `settings-quality-${level}`),
    ...FRAME_RATES.map((rate) => `settings-fps-${rate}`),
  ]);

  it('lives inside the panel, behind a tier row that names it', () => {
    expect(panelMarkup).toContain('class="menu-page" data-page="graphics"');
    expect(panelMarkup).toContain('data-open="graphics"');
    expect(graphicsPage).toContain('class="menu-back"');
  });

  it('declares every id the TypeScript writes into it', () => {
    const missing = [...pageRead].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('carries nothing the TypeScript never reads', () => {
    expect(pageIds.filter((id) => !pageRead.has(id) && !segmentIds.has(id))).toEqual([]);
  });

  it('gives every level and every frame rate a segment of its own', () => {
    for (const id of segmentIds) expect(graphicsPage, id).toContain(`id="${id}"`);
    for (const level of QUALITY_LEVELS) expect(graphicsPage).toContain(`data-value="${level}"`);
    for (const rate of FRAME_RATES) expect(graphicsPage).toContain(`data-value="${rate}"`);
  });

  it('holds both controls as radiogroups of checkable radios', () => {
    const groups = [...panelMarkup.matchAll(/role="radiogroup"[\s\S]*?<\/div>/g)].map((m) => m[0]);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const radios = [...group.matchAll(/role="radio"/g)];
      expect(radios.length).toBeGreaterThanOrEqual(2);
      expect([...group.matchAll(/aria-checked=/g)]).toHaveLength(radios.length);
    }
  });

  it('describes each group by the note under it', () => {
    expect(graphicsPage).toContain('aria-describedby="settings-quality-note"');
    expect(graphicsPage).toContain('aria-describedby="settings-fps-note"');
  });

  it('leaves the old cycling buttons behind in both files', () => {
    // Four buttons reading Low / Medium / High / Dynamic wanted about 357 px
    // and the old panel was 190 px wide, which is why the setting was one
    // button whose label cycled. The control has a line of its own inside a
    // 304 px page now, so the four choices are all on screen at once.
    for (const id of ['settings-quality-toggle', 'settings-fps-toggle']) {
      expect(html).not.toContain(id);
      expect(ts).not.toContain(id);
    }
  });
});

describe('the root page', () => {
  it('puts the Graphics tier between the actions and the toggles', () => {
    const lastAction = rootPage.indexOf('id="planetarium-btn-map"');
    const tier = rootPage.indexOf('data-open="graphics"');
    const ship = rootPage.indexOf('id="settings-ship-toggle"');
    const throttle = rootPage.indexOf('id="settings-throttle-toggle"');
    const build = rootPage.indexOf('id="menu-build"');
    expect(lastAction).toBeGreaterThan(0);
    expect(tier).toBeGreaterThan(lastAction);
    expect(ship).toBeGreaterThan(tier);
    expect(build).toBeGreaterThan(throttle);
  });

  it('leaves the Tools row to the cluster button alone', () => {
    // The root page carried a Tools row with the SAME id as the cluster's
    // Tools button. getElementById answers with the first element in document
    // order, which is the cluster button, so the row's listener was bound to
    // the button a second time and the row itself had none: it never did
    // anything from the day it was written. The front door is the cluster
    // icon; the row is gone and so is the listener that missed it.
    expect(rootPage).not.toContain('id="planetarium-btn-tools"');
    // One element, one listener: a second binding here is the tell that some
    // other element has taken the name back.
    const bindings = ts.match(
      /getElementById\('planetarium-btn-tools'\)\?\.addEventListener/g,
    ) ?? [];
    expect(bindings).toHaveLength(1);
  });

  it('keeps the build stamp last, where ?debug=1 reveals it', () => {
    expect(rootPage.indexOf('id="menu-build"'))
      .toBeGreaterThan(rootPage.lastIndexOf('class="settings-row"'));
  });
});

describe('the ids the TypeScript reaches by name', () => {
  it('declares each one exactly once in the document', () => {
    // Every id in here is read back with getElementById, which answers with
    // the FIRST element carrying the name and never says there was a second.
    // A duplicate is therefore silent: one of the two elements is wired twice
    // and the other is wired not at all, and only a running app shows it.
    const seen = new Map<string, number>();
    for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
      seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicated).toEqual([]);
  });
});

describe('the panel\'s own rules', () => {
  it('hides the page that is not current, over its own display', () => {
    // .menu-page carries an author display (the pages share one grid cell),
    // which would beat the hidden attribute's UA rule and leave both pages
    // stacked on top of each other.
    const rule = html.match(/\.menu-page\[hidden\] \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('display: none');
    expect(rule).toContain('!important');
  });

  it('stills the slide for a reader who asked for less motion', () => {
    // The slide is a Web Animations call in the panel class, so the
    // reduced-motion check lives there too: the page is swapped outright and
    // no animation is created. The CSS carries no transition on a page, so
    // nothing can animate by another route.
    expect(panel).toContain('prefers-reduced-motion: reduce');
    expect(panel).toContain('.animate(');
    const pageRule = html.match(/\.menu-page \{[^}]*\}/)?.[0] ?? '';
    expect(pageRule).not.toContain('transition');
  });

  it('never lets focus scroll the panel sideways mid-slide', () => {
    // The incoming page is a page-width off to the right when its back button
    // takes focus. A panel that scrolled that button into view carried every
    // row across with it and snapped back when the slide settled — 26 px at a
    // phone width in WebKit, which reads as the text bouncing. Every focus
    // call in here refuses the scroll, and the slide holds the vertical axis
    // alone so the sideways clip in the CSS is never replaced.
    const focusCalls = panel.match(/\.focus\([^)]*\)/g) ?? [];
    expect(focusCalls.length).toBeGreaterThan(0);
    for (const call of focusCalls) expect(call).toContain('preventScroll: true');
    expect(panel).toContain('panel.style.overflowY');
    expect(panel).not.toMatch(/style\.overflow\s*=/);
    expect(panel).toContain("removeProperty('overflow-y')");
    expect(panel).toContain('panel.scrollLeft = 0');
  });

  it('scrolls, so the last row is reachable on a small phone', () => {
    // Eleven settings rows put the panel's bottom around 578 px by the CSS
    // arithmetic, and the page itself cannot scroll (html, body are
    // overflow: hidden), so without this the last row is simply unreachable
    // at 320x568.
    const panelCss = html.match(/#planetarium-menu-panel \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(panelCss).toContain('overflow-y: auto');
    expect(panelCss).toContain('overscroll-behavior: contain');
    expect(panelCss).toContain('touch-action: pan-y');
    // The dvh line with a vh fallback before it: an engine without dvh would
    // drop the whole declaration and restore the unreachable row.
    expect(panelCss).toContain('max-height: calc(100vh - 68px)');
    expect(panelCss.indexOf('max-height: calc(100vh - 68px)'))
      .toBeLessThan(panelCss.indexOf('max-height: calc(100dvh - 68px)'));
  });
});
