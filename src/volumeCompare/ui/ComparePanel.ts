/**
 * The volume-compare control panel: the "Fill ⟨container⟩ with ⟨fillers⟩"
 * sentence (two tappable body chips + a ⇄ swap), the honest count, the pour
 * controls (slider + presets + odometer + status sub-line + Reset), the brim
 * Melt affordance, the auto-melt toggle, and the end card. Thin DOM — bind()
 * caches elements and wires listeners once; render()/setters rewrite text on
 * state changes, and the odometer/status tick at ~10 Hz from the mode.
 *
 * Copy is plain and flagged for the P5 voice pass. Prose uses bodyDisplayName
 * for the article convention; the picker rows (ComparePicker) use raw catalog
 * names for search parity, matching the deck.
 */
import {
  formatCount,
  bodyDisplayName,
  pluralizeBody,
  type Comparison,
  type EndCardModel,
} from '../compareLogic';

export type PresetKey = '10' | 'half' | 'fill' | 'one';
export type ChipSlot = 'container' | 'filler';

export interface ComparePanelHandlers {
  onLeave: () => void;
  onSlider: (fraction: number) => void;
  onPreset: (key: PresetKey) => void;
  onMelt: () => void;
  onReset: () => void;
  onAutoMelt: (on: boolean) => void;
  onChip: (slot: ChipSlot) => void;
  onSwap: () => void;
  onTeaserSwap: () => void;
  /** A Try-next row commits the PAIR it names (rows are filtered, so an index
   *  into the raw curated list could desync). */
  onEndTry: (container: string, filler: string) => void;
  onPourAgain: () => void;
  onEndClose: () => void;
}

export interface ComparePanelState {
  container: string;
  filler: string;
  comparison: Comparison;
  /** Whether the pour controls show (marbles/boulders/sand) or hide (sub-unity). */
  pourable: boolean;
  /** Whether the melt controls (Melt affordance + Auto-melt toggle) show. Sand
   *  hides them — a liquid-like fill never packs, so there is nothing to melt. */
  showMeltControls: boolean;
  /** Preset buttons for this regime: labelled keys in display order. */
  presets: { key: PresetKey; label: string }[];
}

export class ComparePanel {
  private wired = false;
  private el: Record<string, HTMLElement | null> = {};

  constructor(private h: ComparePanelHandlers) {}

  private get(id: string): HTMLElement | null {
    return (this.el[id] ??= document.getElementById(id));
  }

