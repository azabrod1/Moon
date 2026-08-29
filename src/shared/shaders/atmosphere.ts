// Atmosphere shell: a single-scatter approximation on a back-side sphere. The
// world-space normal plus a fed sun direction give a day-side Rayleigh limb that
// warms toward the terminator, and a Henyey-Greenstein Mie peak that lights a
// back-lit crescent. Output is additive linear HDR radiance so the composer's
// tonemap + bloom carry the bright forward-scatter rim.
export const atmosphereVertexShader = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vCenter;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;  // planet center in scene space
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

export const atmosphereFragmentShader = /* glsl */ `
#define PI 3.141592653589793

uniform vec3 uSunDirWorld;     // direction to the sun (scene space)
uniform vec3 uDayColor;        // Rayleigh tint in full sun
uniform vec3 uSunsetColor;     // warmed tint toward the terminator / crescent
uniform vec3 uMieColor;        // forward-scatter halo (near white)
uniform float uRayleighStrength;
uniform float uMieStrength;
uniform float uMieG;           // Henyey-Greenstein asymmetry (forward)
uniform float uPower;          // radial falloff shaping
uniform float uIntensity;
uniform float uHaloStrength;    // scales the fringe past the limb over black space: higher
                                // for a thin shell over a surface so it reads, low for
                                // cloud-deck worlds and giants so the limb stays quiet
uniform float uPlanetRadius;   // solid surface radius (shell inner bound)
uniform float alphaScale;      // distance fade, fed per frame (0 far .. 1 near)

varying vec3 vWorldPos;
varying vec3 vCenter;

void main() {
  float outerR = length(vWorldPos - vCenter);          // shell radius
  vec3 D = normalize(vWorldPos - cameraPosition);      // view ray, camera -> fragment
  vec3 oc = cameraPosition - vCenter;
  vec3 closest = cameraPosition + D * (-dot(oc, D));   // ray point nearest the center
  float b = length(closest - vCenter);                 // impact parameter (lowest radius the ray reaches)

  // Fringe profile across the limb, keyed to the ray's closest approach b.
  // Real limb hazes are a scale-height phenomenon: brightest exactly at the
  // surface limb, falling off exponentially into space, and adding almost
  // nothing over the disc (the sunlit deck behind swamps the haze — the
  // disc's own limb darkening carries the edge). The exponential tail is
  // tapered to zero before the shell silhouette so the fringe ends in space
  // without a wire.
  float shell = max(outerR - uPlanetRadius, 1e-9);
  float u = (b - uPlanetRadius) / shell;   // 0 at the surface limb, 1 at the silhouette, <0 over the disc
  float outward = exp(-u / 0.45) * (1.0 - smoothstep(0.55, 0.95, u));
  float inward = smoothstep(-0.3, -0.02, u);   // thin lip over the disc edge, gone by a third of the shell depth
  float depth = u >= 0.0 ? outward : inward;
  // Scale the part beyond the limb (over black space) per body. A thin
  // atmosphere over a surface keeps its bright arc + forward-scatter halo;
  // an all-atmosphere giant suppresses it so the limb can't ring against black.
  float overSpace = smoothstep(0.0, 0.15, u); // 0 on the lit disc, 1 just past the limb
  depth *= mix(1.0, uHaloStrength, overSpace);
  depth = pow(depth, uPower);   // per-body thinning: >1 pulls the tail in toward the limb

  // Day/night + tint evaluated where the ray dips closest to the surface.
  // Guard the central ray (b -> 0): normalize(0) is undefined, so fall back to
  // the fragment's own radial direction there.
  vec3 nClosest = b > 1e-9 ? normalize(closest - vCenter) : normalize(vWorldPos - vCenter);
  vec3 L = normalize(uSunDirWorld);
  float sunElev = dot(nClosest, L);
  // At the limb the sun sits on the local horizon, but the haze column above
  // still sees full sun — so grazing geometry passes half strength, and the
  // gate only kills the fringe past the twilight wedge on the night side.
  float day = smoothstep(-0.2, 0.2, sunElev);

  // Tint: blue where the local sun is up, warming only through the narrow
  // twilight band at the terminator — sunset colour is a local phenomenon,
  // never a whole-limb one (a front-lit limb stays blue at every phase).
  float twilight = 1.0 - smoothstep(0.02, 0.3, sunElev);
  vec3 rayleighColor = mix(uDayColor, uSunsetColor, twilight * 0.85);

  // Sunlit haze is optically thin: front-lit it barely registers against the
  // deck below it (a whisper at the limb — full-disc photos show almost
  // nothing), and it only brightens as the view swings back-lit and forward
  // scattering takes over.
  vec3 V = -D;
  float phase = dot(V, L);                             // +1 sun behind viewer, -1 crescent
  float backlit = 1.0 - smoothstep(-0.45, 0.35, phase);
  float rayleigh = depth * day * uRayleighStrength * mix(0.4, 1.0, backlit);

  // Mie forward-scatter: the thin ring of fire on a back-lit limb. Gated by
  // grazing twilight transmission rather than the day mask — the ring IS the
  // terminator seen edge-on, so it lives exactly where the day mask bottoms out.
  float rim = smoothstep(-0.25, 0.05, sunElev);
  float mu = clamp(-phase, -1.0, 1.0);
  float g = uMieG;
  float denom = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(denom, 1.5));
  float mie = depth * rim * hg * uMieStrength;

  vec3 radiance = (rayleighColor * rayleigh + uMieColor * mie) * uIntensity * alphaScale;
  gl_FragColor = vec4(radiance, 1.0);
}
`;

