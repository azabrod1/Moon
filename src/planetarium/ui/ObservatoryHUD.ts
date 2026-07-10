/**
 * Surface-view HUD for the Observatory:
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
  /** Look-at chip visibility — hidden when the sky offers only one target. */
  showLookatChip: boolean;
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
export type SurfaceMarkerMode = 'hidden' | 'brackets' | 'reticle' | 'chevron' | 'pill';

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
  private lookatEl: HTMLElement | null = null;
  private fovMarkEl: HTMLElement | null = null;
  private subEl: HTMLElement | null = null;
  private blEl: HTMLElement | null = null;
  private brEl: HTMLElement | null = null;
  private timebarEl: HTMLElement | null = null;
  // Lowest anchor Y the marker cluster may take (see render's band measure).
  private clusterMaxY = Infinity;
  private lastMarkerCss = '';
  private wired = false;

  constructor(
    private onExit: () => void,
    private onSwap: () => void,
    private onResumeTracking: () => void,
    private onObservatory: () => void,
    private onTargetMenu: () => void,
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
    this.lookatEl = document.getElementById('surface-lookat');
    this.fovMarkEl = document.getElementById('surface-fov-mark');
    this.subEl = document.getElementById('surface-sub');
    this.blEl = this.rootEl?.querySelector('.shud-bl') ?? null;
    this.brEl = this.rootEl?.querySelector('.shud-br') ?? null;
    this.timebarEl = document.getElementById('surface-timebar');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('surface-exit')?.addEventListener('click', () => this.onExit());
    document.getElementById('surface-observatory')?.addEventListener('click', () => this.onObservatory());
    this.lookatEl?.addEventListener('click', () => this.onTargetMenu());
    this.swapEl?.addEventListener('click', () => this.onSwap());
    this.trackPillEl?.addEventListener('click', () => this.onResumeTracking());
    // The chevron is the way back when the target left the frame in free look.
    this.chevronEl?.addEventListener('click', () => this.onResumeTracking());
    // Transport strip — the surface view's only time controls.
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
  updateMarker(placement: SurfaceMarkerPlacement): void {
    if (!this.bracketsEl || !this.reticleEl || !this.chevronEl || !this.discNoteEl || !this.trackPillEl) return;
    // Fractional coords, positioned via transform (left/top pixel-snap at
    // paint): a slow sky crawl must render sub-pixel-smooth, not twitch.
    // The dedup key quantizes to 0.1 px so steady frames still skip writes.
    // The band-clamp Y joins the key (rounded, so it can't jitter it): the
    // three anchored modes clamp the cluster against clusterMaxY, which
    // render() re-measures at 8 Hz. When the sheet slides under a still target
    // the band moves but mode/x/y/size don't, so without this the cluster
    // would keep its stale clamp and settle onto the panel bands.
    const x = placement.xPx ?? 0;
    const y = placement.yPx ?? 0;
    const size = placement.sizePx ?? 0;
    const angle = placement.angleDeg ?? 0;
    const clamp = Math.round(this.clusterMaxY);
    const css = `${placement.mode}|${x.toFixed(1)}|${y.toFixed(1)}|${size.toFixed(1)}|${angle.toFixed(1)}|${clamp}`;
    if (css === this.lastMarkerCss) return;
    this.lastMarkerCss = css;

    this.bracketsEl.style.display = placement.mode === 'brackets' ? '' : 'none';
    this.reticleEl.style.display = placement.mode === 'reticle' ? '' : 'none';
    this.chevronEl.style.display = placement.mode === 'chevron' ? '' : 'none';
    const anchored =
      placement.mode === 'brackets' || placement.mode === 'reticle' || placement.mode === 'pill';
    this.discNoteEl.style.display = anchored ? '' : 'none';
    this.trackPillEl.style.display = anchored ? '' : 'none';

    if (placement.mode === 'brackets') {
      const top = y - size / 2;
      this.bracketsEl.style.transform = `translate(${x - size / 2}px, ${top}px)`;
      this.bracketsEl.style.width = `${size}px`;
      this.bracketsEl.style.height = `${size}px`;
      this.anchorCluster(x, top + size);
    } else if (placement.mode === 'pill') {
      // Disc dominates the frame: no locator box, just the cluster under the
      // limb (size here is the TRUE disc height; the band clamp pulls the
      // cluster on-screen when the limb runs below the fold).
      this.anchorCluster(x, y + size / 2);
    } else if (placement.mode === 'reticle') {
      this.reticleEl.style.transform = `translate(${x - 6}px, ${y - 6}px)`;
      this.anchorCluster(x, y + 8);
    } else if (placement.mode === 'chevron') {
      // The ‹ glyph points −x at rotation 0; flip it onto the target bearing.
      this.chevronEl.style.transform = `translate(${x - 15}px, ${y - 15}px) rotate(${angle + 180}deg)`;
    }
  }

  private anchorCluster(xPx: number, belowYPx: number): void {
    if (!this.discNoteEl || !this.trackPillEl) return;
    // At wide FOV the bracket bottom dives into the HUD's bottom band —
    // headline stack, FOV cluster, transport strip — and on a phone the
    // centered cluster shares their horizontal space. Cap the anchor at the
    // band's measured top; the cluster then floats inside the (empty)
    // bracket interior instead of over text.
    const y = Math.min(belowYPx, this.clusterMaxY);
    // translateX(-50%) re-applies the CSS centering the inline transform overrides.
    this.discNoteEl.style.transform = `translate(${xPx}px, ${y + 12}px) translateX(-50%)`;
    this.trackPillEl.style.transform = `translate(${xPx}px, ${y + 32}px) translateX(-50%)`;
  }

  /** 8 Hz text pass — no layout writes besides the FOV mark position. */
  render(state: SurfaceHudState): void {
    // Re-measure the bottom band's top edge here (8 Hz), not per marker
    // frame: the band moves only with content/viewport changes. 62 = the
    // cluster's extent below its anchor (note at +12, pill at +32, ~26px
    // pill height) plus a hairline of clearance.
    const top = (el: HTMLElement | null) =>
      el ? el.getBoundingClientRect().top : Infinity;
    this.clusterMaxY =
      Math.min(top(this.blEl), top(this.brEl), top(this.timebarEl)) - 62;
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
      const normalizedFov =
        Math.log(state.fovDeg / SURFACE_FOV_MIN_DEG) /
        Math.log(SURFACE_FOV_MAX_DEG / SURFACE_FOV_MIN_DEG);
      this.fovMarkEl.style.left = `${(Math.min(1, Math.max(0, normalizedFov)) * 100).toFixed(1)}%`;
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
    if (this.lookatEl) {
      this.lookatEl.style.display = state.showLookatChip ? '' : 'none';
      if (state.showLookatChip) setText('surface-lookat-name', state.targetName);
    }
  }
}
