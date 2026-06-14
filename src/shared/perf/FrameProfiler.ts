/**
 * Lightweight per-section frame profiler for the animation loop.
 *
 * Zero-overhead when disabled: `begin`/`end`/`beginFrame`/`endFrame` all
 * early-return on the `enabled` flag, so the instrumentation can stay wired
 * into the shipped hot path. Enable it at runtime (the backquote `` ` `` key,
 * see `wireProfilerHotkey`) or at boot with `?profile=1`.
 *
 * While enabled it accumulates wall-clock time per named section, then every
 * `reportEveryFrames` frames prints a rolling table — per-frame average ms,
 * worst-frame ms, and share of the frame — to a fixed on-screen overlay and
 * (once per report) the console. A section is any code wrapped in
 * `begin(label)`/`end(label)`; `endFrame()` closes the frame and owns the
 * report cadence. The whole instance is exported as the `profiler` singleton
 * and mirrored onto `window.__profiler` for devtools/automation.
 *
 * Framework-free (no Three.js): just `performance.now()` and a little DOM for
 * the overlay, created lazily on first report.
 */

interface Section {
  /** Summed wall-clock time across the current reporting window (ms). */
  total: number;
  /** Number of `end()` calls in the window (sections may run 0–1×/frame). */
  calls: number;
  /** Worst single `begin→end` span in the window (ms). */
  max: number;
}

function blankSection(): Section {
  return { total: 0, calls: 0, max: 0 };
}

export class FrameProfiler {
  enabled = false;
  /** Frames between rolling reports. */
  reportEveryFrames = 60;

  private readonly sections = new Map<string, Section>();
  /** Insertion order, so the report reads top-to-bottom like the update loop. */
  private readonly order: string[] = [];
  private readonly starts = new Map<string, number>();

  private frameStart = 0;
  private framesInWindow = 0;
  private frameTotal = 0; // summed full-frame ms across the window
  private frameMax = 0;

  private overlay: HTMLElement | null = null;
  private lastReport = '';

  enable(): void {
    this.enabled = true;
    this.reset();
    if (this.overlay) this.overlay.style.display = 'block';
  }

  disable(): void {
    this.enabled = false;
    this.starts.clear();
    if (this.overlay) this.overlay.style.display = 'none';
  }

  toggle(): void {
    if (this.enabled) this.disable();
    else this.enable();
  }

  /** Mark the start of a section. Cheap no-op while disabled. */
  begin(label: string): void {
    if (!this.enabled) return;
    this.starts.set(label, performance.now());
  }

  /** Close a section opened with the same label, folding its span into stats. */
  end(label: string): void {
    if (!this.enabled) return;
    const start = this.starts.get(label);
    if (start === undefined) return;
    const span = performance.now() - start;
    this.starts.delete(label);
    let section = this.sections.get(label);
    if (!section) {
      section = blankSection();
      this.sections.set(label, section);
      this.order.push(label);
    }
    section.total += span;
    section.calls++;
    if (span > section.max) section.max = span;
  }

  /** Time a synchronous callback as a section. Returns the callback's result. */
  measure<T>(label: string, fn: () => T): T {
    if (!this.enabled) return fn();
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end(label);
    }
  }

  /** Open a frame (call once at the top of the animation-loop body). */
  beginFrame(): void {
    if (!this.enabled) return;
    this.frameStart = performance.now();
  }

  /**
   * Close a frame and, every `reportEveryFrames`, emit the rolling report and
   * reset the window. Call once at the very end of the animation-loop body.
   */
  endFrame(): void {
    if (!this.enabled) return;
    const span = performance.now() - this.frameStart;
    this.frameTotal += span;
    if (span > this.frameMax) this.frameMax = span;
    this.framesInWindow++;
    if (this.framesInWindow >= this.reportEveryFrames) this.report();
  }

  private reset(): void {
    this.sections.clear();
    this.order.length = 0;
    this.starts.clear();
    this.framesInWindow = 0;
    this.frameTotal = 0;
    this.frameMax = 0;
  }

  /** Build the report text, write it to the overlay + console, and reset. */
  private report(): void {
    const frames = this.framesInWindow || 1;
    const avgFrameMs = this.frameTotal / frames;
    const fps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;

    const rows: string[] = [];
    rows.push(
      `FRAME  avg ${avgFrameMs.toFixed(2)}ms  max ${this.frameMax.toFixed(2)}ms  ~${fps.toFixed(0)} fps  (${frames} frames)`,
    );
    rows.push('────────────────────────────────────────────');
    for (const label of this.order) {
      const s = this.sections.get(label)!;
      const avg = s.total / frames; // per-frame avg (sections may run <1×/frame)
      const share = avgFrameMs > 0 ? (avg / avgFrameMs) * 100 : 0;
      rows.push(
        `${label.padEnd(16)} ${avg.toFixed(3).padStart(7)}ms  ` +
          `${share.toFixed(0).padStart(3)}%  max ${s.max.toFixed(2)}ms`,
      );
    }
    const text = rows.join('\n');
    this.lastReport = text;
    this.writeOverlay(text);
    // eslint-disable-next-line no-console
    console.log(`[profiler]\n${text}`);
    this.reset();
  }

  /** Most recent report text (also handy for automation reading the overlay). */
  getLastReport(): string {
    return this.lastReport;
  }

  private writeOverlay(text: string): void {
    if (typeof document === 'undefined') return;
    if (!this.overlay) {
      const el = document.createElement('pre');
      el.id = 'frame-profiler-overlay';
      el.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'z-index:99999',
        'margin:0',
        'padding:8px 10px',
        'background:rgba(0,0,0,0.72)',
        'color:#7CFC9A',
        'font:11px/1.35 ui-monospace,Menlo,Consolas,monospace',
        'white-space:pre',
        'pointer-events:none',
        'border-radius:6px',
        'border:1px solid rgba(124,252,154,0.25)',
      ].join(';');
      document.body.appendChild(el);
      this.overlay = el;
    }
    this.overlay.textContent = text;
    this.overlay.style.display = 'block';
  }
}

/** Shared singleton — import this and instrument the loop in place. */
export const profiler = new FrameProfiler();

if (typeof window !== 'undefined') {
  (window as unknown as { __profiler: FrameProfiler }).__profiler = profiler;
}

/**
 * Boot wiring: turn the profiler on if the page URL carries `?profile=1`, and
 * bind the backquote (`` ` ``) key to toggle it at runtime. Safe to call once
 * during app init. The key listener ignores repeats and typing into inputs.
 */
export function wireProfilerHotkey(): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('profile') === '1') profiler.enable();
  } catch {
    /* URL parsing can throw in exotic embeddings — ignore. */
  }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.repeat) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    profiler.toggle();
  });
}
