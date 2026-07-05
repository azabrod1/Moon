/**
 * The guided tour's narrator card (top-left on desktop, top-docked on
 * phones). Deliberate exception to the one-modal-at-a-time idiom: the tour
 * stages scenes through the other overlays — the deck theater opens and
 * closes underneath it — so no overlay's open() closes this card; only its
 * own buttons and the tour lifecycle do. The widget is DOM-thin: which
 * labels show, which action each button carries, and when the primary
 * enables are decided by tourCardModel so the mapping stays unit-testable.
 */
import { setText } from '../../shared/dom';
import type { TourPhase, TourStep } from '../tourLogic';

export interface TourCardModel {
  /** "2 / 6" — mono, tabular. */
  counter: string;
  title: string;
  body: string;
  /** Dimmer second paragraph; '' renders nothing. */
  caption: string;
  primary: { label: string; action: 'advance' | 'return'; disabled: boolean };
  ghost: { label: string; action: 'skip' | 'stay'; disabled: boolean };
}

/**
 * Card content for one step. The wrap card repurposes the buttons — primary
 * restores the pre-tour state, ghost keeps the staged scene — everywhere
 * else primary advances and ghost skips. Next waits for the step to settle;
 * skip stays live mid-flight (stopTour absorbs an in-flight arrival), and
 * only the restore actually running ('ending') disables both.
 */
export function tourCardModel(
  step: TourStep,
  index: number,
  count: number,
  phase: TourPhase,
  totalityReached: boolean,
): TourCardModel {
  const wrap = step.id === 'wrap';
  return {
    counter: `${index + 1} / ${count}`,
    title: step.title,
    body: totalityReached && step.totalityBody !== undefined ? step.totalityBody : step.body,
    caption: step.caption ?? '',
    primary: {
      label: step.primaryLabel,
      action: wrap ? 'return' : 'advance',
      disabled: phase !== 'ready',
    },
    ghost: {
      label: step.ghostLabel,
      action: wrap ? 'stay' : 'skip',
      disabled: phase === 'ending',
    },
  };
}

export class TourCard {
  private rootEl: HTMLElement | null = null;
  private primaryEl: HTMLButtonElement | null = null;
  private ghostEl: HTMLButtonElement | null = null;
  private model: TourCardModel | null = null;
  private wired = false;

  constructor(
    private onAdvance: () => void,
    private onSkip: () => void,
    private onStay: () => void,
    private onReturn: () => void,
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('tour-card');
    this.primaryEl = document.getElementById('tour-primary') as HTMLButtonElement | null;
    this.ghostEl = document.getElementById('tour-ghost') as HTMLButtonElement | null;
    if (this.wired) return;
    this.wired = true;
    this.primaryEl?.addEventListener('click', () => {
      if (!this.model || this.model.primary.disabled) return;
      (this.model.primary.action === 'return' ? this.onReturn : this.onAdvance)();
    });
    this.ghostEl?.addEventListener('click', () => {
      if (!this.model || this.model.ghost.disabled) return;
      (this.model.ghost.action === 'stay' ? this.onStay : this.onSkip)();
    });
  }

  /** Update content in place; visibility is show()/hide()'s job. */
  render(model: TourCardModel): void {
    this.model = model;
    setText('tour-count', model.counter);
    setText('tour-title', model.title);
    setText('tour-body', model.body);
    setText('tour-caption', model.caption);
    if (this.primaryEl) {
      this.primaryEl.textContent = model.primary.label;
      this.primaryEl.disabled = model.primary.disabled;
    }
    if (this.ghostEl) {
      this.ghostEl.textContent = model.ghost.label;
      this.ghostEl.disabled = model.ghost.disabled;
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
