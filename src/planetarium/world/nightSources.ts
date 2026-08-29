/**
 * The night side's own light: airglow, the Moon as a second source, and the
 * multiple-scattering ambient the tables put on dark ground. Everything here is
 * a NON-SOLAR source, and everything here is authored to a long exposure.
 *
 * Why authored. Airglow is ~1e7 times dimmer than the daylight sky and full
 * moonlight is 1/4.4e5 of sunlight; a photograph of either is a long exposure
 * with the night side pushed. This renderer has no exposure adaptation — one
 * `toneMappingExposure` covers the whole frame — and its night side is already
 * lifted by hand (the city lights are drawn at 1.5x the night map). So the
 * daylight side stays physical and the night side is drawn at a stated gain,
 * with the physical ratio kept beside it so the two can never be confused. Each
 * constant below says which of the two it is. Moonlight's COLOUR is authored
 * the same way and for the same reason — a long exposure of it is cool, the
 * spectrum that produced it is warm — and MOONLIGHT_TINT carries both numbers.
 *
 * One weight for the sources the daylight sky drowns. Airglow and the sky's
 * own ambient fade out through `nightWeight`, which reads the SAME geometric
 * quantity the airlight does — the Sun's elevation at the ray's lowest point on
 * the shell, at the fragment on a surface. A source with a gate of its own
 * switches off along a line that does not coincide with the terminator, and
 * that line lands in the twilight band, which is the part of the picture the
 * whole campaign is about.
 *
 * The Moon is not one of those sources, and `moonUpWeight` is why. The Moon
 * lights the ground whenever it is above that ground's horizon, wherever the
 * Sun is; gate its beam by the SUN's elevation and the ground goes through a
 * minimum at the terminator, four times darker than the ground five degrees
 * into the day side and thirteen times darker than the same ground fifteen
 * degrees into the night, with a gibbous Moon standing right over it. So the
 * Moon's terms on the ground ride its own elevation instead, times
 * `sunDownWeight`: a ONE-SIDED ramp, already at full strength at the
 * terminator and fading only as the Sun climbs above it. The Sun's light on a
 * fragment is exactly zero at that line, so nothing the Moon adds there can
 * double-light it — and any ramp centred on the terminator holds the Moon at
 * half strength exactly where the Sun has none, which is a band of ground
 * twice darker than the moonlit ground beyond it. The sky is the other way
 * round: past the terminator the Sun's in-scatter does not collapse, it becomes
 * twilight, and twilight really does drown moonlight for the ten degrees or so
 * it takes to fade. So the shell keeps the shared weight and multiplies the
 * Moon's own elevation into it.
 */
import { PLANETS } from '../planets/planetData';
import { AIRLIGHT_SCALE, type RGB } from './atmosphereModel';

export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// The two weights
// ---------------------------------------------------------------------------

/** Sine of the Sun's elevation at which every non-solar source is at full
 *  strength: 14.5 degrees below the local horizon, the end of the bright part
 *  of twilight. */
export const NIGHT_WEIGHT_FULL_SIN = -0.25;
/** ...and where they are entirely off: 2.9 degrees above it. Above this line
 *  the sky is the Sun's, which is what keeps the airglow off the day limb. */
export const NIGHT_WEIGHT_ZERO_SIN = 0.05;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of a non-solar source survives at a point where the Sun's elevation
 * has this sine. 1 in the dark, 0 in daylight, one C-continuous ramp between —
 * mirrored exactly by `nightWeight` in NIGHT_WEIGHT_GLSL, which is generated
 * from these same two constants so the two cannot drift.
 */
export function nightWeight(sunElevSin: number): number {
  return 1 - smoothstep(NIGHT_WEIGHT_FULL_SIN, NIGHT_WEIGHT_ZERO_SIN, sunElevSin);
}

/** The GLSL half of `nightWeight`, for every shader that draws a night source.
 *  The edges are interpolated from the TypeScript constants above: one pair of
 *  numbers, two languages. */
export const NIGHT_WEIGHT_GLSL = /* glsl */`
// 1 where the Sun is well down, 0 where it is up, one ramp between. Every
// non-solar source is multiplied by this, and all of them read it from the same
// geometry the airlight does, so they fade along one line rather than three.
float nightWeight(float sunElevSin) {
  return 1.0 - smoothstep(${NIGHT_WEIGHT_FULL_SIN.toFixed(6)}, ${NIGHT_WEIGHT_ZERO_SIN.toFixed(6)}, sunElevSin);
}
`;

