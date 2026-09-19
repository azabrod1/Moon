/**
 * What the ☰ menu's Graphics page says: which levels this display is offered,
 * what the picture is doing right now under Dynamic, and the one-line note
 * under each control.
 *
 * DOM-free on purpose. The page itself is static markup and a few id lookups;
 * everything that has to be DECIDED — a level left out because it would change
 * nothing, the word for the rung Dynamic is sitting on, the value the tier row
 * on the root carries — is decided here, where it can be read and tested
 * without a browser.
 *
 * The scale is `renderQuality.ts`'s: every number is a SCENE ratio, and Medium
 * is the display's own output ratio. A rung is named by comparing it against
 * the three bounds rather than by its index, because the ladder's length
 * depends on the machine — a display with no supersample above Medium has no
 * top half at all.
 */

import {
  QUALITY_LEVEL_LABELS,
  QUALITY_LEVELS,
  dynamicLadder,
  type QualityBounds,
  type QualityLevel,
} from './renderQuality';
import { type FrameRate } from './frameRateSetting';

/** The note under the quality control: what this level does to the picture,
 *  in the words a reader would use. Nothing here mentions heat or battery —
 *  neither is measured. */
export const QUALITY_LEVEL_NOTES: Record<QualityLevel, string> = {
  low: 'Fewer pixels, sharpened up to the screen. The lightest.',
  medium: "The screen's own resolution.",
  high: 'More pixels than the screen, averaged down. The sharpest, and the most work.',
  dynamic: 'Medium by default. Fewer pixels when frames run late, more when there is room.',
};

/** The note under the frame-rate control. Every value is offered on every
 *  display: on a 60 Hz screen 120 means "as fast as the screen", the way a
 *  game's cap above the monitor's rate does. */
export const FRAME_RATE_NOTES: Record<FrameRate, string> = {
  screen: 'As fast as the screen refreshes.',
  '30': '30 frames a second. Less drawing, coarser motion.',
  '60': '60 frames a second. Under Dynamic, pixels are traded to hold it.',
  '120': '120 frames a second where the screen can. Under Dynamic, pixels are traded to hold it.',
};

/** How close two scene ratios have to be for one to BE the other. A percent
 *  of the bound, because the bounds themselves are ratios of the output.
 *  Dynamic's deepest rung (output / 1.33) sits 0.2 % above Low (0.75 x
 *  output), and the two are the same picture to look at — this tolerance is
 *  what makes that rung read "Low" instead of a number nobody can act on. */
const SAME_RATIO = 0.01;

function isNear(ratio: number, bound: number): boolean {
  return Math.abs(ratio - bound) <= SAME_RATIO * Math.abs(bound);
}

/**
 * The levels this display is offered, in menu order.
 *
 * A level whose scene ratio is another level's is left OUT rather than shown
 * as a choice that would change nothing. High goes where the machine refuses
 * a supersample (no composer, a GPU that completed no multisampled half-float
 * target, the GL size limit, the byte budget — `bounds.reason` says which).
 * Low goes on the same principle from the other end: the no-float path has no
 * composer to re-size, and on the supersample-fallback path the output ratio
 * is already the old 1.5 floor, so Low collapses onto Medium there. Dynamic
 * and Medium are always offered — Medium is the kill switch.
 */
export function offeredQualityLevels(bounds: QualityBounds): QualityLevel[] {
  return QUALITY_LEVELS.filter((level) => {
    if (level === 'high') return bounds.highOffered;
    if (level === 'low') return bounds.low < bounds.medium && !isNear(bounds.low, bounds.medium);
    return true;
  });
}

/** Where the picture stands on Dynamic's ladder right now. */
export interface QualityReadout {
  /** What the "Now rendering" line reads: a bound's own name where the rung
   *  is one, otherwise which pair of bounds it sits between. */
  word: string;
  /** The same in the tier row's shorter form. */
  short: string;
  /** The ladder, ascending — one pip each. */
  rungs: number[];
  /** Which pip is lit: the rung nearest the ratio being drawn. */
  rungIndex: number;
  /** Which pip is Medium, for the caption under the ladder. */
  mediumIndex: number;
  /** Which pip is High, or null where High is not offered and the top pip IS
   *  Medium. */
  highIndex: number | null;
}

/**
 * The live readout under the quality control: the word for the scene ratio
 * being drawn, and the ladder it sits on.
 *
 * The word probes Medium first, then High, then Low. Order matters where the
 * scale collapses: a display offered neither Low nor High has one rung, and
 * probing Low first would name that single rung "Low" when it is the screen's
 * own resolution. An in-between rung says which pair it is between rather
 * than a percentage — the lit pip already carries the precision, and a number
 * against Medium is a figure nobody can act on.
 */
export function qualityReadout(sceneRatio: number, bounds: QualityBounds): QualityReadout {
  const { rungs, mediumIndex } = dynamicLadder(bounds);
  const highIndex = bounds.highOffered
    ? rungs.reduce((best, rung, i) => (isNear(rung, bounds.high) ? i : best), -1)
    : -1;
  let rungIndex = 0;
  for (let i = 1; i < rungs.length; i += 1) {
    if (Math.abs(rungs[i] - sceneRatio) < Math.abs(rungs[rungIndex] - sceneRatio)) rungIndex = i;
  }
  let word: string;
  let short: string;
  if (isNear(sceneRatio, bounds.medium)) {
    word = 'Medium';
    short = 'Medium';
  } else if (bounds.highOffered && isNear(sceneRatio, bounds.high)) {
    word = 'High';
    short = 'High';
  } else if (isNear(sceneRatio, bounds.low)) {
    word = 'Low';
    short = 'Low';
  } else if (sceneRatio < bounds.medium) {
    word = 'Between Low and Medium';
    short = 'Low–Medium';
  } else {
    word = 'Between Medium and High';
    short = 'Medium–High';
  }
  return { word, short, rungs, rungIndex, mediumIndex, highIndex: highIndex < 0 ? null : highIndex };
}

/**
 * The value the root's Graphics tier row carries on its right: the level, and
 * under Dynamic what Dynamic is doing with it.
 *
 * A ladder with one rung gets the bare word: Dynamic cannot move there, so
 * naming the rung would promise a readout that never changes.
 */
export function graphicsSummary(level: QualityLevel, sceneRatio: number, bounds: QualityBounds): string {
  const label = QUALITY_LEVEL_LABELS[level];
  if (level !== 'dynamic') return label;
  const readout = qualityReadout(sceneRatio, bounds);
  if (readout.rungs.length < 2) return label;
  return `${label} · ${readout.short}`;
}

/**
 * The choice an arrow key lands on: one step through the OFFERED list,
 * wrapping at both ends.
 *
 * A value the list does not hold is a real state — the DEV `?quality=high`
 * boots a display that does not offer High at High — and stepping from it
 * lands on the end the key was heading towards rather than refusing to move.
 */
export function stepChoice<T>(list: readonly T[], current: T, delta: number): T {
  if (list.length === 0) return current;
  const at = list.indexOf(current);
  if (at < 0) return delta < 0 ? list[list.length - 1] : list[0];
  return list[(at + delta + list.length * Math.max(1, Math.abs(delta))) % list.length];
}
