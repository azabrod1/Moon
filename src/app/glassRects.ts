/**
 * Where the interface's frosted panels sit on the canvas, read off the page
 * every animation frame for the renderer's own glass (app/glassBackdrop.ts).
 *
 * **One source of truth, in CSS.** Every rule that frosts the picture behind
 * it sets `--glass-blur` (and `--glass-sat` where it saturates too) and spells
 * its `backdrop-filter` from them, and every element such a rule paints
 * carries `data-glass` (index.html; glassRects.test.ts holds the two
 * together). The registry collects the marked elements and reads the two
 * values from each one's computed style, so a panel restyled in CSS is drawn
 * with its new blur without anything here changing, and the registry never
 * holds a value of its own that could drift from the stylesheet. The two
 * properties are registered without inheritance (`@property`), so an element
 * whose own rule is not in force reads 0 and is not glass. That holds only
 * where `@property` exists (Chromium, Safari 16.4 and later); an older engine
 * inherits them like any custom property, and a child of a glass panel reads
 * its parent's values — harmless, because a glass element under a glass
 * ancestor is never drawn (below), and every spelling of the blur carries a
 * fallback for `--glass-sat`, so a rule that does not set it never computes
 * to an invalid filter.
 *
 * **Registered from code.** The marked elements are collected once at boot,
 * and again by `refresh()`. There is no observer on the page: the frame
 * writes `textContent` all over the interface every draw, and an observer on
 * the body would fire for every one of them. Nothing the app builds in code
 * is top-level glass today — the only glass it creates is the picker lists'
 * pinned planet headers, which sit inside a glass card and are flattened with
 * it — so `refresh()` is for the next one.
 *
 * **What the browser draws, reproduced.** Chromium and WebKit leave a
 * backdrop unblurred in three cases, and the engine leaves the same ones:
 *  - the element is not rendered (`display: none` anywhere up the tree,
 *    `visibility: hidden`), or its own opacity is 0;
 *  - an ancestor has opacity below 1, a filter, a mask, a clip-path, a blend
 *    mode or a backdrop-filter of its own: that ancestor becomes the backdrop
 *    root, and what the element would blur is only what the ancestor itself
 *    painted. A glass ancestor counts while its rule is in force, whether the
 *    browser or the engine is drawing it — under the engine its
 *    backdrop-filter reads `none`, so the test is the ancestor's own
 *    `--glass-blur`. The chips of the surface view's HUD are the case that
 *    matters: they sit unblurred for the whole of the HUD's fade;
 *  - the element's box misses the canvas.
 * The backdrop is the element's border box, rounded by its own corner radii
 * (clamped as CSS clamps them where two corners would overlap — a `999px` pill
 * is a half-height radius) and blurred inside that box alone, its edges
 * mirrored: a bright band just outside a panel does not bleed into it.
 *
 * **Opacity.** The element's own opacity applies to it as a group — its tint,
 * its border and its blurred backdrop fade together over the live picture.
 * The engine draws the blur into the canvas BEFORE the browser paints the
 * element's tint over it, so the blur's share has to make up the difference:
 * with own opacity o and a tint of alpha a, the browser shows
 * `o·(a·T + (1−a)·B) + (1−o)·C` and the engine `o·a·T + (1−o·a)·mix(C, B, c)`,
 * which agree exactly when `c = o(1−a)/(1−o·a)` (glassCoverage). At rest
 * (o = 1) that is 1, whatever the tint.
 *
 * **Canvas pixels.** The canvas's drawing buffer is not the window times
 * `devicePixelRatio`: the output ratio is capped and floored
 * (app/renderResolution.ts targetPixelRatio — a phone at 3 draws at 2, a 3×
 * desktop at 2.5), so every length is scaled by the drawing buffer's size over
 * the canvas element's own box, per axis, and positions are taken relative to
 * that box (the canvas, never the window: on an iPad in full screen the two
 * differ). A blur radius in CSS px is a standard deviation in CSS px, so it is
 * scaled the same way, and by the element's own transform (a panel scaled in
 * as it opens blurs in its own coordinates).
 *
 * **When.** The full scan runs at the top of every animation frame, before
 * the mode's own DOM writes, where the layout the browser made for the last
 * frame is clean unless something wrote to the page between frames (a timer,
 * an event): then the scan's first box read lays the page out inside the
 * frame instead of after it — the same layout, moved, not added (gates.md
 * §5 counted 24 such in 3 s at Earth, with the same 24 outside the frame
 * when the browser blurs). CSS transitions have already been ticked to this
 * frame's time. If anything moved since the last drawn frame, main draws
 * this tick even where the frame-rate setting would have skipped it, so a
 * menu never opens with its tint over an unblurred picture and a closed
 * panel never leaves its blur behind. After the mode's update a second pass
 * (`recheck`) runs on every tick that has a glass route — before the draw
 * on a tick that draws, and on one that does not, so that a panel the mode
 * itself showed, hid or moved in its update makes the tick draw after all.
 * It re-reads visibility and opacity, which need style and not layout, and
 * reads a box again only where it may have moved: an element that has just
 * appeared, one that moved in the last GLASS_VOLATILE_DRAWS drawn frames, or
 * every element when the canvas itself changed size since the scan (a phone
 * turned on its side: the boxes were mapped through the old size). So a
 * control the mode shows during its update is blurred on its first frame, a
 * panel the mode positions every frame (the surface view's tracking pill,
 * the Look-inside hover card) is blurred where it is drawn and not a frame
 * behind, and a still interface reads no layout in the second pass at all.
 * One case is left a display frame behind: a panel shown by a promise that
 * settles after the frame's draw, in the same task (main's afterNextDraw);
 * the next tick's scan draws it.
 *
 * **Glass over glass.** Where two shown panels overlap, both go back to the
 * browser's blur for as long as they do (handOverOverlaps): the engine blurs
 * the canvas alone and would leave the lower panel's text crisp under the
 * upper one's tint.
 *
 * At most GLASS_MAX_RECTS are drawn; the surplus is left undrawn and DEV says
 * so once. The interface never shows more than about a dozen.
 */

