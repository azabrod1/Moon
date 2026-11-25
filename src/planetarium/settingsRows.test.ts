import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import mode from './PlanetariumMode.ts?raw';
import panel from './ui/PlanetariumMenuPanel.ts?raw';
import segmented from './ui/SegmentedControl.ts?raw';
import { QUALITY_LEVELS } from '../app/renderQuality';
import { FRAME_RATES } from '../app/frameRateSetting';
import { NIGHT_SIDES, nightSidesSummary, DEFAULT_NIGHT_SIDES } from '../app/nightSidesSetting';
import { DEFAULT_SHIP, SHIP_IDS, SHIP_LABELS } from './ship/shipCatalog';

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
// Each sub-page runs to the start of the next one, so an id is counted on the
// page that really holds it.
const graphicsPage = panelMarkup.slice(
  panelMarkup.indexOf('data-page="graphics"'),
  panelMarkup.indexOf('data-page="display"'),
);
const displayPage = panelMarkup.slice(
  panelMarkup.indexOf('data-page="display"'),
  panelMarkup.indexOf('data-page="ship"'),
);
const shipPage = panelMarkup.slice(
  panelMarkup.indexOf('data-page="ship"'),
  panelMarkup.indexOf('data-page="credits"'),
);
const creditsPage = panelMarkup.slice(panelMarkup.indexOf('data-page="credits"'));
/** Every id the TypeScript asks a page for, by getElementById or setText. */
const pageRead = idsIn(ts, /(?:getElementById|setText)\('(settings-[a-z0-9-]+|menu-page-[a-z0-9-]+)'/g);

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

  it('holds every control in the panel as a radiogroup of checkable radios', () => {
    // Quality and Frame rate here, Night sides on the Display page, the
    // ships on the Ship page.
    const groups = [...panelMarkup.matchAll(/role="radiogroup"[\s\S]*?<\/div>/g)].map((m) => m[0]);
    expect(groups).toHaveLength(4);
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

describe('the Display page', () => {
  const pageIds = [...idsIn(displayPage, /id="([a-z0-9-]+)"/g)]
    .filter((id) => id !== 'menu-page-display');
  // The segments are read by their data-value, like the Graphics page's, so
  // their ids are pinned against the setting's own list instead.
  const segmentIds = new Set(NIGHT_SIDES.map((mode) => `settings-night-sides-${mode}`));

  it('lives inside the panel, behind a tier row that names it', () => {
    expect(panelMarkup).toContain('class="menu-page" data-page="display" id="menu-page-display" hidden');
    expect(rootPage).toContain('data-open="display"');
    expect(displayPage).toContain('class="menu-back"');
    expect(displayPage).toContain('<h3>Display</h3>');
    // Inside the panel's own element: the panel finds its pages by querying
    // itself, so a page outside it is never shown.
    const panelEnd = html.indexOf('<!-- Observatory panel:');
    expect(html.indexOf('data-page="display"')).toBeLessThan(panelEnd);
    expect(html.indexOf('data-page="display"')).toBeGreaterThan(html.indexOf('<div id="planetarium-menu-panel"'));
  });

  it('declares every id the TypeScript writes into it', () => {
    for (const id of ['settings-night-sides-seg', 'settings-night-sides-note']) {
      expect(pageRead.has(id), id).toBe(true);
      expect(displayPage, id).toContain(`id="${id}"`);
    }
  });

  it('carries nothing the TypeScript never reads', () => {
    expect(pageIds.filter((id) => !pageRead.has(id) && !segmentIds.has(id))).toEqual([]);
  });

  it('gives True to life and Lit up a segment each, both always offered', () => {
    for (const id of segmentIds) expect(displayPage, id).toContain(`id="${id}"`);
    for (const mode of NIGHT_SIDES) expect(displayPage).toContain(`data-value="${mode}"`);
    // The markup's own checked segment is the default, so the page reads right
    // even before the mode's first sync.
    expect(displayPage).toContain(`aria-checked="true" data-value="${DEFAULT_NIGHT_SIDES}"`);
    expect(displayPage).not.toMatch(/menu-seg-btn[^>]*\shidden/);
  });

  it('describes the group by the note under it', () => {
    expect(displayPage).toContain('aria-describedby="settings-night-sides-note"');
    expect(displayPage).toContain('role="radiogroup" aria-label="Dark side lighting"');
  });

  it('carries its value on the root row, the default in the markup', () => {
    const row = rootPage.slice(rootPage.indexOf('data-open="display"'));
    const value = row.match(/<span class="menu-tier-value">([^<]*)<\/span>/)?.[1];
    expect(value).toBe(nightSidesSummary(DEFAULT_NIGHT_SIDES));
    expect(mode).toContain("setTierValue('display', nightSidesSummary(mode))");
  });
});

describe('the Ship page', () => {
  /** Each card: the value it stands for, whether the markup checks it, and its text. */
  const cards = [...shipPage.matchAll(
    /<button type="button" class="ship-card" role="radio" aria-checked="(true|false)" data-value="([a-z]+)">([\s\S]*?)<\/button>/g,
  )].map((match) => ({
    checked: match[1] === 'true',
    value: match[2],
    label: match[3].match(/<span>([^<]*)<\/span>/)?.[1],
    markup: match[3],
  }));

  it('lives inside the panel, behind a tier row straight above Show ship', () => {
    expect(panelMarkup).toContain('class="menu-page" data-page="ship" hidden');
    expect(shipPage).toContain('class="menu-back"');
    expect(shipPage).toContain('<h3>Ship</h3>');
    const row = rootPage.indexOf('data-open="ship"');
    const showShip = rootPage.indexOf('id="settings-ship-toggle"');
    expect(row).toBeGreaterThan(rootPage.indexOf('data-open="display"'));
    expect(showShip).toBeGreaterThan(row);
    // Nothing between the two but the end of the tier row and the start of Show ship's own.
    const between = rootPage.slice(row, showShip);
    expect(between).not.toMatch(/menu-divider|menu-action/);
    expect([...between.matchAll(/class="settings-row"/g)]).toHaveLength(1);
  });

  it('gives every ship in the catalog a card, in the catalog\'s order and with its label', () => {
    expect(cards.map((card) => card.value)).toEqual([...SHIP_IDS]);
    for (const card of cards) expect(card.label, card.value).toBe(SHIP_LABELS[card.value as keyof typeof SHIP_LABELS]);
  });

  it('checks the default ship in the markup, and names it on the root row', () => {
    expect(cards.filter((card) => card.checked).map((card) => card.value)).toEqual([DEFAULT_SHIP]);
    const row = rootPage.slice(rootPage.indexOf('data-open="ship"'));
    expect(row.match(/<span class="menu-tier-value">([^<]*)<\/span>/)?.[1]).toBe(SHIP_LABELS[DEFAULT_SHIP]);
  });

  it('draws each card as an outline over its name, with no element the group\'s wiring would trip on', () => {
    for (const card of cards) {
      expect(card.markup, card.value).toMatch(/<svg class="ship-icon" viewBox="0 0 40 24" aria-hidden="true">(<path d="[^"]+"><\/path>)+<\/svg>/);
      // The radiogroup audit above reads a group up to its first </div>.
      expect(card.markup, card.value).not.toContain('<div');
    }
  });

  it('declares the two ids the TypeScript reads, and describes the group by its note', () => {
    const pageIds = [...idsIn(shipPage, /id="([a-z0-9-]+)"/g)];
    expect(pageIds.sort()).toEqual(['settings-ship-grid', 'settings-ship-note']);
    for (const id of pageIds) expect(pageRead.has(id), id).toBe(true);
    expect(shipPage).toContain('role="radiogroup" aria-label="Ship"');
    expect(shipPage).toContain('aria-describedby="settings-ship-note"');
  });
});

describe('the Credits page', () => {
  it('lives inside the panel, behind a tier row that names it', () => {
    expect(panelMarkup).toContain('class="menu-page" data-page="credits" hidden');
    expect(rootPage).toContain('data-open="credits"');
    expect(creditsPage).toContain('class="menu-back"');
    expect(creditsPage).toContain('<h3>Credits</h3>');
  });

  it('is static text, with no id for the TypeScript to miss', () => {
    expect([...idsIn(creditsPage, /id="([a-z0-9-]+)"/g)]).toEqual([]);
  });

  it('opens every link in a new tab, away from the journey', () => {
    // A link followed in place would unload the app mid-journey.
    const links = [...creditsPage.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link, link).toMatch(/href="https:\/\/[^"]+"/);
      expect(link, link).toContain('target="_blank"');
      expect(link, link).toContain('rel="noopener"');
    }
  });

  it('sits straight under System map, as the last of the actions', () => {
    const map = rootPage.indexOf('id="planetarium-btn-map"');
    const credits = rootPage.indexOf('data-open="credits"');
    expect(credits).toBeGreaterThan(map);
    expect(rootPage.indexOf('data-open="graphics"')).toBeGreaterThan(credits);
    // Nothing between the two but the comment that explains the row.
    const between = rootPage.slice(
      rootPage.indexOf('</button>', map) + '</button>'.length,
      rootPage.lastIndexOf('<button', credits),
    );
    expect(between).not.toMatch(/<button|menu-divider|settings-row/);
    expect(rootPage).toContain('class="menu-action menu-tier" data-open="credits"');
    // ...and the last of them: the divider before the tiers comes next.
    const after = rootPage.slice(credits, rootPage.indexOf('menu-divider', credits));
    expect(after).not.toMatch(/menu-action|<button/);
  });

  it('names each group with a heading under the page\'s own', () => {
    expect(creditsPage).not.toMatch(/<h[1256][\s>]/);
    expect([...creditsPage.matchAll(/<h3[\s>]/g)]).toHaveLength(1);
    expect([...creditsPage.matchAll(/<h4 class="menu-field-label">/g)].length).toBeGreaterThan(1);
  });

  it('gives every description a term, as a description list must', () => {
    // A <dl> is groups of one or more <dt> then one or more <dd>; a <dd> with
    // no <dt> before it in its list is invalid and reads oddly aloud.
    for (const list of creditsPage.matchAll(/<dl[^>]*>([\s\S]*?)<\/dl>/g)) {
      expect(list[1].trim().startsWith('<dt>'), list[1].slice(0, 80)).toBe(true);
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

  it('puts the Display tier straight after Graphics, before the toggles', () => {
    const graphics = rootPage.indexOf('data-open="graphics"');
    const display = rootPage.indexOf('data-open="display"');
    const ship = rootPage.indexOf('id="settings-ship-toggle"');
    expect(display).toBeGreaterThan(graphics);
    expect(ship).toBeGreaterThan(display);
    // Nothing between the two tier rows but the end of the first.
    expect(rootPage.slice(graphics, display)).not.toMatch(/settings-row|menu-divider|menu-action/);
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

  it('offers Full screen only once the browser has said it can work', () => {
    // The row is un-hidden by the mode where document.fullscreenEnabled is
    // true (app/fullscreen.ts). Shown from the markup, or with its hidden
    // attribute beaten by the row's own display, it would be a control that
    // does nothing on a device that cannot go full screen — which only that
    // device would ever show.
    const toggle = rootPage.indexOf('id="settings-fullscreen-toggle"');
    const rowTag = rootPage.slice(rootPage.lastIndexOf('<div class="settings-row"', toggle), toggle);
    expect(rowTag).toMatch(/^<div class="settings-row" hidden>/);
    const rule = html.match(/\.settings-row\[hidden\] \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('display: none');
    expect(mode).toContain("closest<HTMLElement>('.settings-row')?.removeAttribute('hidden')");
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
    // The settings rows put the panel's bottom at 642 px in a 320x568 window
    // (measured; 609 px where Full screen is not offered), and the page itself
    // cannot scroll (html, body are overflow: hidden), so without this the
    // last row is simply unreachable at 320x568.
    const panelCss = html.match(/#planetarium-menu-panel \{[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(panelCss).toContain('overflow-y: auto');
    expect(panelCss).toContain('overscroll-behavior: contain');
    expect(panelCss).toContain('touch-action: pan-y');
    // The dvh line with a vh fallback before it: an engine without dvh would
    // drop the whole declaration and restore the unreachable row. Both take
    // the top safe-area inset off, since the panel's top moved down by it
    // (the page covers the screen: viewport-fit=cover).
    const vhLine = 'max-height: calc(100vh - 68px - env(safe-area-inset-top, 0px))';
    const dvhLine = 'max-height: calc(100dvh - 68px - env(safe-area-inset-top, 0px))';
    expect(panelCss).toContain(vhLine);
    expect(panelCss).toContain(dvhLine);
    expect(panelCss.indexOf(vhLine)).toBeLessThan(panelCss.indexOf(dvhLine));
  });
});
