/**
 * Boot render gate: whether the animation loop draws the world this frame.
 *
 * From the first animation frame until the loading screen goes, the canvas is
 * covered by an opaque screen, and every world frame drawn behind it — the
 * scene render, the lens pass, the bloom chain, the output pass, at full
 * device resolution — is GPU time taken from the texture decodes and uploads
 * the boot is waiting on (2–3 s on a fast network, much longer on a phone).
 * So while covered the loop draws only on request:
 *  - once after every composer build (`requestCoveredRender`), so the
 *    composer's own passes link their programs under the cover (the shader
 *    warm-up, world/shaderWarmup.ts, compiles scene materials, not passes);
 *  - once synchronously right before the screen is hidden (the reveal site
 *    renders, then marks the gate live), so the frame under the fade is
 *    fresh and no link is paid on a visible frame.
 * Live, every frame draws as before. Failed — the boot error screen, which
 * is opaque and stays — nothing draws at all. The simulation (`update`) runs
 * every frame in every state; only the draw is gated.
 */

export type BootRenderState = 'covered' | 'live' | 'failed';

export class BootRenderGate {
  private state: BootRenderState = 'covered';
  private requested = false;
  /** Frames drawn while covered (DEV telemetry, the boot battery reads it). */
  coveredRenders = 0;

  get current(): BootRenderState {
    return this.state;
  }

  /** The composer was (re)built: draw one frame under the cover. */
  requestCoveredRender(): void {
    if (this.state === 'covered') this.requested = true;
  }

  /** The loading screen is about to go: from here every frame draws. */
  markLive(): void {
    this.state = 'live';
    this.requested = false;
  }

  /** The boot failed and the error screen owns the canvas for good. */
  markFailed(): void {
    this.state = 'failed';
    this.requested = false;
  }

  /** Called once per animation frame; true means draw the world this frame. */
  shouldRender(): boolean {
    if (this.state === 'live') return true;
    if (this.state === 'failed') return false;
    if (!this.requested) return false;
    this.requested = false;
    this.coveredRenders++;
    return true;
  }
}
