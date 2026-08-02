import { sig3, tiltAxisEndpoints, TILT_GLYPH } from '../map/mapFacts';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * The axial-tilt glyph a planet's Tilt row shows instead of a number: the
 * orbital plane as a dashed line, the body on it, and the spin axis leaning by
 * the catalog angle with a dot on its NORTH end.
 *
 * The dot is what makes the picture worth more than the number — Venus's 177°
 * puts it below the body, so a retrograde spin reads at a glance. The axis and
 * the dot take the body's own tint, the way every other body-coloured thing in
 * the UI does; the plane and the body stay neutral so the lean is what shows.
 *
 * The exact angle is still there for anyone who wants it, as the native
 * tooltip.
 *
 * Geometry after Gregory Zabrodskiy's system-map card (PR #16).
 */
export function makeTiltGlyph(deg: number, tintCss: string): SVGSVGElement {
  const { width, height, cx, cy, bodyRadius, poleRadius, baseInset } = TILT_GLYPH;
  const axis = tiltAxisEndpoints(deg);
  const svg = el('svg', {
    class: 'map-tilt',
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
  });
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = `${sig3(deg)}° axial tilt`;
  svg.appendChild(title);
  svg.appendChild(el('line', {
    class: 'map-tilt-base',
    x1: baseInset,
    y1: cy,
    x2: width - baseInset,
    y2: cy,
  }));
  svg.appendChild(el('circle', { class: 'map-tilt-body', cx, cy, r: bodyRadius }));
  svg.appendChild(el('line', {
    class: 'map-tilt-axis',
    x1: axis.southX,
    y1: axis.southY,
    x2: axis.northX,
    y2: axis.northY,
    stroke: tintCss,
  }));
  svg.appendChild(el('circle', {
    class: 'map-tilt-pole',
    cx: axis.northX,
    cy: axis.northY,
    r: poleRadius,
    fill: tintCss,
  }));
  return svg;
}
