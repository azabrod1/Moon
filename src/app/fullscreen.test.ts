import { describe, expect, it } from 'vitest';
import {
  fullscreenOffered,
  isFullscreen,
  toggleFullscreen,
  watchFullscreen,
  type FullscreenHost,
  type FullscreenTarget,
} from './fullscreen';

/** Something to stand in for the element that went full screen. Nothing reads
 *  it — the app only ever asks whether it is there. */
const SOME_ELEMENT = {} as Element;

interface FakeOptions {
  /** What `fullscreenEnabled` answers. */
  enabled?: boolean;
  /** Safari before 16.4: only the prefixed spelling exists. */
  prefixed?: boolean;
  /** A request that never succeeds, the way a browser refuses one whose
   *  activation has expired. */
  refuse?: boolean;
  /** A document element with no request method at all. */
  noTarget?: boolean;
}

/**
 * A document that behaves like a browser's: a request puts an element in the
 * slot, an exit takes it out, and both fire the change event the same way the
 * real one does, so a test can assert that the label would be rewritten.
 */
class FakeDocument implements FullscreenHost {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement: Element | null = null;
  webkitFullscreenElement: Element | null = null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void | Promise<void>;
  documentElement: FullscreenTarget | null;

  /** Every change event dispatched, by type, so the test can count them. */
  readonly dispatched: string[] = [];
  /** The live listeners, by type. */
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: FakeOptions = {}) {
    const { enabled = true, prefixed = false, refuse = false, noTarget = false } = options;
    if (prefixed) this.webkitFullscreenEnabled = enabled;
    else this.fullscreenEnabled = enabled;

    const enter = async (): Promise<void> => {
      if (refuse) throw new TypeError('permissions check failed');
      if (prefixed) this.webkitFullscreenElement = SOME_ELEMENT;
      else this.fullscreenElement = SOME_ELEMENT;
      this.fire(prefixed ? 'webkitfullscreenchange' : 'fullscreenchange');
    };
    const leave = async (): Promise<void> => {
      this.fullscreenElement = null;
      this.webkitFullscreenElement = null;
      this.fire(prefixed ? 'webkitfullscreenchange' : 'fullscreenchange');
    };

    this.documentElement = noTarget
      ? {}
      : prefixed
        ? { webkitRequestFullscreen: enter }
        : { requestFullscreen: enter };
    if (prefixed) this.webkitExitFullscreen = leave;
    else this.exitFullscreen = leave;
  }

  addEventListener(type: string, handler: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: () => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** The browser's own way out — Escape, F11, the window's control. */
  leaveFromOutside(): void {
    this.fullscreenElement = null;
    this.webkitFullscreenElement = null;
    this.fire('fullscreenchange');
  }

  private fire(type: string): void {
    this.dispatched.push(type);
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
}

describe('whether the control is offered at all', () => {
  it('is offered where the browser will take an element full screen', () => {
    expect(fullscreenOffered(new FakeDocument())).toBe(true);
  });

  it('takes the prefixed spelling on a Safari before 16.4', () => {
    expect(fullscreenOffered(new FakeDocument({ prefixed: true }))).toBe(true);
  });

  // An iframe without the permission, and a browser whose full screen is
  // video-only: a row here could only ever fail, so there is no row.
  it('is not offered where the document refuses it', () => {
    expect(fullscreenOffered(new FakeDocument({ enabled: false }))).toBe(false);
  });

  it('is not offered where the document element has no request method', () => {
    expect(fullscreenOffered(new FakeDocument({ noTarget: true }))).toBe(false);
  });

  // Chromium keeps the `webkit` alias beside the standard property, so the
  // two are both present and the standard one is the authority. An `||` here
  // offered the control in a frame whose `fullscreenEnabled` was false.
  it('lets the unprefixed answer overrule a prefixed alias that says yes', () => {
    const host = new FakeDocument({ enabled: false });
    host.webkitFullscreenEnabled = true;
    expect(host.fullscreenEnabled).toBe(false);
    expect(fullscreenOffered(host)).toBe(false);
  });

  it('still takes the prefixed answer where there is no unprefixed one', () => {
    const host = new FakeDocument({ prefixed: true });
    expect(host.fullscreenEnabled).toBeUndefined();
    expect(fullscreenOffered(host)).toBe(true);
  });

  // Every entry point defaults to the browser's document; in a test there is
  // none, and nothing may throw on the way to that answer.
  it('is not offered where there is no document', () => {
    expect(fullscreenOffered(null)).toBe(false);
    expect(isFullscreen(null)).toBe(false);
  });
});

describe('going in and coming back', () => {
  it('enters, then leaves, reading the state back from the document', async () => {
    const host = new FakeDocument();
    expect(isFullscreen(host)).toBe(false);
    expect(await toggleFullscreen(host)).toBe(true);
    expect(isFullscreen(host)).toBe(true);
    expect(await toggleFullscreen(host)).toBe(false);
    expect(isFullscreen(host)).toBe(false);
  });

  it('uses the prefixed pair throughout on an older Safari', async () => {
    const host = new FakeDocument({ prefixed: true });
    expect(await toggleFullscreen(host)).toBe(true);
    expect(host.webkitFullscreenElement).toBe(SOME_ELEMENT);
    expect(await toggleFullscreen(host)).toBe(false);
  });

  // The promise rejects in a browser when the activation has expired. It must
  // resolve false here: an unhandled rejection reaches the error overlay, and
  // a display preference is never worth that.
  it('resolves false on a refusal instead of throwing', async () => {
    const host = new FakeDocument({ refuse: true });
    await expect(toggleFullscreen(host)).resolves.toBe(false);
    expect(isFullscreen(host)).toBe(false);
  });

  it('does nothing without a document', async () => {
    await expect(toggleFullscreen(null)).resolves.toBe(false);
  });
});

describe('the change event is what the label listens to', () => {
  it('fires for a transition the app started', async () => {
    const host = new FakeDocument();
    let seen = 0;
    watchFullscreen(() => { seen += 1; }, host);
    await toggleFullscreen(host);
    expect(seen).toBe(1);
    await toggleFullscreen(host);
    expect(seen).toBe(2);
  });

  // The case the label would otherwise get wrong: Escape and F11 leave full
  // screen without passing through the app's button.
  it('fires for a way out the app never started', () => {
    const host = new FakeDocument();
    const states: boolean[] = [];
    watchFullscreen(() => states.push(isFullscreen(host)), host);
    host.fullscreenElement = SOME_ELEMENT;
    host.leaveFromOutside();
    expect(states).toEqual([false]);
  });

  it('stops on unsubscribe', async () => {
    const host = new FakeDocument();
    let seen = 0;
    const stop = watchFullscreen(() => { seen += 1; }, host);
    await toggleFullscreen(host);
    stop();
    await toggleFullscreen(host);
    expect(seen).toBe(1);
  });

  it('hands back a no-op unsubscribe with no document', () => {
    expect(() => watchFullscreen(() => {}, null)()).not.toThrow();
  });
});
