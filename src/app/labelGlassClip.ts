/**
 * Keeps the world labels from showing through the frosted panels.
 *
 * The renderer draws the panels' frosted glass itself (app/glassBackdrop.ts),
 * and it can only blur what it draws: the canvas. The world labels — planet,
 * moon, Sun and constellation names — are DOM layers above the canvas, so
 * behind a panel they stayed sharp and read straight through it ("Saturn"
 * under the Look-up card, "Moon" across the Full Moon row). Where the browser
 * blurs a panel (`?glass=0`) its backdrop filter smears them out of sight.
 *
 * So each frame the label layers are clipped around the panels the engine
 * blurs (GlassRegistry.cssBoxes): one even-odd `clip-path` with a hole per
 * panel, written only when the panels move. The engine's panels never
 * overlap (overlapping ones are handed to the browser), so even-odd never
 * re-opens an overlap. Square corners: a label tucked into a panel's rounded
 * corner is a few pixels from its edge either way.
 */
import type { GlassCssBox } from './glassRects';

/** Every full-screen layer of world labels, each fixed at the viewport's
 *  top left, so the path's coordinates are viewport pixels for all of them. */
export const WORLD_LABEL_LAYER_IDS = ['planet-labels', 'moon-labels', 'constellation-labels'] as const;

/** The clip path for a viewport with these panels cut out; '' for none. */
export function labelGlassClipPath(boxes: readonly GlassCssBox[], viewportWidth: number, viewportHeight: number): string {
  if (boxes.length === 0) return '';
  const round = (value: number) => Math.round(value * 10) / 10;
  let path = `M0 0H${round(viewportWidth)}V${round(viewportHeight)}H0Z`;
  for (const box of boxes) {
    path += `M${round(box.left)} ${round(box.top)}H${round(box.right)}V${round(box.bottom)}H${round(box.left)}Z`;
  }
  return `path(evenodd, "${path}")`;
}

let appliedClipPath = '';

/** Apply the clip to every label layer present; a no-op when unchanged. */
export function clipWorldLabelsAroundGlass(
  boxes: readonly GlassCssBox[],
  viewportWidth: number,
  viewportHeight: number,
  lookup: (id: string) => { style: { clipPath: string } } | null = (id) => document.getElementById(id),
): void {
  const clipPath = labelGlassClipPath(boxes, viewportWidth, viewportHeight);
  if (clipPath === appliedClipPath) return;
  appliedClipPath = clipPath;
  for (const id of WORLD_LABEL_LAYER_IDS) {
    const layer = lookup(id);
    if (layer) layer.style.clipPath = clipPath;
  }
}

/** Test seam: forget the last clip written. */
export function resetLabelGlassClipForTests(): void {
  appliedClipPath = '';
}
