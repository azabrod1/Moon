export interface HyperspaceOrigin {
  /** Normalized viewport position, left to right. */
  x: number;
  /** Normalized viewport position, top to bottom. */
  y: number;
}

export interface HyperspaceMotion {
  speed: number;
  trail: number;
  flash: number;
  tunnel: number;
}

export const HYPERSPACE_ACCEL_MS = 440;
export const HYPERSPACE_EXIT_MS = 420;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth01 = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

/** Pure timing policy shared with tests and the canvas renderer. */
export function hyperspaceMotion(elapsedMs: number, exitElapsedMs: number | null): HyperspaceMotion {
  if (exitElapsedMs !== null) {
    const exit = smooth01(exitElapsedMs / HYPERSPACE_EXIT_MS);
    return {
      speed: mix(1.62, 0.045, exit),
      trail: mix(0.34, 0.003, exit),
      flash: Math.sin(Math.PI * exit) ** 2,
      tunnel: mix(1, 0.04, exit),
    };
  }
  const acceleration = smooth01(elapsedMs / HYPERSPACE_ACCEL_MS);
  // The classic jump blooms just as point stars finish becoming streaks,
  // before resolving into the sustained blue simu-tunnel.
  const entryFlashDistance = (elapsedMs - HYPERSPACE_ACCEL_MS) / 115;
  return {
    speed: mix(0.045, 1.62, acceleration),
    trail: mix(0.003, 0.34, acceleration),
    flash: Math.exp(-(entryFlashDistance * entryFlashDistance)),
    tunnel: smooth01((elapsedMs - 220) / 430),
  };
}

/** Pure perspective helpers: lower depth means the star moved toward the
 * viewer, which must increase its distance from the ship-centered vanishing
 * point on every rendered frame. */
export function advanceHyperspaceDepth(depth: number, speed: number, deltaSeconds: number): number {
  return depth - speed * Math.max(0, deltaSeconds);
}

export function projectedHyperspaceRadius(radius: number, depth: number): number {
  return radius / Math.max(depth, 0.055);
}

interface HyperspaceStar {
  angle: number;
  radius: number;
  z: number;
  brightness: number;
  width: number;
  blue: boolean;
  twist: number;
}

/** Perspective-projected star tunnel anchored to the spacecraft on screen. */
export class HyperspaceEffect {
  private readonly context: CanvasRenderingContext2D | null;
  private stars: HyperspaceStar[] = [];
  private frameId: number | null = null;
  private startedAtMs = 0;
  private previousFrameMs = 0;
  private exitStartedAtMs: number | null = null;
  private origin: HyperspaceOrigin = { x: 0.5, y: 0.5 };
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private randomState = 0x6d2b79f5;

