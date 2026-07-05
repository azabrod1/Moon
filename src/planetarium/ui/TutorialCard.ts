/**
 * The tutorial's narrator card (top-left on desktop, top-docked on phones).
 * Deliberate exception to the one-modal-at-a-time idiom: the tutorial stages
 * scenes through the other overlays — the deck theater opens and closes
 * underneath it — so no overlay's open() closes this card; only its own
 * buttons and the tutorial lifecycle do. The widget is DOM-thin: which
 * labels show, which action the primary carries, and when the buttons
 * enable are decided by tutorialCardModel so the mapping stays unit-testable.
 */
import { setText } from '../../shared/dom';
import type { TutorialPhase, TutorialStep } from '../tutorialLogic';

export interface TutorialCardModel {
  /** "2 / 6" — mono, tabular. */
  counter: string;
  title: string;
  body: string;
  primary: { label: string; action: 'advance' | 'return'; disabled: boolean };
  /** null hides the ghost button (the wrap card: ending always takes you back). */
  ghost: { label: string; disabled: boolean } | null;
}

/**
 * Card content for one step. The wrap card's primary restores the
 * pre-tutorial state instead of advancing, and it has no skip. Next waits
 * for the step to settle; skip stays live mid-flight (stopTutorial absorbs
 * an in-flight arrival), and only the restore actually running ('ending')
 * disables everything.
 */
export function tutorialCardModel(
  step: TutorialStep,
  index: number,
  count: number,
  phase: TutorialPhase,
  totalityReached: boolean,
): TutorialCardModel {
  const wrap = step.id === 'wrap';
  return {
    counter: `${index + 1} / ${count}`,
    title: step.title,
    body: totalityReached && step.totalityBody !== undefined ? step.totalityBody : step.body,
    primary: {
      label: step.primaryLabel,
      action: wrap ? 'return' : 'advance',
      disabled: phase !== 'ready',
    },
    ghost:
      step.ghostLabel === null
        ? null
        : { label: step.ghostLabel, disabled: phase === 'ending' },
  };
}

export class TutorialCard {
  private rootEl: HTMLElement | null = null;
  private primaryEl: HTMLButtonElement | null = null;
  private ghostEl: HTMLButtonElement | null = null;
  private model: TutorialCardModel | null = null;
  private wired = false;

  constructor(
    private onAdvance: () => void,
    private onSkip: () => void,
    private onReturn: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('tutorial-card');
    this.primaryEl = document.getElementById('tutorial-primary') as HTMLButtonElement | null;
    this.ghostEl = document.getElementById('tutorial-ghost') as HTMLButtonElement | null;
    if (this.wired) return;
    this.wired = true;
    this.primaryEl?.addEventListener('click', () => {
      if (!this.model || this.model.primary.disabled) return;
      (this.model.primary.action === 'return' ? this.onReturn : this.onAdvance)();
    });
    this.ghostEl?.addEventListener('click', () => {
      if (!this.model?.ghost || this.model.ghost.disabled) return;
      this.onSkip();
    });
  }

  /** Update content in place; visibility is show()/hide()'s job. */
  render(model: TutorialCardModel): void {
    this.model = model;
    setText('tutorial-count', model.counter);
    setText('tutorial-title', model.title);
    setText('tutorial-body', model.body);
    if (this.primaryEl) {
      this.primaryEl.textContent = model.primary.label;
      this.primaryEl.disabled = model.primary.disabled;
    }
    if (this.ghostEl) {
      this.ghostEl.style.display = model.ghost ? '' : 'none';
      if (model.ghost) {
        this.ghostEl.textContent = model.ghost.label;
        this.ghostEl.disabled = model.ghost.disabled;
      }
    }
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
