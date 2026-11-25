import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BLOOM_THRESHOLD } from '../../app/bloomConfig';
import { SHIP_CLEARANCE_AU, SHIP_HULL_MAX_EXTENT_AU, SHIP_REFERENCE_RADIUS_AU } from '../cruiseView';
import type { ShipOverride } from '../PlayerShip';
import { createFleet } from './fleet';
import { HULL_WHITE, SHIP_UNIT, wing } from './models/fleetKit';
import {
  DEFAULT_SHIP, SHIP_IDS, SHIP_LABELS, SHIP_NOTES, resolveBootShip, shipPageNote, shipRowValue, shipSetting,
  type ShipId,
} from './shipCatalog';

// The fleet's ships are procedural, so the rules they must keep can be
// measured on the real models. Each rule here is one a ship could break
// without anything looking wrong at first: a hull too long for the pad that
// parks it, a paint bright or glossy enough to bloom beside the Sun, a mesh
// that writes alpha over Earth's sea, a detail pass that quietly triples the
// cost of the hull's raycasts.

const fleet = createFleet(SHIP_REFERENCE_RADIUS_AU);
const BUILT = SHIP_IDS.filter((id) => id !== DEFAULT_SHIP).map((id) => [id, fleet(id)!] as const);
/** PlayerShip draws every hull at half its authored size (PlanetariumMode). */
const GROUP_SCALE = 0.5;
/** One authoring unit, as drawn, in AU. */
const UNIT_AU = SHIP_REFERENCE_RADIUS_AU * SHIP_UNIT * GROUP_SCALE;

const luminance = (red: number, green: number, blue: number): number => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
/** A flame is the one kind of mesh that blends. */
const isFlame = (mesh: THREE.Mesh): boolean => (mesh.material as THREE.Material).transparent;
/** Whether the rays that ask what the hull hides test this mesh at all. */
const takesRays = (mesh: THREE.Mesh): boolean => mesh.raycast === THREE.Mesh.prototype.raycast;

function meshes(ship: ShipOverride): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  ship.model.updateMatrixWorld(true);
  ship.model.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) found.push(object as THREE.Mesh);
  });
  return found;
}

/** A mesh's triangles as drawn, three corners each, in AU from the ship's origin. */
function* triangles(mesh: THREE.Mesh): Generator<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const positions = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const count = index ? index.count : positions.count;
  for (let first = 0; first < count; first += 3) {
    corners.forEach((corner, offset) => {
      corner.fromBufferAttribute(positions, index ? index.getX(first + offset) : first + offset)
        .applyMatrix4(mesh.matrixWorld).multiplyScalar(GROUP_SCALE);
    });
    yield corners;
  }
}

/** The area a mesh covers, in square authoring units. */
function area(mesh: THREE.Mesh): number {
  let total = 0;
  for (const [first, second, third] of triangles(mesh)) {
    total += second.clone().sub(first).cross(third.clone().sub(first)).length() / 2;
  }
  return total / (UNIT_AU * UNIT_AU);
}

/** The brightest texel of a pattern, as a share of white (sRGB bytes, as painted). */
function brightestTexel(texture: THREE.Texture | null): number {
  const data = (texture?.image as { data: Uint8Array } | undefined)?.data;
  if (!data) return 1;
  let brightest = 0;
  for (let texel = 0; texel < data.length; texel += 4) {
    brightest = Math.max(brightest, luminance(data[texel], data[texel + 1], data[texel + 2]) / 255);
  }
  return brightest;
}

