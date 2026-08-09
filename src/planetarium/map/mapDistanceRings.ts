/**
 * Distance rings: dashed circles around the Sun at 1, 5, 10, 20 and 30 AU, so
 * a true-scale chart can be read as a measurement rather than a picture.
 *
 * They only mean anything at true scale. The compressed chart bends distance
 * by design, and a ruler laid over a bent scale is a lie with a number on it —
 * so the chart's own draw gate keeps them for a settled true scale, and this
 * module just builds them.
 *
 * The circles lie in the J2000 ECLIPTIC plane, which is not the scene's plane:
 * the scene is J2000 equatorial. They are built in ecliptic coordinates and
 * rotated through `eclipticToEquatorial` — the single definition site for that
 * obliquity — rather than by re-inlining a rotation here.
 *
 * The dashes are geometry, not a dashed material. A LineDashedMaterial meters
 * its dash in world units, so one dash length across radii from 1 to 30 AU
 * gives the inner ring a handful of dashes and the outer one thousands; cutting
 * a fixed COUNT of gaps per ring instead makes every ring read the same at
 * every radius. It also keeps them on the plain 1 px line material, which is
 * the weight the ring is meant to have — furniture, never a body.
 *
 * They live on the map's star layer so the corner chart never draws them: the
 * fixed little frame is always compressed, which is the one scale they must
 * not appear on.
 */
import * as THREE from 'three';
import { eclipticToEquatorial } from '../../astronomy/planetary';
import { MAP_STAR_LAYER } from './mapStars';

/** Where the rings sit, in AU. Every radius is inside the chart's own extent,
 *  so no ring is ever cut by the far plane at an edge-on pose. */
export const MAP_RING_RADII_AU: readonly number[] = [1, 5, 10, 20, 30];

/** Dashes per ring, and how much of each dash's slot is drawn. A count rather
 *  than a length: see the module note. */
const DASHES_PER_RING = 144;
const DASH_DUTY = 0.5;

const LINE_COLOR = 0x8ca0c8;
const LINE_OPACITY = 0.22;

let labelPoints: THREE.Vector3[] | null = null;

/** Where each ring's label belongs, in ring order: the +X point of its circle
 *  in the ecliptic plane, in scene (equatorial) coordinates. One fixed bearing
 *  for all five, so the labels line up as a scale rather than scattering.
 *
 *  Built once and handed out read-only — the chart projects these every frame
 *  the layer is on, and a fresh vector per ring per frame is exactly the kind
 *  of allocation a steady chart must not make. */
export function ringLabelPoints(): readonly THREE.Vector3[] {
  labelPoints ??= MAP_RING_RADII_AU.map(
    (radiusAU) => eclipticToEquatorial(new THREE.Vector3(radiusAU, 0, 0)),
  );
  return labelPoints;
}

/** How a ring's radius is printed beside it. */
export function ringLabelText(radiusAU: number): string {
  return `${radiusAU} AU`;
}

export function createMapDistanceRings(): THREE.LineSegments {
  const positions = new Float32Array(MAP_RING_RADII_AU.length * DASHES_PER_RING * 6);
  const ecliptic = new THREE.Vector3();
  let at = 0;
  for (const radiusAU of MAP_RING_RADII_AU) {
    for (let i = 0; i < DASHES_PER_RING; i++) {
      const start = (i / DASHES_PER_RING) * Math.PI * 2;
      const end = start + (DASH_DUTY / DASHES_PER_RING) * Math.PI * 2;
      for (const angle of [start, end]) {
        ecliptic.set(radiusAU * Math.cos(angle), 0, radiusAU * Math.sin(angle));
        const scene = eclipticToEquatorial(ecliptic);
        positions[at++] = scene.x;
        positions[at++] = scene.y;
        positions[at++] = scene.z;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    transparent: true,
    opacity: LINE_OPACITY,
    // Depth read, no depth write: a body in front of a ring occludes it, and
    // the rings never occlude each other or anything drawn after them — the
    // orbit lines' rule, and these are the same kind of furniture.
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });

  const rings = new THREE.LineSegments(geometry, material);
  rings.frustumCulled = false;
  rings.layers.set(MAP_STAR_LAYER);
  rings.visible = false;
  return rings;
}
