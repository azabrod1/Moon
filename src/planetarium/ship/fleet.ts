/**
 * The ships the user can choose (ship/shipCatalog.ts), built on demand.
 *
 * Each is a `ShipOverride`: a model in the default ship's frame and units,
 * with its own flames, flown in place of the default ship through
 * `PlayerShip.setOverride`. `classic` is the default ship itself, so it has no
 * builder here and reads as null.
 *
 * A ship is built the first time it is chosen and kept, so coming back to one
 * costs nothing and its animation carries on where it stopped. Every model is
 * procedural (models/fleetKit.ts): there is nothing to download, so a ship is
 * whole the moment it is picked.
 */
import type { ShipOverride } from '../PlayerShip';
import type { ShipId } from './shipCatalog';
import { createApollo } from './models/apollo';
import { createManta } from './models/manta';
import { createSaucer } from './models/saucer';
import { createShuttle } from './models/shuttle';
import { createSoyuz } from './models/soyuz';
import { createStarship } from './models/starship';
import { createTorchship } from './models/torchship';

const BUILDERS: Record<Exclude<ShipId, 'classic'>, (referenceRadiusAU: number) => ShipOverride> = {
  starship: createStarship,
  shuttle: createShuttle,
  apollo: createApollo,
  soyuz: createSoyuz,
  saucer: createSaucer,
  torchship: createTorchship,
  manta: createManta,
};

/** A fleet at the app's reference radius: `ship(id)` is that ship, the same
 *  one every time, or null for the default ship. */
export function createFleet(referenceRadiusAU: number): (id: ShipId) => ShipOverride | null {
  const built = new Map<ShipId, ShipOverride>();
  return (id) => {
    if (id === 'classic') return null;
    let ship = built.get(id);
    if (!ship) {
      ship = BUILDERS[id](referenceRadiusAU);
      built.set(id, ship);
    }
    return ship;
  };
}
