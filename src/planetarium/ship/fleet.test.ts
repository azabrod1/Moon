import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BLOOM_THRESHOLD } from '../../app/bloomConfig';
import { SHIP_CLEARANCE_AU, SHIP_HULL_MAX_EXTENT_AU, SHIP_REFERENCE_RADIUS_AU } from '../cruiseView';
import type { ShipOverride } from '../PlayerShip';
import { createFleet } from './fleet';
import { HULL_WHITE, SHIP_UNIT } from './models/fleetKit';
import { DEFAULT_SHIP, SHIP_IDS, SHIP_LABELS, SHIP_NOTES, resolveBootShip, shipSetting, type ShipId } from './shipCatalog';

// The fleet's ships are procedural, so the rules they must keep can be
// measured on the real models. Each rule here is one a ship could break
// without anything looking wrong at first: a hull too long for the pad that
// parks it, a paint bright enough to bloom beside the Sun, a blended mesh
// drawn over Earth's sea, a detail pass that quietly triples the draw calls.

const fleet = createFleet(SHIP_REFERENCE_RADIUS_AU);
const BUILT = SHIP_IDS.filter((id) => id !== DEFAULT_SHIP).map((id) => [id, fleet(id)!] as const);
/** PlayerShip draws every hull at half its authored size (PlanetariumMode). */
const GROUP_SCALE = 0.5;

const luminance = (red: number, green: number, blue: number): number => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
const isFlame = (material: THREE.Material): boolean => material.blending === THREE.AdditiveBlending;

function meshes(ship: ShipOverride): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  ship.model.updateMatrixWorld(true);
  ship.model.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) found.push(object as THREE.Mesh);
  });
  return found;
}

/** Every solid vertex, in AU from the ship's origin as it is drawn. */
function* solidPoints(ship: ShipOverride): Generator<THREE.Vector3> {
  const point = new THREE.Vector3();
  for (const mesh of meshes(ship)) {
    if (isFlame(mesh.material as THREE.Material)) continue;
    const positions = mesh.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      yield point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).multiplyScalar(GROUP_SCALE);
    }
  }
}

