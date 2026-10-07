/**
 * The texture units Earth's surface programs hold, counted on a real link
 * (`__moon.samplerCensus()`, asserted by tools/sampler-census.mjs). DEVELOPMENT
 * ONLY: imported by main's DEV bridge and nothing else.
 *
 * WHY A LINK. What a program spends is its ACTIVE samplers — the ones the
 * compiler keeps after it has dropped dead code — and the injected text leans
 * on that: the ground's deck block reads `uCloudDetail` behind a condition the
 * cloud field's archetype define turns into a constant false. A count taken
 * from the source sees the declaration either way; only the driver knows
 * which survived, so every row here is a program three links on this GPU and
 * GL's own ACTIVE_UNIFORMS list read back.
 *
 * WHAT IS ENUMERATED, explicitly, rather than whatever programs one session
 * happened to link: the two surfaces that spend the most — Earth's ground (its
 * colour, bump and, where it has its water mask, roughness map) and the cloud
 * deck with its relief — across every define that adds or removes a sampler,
 * in the combinations the app compiles: CLOUD_SHADOW on the ground, and
 * CLOUD_FIELD beside it (the ground takes the field only for its shadow's
 * read, never alone); CLOUD_FIELD and CLOUD_LIGHT on the deck, in any
 * combination; MIE_EXACT, the single-Mie colour table's sampler, on and off
 * across all of those on both surfaces, whichever reading this session booted;
 * and the atmosphere tables' sizes (the full and the half tier,
 * a define set on every surface). The ocean's gloss is a uniform, not a
 * define, so it forks no program; what it rides on is the roughness map, and
 * the ground is counted with and without one. The sea's wind map is in every
 * ground program and counted in its row like any other sampler;
 * `SEA_WIND_SAMPLERS` says how many sea samplers a ground row links, and the
 * battery holds every ground row to exactly that.
 */
import * as THREE from 'three';
import { augmentSurfaceMaterial } from './surfaceShading';
import { atmosphereTableDefines } from './atmosphereLut';
import { ATMOSPHERE_TABLE_SIZES_FULL, ATMOSPHERE_TABLE_SIZES_HALF } from './atmosphereModel';

/** The sea's samplers every ground program links: the one wind map
 *  (uSeaWindMap). A calm map beside it took a second unit until the sea was
 *  drawn as one lobe. */
export const SEA_WIND_SAMPLERS = 1;

export interface SamplerCensusRow {
  surface: 'ground' | 'deck';
  /** The switch defines this row compiles. */
  defines: string[];
  tables: 'full' | 'half';
  /** Whether the ground carries its water mask (the roughness map the ocean's
   *  gloss reads); the deck has none. */
  waterMask: boolean;
  samplers: string[];
}

export interface SamplerCensus {
  /** The fragment stage's texture units on this GPU. */
  maxUnits: number;
  seaWindSamplers: number;
  rows: SamplerCensusRow[];
  /** The live planetarium surfaces, linked as this session drew them, beside
   *  the census row with their defines — the check that the census builds the
   *  programs the app does. */
  live: Array<{ surface: 'ground' | 'deck'; defines: string[]; tables: 'full' | 'half'; samplers: string[] | null }>;
  /** Earth's atmosphere shell on the tables tier, as this session linked it —
   *  the one other program that reads the single-Mie colour — or null while
   *  the shell still wears the analytic material. */
  shell: { mieExact: boolean; samplers: string[] | null } | null;
}

/** Active samplers of a material's LINKED program, read from GL: the count the
 *  driver holds the program to, not one counted from the source. */
export function linkedSamplers(renderer: THREE.WebGLRenderer, mat: THREE.Material): { count: number; names: string[] } | null {
  const props = renderer.properties.get(mat) as { currentProgram?: { program: WebGLProgram } };
  const prog = props.currentProgram?.program;
  if (!prog) return null;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const samplerTypes = new Set<number>([
    gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW, gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D,
    gl.INT_SAMPLER_CUBE, gl.INT_SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D,
    gl.UNSIGNED_INT_SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY,
  ]);
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (info && samplerTypes.has(info.type)) names.push(info.name);
  }
  return { count: names.length, names: names.sort() };
}

const SWITCHES = ['CLOUD_SHADOW', 'CLOUD_FIELD', 'CLOUD_LIGHT', 'MIE_EXACT'] as const;
/** The ground's cloud combinations: the field only beside the shadow. */
const GROUND_CLOUD_SWITCHES: string[][] = [[], ['CLOUD_SHADOW'], ['CLOUD_SHADOW', 'CLOUD_FIELD']];
/** The single-Mie colour's two readings, crossed with every other combination
 *  on both surfaces: the lookup's define, on unless `?mieexact=0`, adds the
 *  colour table's sampler to whatever else a program holds. */
