/**
 * The Retro look's type sizes: every font size the stylesheet sets, mapped to
 * the nearest of the five bitmap faces (public/fonts/Retro*.woff,
 * tools/gen-pixel-fonts.mjs).
 *
 * A bitmap face is drawn for one size: set at its pixel size times the
 * interface pixel (`--ui-px`) every font pixel is a hard square, and at any
 * other size it is resampled and goes soft. So a face's family and its size
 * must always arrive together, and this module makes sure they do by leaning
 * on ordinary inheritance:
 *
 *  - The root carries the default face (retro.css: Retro Sans 10, the size
 *    most of the interface is in).
 *  - Every rule in the stylesheet that sets a font size in px gets a mirror
 *    rule, `html.retro <its selector>`, that sets the face for that size,
 *    family and size together. Everything inside the element without a size
 *    of its own inherits both, so the nearest sized ancestor wins, as it does
 *    in the modern look.
 *  - A rule that sets only a family (`var(--font-mono)`, say) gets
 *    `font-family: inherit`, so it can never pair one face's family with
 *    another face's size. A relative size (`0.85em`) inherits its parent's
 *    face whole rather than scaling it to a size it was not drawn for.
 *
 * The mirror rules keep their original selectors, so their specificity and
 * order relative to one another are the stylesheet's own; `!important` puts
 * them over the modern rules they mirror. They are inserted just before
 * retro.css, so its own hand-set faces win a tie, and the few
 * regions that set a face of their own (RETRO_FIXED_FACE_REGIONS: the title,
 * the instrument readouts) are left out of the mapping altogether, so a more
 * specific mapped rule inside them cannot win either.
 *
 * Read from the live stylesheet when the look is first turned on, so a size
 * added to the app's CSS later is mapped without anyone writing a rule for it.
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

/**
 * Regions the mapping never touches, because retro.css gives them a face of
 * its own: the title band's heading, the cockpit readouts (the
 * clock and the speed) and the target brackets. A selector part that mentions
 * one is skipped. Add a region here whenever retro.css hand-sets a face.
 */
export const RETRO_FIXED_FACE_REGIONS: readonly string[] = [
  '#top-bar h1', '.tr-clock', '.speed-center', '#retro-target',
  // Elements inside those regions that modern rules name directly (an id
  // outranks the region's own rule), skipped for the same reason.
  '#planetarium-speed-value', '#planetarium-speed-label',
];

/** One rule of the stylesheet that sets a font size or a family. */
export interface FontRule {
  selector: string;
  /** The declared font-size as written ('11px', '0.85em', 'inherit'), or ''. */
  fontSize: string;
  /** Whether it declares a font-family. */
  setsFamily: boolean;
  /** The media query it sits in, or null. */
  media: string | null;
}

/** A selector list split on its top-level commas only, so `:is(.a, .b)` stays whole. */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const character = list[index];
    if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The declarations a rule's mirror sets, or null for none. */
function mirrorDeclarations(rule: FontRule): string | null {
  const size = rule.fontSize.trim();
  const px = /^([0-9.]+)px$/.exec(size);
  if (px) {
    const face = retroFaceFor(Number(px[1]));
    return `font-family: '${face.family}', monospace !important; font-size: calc(${face.pixels} * var(--ui-px)) !important;`;
  }
  // Text sized to nothing is hidden on purpose: leave it hidden.
  if (size !== '' && !/^0+(\.0+)?(px|em|rem|%)?$/.test(size)) {
    return 'font-family: inherit !important; font-size: inherit !important;';
  }
  if (rule.setsFamily) return 'font-family: inherit !important;';
  return null;
}

/** The mirror rules, in the stylesheet's order, media queries kept. */
export function retroTypographyCss(rules: readonly FontRule[]): string {
  const lines: string[] = [];
  for (const rule of rules) {
    const declarations = mirrorDeclarations(rule);
    if (!declarations) continue;
    const parts = splitSelectorList(rule.selector)
      // The retro block's own rules are already in retro terms.
      .filter((part) => !part.includes('.retro') && !RETRO_FIXED_FACE_REGIONS.some((region) => part.includes(region)));
    if (parts.length === 0) continue;
    const body = `${parts.map((part) => `html.retro ${part}`).join(', ')} { ${declarations} }`;
    lines.push(rule.media ? `@media ${rule.media} { ${body} }` : body);
  }
  return lines.join('\n');
}

/** Every style rule in the sheets that sets a font size or a family. */
export function fontRulesOf(sheets: Iterable<CSSStyleSheet>): FontRule[] {
  const found: FontRule[] = [];
  const visit = (rules: CSSRuleList, media: string | null) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        visit(rule.cssRules, media ? `${media} and ${rule.conditionText}` : rule.conditionText);
      } else if (rule instanceof CSSStyleRule) {
        const fontSize = rule.style.fontSize;
        const setsFamily = rule.style.fontFamily !== '';
        if (fontSize !== '' || setsFamily) found.push({ selector: rule.selectorText, fontSize, setsFamily, media });
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

/** Add the mirror rules to the page just before `before` (retro.css). Called once (index.ts). */
export function installRetroTypography(before: HTMLStyleElement): void {
  const doc = before.ownerDocument;
  const style = doc.createElement('style');
  style.id = 'retro-typography';
  style.textContent = retroTypographyCss(fontRulesOf(Array.from(doc.styleSheets).filter((sheet) => sheet.ownerNode !== before)));
  before.before(style);
}