describe('the ships on the Ship page', () => {
  it('offers Classic first, as the default ship itself', () => {
    expect(SHIP_IDS[0]).toBe(DEFAULT_SHIP);
    expect(fleet(DEFAULT_SHIP)).toBeNull();
    for (const id of SHIP_IDS) {
      expect(id, id).toBe(id.toLowerCase());
      expect(SHIP_LABELS[id].length, id).toBeGreaterThan(0);
      expect(SHIP_NOTES[id].endsWith('.'), id).toBe(true);
    }
  });

  it('builds each ship once, without a document', () => {
    expect(typeof document).toBe('undefined');
    for (const [id, ship] of BUILT) {
      expect(fleet(id), id).toBe(ship);
      for (const point of solidPoints(ship)) {
        if (!Number.isFinite(point.lengthSq())) throw new Error(`${id} has a vertex that is not a number`);
      }
    }
  });

  it('keeps every hull inside the pad that parks it and the extent the camera clears', () => {
    // Ahead and to the sides, the pad between a parked ship's origin and a
    // body's surface; behind, the extent the near plane and the zoom floor
    // are set from (cruiseView.ts). The scale chain is pinned with them.
    expect(SHIP_UNIT * GROUP_SCALE * 1.66).toBeLessThan(SHIP_CLEARANCE_AU / SHIP_REFERENCE_RADIUS_AU);
    for (const [id, ship] of BUILT) {
      let ahead = 0;
      let aside = 0;
      let farthest = 0;
      for (const point of solidPoints(ship)) {
        farthest = Math.max(farthest, point.length());
        aside = Math.max(aside, Math.hypot(point.y, point.z));
        if (point.x > 0) ahead = Math.max(ahead, point.length());
      }
      expect(ahead, `${id} ahead`).toBeLessThan(SHIP_CLEARANCE_AU);
      expect(aside, `${id} to the side`).toBeLessThan(SHIP_CLEARANCE_AU);
      expect(farthest, `${id} at all`).toBeLessThan(SHIP_HULL_MAX_EXTENT_AU);
    }
  });

  it('draws each ship in a handful of meshes', () => {
    for (const [id, ship] of BUILT) {
      const all = meshes(ship);
      const triangles = all.reduce((sum, mesh) => {
        const { geometry } = mesh;
        return sum + (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
      }, 0);
      expect(all.length, `${id} meshes`).toBeLessThanOrEqual(20);
      expect(triangles, `${id} triangles`).toBeLessThan(15000);
    }
  });

  it('paints every hull opaque, no brighter than the default hull and never a mirror', () => {
    const white = new THREE.Color(HULL_WHITE).convertLinearToSRGB();
    const brightest = luminance(white.r, white.g, white.b) + 0.01;
    for (const [id, ship] of BUILT) {
      ship.exhaust(false, 0);
      for (const mesh of meshes(ship)) {
        const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        // Only a flame blends: Earth's ground marks its sea in the alpha
        // channel, and the raycasts that find the hull skip additive meshes.
        if (isFlame(material)) continue;
        expect(material.transparent, `${id} blends`).toBe(false);
        expect(material.blending, `${id} blends`).toBe(THREE.NormalBlending);
        if (material instanceof THREE.MeshBasicMaterial) {
          // A lamp that is always on is a dot, not a glare.
          expect(luminance(material.color.r, material.color.g, material.color.b), `${id} lamp`).toBeLessThan(BLOOM_THRESHOLD * 0.7);
          continue;
        }
        expect(material.metalness, `${id} metalness`).toBeLessThanOrEqual(0.65);
        expect(material.roughness, `${id} roughness`).toBeGreaterThanOrEqual(0.45);
        const pattern = (material.map?.image as { data: Uint8Array } | undefined)?.data;
        if (pattern) {
          for (let texel = 0; texel < pattern.length; texel += 4) {
            const lit = luminance(pattern[texel], pattern[texel + 1], pattern[texel + 2]) / 255;
            if (lit > brightest) throw new Error(`${id} has a texel brighter than the default hull`);
          }
        } else {
          const paint = material.color.clone().convertLinearToSRGB();
          expect(luminance(paint.r, paint.g, paint.b), `${id} paint`).toBeLessThanOrEqual(brightest);
        }
      }
    }
  });

  it('lights its flames with the throttle and puts them out parked', () => {
    for (const [id, ship] of BUILT) {
      const flames = meshes(ship).filter((mesh) => isFlame(mesh.material as THREE.Material));
      ship.exhaust(true, 1);
      ship.tick?.(1 / 60);
      for (const flame of flames) expect(flame.visible, `${id} burning`).toBe(true);
      ship.exhaust(false, 0);
      for (const flame of flames) expect(flame.visible, `${id} parked`).toBe(false);
    }
  });
});

describe('the chosen ship', () => {
  const storageHolding = (value: string | null) => {
    const held = new Map<string, string>(value === null ? [] : [[shipSetting.key, value]]);
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, next: string) => void held.set(key, next),
      removeItem: (key: string) => void held.delete(key),
    };
  };

  it('is the saved one, and Classic where nothing legible is saved', () => {
    expect(resolveBootShip(storageHolding(null))).toBe(DEFAULT_SHIP);
    expect(resolveBootShip(storageHolding('saucer'))).toBe('saucer');
    // A ship this build does not offer (one a later build added, or took away).
    expect(resolveBootShip(storageHolding('galleon'))).toBe(DEFAULT_SHIP);
  });

  it('round-trips every ship through its key', () => {
    const storage = storageHolding(null);
    for (const id of SHIP_IDS) {
      expect(shipSetting.write(id, storage)).toBe(true);
      expect(shipSetting.read(storage)).toBe<ShipId>(id);
    }
  });
});
