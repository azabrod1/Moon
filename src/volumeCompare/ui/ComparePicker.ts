/**
 * The body picker for the volume-compare sentence, on the shared BodyPicker
 * (planetarium/ui/BodyPicker): opens on a sentence chip and picks a body for
 * that slot. The header restates the sentence with the active slot
 * highlighted; the already-committed other body carries a role pill
 * ("container"/"contents" — plain words a first-time reader maps to the
 * sentence; "filler" read as jargon), never HERE — this is not a place.
 *
 * Sun is eligible on both sides. Same-body picks are legal (N = 1.00).
 */
import { BodyPicker } from '../../planetarium/ui/BodyPicker';
import { bodyDisplayName, pluralizeBody } from '../compareLogic';

export type PickerSlot = 'container' | 'filler';

export class ComparePicker {
  private readonly picker: BodyPicker;
  private slot: PickerSlot = 'container';
  private container = '';
  private filler = '';

  constructor(onPick: (name: string) => void, onClose: () => void) {
    this.picker = new BodyPicker({
      ids: {
        root: 'compare-picker',
        list: 'compare-picker-list',
        title: 'compare-picker-title',
        search: 'compare-picker-search',
        empty: 'compare-picker-empty',
        close: 'compare-picker-close',
      },
      includeSun: true,
      renderTitle: (title) => {
        const containerEl = document.createElement(this.slot === 'container' ? 'b' : 'span');
        containerEl.textContent = bodyDisplayName(this.container);
        const fillerEl = document.createElement(this.slot === 'filler' ? 'b' : 'span');
        fillerEl.textContent = pluralizeBody(this.filler);
        title.append(document.createTextNode('Fill '), containerEl, document.createTextNode(' with '), fillerEl);
      },
      rowBadge: (name) => {
        // The already-committed OTHER body wears the role pill.
        const otherName = this.slot === 'container' ? this.filler : this.container;
        if (name !== otherName) return null;
        const pill = document.createElement('span');
        pill.className = 'pk-tag-role';
        pill.textContent = this.slot === 'container' ? 'contents' : 'container';
        return pill;
      },
      onPick,
      onClose,
    });
  }

  bind(): void {
    this.picker.bind();
  }

  open(slot: PickerSlot, container: string, filler: string): void {
    this.slot = slot;
    this.container = container;
    this.filler = filler;
    this.picker.open();
  }

  close(): void {
    this.picker.close();
  }

  isOpen(): boolean {
    return this.picker.isOpen();
  }
}
