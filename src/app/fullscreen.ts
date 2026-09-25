/**
 * Full screen: the page's own request to fill the screen.
 *
 * A desktop browser already has a key for this (F11; Ctrl+Cmd+F on a Mac), so
 * the control is mostly for the screens that have none. On a phone or a tablet
 * the address bar and the system bars hold a real share of the screen, and on
 * a page that never scrolls — this one — nothing puts them away except the
 * page's own request. It is also for the reader who never learned the key. It
 * is the ☰ panel's Full screen row and the F key, in every mode that takes
 * keys. The element that goes full screen is the document's root, so the HTML
 * interface comes along with the canvas, and the renderer follows through the
 * ordinary resize path (main.ts syncViewport): to the app, a full-screen
 * change is just a resize.
 *
 * **Offered only where it can work.** `document.fullscreenEnabled` is false
 * where the browser will refuse — for years an iPhone's Safari offered full
 * screen to a <video> alone, and a frame embedded without allowfullscreen
 * never gets it — and there the row stays hidden and F does nothing, rather
 * than being a control that changes nothing. There is no prefixed path:
 * Safari has had the standard API since 16.4.
 *
 * **Escape.** In a full screen the page asked for, the browser keeps Escape
 * for leaving it, and the page is not told about that press. The app's Escape
 * cascade (close the map, leave the surface, take off…) would then be a press
 * behind, and the first Escape of every dismissal would end full screen
 * instead. Where the Keyboard Lock API exists (Chromium), the page takes
 * Escape for itself once it is full screen: the cascade works as it does in a
 * window, and leaving takes a HELD Escape — what Chrome's own full-screen
 * notice asks for while the key is locked — or F, or the row. The first press
 * of that hold is still an ordinary press and takes one rung of the cascade.
 * Firefox and Safari have no such API and keep Escape for themselves. The lock
 * is released when full screen ends, however it ends.
 *
 * **What this cannot see.** The browser's own full screen (F11) is not the
 * page's: the API reports it as not full screen and the page cannot leave it,
 * so the row reads Off under F11, and turning it on nests the page's full
 * screen inside the browser's. Nothing is remembered across a reload,
 * because a page may only go full screen inside a click or a key press.
 */
import { debugWarn } from '../shared/debug';

/** Chromium's Keyboard Lock API, which TypeScript's DOM library leaves out. */
interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardLock(): KeyboardLock | null {
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  return typeof keyboard?.lock === 'function' && typeof keyboard.unlock === 'function'
    ? keyboard as KeyboardLock
    : null;
}

/** The request in flight, so a second press while the browser is still
 *  answering the first cannot fire another one — a double click on the row,
 *  or F reaching two modes' handlers across a mode switch. */
let pending: Promise<boolean> | null = null;

let unlockOnExitWired = false;

/** Whether this page can go full screen at all. Fixed for the session. */
export function fullscreenAvailable(): boolean {
  return document.fullscreenEnabled === true
    && typeof document.documentElement.requestFullscreen === 'function';
}

/** Whether the page is full screen by its own request. A browser's own full
 *  screen (F11) reads false: the page never asked for it. */
export function isFullscreen(): boolean {
  return document.fullscreenElement != null;
}

/** Every change, whoever made it: F, the row, a held Escape, the browser's own
 *  controls, a tab switch. */
export function onFullscreenChange(listener: () => void): void {
  document.addEventListener('fullscreenchange', listener);
}

/**
 * Go full screen, or come out of it. Call it from inside the click or the key
 * press that asked: a browser grants full screen only to a user's gesture, and
 * nothing is awaited here before the request is made. Resolves false when the
 * browser refused, which the caller may want to say out loud; a press that
 * arrives while a request is still being answered is dropped and resolves
 * true, since nothing went wrong.
 */
export function toggleFullscreen(): Promise<boolean> {
  if (pending) return Promise.resolve(true);
  if (!fullscreenAvailable()) return Promise.resolve(false);
  const leaving = isFullscreen();
  const request = leaving
    ? document.exitFullscreen()
    : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  pending = request.then(
    () => {
      if (!leaving) lockEscape();
      return true;
    },
    (reason: unknown) => {
      debugWarn(leaving ? 'Leaving full screen refused' : 'Full screen refused', reason);
      return false;
    },
  ).finally(() => { pending = null; });
  return pending;
}

/** Take Escape from the browser for as long as the page is full screen, so
 *  the app's cascade keeps it. A refusal leaves Escape the browser's, which is
 *  only the behaviour this exists to improve on. */
function lockEscape(): void {
  const keyboard = keyboardLock();
  // Full screen can end before its request's promise settles; a lock taken
  // after that would wait for the next full screen, whoever asked for it.
  if (!keyboard || !isFullscreen()) return;
  if (!unlockOnExitWired) {
    unlockOnExitWired = true;
    onFullscreenChange(() => {
      if (!isFullscreen()) keyboardLock()?.unlock();
    });
  }
  keyboard.lock(['Escape']).catch((reason: unknown) => {
    debugWarn('Escape stays with the browser in full screen', reason);
  });
}

/** What the F-key test reads: the key, its modifiers and where it was typed. */
export type FullscreenKeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>;

/**
 * The F key on its own. Ctrl, Cmd and Alt belong to the browser (Find, its
 * menu), and an F typed into a field is a letter. Shift and Caps Lock are
 * allowed, as the app's other letter keys allow them. Pure: the target is
 * read by its tag, so a test can hand it a plain object.
 */
export function isFullscreenKey(event: FullscreenKeyEvent): boolean {
  if (event.key !== 'f' && event.key !== 'F') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isTextEntry(event.target);
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

/**
 * F, for a mode's own keydown handler: true when the press was the shortcut
 * and has been dealt with. A held F repeats, and a repeat must not flap the
 * screen in and out; a press some control already handled is left alone.
 */
export function handleFullscreenKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || !isFullscreenKey(event) || !fullscreenAvailable()) return false;
  event.preventDefault();
  if (!event.repeat) void toggleFullscreen();
  return true;
}
