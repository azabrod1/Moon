/**
 * The spot picker's controls: where to stand on the landed body. The landed
 * globe stays the picture and takes the taps (the controller turns a tap
 * into a latitude and longitude through the lens and the body's drawn
 * orientation); this class owns only what is drawn over it: Cancel and the
 * title, the pin, and the card that names the spot, says what the sky is
 * doing there, and offers Stand here and the places list.
 *
 * The root takes no pointer events, so a drag anywhere off its controls
 * still turns the globe. ObservatoryHUD's idiom: bind() once, render() for
 * the text, setPin() each frame with the screen position the controller
 * projected after the camera's final pose. The buttons act on a plain
 * click: the places list raises a full-screen backdrop, and acting on
 * pointerup would let the tap's own click land on that backdrop and close
 * the list again.
 */
import { setText } from '../../shared/dom';

export interface SitePickerState {
  /** "Tap the Moon. Drag to turn it." */
  hint: string;
  /** "Your spot", or a named place's name. */
  eyebrow: string;
  /** "2.0° S, 80.0° W", or the invitation while nothing is picked. */
  coords: string;
  /** "Daytime · Earth 4° above the horizon"; empty while nothing is picked. */
  sub: string;
  /** A spot is picked: Stand here is live. */
  canStand: boolean;
}

export class SitePicker {
  private rootEl: HTMLElement | null = null;
  private pinEl: HTMLElement | null = null;
  private goEl: HTMLButtonElement | null = null;
  private lastPinCss = '';
  private wired = false;

  constructor(
    private onCancel: () => void,
    private onPlaces: () => void,
    private onStand: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('site-picker');
    this.pinEl = document.getElementById('site-picker-pin');
    this.goEl = document.getElementById('site-picker-go') as HTMLButtonElement | null;
    if (this.wired) return;
    this.wired = true;
    document.getElementById('site-picker-cancel')?.addEventListener('click', () => this.onCancel());
    document.getElementById('site-picker-places')?.addEventListener('click', () => this.onPlaces());
    this.goEl?.addEventListener('click', () => this.onStand());
  }

  show(): void {
    this.rootEl?.classList.add('visible');
    document.body.classList.add('site-picker-active');
  }

  hide(): void {
    this.rootEl?.classList.remove('visible');
    document.body.classList.remove('site-picker-active');
    this.setPin(null, 0);
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }

  render(state: SitePickerState): void {
    setText('site-picker-hint', state.hint);
    setText('site-picker-eyebrow', state.eyebrow);
    setText('site-picker-coords', state.coords);
    setText('site-picker-sub', state.sub);
    if (this.goEl) this.goEl.disabled = !state.canStand;
  }

  /** The pin at a displayed pixel (CSS px in the canvas), or hidden when
   *  `xPx` is null: nothing picked, or the spot is round the limb. */
  setPin(xPx: number | null, yPx: number): void {
    const pin = this.pinEl;
    if (!pin) return;
    const css = xPx === null ? '' : `translate(${xPx.toFixed(1)}px, ${yPx.toFixed(1)}px)`;
    if (css === this.lastPinCss) return;
    this.lastPinCss = css;
    pin.classList.toggle('visible', css !== '');
    if (css) pin.style.transform = css;
  }
}
