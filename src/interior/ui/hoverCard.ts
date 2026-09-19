/**
 * The hover preview beside a fine pointer over a region: the region's name,
 * its material and phase, and the depth under the pointer. Built once and
 * moved, never rebuilt (plan F27): the card keeps its three text nodes, its
 * name and kicker change only when the region does, its depth line only
 * when the formatted depth does, its size is measured only after its content
 * changed (a depth of the same length is the same width, the digits being
 * tabular) or the fonts arrived, and it is placed by a transform, so a
 * pointer move at rest costs one text write and one transform and no
 * layout. The mode coalesces pointer moves to one pick per frame before
 * asking for a show. The controller is DOM-free through HoverCardSurface,
 * which the test fakes; domHoverCardSurface is the one real surface.
 */
import { element } from './dom';
import { formatKm } from './inspectorText';

/** The card sits this far from the pointer, and never closer than the margin to the viewport's edges. */
export const HOVER_CARD_OFFSET_PX = 14;
export const HOVER_CARD_MARGIN_PX = 8;

export interface HoverCardContent {
  /** What tells one region's card from another's: the region key. */
  key: string;
  name: string;
  /** The line under the name: the material family and the phase. */
  kicker: string;
}

/** What a card must let the controller do; the DOM one is domHoverCardSurface. */
export interface HoverCardSurface {
  setContent(name: string, kicker: string): void;
  /** The depth line, or none. */
  setDepth(text: string | null): void;
  /** The card's size as laid out: the one read that forces layout. */
  measure(): { width: number; height: number };
  place(x: number, y: number): void;
  setVisible(visible: boolean): void;
}

export interface HoverCardViewport {
  width: number;
  height: number;
}

/** Where the card goes: beside the pointer, kept inside the viewport. */
export function placeHoverCard(pointerX: number, pointerY: number, cardWidth: number, cardHeight: number, viewport: HoverCardViewport): { x: number; y: number } {
  const x = Math.min(pointerX + HOVER_CARD_OFFSET_PX, viewport.width - cardWidth - HOVER_CARD_MARGIN_PX);
  const y = Math.min(pointerY + HOVER_CARD_OFFSET_PX, viewport.height - cardHeight - HOVER_CARD_MARGIN_PX);
  return { x: Math.max(HOVER_CARD_MARGIN_PX, x), y: Math.max(HOVER_CARD_MARGIN_PX, y) };
}

/** The depth line: "1,234 km down", never a negative depth. */
export function hoverDepthText(depthKm: number | null): string | null {
  return depthKm === null ? null : `${formatKm(Math.max(0, depthKm))} km down`;
}

export class HoverCard {
  private shownKey: string | null = null;
  private shownDepth: string | null = null;
  private size: { width: number; height: number } | null = null;
  private visible = false;

  constructor(private readonly surface: HoverCardSurface) {}

  /** Show the card for a region at a pointer: writes what changed, measures only if it had to. */
  show(content: HoverCardContent, depthText: string | null, pointerX: number, pointerY: number, viewport: HoverCardViewport): void {
    let remeasure = this.size === null;
    if (content.key !== this.shownKey) {
      this.surface.setContent(content.name, content.kicker);
      this.shownKey = content.key;
      remeasure = true;
    }
    if (depthText !== this.shownDepth) {
      // Tabular digits: a depth line of the same length is the same width.
      if ((depthText?.length ?? 0) !== (this.shownDepth?.length ?? 0)) remeasure = true;
      this.surface.setDepth(depthText);
      this.shownDepth = depthText;
    }
    if (!this.visible) {
      this.surface.setVisible(true);
      this.visible = true;
    }
    if (remeasure || !this.size) this.size = this.surface.measure();
    const { x, y } = placeHoverCard(pointerX, pointerY, this.size.width, this.size.height, viewport);
    this.surface.place(x, y);
  }

  hide(): void {
    if (!this.visible) return;
    this.surface.setVisible(false);
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** The next show measures again: the fonts arrived, or the viewport changed under the card. */
  invalidateSize(): void {
    this.size = null;
  }
}

/** The real card: three text nodes inside the host, placed by a transform from the viewport's corner. */
export function domHoverCardSurface(card: HTMLElement): HoverCardSurface {
  const name = element('div', 'ih-name');
  const kicker = element('div', 'ih-kicker');
  const depth = element('div', 'ih-depth');
  depth.style.display = 'none';
  card.replaceChildren(name, kicker, depth);
  card.style.left = '0';
  card.style.top = '0';
  return {
    setContent(nameText, kickerText) {
      name.textContent = nameText;
      kicker.textContent = kickerText;
    },
    setDepth(text) {
      depth.textContent = text ?? '';
      depth.style.display = text === null ? 'none' : '';
    },
    measure() {
      return { width: card.offsetWidth, height: card.offsetHeight };
    },
    place(x, y) {
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    },
    setVisible(visible) {
      card.style.display = visible ? 'block' : 'none';
    },
  };
}
