/**
 * Standish/JPL approximate planetary elements: "Keplerian Elements for
 * Approximate Positions of the Major Planets", E.M. Standish (JPL/Caltech);
 * Standish & Williams 1992, Explanatory Supplement ch. 8.
 *
 * Two element tables, both heliocentric on the mean ecliptic and equinox of
 * J2000 (the scene's frame): Table 1 is fitted to 1800–2050 and used there;
 * Table 2 covers 3000 BC – 3000 AD and is used outside Table 1's window, with
 * T clamped to its own validity (beyond the fit there is no supported answer).
 * Quoted worst errors inside 1800–2050: tens of arcsec for the inner planets,
 * ~0.11°/0.17° for Jupiter/Saturn.
 *
 * Values are transcribed VERBATIM from the JPL p_elem_t1.txt / p_elem_t2.txt
 * files (research copies + provenance: ~/.claude/plans/standish-data/) —
 * never re-round them; standish.test.ts spot-checks oddball digits and pins
 * five epochs of JPL Horizons vectors against the propagation. The "Earth"
 * rows are the Earth–Moon barycenter ("EM Bary"): consumed only for Earth's
 * decorative orbit line and cross-model tests — the rendered Earth stays
 * Meeus (see computeEarthPositionEquatorial).
 *
 * Source-format quirks an editor must not "fix": the e column of the txt
 * files is headed "rad, rad/Cy" but is dimensionless eccentricity; Mars and
 * Neptune carry negative mean longitudes; the Table-1 EMB row has node ≡ 0.
 * The paper's Kepler iteration is written in degrees with e* = 57.29578·e in
 * the sine term and the BARE dimensionless e in the Newton denominator — in
 * radians it collapses to the ordinary Newton solve already in planetary.ts
 * (solveKepler). Reuse that; never write a degree-mode solver (mixing e*
 * into the denominator is the classic implementation bug).
 */
import { DEG, J2000 } from './constants';

/**
 * Osculating-style Kepler elements at a specific epoch — the mean anomaly
 * arrives propagated and normalized, so position math needs no jd. Field
 * names deliberately match the old PlanetData element vocabulary.
 */
export interface KeplerElements {
  semiMajorAxisAU: number;
  eccentricity: number;
  inclinationDeg: number;
  /** ϖ = ω + Ω (longitude of perihelion, NOT the argument of perihelion). */
  lonPerihelionDeg: number;
  ascendingNodeDeg: number;
  /** M = L − ϖ (+ Table-2 correction terms), normalized to [−180°, 180°]. */
  meanAnomalyDeg: number;
}

interface StandishRow {
  a: number; aDot: number;       // AU, AU/cy
  e: number; eDot: number;       // dimensionless (header says "rad" — quirk)
  i: number; iDot: number;       // deg, deg/cy
  L: number; LDot: number;       // deg, deg/cy (mean longitude)
  lonPeri: number; lonPeriDot: number; // deg, deg/cy (ϖ)
  node: number; nodeDot: number; // deg, deg/cy (Ω)
}

/** M correction b·T² + c·cos(f·T) + s·sin(f·T), f·T in degrees (Table 2b). */
interface ExtraTerms { b: number; c: number; s: number; f: number }

