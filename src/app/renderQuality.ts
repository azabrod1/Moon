/**
 * Graphics quality: what Low, Medium, High and Dynamic mean on the display in
 * front of the user, and the rungs Dynamic slides over.
 *
 * Everything here is a SCENE ratio — the pixel ratio the planetarium's
 * composer draws at (app/renderResolution.ts renderPixelRatio). The OUTPUT
 * ratio never moves with the level: the canvas, the sector tiles, the
 * close-range density, the System Map and the corner chart stay exactly where
 * they were, so a slide can never swap the tiles under the user.
 *
 * - **medium** is the output ratio. Today's frame, byte for byte, and the
 *   kill switch.
 * - **low** is 0.75 x the output ratio, and never below output /
 *   MAX_UPSCALE_FACTOR because EASU is specified good only to 2x linear. On a
 *   2x phone that is 1.5, the ratio RCAS's default stop was calibrated at.
 * - **high** supersamples: the largest of 1.5x and 1.25x the output ratio
 *   whose scene-sized targets fit the byte budget below AND the GL size
 *   limit. It is offered on every display that has a composer, because a
 *   resolution scale is what a game offers and the budget and the GL limit
 *   are facts about the machine rather than a guess about it. Only a fact
 *   withholds it, and then it is OMITTED rather than silently applied as
 *   medium: the no-float path, where there is no composer to resize and every
 *   level is medium; a machine whose GPU completed no multisampled half-float
 *   target (supersampleFallback — its output ratio is already the old 1.5
 *   supersample floor and the scene has no other antialiasing left); a target
 *   over the GL size limit; and the byte budget. `highOffered` says which, and
 *   `reason` says why not.
 * - **dynamic** slides over a ladder of rungs at factors that earn the two
 *   full-screen passes a rung costs: down 1, 1/1.15, 1/1.33 and up 1, 1.25,
 *   1.5, all relative to the output ratio and clamped into [low, high]. A
 *   0.1-wide notch is not on the ladder: the first such step would save a
 *   tenth of the scene, add EASU and RCAS over the whole canvas, and — RCAS's
 *   stop being calibrated at factor 1.33 — come out sharper than medium,
 *   which is a visible pop in the wrong direction.
 *
 * Dynamic's deepest rung (output / 1.33) sits a hair above Low (0.75 x
 * output) — 1.504 against 1.5 on a 2x phone. Both are "the 1.5 the upscaler
 * was measured at"; the ladder is stated in the factors the rungs were
 * calibrated at rather than bent to meet Low exactly.
 *
 * **No rule here asks what kind of chassis it is running on.** A `deviceClass`
 * test used to refuse High on a phone and on the `limited` class, and both are
 * gone: a class is a guess with edge cases, and what the two refusals stood in
 * for is already decided by measurement. A `limited` device's envelope is
 * 192 MiB, so 40 % of it is 76.8 MiB and the byte budget below refuses a
 * sharper canvas there without the class being named. And a phone's heat is
 * answered by Dynamic — the slide down and the floor latch, which measure the
 * device in front of them — rather than by withholding a level the user can
 * choose. The platform family stays, recorded and unread, for the note on it
 * below.
 *
 * **The byte budget.** The risk in supersampling is bytes, not pixels, and
 * the bytes per scene pixel depend on the sample count: at a ratio r on a
 * W x H CSS canvas the scene-sized targets are the scene colour (RGBA16F,
 * 8 B per sample) and its depth/stencil (4 B per sample), the resolve texture
 * when the target is multisampled (8 B) and the LDR target the tone map writes
 * (RGBA8, 4 B). With no samples that is 16 B a pixel; with four (a 1x
 * monitor's output policy, held across every rung) it is 60 B. The composer's
 * ping-pong partner (RGBA16F, 8 B) is counted only where the chain binds it:
 * the `?fused=0` chain, whose lens pass writes it every frame. The chain that
 * ships never binds it, and three gives a target GL storage on its first bind
 * and not before, so there it costs nothing and is not counted — a level is
 * offered wherever the bytes really fit, and a user it does not suit can
 * switch back. `high` and every up rung must keep that sum at or under
 * RENDER_TARGET_ENVELOPE_SHARE of the device's texture envelope.
 *
 * That share is not a share of free memory: the sector tiles and the globe
 * ladder already spend the whole envelope, so render targets at 40 % of it
 * are 140 % of the envelope in total. It is defensible because the envelope
 * is itself half of a measured survival ceiling, which puts the render
 * targets at about 20 % of what the device was measured to survive — and the
 * number passed in is the LIVE envelope the streamer reads, so the DEV
 * `?envelope=` shrink puts a desktop under a phone's pressure here too.
 *
 * The sample count is decided from the OUTPUT ratio and held constant across
 * every rung (it is passed in, not derived here): a slide must never change
 * the antialiasing character or the target layout, and on a scaled Windows
 * display a sample count that followed the scene ratio would make the
 * cheaper rung allocate MORE multisampled storage than medium.
 *
 * Every rung's target size is floored, because GL sizes its storage with a
 * GLsizei and truncates: the sizes here are what the composer must be given
 * and what the upscaler's uniforms are derived from, so the fractional size
 * never reaches either.
 */

