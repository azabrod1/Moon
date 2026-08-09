/**
 * The chart's compressed↔true blend, as a small state machine — pure, no THREE,
 * no DOM.
 *
 * The blend has two readers that must never disagree: `blend` is what the
 * geometry is currently projected at, and `to` is what the scale control says
 * it is. The animation slides the first toward the second, and everything else
 * — closing the chart, reopening it, a corner chart that draws at its own
 * fixed scale — has to leave them reconciled. A `blend` left standing away from
 * `to` draws one picture under a control that names another, and the control
 * refuses the press that would fix it (asking for the target it already holds
 * is a no-op).
 *
 * `parked` is what makes the corner chart safe: it always draws compressed,
 * whatever the full chart's control is set to, so it displaces `blend` and
 * hands the displaced value back when it is done. A leak — a corner chart that
 * never hands back — is caught by the reconcile the full chart runs on open.
 */
import {
  MAP_BLEND_ANIM_MS,
  MAP_BLEND_COMPRESSED,
  MAP_BLEND_TRUE,
} from './mapProjection';
import { smoothstepUnclamped } from '../../shared/math/smoothstep';

export interface MapBlendState {
  /** What the geometry is projected at right now. */
  blend: number;
  /** Where the running animation started, and where it is going. */
  from: number;
  to: number;
  elapsedMs: number;
  animating: boolean;
  /**
   * The blend a corner-chart pass displaced, held until it hands back; null
   * when the chart's own blend is the one standing.
   */
  parked: number | null;
}

export function makeMapBlendState(): MapBlendState {
  return {
    blend: MAP_BLEND_COMPRESSED,
    from: MAP_BLEND_COMPRESSED,
    to: MAP_BLEND_COMPRESSED,
    elapsedMs: 0,
    animating: false,
    parked: null,
  };
}

/**
 * The scale control was pressed. Returns whether the request took — false for
 * the target already committed and settled, which is the caller's "the toggle
 * is inert here" answer.
 */
export function blendRequestScale(state: MapBlendState, trueScale: boolean): boolean {
  const target = trueScale ? MAP_BLEND_TRUE : MAP_BLEND_COMPRESSED;
  if (Math.abs(target - state.to) < 1e-9 && !state.animating) return false;
  state.from = state.blend;
  state.to = target;
  state.elapsedMs = 0;
  state.animating = true;
  return true;
}

/** Advance a running animation by a frame. Returns whether the blend moved. */
export function blendAdvance(state: MapBlendState, dtMs: number): boolean {
  if (!state.animating) return false;
  state.elapsedMs = Math.min(state.elapsedMs + dtMs, MAP_BLEND_ANIM_MS);
  const t = state.elapsedMs / MAP_BLEND_ANIM_MS;
  state.blend = state.from + (state.to - state.from) * smoothstepUnclamped(t);
  if (t >= 1) {
    state.blend = state.to;
    state.animating = false;
  }
  return true;
}

/**
 * Settle on close: a shut chart has nothing to animate, and the committed
 * target is what it reopens at.
 */
export function blendSettle(state: MapBlendState): void {
  state.blend = state.to;
  state.from = state.to;
  state.elapsedMs = 0;
  state.animating = false;
}

/**
 * A corner-chart pass takes the blend: it draws compressed regardless of the
 * control's target. Idempotent — a second pass finds the value already parked.
 * Returns whether `blend` actually moved (the caller reprojects if so).
 */
export function blendParkCompressed(state: MapBlendState): boolean {
  if (state.parked === null) state.parked = state.blend;
  if (state.blend === MAP_BLEND_COMPRESSED) return false;
  state.blend = MAP_BLEND_COMPRESSED;
  return true;
}

/** Hand the displaced blend back. Returns whether `blend` moved. */
export function blendUnpark(state: MapBlendState): boolean {
  if (state.parked === null) return false;
  const restored = state.parked;
  state.parked = null;
  if (state.blend === restored) return false;
  state.blend = restored;
  return true;
}

/**
 * The full chart is opening: whatever happened while it was shut, it draws at
 * the scale its control claims. Returns whether `blend` moved.
 */
export function blendReconcile(state: MapBlendState): boolean {
  state.parked = null;
  state.from = state.to;
  state.elapsedMs = 0;
  state.animating = false;
  if (state.blend === state.to) return false;
  state.blend = state.to;
  return true;
}

/** Whether the committed target is true scale (the control's own reading). */
export function blendIsTrueScale(state: MapBlendState): boolean {
  return state.to >= MAP_BLEND_TRUE - 1e-6;
}