const TABLE_1: Record<string, StandishRow> = {
  Mercury: { a: 0.38709927, aDot: 0.00000037, e: 0.20563593, eDot: 0.00001906, i: 7.00497902, iDot: -0.00594749, L: 252.25032350, LDot: 149472.67411175, lonPeri: 77.45779628, lonPeriDot: 0.16047689, node: 48.33076593, nodeDot: -0.12534081 },
  Venus: { a: 0.72333566, aDot: 0.00000390, e: 0.00677672, eDot: -0.00004107, i: 3.39467605, iDot: -0.00078890, L: 181.97909950, LDot: 58517.81538729, lonPeri: 131.60246718, lonPeriDot: 0.00268329, node: 76.67984255, nodeDot: -0.27769418 },
  Earth: { a: 1.00000261, aDot: 0.00000562, e: 0.01671123, eDot: -0.00004392, i: -0.00001531, iDot: -0.01294668, L: 100.46457166, LDot: 35999.37244981, lonPeri: 102.93768193, lonPeriDot: 0.32327364, node: 0.0, nodeDot: 0.0 }, // Earth–Moon barycenter ("EM Bary")
  Mars: { a: 1.52371034, aDot: 0.00001847, e: 0.09339410, eDot: 0.00007882, i: 1.84969142, iDot: -0.00813131, L: -4.55343205, LDot: 19140.30268499, lonPeri: -23.94362959, lonPeriDot: 0.44441088, node: 49.55953891, nodeDot: -0.29257343 },
  Jupiter: { a: 5.20288700, aDot: -0.00011607, e: 0.04838624, eDot: -0.00013253, i: 1.30439695, iDot: -0.00183714, L: 34.39644051, LDot: 3034.74612775, lonPeri: 14.72847983, lonPeriDot: 0.21252668, node: 100.47390909, nodeDot: 0.20469106 },
  Saturn: { a: 9.53667594, aDot: -0.00125060, e: 0.05386179, eDot: -0.00050991, i: 2.48599187, iDot: 0.00193609, L: 49.95424423, LDot: 1222.49362201, lonPeri: 92.59887831, lonPeriDot: -0.41897216, node: 113.66242448, nodeDot: -0.28867794 },
  Uranus: { a: 19.18916464, aDot: -0.00196176, e: 0.04725744, eDot: -0.00004397, i: 0.77263783, iDot: -0.00242939, L: 313.23810451, LDot: 428.48202785, lonPeri: 170.95427630, lonPeriDot: 0.40805281, node: 74.01692503, nodeDot: 0.04240589 },
  Neptune: { a: 30.06992276, aDot: 0.00026291, e: 0.00859048, eDot: 0.00005105, i: 1.77004347, iDot: 0.00035372, L: -55.12002969, LDot: 218.45945325, lonPeri: 44.96476227, lonPeriDot: -0.32241464, node: 131.78422574, nodeDot: -0.00508664 },
  Pluto: { a: 39.48211675, aDot: -0.00031596, e: 0.24882730, eDot: 0.00005170, i: 17.14001206, iDot: 0.00004818, L: 238.92903833, LDot: 145.20780515, lonPeri: 224.06891629, lonPeriDot: -0.04062942, node: 110.30393684, nodeDot: -0.01183482 },
};

const TABLE_2: Record<string, StandishRow> = {
  Mercury: { a: 0.38709843, aDot: 0.00000000, e: 0.20563661, eDot: 0.00002123, i: 7.00559432, iDot: -0.00590158, L: 252.25166724, LDot: 149472.67486623, lonPeri: 77.45771895, lonPeriDot: 0.15940013, node: 48.33961819, nodeDot: -0.12214182 },
  Venus: { a: 0.72332102, aDot: -0.00000026, e: 0.00676399, eDot: -0.00005107, i: 3.39777545, iDot: 0.00043494, L: 181.97970850, LDot: 58517.81560260, lonPeri: 131.76755713, lonPeriDot: 0.05679648, node: 76.67261496, nodeDot: -0.27274174 },
  Earth: { a: 1.00000018, aDot: -0.00000003, e: 0.01673163, eDot: -0.00003661, i: -0.00054346, iDot: -0.01337178, L: 100.46691572, LDot: 35999.37306329, lonPeri: 102.93005885, lonPeriDot: 0.31795260, node: -5.11260389, nodeDot: -0.24123856 }, // Earth–Moon barycenter ("EM Bary")
  Mars: { a: 1.52371243, aDot: 0.00000097, e: 0.09336511, eDot: 0.00009149, i: 1.85181869, iDot: -0.00724757, L: -4.56813164, LDot: 19140.29934243, lonPeri: -23.91744784, lonPeriDot: 0.45223625, node: 49.71320984, nodeDot: -0.26852431 },
  Jupiter: { a: 5.20248019, aDot: -0.00002864, e: 0.04853590, eDot: 0.00018026, i: 1.29861416, iDot: -0.00322699, L: 34.33479152, LDot: 3034.90371757, lonPeri: 14.27495244, lonPeriDot: 0.18199196, node: 100.29282654, nodeDot: 0.13024619 },
  Saturn: { a: 9.54149883, aDot: -0.00003065, e: 0.05550825, eDot: -0.00032044, i: 2.49424102, iDot: 0.00451969, L: 50.07571329, LDot: 1222.11494724, lonPeri: 92.86136063, lonPeriDot: 0.54179478, node: 113.63998702, nodeDot: -0.25015002 },
  Uranus: { a: 19.18797948, aDot: -0.00020455, e: 0.04685740, eDot: -0.00001550, i: 0.77298127, iDot: -0.00180155, L: 314.20276625, LDot: 428.49512595, lonPeri: 172.43404441, lonPeriDot: 0.09266985, node: 73.96250215, nodeDot: 0.05739699 },
  Neptune: { a: 30.06952752, aDot: 0.00006447, e: 0.00895439, eDot: 0.00000818, i: 1.77005520, iDot: 0.00022400, L: 304.22289287, LDot: 218.46515314, lonPeri: 46.68158724, lonPeriDot: 0.01009938, node: 131.78635853, nodeDot: -0.00606302 },
  Pluto: { a: 39.48686035, aDot: 0.00449751, e: 0.24885238, eDot: 0.00006016, i: 17.14104260, iDot: 0.00000501, L: 238.96535011, LDot: 145.18042903, lonPeri: 224.09702598, lonPeriDot: -0.00968827, node: 110.30167986, nodeDot: -0.00809981 },
};

