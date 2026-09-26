import { describe, expect, it } from 'vitest';
import { resolveViewportSize, viewportDrifted, type ViewportDriftInput } from './viewportSize';
import html from '../../index.html?raw';

// The observer, the canvas's box and the renderer need a browser: a fake DOM
// would only pin the fake, so the live behaviour is proved by driving the app
// (tools/fullscreen-probe.mjs, the `box` and `safearea` scenarios). Pinned
// here are the two pure decisions — which size the renderer takes, and when
// the drift poll re-syncs — and, as text, the page's side of the contract:
// the page covers the whole screen, the canvas is the fixed-position rect,
// and every piece of chrome anchored to an edge of the viewport keeps out of
// the safe area with env() rather than a bare px offset.

describe('resolveViewportSize', () => {
  it('takes the canvas box wherever it has one', () => {
    expect(resolveViewportSize({ width: 834, height: 1210 }, { width: 834, height: 1146 }))
      .toEqual({ width: 834, height: 1210 });
  });

  it('falls back to the window while the box reads zero on either side', () => {
    const fallback = { width: 390, height: 844 };
    expect(resolveViewportSize({ width: 0, height: 0 }, fallback)).toEqual(fallback);
    expect(resolveViewportSize({ width: 390, height: 0 }, fallback)).toEqual(fallback);
    expect(resolveViewportSize({ width: 0, height: 844 }, fallback)).toEqual(fallback);
  });

  it('hands back copies, never the inputs', () => {
    const box = { width: 10, height: 20 };
    const out = resolveViewportSize(box, { width: 1, height: 1 });
    expect(out).not.toBe(box);
  });
});

describe('viewportDrifted', () => {
  const settled = (): ViewportDriftInput => ({
    window: { width: 1400, height: 900 },
    windowAtSync: { width: 1400, height: 900 },
    box: { width: 1400, height: 900 },
    applied: { width: 1400, height: 900 },
    cameraAspect: 1400 / 900,
    rendererPixelRatio: 2,
    targetPixelRatio: 2,
  });

  it('is quiet while nothing moved', () => {
    expect(viewportDrifted(settled())).toBe(false);
  });

  it('re-syncs when the window changed since the last sync', () => {
    expect(viewportDrifted({ ...settled(), window: { width: 1400, height: 820 } })).toBe(true);
    expect(viewportDrifted({ ...settled(), window: { width: 1200, height: 900 } })).toBe(true);
  });

  it('re-syncs when the observer reported a box the sync has not applied', () => {
    expect(viewportDrifted({ ...settled(), box: { width: 1400, height: 1210 } })).toBe(true);
  });

  it('ignores a box that has not been laid out', () => {
    expect(viewportDrifted({ ...settled(), box: { width: 0, height: 0 } })).toBe(false);
  });

  it('compares the window with its own last reading, not with the box', () => {
    // A browser whose window and box legitimately differ must not re-sync on
    // every check: the box is what the interface is laid out on.
    expect(viewportDrifted({
      ...settled(),
      window: { width: 834, height: 1146 },
      windowAtSync: { width: 834, height: 1146 },
      box: { width: 834, height: 1210 },
      applied: { width: 834, height: 1210 },
      cameraAspect: 834 / 1210,
    })).toBe(false);
  });

  it('re-syncs on a clobbered camera aspect and on a pixel ratio the policy no longer asks for', () => {
    expect(viewportDrifted({ ...settled(), cameraAspect: 1 })).toBe(true);
    expect(viewportDrifted({ ...settled(), rendererPixelRatio: 1 })).toBe(true);
  });
});

