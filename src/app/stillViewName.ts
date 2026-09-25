/**
 * stillViewName — a name for the view a frame showed, so the GPU clock can
 * tell two readings taken seconds apart of ONE scene from readings of two
 * (app/resolutionController.ts `IntervalSample.sceneKey`, which compares two
 * rungs and learns how a device's frames grow only under one name).
 *
 * The name is a number that stays the same while the view does: the same body
 * ridden (or none), the camera's aim within `STILL_VIEW_AIM_DEG` of where the
 * name was given, and the displayed field of view within `STILL_VIEW_FOV_SHARE`
 * of it — the DESIGN field of view (`displayFovDeg`), never `camera.fov`,
 * which holds the lens's overscan. An Observatory zoom is a new name, because
 * a narrower field puts the same pixels on a different piece of sky. Where the
 * view cannot be still for seconds at a time — the ship under way, a fast
 * clock, another mode, or a frame the clock cannot use at all — there is no
 * name, and the next view that can be named gets a new one.
 *
 * Pure and allocation-free: stepped once a drawn frame with plain numbers.
 */

/** How far the aim may turn under one name. */
export const STILL_VIEW_AIM_DEG = 2;

/** How far the displayed field of view may change under one name, as a
 *  share of it. */
export const STILL_VIEW_FOV_SHARE = 0.02;

/** Two unit quaternions' aims differ by twice the angle whose cosine is the
 *  magnitude of their dot product. */
const AIM_DOT = Math.cos(((STILL_VIEW_AIM_DEG / 2) * Math.PI) / 180);

export interface Aim { x: number; y: number; z: number; w: number }

export class StillViewNamer {
  private seq = 0;
  private body: string | null = null;
  private ax = 0;
  private ay = 0;
  private az = 0;
  private aw = 1;
  private fovDeg = NaN;

  /** The name of this frame's view: `body` is what the ship rides ('' for
   *  none) or null where the view cannot be still. */
  name(body: string | null, aim: Aim, fovDeg: number): number | null {
    if (body === null || !(fovDeg > 0)) {
      this.forget();
      return null;
    }
    const dot = Math.abs(aim.x * this.ax + aim.y * this.ay + aim.z * this.az + aim.w * this.aw);
    const zoomed = !(Math.abs(fovDeg - this.fovDeg) <= STILL_VIEW_FOV_SHARE * this.fovDeg);
    if (body !== this.body || dot < AIM_DOT || zoomed) {
      this.body = body;
      this.ax = aim.x;
      this.ay = aim.y;
      this.az = aim.z;
      this.aw = aim.w;
      this.fovDeg = fovDeg;
      this.seq++;
    }
    return this.seq;
  }

  /** No name for this frame: the next view that has one is a new one. */
  forget(): void {
    this.body = null;
  }
}