/** The most rects a frame draws (the glass pass's uniform arrays). */
export const GLASS_MAX_RECTS = 16;

/** One frosted panel, in the canvas's drawing-buffer pixels with GL's origin
 *  (bottom-left). */
export interface GlassRect {
  /** The border box, clipped to the drawing buffer; fractional. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The four corner radii after the CSS overlap clamp, in buffer pixels, in
   *  GL order: bottom-left, bottom-right, top-right, top-left. */
  radii: [number, number, number, number];
  /** The blur's standard deviation, in buffer pixels. */
  sigma: number;
  /** The saturation factor applied after the blur; 1 is none. */
  saturation: number;
  /** How much of the blurred picture replaces the canvas (glassCoverage). */
  coverage: number;
}

/** The share of the blurred picture that makes the engine's draw-then-tint
 *  equal to the browser's group opacity, for own opacity `o` and a tint of
 *  alpha `a` (see the header). */
export function glassCoverage(opacity: number, tintAlpha: number): number {
  const o = Math.min(Math.max(opacity, 0), 1);
  const a = Math.min(Math.max(tintAlpha, 0), 1);
  if (o >= 1) return 1;
  const denominator = 1 - o * a;
  return denominator > 1e-6 ? (o * (1 - a)) / denominator : 1;
}

/**
 * The four corner radii of a box of `width × height` after the CSS rule for
 * corners that would overlap: every radius is scaled by the largest factor at
 * which no side's two radii sum past its length (CSS Backgrounds §5.5). Input
 * and output in CSS order: top-left, top-right, bottom-right, bottom-left.
 */
export function clampCornerRadii(
  radii: readonly [number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number] {
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, r)) as [number, number, number, number];
  let f = 1;
  const fit = (side: number, a: number, b: number): void => {
    if (a + b > side && a + b > 0) f = Math.min(f, side / (a + b));
  };
  fit(width, tl, tr);
  fit(width, bl, br);
  fit(height, tl, bl);
  fit(height, tr, br);
  return [tl * f, tr * f, br * f, bl * f];
}

/** A computed radius as CSS writes it ("12px", "999px", "50%", "12px 8px"):
 *  the horizontal radius in px, a percentage taken of the box's width. */
