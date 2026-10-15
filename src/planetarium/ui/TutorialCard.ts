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
import type {
  BeatRunState,
  TutorialBeat,
  TutorialChip,
  TutorialChipId,
  TutorialPhase,
  TutorialStep,
} from '../tutorialLogic';

export interface TutorialCardModel {
  /** The stop dots and the counter they stand in for ("Stop 2 of 4" to a screen reader). */
  progress: { count: number; current: number | null; done: number; label: string };
  title: string;
  /** Mono line for the place or the date; null hides it. */
  kicker: string | null;
  body: string;
  /** 'advance' is the step's own Next, held until the stop is ready; 'proceed'
   *  is a waiting beat's "Show me", which presses its control for the user,
   *  dimmed through the tap guard and live from the wait. */
  primary: { label: string; action: 'advance' | 'return' | 'proceed'; disabled: boolean };
  /** null hides the ghost button (the wrap card: ending always takes you back). */
  ghost: { label: string; disabled: boolean } | null;
  /** Re-stages the previous stop. null hides it on the first stop, where
   *  there is nowhere to go back to. */
  back: { label: string; disabled: boolean } | null;
  /** The wrap's chips, live only once the card is ready; empty elsewhere. */
  chips: readonly TutorialChip[];
}

/** The primary's label while a beat waits for the user's own press. */
export const TUTORIAL_SHOW_ME_LABEL = 'Show me';

/** The action-cluster buttons a card body can quote by their glyph. */
export type TutorialIcon = 'teleport' | 'observatory' | 'tools';

/** A run of body text, or one of the action-cluster button glyphs inline with
 *  `word`, the word after its token (the button's name, with its leading
 *  space and any punctuation), which the card keeps on the glyph's line. */
export type TutorialBodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'icon'; icon: TutorialIcon; word: string };

/**
 * Split a card body on its {teleport}/{observatory}/{tools} tokens. The card
 * renders icon segments as clones of the live action-button SVGs, so the
 * glyph the copy points at is exactly the glyph on screen. Each glyph takes
 * the word after it along: Chromium breaks after an inline SVG even before a
 * no-break space, so only a nowrap run keeps a line from ending on the glyph
 * with its name on the next.
 */
export function tutorialBodySegments(body: string): TutorialBodySegment[] {
  const segments: TutorialBodySegment[] = [];
  const parts = body.split(/(\{teleport\}|\{observatory\}|\{tools\})/);
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (part === '{teleport}' || part === '{observatory}' || part === '{tools}') {
      const [, word, rest] = /^(\s*\S*)([\s\S]*)$/.exec(parts[partIndex + 1] ?? '') ?? ['', '', ''];
      segments.push({ kind: 'icon', icon: part.slice(1, -1) as TutorialIcon, word });
      if (rest.length > 0) segments.push({ kind: 'text', text: rest });
      partIndex++;
    } else if (part.length > 0) {
      segments.push({ kind: 'text', text: part });
    }
  }
  return segments;
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
 * pre-tutorial state instead of advancing, and it has no skip. Next waits
 * for the step to settle: held, it keeps its own label, dimmed, and lights
 * up in place when the stop is done. The copy and the spotlight say what is
 * playing; a status in the button ("Arriving…") was wrong for most of a
 * stop (the panel and Look up play after the landing) and changed the
 * button's width as it cleared. Back is live from a stop's first frame, and
 * skip stays live mid-flight (stopTutorial absorbs an in-flight arrival);
 * only the restore actually running ('ending') disables everything.
 * `kicker` overrides the step's own line when the host has a live one (a
 * distance, a phase, a countdown); `beat` is the current beat while staging
 * — its copy, and while it waits (`beatStage` before the press or the
 * perform) the primary is "Show me", dimmed through the tap guard and live
 * from the wait; `totality` swaps in the eclipse's climax card.
 */
