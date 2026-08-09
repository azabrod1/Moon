/**
 * Surface-view daylight sky: the atmosphere as seen from the ground, not from
 * space. The shell in shared/shaders/atmosphere.ts paints the limb fringe a
 * body shows a distant camera; this module is the other side of the same air —
 * a camera-centred dome that scatters the day sky over an observer standing on
 * a body with an ATMOSPHERES entry (Earth's blue vault, Mars' butterscotch,
 * the giants' haze), warms through twilight at the terminator, and — the
 * showpiece — collapses through a solar eclipse: the sky holds its blue while
 * the Sun is bitten, slides down through the deep partial phases, and at
 * totality drops to a dusk vault with a 360° sunset ring on the horizon while
 * the stars come out.
 *
 * Split the usual way: pure drive math (computeSurfaceSkyDrive — sun elevation
 * + exposed-Sun fraction in, radiance/star-wash levers out) is DOM-free and
 * pinned by colocated tests; the dome mesh/shader factory below feeds those
 * levers to the GPU. The mode recentres the dome on the camera each frame and
 * owns the per-frame uniform feed (PlanetariumMode.updateSurfaceSky).
 *
 * Rendering contract: additive linear HDR radiance, depth-ignorant (the
 * airlight sits between the observer and everything celestial — it washes the
 * daytime Moon pale and hazes the ground toward the horizon), tonemapped by
 * the shared composer. Radiance stays below the bloom threshold so the sky
 * itself never blooms; only the Sun's own glare does. The dome is world-space
 * geometry, so the lens pass warps it like the rest of the scene — none of the
 * screen-authored pre-distortion rules apply.
 */
import * as THREE from 'three';
import { ATMOSPHERES } from '../PlanetFactory';

/**
 * Residual skylight at a fully-covered Sun: totality is dusk, not night — the
 * air overhead is still lit by the sky outside the umbra. Also the floor the
 * eclipse dimming curve bottoms out on, so the drive never quite reaches 0
 * while the Sun is up.
 */
export const ECLIPSE_SKY_FLOOR = 0.012;

/**
 * How bright the sky reads for a given exposed-Sun fraction, display-referred.
 * Illuminance falls linearly with the exposed fraction, but eyes and tonemap
 * both compress: a half-covered Sun leaves the day looking merely "off", and
 * the plunge lives in the last few percent. The 0.45 exponent is that
 * compression, authored against the screenshot battery rather than derived.
 */
export function eclipseSkyDim(visibleSunFraction: number): number {
  const vis = THREE.MathUtils.clamp(visibleSunFraction, 0, 1);
  return ECLIPSE_SKY_FLOOR + (1 - ECLIPSE_SKY_FLOOR) * Math.pow(vis, 0.45);
}

export interface SurfaceSkyDrive {
  /** Geometric day/night gate from sun elevation alone (1 full day, 0 night). */
  daylight: number;
  /** Dome radiance lever: daylight × eclipse dimming. */
  skylight: number;
  /** Warm horizon band weight — the sunset/sunrise glow around the Sun's side. */
  twilight: number;
  /** Totality dusk lever: the 360° horizon sunset ring (needs a daytime Sun
   *  almost fully covered — never fires at night). */
  duskRing: number;
  /** How much of the starfield survives the sky (1 = all of it). Day kills the
   *  stars, twilight most of them, totality hands them back. */
  starVisibility: number;
}

/**
 * The sky's levers from the two numbers that matter: the Sun's elevation sine
 * at the observer (dot of zenith and sun direction) and the exposed fraction
 * of the solar disc (1 = clear sky day, 0 = total eclipse). Pure and
 * per-frame-cheap; every output is continuous in both inputs so realtime
 * motion never steps.
 */
