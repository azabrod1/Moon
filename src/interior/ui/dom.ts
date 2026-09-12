/**
 * The small DOM pieces the inspector and the evidence popover share: an
 * element with a class and text, the close button with its cross (the
 * picker's pk-x, so every card closes with the same glyph), and the
 * five-segment evidence meter. One definition each, so the two cards
 * cannot drift apart.
 */
import { meterSegments } from '../evidenceScore';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CLOSE_CROSS_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 5.5 L14.5 14.5 M14.5 5.5 L5.5 14.5"></path></svg>';

/** A card's close button: the picker's cross, labelled for a reader who cannot see it. */
export function closeButton(onClose: () => void, className = 'pk-x'): HTMLButtonElement {
  const close = element('button', className);
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = CLOSE_CROSS_SVG;
  close.addEventListener('click', onClose);
  return close;
}

/** The five-segment meter for a score, filled in fifths; decorative beside its level word. */
export function meterBar(score: number): HTMLElement {
  const meter = element('span', 'ev-meter');
  meter.setAttribute('aria-hidden', 'true');
  const filled = meterSegments(score);
  for (let segment = 0; segment < 5; segment++) meter.append(element('i', segment < filled ? 'on' : ''));
  return meter;
}
