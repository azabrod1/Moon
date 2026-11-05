/**
 * A body's fine sphere as plain arrays, and the geometry made from them.
 *
 * The two halves of building a fine sphere off the main thread
 * (world/fineSpheres): `buildFineSphereArrays` runs in the worker, and
 * `sphereFromArrays` runs on the main thread when the arrays arrive.
 *
 * The worker builds the sphere with three's own `SphereGeometry` and lays its
 * ground index out with world/groundCull's own `layoutGroundIndex`: the same
 * code as the main-thread build, run in another thread. So the arrays are
 * those bytes, and not an imitation of them that would have to be kept in step
 * with three.
 *
 * The main thread does not rebuild anything. It takes a SphereGeometry built
 * at the smallest grid three allows (3 × 2, a few dozen numbers) and puts the
 * fine arrays, the index and the parameters the worker's sphere was built with
 * in its place. That gives a real SphereGeometry, which is what the readers
 * check: `sphereWidthSegments` (the atmosphere shell's classification) reads
 * `parameters.widthSegments`, groundCull's layout reads the width and height,
 * and the cloud deck reads `parameters.radius`. Every array keeps its type
 * (Float32Array attributes, three's choice of index width) and its bytes. The
 * attributes are plain BufferAttributes rather than three's
 * Float32BufferAttribute and Uint16BufferAttribute subclasses: those
 * constructors only copy their input into a typed array, which would be a
 * second copy of arrays that are already typed. Three tells attributes apart
 * by their array, never by those classes.
 *
 * Nothing here touches the DOM or a renderer, so the worker can import it.
 */
import * as THREE from 'three';
import { adoptGroundIndex, layoutGroundIndex, type GroundIndex, type GroundLayout } from './groundCull';

/** What three's SphereGeometry records about the sphere it built. */
export interface SphereParameters {
  radius: number;
  widthSegments: number;
  heightSegments: number;
  phiStart: number;
  phiLength: number;
  thetaStart: number;
  thetaLength: number;
}

/** One fine sphere, as transferable arrays. */
export interface FineSphereArrays {
  parameters: SphereParameters;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** Three's index: the geometry's own, or, with a layout, the list the layout
   *  is checked against when it replaces it (as `layGroundIndex` does). */
  index: Uint16Array | Uint32Array;
  /** The ground index laid out for `leaf`, when one was asked for. */
  layout?: GroundLayout & { leaf: number };
}

/**
 * Build a sphere exactly as `new THREE.SphereGeometry(radius, width, height)`
 * does, plus its ground layout for `leaf` when one is given, as arrays.
 */
export function buildFineSphereArrays(
  radius: number,
  width: number,
  height: number,
  leaf?: number,
): FineSphereArrays {
  const geometry = new THREE.SphereGeometry(radius, width, height);
  const index = geometry.index!.array as Uint16Array | Uint32Array;
  const arrays: FineSphereArrays = {
    parameters: { ...geometry.parameters },
    position: geometry.getAttribute('position').array as Float32Array,
    normal: geometry.getAttribute('normal').array as Float32Array,
    uv: geometry.getAttribute('uv').array as Float32Array,
    index,
  };
  if (leaf !== undefined) {
    const p = geometry.parameters;
    arrays.layout = { ...layoutGroundIndex(index, p.widthSegments, p.heightSegments, leaf), leaf };
  }
  return arrays;
}

/** Every buffer a reply can hand over without a copy. */
export function fineSphereTransfer(arrays: FineSphereArrays): ArrayBuffer[] {
  const buffers = [arrays.position, arrays.normal, arrays.uv, arrays.index].map((a) => a.buffer as ArrayBuffer);
  if (arrays.layout) buffers.push(arrays.layout.index.buffer as ArrayBuffer, arrays.layout.start.buffer as ArrayBuffer);
  return buffers;
}

/**
 * The SphereGeometry the arrays describe, laid out for cutting when they carry
 * a layout. Never drawn before this, so the layout is adopted where the
 * geometry is made, as groundCull requires.
 */
export function sphereFromArrays(arrays: FineSphereArrays): { geometry: THREE.SphereGeometry; ground?: GroundIndex } {
  const p = arrays.parameters;
  const geometry = new THREE.SphereGeometry(p.radius, 3, 2);
  // Typed read-only, but a plain field: three's own SphereGeometry.copy assigns
  // it the same way.
  (geometry as { parameters: SphereParameters }).parameters = { ...p };
  geometry.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(arrays.uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(arrays.index, 1));
  if (!arrays.layout) return { geometry };
  return { geometry, ground: adoptGroundIndex(geometry, arrays.layout) };
}