export function computeSurfaceSkyDrive(
  sunElevationSin: number,
  visibleSunFraction: number,
): SurfaceSkyDrive {
  const vis = THREE.MathUtils.clamp(visibleSunFraction, 0, 1);
  // Day gate: full brightness once the Sun clears ~5°, gone by ~8° below the
  // horizon — the tail past -6° (civil dusk) is what the twilight band owns.
  const daylight = THREE.MathUtils.smoothstep(sunElevationSin, -0.14, 0.08);
  const dim = eclipseSkyDim(vis);
  const skylight = daylight * dim;
  // Twilight bell: peaks with the Sun on the horizon, gone above ~16° or below
  // ~13°. Scaled by the eclipse dim too — a Sun eclipsed at sunset takes its
  // glow with it.
  const twilight =
    THREE.MathUtils.smoothstep(sunElevationSin, -0.22, -0.03) *
    (1 - THREE.MathUtils.smoothstep(sunElevationSin, 0.06, 0.28)) *
    dim;
  // The totality ring arms through the last few percent of exposed Sun and
  // needs the Sun up at all (daylight gate) — night can't ring.
  const duskRing = daylight * (1 - THREE.MathUtils.smoothstep(vis, 0.002, 0.05));
  // Star wash from the effective sky brightness. The thresholds put the
  // flood-in right at second contact: a 1%-exposed Sun still hides the field,
  // totality hands nearly all of it back — Venus-first, then everything.
  const skyBrightness = skylight + twilight * 0.12;
  const starVisibility = 1 - THREE.MathUtils.smoothstep(skyBrightness, 0.006, 0.08);
  return { daylight, skylight, twilight, duskRing, starVisibility };
}

/** Per-body surface-sky palette + strength, derived from the one ATMOSPHERES
 *  config so a shell retune carries to the ground view. */
export interface SurfaceSkyParams {
  day: THREE.Color;
  horizon: THREE.Color;
  sunset: THREE.Color;
  /** Overall radiance scale — how thick this sky reads from the ground. */
  strength: number;
}

// Ground-view sky thickness per body. Authored, not derived: the shell's
// rayleighStrength is tuned for a limb fringe against black, which is a
// different photometric question from how much of the sky vault the same air
// fills (Mars' fringe is faint yet its daytime sky is far from black).
const SURFACE_SKY_STRENGTH: Record<string, number> = {
  Earth: 1.0,
  Venus: 0.85, // cloud deck: bright, diffuse, directionless
  Mars: 0.42, // thin CO2 — a pale day, stars near the zenith at dusk
  Jupiter: 0.7,
  Saturn: 0.65,
};

/** Push a colour away from its own luminance grey — hue-preserving saturation
 *  boost, countering the desaturation the ACES tonemap applies to the dome's
 *  mid-level radiance (a sky authored at the shell's tint reads steel-grey by
 *  the time it hits the screen). */
function saturate(color: THREE.Color, amount: number): THREE.Color {
  const grey = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  color.r = THREE.MathUtils.clamp(grey + (color.r - grey) * amount, 0, 1);
  color.g = THREE.MathUtils.clamp(grey + (color.g - grey) * amount, 0, 1);
  color.b = THREE.MathUtils.clamp(grey + (color.b - grey) * amount, 0, 1);
  return color;
}

/**
 * Sky palette for a landed body, or null when it has no atmosphere (airless
 * worlds keep their black sky — that absence is the honest look). Zenith takes
 * the shell's Rayleigh day tint; the horizon whitens toward the Mie tint the
 * way airmass desaturates a real horizon; twilight warms with the shell's own
 * sunset colour (which for Mars is the real blue Martian dusk).
 */
export function surfaceSkyParams(bodyName: string): SurfaceSkyParams | null {
  const config = ATMOSPHERES[bodyName];
  if (!config) return null;
  const day = saturate(new THREE.Color(...config.dayColor), 1.35);
  const horizon = new THREE.Color(...config.mieColor).lerp(day, 0.35);
  return {
    day,
    horizon,
    sunset: new THREE.Color(...config.sunsetColor),
    strength: SURFACE_SKY_STRENGTH[bodyName] ?? THREE.MathUtils.clamp(config.rayleighStrength, 0.3, 1),
  };
}

const surfaceSkyVertexShader = /* glsl */ `
varying vec3 vDir;

void main() {
  // The dome is camera-centred and never rotated, so the object-space vertex
  // direction IS the world-space view direction.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const surfaceSkyFragmentShader = /* glsl */ `
