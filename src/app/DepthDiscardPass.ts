/**
 * The scene target's depth and stencil, told to the driver as no longer needed.
 *
 * The composer's scene target carries a packed depth/stencil plane: the world
 * is drawn with depth testing, and the orbit lines stamp a stencil the décor
 * point fields test against (world/orbitLineStencil.ts). Both of those live
 * INSIDE the scene render pass. Every pass after it — the lens warp, the
 * bloom chain, the output transform — is a full-screen quad that reads the
 * target's colour and nothing else, and the next frame's RenderPass clears
 * depth and stencil before it draws.
 *
 * So from the end of the scene pass to the end of the frame, that plane is
 * write-only garbage — and on a tile-based GPU it is written all the way out
 * to memory anyway, because the driver has no way to know it will never be
 * read. `invalidateFramebuffer` is that way. three does this itself, but only
 * for multisampled targets, where it falls out of resolving them; a target
 * with no samples — which is what the mobile profile builds — stores the whole
 * plane every frame for nothing.
 *
 * Pixel-identical by definition: it discards a buffer that has no reader.
 * WebGL2 only, and silently nothing anywhere else.
 */
import { Pass } from 'three/addons/postprocessing/Pass.js';
import type * as THREE from 'three';

export class DepthDiscardPass extends Pass {
  constructor() {
    super();
    // Nothing is drawn and no buffer is written, so the composer must not
    // treat this as a step in the ping-pong.
    this.needsSwap = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const gl = renderer.getContext() as WebGL2RenderingContext & { invalidateFramebuffer?: unknown };
    if (typeof gl.invalidateFramebuffer !== 'function') return;
    // Bind the target the scene was drawn into: the invalidation names an
    // attachment of whatever framebuffer is bound, and the pass before this
    // one may have left another.
    renderer.setRenderTarget(readBuffer);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_STENCIL_ATTACHMENT]);
  }
}
