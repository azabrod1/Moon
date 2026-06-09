/**
 * Accumulated general precession in longitude since J2000 (IAU/Lieske
 * coefficients, Meeus ch. 21): p_A(T) = 5029.0966″·T + 1.11113″·T² — the
 * cubic term is < 0.1″ over the app's range.
 *
 * Contract: a Meeus ecliptic-of-date longitude becomes J2000 by subtracting
 * this value (λ_J2000 = λ_of-date − p_A; of-date λ > J2000 λ after 2000);
 * latitude is left unchanged. Leaving β alone neglects the slow tilt of the
 * ecliptic plane itself (~47″/cy): an error of ≈ 47″·|T| — 0.033° at 1750,
 * ~0.4° at the ±3000 AD Standish clamp — acceptable beside the Standish
 * planets' own 0.1–0.6° accuracy out there. Revisit (full Lieske three-angle
 * reduction) only if a later milestone needs arcsecond star registration at
 * remote epochs.
 */
import { J2000 } from './constants';

export function accumulatedPrecessionLonDeg(jdTT: number): number {
  const T = (jdTT - J2000) / 36525;
  return 1.3969713 * T + 0.000308648 * T * T;
}
