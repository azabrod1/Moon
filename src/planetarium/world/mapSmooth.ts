/**
 * Whether a ground's colour map is drawn through the smooth magnification
 * filter (world/surfaceShading SURFACE_MAP_FRAGMENT) right now, kept as the two
 * facts it is made of:
 *
 * - the RULE: the body's photograph is one worth smoothing up close
 *   (PlanetFactory's smoothsMagnifiedMap), set once when the material is built;
 * - whether a PHOTOGRAPH is the map bound at this moment. A body whose image has
 *   not arrived yet wears painted noise (the moons' procedural floor), and one
 *   whose fetch failed wears the 256×128 stand-in loadTexture falls back to;
 *   neither has a texel grid worth four extra taps. Every site that binds a
 *   colour map says which it bound: the texture ladder's one swap
 *   (textureLadder setMaterialColorMap), the procedural painters, and the
 *   planet's construction.
 *
 * The live uniform is their AND. A streamed tile is always a photograph, so a
 * sector takes its globe's rule and not its globe's momentary state
 * (world/sectorMaterial): a tile landing over a globe still on its stand-in
 * smooths from the first frame it draws.
 *
 * The rule also decides how a globe's colour map wraps (globeColorWrap below),
 * so `?mapsmooth=0` puts back the old picture whole, seam column included.
 *
 * A leaf module: the ladder reports its swaps here without importing the
 * surface shading, which reaches the ladder through world/surfaceDensity.
 */
import * as THREE from 'three';

export interface MapSmoothGate {
  /** The body's rule, as the factory (or a sector's globe) answered it. */
  rule: boolean;
  /** Whether the map bound now is a photograph. */
  photo: boolean;
  /** 1 while both hold, else 0: the shader's `uMapSmooth`. */
  readonly uniform: { value: number };
}

const gates = new WeakMap<THREE.Material, MapSmoothGate>();

function sync(gate: MapSmoothGate): void {
  gate.uniform.value = gate.rule && gate.photo ? 1 : 0;
}

/** A fresh gate for a material being augmented: rule off, no photograph. */
export function createMapSmoothGate(mat: THREE.Material): MapSmoothGate {
  const gate: MapSmoothGate = { rule: false, photo: false, uniform: { value: 0 } };
  gates.set(mat, gate);
  return gate;
}

export function mapSmoothGateOf(mat: THREE.Material): MapSmoothGate | undefined {
  return gates.get(mat);
}

/** Set the body's rule. A material with no gate (not a surface) is left alone. */
export function setMapSmoothRule(mat: THREE.Material, on: boolean): void {
  const gate = gates.get(mat);
  if (!gate) return;
  gate.rule = on;
  sync(gate);
}

/** Say whether the colour map just bound on this material is a photograph. */
export function setColorMapIsPhoto(mat: THREE.Material, photo: boolean): void {
  const gate = gates.get(mat);
  if (!gate) return;
  gate.photo = photo;
  sync(gate);
}

/** Whether a texture is a photograph rather than a stand-in for one. */
export function isPhotoTexture(tex: THREE.Texture | null | undefined): boolean {
  return !!tex && tex.userData?.proceduralFallback !== true;
}

/**
 * Wrap a globe colour map for a material whose rule is on: periodic in
 * longitude (S), clamped in latitude (T).
 *
 * The smooth filter's four taps reach a texel and a half past the sample on
 * each side, so near u = 0 or u = 1 they read past the map's edge. Under
 * clamp-to-edge they read the edge column again instead of the column across
 * the seam, and the spline draws a step there on rows where bilinear had none;
 * the equirect map's first and last columns are neighbours on the ground, and
 * a periodic S reads them as neighbours. T stays clamped: past a pole is not
 * the other end of the map.
 *
 * Must run before the texture's first upload — three applies the wrap with the
 * upload, and a later change would mean a second upload of a source the ladder
 * may already have released. So the load sites call it as the texture arrives,
 * not the swap. A sector tile is a crop with its own gutters and stays clamped
 * in both (world/sectorGrid).
 */
export function globeColorWrap(tex: THREE.Texture, periodicLongitude: boolean): void {
  if (!periodicLongitude) return;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
}

/** globeColorWrap by the rule a material carries. */
export function globeColorWrapFor(tex: THREE.Texture, mat: THREE.Material): void {
  globeColorWrap(tex, gates.get(mat)?.rule === true);
}
