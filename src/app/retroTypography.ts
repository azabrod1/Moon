/**
 * The Retro look's type sizes: every font size the stylesheet sets, mapped to
 * the nearest of the five bitmap faces (public/fonts/Retro*.woff,
 * tools/gen-pixel-fonts.mjs).
 *
 * A bitmap face is drawn for one size: set at its pixel size times the
 * interface pixel (`--ui-px`) every font pixel is a hard square, and at any
 * other size it is resampled and goes soft. So the family and the size must
 * always change together. index.html's retro block sets one face for every
 * element (Retro Sans 10, the size most of the interface is in); this module
 * adds, for each rule in the stylesheet that sets a font size, a rule giving
 * that element and its descendants the face for its size — inside the same
 * media query, so a phone's sizes follow the phone's rules. Read from the
 * live stylesheet when the look is first turned on, so a size added to
 * index.html later is mapped without anyone remembering to.
 */

/** A bitmap face: its CSS family and its size in font pixels. */
export interface RetroFace {
  family: string;
  pixels: number;
}

/** The faces, smallest first, with the largest modern size each one stands for. */
const FACES: readonly { upTo: number; face: RetroFace }[] = [
  { upTo: 10.5, face: { family: 'Retro Sans 8', pixels: 8 } },
  { upTo: 13.5, face: { family: 'Retro Sans 10', pixels: 10 } },
  { upTo: 16.5, face: { family: 'Retro Sans 12', pixels: 12 } },
  { upTo: 22.5, face: { family: 'Retro Sans 14', pixels: 14 } },
  { upTo: Infinity, face: { family: 'Retro Sans 18', pixels: 18 } },
];

/** The face that stands in for a modern font size in CSS px. */
export function retroFaceFor(modernPx: number): RetroFace {
  return FACES.find((entry) => modernPx <= entry.upTo)!.face;
}

/** One rule of the stylesheet that sets a font size. */
export interface SizedRule {
  selector: string;
  fontSizePx: number;
  /** The media query it sits in, or null. */
  media: string | null;
}

/** The face's declarations; !important because the retro block's default is. */
function declarations(face: RetroFace): string {
  return `font-family: '${face.family}', monospace !important; font-size: calc(${face.pixels} * var(--ui-px)) !important;`;
}

/** Prefix each selector of a list with `html.retro`, and add its descendants. */
function retroSelectors(selectorList: string): string {
  return selectorList
    .split(',')
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0)
    // A pseudo-element has no descendants, and `::before *` would make the
    // whole rule invalid, so it gets the face alone.
    .flatMap((selector) => (selector.includes('::')
      ? [`html.retro ${selector}`]
      : [`html.retro ${selector}`, `html.retro ${selector} *`]))
    .join(', ');
}

/** The CSS for every sized rule, in their order, media queries kept. Rules
 *  whose size maps to the default face are left out: the default covers them. */
export function retroTypographyCss(rules: readonly SizedRule[]): string {
  const lines: string[] = [];
  for (const rule of rules) {
    const face = retroFaceFor(rule.fontSizePx);
    if (face.family === 'Retro Sans 10') continue;
    const body = `${retroSelectors(rule.selector)} { ${declarations(face)} }`;
    lines.push(rule.media ? `@media ${rule.media} { ${body} }` : body);
  }
  return lines.join('\n');
}

/** Every style rule in the sheets that sets a font size in px. */
export function sizedRulesOf(sheets: Iterable<CSSStyleSheet>): SizedRule[] {
  const found: SizedRule[] = [];
  const visit = (rules: CSSRuleList, media: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        visit(rule.cssRules, media ? `${media} and ${rule.conditionText}` : rule.conditionText);
      } else if (rule instanceof CSSStyleRule) {
        const size = /^([0-9.]+)px$/.exec(rule.style.fontSize.trim());
        if (size) found.push({ selector: rule.selectorText, fontSizePx: Number(size[1]), media });
      }
    }
  };
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet: nothing of the app's in it
    }
    visit(rules, null);
  }
  return found;
}

/** Add the mapped sizes to the page once. Safe to call on every switch. */
export function installRetroTypography(doc: Document = document): void {
  if (doc.getElementById('retro-typography')) return;
  const style = doc.createElement('style');
  style.id = 'retro-typography';
  style.textContent = retroTypographyCss(sizedRulesOf(Array.from(doc.styleSheets)));
  doc.head.appendChild(style);
}