describe('the kit the ships are built from', () => {
  it('closes a wing with every face looking out, the two ends included', () => {
    // A straight wing is convex, so a face looks out exactly when it looks
    // away from the wing's middle. An end cap wound the other way is culled
    // and leaves the tip open.
    const sections = [{ span: 0.5, lead: 1, chord: 2, thick: 0.4 }, { span: 2.5, lead: 1, chord: 2, thick: 0.4 }];
    const middle = new THREE.Vector3(0, 0, 1.5);
    let faces = 0;
    for (const skin of wing(sections)) {
      const positions = skin.getAttribute('position');
      const normals = skin.getAttribute('normal');
      for (let first = 0; first < positions.count; first += 3) {
        const [a, b, c] = [0, 1, 2].map((offset) => new THREE.Vector3().fromBufferAttribute(positions, first + offset));
        const facing = b.clone().sub(a).cross(c.clone().sub(a));
        if (facing.lengthSq() < 1e-12) continue;
        const outward = a.clone().add(b).add(c).divideScalar(3).sub(middle);
        expect(facing.dot(outward), `face ${first / 3}`).toBeGreaterThan(0);
        // The stored normal agrees with the face, or it would be lit from inside.
        expect(new THREE.Vector3().fromBufferAttribute(normals, first).dot(facing), `normal ${first / 3}`).toBeGreaterThan(0);
        faces++;
      }
    }
    expect(faces).toBeGreaterThan(40);
  });
});

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
      for (const mesh of meshes(ship)) {
        for (const corners of triangles(mesh)) {
          if (!corners.every((corner) => Number.isFinite(corner.lengthSq()))) throw new Error(`${id} has a vertex that is not a number`);
        }
      }
    }
  });

  it('keeps every hull inside the pad that parks it and the extent the camera clears', () => {
    // Ahead and to the sides, the pad between a parked ship's origin and a
    // body's surface; behind, the extent the near plane and the zoom floor
    // are set from (cruiseView.ts). The kit's two numbers are pinned to them.
    expect(1.66 * UNIT_AU).toBeLessThan(SHIP_CLEARANCE_AU);
    expect(2.44 * UNIT_AU).toBeLessThan(SHIP_HULL_MAX_EXTENT_AU);
    for (const [id, ship] of BUILT) {
      let ahead = 0;
      let aside = 0;
      let farthest = 0;
      for (const mesh of meshes(ship).filter((candidate) => !isFlame(candidate))) {
        for (const corners of triangles(mesh)) {
          for (const point of corners) {
            farthest = Math.max(farthest, point.length());
            aside = Math.max(aside, Math.hypot(point.y, point.z));
            if (point.x > 0) ahead = Math.max(ahead, point.length());
          }
        }
      }
      expect(ahead, `${id} ahead`).toBeLessThan(SHIP_CLEARANCE_AU);
      expect(aside, `${id} to the side`).toBeLessThan(SHIP_CLEARANCE_AU);
      expect(farthest, `${id} at all`).toBeLessThan(SHIP_HULL_MAX_EXTENT_AU);
    }
  });

  it('draws each ship in a handful of meshes, and keeps the hull\'s raycasts cheap', () => {
    for (const [id, ship] of BUILT) {
      const all = meshes(ship);
      const count = (some: THREE.Mesh[]): number => some.reduce((sum, mesh) => {
        const { geometry } = mesh;
        return sum + (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
      }, 0);
      expect(all.length, `${id} meshes`).toBeLessThanOrEqual(20);
      expect(count(all), `${id} triangles`).toBeLessThan(12000);
      // A ray tests every triangle of a mesh whose box it crosses, 37 rays a
      // frame while the Sun is behind the ship: fine parts and lights stay
      // out of it, and what is left is a few thousand triangles.
      const solid = all.filter(takesRays);
      expect(solid.length, `${id} has a hull to hit`).toBeGreaterThan(0);
      expect(count(solid), `${id} triangles the rays test`).toBeLessThan(3600);
      for (const mesh of all.filter(isFlame)) expect(takesRays(mesh), `${id} flame`).toBe(false);
    }
  });

  it('paints every hull opaque, no brighter than the default hull and never glossy', () => {
    const white = new THREE.Color(HULL_WHITE).convertLinearToSRGB();
    const brightest = luminance(white.r, white.g, white.b) + 0.01;
    for (const [id, ship] of BUILT) {
      for (const mesh of meshes(ship).filter((candidate) => !isFlame(candidate))) {
        const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        expect(material.blending, `${id} blends`).toBe(THREE.NormalBlending);
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        expect(material.metalness, `${id} metalness`).toBeLessThanOrEqual(0.65);
        // A broad surface mirrors the Sun into the chase camera unless it is
        // matte (the kit's header); a small or tightly curved one may shine a
        // little more.
        expect(material.roughness, `${id} roughness`).toBeGreaterThanOrEqual(area(mesh) > 2.5 ? 0.62 : 0.45);
        const paint = material.color.clone().convertLinearToSRGB();
        const lit = luminance(paint.r, paint.g, paint.b) * brightestTexel(material.map);
        expect(lit, `${id} paint`).toBeLessThanOrEqual(brightest);
      }
    }
  });

  it('keeps every light a ship carries under the bloom, parked and at full burn', () => {
    // A lamp, a window, a hot radiator: each reads as a light, never a glare.
    // Only a flame near full burn may cross the threshold.
    const ceiling = BLOOM_THRESHOLD * 0.7;
    for (const [id, ship] of BUILT) {
      for (const [state, on, throttle] of [['parked', false, 0], ['at full burn', true, 1]] as const) {
        ship.exhaust(on, throttle);
        ship.tick?.(1 / 60);
        for (const mesh of meshes(ship).filter((candidate) => !isFlame(candidate))) {
          const material = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
          if (material instanceof THREE.MeshStandardMaterial) {
            const glow = material.emissive;
            const lit = luminance(glow.r, glow.g, glow.b) * material.emissiveIntensity * brightestTexel(material.emissiveMap);
            expect(lit, `${id} glow, ${state}`).toBeLessThan(ceiling);
          } else {
            expect(luminance(material.color.r, material.color.g, material.color.b), `${id} lamp, ${state}`).toBeLessThan(ceiling);
          }
        }
      }
      ship.exhaust(false, 0);
    }
  });

  it('lights its flames with the throttle and puts them out parked, writing no alpha', () => {
    for (const [id, ship] of BUILT) {
      const flames = meshes(ship).filter(isFlame);
      // The saucer has no flame; every other ship has engines.
      if (id !== 'saucer') expect(flames.length, `${id} has flames`).toBeGreaterThan(0);
      ship.exhaust(true, 1);
      for (const flame of flames) {
        expect(flame.visible, `${id} burning`).toBe(true);
        // Earth's ground marks its sea in the alpha channel: a flame adds to
        // the colour and leaves the alpha as it found it.
        const material = flame.material as THREE.Material;
        expect([material.blending, material.blendSrcAlpha, material.blendDstAlpha], `${id} flame blend`)
          .toEqual([THREE.CustomBlending, THREE.ZeroFactor, THREE.OneFactor]);
        expect(material.depthWrite, `${id} flame depth`).toBe(false);
      }
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

  it('says why it is not on screen: a mission first, then a look, then Show ship', () => {
    const flying = { mission: false, lookShip: false, shown: true };
    expect(shipPageNote('manta', flying)).toBe(SHIP_NOTES.manta);
    const hidden = shipPageNote('manta', { ...flying, shown: false });
    const look = shipPageNote('manta', { ...flying, lookShip: true, shown: false });
    const mission = shipPageNote('manta', { mission: true, lookShip: true, shown: false });
    expect(hidden).toContain('Show ship');
    expect(look).toContain('look');
    expect(mission).toContain('mission');
    expect(new Set([SHIP_NOTES.manta, hidden, look, mission]).size).toBe(4);
    expect(shipRowValue('manta', true)).toBe(SHIP_LABELS.manta);
    expect(shipRowValue('manta', false)).toContain(SHIP_LABELS.manta);
    expect(shipRowValue('manta', false)).not.toBe(SHIP_LABELS.manta);
  });
});
