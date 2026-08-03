/**
 * The facts a map card reads out about the body it names, and the axial-tilt
 * glyph's geometry.
 *
 * Pure: a catalog name in, plain rows out. No DOM and no scene state — the
 * card's DOM layer is handed these rows as data and owns nothing but their
 * painting, so the numbers can be pinned by tests rather than by a screenshot.
 *
 * Two figures are DERIVED rather than stored, because the catalogs never held
 * them: mass from surface gravity and radius (g = GM/R², rearranged against
 * Earth), and the orbital period from Kepler's third law in units where Earth
 * is 1. Everything else is a catalog value formatted to three significant
 * figures.
 *
 * The row shapes, the formatters and the sig3 rounding are ported from
 * Gregory Zabrodskiy's system-map card (PR #16).
 */

import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS } from '../planets/moonData';
import { getMoonDisplayOrbit } from '../../astronomy/satellites';
import { bodyDisplayName } from '../surfaceView';
import { mapBody } from './mapBodies';

/**
 * One line of the card's fact block. A value is either finished text or the
 * axial tilt in degrees — the tilt is a picture, not a number, and the DOM
 * layer draws it. Keeping it a shape rather than a pre-rendered node is what
 * keeps this module free of the DOM.
 */
export interface FactRow {
  label: string;
  value: string | { tiltDeg: number };
}

/** The card's facts for one body: the rows, and the line under its name. */
export interface MapFacts {
  rows: FactRow[];
  oneLiner: string;
}

/**
 * Three significant figures, and above a thousand a rounded, grouped integer —
 * "384,000 km" rather than "3.84e+5". A non-finite value is printed as itself
 * rather than dressed up as a measurement.
 */
export function sig3(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) {
    return Math.round(Number(value.toPrecision(3))).toLocaleString('en-US');
  }
  return value.toPrecision(3);
}

/** Earth's own catalog radius: the unit radii and the derived mass are quoted
 *  in. Read from the catalog rather than restated, so an edit there moves the
 *  unit with it — and NaN, not zero, if Earth ever left, so a broken unit reads
 *  as broken instead of as infinity. */
const EARTH_RADIUS_AU =
  PLANETARIUM_BODIES.find((planet) => planet.name === 'Earth')?.radiusAU ?? Number.NaN;

/** The Sun in Earth masses. The star is outside the body catalogs — like its
 *  tint, this is the one commented exception to reading figures from them. */
const SUN_MASS_EARTHS = 332_946;

const fmtAu = (au: number): string => `${sig3(au)} AU`;
const fmtEarthRadii = (radiusAU: number): string => `${sig3(radiusAU / EARTH_RADIUS_AU)} R⊕`;
const fmtEarthMass = (massEarths: number): string => `${sig3(massEarths)} M⊕`;
const fmtYears = (years: number): string => `${sig3(years)} yr⊕`;
const fmtDays = (days: number): string => `${sig3(days)} d⊕`;

const PLANET_BY_NAME = new Map(PLANETARIUM_BODIES.map((planet) => [planet.name, planet]));
const MOON_BY_NAME = new Map(MOONS.map((moon) => [moon.name, moon]));

/**
 * The card's fact rows and one-liner for a catalog name, resolved through the
 * chart's one roster. A name the chart does not know gets no rows and no
 * one-liner: the card then paints neither, which is the honest answer — an
 * invented row would read as a measurement.
 */
