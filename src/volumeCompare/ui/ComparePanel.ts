/**
 * The volume-compare readout panel: the "Fill <container> with <fillers>"
 * sentence and the honest count ("1,321 fit", or the sub-unity "less than one
 * fits"), plus the in-scene loading chip shown during a pair swap and the Leave
 * button. Thin DOM — bind() caches elements and wires Leave once; render()
 * rewrites the text only on a state change (nothing here ticks per frame).
 *
 * Copy is plain and flagged for the P5 voice pass. The container keeps its
 * article ("the Moon") via bodyDisplayName; the pluralized filler stays bare
 * ("Moons", not "the Moons") — a pluralized noun reads better without the article.
 */
import { formatCount } from '../compareLogic';
import { bodyDisplayName } from '../../planetarium/surfaceView';

export interface ComparePanelState {
  container: string;
  filler: string;
  n: number;
  subUnity: boolean;
}

/** English plural of a body name: +es after a sibilant ending, else +s. */
function pluralizeBody(name: string): string {
  return /(?:s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
}

export class ComparePanel {
  private panelEl: HTMLElement | null = null;
  private sentenceEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private wired = false;

  constructor(private onLeave: () => void) {}

  bind(): void {
    this.panelEl = document.getElementById('compare-panel');
    this.sentenceEl = document.getElementById('compare-sentence');
    this.countEl = document.getElementById('compare-count');
    if (this.wired) return;
    this.wired = true;
    document.getElementById('compare-leave')?.addEventListener('click', () => this.onLeave());
  }

  render(state: ComparePanelState): void {
    if (this.sentenceEl) {
      this.sentenceEl.textContent =
        `Fill ${bodyDisplayName(state.container)} with ${pluralizeBody(state.filler)}`;
    }
    const count = this.countEl;
    if (!count) return;
    count.textContent = '';
    if (state.subUnity) {
      // Filler larger than the container: no honest count, just the teaser line.
      count.classList.add('compare-count-sub');
      count.textContent = 'less than one fits';
      return;
    }
    count.classList.remove('compare-count-sub');
    const num = document.createElement('b');
    num.textContent = formatCount(state.n);
    count.append(num, document.createTextNode(' fit'));
  }

  /** Show/hide the pair-swap loading chip (mode entry uses the veil instead). */
  setLoading(loading: boolean): void {
    this.panelEl?.classList.toggle('compare-swapping', loading);
  }
}
