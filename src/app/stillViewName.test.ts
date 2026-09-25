import { describe, expect, it } from 'vitest';
import { STILL_VIEW_FOV_SHARE, StillViewNamer } from './stillViewName';

/** A unit quaternion turning `deg` about the vertical. */
function yaw(deg: number) {
  const half = (deg * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

describe('the still view’s name', () => {
  it('stays the same while the body, the aim and the field of view do', () => {
    const namer = new StillViewNamer();
    const a = namer.name('Earth', yaw(0), 60);
    expect(namer.name('Earth', yaw(1.5), 60)).toBe(a);
    expect(namer.name('Earth', yaw(0), 60 * (1 + STILL_VIEW_FOV_SHARE / 2))).toBe(a);
  });

  it('changes with the body ridden, an aim turned past two degrees, or a zoom past two per cent', () => {
    const namer = new StillViewNamer();
    const a = namer.name('Earth', yaw(0), 60);
    const b = namer.name('Moon', yaw(0), 60);
    expect(b).not.toBe(a);
    const c = namer.name('Moon', yaw(2.5), 60);
    expect(c).not.toBe(b);
    // An Observatory zoom from 60° to 55°.
    const d = namer.name('Moon', yaw(2.5), 55);
    expect(d).not.toBe(c);
    expect(namer.name('Moon', yaw(2.5), 55)).toBe(d);
  });

  it('has no name while the view cannot be still, and a new one after', () => {
    const namer = new StillViewNamer();
    const a = namer.name('', yaw(0), 60);
    expect(namer.name(null, yaw(0), 60)).toBeNull();
    expect(namer.name('', yaw(0), 60)).not.toBe(a);
    const b = namer.name('', yaw(0), 60);
    namer.forget();
    expect(namer.name('', yaw(0), 60)).not.toBe(b);
  });
});
