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
  /** Re-stages the previous stop. null hides it: on the welcome card there is
   *  nowhere to go, and on Saturn the previous card stages no scene — Back
   *  there would strand the welcome copy over the Saturn parking spot. */
  back: { label: string; disabled: boolean } | null;
}

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

/**
 * Card content for one step. The wrap card's primary restores the
 * pre-tutorial state instead of advancing, and it has no skip. Next and Back
 * wait for the step to settle; skip stays live mid-flight (stopTutorial
 * absorbs an in-flight arrival), and only the restore actually running
 * ('ending') disables everything.
 */
export function tutorialCardModel(
  step: TutorialStep,
  index: number,
  count: number,
  phase: TutorialPhase,
): TutorialCardModel {
  const wrap = step.id === 'wrap';
  return {
    counter: `${index + 1} / ${count}`,
    title: step.title,
    body: step.body,
    primary: {
      label: step.primaryLabel,
      action: wrap ? 'return' : 'advance',
      disabled: phase !== 'ready',
    },
    ghost:
      step.ghostLabel === null
        ? null
        : { label: step.ghostLabel, disabled: phase === 'ending' },
    back: index >= 2 ? { label: '‹ Back', disabled: phase !== 'ready' } : null,
  };
}

export class TutorialCard {
  private rootEl: HTMLElement | null = null;
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
  ) {}

  bind(): void {
    this.rootEl = document.getElementById('tutorial-card');
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
      (this.model.primary.action === 'return' ? this.onReturn : this.onAdvance)();
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
    setText('tutorial-count', model.counter);
    setText('tutorial-title', model.title);
    this.renderBody(model.body);
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
    if (this.backEl) {
      this.backEl.style.display = model.back ? '' : 'none';
      if (model.back) {
        this.backEl.textContent = model.back.label;
        this.backEl.disabled = model.back.disabled;
      }
    }
  }

  /** Body text with each icon token replaced by a clone of the real button SVG
   *  (a missing source just drops the glyph — the button name beside it still
   *  carries the meaning). */
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
      this.bodyEl.appendChild(svg);
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
