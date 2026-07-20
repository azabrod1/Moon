import type { HyperspaceOrigin } from './HyperspaceEffect';

export interface StarTrekWarpMotion {
  speed: number;
  trail: number;
  chroma: number;
  flare: number;
}

export interface StarTrekWarpDirection {
  /** Unit screen-space direction in which the ship's nose points. */
  x: number;
  /** Unit screen-space direction in which the ship's nose points. */
  y: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

export const STAR_TREK_WARP_ACCEL_MS = 480;
export const STAR_TREK_WARP_EXIT_MS = 380;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smooth01 = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

/** Classic TNG/Voyager timing: points become clean slit-scan streaks without
 * the blue spiral tunnel that belongs to Star Wars hyperspace. */
export function starTrekWarpMotion(elapsedMs: number, exitElapsedMs: number | null): StarTrekWarpMotion {
  if (exitElapsedMs !== null) {
    const exit = smooth01(exitElapsedMs / STAR_TREK_WARP_EXIT_MS);
    return {
      speed: mix(1.16, 0.04, exit),
      trail: mix(0.082, 0.0015, exit),
      chroma: mix(1, 0.08, exit),
      flare: Math.sin(Math.PI * exit) ** 2 * 0.48,
    };
  }
  const acceleration = smooth01(elapsedMs / STAR_TREK_WARP_ACCEL_MS);
  const jumpDistance = (elapsedMs - STAR_TREK_WARP_ACCEL_MS) / 105;
  return {
    speed: mix(0.04, 1.16, acceleration),
    trail: mix(0.0015, 0.082, acceleration),
    chroma: mix(0.08, 1, acceleration),
    flare: Math.exp(-(jumpDistance * jumpDistance)) * 0.58,
  };
}

/** Resolve the ship's projected nose direction. A near-zero projection means
 * the camera is almost exactly on the travel axis; the chase rig's canonical
 * screen-up direction is a stable fallback and avoids an arbitrary horizontal
 * field. */
export function screenSpaceWarpDirection(
  ship: ScreenPoint,
  nose: ScreenPoint,
): StarTrekWarpDirection {
  const x = nose.x - ship.x;
  const y = nose.y - ship.y;
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length < 1e-4) return { x: 0, y: -1 };
  return { x: x / length, y: y / length };
}

/** Deeper streaks cross the tracked exterior shot faster, preserving layered
 * parallax. Stars move opposite the ship's projected travel direction. */
export function advanceStarTrekWarpPoint(
  x: number,
  y: number,
  direction: StarTrekWarpDirection,
  speed: number,
  depth: number,
  deltaSeconds: number,
  out: ScreenPoint = { x: 0, y: 0 },
): ScreenPoint {
  const distance = speed * mix(0.22, 1, clamp01(depth)) * Math.max(0, deltaSeconds);
  out.x = x - direction.x * distance;
  out.y = y - direction.y * distance;
  return out;
}

/** Pick a visible coordinate on the upstream viewport edge. Keeping the
 * perpendicular coordinate inside the viewport avoids permanently invisible
 * respawns when the projected heading is almost perfectly vertical/horizontal. */
export function upstreamWarpSpawn(
  direction: StarTrekWarpDirection,
  edgeChoice: number,
  perpendicularPosition: number,
  margin: number,
): ScreenPoint {
  const xWeight = Math.abs(direction.x);
  const yWeight = Math.abs(direction.y);
  const chooseXEdge = edgeChoice < xWeight / Math.max(xWeight + yWeight, 1e-6);
  const coordinate = clamp01(perpendicularPosition);
  const safeMargin = Math.max(0, margin);
  return chooseXEdge
    ? { x: direction.x >= 0 ? 1 + safeMargin : -safeMargin, y: coordinate }
    : { x: coordinate, y: direction.y >= 0 ? 1 + safeMargin : -safeMargin };
}

interface WarpStar {
  x: number;
  y: number;
  depth: number;
  brightness: number;
  width: number;
  tint: 0 | 1 | 2;
}

const TINTS = [
  [116, 188, 255],
  [255, 218, 166],
  [196, 166, 255],
] as const;

/** Exterior Star Trek warp field: short, layered pastel/white slit-scan star
 * streaks pass opposite the tracked ship's projected heading. There are
 * deliberately no tunnel rings, spiral motion, or blue simu-tunnel wash. */