import type { PlatformFamily } from '../planetarium/world/gpuEnvelope';
import { DESKTOP_FLOOR_PIXEL_RATIO, MAX_UPSCALE_FACTOR } from './renderResolution';

/** The four levels, in the order the menu offers them. */
export type QualityLevel = 'low' | 'medium' | 'high' | 'dynamic';

/** Every level, in menu order: the order the ☰ menu's Graphics page offers
 *  them in, a ramp from the cheapest picture to the one that decides for
 *  itself, so the two extremes are never adjacent. */
export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'dynamic'];

/** What each level is called on its segment. */
export const QUALITY_LEVEL_LABELS: Record<QualityLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  dynamic: 'Dynamic',
};

/** The level a session starts at with nothing saved and nothing in the URL. */
export const DEFAULT_QUALITY: QualityLevel = 'dynamic';

/** Low's scene ratio as a share of the output ratio. 0.75 on a 2x phone is
 *  1.5, a 1.33 upscale — the factor the upscaler's sharpen was calibrated at
 *  and the smallest loss inside EASU's stated range. */
export const QUALITY_LOW_SCALE = 0.75;

/**
 * Dynamic's rungs below medium, as divisors of the output ratio. Each one has
 * to earn the EASU and RCAS passes it adds: 1/1.15 is 24 % of the scene's
 * pixels and 1/1.33 is 44 %, against two full-screen passes over the canvas.
 */
export const QUALITY_DOWN_RUNG_FACTORS: readonly number[] = [1, 1 / 1.15, 1 / 1.33];

/** Dynamic's rungs above medium, as multipliers of the output ratio. */
export const QUALITY_UP_RUNG_FACTORS: readonly number[] = [1, 1.25, 1.5];

/** The share of the device's texture envelope the scene-sized render targets
 *  may hold. See the header: 40 % of an envelope the tiles already spend is
 *  about 20 % of what the device was measured to survive. */
export const RENDER_TARGET_ENVELOPE_SHARE = 0.4;

/** Why `high` is not offered on this display. Every one of them is a fact
 *  about the machine — no chassis is named. */
export type HighDenialReason =
  | 'no composer'
  | 'supersample fallback'
  | 'byte budget'
  | 'gl size';

/**
 * Everything the bounds depend on. The caller reads all of it once and passes
 * it in: this module touches no browser and no renderer.
 */
export interface QualityBoundsInput {
  /** The output ratio (renderResolution.ts targetPixelRatio), which no level
   *  changes. Every bound and every rung is relative to it. */
  outputRatio: number;
  /** Whose platform it is. Recorded rather than read: the family reaches the
   *  bounds through the envelope its row in the table carries, and no rule
   *  here asks the question directly — which is why an Apple tablet clears
   *  1.5x and an Android one does not without either being named. */
  platform: PlatformFamily;
  /** The LIVE texture envelope the sector streamer and the globe ladder
   *  share, in bytes (the device profile's envelopeBytes, as the DEV
   *  `?envelope=` shrink leaves it). */
  envelopeBytes: number;
  /** The canvas in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** The sample count the OUTPUT ratio's policy chose, held across every
   *  rung (renderResolution.ts composerSamples). */
  samples: number;
  /** Whether the composer's ping-pong partner is bound at all: true on the
   *  `?fused=0` chain, where the lens pass writes it every frame, and false on
   *  the chain that ships, where no pass swaps and three never allocates it. */
  partnerBound: boolean;
  /** False on the no-float path, where there is no composer to re-size and
   *  every level is medium. */
  hasComposer: boolean;
  /** True where the GPU completed no multisampled half-float target, or
   *  `?msaa=0` asked for none: the output ratio is then the old 1.5
   *  supersample floor and it is the scene's only antialiasing. */
  supersampleFallback: boolean;
  /** min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE). A target above it yields
   *  an incomplete framebuffer — a black frame with no fallback — so no rung
   *  may cross it in either dimension. */
  maxGlSize: number;
}