  constructor(private readonly canvas: HTMLCanvasElement) {
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d', { alpha: true });
    } catch {
      // Canvas 2D is optional in headless test DOMs; the travel cover still
      // works there, while a real browser always supplies the renderer.
    }
    this.context = context;
  }

  start(origin: HyperspaceOrigin): void {
    this.stop();
    if (!this.context) return;
    this.origin = { x: clamp01(origin.x), y: clamp01(origin.y) };
    this.resize();
    this.randomState = 0x6d2b79f5;
    const mobile = this.cssWidth <= 640;
    const starCount = mobile ? 440 : 760;
    this.stars = Array.from({ length: starCount }, () => this.makeStar(0.08, 1.35));
    this.startedAtMs = performance.now();
    this.previousFrameMs = this.startedAtMs;
    this.exitStartedAtMs = null;
    this.frameId = requestAnimationFrame(this.renderFrame);
  }

  beginExit(): number {
    if (this.frameId === null) return 0;
    if (this.exitStartedAtMs === null) this.exitStartedAtMs = performance.now();
    return HYPERSPACE_EXIT_MS;
  }

  stop(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.exitStartedAtMs = null;
    if (this.context) {
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = Math.max(1, rect.width || window.innerWidth);
    this.cssHeight = Math.max(1, rect.height || window.innerHeight);
    this.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.cssWidth * this.pixelRatio);
    this.canvas.height = Math.round(this.cssHeight * this.pixelRatio);
  }

  private random(): number {
    let state = this.randomState += 0x6d2b79f5;
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  }

  private makeStar(minZ: number, maxZ: number): HyperspaceStar {
    const angle = this.random() * Math.PI * 2;
    // Sqrt produces uniform density across the projected disc. The small
    // central exclusion keeps the ship itself readable at the vanishing point.
    const radius = 0.07 + Math.sqrt(this.random()) * 0.92;
    return {
      angle,
      radius,
      z: mix(minZ, maxZ, this.random()),
      brightness: mix(0.42, 1, this.random()),
      width: mix(0.55, 1.7, this.random()),
      blue: this.random() < 0.48,
      twist: mix(-0.16, 0.2, this.random()),
    };
  }

  private resetStar(star: HyperspaceStar): void {
    const replacement = this.makeStar(1.05, 1.42);
    Object.assign(star, replacement);
  }

  private readonly renderFrame = (nowMs: number): void => {
    const context = this.context;
    if (!context || this.frameId === null) return;
    const dt = Math.min(0.04, Math.max(0, (nowMs - this.previousFrameMs) / 1000));
    this.previousFrameMs = nowMs;
    const elapsedMs = nowMs - this.startedAtMs;
    const exitElapsedMs = this.exitStartedAtMs === null ? null : nowMs - this.exitStartedAtMs;
    const motion = hyperspaceMotion(elapsedMs, exitElapsedMs);

    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const originX = this.origin.x * this.cssWidth;
    const originY = this.origin.y * this.cssHeight;
    const projectionScale = Math.min(this.cssWidth, this.cssHeight) * 0.68;

    const tunnelGlow = context.createRadialGradient(
      originX, originY, 0,
      originX, originY, Math.max(this.cssWidth, this.cssHeight) * 0.75,
    );
    tunnelGlow.addColorStop(0, `rgba(229, 247, 255, ${0.08 + motion.flash * 0.68})`);
    tunnelGlow.addColorStop(0.075, `rgba(79, 159, 255, ${0.07 + motion.flash * 0.26})`);
    tunnelGlow.addColorStop(0.38, `rgba(11, 35, 94, ${0.13 + motion.tunnel * 0.12})`);
    tunnelGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = tunnelGlow;
    context.fillRect(0, 0, this.cssWidth, this.cssHeight);

    // Concentric blue fronts continuously expand out of the vanishing point.
    // They are deliberately faint; the moving star heads below remain the
    // primary speed cue, while these fronts turn the sustained phase into the
    // canonical swirling-blue tunnel instead of a frozen radial burst.
    if (motion.tunnel > 0.01) {
      context.save();
      context.globalCompositeOperation = 'lighter';
      for (let ringIndex = 0; ringIndex < 8; ringIndex++) {
        const phase = ((elapsedMs * 0.00042 * motion.speed) + ringIndex / 8) % 1;
        const radius = mix(0.08, 1.24, phase * phase) * Math.max(this.cssWidth, this.cssHeight);
        context.strokeStyle = `rgba(55, 125, 255, ${(1 - phase) * motion.tunnel * 0.12})`;
        context.lineWidth = mix(1.2, 5.5, phase);
        context.beginPath();
        context.ellipse(originX, originY, radius, radius * 0.62, 0, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    }

    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    for (const star of this.stars) {
      star.z = advanceHyperspaceDepth(star.z, motion.speed, dt);
      star.angle += (0.055 + star.twist) * motion.tunnel * dt;
      if (star.z < 0.055) this.resetStar(star);
      const tailZ = Math.min(1.5, star.z + motion.trail * (0.62 + star.brightness * 0.72));
      const tailAngle = star.angle - (0.055 + star.twist) * motion.trail * 0.36;
      const headRadius = projectedHyperspaceRadius(star.radius, star.z) * projectionScale;
      const tailRadius = projectedHyperspaceRadius(star.radius, tailZ) * projectionScale;
      const headX = originX + Math.cos(star.angle) * headRadius;
      const headY = originY + Math.sin(star.angle) * headRadius;
      const tailX = originX + Math.cos(tailAngle) * tailRadius;
      const tailY = originY + Math.sin(tailAngle) * tailRadius;
      const margin = 180;
      if (
        (headX < -margin || headX > this.cssWidth + margin || headY < -margin || headY > this.cssHeight + margin) &&
        (tailX < -margin || tailX > this.cssWidth + margin || tailY < -margin || tailY > this.cssHeight + margin)
      ) {
        this.resetStar(star);
        continue;
      }
      const depth = clamp01(1 - star.z / 1.42);
      const alpha = star.brightness * mix(0.28, 0.96, depth) * (exitElapsedMs === null ? 1 : mix(1, 0.22, clamp01(exitElapsedMs / HYPERSPACE_EXIT_MS)));
      // A saturated outer streak and narrow white-hot core produce the moving
      // photographic-light-trail look; the luminous head visibly advances
      // from frame to frame instead of leaving a static radial line.
      context.strokeStyle = star.blue
        ? `rgba(63, 135, 255, ${alpha * 0.78})`
        : `rgba(148, 204, 255, ${alpha * 0.66})`;
      context.lineWidth = star.width * mix(1.25, 4.6, depth);
      context.beginPath();
      context.moveTo(tailX, tailY);
      const controlRadius = (headRadius + tailRadius) * 0.5;
      const controlAngle = (star.angle + tailAngle) * 0.5 + star.twist * 0.025;
      context.quadraticCurveTo(
        originX + Math.cos(controlAngle) * controlRadius,
        originY + Math.sin(controlAngle) * controlRadius,
        headX,
        headY,
      );
      context.stroke();

      context.strokeStyle = `rgba(244, 251, 255, ${alpha})`;
      context.lineWidth = Math.max(0.55, star.width * mix(0.45, 1.35, depth));
      context.beginPath();
      context.moveTo(tailX, tailY);
      context.lineTo(headX, headY);
      context.stroke();

      context.fillStyle = `rgba(255, 255, 255, ${Math.min(1, alpha * 1.16)})`;
      context.beginPath();
      context.arc(headX, headY, Math.max(0.75, context.lineWidth * 0.72), 0, Math.PI * 2);
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';

    if (motion.flash > 0.01) {
      const flash = context.createRadialGradient(originX, originY, 0, originX, originY, projectionScale * 0.34);
      flash.addColorStop(0, `rgba(255, 255, 255, ${motion.flash * 0.9})`);
      flash.addColorStop(0.2, `rgba(151, 215, 255, ${motion.flash * 0.46})`);
      flash.addColorStop(1, 'rgba(75, 148, 255, 0)');
      context.fillStyle = flash;
      context.fillRect(0, 0, this.cssWidth, this.cssHeight);
      context.fillStyle = `rgba(215, 237, 255, ${motion.flash * 0.1})`;
      context.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }

    this.frameId = requestAnimationFrame(this.renderFrame);
  };
}
