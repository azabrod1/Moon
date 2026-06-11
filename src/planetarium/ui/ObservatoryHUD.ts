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
  /** Clock paused — the transport strip's pause button flips to "Resume". */
  paused: boolean;
}

/** Transport-strip actions, routed to the owner's shared time handlers. */
export type SurfaceTimeAction = 'toggle-pause' | 'slower' | 'faster' | 'now';

/** Which marker the HUD draws over the tracked target this frame. */
export type SurfaceMarkerMode = 'hidden' | 'brackets' | 'reticle' | 'chevron';

export interface SurfaceMarkerPlacement {
  mode: SurfaceMarkerMode;
  xPx?: number;
  yPx?: number;
  /** Bracket box size — brackets mode only. */
  sizePx?: number;
  /** Screen-space direction toward the off-frame target — chevron mode only. */
  angleDeg?: number;
}

export class ObservatoryHUD {
  private rootEl: HTMLElement | null = null;
  private bracketsEl: HTMLElement | null = null;
  private reticleEl: HTMLElement | null = null;
  private chevronEl: HTMLElement | null = null;
  private discNoteEl: HTMLElement | null = null;
  private trackPillEl: HTMLElement | null = null;
  private swapEl: HTMLElement | null = null;
  private fovMarkEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private lastMarkerCss = '';
  private wired = false;

  constructor(
    private onExit: () => void,
    private onSwap: () => void,
    private onResumeTracking: () => void,
    private onObservatory: () => void,
    private onTimeAction: (action: SurfaceTimeAction) => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('surface-hud');
    this.bracketsEl = document.getElementById('surface-brackets');
    this.reticleEl = document.getElementById('surface-reticle');
    this.chevronEl = document.getElementById('surface-chevron');
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
    // The chevron is the way back when the target left the frame in free look.
    this.chevronEl?.addEventListener('click', () => this.onResumeTracking());
    // Transport strip — the surface view's only time controls (policy 1).
    document.getElementById('surface-tb-pause')?.addEventListener('click', () => this.onTimeAction('toggle-pause'));
    document.getElementById('surface-tb-slower')?.addEventListener('click', () => this.onTimeAction('slower'));
    document.getElementById('surface-tb-faster')?.addEventListener('click', () => this.onTimeAction('faster'));
    document.getElementById('surface-tb-now')?.addEventListener('click', () => this.onTimeAction('now'));
  }

  show(): void {
    this.rootEl?.classList.add('visible');
  }

  hide(): void {
    this.rootEl?.classList.remove('visible');
    this.lastMarkerCss = '';
  }

  /**
   * Per-frame marker placement. Brackets (resolvable disc) and the
   * sub-resolution reticle anchor the disc note + tracking pill beneath
   * them; the off-frame chevron hugs the screen edge pointing toward the
   * target and replaces the anchored cluster entirely.
   */
  updateMarker(p: SurfaceMarkerPlacement): void {
    if (!this.bracketsEl || !this.reticleEl || !this.chevronEl || !this.discNoteEl || !this.trackPillEl) return;
    const x = Math.round(p.xPx ?? 0);
    const y = Math.round(p.yPx ?? 0);
    const size = Math.round(p.sizePx ?? 0);
    const angle = Math.round(p.angleDeg ?? 0);
    const css = `${p.mode}|${x}|${y}|${size}|${angle}`;
    if (css === this.lastMarkerCss) return;
    this.lastMarkerCss = css;

    this.bracketsEl.style.display = p.mode === 'brackets' ? '' : 'none';
    this.reticleEl.style.display = p.mode === 'reticle' ? '' : 'none';
    this.chevronEl.style.display = p.mode === 'chevron' ? '' : 'none';
    const anchored = p.mode === 'brackets' || p.mode === 'reticle';
    this.discNoteEl.style.display = anchored ? '' : 'none';
    this.trackPillEl.style.display = anchored ? '' : 'none';

    if (p.mode === 'brackets') {
      const left = x - size / 2;
      const top = y - size / 2;
      this.bracketsEl.style.left = `${left}px`;
      this.bracketsEl.style.top = `${top}px`;
      this.bracketsEl.style.width = `${size}px`;
      this.bracketsEl.style.height = `${size}px`;
      this.anchorCluster(x, top + size);
    } else if (p.mode === 'reticle') {
      this.reticleEl.style.left = `${x - 6}px`;
      this.reticleEl.style.top = `${y - 6}px`;
      this.anchorCluster(x, y + 8);
    } else if (p.mode === 'chevron') {
      this.chevronEl.style.left = `${x - 15}px`;
      this.chevronEl.style.top = `${y - 15}px`;
      // The ‹ glyph points −x at rotation 0; flip it onto the target bearing.
      this.chevronEl.style.transform = `rotate(${angle + 180}deg)`;
    }
  }

  private anchorCluster(xPx: number, belowYPx: number): void {
    if (!this.discNoteEl || !this.trackPillEl) return;
    this.discNoteEl.style.left = `${xPx}px`;
    this.discNoteEl.style.top = `${belowYPx + 12}px`;
    this.trackPillEl.style.left = `${xPx}px`;
    this.trackPillEl.style.top = `${belowYPx + 32}px`;
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
    setText('surface-tb-pause', state.paused ? 'Resume' : 'Pause');
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
