import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import {
  GLASS_MAX_RECTS, GLASS_VOLATILE_DRAWS, GlassRegistry, blocksBackdrop, boxToBuffer, clampCornerRadii, glassCoverage,
  parseColourAlpha, parseRadius, type GlassElement, type GlassStyle,
} from './glassRects';

// ---------------------------------------------------------------------------
// The CSS seam: every frosted rule on the two custom properties, every element
// it paints marked.

/** The page's stylesheet text and its markup. */
const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
const bodyText = html.slice(html.indexOf('<body'));

/** Every CSS rule (selector, declarations) at any nesting depth. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (text: string): void => {
    let depth = 0;
    let start = 0;
    let open = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (depth === 0) open = i;
        depth++;
      } else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          const selector = text.slice(start, open).trim();
          const body = text.slice(open + 1, i);
          if (selector.startsWith('@media') || selector.startsWith('@supports')) walk(body);
          else out.push({ selector, body });
          start = i + 1;
        }
      }
    }
  };
  walk(clean);
  return out;
}

/** Rules that blur with a literal on purpose: glass inside a glass card,
 *  whose blur goes when the card's does (index.html's engine rule). */
const LITERAL_GLASS = new Set(['.pk-planet']);

/** The two spellings a glass rule may use. */
const GLASS_VALUES = new Set(['blur(var(--glass-blur))', 'blur(var(--glass-blur)) saturate(var(--glass-sat))']);

const glassRules = rules(styleText).filter((r) => /(^|[;\s])(-webkit-)?backdrop-filter\s*:/.test(r.body));

/** The element a selector paints: the last compound's class or id. */
function keyOf(selector: string): { kind: 'class' | 'id'; name: string } {
  const last = selector.trim().split(/\s+/).pop()!;
  const id = last.match(/#([\w-]+)/);
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (classes.length) return { kind: 'class', name: classes[classes.length - 1] };
  if (id) return { kind: 'id', name: id[1] };
  throw new Error(`no class or id in ${selector}`);
}

/** Every opening tag in the body, with its class tokens, id and marker. */
const tags = [...bodyText.matchAll(/<([a-zA-Z][\w-]*)(\s[^<>]*?)?>/g)].map((m) => {
  const attrs = m[2] ?? '';
  return {
    text: m[0],
    classes: (attrs.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean),
    id: attrs.match(/\bid="([^"]*)"/)?.[1] ?? '',
    marked: /\sdata-glass(\s|=|>|$)/.test(` ${attrs} `) || /\sdata-glass[\s>]/.test(m[0]),
  };
});

describe('the glass seam in index.html', () => {
  it('finds the glass rules at all', () => {
    expect(glassRules.length).toBeGreaterThan(12);
  });

  it('spells every backdrop-filter from the custom properties its own rule sets', () => {
    for (const rule of glassRules) {
      const selectors = rule.selector.split(',').map((s) => s.trim());
      if (selectors.every((s) => s.startsWith('body.glass-engine'))) {
        // The engine's own rule: it switches the browser's blur off.
        expect(rule.body).toMatch(/backdrop-filter:\s*none !important/);
        continue;
      }
      if (selectors.some((s) => LITERAL_GLASS.has(s))) continue;
      const values = [...rule.body.matchAll(/(?:^|[;\s])(?:-webkit-)?backdrop-filter\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
      for (const v of values) {
        expect(GLASS_VALUES.has(v), `${rule.selector}: ${v}`).toBe(true);
        expect(rule.body, rule.selector).toMatch(/--glass-blur:\s*\d+px/);
        if (v.includes('saturate')) expect(rule.body, rule.selector).toMatch(/--glass-sat:\s*\d+%/);
        else expect(rule.body, rule.selector).not.toMatch(/--glass-sat/);
      }
    }
  });

  it('registers the two properties without inheritance', () => {
    expect(styleText).toMatch(/@property --glass-blur \{[^}]*inherits: false[^}]*initial-value: 0px/);
    expect(styleText).toMatch(/@property --glass-sat \{[^}]*inherits: false[^}]*initial-value: 100%/);
  });

  it('switches the browser blur off under the engine, glass inside glass included, past id selectors', () => {
    const engine = rules(styleText).find((r) => r.selector.includes('body.glass-engine [data-glass] *'));
    expect(engine).toBeDefined();
    expect(engine!.selector).toContain('body.glass-engine [data-glass],');
    expect(engine!.body).toMatch(/-webkit-backdrop-filter:\s*none !important/);
    expect(engine!.body).toMatch(/(^|\s)backdrop-filter:\s*none !important/);
  });

  it('marks every element a glass rule paints, and nothing else', () => {
    const keys = glassRules
      .flatMap((r) => r.selector.split(',').map((s) => s.trim()))
      .filter((s) => !s.startsWith('body.glass-engine') && !LITERAL_GLASS.has(s))
      .map(keyOf);
    const painted = (t: (typeof tags)[number]): boolean =>
      keys.some((k) => (k.kind === 'class' ? t.classes.includes(k.name) : t.id === k.name));
    let count = 0;
    for (const t of tags) {
      if (painted(t)) {
        count++;
        expect(t.marked, t.text).toBe(true);
      } else {
        expect(t.marked, t.text).toBe(false);
      }
    }
    expect(count).toBeGreaterThan(40);
  });
});

