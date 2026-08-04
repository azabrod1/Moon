import { describe, it, expect } from 'vitest';
import {
  blendAdvance,
  blendIsTrueScale,
  blendParkCompressed,
  blendReconcile,
  blendRequestScale,
  blendSettle,
  blendUnpark,
  makeMapBlendState,
} from './mapBlend';
import { MAP_BLEND_ANIM_MS, MAP_BLEND_COMPRESSED, MAP_BLEND_TRUE } from './mapProjection';

/** Run an animation to its end, the way a run of frames would. */
function settleAnimation(state: ReturnType<typeof makeMapBlendState>) {
  for (let i = 0; i < 40; i++) {
    if (!blendAdvance(state, MAP_BLEND_ANIM_MS / 8)) break;
  }
}

describe('mapBlend', () => {
  it('starts compressed and inert', () => {
    const s = makeMapBlendState();
    expect(s.blend).toBe(MAP_BLEND_COMPRESSED);
    expect(s.to).toBe(MAP_BLEND_COMPRESSED);
    expect(blendIsTrueScale(s)).toBe(false);
    expect(blendAdvance(s, 16)).toBe(false);
  });

  it('refuses the target it already holds, and takes the other one', () => {
    const s = makeMapBlendState();
    expect(blendRequestScale(s, false)).toBe(false);
    expect(blendRequestScale(s, true)).toBe(true);
    // Mid-animation the same target is still live (the animation is running).
    expect(blendRequestScale(s, true)).toBe(true);
    settleAnimation(s);
    expect(blendRequestScale(s, true)).toBe(false);
  });

  it('animates monotonically to the committed target and stops', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    let last = s.blend;
    let steps = 0;
    while (blendAdvance(s, MAP_BLEND_ANIM_MS / 10)) {
      expect(s.blend).toBeGreaterThanOrEqual(last);
      last = s.blend;
      steps++;
      expect(steps).toBeLessThan(50);
    }
    expect(s.blend).toBe(MAP_BLEND_TRUE);
    expect(s.animating).toBe(false);
  });

  it('reads true scale off the committed target, not the live blend', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    blendAdvance(s, 1);
    expect(s.blend).toBeLessThan(MAP_BLEND_TRUE);
    expect(blendIsTrueScale(s)).toBe(true);
  });

  it('settles a half-run animation on close', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    blendAdvance(s, MAP_BLEND_ANIM_MS / 3);
    blendSettle(s);
    expect(s.blend).toBe(MAP_BLEND_TRUE);
    expect(s.animating).toBe(false);
  });

  it('parks and hands back the displaced blend', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    settleAnimation(s);
    expect(blendParkCompressed(s)).toBe(true);
    expect(s.blend).toBe(MAP_BLEND_COMPRESSED);
    // A second pass finds it already parked and asks for no reprojection.
    expect(blendParkCompressed(s)).toBe(false);
    expect(s.blend).toBe(MAP_BLEND_COMPRESSED);
    expect(blendUnpark(s)).toBe(true);
    expect(s.blend).toBe(MAP_BLEND_TRUE);
    expect(blendUnpark(s)).toBe(false);
  });

  it('parks a blend already compressed without asking for work', () => {
    const s = makeMapBlendState();
    expect(blendParkCompressed(s)).toBe(false);
    expect(s.parked).toBe(MAP_BLEND_COMPRESSED);
    expect(blendUnpark(s)).toBe(false);
    expect(s.parked).toBeNull();
  });

  it(
    'reopens at the scale the control claims, with the control live — '
    + 'even if a corner-chart pass never handed the blend back',
    () => {
      const s = makeMapBlendState();
      // The user set true scale on the full chart, and closed it.
      expect(blendRequestScale(s, true)).toBe(true);
      settleAnimation(s);
      blendSettle(s);
      expect(s.blend).toBe(MAP_BLEND_TRUE);

      // The corner chart ticks: it always draws compressed.
      blendParkCompressed(s);
      expect(s.blend).toBe(MAP_BLEND_COMPRESSED);
      expect(blendIsTrueScale(s)).toBe(true);

      // The full chart opens again — WITHOUT an unpark, the leak case.
      blendReconcile(s);
      expect(s.blend).toBe(s.to);
      expect(s.blend).toBe(MAP_BLEND_TRUE);
      expect(s.parked).toBeNull();
      // ...and the scale control still answers: the press that returns to
      // compressed is accepted, not swallowed as a no-op.
      expect(blendRequestScale(s, false)).toBe(true);
    },
  );

  it('reopens correctly through the ordinary hand-back too', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    settleAnimation(s);
    blendSettle(s);
    blendParkCompressed(s);
    blendUnpark(s);
    expect(s.blend).toBe(MAP_BLEND_TRUE);
    blendReconcile(s);
    expect(s.blend).toBe(s.to);
    expect(blendRequestScale(s, false)).toBe(true);
  });

  it('reconcile clears a half-run animation', () => {
    const s = makeMapBlendState();
    blendRequestScale(s, true);
    blendAdvance(s, MAP_BLEND_ANIM_MS / 4);
    blendReconcile(s);
    expect(s.animating).toBe(false);
    expect(s.blend).toBe(MAP_BLEND_TRUE);
    expect(blendAdvance(s, 16)).toBe(false);
  });
});