export function tutorialCardModel(
  step: TutorialStep,
  index: number,
  phase: TutorialPhase,
  opts: {
    kicker?: string | null;
    beat?: TutorialBeat | null;
    beatStage?: BeatRunState['stage'] | null;
    totality?: boolean;
  } = {},
): TutorialCardModel {
  const wrap = step.id === 'wrap';
  const beat = opts.beat ?? null;
  const climax = opts.totality === true && step.totality ? step.totality : null;
  const stage = opts.beatStage ?? 'await';
  const waiting =
    phase === 'staging' && beat?.await === true && (stage === 'enter' || stage === 'hold' || stage === 'await');
  return {
    progress: tutorialProgress(index),
    title: climax?.title ?? step.title,
    kicker: opts.kicker === undefined ? (climax?.kicker ?? step.kicker) : opts.kicker,
    body: climax?.body ?? tutorialBodyFor(step, phase, beat),
    primary: waiting
      ? { label: TUTORIAL_SHOW_ME_LABEL, action: 'proceed', disabled: stage !== 'await' }
      : { label: step.primaryLabel, action: wrap ? 'return' : 'advance', disabled: phase !== 'ready' },
    ghost:
      step.ghostLabel === null
        ? null
        : { label: step.ghostLabel, disabled: phase === 'ending' },
    back: index >= 1 ? { label: '‹ Back', disabled: phase === 'ending' } : null,
    chips: phase === 'ready' ? (step.chips ?? []) : [],
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
  private chipsEl: HTMLElement | null = null;
  /** The action-cluster button SVGs, cloned into the body per icon token. */
  private icons: Record<TutorialIcon, Element | null> = {
    teleport: null,
    observatory: null,
    tools: null,
  };
  private model: TutorialCardModel | null = null;
  private wired = false;

  constructor(
    private onAdvance: () => void,
    private onBack: () => void,
    private onSkip: () => void,
    private onReturn: () => void,
    private onProceed: () => void,
    private onChip: (id: TutorialChipId) => void,
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
    this.chipsEl = document.getElementById('tutorial-chips');
    this.icons.teleport = document.querySelector('#planetarium-btn-travel svg');
    this.icons.observatory = document.querySelector('#planetarium-btn-observatory svg');
    this.icons.tools = document.querySelector('#planetarium-btn-tools svg');
    if (this.wired) return;
    this.wired = true;
    this.primaryEl?.addEventListener('click', () => {
      if (!this.model || this.model.primary.disabled) return;
      switch (this.model.primary.action) {
        case 'return':
          this.onReturn();
          break;
        case 'proceed':
          this.onProceed();
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
    this.renderChips(model.chips);
  }

  /** The wrap's doors, rebuilt per render (three buttons at most). */
  private renderChips(chips: readonly TutorialChip[]): void {
    const row = this.chipsEl;
    if (!row) return;
    row.style.display = chips.length ? '' : 'none';
    const current = Array.from(row.children).map((el) => el.getAttribute('data-chip'));
    if (current.length === chips.length && chips.every((chip, i) => current[i] === chip.id)) return;
    row.textContent = '';
    for (const chip of chips) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tutorial-chip';
      button.dataset.chip = chip.id;
      button.textContent = chip.label;
      button.addEventListener('click', () => this.onChip(chip.id));
      row.appendChild(button);
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

  /** Body text with each icon token replaced by a clone of the real button SVG,
   *  bound to the word after it in a nowrap run (a missing source just drops
   *  the glyph — the button name beside it still carries the meaning). The
   *  clone is decoration: the real control is the one under the spotlight, so
   *  it carries no button styling and is hidden from assistive tech. */
  private renderBody(body: string): void {
    if (!this.bodyEl) return;
    this.bodyEl.textContent = '';
    for (const seg of tutorialBodySegments(body)) {
      if (seg.kind === 'text') {
        this.bodyEl.appendChild(document.createTextNode(seg.text));
        continue;
      }
      const src = this.icons[seg.icon];
      if (!src) {
        this.bodyEl.appendChild(document.createTextNode(seg.word));
        continue;
      }
      const svg = src.cloneNode(true) as Element;
      svg.setAttribute('class', 'tutorial-inline-icon');
      svg.setAttribute('aria-hidden', 'true');
      const bound = document.createElement('span');
      bound.className = 'tutorial-icon-word';
      bound.append(svg, seg.word);
      this.bodyEl.appendChild(bound);
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
