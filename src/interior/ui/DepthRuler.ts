/**
 * The depth ruler on screen (plan §6): an SVG overlay that draws the
 * ruler.ts layout each frame — the region segments as lines following the
 * terraces, km ticks with labels thinned to the spacing the projection
 * leaves, region names on segments with room, annotation brackets on a
 * second tier below. Elements are pooled and re-posed, never rebuilt per
 * frame. Hidden on phones and while the cut is closed; it fades in with
 * the opening so it draws itself on the reveal.
 */
import * as THREE from 'three';
import type { RulerLayout } from '../ruler';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TICK_PX = 6;
const LABEL_GAP_PX = 10;
/** Labels are thinned to the width of the text between them (mono, about this wide per glyph) plus a gap. */
const LABEL_GLYPH_PX = 6.2;
const LABEL_MIN_GAP_PX = 10;
/** A region name needs this much projected segment length. */
const NAME_MIN_SEGMENT_PX = 44;
const NAME_GAP_PX = 14;
const BRACKET_GAP_PX = 30;
const BRACKET_ARM_PX = 4;
/** Brackets whose spans overlap along the ruler step down a tier each. */
const BRACKET_TIER_PX = 15;
const BRACKET_PAD_PX = 6;
/** Below this projected span a bracket keeps its line but drops its name. */
const BRACKET_NAME_MIN_PX = 14;

interface Pool<T extends SVGElement> {
  elements: T[];
  used: number;
}

function pool<K extends keyof SVGElementTagNameMap>(): Pool<SVGElementTagNameMap[K]> {
  return { elements: [], used: 0 };
}

function take<K extends keyof SVGElementTagNameMap>(root: SVGSVGElement, tag: K, className: string, store: Pool<SVGElementTagNameMap[K]>): SVGElementTagNameMap[K] {
  let element = store.elements[store.used];
  if (!element) {
    element = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
    element.setAttribute('class', className);
    root.append(element);
    store.elements.push(element);
  }
  element.style.display = '';
  store.used++;
  return element;
}

function release<T extends SVGElement>(store: Pool<T>): void {
  for (let index = store.used; index < store.elements.length; index++) store.elements[index].style.display = 'none';
  store.used = 0;
}

function formatKm(km: number): string {
  return km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('en-US');
}

const projected = new THREE.Vector3();

export class DepthRuler {
  private root: SVGSVGElement | null = null;
  private readonly segmentLines = pool<'line'>();
  private readonly tickLines = pool<'line'>();
  private readonly tickLabels = pool<'text'>();
  private readonly nameLabels = pool<'text'>();
  private readonly bracketPaths = pool<'path'>();
  private readonly bracketLabels = pool<'text'>();

  bind(id: string): void {
    this.root = document.getElementById(id) as SVGSVGElement | null;
  }

  hide(): void {
    if (this.root) this.root.style.display = 'none';
  }