export function parseRadius(value: string, width: number): number {
  const first = value.trim().split(/\s+/)[0] ?? '';
  const n = parseFloat(first);
  if (!Number.isFinite(n)) return 0;
  return first.endsWith('%') ? (n / 100) * width : n;
}

/** The alpha of a computed colour ("rgba(8, 10, 15, 0.58)", "rgb(0 0 0 / 0.5)",
 *  "transparent"); 1 for an opaque colour. */
export function parseColourAlpha(value: string): number {
  if (value === 'transparent') return 0;
  const numbers = value.match(/-?[\d.]+%?/g);
  if (!numbers || numbers.length < 4) return 1;
  const last = numbers[numbers.length - 1];
  const n = parseFloat(last);
  if (!Number.isFinite(n)) return 1;
  return last.endsWith('%') ? n / 100 : n;
}

/** The canvas as the scan needs it: its element's box in CSS px and its
 *  drawing buffer. */
export interface GlassCanvas {
  rect: { left: number; top: number; width: number; height: number };
  bufferWidth: number;
  bufferHeight: number;
}

/**
 * An element's border box, in CSS px relative to the page, mapped into the
 * canvas's drawing buffer with GL's origin and clipped to it; null where it
 * misses the canvas. The scale is per axis, from the buffer over the canvas
 * element's own box.
 */
export function boxToBuffer(
  box: { left: number; top: number; right: number; bottom: number },
  canvas: GlassCanvas,
): { x0: number; y0: number; x1: number; y1: number; sx: number; sy: number } | null {
  const c = canvas.rect;
  if (!(c.width > 0 && c.height > 0)) return null;
  const sx = canvas.bufferWidth / c.width;
  const sy = canvas.bufferHeight / c.height;
  const x0 = Math.max(0, (box.left - c.left) * sx);
  const x1 = Math.min(canvas.bufferWidth, (box.right - c.left) * sx);
  const y0 = Math.max(0, (c.top + c.height - box.bottom) * sy);
  const y1 = Math.min(canvas.bufferHeight, (c.top + c.height - box.top) * sy);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0, y0, x1, y1, sx, sy };
}

/** The parts of a computed style the scan reads; a CSSStyleDeclaration is one. */
export interface GlassStyle {
  opacity: string;
  filter: string;
  backdropFilter?: string;
  webkitBackdropFilter?: string;
  clipPath?: string;
  maskImage?: string;
  webkitMaskImage?: string;
  mixBlendMode?: string;
  display: string;
  visibility: string;
  backgroundColor: string;
  borderTopLeftRadius: string;
  borderTopRightRadius: string;
  borderBottomRightRadius: string;
  borderBottomLeftRadius: string;
  getPropertyValue(name: string): string;
}

/** The parts of an element the scan touches. */
export interface GlassElement {
  readonly parentElement: GlassElement | null;
  hasAttribute(name: string): boolean;
  toggleAttribute(name: string, force: boolean): boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  checkVisibility?(options?: Record<string, boolean>): boolean;
  readonly offsetWidth?: number;
}