export class StarTrekWarpEffect {
  private readonly context: CanvasRenderingContext2D | null;
  private stars: WarpStar[] = [];
  private frameId: number | null = null;
  private startedAtMs = 0;
  private previousFrameMs = 0;
  private exitStartedAtMs: number | null = null;
  private origin: HyperspaceOrigin = { x: 0.5, y: 0.5 };
  private direction: StarTrekWarpDirection = { x: 0, y: -1 };
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private randomState = 0x7f4a7c15;
  private readonly advancedPoint: ScreenPoint = { x: 0, y: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d', { alpha: true });
    } catch {
      // Optional in headless DOMs; the opaque arrival cover still works.
    }
    this.context = context;
  }

  start(origin: HyperspaceOrigin, direction: StarTrekWarpDirection): void {
    this.stop();
    if (!this.context) return;
    this.origin = { x: clamp01(origin.x), y: clamp01(origin.y) };
    this.direction = screenSpaceWarpDirection({ x: 0, y: 0 }, direction);
    this.resize();
    this.randomState = 0x7f4a7c15;
    const mobile = this.cssWidth <= 640;
    const starCount = mobile ? 360 : 620;
    this.stars = Array.from({ length: starCount }, () => this.makeStar());
    this.startedAtMs = performance.now();
    this.previousFrameMs = this.startedAtMs;
    this.exitStartedAtMs = null;
    this.frameId = requestAnimationFrame(this.renderFrame);
  }

  beginExit(): number {
    if (this.frameId === null) return 0;
    if (this.exitStartedAtMs === null) this.exitStartedAtMs = performance.now();
    return STAR_TREK_WARP_EXIT_MS;
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

  private makeStar(): WarpStar {
    return {
      x: this.random(),
      y: this.random(),
      depth: mix(0.08, 1, this.random()),
      brightness: mix(0.42, 1, this.random()),
      width: mix(0.55, 1.55, this.random()),
      tint: Math.floor(this.random() * 3) as 0 | 1 | 2,
    };
  }

  private resetStar(star: WarpStar): void {
    const replacement = this.makeStar();
    const margin = mix(0.02, 0.18, this.random());
    // Stars travel opposite the ship, so replenish them on the screen edge
    // toward which the ship is headed. Diagonal travel distributes new stars
    // between both upstream edges in proportion to the heading components.
    const spawn = upstreamWarpSpawn(this.direction, this.random(), this.random(), margin);
    replacement.x = spawn.x;
    replacement.y = spawn.y;
    Object.assign(star, replacement);
  }

  private readonly renderFrame = (nowMs: number): void => {
    const context = this.context;
    if (!context || this.frameId === null) return;
    const dt = Math.min(0.04, Math.max(0, (nowMs - this.previousFrameMs) / 1000));
    this.previousFrameMs = nowMs;
    const elapsedMs = nowMs - this.startedAtMs;
    const exitElapsedMs = this.exitStartedAtMs === null ? null : nowMs - this.exitStartedAtMs;
    const motion = starTrekWarpMotion(elapsedMs, exitElapsedMs);

    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    const originX = this.origin.x * this.cssWidth;
    const originY = this.origin.y * this.cssHeight;
    if (motion.flare > 0.01) {
      const flareRadius = Math.min(this.cssWidth, this.cssHeight) * 0.24;
      const flare = context.createRadialGradient(originX, originY, 0, originX, originY, flareRadius);
      flare.addColorStop(0, `rgba(255, 255, 255, ${motion.flare * 0.3})`);
      flare.addColorStop(0.28, `rgba(174, 218, 255, ${motion.flare * 0.13})`);
      flare.addColorStop(1, 'rgba(125, 156, 255, 0)');
      context.fillStyle = flare;
      context.fillRect(0, 0, this.cssWidth, this.cssHeight);
    }
    const screenSpan = Math.hypot(
      this.direction.x * this.cssWidth,
      this.direction.y * this.cssHeight,
    );
    const speedPx = motion.speed * screenSpan;
    const trailPx = motion.trail * screenSpan;
    const normalX = -this.direction.y;
    const normalY = this.direction.x;

    for (const star of this.stars) {
      const advanced = advanceStarTrekWarpPoint(
        star.x * this.cssWidth,
        star.y * this.cssHeight,
        this.direction,
        speedPx,
        star.depth,
        dt,
        this.advancedPoint,
      );
      star.x = advanced.x / this.cssWidth;
      star.y = advanced.y / this.cssHeight;
      const headX = advanced.x;
      const headY = advanced.y;
      const trail = trailPx * mix(0.3, 1.05, star.depth);
      const tailX = headX + this.direction.x * trail;
      const tailY = headY + this.direction.y * trail;
      const margin = trail + 40;
      if (
        (headX < -margin || headX > this.cssWidth + margin || headY < -margin || headY > this.cssHeight + margin) &&
        (tailX < -margin || tailX > this.cssWidth + margin || tailY < -margin || tailY > this.cssHeight + margin)
      ) {
        this.resetStar(star);
        continue;
      }

      const alpha = star.brightness * mix(0.28, 0.9, star.depth) * (1 + motion.flare * 0.4);
      const tint = TINTS[star.tint];
      const chromaOffset = motion.chroma * mix(0.25, 1.3, star.depth);

      context.strokeStyle = `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${alpha * 0.62})`;
      context.lineWidth = star.width * mix(1, 3.1, star.depth);
      context.beginPath();
      context.moveTo(tailX + normalX * chromaOffset, tailY + normalY * chromaOffset);
      context.lineTo(headX + normalX * chromaOffset * 0.2, headY + normalY * chromaOffset * 0.2);
      context.stroke();

      context.strokeStyle = `rgba(247, 252, 255, ${Math.min(1, alpha)})`;
      context.lineWidth = Math.max(0.55, star.width * mix(0.46, 1.08, star.depth));
      context.beginPath();
      context.moveTo(tailX, tailY);
      context.lineTo(headX, headY);
      context.stroke();

      context.fillStyle = `rgba(255, 255, 255, ${Math.min(1, alpha * 1.1)})`;
      context.beginPath();
      context.arc(headX, headY, Math.max(0.65, context.lineWidth * 0.65), 0, Math.PI * 2);
      context.fill();
    }
    context.globalCompositeOperation = 'source-over';
    this.frameId = requestAnimationFrame(this.renderFrame);
  };
}
