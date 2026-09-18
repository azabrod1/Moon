/**
 * The Magnified section (plan F20): the small inset a thin layer's summary
 * page draws beside its words. The globe shows every layer at its physical
 * thickness, so Earth's 35 km of crust in 6,371 km of Earth is a hairline —
 * a layer a reader can be told about but cannot look at. The inset is a
 * strip of the radial profile around that one layer, drawn at the layer's
 * OWN scale: the layer, the boundary above it, the boundary below it and
 * its thickness in km, legible without touching the model the globe draws.
 *
 * What it deliberately is not. It is not a second renderer: the layout is
 * plain numbers in SVG viewBox units and the drawing is a handful of rects,
 * lines and labels. It is not a magnification factor — the globe's scale
 * changes with zoom, so any "×180" printed here would be wrong most of the
 * time; the caption says in words that the strip is drawn to the layer's
 * own scale instead. It invents no geology: the bands carry the legend's
 * own swatch colours, a sharp boundary is a line and a distributed one is a
 * soft band exactly as wide as the model's transition, never widened to be
 * seen and never sharpened to be tidy. And it never re-scales itself from
 * the projected disc, which would make the inset breathe with the camera.
 *
 * The scale comes from the selected layer alone (`LAYER_BAND_PX` over its
 * thickness), so its neighbours run off the strip when they are much
 * thicker — which is the honest picture, and they are marked as continuing
 * where they leave. Everything above is pure; `renderThinLayerInset` is the
 * only part that touches the DOM.
 */
import { MAX_REGIONS } from '../data/interiorTypes';
import type { DrawnModel, DrawnRegion } from '../drawnModel';
import { formatKm } from './inspectorText';

/** A layer thinner than this fraction of the reference radius gets the inset: under six pixels on a 200 px disc, the phone's typical size. */
export const THIN_LAYER_FRACTION = 0.03;

/** The inset's coordinate system; the caller stretches it to the panel's width. */
export const INSET_WIDTH = 240;
export const INSET_HEIGHT = 128;

/** How tall the selected layer's band is drawn: the one number the scale comes from. */
export const LAYER_BAND_PX = 44;

export const INSET_TITLE = 'Magnified section';
export const INSET_CAPTION = 'Drawn to this layer\'s own scale: on the globe it is too thin to see at true size.';

/** What the top of the outermost layer and the bottom of the innermost are called. */
export const SURFACE_LABEL = 'Surface';
export const CENTRE_LABEL = 'Centre';

export interface InsetBand {
  key: string;
  name: string;
  /** Top and bottom in viewBox units; outward is up, so `top` is the shallower edge. */
  top: number;
  bottom: number;
  /** The legend's swatch for this region, as a CSS colour. */
  fill: string;
  selected: boolean;
  /** The band's far edge is the strip's edge, not the region's: it goes on past it. */
  continues: boolean;
  /** The region's name. */
  labelText: string;
  /** "35 km thick", on the selected band only. */
  thicknessText: string | null;
}

export interface InsetBoundary {
  y: number;
  /** Depth below the surface, km. */
  depthKm: number;
  /** "35 km", or "Surface" / "Centre" at the two ends of the profile. */
  label: string;
  /** The physical transition's width at this scale: 0 for a sharp boundary. */
  transitionPx: number;
}

export interface InsetLayout {
  title: string;
  caption: string;
  /** The strip read out in words, for a reader who cannot see it. */
  ariaLabel: string;
  width: number;
  height: number;
  /** The scale the whole strip is drawn at, from the selected layer's thickness alone. */
  scalePxPerKm: number;
  /** Outer to inner, top to bottom, contiguous. */
  bands: InsetBand[];
  /** Top to bottom. */
  boundaries: InsetBoundary[];
  /** Which band is the layer the inset is about. */
  selectedIndex: number;
}

/** The regions the tool actually draws: the shader's arrays stop at MAX_REGIONS, so the inset does too. */
function drawnRegions(drawn: DrawnModel): readonly DrawnRegion[] {
  return drawn.regionsInsideOut.length > MAX_REGIONS ? drawn.regionsInsideOut.slice(0, MAX_REGIONS) : drawn.regionsInsideOut;
}

