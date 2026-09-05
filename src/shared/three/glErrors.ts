/**
 * One bounded drain of the WebGL error queue, shared by the probes that need
 * to hand the context back clean.
 */

/** Empties the GL error queue so nothing raised earlier is blamed on a probe —
 *  and nothing a probe raised is blamed on the frame after it. Bounded: a
 *  context that answers with an error forever (a lost one does) must not spin
 *  the caller. */
export function drainErrors(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drained */ }
}