/** What each level draws at on this display, and the ladder Dynamic uses. */
export interface QualityBounds {
  /** Low's scene ratio. */
  low: number;
  /** Medium's scene ratio: the output ratio. */
  medium: number;
  /** High's scene ratio, or medium where high is not offered. */
  high: number;
  /** Dynamic's rungs at and below medium, descending from medium. */
  downRungs: number[];
  /** Dynamic's rungs at and above medium, ascending from medium. */
  upRungs: number[];
  /** Whether High is a distinct level here. False means the menu omits it
   *  rather than offering a choice that does nothing. */
  highOffered: boolean;
  /** Why High is not offered; null when it is. */
  reason: HighDenialReason | null;
}

/** Dynamic's whole ladder in one piece, the shape the controller takes. */
export interface QualityLadder {
  /** Scene ratios, ascending, without repeats. */
  rungs: number[];
  /** Which of them is medium — where a session starts and what the floor
   *  latch hands the picture back to. */
  mediumIndex: number;
}

/** The scene target's size in device pixels at a scene ratio. Floored,
 *  because that is what GL will store and what the upscaler's uniforms must
 *  be derived from. */
export function sceneTargetSize(cssWidth: number, cssHeight: number, sceneRatio: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(cssWidth * sceneRatio)),
    height: Math.max(1, Math.floor(cssHeight * sceneRatio)),
  };
}

/**
 * The bytes the scene-sized render targets hold at a scene ratio: the
 * multisampled colour and depth/stencil, the resolve texture when there are
 * samples, the LDR target, and the composer's partner buffer where the chain
 * binds it. The figure `perfTargets()` reports and the one the byte budget
 * below is checked against.
 *
 * The partner is the whole difference between the two chains' figures — a
 * third of the total at 0 samples — and it decides where High is offered: a
 * 5K iMac at 2.5x holds 369 MB of targets on the shipped chain against a
 * ~429 MB share, and 553 MB on `?fused=0`, so it is offered the one and
 * refused the other; a 320 MiB tablet at 2.5x reads 102 MB against ~134 MB
 * and 154 MB. The figure follows what the GPU really holds, which is what a
 * budget is for; a device the wider offer does not suit has Medium one tap
 * away in the same menu row.
 */
export function renderTargetBytes(
  cssWidth: number,
  cssHeight: number,
  sceneRatio: number,
  samples: number,
  partnerBound: boolean,
): number {
  const { width, height } = sceneTargetSize(cssWidth, cssHeight, sceneRatio);
  const perSample = Math.max(1, Math.floor(samples));
  const colour = 8 * perSample;
  const depthStencil = 4 * perSample;
  const resolve = samples > 0 ? 8 : 0;
  const partner = partnerBound ? 8 : 0;
  const ldr = 4;
  return width * height * (colour + depthStencil + resolve + partner + ldr);
}

/** Rungs from their factors, clamped into [low, high], with the repeats the
 *  clamp creates removed. */
function ladderFrom(factors: readonly number[], outputRatio: number, low: number, high: number): number[] {
  const rungs: number[] = [];
  for (const factor of factors) {
    const ratio = Math.min(high, Math.max(low, outputRatio * factor));
    if (!rungs.some((r) => Math.abs(r - ratio) < 1e-9)) rungs.push(ratio);
  }
  return rungs;
}

/** The largest offered supersample, or medium with the reason it was refused. */
function highBound(input: QualityBoundsInput, medium: number): { high: number; reason: HighDenialReason | null } {
  if (!input.hasComposer) return { high: medium, reason: 'no composer' };
  if (input.supersampleFallback) return { high: medium, reason: 'supersample fallback' };
  const budget = RENDER_TARGET_ENVELOPE_SHARE * Math.max(0, input.envelopeBytes);
  // Largest first: the biggest candidate that fits is the one offered, and
  // the reason reported is the one that refused the smallest candidate —
  // the constraint that is actually binding.
  let reason: HighDenialReason = 'byte budget';
  for (const factor of [...QUALITY_UP_RUNG_FACTORS].sort((a, b) => b - a)) {
    if (factor <= 1) continue;
    const ratio = medium * factor;
    const size = sceneTargetSize(input.cssWidth, input.cssHeight, ratio);
    if (size.width > input.maxGlSize || size.height > input.maxGlSize) {
      reason = 'gl size';
      continue;
    }
    if (renderTargetBytes(input.cssWidth, input.cssHeight, ratio, input.samples, input.partnerBound) <= budget) {
      return { high: ratio, reason: null };
    }
    reason = 'byte budget';
  }
  return { high: medium, reason };
}