describe('glass blurs outside index.html', () => {
  // The dormant flight mode builds its HUD with inline styles; it keeps the
  // browser's blur, deliberately. Any other blur in code would be one the
  // registry never hears of.
  const sources = import.meta.glob(['../**/*.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const CSS_ONLY = new Set(['../moonFlight/FlightInput.ts', '../moonFlight/FlightHUD.ts', '../moonFlight/MoonFlightMode.ts']);

  it('are only the flight HUD\'s', () => {
    const found = Object.entries(sources)
      .filter(([, text]) => /backdrop-filter\s*:/.test(text) || /backdropFilter\s*=/.test(text))
      .map(([path]) => path)
      .filter((path) => !CSS_ONLY.has(path));
    expect(found).toEqual([]);
    for (const path of CSS_ONLY) expect(sources[path], path).toMatch(/backdrop-filter:blur\(\d+px\)/);
  });
});

// ---------------------------------------------------------------------------
// The arithmetic.

describe('glassCoverage', () => {
  it('is 1 at rest, whatever the tint', () => {
    expect(glassCoverage(1, 0.58)).toBe(1);
    expect(glassCoverage(1, 0)).toBe(1);
  });

  it('makes draw-then-tint equal the browser\'s group opacity', () => {
    for (const o of [0.1, 0.35, 0.5, 0.8, 0.97]) {
      for (const a of [0, 0.045, 0.58, 0.82]) {
        const c = glassCoverage(o, a);
        // Tint T, blurred B, canvas C: any three values.
        const [T, B, C] = [0.9, 0.3, 0.6];
        const browser = o * (a * T + (1 - a) * B) + (1 - o) * C;
        const engine = o * a * T + (1 - o * a) * (C + (B - C) * c);
        expect(engine).toBeCloseTo(browser, 12);
      }
    }
  });

  it('is the opacity itself under a clear tint', () => {
    expect(glassCoverage(0.4, 0)).toBeCloseTo(0.4, 12);
  });
});

describe('clampCornerRadii', () => {
  it('turns a 999px pill into a half-height radius', () => {
    const r = clampCornerRadii([999, 999, 999, 999], 139, 38);
    for (const v of r) expect(v).toBeCloseTo(19, 9);
  });

  it('leaves radii that fit alone', () => {
    expect(clampCornerRadii([12, 12, 12, 12], 300, 100)).toEqual([12, 12, 12, 12]);
  });

  it('scales every corner by the tightest side', () => {
    // Top corners only (a sheet): the width binds, 200 / (150 + 150).
    const r = clampCornerRadii([150, 150, 0, 0], 200, 400);
    expect(r[0]).toBeCloseTo(100, 9);
    expect(r[1]).toBeCloseTo(100, 9);
    expect(r[2]).toBe(0);
  });
});

describe('parsing computed values', () => {
  it('reads a radius in px, a pill, a percentage and an ellipse', () => {
    expect(parseRadius('12px', 100)).toBe(12);
    expect(parseRadius('999px', 38)).toBe(999);
    expect(parseRadius('50%', 38)).toBe(19);
    expect(parseRadius('12px 8px', 100)).toBe(12);
    expect(parseRadius('0px', 100)).toBe(0);
  });

  it('reads a colour\'s alpha in both syntaxes', () => {
    expect(parseColourAlpha('rgba(8, 10, 15, 0.58)')).toBeCloseTo(0.58, 9);
    expect(parseColourAlpha('rgb(8 10 15 / 0.5)')).toBeCloseTo(0.5, 9);
    expect(parseColourAlpha('rgb(8 10 15 / 50%)')).toBeCloseTo(0.5, 9);
    expect(parseColourAlpha('rgb(8, 10, 15)')).toBe(1);
    expect(parseColourAlpha('transparent')).toBe(0);
    expect(parseColourAlpha('rgba(0, 0, 0, 0)')).toBe(0);
  });
});

describe('boxToBuffer', () => {
  it('maps a phone at device ratio 3 onto a canvas drawn at 2 (the canvas ratio, never devicePixelRatio)', () => {
    // 390 × 844 CSS, the drawing buffer at the capped 2: 780 × 1688.
    const canvas = { rect: { left: 0, top: 0, width: 390, height: 844 }, bufferWidth: 780, bufferHeight: 1688 };
    const m = boxToBuffer({ left: 10, top: 800, right: 110, bottom: 838 }, canvas)!;
    expect(m.sx).toBe(2);
    expect(m.sy).toBe(2);
    expect([m.x0, m.x1]).toEqual([20, 220]);
    // GL's origin is the bottom: 844 − 838 = 6 CSS px up.
    expect([m.y0, m.y1]).toEqual([12, 88]);
  });

  it('scales each axis by its own buffer-to-box ratio and positions against the canvas, not the window', () => {
    const canvas = { rect: { left: 100, top: 50, width: 1000, height: 500 }, bufferWidth: 2500, bufferHeight: 1250 };
    const m = boxToBuffer({ left: 100, top: 50, right: 200, bottom: 100 }, canvas)!;
    expect(m.sx).toBe(2.5);
    expect([m.x0, m.x1, m.y0, m.y1]).toEqual([0, 250, 1125, 1250]);
  });

  it('clips to the buffer and refuses a box off the canvas', () => {
    const canvas = { rect: { left: 0, top: 0, width: 100, height: 100 }, bufferWidth: 200, bufferHeight: 200 };
    expect(boxToBuffer({ left: -10, top: -10, right: 10, bottom: 10 }, canvas)).toMatchObject({ x0: 0, x1: 20, y0: 180, y1: 200 });
    expect(boxToBuffer({ left: 120, top: 0, right: 140, bottom: 10 }, canvas)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The browser's rules, through fakes of the DOM surface the scan reads.

interface FakeOpts {
  blur?: number;
  sat?: number;
  opacity?: number;
  display?: string;
  visibility?: string;
  filter?: string;
  backdrop?: string;
  marked?: boolean;
  bg?: string;
  radius?: string;
  box?: { left: number; top: number; width: number; height: number };
  layoutWidth?: number;
}

class FakeEl implements GlassElement {
  boxReads = 0;
  constructor(public parentElement: FakeEl | null, public opts: FakeOpts) {}
  hasAttribute(name: string): boolean {
    return name === 'data-glass' && this.opts.marked === true;
  }
  getBoundingClientRect() {
    this.boxReads++;
    const b = this.opts.box ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...b, right: b.left + b.width, bottom: b.top + b.height };
  }
  checkVisibility(): boolean {
    for (let e: FakeEl | null = this; e; e = e.parentElement) if (e.opts.display === 'none') return false;
    return this.opts.visibility !== 'hidden';
  }
  get offsetWidth(): number {
    return this.opts.layoutWidth ?? this.opts.box?.width ?? 0;
  }
}

/** A live computed style, as the browser's is: every read sees the
 *  element's current state. */
function styleOf(el: GlassElement): GlassStyle {
  const o = () => (el as FakeEl).opts;
  const r = () => o().radius ?? '0px';
  return {
    get opacity() { return String(o().opacity ?? 1); },
    get filter() { return o().filter ?? 'none'; },
    get backdropFilter() { return o().backdrop ?? 'none'; },
    get display() { return o().display ?? 'block'; },
    get visibility() { return o().visibility ?? 'visible'; },
    get backgroundColor() { return o().bg ?? 'rgba(8, 10, 15, 0.58)'; },
    get borderTopLeftRadius() { return r(); },
    get borderTopRightRadius() { return r(); },
    get borderBottomRightRadius() { return r(); },
    get borderBottomLeftRadius() { return r(); },
    getPropertyValue: (name: string) =>
      name === '--glass-blur' ? `${o().blur ?? 0}px` : name === '--glass-sat' ? `${o().sat ?? 100}%` : '',
  };
}

function page(): { root: FakeEl; body: FakeEl } {
  const root = new FakeEl(null, {});
  const body = new FakeEl(root, {});
  return { root, body };
}

const desktop = () => ({ rect: { left: 0, top: 0, width: 1000, height: 600 }, bufferWidth: 2000, bufferHeight: 1200 });

function registry(els: FakeEl[], canvas = desktop) {
  return new GlassRegistry(() => els, styleOf, canvas, () => 0);
}

describe('GlassRegistry', () => {
  const box = { left: 100, top: 100, width: 100, height: 40 };

  it('draws a visible glass panel with its own values, in buffer pixels', () => {
    const { body } = page();
    const panel = new FakeEl(body, { marked: true, blur: 30, sat: 160, box, radius: '999px' });
    const reg = registry([panel]);
    expect(reg.scan()).toBe(true);
    const [r] = reg.rects();
    expect(r).toMatchObject({ x0: 200, x1: 400, y0: 1200 - 280, y1: 1200 - 200, sigma: 60, saturation: 1.6, coverage: 1 });
    for (const v of r.radii) expect(v).toBeCloseTo(40, 9);
  });

  it('leaves out an element hidden anywhere up the tree, at opacity 0, or whose rule is not in force', () => {
    const { body } = page();
    const hiddenParent = new FakeEl(body, { display: 'none' });
    const els = [
      new FakeEl(hiddenParent, { marked: true, blur: 12, box }),
      new FakeEl(body, { marked: true, blur: 12, box, visibility: 'hidden' }),
      new FakeEl(body, { marked: true, blur: 12, box, opacity: 0 }),
      new FakeEl(body, { marked: true, blur: 0, box }),
    ];
    const reg = registry(els);
    reg.scan();
    expect(reg.rects()).toEqual([]);
  });

  it('leaves glass unblurred under an ancestor with opacity below 1, a filter, or a backdrop-filter', () => {
    const { body } = page();
    const fading = new FakeEl(body, { opacity: 0.6 });
    const filtered = new FakeEl(body, { filter: 'blur(1px)' });
    const cssGlass = new FakeEl(body, { backdrop: 'blur(8px)' });
    const reg = registry([
      new FakeEl(fading, { marked: true, blur: 8, box }),
      new FakeEl(filtered, { marked: true, blur: 8, box }),
      new FakeEl(cssGlass, { marked: true, blur: 8, box }),
    ]);
    reg.scan();
    expect(reg.rects()).toEqual([]);
  });

  it('leaves glass inside glass unblurred while the outer rule is in force, under the engine too', () => {
    const { body } = page();
    // Under the engine the outer panel's backdrop-filter reads none: its own
    // --glass-blur is what says it is glass.
    const bar = new FakeEl(body, { marked: true, blur: 30, sat: 160, box: { left: 0, top: 500, width: 400, height: 40 } });
    const tip = new FakeEl(bar, { marked: true, blur: 30, sat: 160, box: { left: 0, top: 460, width: 60, height: 20 } });
    const reg = registry([bar, tip]);
    reg.scan();
    expect(reg.rects()).toHaveLength(1);
    expect(reg.rects()[0].x1).toBe(800);
  });

  it('fades the blur as the browser fades the group, by its own opacity and tint', () => {
    const { body } = page();
    const reg = registry([new FakeEl(body, { marked: true, blur: 12, box, opacity: 0.5, bg: 'rgba(0, 0, 0, 0.5)' })]);
    reg.scan();
    expect(reg.rects()[0].coverage).toBeCloseTo(glassCoverage(0.5, 0.5), 12);
  });

  it('leaves out a panel off the canvas', () => {
    const { body } = page();
    const reg = registry([new FakeEl(body, { marked: true, blur: 12, box: { left: 1200, top: 0, width: 50, height: 50 } })]);
    reg.scan();
    expect(reg.rects()).toEqual([]);
  });

  it('blurs in the panel\'s own coordinates when a transform scales it', () => {
    const { body } = page();
    // Laid out 200 wide, drawn at half that.
    const reg = registry([new FakeEl(body, { marked: true, blur: 20, box, layoutWidth: 200, radius: '10px' })]);
    reg.scan();
    const r = reg.rects()[0];
    expect(r.sigma).toBeCloseTo(20 * 2 * 0.5, 9);
    expect(r.radii[0]).toBeCloseTo(10 * 2 * 0.5, 9);
  });

  it('says a change once, until the frame draws it', () => {
    const { body } = page();
    const panel = new FakeEl(body, { marked: true, blur: 12, box });
    const reg = registry([panel]);
    expect(reg.scan()).toBe(true);
    reg.markDrawn();
    expect(reg.scan()).toBe(false);
    panel.opts.box = { ...box, left: 101 };
    expect(reg.scan()).toBe(true);
    reg.markDrawn();
    panel.opts.display = 'none';
    expect(reg.scan()).toBe(true);
    reg.markDrawn();
    expect(reg.scan()).toBe(false);
    reg.forgetDrawn();
    expect(reg.scan()).toBe(true);
  });

  it('rechecks without reading layout, except for an element that has just appeared', () => {
    const { body } = page();
    const shown = new FakeEl(body, { marked: true, blur: 12, box });
    const later = new FakeEl(body, { marked: true, blur: 12, box: { ...box, top: 300 }, display: 'none' });
    const reg = registry([shown, later]);
    reg.scan();
    reg.markDrawn();
    const reads = shown.boxReads;
    // The mode shows a control during its update.
    later.opts.display = 'block';
    expect(reg.recheck()).toBe(true);
    expect(shown.boxReads).toBe(reads);
    expect(later.boxReads).toBe(1);
    expect(reg.rects()).toHaveLength(2);
    // And fades one: the opacity is re-read, the box is not.
    shown.opts.opacity = 0.5;
    expect(reg.recheck()).toBe(true);
    expect(shown.boxReads).toBe(reads);
    expect(reg.rects()[0].coverage).toBeLessThan(1);
  });

  it('reads the box of a panel the mode moves every frame fresh before each draw, and settles once it stops', () => {
    const { body } = page();
    const pill = new FakeEl(body, { marked: true, blur: 8, box });
    const reg = registry([pill]);
    const drawTick = (moveTo?: number): void => {
      reg.scan();
      if (moveTo !== undefined) pill.opts.box = { ...box, left: moveTo };
      reg.recheck();
      reg.markDrawn();
    };
    drawTick();
    // The mode moves it inside a drawing tick's update: the first move is
    // caught at the next tick's top, the frame after that is read fresh.
    drawTick(110);
    expect(reg.scan()).toBe(true);
    drawTick(120);
    expect(reg.rects()[0].x0).toBe(240);
    // While it keeps moving, the draw has it where the mode put it, and the
    // next tick sees nothing new: the frame-rate setting is kept.
    drawTick(130);
    expect(reg.rects()[0].x0).toBe(260);
    expect(reg.scan()).toBe(false);
    // Once still for GLASS_VOLATILE_DRAWS frames, it is reused again.
    for (let i = 0; i < GLASS_VOLATILE_DRAWS + 1; i++) drawTick();
    const reads = pill.boxReads;
    drawTick();
    expect(pill.boxReads).toBe(reads + 1);
  });

  it('draws at most GLASS_MAX_RECTS', () => {
    const { body } = page();
    const els = Array.from({ length: GLASS_MAX_RECTS + 3 }, (_, i) => new FakeEl(body, { marked: true, blur: 8, box: { left: i * 10, top: 0, width: 8, height: 8 } }));
    const reg = registry(els);
    reg.scan();
    expect(reg.rects()).toHaveLength(GLASS_MAX_RECTS);
  });
});

/** A plain copy of a style, for spreading with overrides. */
function snapshot(style: GlassStyle): GlassStyle {
  return {
    opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter, display: style.display,
    visibility: style.visibility, backgroundColor: style.backgroundColor,
    borderTopLeftRadius: style.borderTopLeftRadius, borderTopRightRadius: style.borderTopRightRadius,
    borderBottomRightRadius: style.borderBottomRightRadius, borderBottomLeftRadius: style.borderBottomLeftRadius,
    getPropertyValue: style.getPropertyValue,
  };
}

describe('blocksBackdrop', () => {
  const base = snapshot(styleOf(new FakeEl(null, {})));
  it('is false for a plain ancestor and true for each backdrop root', () => {
    expect(blocksBackdrop(base, false)).toBe(false);
    expect(blocksBackdrop({ ...base, opacity: '0.99' }, false)).toBe(true);
    expect(blocksBackdrop({ ...base, filter: 'brightness(1.1)' }, false)).toBe(true);
    expect(blocksBackdrop({ ...base, webkitBackdropFilter: 'blur(4px)', backdropFilter: undefined }, false)).toBe(true);
    expect(blocksBackdrop({ ...base, clipPath: 'inset(1px)' }, false)).toBe(true);
    expect(blocksBackdrop({ ...base, maskImage: 'linear-gradient(red, blue)' }, false)).toBe(true);
    expect(blocksBackdrop({ ...base, mixBlendMode: 'screen' }, false)).toBe(true);
  });
  it('counts a marked ancestor as glass only while its own rule is in force', () => {
    const glass = styleOf(new FakeEl(null, { blur: 30 }));
    expect(blocksBackdrop(glass, true)).toBe(true);
    expect(blocksBackdrop(base, true)).toBe(false);
  });
});