export function mapFactRows(name: string): MapFacts {
  const body = mapBody(name);
  if (!body) return { rows: [], oneLiner: '' };
  if (body.kind === 'sun') {
    return {
      rows: [
        { label: 'Radius', value: fmtEarthRadii(SUN_DATA.radiusAU) },
        { label: 'Mass', value: fmtEarthMass(SUN_MASS_EARTHS) },
      ],
      oneLiner: 'Our star, a yellow dwarf',
    };
  }
  if (body.kind === 'moon') {
    const moon = MOON_BY_NAME.get(name);
    if (!moon) return { rows: [], oneLiner: '' };
    const rows: FactRow[] = [
      { label: 'Distance to planet', value: `${sig3(moon.orbitalRadiusKm)} km` },
      { label: 'Radius', value: fmtEarthRadii(moon.radiusAU) },
      // The display-period seam, never 360/|Ṁ| — that reads 30× wrong on the
      // degenerate Tethys-family fits. A major moon is tidally locked, so its
      // orbit is also its day.
      {
        label: 'Orbit',
        value: fmtDays(getMoonDisplayOrbit(moon.name, moon.parentPlanet).periodDays),
      },
    ];
    // Airless moons get no row at all — a padded 'None' on sixty-odd rocks is
    // noise, and the three that have an atmosphere are the point.
    if (moon.atmosphere) rows.push({ label: 'Atmosphere', value: moon.atmosphere });
    return { rows, oneLiner: `${moon.parentPlanet}'s moon` };
  }
  const planet = PLANET_BY_NAME.get(name);
  if (!planet) return { rows: [], oneLiner: '' };
  const earthRadii = planet.radiusAU / EARTH_RADIUS_AU;
  return {
    rows: [
      { label: 'Distance to Sun', value: fmtAu(planet.semiMajorAxisAU) },
      { label: 'Radius', value: fmtEarthRadii(planet.radiusAU) },
      // g = GM/R², rearranged: both inputs are hand-authored catalog figures,
      // so this lands within a few percent of the published mass rather than
      // on it — close enough to read, and honest about where it came from.
      { label: 'Mass', value: fmtEarthMass(planet.surfaceGravityG * earthRadii * earthRadii) },
      { label: 'Gravity', value: `${sig3(planet.surfaceGravityG)} g` },
      { label: 'Tilt', value: { tiltDeg: planet.axialTiltDeg } },
      { label: 'Atmosphere', value: planet.atmosphere ?? 'None' },
      // Kepler's third law in units where Earth is 1 — the catalog stores no
      // period, and a^1.5 is exact enough that Earth comes out at 1.00.
      { label: 'Year', value: fmtYears(planet.semiMajorAxisAU ** 1.5) },
      // Math.abs is defensive: every catalog rotation period is positive, and
      // a retrograde spin is what the tilt glyph says, not this row.
      { label: 'Day', value: fmtDays(Math.abs(planet.rotationPeriodHours) / 24) },
      { label: 'Moons', value: String(planet.moons) },
    ],
    oneLiner: planet.description,
  };
}

/**
 * The line the chart shows while the cursor rests on a MOON, finished the same
 * way the fact rows are — one string, ready to paint.
 *
 * Moons only, and null for everything else, because a moon is the one body
 * whose drawn position is not its true one: the chart compresses moon distances
 * so a system stays a picture instead of a dot beside a dot. So the moment the
 * cursor picks one out is the moment to say where it really is and how long it
 * really takes — the two figures the drawing cannot carry. A planet's chart
 * position IS its position, and nothing is owed.
 */
export function mapHoverMeta(name: string): string | null {
  const body = mapBody(name);
  if (body?.kind !== 'moon') return null;
  const moon = MOON_BY_NAME.get(name);
  if (!moon) return null;
  // The display seam again, never 360/|Ṁ| — the card and this line have to
  // agree, and only one of the two figures is right.
  const periodDays = getMoonDisplayOrbit(moon.name, moon.parentPlanet).periodDays;
  return [
    bodyDisplayName(name),
    `${moon.parentPlanet}'s moon`,
    `Orbit ${fmtDays(periodDays)}`,
    `${sig3(moon.orbitalRadiusKm)} km`,
  ].join(' · ');
}

/**
 * The tilt glyph's fixed geometry, in its own viewBox units: a dashed orbital
 * plane across the middle, the body at the centre, and the spin axis leaning
 * off vertical by the catalog angle. Shared by the drawing and by its test, so
 * neither can drift from the other.
 */
export const TILT_GLYPH = {
  width: 32,
  height: 18,
  cx: 16,
  cy: 9,
  /** Half the axis, centre to pole. */
  axisHalf: 6.5,
  bodyRadius: 2.2,
  poleRadius: 1.5,
  /** Inset of the dashed orbital-plane line from either edge. */
  baseInset: 3,
} as const;

/** Where a tilt glyph's axis ends. */
export interface TiltAxisEndpoints {
  northX: number;
  northY: number;
  southX: number;
  southY: number;
}

/**
 * The spin axis for an axial tilt, as the glyph draws it: screen y runs down,
 * so an untilted pole points straight up and the angle leans it clockwise. The
 * NORTH end is the one that carries the pole dot, which is the whole tell — at
 * Venus's 177° the dot swings below the body and the retrograde spin reads at a
 * glance, without a word of copy.
 */
export function tiltAxisEndpoints(deg: number): TiltAxisEndpoints {
  const rad = (deg * Math.PI) / 180;
  const dx = TILT_GLYPH.axisHalf * Math.sin(rad);
  const dy = TILT_GLYPH.axisHalf * Math.cos(rad);
  return {
    northX: TILT_GLYPH.cx + dx,
    northY: TILT_GLYPH.cy - dy,
    southX: TILT_GLYPH.cx - dx,
    southY: TILT_GLYPH.cy + dy,
  };
}