/** Sine of the Moon's own elevation at which its light is at full strength on
 *  the ground below: 2.9 degrees up. Not a twilight ramp — moonlight has no
 *  twilight to fade through — but a horizon is never a step either, so the beam
 *  arrives over the last few degrees rather than switching on. */
export const MOON_UP_FULL_SIN = 0.05;

/**
 * How much of the Moon's own light reaches a point where the MOON's elevation
 * has this sine: 0 with the Moon down, 1 with it up. Mirrored exactly by
 * `moonUpWeight` in MOON_UP_GLSL, from the one constant above.
 *
 * This is only half of what the Moon's terms on the ground are multiplied by.
 * The other half is `sunDownWeight`, which is what keeps the two sources from
 * both being weak in the middle of the crossing.
 */
export function moonUpWeight(moonElevSin: number): number {
  return smoothstep(0, MOON_UP_FULL_SIN, moonElevSin);
}

/** The GLSL half of `moonUpWeight`, from the same constant. */
export const MOON_UP_GLSL = /* glsl */`
// 1 with the Moon up, 0 with it down. Every moon-sourced term is multiplied by
// it: the Moon lights a place whenever it stands above that place's horizon,
// and how the Sun's own light there weighs against it is the caller's second
// factor — never this one.
float moonUpWeight(float moonElevSin) {
  return smoothstep(0.0, ${MOON_UP_FULL_SIN.toFixed(6)}, moonElevSin);
}
`;

/**
 * How much of the Moon's light survives the Sun's own on the same ground, at a
 * fragment where the sine of the Sun's elevation — which is the Sun's Lambert
 * term on that fragment — is `sunElevSin`: 1 at the geometric terminator and
 * everywhere below it, 0 once the Sun has climbed `termWidth` above it.
 *
 * One-sided, and that is the whole of it. The Sun's light on a fragment is
 * exactly zero at the terminator, so nothing the Moon adds there can
 * double-light it and there is no reason to hold the Moon back. A ramp centred
 * on the terminator does hold it back — half strength exactly where the Sun has
 * none — and what that draws is a band of ground twice darker than the fully
 * moonlit ground a few degrees further into the night, which no narrowing of a
 * two-sided ramp can remove. Above the terminator the Sun is back and worth
 * 4.4e5 times the Moon, so the fade there only has to be C-continuous, and the
 * width to fade over is the day ramp's own half-width: the Sun's light leaving
 * and the Moon's arriving are one handover written from one side each.
 */
export function sunDownWeight(sunElevSin: number, termWidth: number): number {
  return 1 - smoothstep(0, termWidth, sunElevSin);
}

/** The GLSL half of `sunDownWeight`. The width is a parameter rather than a
 *  constant here because it is the surface's own terminator half-width, which
 *  is per-body: the ramp the Moon arrives on is the one the Sun's light on that
 *  body leaves on. */
export const SUN_DOWN_GLSL = /* glsl */`
// 1 at the geometric terminator and everywhere below it, 0 once the Sun is a
// day-ramp half-width above it. The Sun's light on a fragment is exactly zero
// at that line, so a weight still climbing there leaves a band of ground darker
// than the ground on either side of it.
float sunDownWeight(float sunElevSin, float termWidth) {
  return 1.0 - smoothstep(0.0, termWidth, sunElevSin);
}
`;

// ---------------------------------------------------------------------------
// Airglow
// ---------------------------------------------------------------------------

/**
 * A body's airglow, as the thin emissive layers it is: chemiluminescence in the
 * upper air, not scattered sunlight, so it is on all night and no table
 * describes it.
 *
 * Colours are the real emission lines run through CIE 1931 to linear sRGB and
 * clamped into gamut. 557.7 nm (the green oxygen line, xy 0.357/0.640) comes
 * out (0.199, 1, -0.168) and clamps to (0.199, 1, 0). 630 nm (the red oxygen
 * line) sits outside the gamut past the sRGB red primary and clamps to pure
 * red, so a little green is added back: 630 nm looks orange, and a display's
 * red primary does not.
 *
 * Heights are authored where the geometry forces it. The green line really does
 * peak near 97 km and the 90-100 km band is physical. The 630 nm emission comes
 * from 250-300 km, which is outside the shell MESH (127 km at Earth's 1.02
 * scale) — so the fringe is drawn in the band just above the green one, which
 * is where it reads in a photograph even though it is not where it is.
 */
