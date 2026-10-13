/**
 * The tutorial's narrator card (top-left on desktop, top-docked on phones).
 * Deliberate exception to the one-modal-at-a-time idiom: the tutorial stages
 * scenes through the other overlays — the deck opens and closes underneath
 * it, the spotlight rings controls beside it — so no overlay's open() closes
 * this card; only its own buttons and the tutorial lifecycle do. The widget
 * is DOM-thin: which labels show, which copy the body carries, which action
 * the primary holds and when the buttons enable are decided by
 * tutorialCardModel so the mapping stays unit-testable. The stop dots and
 * the kicker are the card's only state beyond the copy.
 */
import { setText } from '../../shared/dom';
import { tutorialProgress } from '../tutorialLogic';
import type { TutorialBeat, TutorialPhase, TutorialStep } from '../tutorialLogic';

export interface TutorialCardModel {
  /** The stop dots and the counter they stand in for ("Stop 2 of 4" to a screen reader). */
  progress: { count: number; current: number | null; done: number; label: string };
  title: string;
  /** Mono line for the place or the date; null hides it. */
  kicker: string | null;
  body: string;
  /** `busy` is the held state while a stop stages — the label says why Next
   *  waits. 'show-me' is the you-try beat's offer: live, and it presses the
   *  awaited control for the user. */
  primary: { label: string; action: 'advance' | 'return' | 'show-me'; disabled: boolean; busy: boolean };
  /** null hides the ghost button (the wrap card: ending always takes you back). */
  ghost: { label: string; disabled: boolean } | null;
  /** Re-stages the previous stop. null hides it on the first stop, where
   *  there is nowhere to go back to. */
  back: { label: string; disabled: boolean } | null;
}

/** The primary's label while a stop's scene is still on its way. */
export const TUTORIAL_ARRIVING_LABEL = 'Arriving…';
/** The primary's label while a you-try beat waits for the user. */
export const TUTORIAL_SHOW_ME_LABEL = 'Show me';

/** A run of body text, or one of the action-cluster button glyphs inline. */
export type TutorialBodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'icon'; icon: 'teleport' | 'observatory' };

/**
 * Split a card body on its {teleport}/{observatory} tokens. The card renders
 * icon segments as clones of the live action-button SVGs, so the glyph the
 * copy points at is exactly the glyph on screen.
 */
export function tutorialBodySegments(body: string): TutorialBodySegment[] {
  return body
    .split(/(\{teleport\}|\{observatory\})/)
    .filter((part) => part.length > 0)
    .map((part) =>
      part === '{teleport}' || part === '{observatory}'
        ? { kind: 'icon' as const, icon: part.slice(1, -1) as 'teleport' | 'observatory' }
        : { kind: 'text' as const, text: part },
    );
}

/** The body a step shows in a phase: while staging, the current beat's own
 *  copy if it has one, else the step's staging copy; the settled copy from
 *  the moment the scene is up. */
export function tutorialBodyFor(step: TutorialStep, phase: TutorialPhase, beat: TutorialBeat | null = null): string {
  if (phase !== 'staging') return step.body;
  return beat?.body ?? step.bodyDuring ?? step.body;
}

/**
 * Card content for one step. The wrap card's primary restores the
 * pre-tutorial state instead of advancing, and it has no skip. Next and Back
 * wait for the step to settle — while a scene stop is on its way the primary
 * reads "Arriving…" so the wait explains itself; skip stays live mid-flight
 * (stopTutorial absorbs an in-flight arrival), and only the restore actually
 * running ('ending') disables everything. `kicker` overrides the step's own
 * line when the host has a live one (a distance, a phase, a countdown);
 * `beat` is the current beat while staging — its copy, and on a you-try beat
 * the primary becomes a live "Show me".
 */
export function tutorialCardModel(
  step: TutorialStep,
  index: number,
  phase: TutorialPhase,
  opts: { kicker?: string | null; beat?: TutorialBeat | null } = {},
): TutorialCardModel {
  const wrap = step.id === 'wrap';
  const beat = opts.beat ?? null;
  const awaiting = phase === 'staging' && beat?.await === true;
  const busy = !awaiting && step.stage !== 'none' && (phase === 'staging' || phase === 'settling');
  return {
    progress: tutorialProgress(index),
    title: step.title,
    kicker: opts.kicker === undefined ? step.kicker : opts.kicker,
    body: tutorialBodyFor(step, phase, beat),
    primary: awaiting
      ? { label: TUTORIAL_SHOW_ME_LABEL, action: 'show-me', disabled: false, busy: false }
      : {
          label: busy ? TUTORIAL_ARRIVING_LABEL : step.primaryLabel,
          action: wrap ? 'return' : 'advance',
          disabled: phase !== 'ready',
          busy,
        },
    ghost:
      step.ghostLabel === null
        ? null
        : { label: step.ghostLabel, disabled: phase === 'ending' },
    back: index >= 1 ? { label: '‹ Back', disabled: phase !== 'ready' } : null,
  };
}

