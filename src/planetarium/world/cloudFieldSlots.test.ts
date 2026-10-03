import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cloudFieldOn, enableCloudField, setCloudFieldOn } from './cloudFieldSlots';

const defines = (mat: THREE.Material): Record<string, string> =>
  (mat as THREE.Material & { defines?: Record<string, string> }).defines ?? {};

describe('the cloud field\'s session switch', () => {
  it('compiles the field into nothing while the session does not have it', () => {
    // The order the boot runs in: the session's answer is settled before the
    // deck is built, and a session without the field leaves the deck's
    // program the one it was.
    expect(cloudFieldOn()).toBe(false);
    const deck = new THREE.MeshStandardMaterial();
    const version = deck.version;
    enableCloudField(deck);
    expect(defines(deck).CLOUD_FIELD).toBeUndefined();
    expect(deck.version).toBe(version);
  });

  it('takes the define back off every material it put it on when the field goes off', () => {
    // A context restore that cannot allocate the pool again: the deck and its
    // warm-up probe relink without the field rather than sample a pool that is
    // not there, which would draw every resident page as clear sky.
    setCloudFieldOn(true);
    const deck = new THREE.MeshStandardMaterial();
    deck.defines = { CLOUD_DECK: '' };
    const probe = new THREE.MeshStandardMaterial();
    enableCloudField(deck);
    enableCloudField(probe);
    expect(defines(deck)).toEqual({ CLOUD_DECK: '', CLOUD_FIELD: '' });
    expect(defines(probe).CLOUD_FIELD).toBe('');
    const [deckVersion, probeVersion] = [deck.version, probe.version];
    setCloudFieldOn(false);
    expect(cloudFieldOn()).toBe(false);
    expect(defines(deck)).toEqual({ CLOUD_DECK: '' });
    expect(defines(probe).CLOUD_FIELD).toBeUndefined();
    // needsUpdate, so the next draw links the other program.
    expect(deck.version).toBeGreaterThan(deckVersion);
    expect(probe.version).toBeGreaterThan(probeVersion);
    // And a material built after it is off never takes it.
    const late = new THREE.MeshStandardMaterial();
    enableCloudField(late);
    expect(defines(late).CLOUD_FIELD).toBeUndefined();
  });
});
