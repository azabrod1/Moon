/**
 * The small DOM piece the panel's pages share: an element with a class and
 * text. One definition, so no page builds it its own way.
 */

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
