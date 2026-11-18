/**
 * Oblate spheroids: a planet flattened along its spin pole, for every test
 * that would otherwise treat it as a sphere. The body has equatorial radius a,
 * polar radius c = a(1 − f) and a unit pole p̂; any consistent length unit.
 *
 * Lines are exact. Stretch every vector along the pole by k = a/c,
 *   v′ = v + (k − 1)(v·p̂)p̂,
 * and the spheroid becomes a sphere of radius a while a ray's parameter t
 * stays the same, so "where does this line meet the body" is the sphere's
 * quadratic in the stretched frame.
 *
 * Outlines are the projected ellipse. Seen along a unit direction ŝ (from far
 * away, or along a shadow axis), the spheroid's outline is an ellipse with
 * semi-major axis a across the projected pole and semi-minor axis
 *   b′ = √(c²cos²B + a²sin²B),   sin B = p̂·ŝ,
 * along it. `projectedOutlineRadius` is that ellipse's radius in a given
 * direction, which is what "is this point inside the shadow / behind the
 * limb" compares against.
 *
 * At f = 0 these are the sphere's answers, without the stretch arithmetic.
 * Call sites that already had a sphere formula keep it for f = 0, so a body
 * with no flattening behaves bit for bit as before.
 */

export interface SpheroidShape {
  /** (a − c)/a; 0 is a sphere. */
  flattening: number;
  /** Unit spin pole, in the frame of the positions it is used with. */
  poleX: number;
  poleY: number;
  poleZ: number;
}

/** A sphere: what a body with no flattening field is. */
export const SPHERE_SHAPE: SpheroidShape = Object.freeze({ flattening: 0, poleX: 0, poleY: 1, poleZ: 0 });

/**
 * The smaller root t of |origin + t·direction| on the spheroid (centre at the
 * origin of these coordinates), or NaN where the line misses it. `direction`
 * need not be unit: t is in its units. A negative t is behind the origin.
 */
export function raySpheroidT(
  originX: number, originY: number, originZ: number,
  directionX: number, directionY: number, directionZ: number,
  equatorialRadius: number,
  shape: SpheroidShape,
): number {
  let ox = originX, oy = originY, oz = originZ;
  let dx = directionX, dy = directionY, dz = directionZ;
  if (shape.flattening !== 0) {
    const stretch = 1 / (1 - shape.flattening) - 1;
    const originAlong = (ox * shape.poleX + oy * shape.poleY + oz * shape.poleZ) * stretch;
    ox += originAlong * shape.poleX;
    oy += originAlong * shape.poleY;
    oz += originAlong * shape.poleZ;
    const directionAlong = (dx * shape.poleX + dy * shape.poleY + dz * shape.poleZ) * stretch;
    dx += directionAlong * shape.poleX;
    dy += directionAlong * shape.poleY;
    dz += directionAlong * shape.poleZ;
  }
  const quadratic = dx * dx + dy * dy + dz * dz;
  if (!(quadratic > 0)) return NaN;
  const linear = ox * dx + oy * dy + oz * dz;
  const constant = ox * ox + oy * oy + oz * oz - equatorialRadius * equatorialRadius;
  const discriminant = linear * linear - quadratic * constant;
  if (discriminant < 0) return NaN;
  return (-linear - Math.sqrt(discriminant)) / quadratic;
}

/**
 * The equatorial radius of the spheroid through a point that shares this
 * one's centre, pole and flattening: the point's length in the frame
 * stretched along the pole, where that whole family of similar spheroids is
 * concentric spheres. It labels the nested shells a flattened body is drawn
 * with, as a radius labels a sphere's; on a sphere it is the point's distance
 * from the centre.
 */
export function spheroidLevelRadius(
  pointX: number, pointY: number, pointZ: number,
  shape: SpheroidShape,
): number {
  if (shape.flattening === 0) return Math.hypot(pointX, pointY, pointZ);
  const along = (pointX * shape.poleX + pointY * shape.poleY + pointZ * shape.poleZ) * (1 / (1 - shape.flattening) - 1);
  return Math.hypot(pointX + along * shape.poleX, pointY + along * shape.poleY, pointZ + along * shape.poleZ);
}

/** Distance from the centre to the surface along a unit direction. */
export function spheroidRadiusToward(
  directionX: number, directionY: number, directionZ: number,
  equatorialRadius: number,
  shape: SpheroidShape,
): number {
  if (shape.flattening === 0) return equatorialRadius;
  const polarRadius = equatorialRadius * (1 - shape.flattening);
  const cosPole = directionX * shape.poleX + directionY * shape.poleY + directionZ * shape.poleZ;
  const sinSquared = Math.max(0, 1 - cosPole * cosPole);
  return (equatorialRadius * polarRadius)
    / Math.sqrt(polarRadius * polarRadius * sinSquared + equatorialRadius * equatorialRadius * cosPole * cosPole);
}

/**
 * The outward unit normal at a point on (or near) the surface, written into
 * `out` as [x, y, z]: the gradient of the spheroid's equation, which on a
 * sphere is the radial direction.
 */
export function spheroidNormal(
  pointX: number, pointY: number, pointZ: number,
  shape: SpheroidShape,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  let nx = pointX, ny = pointY, nz = pointZ;
  if (shape.flattening !== 0) {
    // ∇(|v⊥|²/a² + (v·p̂)²/c²) ∝ v⊥ + (v·p̂)(a/c)²p̂.
    const ratio = 1 / (1 - shape.flattening);
    const along = (nx * shape.poleX + ny * shape.poleY + nz * shape.poleZ) * (ratio * ratio - 1);
    nx += along * shape.poleX;
    ny += along * shape.poleY;
    nz += along * shape.poleZ;
  }
  const length = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / length;
  out.y = ny / length;
  out.z = nz / length;
  return out;
}

/**
 * Radius of the outline the spheroid shows along a unit line of sight ŝ,
 * measured in a unit direction û across the line of sight (û ⊥ ŝ): the
 * projected ellipse's polar radius ab′/√(b′²cos²ψ + a²sin²ψ), ψ the angle of
 * û from the ellipse's major axis.
 */
export function projectedOutlineRadius(
  sightX: number, sightY: number, sightZ: number,
  acrossX: number, acrossY: number, acrossZ: number,
  equatorialRadius: number,
  shape: SpheroidShape,
): number {
  if (shape.flattening === 0) return equatorialRadius;
  const polarRadius = equatorialRadius * (1 - shape.flattening);
  const sinLatitude = shape.poleX * sightX + shape.poleY * sightY + shape.poleZ * sightZ;
  const cosLatitudeSquared = Math.max(0, 1 - sinLatitude * sinLatitude);
  const minorSquared =
    polarRadius * polarRadius * cosLatitudeSquared + equatorialRadius * equatorialRadius * sinLatitude * sinLatitude;
  // The projected pole q = p̂ − (p̂·ŝ)ŝ has length cos B; û's share along it is
  // sin ψ. Seen pole-on (cos B → 0) the outline is a circle of radius a.
  if (cosLatitudeSquared < 1e-12) return equatorialRadius;
  const acrossDotPole = acrossX * shape.poleX + acrossY * shape.poleY + acrossZ * shape.poleZ;
  const sinPsiSquared = Math.min(1, (acrossDotPole * acrossDotPole) / cosLatitudeSquared);
  const majorSquared = equatorialRadius * equatorialRadius;
  return Math.sqrt((majorSquared * minorSquared) / (minorSquared * (1 - sinPsiSquared) + majorSquared * sinPsiSquared));
}