export interface AirglowSpec {
  /** Green (557.7 nm) layer, km above the surface. */
  readonly greenKm: readonly [number, number];
  /** Orange (630 nm) fringe, km above the surface — above the green layer. */
  readonly orangeKm: readonly [number, number];
  /** Radiance of a VERTICAL path through each layer, in the scene's linear
   *  units. Authored, not physical, and set against the photograph at the night
   *  limb. What the eye gets is the number AFTER the tone curve, and that is
   *  the whole of the level: at the 20x the limb stretches it to the green line
   *  is 6.5e-3 of linear radiance, which through ACES at exposure 1 and the
   *  sRGB transfer is 3.8 of 255 — a four-step thread, dimmer than the moonlit
   *  air below it, which is the order the two read in from orbit. (ACES is not
   *  a gamma curve near black: its slope there flattens a linear value that a
   *  bare sRGB encode would put twenty steps up.) Straight down the line is
   *  1/20 of that and rounds to nothing, which is also right. */
  readonly greenRadiance: number;
  readonly orangeRadiance: number;
}

/** Linear sRGB of the 557.7 nm line, gamut-clamped. */
export const AIRGLOW_GREEN_COLOR: RGB = [0.199, 1.0, 0.0];
/** Linear sRGB of the 630 nm line: the red primary, with the green channel
 *  lifted so the fringe reads as the orange the eye sees rather than as the
 *  display's pure red. */
export const AIRGLOW_ORANGE_COLOR: RGB = [1.0, 0.2, 0.05];

/**
 * Ceiling on the limb brightening. A ray running tangentially through a 10 km
 * slab at 6378 km travels 71x the slab's thickness, but the layer is a peaked
 * profile rather than a uniform slab and the emission does not keep growing
 * that way. 20 is where it is held.
 */
export const AIRGLOW_LIMB_CAP = 20;

export const AIRGLOW_SPECS: Readonly<Record<string, AirglowSpec>> = {
  Earth: {
    greenKm: [90, 100],
    orangeKm: [100, 120],
    greenRadiance: 3.0e-4,
    orangeRadiance: 1.2e-4,
  },
};

const RADIUS_KM_BY_BODY: Readonly<Record<string, number>> = Object.fromEntries(
  PLANETS.map((p) => [p.name, p.radiusKm]),
);

export interface AirglowUniforms {
  /** (green inner, green outer, orange inner, orange outer), in the radius
   *  units the tables and the shell shader work in (surface = 1). */
  readonly bands: readonly [number, number, number, number];
  readonly green: RGB;
  readonly orange: RGB;
}

/** A body's airglow as the shell's uniforms want it — all zero for a body with
 *  none, so the same shader text serves every body. */