  bind(): void {
    this.el = {}; // re-cache each activation (DOM persists, but be safe)
    if (this.wired) return;
    this.wired = true;
    this.get('compare-leave')?.addEventListener('click', () => this.h.onLeave());
    this.get('compare-chip-container')?.addEventListener('click', () => this.h.onChip('container'));
    this.get('compare-chip-filler')?.addEventListener('click', () => this.h.onChip('filler'));
    this.get('compare-swap')?.addEventListener('click', () => this.h.onSwap());
    this.get('compare-teaser')?.addEventListener('click', () => this.h.onTeaserSwap());
    this.get('compare-reset')?.addEventListener('click', () => this.h.onReset());
    this.get('compare-melt')?.addEventListener('click', () => this.h.onMelt());
    const slider = this.get('compare-slider') as HTMLInputElement | null;
    slider?.addEventListener('input', () => this.h.onSlider(parseFloat(slider.value)));
    const auto = this.get('compare-automelt-toggle') as HTMLInputElement | null;
    auto?.addEventListener('change', () => this.h.onAutoMelt(auto.checked));
    this.wireInfo('compare-automelt-info', 'compare-automelt-explain');
    this.get('compare-presets')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-preset]') as HTMLElement | null;
      if (btn) this.h.onPreset(btn.dataset.preset as PresetKey);
    });
    this.get('compare-endcard-again')?.addEventListener('click', () => this.h.onPourAgain());
    this.get('compare-endcard-close')?.addEventListener('click', () => this.h.onEndClose());
    this.get('compare-endcard')?.addEventListener('click', (e) => {
      if (e.target === this.get('compare-endcard')) this.h.onEndClose();
    });
    this.get('compare-endcard-rows')?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-try]') as HTMLElement | null;
      if (row?.dataset.container && row.dataset.filler) {
        this.h.onEndTry(row.dataset.container, row.dataset.filler);
      }
    });
  }

  /** The ⓘ note idiom: the info button toggles the explain block. */
  private wireInfo(btnId: string, explainId: string): void {
    const btn = this.get(btnId);
    const explain = this.get(explainId);
    btn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!explain) return;
      const open = explain.style.display !== 'none';
      explain.style.display = open ? 'none' : 'block';
      btn.setAttribute('aria-expanded', String(!open));
    });
  }

  /** Rewrite the sentence, count/teaser, and pour-control shell for a new pair. */
  render(state: ComparePanelState): void {
    const { container, filler, comparison } = state;
    this.setText('compare-chip-container', bodyDisplayName(container));
    this.setText('compare-chip-filler', pluralizeBody(filler));

    const count = this.get('compare-count');
    if (count) {
      count.textContent = '';
      if (comparison.subUnity) {
        count.classList.add('compare-count-sub');
        count.textContent = 'less than one fits';
      } else {
        count.classList.remove('compare-count-sub');
        const num = document.createElement('b');
        num.textContent = formatCount(comparison.n);
        count.append(num, document.createTextNode(' fit'));
      }
    }

    // Pour controls: hidden for the sub-unity teaser only.
    this.get('compare-pour')?.classList.toggle('off', !state.pourable);
    // Melt controls (the brim Melt affordance + the Auto-melt toggle/ⓘ) hide for
    // sand — its fill is liquid-like and never packs.
    this.get('compare-melt')?.classList.toggle('melt-hidden', !state.showMeltControls);
    this.get('compare-automelt-row')?.classList.toggle('melt-hidden', !state.showMeltControls);
    const explain = this.get('compare-automelt-explain');
    if (explain && !state.showMeltControls) explain.style.display = 'none';

    // Presets rebuilt per regime (boulders read "1 · half · fill it").
    const presets = this.get('compare-presets');
    if (presets) {
      presets.textContent = '';
      for (const p of state.presets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'compare-preset';
        b.dataset.preset = p.key;
        b.textContent = p.label;
        presets.appendChild(b);
      }
    }
  }

  /** The odometer (poured count) + the phase status sub-line — ticked ~10 Hz. */
  setReadout(odometer: string, status: string): void {
    this.setText('compare-odometer', odometer);
    this.setText('compare-status', status);
  }

  /** Two-tone slider track: poured in the filler tint, poured→target dimmed, rest neutral. */
  setSliderTrack(pouredFrac: number, targetFrac: number, colorHex: number): void {
    const slider = this.get('compare-slider') as HTMLInputElement | null;
    if (!slider) return;
    const p = Math.round(Math.min(1, Math.max(0, pouredFrac)) * 100);
    const t = Math.round(Math.min(1, Math.max(0, Math.max(pouredFrac, targetFrac))) * 100);
    const tint = `#${(colorHex & 0xffffff).toString(16).padStart(6, '0')}`;
    slider.style.background =
      `linear-gradient(90deg, ${tint} 0 ${p}%, rgba(94,139,255,0.45) ${p}% ${t}%, rgba(255,255,255,0.10) ${t}% 100%)`;
  }

  /** Set the slider knob position (presets / reset / restore). */
  setSliderValue(fraction: number): void {
    const slider = this.get('compare-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(fraction);
  }

  setPreview(text: string, show: boolean): void {
    this.setText('compare-status', show ? text : '');
  }

  /** The brim Melt affordance: shown + pulsing while the pile waits to be reconciled.
   *  On the mobile bar this also reveals the conditional row 4 (Melt + Auto-melt),
   *  keeping the protected brim→Melt moment first-class without growing the bar
   *  the rest of the time. */
  showMelt(show: boolean, rowLive: boolean = show): void {
    const melt = this.get('compare-melt');
    melt?.classList.toggle('on', show);
    melt?.classList.toggle('pulse', show);
    // The mobile row-4 (Melt + Auto-melt, one conditional unit) stays live from brim
    // THROUGH melting and only drops at raining, so it never vanishes mid-melt; the
    // Melt button itself still hides the moment melting starts (show=false).
    this.get('compare-panel')?.classList.toggle('melt-live', rowLive);
  }

  setAutoMelt(on: boolean): void {
    const auto = this.get('compare-automelt-toggle') as HTMLInputElement | null;
    if (auto) auto.checked = on;
  }

  /** The sub-unity teaser sub-line ("the other way round: 1,321 fit — tap ⇄"). */
  setTeaser(text: string | null): void {
    const teaser = this.get('compare-teaser');
    if (!teaser) return;
    teaser.classList.toggle('on', text !== null);
    if (text === null) {
      teaser.textContent = '';
    } else {
      teaser.textContent = '';
      teaser.append(document.createTextNode('the other way round: '));
      const b = document.createElement('b');
      b.textContent = text;
      teaser.append(b, document.createTextNode(' fit — tap ⇄'));
    }
  }

  /** Fill + show the end card (null hides it). On the mobile bar the card is a
   *  bottom sheet — hide the bar under it (its controls are inert at complete;
   *  Pour again lives on the card), so the sheet is the only bottom occluder. */
  showEndCard(model: EndCardModel | null): void {
    const card = this.get('compare-endcard');
    if (!card) return;
    if (!model) {
      card.classList.remove('visible');
      this.get('compare-panel')?.classList.remove('bar-hidden');
      return;
    }
    this.setText('compare-endcard-headline', model.headline);
    const dual = this.get('compare-endcard-dual');
    if (dual) {
      dual.textContent = model.dualStat ?? '';
      dual.style.display = model.dualStat ? 'block' : 'none';
    }
    const kicker = this.get('compare-endcard-kicker');
    if (kicker) {
      kicker.textContent = model.kicker ?? '';
      kicker.style.display = model.kicker ? 'block' : 'none';
    }
    const rows = this.get('compare-endcard-rows');
    if (rows) {
      rows.textContent = '';
      model.tryNext.forEach((row, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pk-row';
        btn.dataset.try = String(i);
        // The commit reads the pair off the row itself, never an index back
        // into the (filtered) curated list.
        btn.dataset.container = row.container;
        btn.dataset.filler = row.filler;
        const info = document.createElement('span');
        info.className = 'pk-info';
        const small = document.createElement('small');
        small.textContent = row.text;
        info.append(small);
        btn.append(info);
        rows.append(btn);
      });
    }
    card.classList.add('visible');
    this.get('compare-panel')?.classList.add('bar-hidden');
  }

  isEndCardShown(): boolean {
    return this.get('compare-endcard')?.classList.contains('visible') ?? false;
  }

  /** Show/hide the pair-swap loading chip (mode entry uses the veil instead). */
  setLoading(loading: boolean): void {
    this.get('compare-panel')?.classList.toggle('compare-swapping', loading);
  }

  private setText(id: string, text: string): void {
    const el = this.get(id);
    if (el) el.textContent = text;
  }
}
