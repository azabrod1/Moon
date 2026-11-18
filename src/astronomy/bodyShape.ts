/**
 * The spheroid each catalog body is drawn as (spheroid.ts): its flattening
 * along its IAU pole, in the scene frame — the same pole the drawn globe is
 * built on (planetary.ts' pole basis). A body without a flattening, or not in
 * the planet catalog (moons), is a sphere. The shadow engine, the shadow
 * visuals and the renderer all ask here, so the body they draw, the shadow it
 * casts and the shadow it catches agree.
 *
 * Look inside asks too (interior/InteriorScene): a giant is cut open as the
 * spheroid the planetarium draws, its layers flattened with it. Volume compare
 * deliberately does not (volumeCompare/CompareScene): it compares volumes, and
 * draws every body as the sphere of its volumetric-mean radius, the shape
 * that holds exactly the body's volume and the one its solver is built on.
 */
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';
import { raDecToVector } from './planetary';
import { SPHERE_SHAPE, type SpheroidShape } from './spheroid';

const shapes = new Map<string, SpheroidShape>();

export function bodyShape(name: string): SpheroidShape {
  let shape = shapes.get(name);
  if (shape) return shape;
  const body = PLANETARIUM_BODIES.find((candidate) => candidate.name === name);
  if (body?.flattening) {
    const pole = raDecToVector(body.poleRaDeg, body.poleDecDeg).normalize();
    shape = Object.freeze({ flattening: body.flattening, poleX: pole.x, poleY: pole.y, poleZ: pole.z });
  } else {
    shape = SPHERE_SHAPE;
  }
  shapes.set(name, shape);
  return shape;
}
