/**
 * Sector streaming: 16K-class surface detail for the hero bodies (Earth,
 * Moon, Mars) without a 16K texture. A body's map is split into 8×4 sectors
 * (sectorGrid); while the player is close, the sectors that face the camera
 * AND are large on screen each stream their own 2048² tile (plus crops of the
 * globe's relief / roughness maps) and draw as a sector mesh overlaid on the
 * globe. Everything else keeps drawing the globe's 4K map: a tile that is
 * still downloading changes nothing on screen, so there is never a hold, a
 * veil, or a half-loaded surface — the base map IS the fallback.
 *
 * The working set is bounded and stable: sectors are ranked by projected size
 * and centrality, the top N (a per-device cap) are wanted, and a resident
 * sector is only evicted for a candidate that out-ranks it by a margin — a
 * plain LRU would churn 21 MiB uploads every frame at the wall, where more
 * sectors face the camera than the cap allows. Hysteresis (want above 600
 * device px, release below 400) keeps a sector from flapping as the disc
 * breathes, and the cap plus the in-flight limit bound GPU and CPU memory.
 *
 * A tile is drawn only once it is resident on the GPU: the fetch decodes off
 * the main thread (textureBitmapLoader), the warm pump uploads it on its
 * budgeted frame, and the sector mesh is created on the pump's 'warmed'
 * outcome — nothing on the render path ever pays a texture upload. After the
 * upload the decoded bitmap is closed (tiles are cheap to re-fetch from the
 * service-worker cache); on WebGL context loss every sector is dropped and
 * streams back in.
 *
 * Sector meshes are children of the globe mesh, so they inherit its spin,
 * pole and the moon render-curve scale; their vertices coincide with the
 * globe's fine (256-segment) grid, which the streamer forces before the first
 * sector shows. Their materials are built from the globe's (sectorMaterial),
 * share its per-frame shading uniforms, and mirror its scalar state every
 * frame; they own every texture they draw.
 *
 * Pure apart from three's scene graph: the loader, the warm pump and the
 * screen measurement are injected, so the policy is unit-tested without a
 * renderer. PlanetariumMode owns the per-frame call and the device facts.
 */
import * as THREE from 'three';
import {
  SECTOR_GRID_16K,
  SECTOR_TILE,
  applySectorTileTransform,
  dataCropLayout,
  sectorAngularRadius,
  sectorBoundingSphere,
  sectorCentreDirection,
  sectorMayFaceCamera,
  sectorSphereGeometry,
  type Sector,
  type SectorGrid,
  type TileLayout,
} from './sectorGrid';
import { SECTOR_RENDER_ORDER, createSectorMaterial, syncSectorMaterial } from './sectorMaterial';
import { loadStreamedTexture, type TextureLoad } from './textureBitmapLoader';
import { applyTextureDefaults, resolveTileUrl, type TextureTier } from './texturePolicy';
import { TIER_RANK } from '../PlanetFactory';
import { queueTextureWarm, type WarmOutcome } from './textureWarmer';

export type CropSlot = 'bumpMap' | 'normalMap' | 'roughnessMap';

export interface SectorCropSpec {
  /** Tile-set key under textures/tiles/ (tools/gen-tiles.mjs). */
  key: string;
  /** The base map's tier folder the crops were cut from. */
  tier: TextureTier;
  /** Width of that base map — the crop layout (content + gutter) follows. */
  baseWidth: number;
  /** Sectors of longitude a crop spans (normal maps: 2, see sectorGrid). */
  spanU?: number;
}

export interface SectorSetSpec {
  colorKey: string;
  /** Crops for the relief / roughness slots the base material carries. A slot
   *  the base does not currently have is not loaded; if the base gains one
   *  later (Mars's relief arrives after boot) resident sectors reload. */
  crops: Partial<Record<CropSlot, SectorCropSpec>>;
}

/** The bodies that ship a sector set, by catalog name. Colour tiles are the
 *  16K sets; every crop is the base map it names, sector-cut with the same
 *  gutter (tools/gen-tiles.mjs writes both). */