export class TutorialCard {
  private rootEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private kickerEl: HTMLElement | null = null;
  private dotsEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private primaryEl: HTMLButtonElement | null = null;
  private ghostEl: HTMLButtonElement | null = null;
  private backEl: HTMLButtonElement | null = null;
  /** The action-cluster button SVGs, cloned into the body per icon token. */
  private icons: Record<'teleport' | 'observatory', Element | null> = {
    teleport: null,
    observatory: null,
  };
  private model: TutorialCardModel | null = null;
  private wired = false;

  constructor(
    private onAdvance: () => void,
    private onBack: () => void,
    private onSkip: () => void,
    private onReturn: () => void,
    private onShowMe: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('tutorial-card');
    this.titleEl = document.getElementById('tutorial-title');
    this.kickerEl = document.getElementById('tutorial-kicker');
    this.dotsEl = document.getElementById('tutorial-dots');
    this.bodyEl = document.getElementById('tutorial-body');
    this.primaryEl = document.getElementById('tutorial-primary') as HTMLButtonElement | null;
    this.ghostEl = document.getElementById('tutorial-ghost') as HTMLButtonElement | null;
    this.backEl = document.getElementById('tutorial-back') as HTMLButtonElement | null;
    this.icons.teleport = document.querySelector('#planetarium-btn-travel svg');
    this.icons.observatory = document.querySelector('#planetarium-btn-observatory svg');
    if (this.wired) return;
    this.wired = true;
    this.primaryEl?.addEventListener('click', () => {
      if (!this.model || this.model.primary.disabled) return;
      switch (this.model.primary.action) {
        case 'return':
          this.onReturn();
          break;
        case 'show-me':
          this.onShowMe();
          break;
        case 'advance':
          this.onAdvance();
          break;
      }
    });
    this.ghostEl?.addEventListener('click', () => {
      if (!this.model?.ghost || this.model.ghost.disabled) return;
      this.onSkip();
    });
    this.backEl?.addEventListener('click', () => {
      if (!this.model?.back || this.model.back.disabled) return;
      this.onBack();
    });
  }

  /** Update content in place; visibility is show()/hide()'s job. */
  render(model: TutorialCardModel): void {
    this.model = model;
    this.renderDots(model.progress);
    setText('tutorial-count', model.progress.label);
    setText('tutorial-title', model.title);
    if (this.kickerEl) {
      this.kickerEl.textContent = model.kicker ?? '';
      this.kickerEl.style.display = model.kicker ? '' : 'none';
    }
    this.renderBody(model.body);
    if (this.primaryEl) {
      this.primaryEl.textContent = model.primary.label;
      this.primaryEl.disabled = model.primary.disabled;
      this.primaryEl.classList.toggle('busy', model.primary.busy);
    }
    if (this.ghostEl) {
      this.ghostEl.style.display = model.ghost ? '' : 'none';
      if (model.ghost) {
        this.ghostEl.textContent = model.ghost.label;
        this.ghostEl.disabled = model.ghost.disabled;
      }
    }
    if (this.backEl) {
      this.backEl.style.display = model.back ? '' : 'none';
      if (model.back) {
        this.backEl.textContent = model.back.label;
        this.backEl.disabled = model.back.disabled;
      }
    }
  }

  /** One dot per stop: done ones dimmed, the current one filled, the rest hollow. */
  private renderDots(progress: TutorialCardModel['progress']): void {
    const dots = this.dotsEl;
    if (!dots) return;
    while (dots.childElementCount > progress.count) dots.lastElementChild?.remove();
    while (dots.childElementCount < progress.count) {
      const dot = document.createElement('i');
      dot.className = 'tutorial-dot';
      dots.appendChild(dot);
    }
    Array.from(dots.children).forEach((dot, i) => {
      const number = i + 1;
      dot.classList.toggle('done', number <= progress.done);
      dot.classList.toggle('current', number === progress.current);
    });
  }

  /** Body text with each icon token replaced by a clone of the real button SVG
   *  (a missing source just drops the glyph — the button name beside it still
   *  carries the meaning). The clone is decoration: the real control is the
   *  one under the spotlight, so it carries no button styling and is hidden
   *  from assistive tech. */
  private renderBody(body: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.textContent = '';
    for (const seg of tutorialBodySegments(body)) {
      if (seg.kind === 'text') {
        this.bodyEl.appendChild(document.createTextNode(seg.text));
        continue;
      }
      const src = this.icons[seg.icon];
      if (!src) continue;
      const svg = src.cloneNode(true) as Element;
      svg.setAttribute('class', 'tutorial-inline-icon');
      svg.setAttribute('aria-hidden', 'true');
      this.bodyEl.appendChild(svg);
    }
  }

  /** Move focus to the title: a new stop announces itself and Tab lands on
   *  its buttons next. Programmatic, so pointer users see no focus ring. */
  focusTitle(): void {
    this.titleEl?.focus({ preventScroll: true });
  }

  /** The card's own rectangle, for the spotlight to keep its bubble off. */
  rect(): DOMRect | null {
    return this.rootEl?.getBoundingClientRect() ?? null;
  }

  show(): void {
    this.rootEl?.classList.add('visible');
  }

  hide(): void {
    this.rootEl?.classList.remove('visible');
    this.model = null;
  }

  isOpen(): boolean {
    return this.rootEl?.classList.contains('visible') ?? false;
  }
}