describe('the page covers the screen (index.html)', () => {
  it('asks for viewport-fit=cover, so the canvas can run under the bars', () => {
    const meta = html.match(/<meta name="viewport" content="([^"]*)"/);
    expect(meta).not.toBeNull();
    expect(meta![1].split(',').map((part) => part.trim())).toContain('viewport-fit=cover');
  });

  it('makes the canvas the fixed-position rect, at the floor of the positioned stack', () => {
    const rule = html.match(/canvas\.scene-canvas\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1];
    for (const declaration of ['position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%', 'z-index: 0']) {
      expect(body, declaration).toContain(declaration);
    }
  });

  /** Every rule of the selector: the base one and each media override. */
  const rulesOf = (selector: string): string[] => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...html.matchAll(new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  };

  // Chrome anchored to an edge of the viewport, and the edges it anchors to.
  // A bare px offset on one of those edges would put it under the status bar,
  // the home indicator or a notch on a page that covers the screen; the
  // offset has to carry env(safe-area-inset-<edge>). Chrome placed by a
  // script (the corner chart) reads the same insets through shared/dom.
  const anchored: Record<string, string[]> = {
    '#top-bar': ['top', 'left', 'right'],
    '#planetarium-actions': ['top', 'right'],
    '#planetarium-bottom-bar': ['bottom'],
    '#planetarium-btn-land': ['bottom'],
    '#planetarium-menu-panel': ['top', 'right'],
    '#planetarium-notification': ['top'],
    '#planetarium-keys-hint': ['bottom'],
    '#stats-popover': ['right', 'bottom'],
    '#observatory-panel': ['top', 'right'],
    '#historic-panel': ['top', 'left', 'right', 'bottom'],
    '#historic-reopen': ['top', 'left', 'right', 'bottom'],
    '#tutorial-card': ['top', 'left', 'right'],
    '.shud-tr': ['top', 'left', 'right'],
    '.shud-bl': ['left', 'bottom'],
    '.shud-br': ['right', 'bottom'],
    '.shud-timebar': ['bottom'],
    '.interior-top': ['top', 'left', 'right'],
    '#interior-panel': ['top', 'right', 'left', 'bottom'],
    '#compare-leave': ['top', 'left'],
    '#compare-panel': ['top', 'right'],
    '#compare-loading': ['top'],
    '.tools-card': ['top', 'right'],
    '.map-close': ['top', 'left'],
    '.smx': ['right', 'bottom', 'left'],
    '#system-map-ui .map-zoom-hint': ['bottom'],
    '#system-map-ui .map-hover-meta': ['top'],
    '.map-card': ['left', 'right', 'bottom'],
    '#deck': ['left', 'right', 'bottom'],
  };

  for (const [selector, edges] of Object.entries(anchored)) {
    it(`${selector} keeps out of the safe area on its ${edges.join('/')}`, () => {
      const rules = rulesOf(selector);
      expect(rules.length, 'rule found').toBeGreaterThan(0);
      let anchoredSomewhere = false;
      for (const rule of rules) {
        for (const edge of edges) {
          const declaration = rule.match(new RegExp(`(?:^|[\\s;])${edge}\\s*:\\s*([^;]+);`));
          if (!declaration) continue;
          const value = declaration[1].trim();
          // `top: 0` on the wordmark bar is its padding's job; `auto` and a
          // percentage are not an offset from the edge.
          if (value === 'auto' || value === '0' || value.endsWith('%')) continue;
          anchoredSomewhere = true;
          expect(value, `${selector} ${edge}: ${value}`).toContain(`env(safe-area-inset-${edge}`);
        }
      }
      // The wordmark bar anchors with padding rather than an offset.
      if (selector === '#top-bar') {
        expect(rules.some((rule) => /padding:[^;]*env\(safe-area-inset-top/.test(rule))).toBe(true);
        return;
      }
      expect(anchoredSomewhere, `${selector} anchors to ${edges.join('/')}`).toBe(true);
    });
  }

  it('leaves the full-bleed layers on the whole viewport', () => {
    // The overlay every projected label and reticle is anchored to, and the
    // map's own container: insetting these would move a projected point off
    // the body it names.
    for (const selector of ['#ui-overlay', '#system-map-ui', '#surface-hud', '#sun-glare-flood']) {
      const rules = rulesOf(selector);
      expect(rules.length, selector).toBeGreaterThan(0);
      expect(rules.some((rule) => /inset:\s*0;|top:\s*0;\s*left:\s*0;\s*right:\s*0;\s*bottom:\s*0;/.test(rule)), selector).toBe(true);
      expect(rules.join('\n'), selector).not.toContain('safe-area-inset');
    }
  });
});