export const SECTOR_SETS: Record<string, SectorSetSpec> = {
  Earth: {
    colorKey: 'earth-day',
    crops: {
      bumpMap: { key: 'earth-bump', tier: '2k', baseWidth: 2048 },
      roughnessMap: { key: 'earth-roughness', tier: '2k', baseWidth: 1024 },
    },
  },
  Mars: {
    colorKey: 'mars',
    crops: { normalMap: { key: 'mars-normal', tier: '2k', baseWidth: 1440, spanU: 2 } },
  },
  Moon: {
    colorKey: 'moon',
    crops: { normalMap: { key: 'moon-normal', tier: '4k', baseWidth: 2880, spanU: 2 } },
  },
};

/** A sector is wanted once its bounding sphere spans this many DEVICE pixels
 *  — where the 4K base's 512 texels per sector fall under one texel per
 *  pixel — and released only once it shrinks under the second value, so a
 *  disc breathing around the threshold never flaps a 21 MiB upload. */
export const SECTOR_WANT_DEVICE_PX = 600;
export const SECTOR_RELEASE_DEVICE_PX = 400;

/** Resident sectors (meshes with a tile on the GPU) across all bodies. The
 *  wall view has ~12 sectors facing the camera; the cap holds the largest. */
export const SECTOR_RESIDENT_CAP_DESKTOP = 10;
export const SECTOR_RESIDENT_CAP_TOUCH = 6;
/** Tile fetches (colour + crops of one sector count as one) in flight. */
export const SECTOR_INFLIGHT_CAP_DESKTOP = 2;
export const SECTOR_INFLIGHT_CAP_TOUCH = 1;

/** A candidate evicts the weakest resident only when it out-ranks it by this
 *  factor — the admission hysteresis that keeps the working set stable. */
export const SECTOR_ADMIT_MARGIN = 1.25;

/** Cooldown after a failed sector load, doubling per consecutive failure. */
export const SECTOR_RETRY_MS = 8_000;
const SECTOR_RETRY_MAX_DOUBLINGS = 4;

/** Segments per 45° sector: 32 × 8 = the globe's 256-segment fine grid. */
export const SECTOR_SEGMENTS = 32;

/** How a sector reads on screen this frame, from the mode's projection. */
export interface SectorMeasure {
  /** Projected diameter of the sector's bounding sphere in device pixels. */
  devicePx: number;
  /** 1 at the screen centre, falling to 0 at the frame edge. */
  centrality: number;
}

/** A body registered for streaming: the globe mesh sectors attach to (its
 *  transform is theirs), the material they shade like, and the unscaled
 *  radius the sector geometry is built at. */
export interface SectorBodyHandle {
  name: string;
  spec: SectorSetSpec;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  radiusAU: number;
  /** Rebuild the globe on its fine grid now (idempotent); sectors must not
   *  show over a coarse globe, whose chords they would float above. */
  ensureFineGeometry: () => void;
}

/** What the per-frame call may do for a body. */
export type SectorSuspend = 'none' | 'admissions' | 'all';

type SlotState = 'idle' | 'loading' | 'resident';
type MapName = 'map' | CropSlot;

interface SectorSlot {
  sector: Sector;
  centreDir: THREE.Vector3;
  angularRadius: number;
  bsCentre: THREE.Vector3;
  bsRadius: number;
  state: SlotState;
  gen: number;
  /** This frame's rank (0 = not wanted). */
  score: number;
  keep: boolean;
  wanted: boolean;
  /** Crop-slot signature of the base when this sector was loaded. */
  signature: string;
  /** In-flight load: `owned` holds every decoded texture from the moment it
   *  exists (queued for warming or resident), so a release can dispose it —
   *  which also dequeues it from the warm pump through its dispose hook. */
  loading?: { pending: number; loaded: Partial<Record<MapName, THREE.Texture>>; owned: THREE.Texture[] };
  mesh?: THREE.Mesh;
  textures: THREE.Texture[];
  failStreak: number;
  retryAtMs: number;
}

interface SectorBody {
  handle: SectorBodyHandle;
  slots: SectorSlot[];
}

export interface SectorStreamerOptions {
  touch: boolean;
  load?: TextureLoad;
  warm?: (tex: THREE.Texture, onOutcome: (o: WarmOutcome) => void) => void;
  grid?: SectorGrid;
}

export interface SectorStats {
  resident: number;
  loading: number;
  bodies: Record<string, { resident: string[]; loading: string[] }>;
}

/** A real map in a material slot — not the procedural stand-in a failed
 *  boot fetch leaves there (a crop of the real map over a flat fallback would
 *  be a rectangle of relief on a smooth globe). */