function thicknessKmOf(region: DrawnRegion): number {
  return region.outerRadiusKm - region.innerRadiusKm;
}

/**
 * Whether this layer is one the globe cannot show: thinner than
 * THIN_LAYER_FRACTION of the reference radius. A layer with no thickness at
 * all, and an index the model does not draw, are not thin — there is nothing
 * to magnify.
 */
export function isThinLayer(drawn: DrawnModel, index: number): boolean {
  const region = drawnRegions(drawn)[index];
  if (!region || !(drawn.referenceRadiusKm > 0)) return false;
  const thicknessKm = thicknessKmOf(region);
  if (!(thicknessKm > 0)) return false;
  return thicknessKm / drawn.referenceRadiusKm < THIN_LAYER_FRACTION;
}

/** An sRGB swatch number as a CSS colour: "#rrggbb", lower case and padded. */
function cssHex(swatch: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.round(swatch)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/**
 * Lay the inset out for region `index` (the inside-out index into
 * `drawn.regionsInsideOut`), with the legend's swatches inside-out beside
 * it. Null when the layer is thick enough to read on the globe, or when the
 * model does not draw that index.
 */
export function thinLayerInset(drawn: DrawnModel, index: number, swatchesInsideOut: readonly number[]): InsetLayout | null {
  if (!isThinLayer(drawn, index)) return null;
  const regions = drawnRegions(drawn);
  const selected = regions[index];
  const referenceRadiusKm = drawn.referenceRadiusKm;
  const thicknessKm = thicknessKmOf(selected);
  const scalePxPerKm = LAYER_BAND_PX / thicknessKm;
  const selectedTop = (INSET_HEIGHT - LAYER_BAND_PX) / 2;
  const selectedBottom = selectedTop + LAYER_BAND_PX;

  const bandFor = (regionIndex: number, top: number, bottom: number, continues: boolean): InsetBand => {
    const region = regions[regionIndex];
    const isSelected = regionIndex === index;
    return {
      key: region.key,
      name: region.name,
      top,
      bottom,
      fill: cssHex(swatchesInsideOut[regionIndex] ?? 0),
      selected: isSelected,
      continues,
      labelText: region.name,
      thicknessText: isSelected ? `${formatKm(thicknessKm)} km thick` : null,
    };
  };

  /** The boundary at the OUTER radius of region `regionIndex`: the outermost region's is the surface. */
  const outerBoundaryOf = (regionIndex: number, y: number): InsetBoundary => {
    const region = regions[regionIndex];
    const outermost = regionIndex === regions.length - 1;
    const depthKm = outermost ? 0 : referenceRadiusKm - region.outerRadiusKm;
    return {
      y,
      depthKm,
      label: outermost ? SURFACE_LABEL : `${formatKm(depthKm)} km`,
      transitionPx: region.transitionKm * scalePxPerKm,
    };
  };

  /** The bottom of the innermost region: the centre of the body, and never a transition. */
  const centreBoundary = (y: number): InsetBoundary => ({ y, depthKm: referenceRadiusKm, label: CENTRE_LABEL, transitionPx: 0 });

  const bands: InsetBand[] = [];
  const boundaries: InsetBoundary[] = [];

  // The outer neighbour, from the shared boundary up: whole when it fits in
  // the room above, clipped at the strip's edge when it does not.
  const outerIndex = index + 1;
  if (outerIndex < regions.length) {
    const neighbourPx = thicknessKmOf(regions[outerIndex]) * scalePxPerKm;
    const fits = neighbourPx < selectedTop;
    const top = fits ? selectedTop - neighbourPx : 0;
    bands.push(bandFor(outerIndex, top, selectedTop, !fits));
    if (fits) boundaries.push(outerBoundaryOf(outerIndex, top));
  }

  boundaries.push(outerBoundaryOf(index, selectedTop));
  bands.push(bandFor(index, selectedTop, selectedBottom, false));
  const selectedIndex = bands.length - 1;
  boundaries.push(index > 0 ? outerBoundaryOf(index - 1, selectedBottom) : centreBoundary(selectedBottom));

  // The inner neighbour, the same way downward.
  const innerIndex = index - 1;
  if (innerIndex >= 0) {
    const neighbourPx = thicknessKmOf(regions[innerIndex]) * scalePxPerKm;
    const roomBelow = INSET_HEIGHT - selectedBottom;
    const fits = neighbourPx < roomBelow;
    const bottom = fits ? selectedBottom + neighbourPx : INSET_HEIGHT;
    bands.push(bandFor(innerIndex, selectedBottom, bottom, !fits));
    if (fits) boundaries.push(innerIndex > 0 ? outerBoundaryOf(innerIndex - 1, bottom) : centreBoundary(bottom));
  }

  const above = bands[selectedIndex - 1];
  const below = bands[selectedIndex + 1];
  const ariaLabel = [
    `${INSET_TITLE}: ${selected.name}, ${formatKm(thicknessKm)} km thick, drawn at its own scale.`,
    `Above it: ${above ? above.name : 'the surface'}.`,
    `Below it: ${below ? below.name : 'the centre'}.`,
  ].join(' ');

  return {
    title: INSET_TITLE,
    caption: INSET_CAPTION,
    ariaLabel,
    width: INSET_WIDTH,
    height: INSET_HEIGHT,
    scalePxPerKm,
    bands,
    boundaries,
    selectedIndex,
  };
}

// ---- the drawing ------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Names sit in from the left edge, depths and the thickness from the right. */
const NAME_X = 8;
const DEPTH_X = INSET_WIDTH - 8;
const THICKNESS_X = INSET_WIDTH - 12;
const LABEL_SIZE_PX = 10.5;
/** Half the label's cap height: a text placed by its middle needs it, and dominant-baseline is not worth the risk. */
const BASELINE_NUDGE_PX = 3.6;
/** A depth label sits this far above its boundary, and never closer than this to the last one drawn. */
const DEPTH_LABEL_GAP_PX = 4;
const DEPTH_LABEL_MIN_SPACING_PX = 11;
/** A band shorter than this has no room for its name. */
const NAME_MIN_BAND_PX = 13;
const SELECTED_OUTLINE_PX = 1.5;
/** How far either side of a boundary the drawing looks to find the material it separates. */
const BOUNDARY_PROBE_PX = 0.5;

/** Gradient ids have to be unique on the page: two insets can be open at once on a wide panel. */
let gradientSerial = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function label(className: string, x: number, y: number, anchor: 'start' | 'end', text: string): SVGTextElement {
  const node = svg('text', `inset-label ${className}`);
  node.setAttribute('x', x.toFixed(1));
  node.setAttribute('y', y.toFixed(1));
  node.setAttribute('text-anchor', anchor);
  node.setAttribute('font-size', String(LABEL_SIZE_PX));
  node.textContent = text;
  return node;
}

function horizontalLine(className: string, y: number, width: number, dashed: boolean): SVGLineElement {
  const line = svg('line', className);
  line.setAttribute('x1', '0');
  line.setAttribute('x2', String(width));
  line.setAttribute('y1', y.toFixed(2));
  line.setAttribute('y2', y.toFixed(2));
  line.setAttribute('stroke-width', '1');
  if (dashed) line.setAttribute('stroke-dasharray', '4 3');
  return line;
}

/**
 * The inset as an SVG element: bands in their swatch colours, a sharp
 * boundary as a line and a distributed one as a soft band of its own width,
 * a dashed edge where a neighbour runs off the strip, and the labels. Every
 * stroke and every text colour is left to the stylesheet; only geometry is
 * set here.
 */
export function renderThinLayerInset(layout: InsetLayout): SVGSVGElement {
  const root = svg('svg', 'interior-inset');
  root.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', layout.ariaLabel);
  const defs = svg('defs');
  root.append(defs);

  const selected = layout.bands[layout.selectedIndex];

  layout.bands.forEach((band, index) => {
    const rect = svg('rect', 'inset-band');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', band.top.toFixed(2));
    rect.setAttribute('width', String(layout.width));
    rect.setAttribute('height', Math.max(0, band.bottom - band.top).toFixed(2));
    rect.setAttribute('fill', band.fill);
    root.append(rect);
    if (!band.continues) return;
    // The edge where the band leaves the strip rather than ending; it sits at
    // the strip's own edge, so it is drawn half a stroke inside to stay whole.
    const edge = index < layout.selectedIndex ? band.top + 0.5 : band.bottom - 0.5;
    root.append(horizontalLine('inset-continues', edge, layout.width, true));
  });

  /** The band a point falls in, or null where the strip has none (past the surface, past the centre). */
  const fillAt = (y: number): string | null => {
    const band = layout.bands.find((entry) => y >= entry.top && y < entry.bottom);
    return band ? band.fill : null;
  };

  for (const boundary of layout.boundaries) {
    if (boundary.transitionPx <= 0) {
      root.append(horizontalLine('inset-boundary', boundary.y, layout.width, false));
      continue;
    }
    // A distributed boundary is drawn exactly as wide as the model says it
    // is, as a fade between the two materials; at the strip's own edge there
    // is only one material, so it fades out instead of inventing a second.
    const above = fillAt(boundary.y - BOUNDARY_PROBE_PX);
    const below = fillAt(boundary.y + BOUNDARY_PROBE_PX);
    const gradient = svg('linearGradient');
    const id = `inset-grad-${++gradientSerial}`;
    gradient.setAttribute('id', id);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('x2', '0');
    gradient.setAttribute('y2', '1');
    const stop = (offset: string, color: string | null, fallback: string) => {
      const node = svg('stop');
      node.setAttribute('offset', offset);
      node.setAttribute('stop-color', color ?? fallback);
      if (!color) node.setAttribute('stop-opacity', '0');
      gradient.append(node);
    };
    stop('0', above, below ?? '#000000');
    stop('1', below, above ?? '#000000');
    defs.append(gradient);
    const rect = svg('rect', 'inset-boundary inset-transition');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', (boundary.y - boundary.transitionPx / 2).toFixed(2));
    rect.setAttribute('width', String(layout.width));
    rect.setAttribute('height', boundary.transitionPx.toFixed(2));
    rect.setAttribute('fill', `url(#${id})`);
    root.append(rect);
  }

  if (selected) {
    const outline = svg('rect', 'inset-selected');
    const half = SELECTED_OUTLINE_PX / 2;
    outline.setAttribute('x', String(half));
    outline.setAttribute('y', (selected.top + half).toFixed(2));
    outline.setAttribute('width', String(layout.width - SELECTED_OUTLINE_PX));
    outline.setAttribute('height', Math.max(0, selected.bottom - selected.top - SELECTED_OUTLINE_PX).toFixed(2));
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke-width', String(SELECTED_OUTLINE_PX));
    root.append(outline);
  }

  for (const band of layout.bands) {
    if (band.bottom - band.top < NAME_MIN_BAND_PX) continue;
    root.append(label('inset-name', NAME_X, (band.top + band.bottom) / 2 + BASELINE_NUDGE_PX, 'start', band.labelText));
  }
  if (selected?.thicknessText) {
    root.append(label('inset-thickness', THICKNESS_X, (selected.top + selected.bottom) / 2 + BASELINE_NUDGE_PX, 'end', selected.thicknessText));
  }

  // The selected layer's own depths always read; another boundary's label is
  // dropped where it would sit on top of one already placed.
  const placed: number[] = [];
  const own = (boundary: InsetBoundary) => !!selected && (boundary.y === selected.top || boundary.y === selected.bottom);
  const depthLabel = (boundary: InsetBoundary) => {
    const y = Math.min(layout.height - DEPTH_LABEL_GAP_PX, Math.max(LABEL_SIZE_PX, boundary.y - DEPTH_LABEL_GAP_PX));
    if (!own(boundary) && placed.some((other) => Math.abs(other - y) < DEPTH_LABEL_MIN_SPACING_PX)) return;
    placed.push(y);
    root.append(label('inset-depth', DEPTH_X, y, 'end', boundary.label));
  };
  for (const boundary of layout.boundaries) if (own(boundary)) depthLabel(boundary);
  for (const boundary of layout.boundaries) if (!own(boundary)) depthLabel(boundary);

  return root;
}
