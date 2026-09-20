/**
 * The ☰ panel: one popover with pages inside it.
 *
 * The panel is a fixed-width card anchored under the ☰ button, and its
 * children are `.menu-page` elements of which exactly one is current. The
 * ROOT page is the list of actions, the tier rows and the flat toggles; a
 * tier row (`button.menu-tier[data-open="graphics"]`) opens the page it
 * names, and the `‹` button at the top of a sub-page comes back. Navigation
 * is delegated from the panel itself, so a new tier is markup and nothing
 * else — no wiring, no new class.
 *
 * The pages share one grid cell, so a page change slides: the outgoing page
 * moves out and the incoming one in, 220 ms on transform and opacity, which
 * is compositor work. The slide is a Web Animations call with both keyframes
 * spelled out, not a CSS transition off a toggled class: a transition starts
 * from whatever style the engine computed last, and a page that has been
 * measured while hidden already has one, so toggling a start class on it
 * began a transition and taking the class off reversed it to nothing — the
 * page snapped into place. Nothing animates the panel's HEIGHT — the outline
 * takes the incoming page's height in one step, the way every other resize in
 * this app does — and the outgoing page is taken out of flow for the slide so
 * it cannot hold the old height open. The panel clips while a slide runs and
 * gets its scrolling back when it settles, when the entering page's animation
 * finishes or on a safety timeout, so an interrupted slide can never leave the
 * panel unable to scroll. Only the vertical axis is held, so the stylesheet's
 * sideways rule keeps clipping the pages throughout.
 *
 * **Focus never scrolls.** The incoming page is still a page-width off to the
 * right when its back button takes focus, and a panel that scrolled that
 * button into view would carry every row across with it and then snap back
 * when the slide settles — a jump of 20 px in a desktop window and 26 px at a
 * phone width, which is what a reader sees as the text bouncing. A panel whose
 * overflow is hidden is still a scroll container (hidden only takes the
 * scrollbar away, and clip is not available: it computes back to hidden beside
 * a scrolling axis), so the focus call itself is what has to refuse, and
 * settling puts any sideways offset back to zero regardless.
 * `prefers-reduced-motion: reduce` swaps the pages outright.
 *
 * **Hiding resets to the root.** The menu always opens on the list, and no
 * page is remembered across a close: that is what a popover does, and there
 * is then no page state to restore when a mission or a tutorial re-shows the
 * panel. `onShow` fires on every closed-to-open transition and is where the
 * owner re-reads anything it draws in here — while the panel is closed
 * nothing is kept up to date, and a level arriving from the URL or the DEV
 * bridge is read on the next open.
 *
 * The pause and resume of the ship and the clock that happen while the panel
 * is open stay the caller's job (PlanetariumMode): this class owns the panel's
 * own state and nothing about the scene behind it.
 *
 * Escape is deliberately NOT wired here. The ☰ menu is out of the app's
 * Escape cascade — every other transient overlay is in it, and this one
 * auto-pauses the ship and the clock, so a stray Escape that closed it would
 * resume both — and the back button, first in a sub-page's Tab order, is the
 * way out.
 */

/** The page a closed panel always opens on. */
const ROOT_PAGE = 'root';

/** The slide, and the wait before the settle runs anyway. Long enough for a
 *  transition that never fires its end event (a page swapped out from under
 *  it, an engine that skipped the animation) to be cleaned up. */
const SLIDE_MS = 220;
const SLIDE_SAFETY_MS = SLIDE_MS + 120;

export interface MenuPanelHooks {
  /** Every closed-to-open transition, after the page has been reset to the
   *  root. The owner re-reads what it draws in the panel here. */
  onShow?: () => void;
  /** A page has become current, the root included. */
  onPageOpen?: (page: string) => void;
}

export class PlanetariumMenuPanel {
  /** The page on screen. A cached field, never a DOM read: the graphics
   *  readout's hot-path guard asks for it on every scene-ratio change. */
  private currentPage = ROOT_PAGE;

  private hooks: MenuPanelHooks = {};

  /** The tier row that opened the current page, so coming back gives the
   *  keyboard its place in the list again. Recorded on the click because
   *  WebKit does not focus a clicked button. */
  private opener: HTMLElement | null = null;

  /** Bumped by every navigation, so a slide that is superseded mid-flight
   *  settles nothing. */
  private generation = 0;

  private settleTimer: number | null = null;

  private reduceMotion: MediaQueryList | null = null;

  /** The app's own easing (`--ease` on the root), read once. */
  private easing: string | null = null;

  private el(): HTMLElement | null {
    return document.getElementById('planetarium-menu-panel');
  }

  private pageEl(page: string): HTMLElement | null {
    return this.el()?.querySelector<HTMLElement>(`.menu-page[data-page="${page}"]`) ?? null;
  }

  private pages(): HTMLElement[] {
    return [...(this.el()?.querySelectorAll<HTMLElement>('.menu-page') ?? [])];
  }