function realMapIn(mat: THREE.MeshStandardMaterial, slot: CropSlot): boolean {
  const tex = mat[slot];
  return !!tex && tex.userData?.proceduralFallback !== true;
}

/** The globe draws a real photo map (boot tier or higher) — the only base a
 *  real tile may overlay. A body still on its procedural floor (a fallback
 *  after a failed fetch, a painted moon before its photo lands) would show a
 *  sector as a rectangle of a different world. */
function realAlbedoOn(mat: THREE.MeshStandardMaterial): boolean {
  const rank = mat.userData?.colorTierRank as number | undefined;
  return (rank ?? 0) >= TIER_RANK['2k'];
}

/** Which crop slots the base material carries right now — sectors loaded
 *  under a different signature reload so their maps stay the base's. */
function cropSignature(mat: THREE.MeshStandardMaterial, spec: SectorSetSpec): string {
  let sig = '';
  for (const slot of ['bumpMap', 'normalMap', 'roughnessMap'] as const) {
    if (spec.crops[slot] && realMapIn(mat, slot)) sig += slot[0];
  }
  return sig;
}

/** Close a tile's decoded bitmap once it is resident: the upload is paid, a
 *  context loss drops the sector rather than re-uploading, and 16 MiB of RAM
 *  per tile goes back. Idempotent — the loader's dispose hook closes too. */
function releaseBitmap(tex: THREE.Texture): void {
  const img = tex.image as { close?: () => void } | undefined;
  if (img && typeof img.close === 'function') img.close();
}

export class SectorStreamer {
  private readonly bodies = new Map<string, SectorBody>();
  private readonly grid: SectorGrid;
  private readonly load: TextureLoad;
  private readonly warm: (tex: THREE.Texture, onOutcome: (o: WarmOutcome) => void) => void;
  private readonly residentCap: number;
  private readonly inflightCap: number;
  private generation = 0;
  private lastNowMs = 0;
  private readonly camScratch = new THREE.Vector3();

  constructor(opts: SectorStreamerOptions) {
    this.grid = opts.grid ?? SECTOR_GRID_16K;
    this.load = opts.load ?? loadStreamedTexture;
    this.warm = opts.warm ?? queueTextureWarm;
    this.residentCap = opts.touch ? SECTOR_RESIDENT_CAP_TOUCH : SECTOR_RESIDENT_CAP_DESKTOP;
    this.inflightCap = opts.touch ? SECTOR_INFLIGHT_CAP_TOUCH : SECTOR_INFLIGHT_CAP_DESKTOP;
  }

  register(handle: SectorBodyHandle): void {
    this.unregister(handle.name);
    const slots: SectorSlot[] = [];
    for (let r = 0; r < this.grid.rows; r++) {
      for (let c = 0; c < this.grid.cols; c++) {
        const sector = { c, r };
        const bsCentre = new THREE.Vector3();
        const bs = sectorBoundingSphere(this.grid, sector, handle.radiusAU, bsCentre);
        slots.push({
          sector,
          centreDir: sectorCentreDirection(this.grid, sector, new THREE.Vector3()),
          angularRadius: sectorAngularRadius(this.grid, sector),
          bsCentre,
          bsRadius: bs.radius,
          state: 'idle',
          gen: 0,
          score: 0,
          keep: false,
          wanted: false,
          signature: '',
          textures: [],
          failStreak: 0,
          retryAtMs: 0,
        });
      }
    }
    this.bodies.set(handle.name, { handle, slots });
  }

  unregister(name: string): void {
    const body = this.bodies.get(name);
    if (!body) return;
    for (const slot of body.slots) this.release(slot);
    this.bodies.delete(name);
  }

  has(name: string): boolean {
    return this.bodies.has(name);
  }