const TABLE_2_EXTRAS: Record<string, ExtraTerms> = {
  Jupiter: { b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 },
  Saturn: { b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000 }, // f: 360/38.35125 ≈ 938.7 yr — the Jupiter–Saturn great inequality
  Uranus: { b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000 },
  Neptune: { b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000 },
  Pluto: { b: -0.01262724, c: 0, s: 0, f: 0 }, // b only, per Table 2b
};

// Validity windows in Julian centuries from J2000.
const TABLE_1_MIN_T = -2.0; // 1800 AD
const TABLE_1_MAX_T = 0.5; // 2050 AD
const TABLE_2_MIN_T = -50; // 3000 BC
const TABLE_2_MAX_T = 10; // 3000 AD

function normalizeDeg180(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function propagate(row: StandishRow, extras: ExtraTerms | undefined, T: number): KeplerElements {
  const lonPerihelionDeg = row.lonPeri + row.lonPeriDot * T;
  // M = L − ϖ, normalized only AFTER the subtraction — L itself is enormous
  // (Mercury L̇ ≈ 149472.674 °/cy) and must keep full precision until then.
  let meanAnomalyDeg = row.L + row.LDot * T - lonPerihelionDeg;
  if (extras) {
    meanAnomalyDeg +=
      extras.b * T * T + extras.c * Math.cos(extras.f * T * DEG) + extras.s * Math.sin(extras.f * T * DEG);
  }
  return {
    semiMajorAxisAU: row.a + row.aDot * T,
    eccentricity: row.e + row.eDot * T,
    inclinationDeg: row.i + row.iDot * T,
    lonPerihelionDeg,
    ascendingNodeDeg: row.node + row.nodeDot * T,
    meanAnomalyDeg: normalizeDeg180(meanAnomalyDeg),
  };
}

/**
 * Elements for a planetarium body at a TT Julian Day. Table 1 inside its
 * 1800–2050 fit, Table 2 (with its M correction terms) everywhere else,
 * clamped to Table 2's 3000 BC – 3000 AD validity.
 */
export function getStandishElements(name: string, jdTT: number): KeplerElements {
  const T = (jdTT - J2000) / 36525;
  const table = T >= TABLE_1_MIN_T && T <= TABLE_1_MAX_T ? 1 : 2;
  return getElementsFromTable(table, name, jdTT);
}

/** @internal Exposed for tests only (table handoff + verbatim value spot-checks). */
export function getElementsFromTable(table: 1 | 2, name: string, jdTT: number): KeplerElements {
  const row = (table === 1 ? TABLE_1 : TABLE_2)[name];
  if (!row) {
    throw new Error(`No Standish elements for body "${name}"`);
  }
  let T = (jdTT - J2000) / 36525;
  if (table === 2) {
    T = Math.min(TABLE_2_MAX_T, Math.max(TABLE_2_MIN_T, T));
  }
  return propagate(row, table === 2 ? TABLE_2_EXTRAS[name] : undefined, T);
}