export function airglowUniforms(body: string): AirglowUniforms {
  const spec = AIRGLOW_SPECS[body];
  const radiusKm = RADIUS_KM_BY_BODY[body];
  if (!spec || !radiusKm) {
    return { bands: [0, 0, 0, 0], green: [0, 0, 0], orange: [0, 0, 0] };
  }
  const r = (km: number): number => 1 + km / radiusKm;
  const scale = (color: RGB, amount: number): RGB =>
    [color[0] * amount, color[1] * amount, color[2] * amount];
  return {
    bands: [r(spec.greenKm[0]), r(spec.greenKm[1]), r(spec.orangeKm[0]), r(spec.orangeKm[1])],
    green: scale(AIRGLOW_GREEN_COLOR, spec.greenRadiance),
    orange: scale(AIRGLOW_ORANGE_COLOR, spec.orangeRadiance),
  };
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Forward length of a ray inside a sphere of radius `radius`, from an origin
 *  with `r2 = origin.origin` and `rmu = origin.view`. */
function sphereForwardLength(r2: number, rmu: number, radius: number): number {
  const disc = rmu * rmu - r2 + radius * radius;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  return Math.max(-rmu + s, 0) - Math.max(-rmu - s, 0);
}

/**
 * How much longer a ray runs through a spherical layer than a vertical path
 * does — 1 looking straight down through it, rising toward the limb where the
 * ray runs along the layer instead of across it. That IS the airglow line: the
 * layer is invisible from above and a bright thread edge-on.
 *
 * Mirrors `airglowLimbFactor` in AIRGLOW_GLSL line for line; the shader cannot
 * be unit-tested and this can.
 */
export function airglowLimbFactor(
  origin: Vec3,
  view: Vec3,
  innerRadius: number,
  outerRadius: number,
  cap = AIRGLOW_LIMB_CAP,
): number {
  const r2 = dot3(origin, origin);
  const rmu = dot3(origin, view);
  const thickness = Math.max(outerRadius - innerRadius, 1e-9);
  const length = sphereForwardLength(r2, rmu, outerRadius)
    - sphereForwardLength(r2, rmu, innerRadius);
  return Math.min(Math.max(length, 0) / thickness, cap);
}

/** The airglow a ray picks up, weighted off wherever the Sun is up. `origin`
 *  and `view` are in radius units about the body's centre; `sunElevSin` is the
 *  Sun's elevation at the ray's lowest point, the same quantity the airlight
 *  reads. */
export function airglowRadiance(
  body: string,
  origin: Vec3,
  view: Vec3,
  sunElevSin: number,
): RGB {
  const u = airglowUniforms(body);
  const weight = nightWeight(sunElevSin);
  const green = airglowLimbFactor(origin, view, u.bands[0], u.bands[1]) * weight;
  const orange = airglowLimbFactor(origin, view, u.bands[2], u.bands[3]) * weight;
  return [
    u.green[0] * green + u.orange[0] * orange,
    u.green[1] * green + u.orange[1] * orange,
    u.green[2] * green + u.orange[2] * orange,
  ];
}

/** The shell's airglow, in GLSL. Only the shell draws it: the layer is an
 *  emissive band the sky rays cross, and a ray that ends on the ground carries
 *  its air in the surface material, where a table lookup — not this — is what
 *  is wanted. Seen from directly above, the layer is a thousandth of the haze
 *  it hangs over; seen edge-on it is the thread in the photograph. */
export const AIRGLOW_GLSL = /* glsl */`
uniform vec4 uAirglowBands;     // (green inner, green outer, orange inner, orange outer)
uniform vec3 uAirglowGreen;     // vertical-path radiance, emission colour folded in
uniform vec3 uAirglowOrange;
uniform float uAirglowLimbCap;

float sphereForwardLength(float r2, float rmu, float radius) {
  float disc = rmu * rmu - r2 + radius * radius;
  if (disc <= 0.0) return 0.0;
  float s = sqrt(disc);
  return max(-rmu + s, 0.0) - max(-rmu - s, 0.0);
}

float airglowLimbFactor(vec3 origin, vec3 view, float innerRadius, float outerRadius) {
  float r2 = dot(origin, origin);
  float rmu = dot(origin, view);
  float thickness = max(outerRadius - innerRadius, 1e-9);
  float len = sphereForwardLength(r2, rmu, outerRadius)
      - sphereForwardLength(r2, rmu, innerRadius);
  return min(max(len, 0.0) / thickness, uAirglowLimbCap);
}

vec3 airglowRadiance(vec3 origin, vec3 view, float night) {
  return uAirglowGreen * (airglowLimbFactor(origin, view, uAirglowBands.x, uAirglowBands.y) * night)
      + uAirglowOrange * (airglowLimbFactor(origin, view, uAirglowBands.z, uAirglowBands.w) * night);
}
`;

// ---------------------------------------------------------------------------
// Moonlight
// ---------------------------------------------------------------------------

/**
 * Full-moon irradiance as a fraction of sunlight — 0.25 lux against 1e5 lux.
 * PHYSICAL, and on its own it would put the moonlit sky at 2e-7 of the daylight
 * one, which is nothing at a fixed exposure.
 */
export const LUNAR_IRRADIANCE_RATIO = 1 / 4.4e5;

/**
 * The gain that makes the night side a long exposure. AUTHORED: the ISS night
 * frames it is drawn against are seconds at f/1.4 and ISO 6400 where a daylight
 * frame is a thousandth at f/8 and ISO 200 — about 2e5x — and this is most of
 * that. Full moonlight lands at 0.40 of sunlight on this scale, 1.3 stops down.
 *
 * Set by measuring the picture rather than by taste. In the ISS pose the app is
 * held to — 1.05 R over the night side under a full Moon — the moonlit cloud
 * tops now read 0.42 of full scale after the tone curve, which is what the same
 * measurement gives on the reference photograph: the upper quartile of display
 * luminance over a field of cloud, cities left out. At the earlier 1.2e5 they
 * read 0.32 and the frame was visibly darker than the photograph. The moonlit
 * ground showing between the clouds moves 0.10 to 0.15 and stays a third of the
 * tops, which is the order the two read in from orbit.
 *
 * The ceiling is the bloom threshold, not the picture. A night fragment is the
 * ground's own light plus the air in front of it plus the airglow, and all of
 * the moon-sourced part of that scales with this number; the binding channel is
 * red at a low Moon, where the aureole is the longest path the table has. The
 * composed sum reaches 1.0 at 1.85e5, so this sits at 0.95 of the ceiling, and
 * the test below re-derives both rather than remembering either. Raising it
 * further is not a taste question — past that line a night source blooms.
 */
export const MOONLIGHT_NIGHT_GAIN = 1.75e5;

/**
 * Lunar light is redder than solar, and this is by how much. B-V is 0.92 for
 * the Moon against 0.65 for the Sun, so the blue channel carries
 * 10^(-0.4 x 0.27) = 0.78 of what a grey scaling of the solar tables would give
 * it; V-R differs by 0.01 mag, which is the red channel's 1.01. Normalised on
 * green.
 *
 * PHYSICAL, and nothing draws with it. It stays here because it is what the
 * tables would compute, beside the tint that is actually used, so the two can
 * never be confused for one another.
 */
export const MOON_SPECTRUM_PHYSICAL: RGB = [1.01, 1.0, 0.78];

/** Rec.709 luminance of a linear-sRGB triple. */
const luminance = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The same amount of light in a different colour: a triple scaled so its
 *  Rec.709 luminance is exactly 1. */
function unitLuminance(c: RGB): RGB {
  const l = luminance(c);
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** The cool tint as authored, before that normalisation — the numbers a reader
 *  should recognise in MOONLIGHT_TINT, which is this triple and a divisor. */
export const MOONLIGHT_TINT_AUTHORED: RGB = [0.8, 0.92, 1.15];

/**
 * The colour moonlight is DRAWN in, and it is not the spectrum above.
 *
 * A LOOK choice: a photograph renders moonlight cool, because a camera balanced
 * for daylight puts the Moon's slightly redder sunlight on the blue side of
 * neutral, and a dark-adapted eye does the same thing for its own reason — at
 * scotopic levels the rods take over and their peak sits 50 nm blueward of the
 * cones' (the Purkinje shift), so a moonlit cloud top looks blue-white to the
 * person under it. The physical warm spectrum is what the tables compute; this
 * is what the picture needs, and the picture is what this is for. Nothing on
 * the daylight side is touched by it.
 *
 * Normalised to unit Rec.709 luminance, so this constant says what colour
 * moonlight is and MOONLIGHT_NIGHT_GAIN alone says how much of it there is.
 * (The physical spectrum's own luminance is 0.986, so the swap is a change of
 * hue and not of level.)
 *
 * Applied once, in `moonIrradiance`, which is the single factor every
 * moon-sourced term is built from: the beam on the ground, the sky's own
 * irradiance on it, the air's in-scatter, and the cloud deck lit by all three.
 * Tinting any one of them on its own is how a moonlit cloud ends up a different
 * colour from the moonlit air around it.
 */
export const MOONLIGHT_TINT: RGB = unitLuminance(MOONLIGHT_TINT_AUTHORED);

const DEG = Math.PI / 180;

/**
 * Brightness of the Moon relative to full, at a Sun-Moon-observer phase angle
 * in degrees. Krisciunas & Schaefer (1991):
 *
 *     I(a) / I(0) = 10^(-0.4 (0.026 a + 4e-9 a^4))
 *
 * which is not the illuminated fraction — a quarter Moon is 0.09 of a full one,
 * not 0.5, because the surface is rough and back-scatters hard. The fit is
 * drawn from observations out to about 150 degrees, so the last stretch is
 * tapered to reach exactly zero at new Moon rather than the 3e-4 the formula
 * would leave lighting a night that has no Moon in it.
 */
export function lunarPhaseBrightness(phaseAngleDeg: number): number {
  const a = Math.min(180, Math.abs(phaseAngleDeg));
  const curve = Math.pow(10, -0.4 * (0.026 * a + 4e-9 * a * a * a * a));
  // Zero at 180 degrees, untouched at 160 and below.
  const taper = smoothstep(-1, Math.cos(160 * DEG), Math.cos(a * DEG));
  return curve * taper;
}

/** Bodies whose night side has a moon bright enough to light it, and which one.
 *  Mars' two are a few kilometres across and contribute nothing. */
export const MOONLIGHT_SOURCES: Readonly<Record<string, string>> = { Earth: 'Moon' };

/**
 * The `uMoonIrradiance` uniform: everything that multiplies a table lookup made
 * with the Moon's direction, so a moonlit lookup costs exactly what a sunlit
 * one does. It plays the part `uAirlightScale * uSolarIrradiance` plays for the
 * Sun, and carries the same bridge out of a bake normalised to unit white
 * irradiance.
 *
 * It is also the one place MOONLIGHT_TINT is applied, and that is what makes
 * every moon-sourced term one colour: the beam, the sky's irradiance, the
 * air's in-scatter and the cloud deck all reduce to a table lookup times this.
 *
 * `sunVisibleFraction` is the Moon's own eclipse: a Moon inside Earth's shadow
 * stops lighting the ground under it, which is the one night of the year this
 * term has to get right.
 */
export function moonIrradiance(
  solarIrradianceScale: number,
  phaseAngleDeg: number,
  sunVisibleFraction = 1,
): RGB {
  const k = solarIrradianceScale
    * LUNAR_IRRADIANCE_RATIO
    * MOONLIGHT_NIGHT_GAIN
    * lunarPhaseBrightness(phaseAngleDeg)
    * Math.min(1, Math.max(0, sunVisibleFraction));
  return [
    AIRLIGHT_SCALE[0] * MOONLIGHT_TINT[0] * k,
    AIRLIGHT_SCALE[1] * MOONLIGHT_TINT[1] * k,
    AIRLIGHT_SCALE[2] * MOONLIGHT_TINT[2] * k,
  ];
}

/** What the multiple-scattering orders add over single scattering, at the
 *  worst of it: a one-order bake against a four-order one measures 1.43x in
 *  blue at a low Sun, and 1.5 is the headroom that number is used with. */
export const MULTIPLE_SCATTERING_HEADROOM = 1.5;

/**
 * The brightest sky radiance a lookup returns at one unit of solar irradiance,
 * anywhere in the table, before the photometry bridge. The worst is the aureole
 * — the horizon looked at along a low Sun FROM THE GROUND, where the Mie lobe
 * is 5.6/sr and the path is the longest the air has — at 1.41 single-scattered,
 * and this is that with the multiple-scattering headroom on top.
 */
export const PEAK_TABLE_SKY_RADIANCE = 2.2;

/**
 * The brightest one the app can actually draw, which is a different number and
 * the one the bloom contract rests on. Every scattering lookup this renderer
 * makes starts at the atmosphere ENTRY point: the shell advances its ray there
 * and the aerial segment starts there, because a lookup at the camera's own
 * radius clamps to the top row and comes back flat. At the top row the peak is
 * 0.075. The one way further in is the dev pose inside the air at 51 km, where
 * the table reaches 0.55 — and that is the number here, with the
 * multiple-scattering headroom on top, because a contract that only holds for
 * poses the shipped app can reach is not one worth writing down.
 *
 * It exists so that "no night source blooms" is an assertion and not an
 * intention: a test re-derives both sweeps, holds them under these numbers, and
 * holds the whole composed night fragment under the bloom threshold.
 *
 * Only the NIGHT sources. The Sun's own sky is over the threshold by
 * construction — 0.85 x the 3.0 the photometry bridge scales it by — and that
 * is deliberate: a bloomed daylight limb is the look. Nothing here is a clamp
 * on the physical sky, and nothing anywhere else is either.
 */
export const PEAK_REACHABLE_SKY_RADIANCE = 0.85;
