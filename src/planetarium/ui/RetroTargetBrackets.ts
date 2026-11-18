/**
 * The Retro look's target brackets: four green corners around the most
 * prominent body on screen, with its name in the small instrument font, as a
 * 1990s space game framed what it had in its sights.
 *
 * The body and its disc on screen come from PlanetLabels.prominentSphere (the
 * lens-correct `projectSphereToScreen`, so the corners hug the drawn limb).
 * The box is placed on the picture's own grid — whole big pixels, `--px`
 * (app/retroScreen.ts), counted from the canvas's top-left like the grid —
 * and its strokes are one big pixel thick, so the corners look drawn into
 * the picture rather than laid over it. Shown only in the Retro look; the
 * layer sits with the world labels, under the interface's panels.
 */

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Big pixels between the disc and the corners, and the length of an arm. */
export const BRACKET_MARGIN_BIG_PIXELS = 2;
export const BRACKET_ARM_BIG_PIXELS = 6;

/**
 * The corners' box in CSS px: the disc's box grown by the margin, snapped
 * outwards to the big-pixel grid and kept inside the viewport. Null where too
 * little of it would show to read as a frame.
 */
export function bracketBox(disc: ScreenBox, bigPixel: number, viewportWidth: number, viewportHeight: number): ScreenBox | null {
  if (!(bigPixel > 0)) return null;
  const margin = BRACKET_MARGIN_BIG_PIXELS * bigPixel;
  const snapDown = (value: number) => Math.floor(value / bigPixel) * bigPixel;
  const snapUp = (value: number) => Math.ceil(value / bigPixel) * bigPixel;
  const box = {
    left: Math.max(0, snapDown(disc.left - margin)),
    top: Math.max(0, snapDown(disc.top - margin)),
    right: Math.min(snapDown(viewportWidth), snapUp(disc.right + margin)),
    bottom: Math.min(snapDown(viewportHeight), snapUp(disc.bottom + margin)),
  };
  const minimum = 2 * BRACKET_ARM_BIG_PIXELS * bigPixel;
  if (box.right - box.left < minimum || box.bottom - box.top < minimum) return null;
  return box;
}

export class RetroTargetBrackets {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private shownKey = '';

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.id = 'retro-target';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const arm = document.createElement('i');
      arm.className = `retro-target-${corner}`;
      this.el.appendChild(arm);
    }
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'retro-target-name';
    this.el.appendChild(this.nameEl);
    parent.appendChild(this.el);
  }

  /** Frame `name`'s disc, or hide with a null box. Writes the DOM only on a change. */
  show(name: string, disc: ScreenBox | null, bigPixel: number, viewportWidth: number, viewportHeight: number): void {
    const box = disc ? bracketBox(disc, bigPixel, viewportWidth, viewportHeight) : null;
    if (!box) {
      this.hide();
      return;
    }
    const key = `${name}|${box.left}|${box.top}|${box.right}|${box.bottom}|${bigPixel}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.el.style.left = `${box.left}px`;
    this.el.style.top = `${box.top}px`;
    this.el.style.width = `${box.right - box.left}px`;
    this.el.style.height = `${box.bottom - box.top}px`;
    this.nameEl.textContent = name.toUpperCase();
    this.el.hidden = false;
  }

  hide(): void {
    if (this.shownKey === '' && this.el.hidden) return;
    this.shownKey = '';
    this.el.hidden = true;
  }
}
