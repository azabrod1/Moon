/**
 * The app's device-class verdicts, in one place. These answer "what kind of
 * machine is this?" — a question separate from "what can this GPU do?"
 * (capability probes) and from "how wide is the window right now?" (layout
 * breakpoints). Every budget that is about a device class reads the same
 * function here, so a phone cannot be a phone for one budget and a desktop
 * for the next.
 */
import { isPhoneViewport } from './dom';

let touchFirst: boolean | null = null;

/**
 * A phone or tablet: the class that gets cache-only boot speculation, the
 * smaller sector-tile working set and the residency tier cap. Capability-based
 * quality decisions are unaffected — this is only about how much a device is
 * asked to hold at once.
 *
 * A touchscreen laptop is a desktop: a coarse pointer alone says nothing about
 * memory. iPads report a desktop user agent, so they are recognised by the
 * MacIntel platform string carrying more than one touch point.
 *
 * Answered once per page: the same session must not switch device class
 * halfway through because a window was resized or a tablet rotated.
 */
export function touchFirstDevice(): boolean {
  if (touchFirst === null) {
    touchFirst =
      typeof navigator !== 'undefined' &&
      typeof window !== 'undefined' &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || // iPadOS desktop UA
        (navigator.maxTouchPoints > 0 && window.innerWidth <= 1024));
  }
  return touchFirst;
}

/** Forget the memoised verdict. Tests only — a page never changes class. */
export function resetDeviceClassForTests(): void {
  touchFirst = null;
}

/** Phone-width viewport, measured exactly as the stylesheet measures it.
 *  Re-exported here so a caller weighing device class and layout width reads
 *  both from one module; the implementation stays with the breakpoint it
 *  shares with the CSS. */
export const phoneViewport = isPhoneViewport;
