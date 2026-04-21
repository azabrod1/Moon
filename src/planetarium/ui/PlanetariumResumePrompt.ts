/**
 * Modal shown on Planetarium activation when a saved state exists. Resolves
 * to true if the user chooses to resume, false if they start a new journey.
 * `cancel()` aborts a pending prompt (resolves false) so deactivate can
 * unblock.
 */
import type { PlanetariumState } from '../PlanetariumStore';

export class PlanetariumResumePrompt {
  private cancelPending: (() => void) | null = null;

  ask(saved: PlanetariumState): Promise<boolean> {
    return new Promise((resolve) => {
      const prompt = document.getElementById('planetarium-resume-prompt');
      if (!prompt) {
        resolve(true);
        return;
      }
      const uiOverlay = document.getElementById('ui-overlay');

      const info = document.getElementById('resume-info');
      if (info) {
        const dist = Math.sqrt(
          saved.positionAU.x ** 2 + saved.positionAU.y ** 2 + saved.positionAU.z ** 2,
        );
        info.textContent = `${dist.toFixed(2)} AU from Sun, ${saved.visitedPlanets.length} planets visited`;
      }

      uiOverlay?.classList.add('resume-active');
      prompt.classList.add('visible');

      const resumeBtn = document.getElementById('resume-btn-continue');
      const newBtn = document.getElementById('resume-btn-new');
      let settled = false;

      const cleanup = () => {
        prompt.classList.remove('visible');
        uiOverlay?.classList.remove('resume-active');
        resumeBtn?.removeEventListener('click', onResume);
        resumeBtn?.removeEventListener('pointerup', onResume);
        newBtn?.removeEventListener('click', onNew);
        newBtn?.removeEventListener('pointerup', onNew);
        if (this.cancelPending === cancel) {
          this.cancelPending = null;
        }
      };
      const finish = (shouldResume: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(shouldResume);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const onResume = () => { finish(true); };
      const onNew = () => { finish(false); };

      this.cancelPending = cancel;
      resumeBtn?.addEventListener('click', onResume);
      resumeBtn?.addEventListener('pointerup', onResume);
      newBtn?.addEventListener('click', onNew);
      newBtn?.addEventListener('pointerup', onNew);
    });
  }

  /** Abort a pending prompt (resolves `ask()` with false). No-op if none. */
  cancel(): void {
    this.cancelPending?.();
  }

  isVisible(): boolean {
    return document.getElementById('planetarium-resume-prompt')?.classList.contains('visible') ?? false;
  }
}