  /**
   * One frame for one body. `camLocal` is the camera position in the globe
   * mesh's LOCAL frame (radius = handle.radiusAU there, whatever the mesh's
   * render scale); `measure` projects a bounding sphere given in that frame
   * and returns null when it cannot matter (off screen, or under the release
   * size by a conservative estimate). Bodies not called this frame keep
   * whatever they hold — call every registered body every frame.
   */
  update(
    name: string,
    camLocal: THREE.Vector3,
    measure: (bsCentreLocal: THREE.Vector3, bsRadiusLocal: number) => SectorMeasure | null,
    nowMs: number,
    suspend: SectorSuspend = 'none',
  ): void {
    const body = this.bodies.get(name);
    if (!body) return;
    this.lastNowMs = nowMs;
    const { handle, slots } = body;

    if (suspend === 'all' || !realAlbedoOn(handle.material)) {
      for (const slot of slots) this.release(slot);
      return;
    }

    const signature = cropSignature(handle.material, handle.spec);
    this.camScratch.copy(camLocal);
    for (const slot of slots) {
      let devicePx = 0;
      let score = 0;
      if (sectorMayFaceCamera(slot.centreDir, slot.angularRadius, this.camScratch, handle.radiusAU)) {
        const m = measure(slot.bsCentre, slot.bsRadius);
        if (m) {
          devicePx = m.devicePx;
          score = devicePx * (0.5 + 0.5 * Math.max(0, Math.min(1, m.centrality)));
        }
      }
      slot.score = score;
      slot.wanted = devicePx > SECTOR_WANT_DEVICE_PX;
      slot.keep = devicePx > SECTOR_RELEASE_DEVICE_PX;
      if (slot.state !== 'idle' && (!slot.keep || slot.signature !== signature)) this.release(slot);
    }

    // Mirror the globe's scalar state onto every live sector (eclipse tint,
    // relief scale) — cheap, and what keeps a sector from reading as a patch.
    for (const slot of slots) {
      if (slot.state === 'resident' && slot.mesh) {
        syncSectorMaterial(slot.mesh.material as THREE.MeshStandardMaterial, handle.material);
      }
    }

    if (suspend === 'admissions') return;

    const candidates = slots
      .filter((s) => s.wanted && s.state === 'idle' && nowMs >= s.retryAtMs)
      .sort((a, b) => b.score - a.score);
    for (const candidate of candidates) {
      if (this.inflightCount() >= this.inflightCap) break;
      if (this.liveCount() >= this.residentCap) {
        const weakest = this.weakestResident();
        if (!weakest || weakest.score * SECTOR_ADMIT_MARGIN >= candidate.score) break;
        this.release(weakest);
      }
      this.admit(body, candidate, signature);
    }
  }

  /** Drop every sector of bodies not named — a teleport's destination keeps
   *  its own; everything else is disposed now (and leaves the warm queue with
   *  its textures), so no upload for a left-behind body lands on arrival. */
  releaseAllExcept(keep: ReadonlySet<string>): void {
    for (const [name, body] of this.bodies) {
      if (keep.has(name)) continue;
      for (const slot of body.slots) this.release(slot);
    }
  }

  /** Drop everything (context loss, mode teardown); bodies stay registered
   *  and stream back in on later frames. */
  dropAll(): void {
    for (const body of this.bodies.values()) for (const slot of body.slots) this.release(slot);
  }

  dispose(): void {
    this.dropAll();
    this.bodies.clear();
  }

  stats(): SectorStats {
    const out: SectorStats = { resident: 0, loading: 0, bodies: {} };
    for (const [name, body] of this.bodies) {
      const resident: string[] = [];
      const loading: string[] = [];
      for (const s of body.slots) {
        const id = `${s.sector.c}_${s.sector.r}`;
        if (s.state === 'resident') resident.push(id);
        else if (s.state === 'loading') loading.push(id);
      }
      out.resident += resident.length;
      out.loading += loading.length;
      out.bodies[name] = { resident, loading };
    }
    return out;
  }

