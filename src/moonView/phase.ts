/**
 * Moon-view phase + eclipse classification. Pure: given the displayed moon,
 * sun, and ascending-node angles (degrees), returns the phase name,
 * illumination fraction, phase angle, and any eclipse type/quality.
 */
import { DEG2RAD } from '../shared/math/angles';

export interface PhaseInfo {
  name: string;
  illumination: number;
  phaseAngle: number;
  eclipseType: 'none' | 'lunar' | 'solar';
  eclipseQuality: number;
}

export function computePhaseInfo(moonAngleDeg: number, sunAngleDeg: number, nodeAngleDeg: number): PhaseInfo {
  let phaseAngle = moonAngleDeg - sunAngleDeg;
  while (phaseAngle > 180) phaseAngle -= 360;
  while (phaseAngle < -180) phaseAngle += 360;

  const absPhase = Math.abs(phaseAngle);
  const illumination = (1 - Math.cos(absPhase * DEG2RAD)) / 2;

  let name: string;
  if (absPhase < 10) name = 'New Moon';
  else if (absPhase < 80) name = phaseAngle > 0 ? 'Waxing Crescent' : 'Waning Crescent';
  else if (absPhase < 100) name = phaseAngle > 0 ? 'First Quarter' : 'Last Quarter';
  else if (absPhase < 170) name = phaseAngle > 0 ? 'Waxing Gibbous' : 'Waning Gibbous';
  else name = 'Full Moon';

  let moonRelNode = moonAngleDeg - nodeAngleDeg;
  while (moonRelNode > 180) moonRelNode -= 360;
  while (moonRelNode < -180) moonRelNode += 360;
  const distFromNode = Math.min(Math.abs(moonRelNode), Math.abs(Math.abs(moonRelNode) - 180));
  const nodeProximity = Math.max(0, 1 - distFromNode / 18);

  let eclipseType: 'none' | 'lunar' | 'solar' = 'none';
  let eclipseQuality = 0;

  if (nodeProximity > 0) {
    if (absPhase > 170) {
      eclipseType = 'lunar';
      eclipseQuality = nodeProximity * (absPhase - 170) / 10;
    } else if (absPhase < 10) {
      eclipseType = 'solar';
      eclipseQuality = nodeProximity * (10 - absPhase) / 10;
    }
  }

  return { name, illumination, phaseAngle: absPhase, eclipseType, eclipseQuality: Math.min(1, eclipseQuality) };
}