/** An element's own `--glass-blur`, in CSS px; 0 where its rule is not in force. */
export function glassBlurOf(style: GlassStyle): number {
  const n = parseFloat(style.getPropertyValue('--glass-blur'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether an ancestor with this style turns the backdrop of every glass
 *  element under it off: it is a backdrop root that is not the page. */
export function blocksBackdrop(style: GlassStyle, marked: boolean): boolean {
  if (parseFloat(style.opacity) < 1) return true;
  if (style.filter && style.filter !== 'none') return true;
  const backdrop = style.backdropFilter || style.webkitBackdropFilter || 'none';
  if (backdrop !== 'none') return true;
  if (marked && glassBlurOf(style) > 0) return true;
  if (style.clipPath && style.clipPath !== 'none') return true;
  const mask = style.maskImage || style.webkitMaskImage || 'none';
  if (mask !== 'none') return true;
  if (style.mixBlendMode && style.mixBlendMode !== 'normal') return true;
  return false;
}


/** How many drawn frames an element that moved keeps having its box read
 *  fresh before the draw. A panel the mode positions every frame (the
 *  surface view's tracking pill) stays read; one that moved once (a menu
 *  sliding open) goes back to the free reading a second or so later. */
export const GLASS_VOLATILE_DRAWS = 60;

/** What the registry remembers of one element between frames. */
interface Track {
  /** Its box at the last scan of this tick, if it was glass. */
  seen: GlassRect | null;
  /** Its box in the last drawn frame, if it was glass there. */
  drawn: GlassRect | null;
  /** Drawn frames left in which its box is read fresh before the draw. */
  volatile: number;
}

function sameCanvas(a: GlassCanvas, b: GlassCanvas | null): boolean {
  return b !== null && a.bufferWidth === b.bufferWidth && a.bufferHeight === b.bufferHeight
    && a.rect.left === b.rect.left && a.rect.top === b.rect.top
    && a.rect.width === b.rect.width && a.rect.height === b.rect.height;
}

/**
 * What a drawn frame means for the class that turns the browser's blur off
 * and for the change test: the class is on exactly when the frame carried the
 * engine's glass (the route was live and every panel was drawn, or there was
 * none to draw); a frame on the engine's route that could not draw its glass
 * keeps the browser's blur and forgets what was drawn, so the next scan reads
 * a change and draws again; a frame off the route leaves the change test
 * alone (no scan runs there).
 */
export function glassFrameOutcome(routeLive: boolean, frameComplete: boolean): { engineClass: boolean; drawn: 'mark' | 'forget' | 'keep' } {
  if (!routeLive) return { engineClass: false, drawn: 'keep' };
  return frameComplete ? { engineClass: true, drawn: 'mark' } : { engineClass: false, drawn: 'forget' };
}

function sameBox(a: GlassRect | null, b: GlassRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/**
 * The registry and the per-frame scan. One instance for the session.
 */
export class GlassRegistry {
  private elements: GlassElement[] = [];
  private readonly tracks = new Map<GlassElement, Track>();
  private readonly styles = new Map<GlassElement, GlassStyle>();
  private readonly handedOver = new Set<GlassElement>();
  /** What the last drawn frame drew, flattened, for the change test. */
  private drawnKey: number[] = [];
  private readonly ancestorVerdict = new Map<GlassElement, boolean>();
  /** Per pass, where there is no checkVisibility: whether an element or an
   *  ancestor of it has `display: none`, each element judged once. */
  private readonly displayNone = new Map<GlassElement, boolean>();
  /** The canvas the last full scan mapped its boxes through. */
  private scanCanvas: GlassCanvas | null = null;
  private surplusSaid = false;
  /** The last full scan's own time, ms, for the readout. */
  lastScanMs = 0;
  /** The last pre-draw pass's own time, ms. */
  lastRecheckMs = 0;
  /** Boxes the last pre-draw pass read fresh (each a layout read). */
  lastRecheckReads = 0;
  /** Boxes read by the pass under way. */
  private boxReads = 0;

  constructor(
    private readonly collect: () => GlassElement[],
    private readonly read: (el: GlassElement) => GlassStyle,
    private readonly canvas: () => GlassCanvas,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.refresh();
  }

  /** Collect the marked elements again: call after building glass in code. */
  refresh(): void {
    this.elements = this.collect();
    this.styles.clear();
    const keep = new Set(this.elements);
    for (const el of [...this.tracks.keys()]) if (!keep.has(el)) this.tracks.delete(el);
  }

  /** How many elements are registered. */
  get registered(): number {
    return this.elements.length;
  }

  /** An element's computed style: the live object, made once and read many
   *  times (it reflects the element's current style at every read). */
  private readonly styleOf = (el: GlassElement): GlassStyle => {
    let s = this.styles.get(el);
    if (!s) {
      s = this.read(el);
      this.styles.set(el, s);
    }
    return s;
  };

  private track(el: GlassElement): Track {
    let t = this.tracks.get(el);
    if (!t) {
      t = { seen: null, drawn: null, volatile: 0 };
      this.tracks.set(el, t);
    }
    return t;
  }

  /** This frame's rects, in document order, at most GLASS_MAX_RECTS. */
  rects(): GlassRect[] {
    const out: GlassRect[] = [];
    for (const el of this.elements) {
      const rect = this.tracks.get(el)?.seen;
      if (!rect || this.handedOver.has(el)) continue;
      if (out.length >= GLASS_MAX_RECTS) {
        if (import.meta.env.DEV && !this.surplusSaid) {
          this.surplusSaid = true;
          console.warn(`[glass] more than ${GLASS_MAX_RECTS} glass panels on screen; the rest are drawn without blur`);
        }
        break;
      }
      out.push(rect);
    }
    return out;
  }

  /**
   * The full scan, at the top of the tick: every registered element's
   * visibility, values and box. Returns whether anything differs from the
   * last drawn frame.
   */
  scan(): boolean {
    const t0 = this.now();
    const canvas = this.canvas();
    this.scanCanvas = canvas;
    this.ancestorVerdict.clear();
    this.displayNone.clear();
    for (const el of this.elements) this.track(el).seen = this.readElement(el, canvas, null);
    this.handOverOverlaps();
    this.lastScanMs = this.now() - t0;
    return this.changed();
  }

  /** Panels left to the browser because they overlap another (handOverOverlaps). */
  get browserBlurred(): number {
    return this.handedOver.size;
  }

  /**
   * Glass over glass goes back to the browser, both panels. The engine blurs
   * the canvas alone, so a panel over another would show the lower one's
   * text and controls crisp through its tint, where the browser blurs them
   * away (the phone's tour card under the ☰ menu is the case that happens).
   * While two panels overlap, each carries `data-glass-browser`, which gives
   * it its own CSS blur back under the engine class (index.html), and the
   * engine draws neither: the upper one's backdrop is then the canvas and the
   * lower panel, as it always was. Both, because which of the two is on top
   * is the stacking order's to say and not the boxes'; the cost is one or
   * two browser blurs for as long as the overlap lasts.
   */
  private handOverOverlaps(): void {
    const shown: Array<[GlassElement, GlassRect]> = [];
    for (const el of this.elements) {
      const r = this.tracks.get(el)?.seen;
      if (r) shown.push([el, r]);
    }
    const over = new Set<GlassElement>();
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i][1];
        const b = shown[j][1];
        if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5) {
          over.add(shown[i][0]);
          over.add(shown[j][0]);
        }
      }
    }
    for (const el of [...this.handedOver]) {
      if (!over.has(el)) {
        el.toggleAttribute('data-glass-browser', false);
        this.handedOver.delete(el);
      }
    }
    for (const el of over) {
      if (!this.handedOver.has(el)) {
        el.toggleAttribute('data-glass-browser', true);
        this.handedOver.add(el);
      }
    }
  }

  /**
   * The pre-draw pass, after the mode's own DOM writes: visibility and
   * opacity again for every element, which need style but no layout. An
   * element's box is read again only where it may have moved since the top
   * of the tick — it has just appeared, its box differs from the one last
   * drawn, or it moved within the last GLASS_VOLATILE_DRAWS drawn frames —
   * and reused otherwise, so a still interface costs no layout here. Returns
   * whether anything differs from the last drawn frame.
   */
  recheck(): boolean {
    const t0 = this.now();
    const canvas = this.canvas();
    // The canvas resized since the scan (the viewport sync runs between the
    // two): every box was mapped through the old size, so none is reused.
    const resized = !sameCanvas(canvas, this.scanCanvas);
    this.scanCanvas = canvas;
    this.ancestorVerdict.clear();
    this.displayNone.clear();
    this.boxReads = 0;
    for (const el of this.elements) {
      const t = this.track(el);
      const settled = !resized && t.seen !== null && t.volatile === 0 && sameBox(t.seen, t.drawn);
      t.seen = this.readElement(el, canvas, settled ? t.seen : null);
    }
    this.handOverOverlaps();
    this.lastRecheckReads = this.boxReads;
    this.lastRecheckMs = this.now() - t0;
    return this.changed();
  }

  /** The frame drew this tick's rects: they are what the next change is
   *  measured against, and an element whose box moved since the last drawn
   *  frame has its box read fresh before the next GLASS_VOLATILE_DRAWS. */
  markDrawn(): void {
    for (const t of this.tracks.values()) {
      if (t.seen && t.drawn && !sameBox(t.seen, t.drawn)) t.volatile = GLASS_VOLATILE_DRAWS;
      else if (t.volatile > 0) t.volatile--;
      t.drawn = t.seen;
    }
    this.drawnKey = this.key();
  }

  /** Forget what was drawn, so the next scan reads as a change. */
  forgetDrawn(): void {
    this.drawnKey = [-1];
  }

  private changed(): boolean {
    const key = this.key();
    const old = this.drawnKey;
    if (key.length !== old.length) return true;
    for (let i = 0; i < key.length; i++) if (key[i] !== old[i]) return true;
    return false;
  }

  private key(): number[] {
    const out: number[] = [];
    for (const r of this.rects()) {
      out.push(r.x0, r.y0, r.x1, r.y1, r.radii[0], r.radii[1], r.radii[2], r.radii[3], r.sigma, r.saturation, r.coverage);
    }
    return out;
  }

  /** Visibility as the browser renders it: `checkVisibility` where there is
   *  one (both spellings of its option, old and new), else the walk up the
   *  tree for `display: none`, memoised per pass so the 48 elements' shared
   *  ancestors are read once. */
  private rendered(el: GlassElement): boolean {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    }
    const style = this.styleOf(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    return !this.hiddenUp(el);
  }

  private hiddenUp(el: GlassElement): boolean {
    let verdict = this.displayNone.get(el);
    if (verdict === undefined) {
      verdict = this.styleOf(el).display === 'none' || (el.parentElement !== null && this.hiddenUp(el.parentElement));
      this.displayNone.set(el, verdict);
    }
    return verdict;
  }

  /** Whether some ancestor of `el` is a backdrop root that is not the page;
   *  each ancestor judged once per scan. */
  private underBackdropRoot(el: GlassElement): boolean {
    for (let a = el.parentElement; a; a = a.parentElement) {
      let verdict = this.ancestorVerdict.get(a);
      if (verdict === undefined) {
        // The page's own root is always a backdrop root: the canvas is under it.
        verdict = a.parentElement !== null && blocksBackdrop(this.styleOf(a), a.hasAttribute('data-glass'));
        this.ancestorVerdict.set(a, verdict);
      }
      if (verdict) return true;
    }
    return false;
  }

  /** One element, as glass this frame or null. `box` is a rect already read
   *  this tick, which the pre-draw pass reuses instead of reading layout. */
  private readElement(el: GlassElement, canvas: GlassCanvas, box: GlassRect | null): GlassRect | null {
    // Rendered first: most registered elements are hidden at any moment, and
    // a browser computes the style of an element under `display: none` out
    // of band on every read, where the visibility test needs none of it.
    if (!this.rendered(el)) return null;
    const style = this.styleOf(el);
    const blur = glassBlurOf(style);
    if (blur <= 0) return null;
    const opacity = parseFloat(style.opacity);
    if (!(opacity > 0)) return null;
    if (this.underBackdropRoot(el)) return null;
    const coverage = glassCoverage(opacity, parseColourAlpha(style.backgroundColor));
    if (box) {
      // Seen at the top of the tick: the same box, this pass's opacity.
      return box.coverage === coverage ? box : { ...box, coverage };
    }
    const r = el.getBoundingClientRect();
    this.boxReads++;
    if (!(r.width > 0 && r.height > 0)) return null;
    const mapped = boxToBuffer(r, canvas);
    if (!mapped) return null;
    // The element's own transform scale: its layout width against its box.
    const layoutWidth = el.offsetWidth ?? 0;
    const scale = layoutWidth > 0 ? r.width / layoutWidth : 1;
    const cssW = r.width / scale;
    const cssH = r.height / scale;
    const [tl, tr, br, bl] = clampCornerRadii([
      parseRadius(style.borderTopLeftRadius, cssW),
      parseRadius(style.borderTopRightRadius, cssW),
      parseRadius(style.borderBottomRightRadius, cssW),
      parseRadius(style.borderBottomLeftRadius, cssW),
    ], cssW, cssH);
    const k = scale * 0.5 * (mapped.sx + mapped.sy);
    const sat = parseFloat(style.getPropertyValue('--glass-sat'));
    return {
      x0: mapped.x0,
      y0: mapped.y0,
      x1: mapped.x1,
      y1: mapped.y1,
      radii: [bl * k, br * k, tr * k, tl * k],
      sigma: blur * k,
      saturation: Number.isFinite(sat) ? sat / 100 : 1,
      coverage,
    };
  }
}