/**
 * What the four levels mean on this display. Medium is the output ratio; Low
 * is the floor; High is the largest supersample the bytes and the GL limit
 * allow, or medium where it is not offered; the two rung ladders are what
 * Dynamic slides over.
 */
export function qualityBounds(input: QualityBoundsInput): QualityBounds {
  const medium = input.outputRatio;
  const { high, reason } = highBound(input, medium);
  let low: number;
  if (!input.hasComposer) {
    low = medium;
  } else if (input.supersampleFallback) {
    // The old desktop supersample floor is this machine's only antialiasing:
    // below it the scene has none at all.
    low = Math.min(medium, DESKTOP_FLOOR_PIXEL_RATIO);
  } else {
    low = Math.max(medium * QUALITY_LOW_SCALE, medium / MAX_UPSCALE_FACTOR);
  }
  return {
    low,
    medium,
    high,
    downRungs: ladderFrom(QUALITY_DOWN_RUNG_FACTORS, medium, low, medium),
    upRungs: ladderFrom(QUALITY_UP_RUNG_FACTORS, medium, medium, high),
    highOffered: high > medium,
    reason,
  };
}

/** Dynamic's ladder: the down rungs turned round, then the up rungs above
 *  medium. Ascending, so a rung index is a picture the user can rank. */
export function dynamicLadder(bounds: QualityBounds): QualityLadder {
  const rungs = [...bounds.downRungs].reverse();
  const mediumIndex = rungs.length - 1;
  for (const rung of bounds.upRungs) {
    if (!rungs.some((r) => Math.abs(r - rung) < 1e-9)) rungs.push(rung);
  }
  return { rungs, mediumIndex };
}

/** The scene ratio a fixed level draws at. Dynamic starts at medium and the
 *  controller moves it from there. */
export function sceneRatioForLevel(level: QualityLevel, bounds: QualityBounds): number {
  switch (level) {
    case 'low':
      return bounds.low;
    case 'high':
      return bounds.high;
    case 'medium':
    case 'dynamic':
      return bounds.medium;
  }
}

/**
 * What the ☰ menu's quality control reads and writes. The level itself is
 * owned by the entry point — it decides the scene ratio before the
 * planetarium exists, and it is saved on its own key so a New Journey cannot
 * clear it — and the control only picks it and reports where it stands.
 */
export interface QualityControl {
  /** The level the session is running at. */
  level(): QualityLevel;
  /** Pick a level: saved, and applied to the live frame. */
  set(level: QualityLevel): void;
  /** What this display offers, `highOffered` included. */
  bounds(): QualityBounds;
  /** What the scene-sized render targets really hold, in bytes: the size they
   *  are ALLOCATED at, which under Dynamic is the ladder's top rung whatever
   *  rung is being drawn (app/sceneSubRect.ts). The `?debug=1` memory line
   *  reads it rather than deriving a figure from the drawing buffer, which
   *  would report the rung and understate what the device is holding. */
  targetBytes(): number;
}

/**
 * The `?quality=` startup param. `low`, `medium` and `dynamic` are honoured
 * on any build — `medium` is the kill switch. `high` is honoured on the dev
 * server only: it can allocate a few hundred megabytes of render target, and
 * a production link must not be able to do that (the same line `?msaa=2|4|8`
 * is held to). The menu is High's production door. Anything else — absent,
 * empty, a word that is not a level — means follow the saved setting or the
 * default; the precedence is the caller's.
 */
export function parseQualityParam(search: string, dev: boolean): QualityLevel | null {
  const raw = new URLSearchParams(search).get('quality');
  if (raw === null || raw.trim() === '') return null;
  const asked = raw.trim().toLowerCase();
  if (asked === 'high') return dev ? 'high' : null;
  return QUALITY_LEVELS.includes(asked as QualityLevel) ? (asked as QualityLevel) : null;
}