  private liveCount(): number {
    let n = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) if (s.state !== 'idle') n++;
    return n;
  }

  private inflightCount(): number {
    let n = 0;
    for (const body of this.bodies.values()) for (const s of body.slots) if (s.state === 'loading') n++;
    return n;
  }

  private weakestResident(): SectorSlot | null {
    let weakest: SectorSlot | null = null;
    for (const body of this.bodies.values()) {
      for (const s of body.slots) {
        if (s.state === 'idle') continue;
        if (!weakest || s.score < weakest.score) weakest = s;
      }
    }
    return weakest;
  }

  private admit(body: SectorBody, slot: SectorSlot, signature: string): void {
    const { handle } = body;
    const gen = ++this.generation;
    slot.state = 'loading';
    slot.gen = gen;
    slot.signature = signature;
    const stillWanted = () => slot.gen === gen && slot.state === 'loading';

    const maps: Array<{ name: MapName; url: string; kind: 'color' | 'data'; layout: TileLayout }> = [
      {
        name: 'map',
        url: resolveTileUrl(handle.spec.colorKey, '16k', slot.sector.c, slot.sector.r),
        kind: 'color',
        layout: SECTOR_TILE,
      },
    ];
    for (const cropSlot of ['bumpMap', 'normalMap', 'roughnessMap'] as const) {
      const crop = handle.spec.crops[cropSlot];
      if (!crop || !realMapIn(handle.material, cropSlot)) continue;
      maps.push({
        name: cropSlot,
        url: resolveTileUrl(crop.key, crop.tier, slot.sector.c, slot.sector.r),
        kind: 'data',
        layout: dataCropLayout(this.grid, crop.baseWidth, crop.spanU ?? 1),
      });
    }
    const loading = {
      pending: maps.length,
      loaded: {} as Partial<Record<MapName, THREE.Texture>>,
      owned: [] as THREE.Texture[],
    };
    slot.loading = loading;

    const fail = () => {
      if (!stillWanted()) return;
      this.disposeLoaded(slot);
      slot.state = 'idle';
      slot.loading = undefined;
      slot.failStreak += 1;
      slot.retryAtMs =
        this.lastNowMs + SECTOR_RETRY_MS * 2 ** Math.min(slot.failStreak - 1, SECTOR_RETRY_MAX_DOUBLINGS);
    };

    for (const m of maps) {
      this.load(
        m.url,
        (tex) => {
          if (!stillWanted()) {
            tex.dispose();
            return;
          }
          applyTextureDefaults(tex, m.kind);
          applySectorTileTransform(tex, this.grid, slot.sector, m.layout);
          loading.owned.push(tex); // owned from here: a release disposes it even mid-queue
          this.warm(tex, (outcome) => {
            if (!stillWanted()) {
              tex.dispose();
              return;
            }
            if (outcome !== 'warmed') {
              // 'disposed' only reaches a still-wanted attempt if something
              // else disposed the texture; either way the attempt is over.
              fail();
              return;
            }
            releaseBitmap(tex);
            loading.loaded[m.name] = tex;
            loading.pending -= 1;
            if (loading.pending === 0) this.materialize(body, slot);
          });
        },
        () => fail(),
        stillWanted,
      );
    }
  }

  private materialize(body: SectorBody, slot: SectorSlot): void {
    const { handle } = body;
    const loaded = slot.loading?.loaded;
    if (!loaded?.map) return;
    handle.ensureFineGeometry();
    const geometry = sectorSphereGeometry(handle.radiusAU, this.grid, slot.sector, SECTOR_SEGMENTS);
    const material = createSectorMaterial(handle.material, {
      map: loaded.map,
      bumpMap: loaded.bumpMap ?? null,
      normalMap: loaded.normalMap ?? null,
      roughnessMap: loaded.roughnessMap ?? null,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${handle.name} sector ${slot.sector.c}_${slot.sector.r}`;
    mesh.renderOrder = SECTOR_RENDER_ORDER;
    handle.mesh.add(mesh);
    slot.mesh = mesh;
    slot.textures = Object.values(loaded);
    slot.loading = undefined;
    slot.state = 'resident';
    slot.failStreak = 0;
  }

  private disposeLoaded(slot: SectorSlot): void {
    const loading = slot.loading;
    if (!loading) return;
    for (const tex of loading.owned) tex.dispose();
    loading.owned = [];
    loading.loaded = {};
  }

  /** Back to idle from any state: the mesh leaves the globe, and every
   *  texture the sector owned is disposed (a queued one leaves the warm pump
   *  through its dispose hook). A load in flight is superseded by generation;
   *  its late callbacks dispose what they carry. */
  private release(slot: SectorSlot): void {
    if (slot.state === 'idle') return;
    slot.gen = ++this.generation;
    this.disposeLoaded(slot);
    slot.loading = undefined;
    if (slot.mesh) {
      slot.mesh.removeFromParent();
      slot.mesh.geometry.dispose();
      (slot.mesh.material as THREE.Material).dispose();
      slot.mesh = undefined;
    }
    for (const tex of slot.textures) tex.dispose();
    slot.textures = [];
    slot.state = 'idle';
  }
}
