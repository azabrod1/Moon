/**
 * Zeroing OrbitControls' damping residuals — the one place that does it.
 *
 * Damped controls keep coasting for a while after the pointer lifts. Any camera
 * move that takes the pose over (a reacquire, a reset, a scripted flight) has to
 * start from a settled controls state, or the leftover momentum is applied on
 * top of it and the move curves away from where it was aimed.
 *
 * The primary path pokes fields private to three's OrbitControls (verified in
 * r0.183.2); a rename on a three upgrade falls through to a dampingFactor pulse
 * that consumes the residuals in one update().
 */
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function flushOrbitDamping(controls: OrbitControls): void {
  const c = controls as unknown as {
    _sphericalDelta?: { set(theta: number, phi: number, radius: number): void };
    _panOffset?: { set(x: number, y: number, z: number): void };
    _scale?: number;
  };
  if (c._sphericalDelta && c._panOffset && typeof c._scale === 'number') {
    c._sphericalDelta.set(0, 0, 0);
    c._panOffset.set(0, 0, 0);
    c._scale = 1;
    return;
  }
  if (import.meta.env.DEV) {
    console.warn('OrbitControls damping fields missing — three upgrade renamed them; using dampingFactor pulse');
  }
  // Pulse damping to full so one update() applies every residual (including
  // the full pan onto controls.target and the _last*/change-event pokes),
  // then restore the pre-pulse camera pose, target, and damping factor.
  const camera = controls.object;
  const savedPos = camera.position.clone();
  const savedQuat = camera.quaternion.clone();
  const savedTarget = controls.target.clone();
  const savedDamping = controls.dampingFactor;
  controls.dampingFactor = 1;
  controls.update();
  controls.dampingFactor = savedDamping;
  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  controls.target.copy(savedTarget);
}