  /** Install the delegated navigation and the owner's hooks. Idempotent in
   *  practice — the owner wires its UI once. */
  wire(hooks: MenuPanelHooks): void {
    this.hooks = hooks;
    const panel = this.el();
    if (!panel) return;
    panel.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const tier = target?.closest<HTMLElement>('.menu-tier');
      if (tier) {
        this.opener = tier;
        this.openPage(tier.dataset.open ?? ROOT_PAGE);
        return;
      }
      if (target?.closest('.menu-back')) this.back();
    });
  }

  show(): void {
    const el = this.el();
    if (!el || el.classList.contains('visible')) return;
    el.classList.add('visible');
    this.onShown();
  }

  hide(): void {
    const el = this.el();
    if (!el?.classList.contains('visible')) return;
    el.classList.remove('visible');
    this.resetToRoot();
  }

  setVisible(visible: boolean): void {
    const wasOpen = this.isOpen();
    this.el()?.classList.toggle('visible', visible);
    if (visible && !wasOpen) this.onShown();
    else if (!visible && wasOpen) this.resetToRoot();
  }

  isOpen(): boolean {
    return this.el()?.classList.contains('visible') ?? false;
  }

  /** The page on screen. */
  page(): string {
    return this.currentPage;
  }

  /** Open a page by name. Going away from the root slides forward, coming
   *  back slides the other way. */
  openPage(page: string): void {
    this.navigate(page, page !== ROOT_PAGE);
  }

  /** The `‹` button: back to the root, and the keyboard back on the row that
   *  opened the page. */
  back(): void {
    const opener = this.opener;
    this.navigate(ROOT_PAGE, false);
    opener?.focus({ preventScroll: true });
  }

  /** Write the value a tier row carries on its right — "Dynamic · Medium".
   *  One call per tier, so the next one is a line rather than a special
   *  case. */
  setTierValue(page: string, text: string): void {
    const value = this.el()?.querySelector<HTMLElement>(`.menu-tier[data-open="${page}"] .menu-tier-value`);
    if (value) value.textContent = text;
  }

  private onShown(): void {
    this.resetToRoot();
    this.hooks.onShow?.();
  }

  /** Put the root back with no motion: the panel is not on screen, or is
   *  about to leave it. */
  private resetToRoot(): void {
    this.currentPage = ROOT_PAGE;
    this.opener = null;
    this.generation += 1;
    this.settle();
  }

  private ease(): string {
    if (this.easing === null) {
      const declared = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim();
      this.easing = declared || 'ease-out';
    }
    return this.easing;
  }

  private prefersReducedMotion(): boolean {
    if (!this.reduceMotion) this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    return this.reduceMotion.matches;
  }

  private navigate(to: string, forward: boolean): void {
    const panel = this.el();
    const next = this.pageEl(to);
    if (!panel || !next || to === this.currentPage) return;
    const from = this.pageEl(this.currentPage);
    this.currentPage = to;
    this.generation += 1;
    const generation = this.generation;

    // Un-hidden BEFORE anything is focused, and the outgoing page is hidden
    // only once the slide ends: a page cannot take focus while it is hidden.
    next.hidden = false;
    panel.scrollTop = 0;

    if (from && from !== next && !this.prefersReducedMotion() && typeof next.animate === 'function') {
      from.classList.add('menu-page-leaving');
      panel.style.overflowY = 'hidden';
      // Going deeper, the old page leaves to the left and the new one comes in
      // from the right; coming back, the other way round. `fill: forwards`
      // holds each page at its end pose until settle() cancels the animation,
      // so the leaving page cannot flash back into view between finishing
      // and being hidden.
      const away = forward ? '-100%' : '100%';
      const fromSide = forward ? '100%' : '-100%';
      const options: KeyframeAnimationOptions = { duration: SLIDE_MS, easing: this.ease(), fill: 'forwards' };
      from.animate([
        { transform: 'none', opacity: 1 },
        { transform: `translateX(${away})`, opacity: 0 },
      ], options);
      const enter = next.animate([
        { transform: `translateX(${fromSide})`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], options);
      // A cancelled animation rejects `finished`; settle() is what cancels it,
      // so there is nothing to do then.
      enter.finished.then(() => this.settle(generation), () => {});
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.settle(generation), SLIDE_SAFETY_MS);
    } else {
      this.settle(generation);
    }

    this.focusTargetFor(to)?.focus({ preventScroll: true });
    this.hooks.onPageOpen?.(to);
  }

  /** What the keyboard lands on when a page opens: a sub-page's back button,
   *  which is the first thing in it. The root's focus is the caller's — it
   *  goes back to the tier row that opened the page. */
  private focusTargetFor(page: string): HTMLElement | null {
    if (page === ROOT_PAGE) return null;
    return this.pageEl(page)?.querySelector<HTMLElement>('.menu-back') ?? null;
  }

  /** End of a slide, or a reset: every page but the current one hidden, every
   *  slide animation cancelled and the leaving page back in flow, and the
   *  panel scrolling again. Runs for a given navigation only while that
   *  navigation is still the latest one, so a superseded slide cleans nothing
   *  up under its successor. */
  private settle(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    const panel = this.el();
    for (const page of this.pages()) {
      if (typeof page.getAnimations === 'function') for (const animation of page.getAnimations()) animation.cancel();
      page.classList.remove('menu-page-leaving');
      page.hidden = page.dataset.page !== this.currentPage;
    }
    // Never leave an inline overflow behind: the panel's own rule is what
    // makes a tall list reachable on a small phone. The sideways offset is put
    // back too, in case an engine scrolled the panel across despite the focus
    // asking it not to — the panel has no sideways scrolling to offer.
    panel?.style.removeProperty('overflow-y');
    if (panel) {
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
    }
  }
}
