/**
 * The viewport the frame is drawn into: the canvas's own CSS box.
 *
 * Everything that works in screen space — the renderer's size, the cameras'
 * aspect, the composer's targets, the bloom chain, the star point sizes, the
 * label pipelines, the corner chart — measures ONE rectangle, and that
 * rectangle is the canvas's box, not `window.innerWidth × innerHeight`. On a
 * desktop the two never differ. On an iPad Pro in the page's own full screen
 * they did (measured off a screenshot, iPadOS 26): the fixed-position rect
 * that every DOM layer — the UI overlay, the labels, the reticles — is
 * anchored to sat 32 pt in from the top and the bottom of the screen (WebKit
 * lays a page without viewport-fit=cover out inside the safe area), the
 * in-flow canvas started another 32 pt lower still, and its stars stopped
 * 64 pt short of the top of the screen and 30 pt short of the bottom, with
 * the bottom bar sitting inside that band. So the canvas is `position: fixed`
 * at the viewport's origin (index.html), sized by CSS to the fixed-position
 * rect the interface is on, and the renderer follows THAT box: a
 * ResizeObserver on the canvas reports every change to it, including the ones
 * the window never announces (the iPad's full-screen transition emits no
 * resize event the page can act on before the box has moved), and the per-
 * frame drift poll keeps the window as the backstop for a transition that
 * emits nothing at all.
 *
 * The window is the fallback: before the canvas has been laid out (boot), and
 * wherever the box reads zero (a hidden tab, a detached canvas).
 *
 * Pure: the decisions are here, main.ts holds the observer and the renderer.
 */

/** A size in CSS px. */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * The size to size the renderer to: the canvas's box wherever it has one, the
 * window otherwise. A box with a zero side has not been laid out (or the tab
 * is hidden), and the window is the best guess the browser offers then.
 */
export function resolveViewportSize(box: ViewportSize, fallback: ViewportSize): ViewportSize {
  if (box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  return { width: fallback.width, height: fallback.height };
}

/** What the drift poll compares each check against. */
export interface ViewportDriftInput {
  /** The window now, and as it read at the last sync. */
  window: ViewportSize;
  windowAtSync: ViewportSize;
  /** The canvas's box as last reported (by the observer, or the sync's own
   *  read), and the size the renderer was last sized to. */
  box: ViewportSize;
  applied: ViewportSize;
  /** The live camera's aspect, and the renderer's pixel ratio against the
   *  one the policy asks for now. */
  cameraAspect: number;
  rendererPixelRatio: number;
  targetPixelRatio: number;
}

/**
 * Whether the viewport has moved under the renderer since the last sync.
 *
 * The window is compared with its OWN last reading rather than with the
 * applied size: the applied size is the canvas's box, and a browser whose
 * window and box legitimately differ (the box is what the interface is laid
 * out on) must not re-sync every third frame for the difference. A box that
 * differs from the applied size is a change the observer reported and the
 * sync has not consumed. The aspect term re-arms the sync if some other path
 * ever clobbers a camera, and the ratio term follows a page zoom or a move to
 * another monitor.
 */
export function viewportDrifted(input: ViewportDriftInput): boolean {
  const { window, windowAtSync, box, applied } = input;
  if (window.width !== windowAtSync.width || window.height !== windowAtSync.height) return true;
  if (box.width > 0 && box.height > 0 && (box.width !== applied.width || box.height !== applied.height)) return true;
  if (input.cameraAspect !== applied.width / applied.height) return true;
  return input.rendererPixelRatio !== input.targetPixelRatio;
}

// ── The applied size, for every reader ────────────────────────────────────

let applied: ViewportSize | null = null;

/** Record the size the renderer was just sized to. main.ts, from its viewport
 *  sync, and nowhere else. */
export function setViewportSize(size: ViewportSize): void {
  applied = { width: size.width, height: size.height };
}

/** The size the frame is drawn into, in CSS px: the canvas's box as of the
 *  last sync, or the window before the first one. No layout is forced —
 *  this is a cached number, safe on a hot path. */
export function viewportSize(): ViewportSize {
  if (applied) return applied;
  return { width: window.innerWidth, height: window.innerHeight };
}
