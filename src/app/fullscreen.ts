/**
 * Full screen — the browser's own, asked for by the app.
 *
 * The browser already has a way in from a desktop keyboard, and on Windows
 * and Linux it is one key. It is not one key everywhere. On a Mac, F11 is the
 * system's (volume down on an Apple keyboard, Show Desktop otherwise) and the
 * browser's is ⌃⌘F or the green button; on a phone there is no keyboard at
 * all, and a phone is where the cost is highest — Safari's URL bar and
 * toolbar take roughly an eighth of a 390×844 panel, and this page never
 * scrolls, so nothing ever rolls them away. So the app asks for itself.
 *
 * **The document element, never the canvas.** The HUD, the ☰ panel, the body
 * labels and every overlay are DOM siblings of the canvas, not children of
 * it: a canvas taken full screen paints the scene onto a black page with
 * every control gone. `document.documentElement` takes the lot.
 *
 * **The browser is the single source of truth.** Escape, F11, the window's
 * own control and the OS all leave full screen without passing through the
 * app's button, so a caller's label is read back from `fullscreenElement` and
 * never from what the click asked for. A click that writes its own label is a
 * label that goes stale the first time somebody presses Escape.
 *
 * Both signals here are needed and neither is enough. `watchFullscreen` is the
 * only one that sees a change the app did not start, but it is not guaranteed
 * to arrive — a headless Chromium was caught entering full screen, with
 * `fullscreenElement` set, without ever dispatching `fullscreenchange`. So
 * `toggleFullscreen` resolves with the state the document ended in, which
 * covers every transition the app itself started.
 *
 * **Nothing is persisted.** Entering full screen needs transient user
 * activation, so a saved "on" could not be applied at boot: the request would
 * be refused and the menu would open showing a state the window is not in.
 * The setting is session-only by construction, which is why there is no
 * storage key here beside `qualitySetting.ts` and `frameRateSetting.ts`.
 *
 * **Where it is not offered there is no row** — the same rule the Graphics
 * page uses for a level a display cannot draw. `fullscreenEnabled` is false
 * inside an iframe without the permission and on a browser with no element
 * full screen at all, and a toggle that could only ever fail is worse than no
 * toggle. iOS is the moving part here — an iPhone had no element full screen
 * for years, video only, and Safari 26 gave it one — so this asks the browser
 * rather than reading the user agent string.
 *
 * The prefixed WebKit spelling is kept for Safari before 16.4, where the
 * unprefixed names do not exist; it returns undefined rather than a promise,
 * which is why the calls are awaited through a wrapper rather than directly.
 *
 * The host is injectable so the tests can drive a fake — including one that
 * offers nothing, and one whose request rejects the way a browser does when
 * the gesture has already expired.
 */

/** The element side: what the app asks to be made full screen. */
export interface FullscreenTarget {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => void | Promise<void>;
}

/** The document side of the Fullscreen API, as much of it as this app uses.
 *  The `webkit` members are absent from the DOM lib types and present on a
 *  Safari before 16.4, so they are declared optional and read off the host. */
export interface FullscreenHost {
  readonly fullscreenEnabled?: boolean;
  readonly webkitFullscreenEnabled?: boolean;
  readonly fullscreenElement?: Element | null;
  readonly webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void | Promise<void>;
  readonly documentElement?: FullscreenTarget | null;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

/** The browser's own document, or null where there is none (a test, a
 *  worker). Every entry point defaults to it, so the app calls these with no
 *  argument and the tests pass a fake. */
function defaultHost(): FullscreenHost | null {
  return typeof document === 'undefined' ? null : (document as FullscreenHost);
}

/** Whether this browser, in this frame, will take an element full screen at
 *  all. False inside an iframe that was not given the permission, and on a
 *  browser whose full screen is video-only. The caller shows no control where
 *  this is false. */
export function fullscreenOffered(host: FullscreenHost | null = defaultHost()): boolean {
  if (!host) return false;
  // The unprefixed answer wins wherever it exists, and the prefixed one is
  // consulted only where it does not. Not an `||`: Chromium keeps the
  // `webkit` alias alongside the standard property, so an OR would let the
  // alias overrule a `fullscreenEnabled` of false and offer a control in a
  // frame that will refuse it.
  const allowed = host.fullscreenEnabled ?? host.webkitFullscreenEnabled ?? false;
  if (allowed !== true) return false;
  const target = host.documentElement;
  return !!(target?.requestFullscreen ?? target?.webkitRequestFullscreen);
}

/** Whether the window is full screen right now, read from the browser. */
export function isFullscreen(host: FullscreenHost | null = defaultHost()): boolean {
  if (!host) return false;
  return !!(host.fullscreenElement ?? host.webkitFullscreenElement);
}

/**
 * Ask for full screen, or give it back, and resolve with the state the
 * document ended in.
 *
 * The caller writes its label from that answer, or re-reads `isFullscreen`
 * once it settles: it is the signal that always arrives for a transition the
 * app started, where the change event is the one that also catches the
 * transitions it did not. A refusal — an expired gesture, a policy that
 * forbids it, a user who dismissed the prompt — resolves false rather than
 * throwing, because a display preference is never worth an unhandled
 * rejection reaching the error overlay.
 */
export async function toggleFullscreen(host: FullscreenHost | null = defaultHost()): Promise<boolean> {
  if (!host) return false;
  if (isFullscreen(host)) {
    try {
      await (host.exitFullscreen?.() ?? host.webkitExitFullscreen?.());
    } catch {
      // Already out, or the document went away underneath the call.
    }
    return isFullscreen(host);
  }
  const target = host.documentElement;
  if (!target) return false;
  try {
    await (target.requestFullscreen?.() ?? target.webkitRequestFullscreen?.());
  } catch {
    // Refused: no activation left, or the browser simply said no.
  }
  return isFullscreen(host);
}

/** Subscribe to every way the state can change — the app's own button, the
 *  F key, Escape, F11, the window's control, the OS. Returns the
 *  unsubscribe. Both spellings are wired: a Safari before 16.4 fires only the
 *  prefixed event, and a browser that fires both calls the handler twice,
 *  which costs one redundant label write. */
export function watchFullscreen(
  handler: () => void,
  host: FullscreenHost | null = defaultHost(),
): () => void {
  if (!host) return () => {};
  host.addEventListener('fullscreenchange', handler);
  host.addEventListener('webkitfullscreenchange', handler);
  return () => {
    host.removeEventListener('fullscreenchange', handler);
    host.removeEventListener('webkitfullscreenchange', handler);
  };
}
