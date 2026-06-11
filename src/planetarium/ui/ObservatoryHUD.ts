/**
 * Surface-view HUD for the Observatory (Option D, reference d-s3.png):
 * bottom-left narrative stack (eyebrow / headline / subline with the warm
 * peak countdown / mono when-line), bottom-right FOV cluster with a
 * log-scale hairline, breathing corner brackets over the tracked target with
 * the mono disc annotation and tracking pill, and the top-right
 * Observatory/swap/exit chips. FlightHUD/SunLabel idiom: bind() once,
 * per-frame updateBrackets() with screen coords from the owner, 8 Hz
 * render() that touches text nodes only.
 */
import { setText } from '../../shared/dom';
import { SURFACE_FOV_MAX_DEG, SURFACE_FOV_MIN_DEG } from '../surfaceView';

export interface SurfaceHudState {
  /** "Surface view · standing on Earth" */
  eyebrow: string;
  /** Event name while one is in window, else the phase name. */
  headline: string;
  /** Narrative subline; `warm` renders highlighted ("peak in 11m"). */
  subText: string;
  subWarm: string | null;
  /** Mono when-line + its tag ('paused' / 'realtime' / rate). */
  whenText: string;
  whenTag: string;
  fovDeg: number;
  tracking: boolean;
  /** Display name of the tracked target ("the Sun", "Io"). */
  targetName: string;
  /** Mono disc annotation under the brackets; null hides it. */
  discNote: string | null;
  /** Swap chip label ("Stand on the Moon"), or null to hide. */
  swapLabel: string | null;
}

export class ObservatoryHUD {
  private rootEl: HTMLElement | null = null;
  private bracketsEl: HTMLElement | null = null;
  private discNoteEl: HTMLElement | null = null;
  private trackPillEl: HTMLElement | null = null;
  private swapEl: HTMLElement | null = null;
  private fovMarkEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private lastBracketCss = '';
  private lastAnchorCss = '';
  private wired = false;

  constructor(
    private onExit: () => void,
    private onSwap: () => void,
    private onResumeTracking: () => void,
    private onObservatory: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('surface-hud');
    this.bracketsEl = document.getElementById('surface-brackets');
    this.discNoteEl = document.getElementById('surface-discnote');
    this.trackPillEl = document.getElementById('surface-trackpill');
    this.swapEl = document.getElementById('surface-swap');
    this.fovMarkEl = document.getElementById('surface-fov-mark');
    this.subEl = document.getElementById('surface-sub');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('surface-exit')?.addEventListener('click', () => this.onExit());
    document.getElementById('surface-observatory')?.addEventListener('click', () => this.onObservatory());
    this.swapEl?.addEventListener('click', () => this.onSwap());
    this.trackPillEl?.addEventListener('click', () => this.onResumeTracking());
  }

  show(): void {
    this.rootEl?.classList.add('visible');
  }

  hide(): void {
    this.rootEl?.classList.remove('visible');
    this.lastBracketCss = '';
    this.lastAnchorCss = '';
  }

  /**
   * Per-frame: place the breathing brackets (and the disc note + tracking
   * pill anchored under them) around the tracked target's screen position.
   * `visible: false` (target behind the camera) hides the cluster.
   */
  updateBrackets(visible: boolean, xPx: number, yPx: number, sizePx: number): void {
    if (!this.bracketsEl || !this.discNoteEl || !this.trackPillEl) return;
    if (!visible) {
      if (this.lastBracketCss !== 'hidden') {
        this.bracketsEl.style.display = 'none';
        this.discNoteEl.style.display = 'none';
        this.trackPillEl.style.display = 'none';
        this.lastBracketCss = 'hidden';
        this.lastAnchorCss = '';
      }
      return;
    }
    const size = Math.round(sizePx);
    const left = Math.round(xPx - size / 2);
    const top = Math.round(yPx - size / 2);
    const bracketCss = `${left}|${top}|${size}`;
    if (bracketCss !== this.lastBracketCss) {
      this.bracketsEl.style.display = '';
      this.bracketsEl.style.left = `${left}px`;
      this.bracketsEl.style.top = `${top}px`;
      this.bracketsEl.style.width = `${size}px`;
      this.bracketsEl.style.height = `${size}px`;
      this.lastBracketCss = bracketCss;
    }
    const anchorCss = `${Math.round(xPx)}|${top + size}`;
    if (anchorCss !== this.lastAnchorCss) {
      this.discNoteEl.style.display = '';
      this.discNoteEl.style.left = `${Math.round(xPx)}px`;
      this.discNoteEl.style.top = `${top + size + 12}px`;
      this.trackPillEl.style.display = '';
      this.trackPillEl.style.left = `${Math.round(xPx)}px`;
      this.trackPillEl.style.top = `${top + size + 32}px`;
      this.lastAnchorCss = anchorCss;
    }
  }

  /** 8 Hz text pass — no layout writes besides the FOV mark position. */
  render(state: SurfaceHudState): void {
    setText('surface-eyebrow', state.eyebrow);
    setText('surface-headline', state.headline);
    if (this.subEl) {
      // Two text nodes (plain + warm) — rebuilt only when the strings change.
      const key = `${state.subText}|${state.subWarm ?? ''}`;
      if (this.subEl.dataset.key !== key) {
        this.subEl.dataset.key = key;
        this.subEl.textContent = '';
        this.subEl.append(state.subText);
        if (state.subWarm) {
          const warmEl = document.createElement('b');
          warmEl.textContent = state.subWarm;
          this.subEl.append(' · ', warmEl);
        }
      }
    }
    setText('surface-when', state.whenText);
    setText('surface-when-tag', state.whenTag);
    setText(
      'surface-fov',
      `${state.fovDeg >= 10 ? Math.round(state.fovDeg) : state.fovDeg.toFixed(1)}°`,
    );
    if (this.fovMarkEl) {
      const t =
        Math.log(state.fovDeg / SURFACE_FOV_MIN_DEG) /
        Math.log(SURFACE_FOV_MAX_DEG / SURFACE_FOV_MIN_DEG);
      this.fovMarkEl.style.left = `${(Math.min(1, Math.max(0, t)) * 100).toFixed(1)}%`;
    }
    setText(
      'surface-trackpill-text',
      state.tracking
        ? `Tracking ${state.targetName} · drag to look around`
        : 'Free look · resume tracking',
    );
    if (this.discNoteEl) {
      const note = state.discNote ?? '';
      if (this.discNoteEl.textContent !== note) this.discNoteEl.textContent = note;
      this.discNoteEl.style.visibility = note ? '' : 'hidden';
    }
    if (this.swapEl) {
      this.swapEl.style.display = state.swapLabel ? '' : 'none';
      if (state.swapLabel) setText('surface-swap-name', state.swapLabel);
    }
  }
}