uniform vec3 uZenith;       // local up at the observer (world)
uniform vec3 uSunDir;       // toward the Sun (world)
uniform vec3 uDayColor;     // zenith Rayleigh tint
uniform vec3 uHorizonColor; // airmass-whitened horizon tint
uniform vec3 uSunsetColor;  // twilight / totality-ring warmth
uniform float uSkylight;    // daylight x eclipse dim x body strength x fade
uniform float uTwilight;    // warm horizon band weight
uniform float uDuskRing;    // totality 360-degree ring weight
uniform float uHorizonSin;  // sine of the visible horizon's elevation — the
                            // hovering vantage sees the limb dip below 0

varying vec3 vDir;

void main() {
  vec3 V = normalize(vDir);
  float h = dot(V, uZenith);   // sine of the view elevation
  // Elevation above the VISIBLE horizon (the limb), 0 at the limb, 1 at
  // zenith: the vantage hovers, so the haze band hugs the limb rather than
  // the astronomical horizon — the gap between them must not read as a void
  // strip of naked stars under the sky.
  float lift = clamp((h - uHorizonSin) / (1.0 - uHorizonSin), 0.0, 1.0);
  // The sky ends just under the limb; the soft lip is the haze seen edge-on.
  float above = smoothstep(uHorizonSin - 0.08, uHorizonSin + 0.02, h);

  // Airmass gradient: deep hue overhead, brightening and whitening toward the
  // horizon the way a long slant path multiplies the scatter.
  float horiz = pow(1.0 - lift, 2.5);
  vec3 dome = mix(uDayColor, uHorizonColor, horiz * 0.85) * (0.38 + 0.52 * horiz);
  // Circumsolar aureole — the forward-scatter brightening around the Sun.
  // Rides uSkylight, so an eclipsed Sun takes its aureole down with it.
  float g = dot(V, uSunDir);
  vec3 sky = dome + uHorizonColor * (pow(max(g, 0.0), 6.0) * 0.25);
  vec3 radiance = sky * uSkylight;

  // Warm twilight band: horizon-hugging, weighted toward the Sun's side of
  // the sky but never zero opposite it (the whole horizon warms at dusk).
  float band = pow(1.0 - lift, 9.0);
  float sunSide = 0.25 + 0.75 * smoothstep(-0.3, 0.7, g);
  radiance += uSunsetColor * (uTwilight * band * sunSide * 0.5);

  // Totality dusk ring: the day beyond the umbra's edge, all the way round.
  radiance += uSunsetColor * (uDuskRing * band * 0.32);

  gl_FragColor = vec4(radiance * above, 1.0);
}
`;

export interface SurfaceSkyUniforms {
  uZenith: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
  uDayColor: { value: THREE.Color };
  uHorizonColor: { value: THREE.Color };
  uSunsetColor: { value: THREE.Color };
  uSkylight: { value: number };
  uTwilight: { value: number };
  uDuskRing: { value: number };
  uHorizonSin: { value: number };
}

export interface SurfaceSkyDome {
  mesh: THREE.Mesh;
  uniforms: SurfaceSkyUniforms;
}

/** Dome radius (AU): safely past the landed near plane (1e-6) and irrelevant
 *  beyond that — the material ignores depth, so only the vertex directions
 *  matter. */
const SKY_DOME_RADIUS_AU = 5e-6;

/**
 * Build the sky dome: a camera-centred back-side sphere, additive, depth-
 * ignorant, starting invisible with every lever at 0. Camera-distance 0 puts
 * it last in the transparent sort, i.e. the airlight adds over every celestial
 * body behind it — which is where air actually sits.
 */
export function createSurfaceSkyDome(): SurfaceSkyDome {
  const uniforms: SurfaceSkyUniforms = {
    uZenith: { value: new THREE.Vector3(0, 1, 0) },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uDayColor: { value: new THREE.Color(0.3, 0.55, 1.0) },
    uHorizonColor: { value: new THREE.Color(0.85, 0.9, 1.0) },
    uSunsetColor: { value: new THREE.Color(1.0, 0.45, 0.22) },
    uSkylight: { value: 0 },
    uTwilight: { value: 0 },
    uDuskRing: { value: 0 },
    uHorizonSin: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: surfaceSkyVertexShader,
    fragmentShader: surfaceSkyFragmentShader,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_DOME_RADIUS_AU, 48, 24), mat);
  mesh.name = 'SurfaceSky';
  mesh.frustumCulled = false; // camera-centred: always in frame when visible
  mesh.visible = false;
  return { mesh, uniforms };
}