  /**
   * Pose the ruler for this frame. `opacity` fades it with the opening.
   * Points are projected with the camera as it is; the caller has already
   * updated the camera's matrices for the frame.
   */
  render(layout: RulerLayout, camera: THREE.Camera, width: number, height: number, opacity: number): void {
    const root = this.root;
    if (!root) return;
    if (opacity <= 0.01) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    root.style.opacity = opacity.toFixed(3);
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const toScreen = (point: THREE.Vector3): [number, number] | null => {
      projected.copy(point).project(camera);
      if (projected.z > 1) return null;
      return [((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height];
    };

    // The ruler's screen direction, rim to centre, and its perpendicular (ticks go "up").
    const rim = toScreen(layout.ticks[0]?.point ?? new THREE.Vector3());
    const centre = toScreen(layout.ticks[layout.ticks.length - 1]?.point ?? new THREE.Vector3());
    let dirX = 1;
    let dirY = 0;
    if (rim && centre) {
      const dx = centre[0] - rim[0];
      const dy = centre[1] - rim[1];
      const length = Math.hypot(dx, dy) || 1;
      dirX = dx / length;
      dirY = dy / length;
    }
    let perpX = -dirY;
    let perpY = dirX;
    if (perpY > 0) {
      perpX = -perpX;
      perpY = -perpY;
    }

    // Segments: one line per region along the terraces.
    for (const segment of layout.segments) {
      const from = toScreen(segment.from);
      const to = toScreen(segment.to);
      if (!from || !to) continue;
      const line = take(root, 'line', 'ruler-seg', this.segmentLines);
      line.setAttribute('x1', from[0].toFixed(1));
      line.setAttribute('y1', from[1].toFixed(1));
      line.setAttribute('x2', to[0].toFixed(1));
      line.setAttribute('y2', to[1].toFixed(1));
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (length >= NAME_MIN_SEGMENT_PX) {
        const label = take(root, 'text', 'ruler-name', this.nameLabels);
        const midX = (from[0] + to[0]) / 2 - perpX * NAME_GAP_PX;
        const midY = (from[1] + to[1]) / 2 - perpY * NAME_GAP_PX;
        label.setAttribute('x', midX.toFixed(1));
        label.setAttribute('y', midY.toFixed(1));
        label.textContent = segment.name;
      }
    }
    release(this.segmentLines);
    release(this.nameLabels);

    // Ticks, labels thinned to the spacing the projection leaves.
    let lastLabelX = -Infinity;
    let lastLabelY = -Infinity;
    let lastLabelText = '';
    for (const tick of layout.ticks) {
      const at = toScreen(tick.point);
      if (!at) continue;
      const line = take(root, 'line', tick.major ? 'ruler-tick' : 'ruler-tick minor', this.tickLines);
      line.setAttribute('x1', at[0].toFixed(1));
      line.setAttribute('y1', at[1].toFixed(1));
      line.setAttribute('x2', (at[0] + perpX * TICK_PX).toFixed(1));
      line.setAttribute('y2', (at[1] + perpY * TICK_PX).toFixed(1));
      const text = tick.depthKm === 0 ? '0 km' : formatKm(tick.depthKm);
      const spacing = Math.hypot(at[0] - lastLabelX, at[1] - lastLabelY);
      const needed = ((lastLabelText.length + text.length) / 2) * LABEL_GLYPH_PX + LABEL_MIN_GAP_PX;
      if (tick.major && spacing >= needed) {
        const label = take(root, 'text', 'ruler-label', this.tickLabels);
        label.setAttribute('x', (at[0] + perpX * LABEL_GAP_PX).toFixed(1));
        label.setAttribute('y', (at[1] + perpY * LABEL_GAP_PX).toFixed(1));
        label.textContent = text;
        lastLabelX = at[0];
        lastLabelY = at[1];
        lastLabelText = text;
      }
    }
    release(this.tickLines);
    release(this.tickLabels);

    // Brackets: a second tier below the names, stepping down where spans overlap
    // along the ruler (the lithosphere and the transition zone sit close at the rim).
    const placed: { tier: number; low: number; high: number }[] = [];
    for (const bracket of layout.brackets) {
      const from = toScreen(bracket.from);
      const to = toScreen(bracket.to);
      if (!from || !to) continue;
      const alongFrom = (from[0] - (rim?.[0] ?? 0)) * dirX + (from[1] - (rim?.[1] ?? 0)) * dirY;
      const alongTo = (to[0] - (rim?.[0] ?? 0)) * dirX + (to[1] - (rim?.[1] ?? 0)) * dirY;
      const low = Math.min(alongFrom, alongTo) - BRACKET_PAD_PX;
      const high = Math.max(alongFrom, alongTo) + BRACKET_PAD_PX;
      let tier = 0;
      while (placed.some((other) => other.tier === tier && other.low < high && other.high > low)) tier++;
      placed.push({ tier, low, high });
      const gap = BRACKET_GAP_PX + tier * BRACKET_TIER_PX;
      const offsetX = -perpX * gap;
      const offsetY = -perpY * gap;
      const armX = perpX * BRACKET_ARM_PX;
      const armY = perpY * BRACKET_ARM_PX;
      const path = take(root, 'path', 'ruler-bracket', this.bracketPaths);
      path.setAttribute('d', [
        `M ${(from[0] + offsetX + armX).toFixed(1)} ${(from[1] + offsetY + armY).toFixed(1)}`,
        `L ${(from[0] + offsetX).toFixed(1)} ${(from[1] + offsetY).toFixed(1)}`,
        `L ${(to[0] + offsetX).toFixed(1)} ${(to[1] + offsetY).toFixed(1)}`,
        `L ${(to[0] + offsetX + armX).toFixed(1)} ${(to[1] + offsetY + armY).toFixed(1)}`,
      ].join(' '));
      if (high - low - 2 * BRACKET_PAD_PX < BRACKET_NAME_MIN_PX) continue;
      const label = take(root, 'text', 'ruler-bracket-name', this.bracketLabels);
      label.setAttribute('x', ((from[0] + to[0]) / 2 + offsetX - perpX * LABEL_GAP_PX).toFixed(1));
      label.setAttribute('y', ((from[1] + to[1]) / 2 + offsetY - perpY * LABEL_GAP_PX).toFixed(1));
      label.textContent = bracket.name;
    }
    release(this.bracketPaths);
    release(this.bracketLabels);
  }
}