// City lights on the night side. An ADDITIVE layer over the globe, which is
// what decides how the air in front of it applies: the lights are attenuated by
// the transmittance of that air (they are seen THROUGH ten airmasses at the
// limb) and nothing is added, because the globe underneath has already added
// the air's own in-scattered light. Adding it again here would count the whole
// night side's airlight twice.
//
// The column is the whole one. A city is at sea level; this mesh floats a few
// kilometres up so it never z-fights the globe, and at an 8 km Rayleigh scale
// height those few kilometres are more than half the air by mass and nearly all
// of the Mie. So the segment's far end is substituted back down to the surface
// through `uAirLookupRadius`, the same uniform the cloud deck uses to move its
// end the other way.
//
// The transmittance lookup and its uniform block come from the table GLSL the
// factory prepends to the fragment source; with no tables the switch is 0 and
// the shader is what it always was.
//
// How much of the map a point draws comes from the cosine between its surface
// normal and the direction to the sun: full strength once the sun is this far
// below the local horizon, gone by the lit edge — the few degrees of twilight
// in between are where the lights fade up. Exported because anything that
// decides which ground the lights cover (which sectors are worth a tile, how
// strongly they rank) has to read the same two numbers the shader does, and the
// GLSL below is written from them so the two cannot drift apart.
export const EARTH_NIGHT_MIX_DARK = -0.3;
export const EARTH_NIGHT_MIX_LIT = -0.1;

/** The shader's `nightMix` for one sun cosine: 0 in daylight, 1 in full night.
 *  Note the shader's own response is this SQUARED — the mix multiplies the rgb
 *  and the alpha, and additive blending with a non-premultiplied source takes
 *  the alpha as its factor — so a comparison between two night surfaces is
 *  only meaningful at the same sun elevation. */
export function earthNightMix(sunDot: number): number {
  const t = (sunDot - EARTH_NIGHT_MIX_DARK) / (EARTH_NIGHT_MIX_LIT - EARTH_NIGHT_MIX_DARK);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - c * c * (3 - 2 * c);
}

export const earthNightVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSunDir;
varying vec3 vAirCam;
varying vec3 vAirFrag;
uniform vec3 sunDirection;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  // Transform sun direction to view space
  vSunDir = normalize((viewMatrix * vec4(sunDirection, 0.0)).xyz);
  // Camera and fragment as offsets from the body's centre, world axes — the
  // frame-free form the air's geometry is worked out in.
  vAirCam = cameraPosition - modelMatrix[3].xyz;
  vAirFrag = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// uUvOffset / uUvRepeat select the part of `nightTexture` this mesh draws.
// The whole-globe shell takes (0,0) and (1,1); a sector tile takes the
// transform that lands its own global equirect rectangle on the tile's
// interior, inside the gutter. A hand-written shader gets no `mapTransform`
// from three, so the rectangle has to arrive as uniforms — a sector left on
// the identity would stretch its tile's western eighth across the whole patch.
export const earthNightFragmentShader = /* glsl */ `
uniform sampler2D nightTexture;
uniform vec2 uUvOffset;
uniform vec2 uUvRepeat;
uniform vec3 sunDirection;
uniform float uAirDensity;
uniform float uPlanetRadius;
uniform float uAirLookupRadius;
uniform sampler2D uTransmittance;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSunDir;
varying vec3 vAirCam;
varying vec3 vAirFrag;

void main() {
  vec4 nightColor = texture2D(nightTexture, vUv * uUvRepeat + uUvOffset);
  // The composite's lights and its blue casts separate on the sign of the
  // chroma, with a gap between them. Every light source measured on the map
  // is warm — b-r from -8 to -37 counts across New York, London, Tokyo,
  // Delhi, Cairo and Sao Paulo — while everything that is not a light is
  // cold: snow and ice (Greenland +38, Svalbard +35, the Andes +23, the
  // Himalaya +22, Norway's highlands +22), the map's own background (+12 to
  // +25), and the polar no-data fill. Additive over a dark globe, an ice
  // sheet at +38 is a lit continent that blooms. So fade a pixel out by how
  // blue it is: gone by +12, the least blue of the casts, and untouched from
  // neutral upward — eight counts of margin below the warmest light there is.
  nightColor.rgb *= smoothstep(-12.0 / 255.0, 0.0, nightColor.r - nightColor.b);
  // Show night lights only on dark side
  float sunDot = dot(vNormal, vSunDir);
  float nightMix = 1.0 - smoothstep(${EARTH_NIGHT_MIX_DARK.toFixed(1)}, ${EARTH_NIGHT_MIX_LIT.toFixed(1)}, sunDot); // ordered edges (reversed smoothstep is undefined)
  vec3 lit = nightColor.rgb * nightMix * 1.5;
  if (uAirDensity > 0.0) {
    AerialSegment seg = aerialSegment(
        vAirCam / uPlanetRadius, normalize(vAirFrag) * uAirLookupRadius, normalize(sunDirection));
    if (seg.valid) lit *= aerialTransmittance(uTransmittance, seg);
  }
  gl_FragColor = vec4(lit, nightMix * nightColor.a);
}
`;
