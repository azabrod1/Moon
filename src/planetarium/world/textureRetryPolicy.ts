/**
 * Retry policy for texture fetches: when to try again after a failed attempt,
 * and how a wake signal (network back, tab foregrounded) pulls a pending
 * attempt forward.
 *
 * A texture that never lands costs its body a real map for the WHOLE session —
 * procedural speckle where a photograph belongs — so the ladder never runs out
 * of attempts; it only slows down. Capped exponential backoff turns a long
 * outage into a cheap poll instead of either giving up or hammering, and a
 * laptop that wakes from sleep (or a phone that comes back into signal) gets
 * its textures on the next event rather than at the end of the current wait.
 *
 * Pure and clock-free: every function takes the current time, so the whole
 * schedule is reproducible in a test.
 */

export interface TextureRetryPolicy {
  /** Wait before the first retry — short, because most failures are a blip. */
  baseDelayMs: number;
  /** Multiplier per consecutive failure. */
  growth: number;
  /** Ceiling the wait settles at, so a dead network costs one poll a minute. */
  capDelayMs: number;
  /** Fraction of the wait spread across URLs so simultaneous failures don't
   *  retry in one burst (±this much around the nominal delay). */
  ditherFraction: number;
  /** Longest stagger applied to a woken attempt, for the same reason. */
  wakeStaggerMs: number;
  /** Floor between two attempts at the same URL. Wake signals are cheap to
   *  generate (flipping browser tabs fires one each time), and without a floor
   *  they would drive a fetch loop at gesture speed. */
  minAttemptSpacingMs: number;
}

export const DEFAULT_TEXTURE_RETRY_POLICY: TextureRetryPolicy = {
  baseDelayMs: 500,
  growth: 2,
  // 45 s ± the dither stays inside a minute even at the top of the ladder.
  capDelayMs: 45_000,
  ditherFraction: 0.25,
  wakeStaggerMs: 250,
  minAttemptSpacingMs: 2_000,
};

/**
 * Stable value in [0, 1) derived from a URL. Every texture in the scene fails
 * in the same instant when a connection drops, so one shared ladder would have
 * them retrying in lockstep forever; seeding each URL's dither from its own
 * characters spreads the burst while keeping the schedule reproducible.
 */
export function urlSpread(url: string): number {
  let hash = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** How long to wait before the next attempt, given how many have failed. */
export function retryDelayMs(
  attemptsFailed: number,
  spread01: number,
  policy: TextureRetryPolicy = DEFAULT_TEXTURE_RETRY_POLICY,
): number {
  if (attemptsFailed < 1) return 0;
  const nominal = Math.min(
    policy.capDelayMs,
    policy.baseDelayMs * Math.pow(policy.growth, attemptsFailed - 1),
  );
  const spread = Math.min(1, Math.max(0, spread01));
  const dither = policy.ditherFraction;
  return Math.round(nominal * (1 - dither + 2 * dither * spread));
}

/** Stagger for an attempt a wake signal pulls forward — same anti-burst job as
 *  the backoff dither, on the shorter timescale a wake deserves. */
export function wakeStaggerMs(
  spread01: number,
  policy: TextureRetryPolicy = DEFAULT_TEXTURE_RETRY_POLICY,
): number {
  const spread = Math.min(1, Math.max(0, spread01));
  return Math.round(policy.wakeStaggerMs * spread);
}

/** One URL's retry schedule. Per request, not global: a body whose map is
 *  flapping must not push every other body's ladder out with it. */
export interface TextureRetryState {
  /** Consecutive failures so far — the rung of the ladder. */
  attemptsFailed: number;
  /** Clock time the next attempt is due, or null when none is scheduled. */
  nextAttemptAtMs: number | null;
  /** Clock time the last attempt started, or null before the first. */
  lastAttemptAtMs: number | null;
}

export function newTextureRetryState(): TextureRetryState {
  return { attemptsFailed: 0, nextAttemptAtMs: null, lastAttemptAtMs: null };
}

/** Record an attempt going out: nothing is pending while one is in flight. */
export function startAttempt(state: TextureRetryState, nowMs: number): TextureRetryState {
  return { ...state, nextAttemptAtMs: null, lastAttemptAtMs: nowMs };
}

/** Schedule the next attempt after a failure. Never returns "give up". */
export function scheduleAfterFailure(
  state: TextureRetryState,
  nowMs: number,
  spread01: number,
  policy: TextureRetryPolicy = DEFAULT_TEXTURE_RETRY_POLICY,
): TextureRetryState {
  const attemptsFailed = state.attemptsFailed + 1;
  return {
    ...state,
    attemptsFailed,
    nextAttemptAtMs: nowMs + retryDelayMs(attemptsFailed, spread01, policy),
  };
}

/**
 * Pull a pending attempt forward onto a wake signal. Only ever earlier, never
 * later: a wake that arrives while a shorter wait is already running leaves it
 * alone, and a wake with nothing pending (the fetch is in flight, or already
 * done) changes nothing. The minimum spacing keeps a stream of wake events
 * from turning into a stream of requests.
 */
export function scheduleAfterWake(
  state: TextureRetryState,
  nowMs: number,
  spread01: number,
  policy: TextureRetryPolicy = DEFAULT_TEXTURE_RETRY_POLICY,
): TextureRetryState {
  if (state.nextAttemptAtMs === null) return state;
  const earliest = state.lastAttemptAtMs === null
    ? nowMs
    : Math.max(nowMs, state.lastAttemptAtMs + policy.minAttemptSpacingMs);
  const woken = earliest + wakeStaggerMs(spread01, policy);
  if (woken >= state.nextAttemptAtMs) return state;
  return { ...state, nextAttemptAtMs: woken };
}

/** Milliseconds until the pending attempt (0 if it is already due), or null
 *  when nothing is scheduled. */
export function pendingDelayMs(state: TextureRetryState, nowMs: number): number | null {
  if (state.nextAttemptAtMs === null) return null;
  return Math.max(0, state.nextAttemptAtMs - nowMs);
}

/**
 * Whether a failure at this rung is worth a console line. The ladder runs for
 * the whole session, so logging every attempt of a genuinely missing file would
 * bury everything else; the first few failures (the ones that explain a
 * fallback) log, then it goes quiet apart from an occasional heartbeat.
 */
export function shouldLogFailure(attemptsFailed: number): boolean {
  return attemptsFailed <= 3 || attemptsFailed % 8 === 0;
}
