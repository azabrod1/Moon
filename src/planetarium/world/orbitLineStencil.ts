/**
 * The stencil contract between the orbit lines and the décor point fields.
 *
 * Orbit-line cores draw first (renderOrder -1) and stamp the stencil buffer;
 * the starfield and the asteroid belt draw later and skip stamped pixels, so
 * a star or belt dot can never composite over a ribbon and bead it into a
 * dotted string. Alpha blending cannot express this (a dot behind a line at
 * opacity a shows through at 1-a; a belt dot is usually NEARER than an outer
 * ring, so depth can never reject it), and depth-writing the lines both chops
 * coincident rings into patches and ties out at the tiny landed/close-pass
 * near planes. Bodies (planets, moon dots, the ship) deliberately do not
 * test: something real passing in front of a chart line should cross it.
 *
 * Both planetarium render paths carry a stencil buffer for this: the
 * renderer itself (the no-float direct path) and the composer's render
 * target (main.ts).
 */
import * as THREE from 'three';

/** Stencil value the orbit-line cores stamp; décor point fields skip it. */
export const ORBIT_LINE_STENCIL_REF = 1;

/**
 * Make a décor material test-only against the orbit-line stamp. stencilWrite
 * is three's master switch for the stencil TEST too (WebGLState.setMaterial);
 * the zeroed write mask keeps the material from stamping anything itself.
 */
export function applyOrbitLineStencilGate(material: THREE.Material): void {
  material.stencilWrite = true;
  material.stencilWriteMask = 0x00;
  material.stencilFunc = THREE.NotEqualStencilFunc;
  material.stencilRef = ORBIT_LINE_STENCIL_REF;
}