const MIE_SWITCHES: string[][] = [[], ['MIE_EXACT']];
const withMie = (combos: string[][]): string[][] => combos.flatMap((c) => MIE_SWITCHES.map((m) => [...c, ...m]));
const GROUND_SWITCHES = withMie(GROUND_CLOUD_SWITCHES);
const TABLE_SIZES = { full: ATMOSPHERE_TABLE_SIZES_FULL, half: ATMOSPHERE_TABLE_SIZES_HALF } as const;

/** Every subset of a list, the empty one first. */
function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [[]];
  for (const item of items) for (const prior of out.slice()) out.push([...prior, item]);
  return out;
}

function texel(kind: 'color' | 'data'): THREE.Texture {
  const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  if (kind === 'color') tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** A row's table defines, with the session's own MIE_EXACT taken out: the row
 *  states its own reading of that switch, whichever one this session boots. */
function tableDefines(
  defines: Record<string, unknown> | undefined, tables: 'full' | 'half',
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defines, ...atmosphereTableDefines(TABLE_SIZES[tables]) };
  delete out.MIE_EXACT;
  return out;
}

/** The surface's switch defines and tables tier, as a material carries them. */
function switchesOf(mat: THREE.Material): { defines: string[]; tables: 'full' | 'half' } {
  const defines = (mat as THREE.Material & { defines?: Record<string, string> }).defines ?? {};
  const half = defines.TRANSMITTANCE_TEXTURE_WIDTH === String(ATMOSPHERE_TABLE_SIZES_HALF.transmittanceW)
    && ATMOSPHERE_TABLE_SIZES_HALF.transmittanceW !== ATMOSPHERE_TABLE_SIZES_FULL.transmittanceW;
  return { defines: SWITCHES.filter((d) => defines[d] !== undefined), tables: half ? 'half' : 'full' };
}

/**
 * Link every combination and read back what each program holds. The census
 * meshes are compiled against the live scene's lights (`compile`'s target
 * scene), so their programs are keyed exactly as the app's are, then disposed.
 */
export function devSamplerCensus(
  renderer: THREE.WebGLRenderer, liveScene: THREE.Scene, camera: THREE.Camera,
): SamplerCensus {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(1, 4, 2);
  const made: Array<{ row: Omit<SamplerCensusRow, 'samplers'>; mat: THREE.MeshStandardMaterial }> = [];
  for (const tables of ['full', 'half'] as const) {
    for (const waterMask of [true, false]) {
      for (const on of GROUND_SWITCHES) {
        const mat = new THREE.MeshStandardMaterial({
          map: texel('color'), bumpMap: texel('data'), roughnessMap: waterMask ? texel('data') : null,
        });
        augmentSurfaceMaterial(mat, 'earth');
        mat.defines = tableDefines(mat.defines, tables);
        for (const d of on) mat.defines[d] = '';
        made.push({ row: { surface: 'ground', defines: on, tables, waterMask }, mat });
      }
    }
    for (const on of withMie(subsets(['CLOUD_FIELD', 'CLOUD_LIGHT']))) {
      const mat = new THREE.MeshStandardMaterial({ map: texel('color'), normalMap: texel('data'), transparent: true });
      augmentSurfaceMaterial(mat, 'cloud');
      mat.defines = tableDefines(mat.defines, tables);
      for (const d of on) mat.defines[d] = '';
      made.push({ row: { surface: 'deck', defines: on, tables, waterMask: false }, mat });
    }
  }
  for (const { mat } of made) scene.add(new THREE.Mesh(geo, mat));
  renderer.compile(scene, camera, liveScene);
  const rows: SamplerCensusRow[] = made.map(({ row, mat }) => ({ ...row, samplers: linkedSamplers(renderer, mat)?.names ?? [] }));
  for (const { mat } of made) {
    mat.map?.dispose();
    mat.bumpMap?.dispose();
    mat.roughnessMap?.dispose();
    mat.normalMap?.dispose();
    mat.dispose();
  }
  geo.dispose();

  // The live surfaces, as the session linked them.
  const live: SamplerCensus['live'] = [];
  let shell: SamplerCensus['shell'] = null;
  liveScene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === 'EarthAtmosphere') {
      const mat = mesh.material as THREE.ShaderMaterial;
      if (mat.uniforms?.uScattering) {
        shell = { mieExact: mat.defines?.MIE_EXACT !== undefined, samplers: linkedSamplers(renderer, mat)?.names ?? null };
      }
      return;
    }
    const surface = mesh.name === 'Earth clouds' ? 'deck' : mesh.name === 'Earth surface' ? 'ground' : null;
    if (!surface) return;
    const mat = mesh.material as THREE.Material;
    live.push({ surface, ...switchesOf(mat), samplers: linkedSamplers(renderer, mat)?.names ?? null });
  });
  return {
    maxUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number, seaWindSamplers: SEA_WIND_SAMPLERS, rows, live, shell,
  };
}
