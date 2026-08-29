import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  resolveProgramLinks,
  warmUpSceneShaders,
  type ProgramLinkResolver,
  type ShaderWarmupRenderer,
  type WarmupProgram,
} from './shaderWarmup';

/** A stand-in for three's program wrapper plus the two calls the resolve phase
 *  makes on it. `program` stands for the raw GL program. */
function makeProgram(name: string, opts: { getUniformsThrows?: boolean; type?: string } = {}) {
  const calls: string[] = [];
  const wrapper: WarmupProgram & { calls: string[] } = {
    name,
    type: opts.type,
    program: { name },
    getUniforms: () => {
      calls.push('getUniforms');
      if (opts.getUniformsThrows) throw new Error(`getUniforms failed for ${name}`);
      return {};
    },
    calls,
  };
  return wrapper;
}

/** The GL slice the resolve phase touches, recording what it was asked. */
function makeResolver(programs: Array<WarmupProgram & { calls: string[] }>, opts: {
  contextThrows?: boolean;
  parameterThrows?: boolean;
} = {}) {
  const parameterCalls: unknown[] = [];
  const resolver: ProgramLinkResolver = {
    getContext: () => {
      if (opts.contextThrows) throw new Error('no context');
      return {
        LINK_STATUS: 0x8b82,
        getProgramParameter: (program: unknown, pname: number) => {
          parameterCalls.push({ program, pname });
          if (opts.parameterThrows) throw new Error('getProgramParameter failed');
          return true;
        },
      } as unknown as WebGL2RenderingContext;
    },
    info: { programs },
  };
  return { resolver, parameterCalls };
}

interface RenderSnapshot {
  target: THREE.WebGLRenderTarget | null;
  viewport: number[];
  scissor: number[];
  scissorTest: boolean;
  probesVisible: boolean[];
  probePositions: THREE.Vector3[];
  frustumCulled: boolean[];
}

/** A recording stand-in for the renderer slice the warm-up touches. */
function makeRenderer(opts: {
  compile?: () => Promise<unknown>;
  render?: () => void;
  probes?: THREE.Group[];
  meshes?: THREE.Object3D[];
  initialTarget?: THREE.WebGLRenderTarget | null;
  /** Make the RESTORE to this target throw (the first bind of it succeeds). */
  failRestoreTo?: THREE.WebGLRenderTarget | null;
  /** Programs the resolve phase will find on the renderer. */
  programs?: Array<WarmupProgram & { calls: string[] }>;
} = {}) {
  let current: THREE.WebGLRenderTarget | null = opts.initialTarget ?? null;
  const viewport = new THREE.Vector4(0, 0, 640, 480);
  const scissor = new THREE.Vector4(0, 0, 640, 480);
  let scissorTest = false;
  const targetsSeenAtCompile: Array<THREE.WebGLRenderTarget | null> = [];
  const renders: RenderSnapshot[] = [];
  const setTargetCalls: Array<THREE.WebGLRenderTarget | null> = [];
  const events: string[] = []; // one ordered log across compile/render/setRenderTarget
  const warmupPrograms = opts.programs ?? [];
  const renderer: ShaderWarmupRenderer = {
    getContext: () => ({
      LINK_STATUS: 0x8b82,
      getProgramParameter: () => { events.push('resolve'); return true; },
    } as unknown as WebGL2RenderingContext),
    info: { programs: warmupPrograms },
    getRenderTarget: () => current,
    setRenderTarget: (t) => {
      if (opts.failRestoreTo !== undefined && t === opts.failRestoreTo && setTargetCalls.length > 0) throw new Error('restore failed');
      current = t; setTargetCalls.push(t); events.push('setTarget');
    },
    compileAsync: () => { events.push('compile'); targetsSeenAtCompile.push(current); return (opts.compile ?? (() => Promise.resolve()))(); },
    render: () => {
      events.push('render');
      renders.push({
        target: current,
        viewport: viewport.toArray(),
        scissor: scissor.toArray(),
        scissorTest,
        probesVisible: (opts.probes ?? []).map((g) => g.visible),
        probePositions: (opts.probes ?? []).map((g) => g.position.clone()),
        frustumCulled: (opts.meshes ?? []).map((m) => m.frustumCulled),
      });
      opts.render?.();
    },
    getViewport: (v) => v.copy(viewport),
    setViewport: (x, y, w, h) => { viewport.set(x, y, w, h); },
    getScissor: (v) => v.copy(scissor),
    setScissor: (x, y, w, h) => { scissor.set(x, y, w, h); },
    getScissorTest: () => scissorTest,
    setScissorTest: (b) => { scissorTest = b; },
  };
  return {
    renderer, targetsSeenAtCompile, renders, setTargetCalls, events,
    state: () => ({ current, viewport: viewport.toArray(), scissor: scissor.toArray(), scissorTest }),
  };
}

function makeScene() {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.frustumCulled = true;
  const uncullable = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  uncullable.frustumCulled = false;
  const probe = new THREE.Group();
  probe.visible = false;
  probe.add(new THREE.Mesh(new THREE.SphereGeometry(1e-9, 4, 2), new THREE.MeshStandardMaterial()));
  scene.add(mesh, uncullable, probe);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
  camera.position.set(3, 0, 0);
  camera.lookAt(0, 0, 0);
  return { scene, mesh, uncullable, probe, camera };
}

describe('warmUpSceneShaders', () => {
  it('composer path: compiles and warm-draws with a render target bound, then restores what was bound', async () => {
    const { scene, mesh, uncullable, probe, camera } = makeScene();
    const before = new THREE.WebGLRenderTarget(8, 8); // something already bound must come back
    const target = new THREE.WebGLRenderTarget(1, 1);
    const dispose = vi.spyOn(target, 'dispose');
    const rig = makeRenderer({ probes: [probe], meshes: [mesh, uncullable], initialTarget: before });

    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      createTarget: () => target,
    });
    await compiled;

    expect(rig.targetsSeenAtCompile).toEqual([target]);
    expect(rig.renders).toHaveLength(1);
    const draw = rig.renders[0];
    expect(draw.target).toBe(target);
    expect(draw.viewport).toEqual([0, 0, 1, 1]);
    expect(draw.scissor).toEqual([0, 0, 1, 1]);
    expect(draw.scissorTest).toBe(true);
    expect(draw.probesVisible).toEqual([true]);
    // culling is off for the draw so every material is submitted…
    expect(draw.frustumCulled).toEqual([false, false]);
    // …and the probe sits just in front of the camera
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const expected = camera.position.clone().addScaledVector(forward, camera.near * 4);
    expect(draw.probePositions[0].distanceTo(expected)).toBeLessThan(1e-9);

    // everything restored afterwards
    const after = rig.state();
    expect(after.current).toBe(before);
    expect(after.viewport).toEqual([0, 0, 640, 480]);
    expect(after.scissor).toEqual([0, 0, 640, 480]);
    expect(after.scissorTest).toBe(false);
    expect(probe.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    expect(uncullable.frustumCulled).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    // the target is bound exactly twice (compile, draw) and never left bound
    expect(rig.setTargetCalls).toEqual([target, before, target, before]);
    // and the compile always precedes the draw (the draw must find linked programs)
    expect(rig.events.filter((e) => e !== 'setTarget')).toEqual(['compile', 'render']);
  });

  it('canvas path: compiles and warm-draws with the canvas (null) bound and creates no target', async () => {
    const { scene, probe, camera } = makeScene();
    const createTarget = vi.fn(() => new THREE.WebGLRenderTarget(1, 1));
    const rig = makeRenderer({ probes: [probe] });

    await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: false,
      probeGroups: [probe],
      createTarget,
    });

    expect(createTarget).not.toHaveBeenCalled();
    expect(rig.targetsSeenAtCompile).toEqual([null]);
    expect(rig.renders).toHaveLength(1);
    expect(rig.renders[0].target).toBeNull();
    expect(rig.state().current).toBeNull();
  });

  it('a hung compileAsync poll does not hold boot: the draw still happens after the timeout', async () => {
    const { scene, probe, camera } = makeScene();
    const rig = makeRenderer({ probes: [probe], compile: () => new Promise(() => {}) });
    const t0 = Date.now();
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      timeoutMs: 30,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(rig.renders).toHaveLength(1);
    // the poll is still pending — callers wait on it before disposing probes
    let settled = false;
    void compiled.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('a rejected compileAsync is reported and swallowed; the draw still happens and `compiled` settles', async () => {
    const { scene, probe, camera } = makeScene();
    const onError = vi.fn();
    const rig = makeRenderer({ probes: [probe], compile: () => Promise.reject(new Error('link failed')) });
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError,
    });
    await expect(compiled).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('compile', expect.any(Error));
    expect(rig.renders).toHaveLength(1);
  });

  it('a synchronous throw from compileAsync is reported, the bound target is restored, the draw still happens', async () => {
    const { scene, probe, camera } = makeScene();
    const onError = vi.fn();
    const before = new THREE.WebGLRenderTarget(8, 8);
    const rig = makeRenderer({ probes: [probe], initialTarget: before, compile: () => { throw new Error('no context'); } });
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError,
    });
    await compiled;
    expect(onError).toHaveBeenCalledWith('compile', expect.any(Error));
    expect(rig.renders).toHaveLength(1);
    expect(rig.state().current).toBe(before);
  });

  it('a throwing warm draw is reported and every piece of state is still restored', async () => {
    const { scene, mesh, probe, camera } = makeScene();
    const onError = vi.fn();
    const target = new THREE.WebGLRenderTarget(1, 1);
    const dispose = vi.spyOn(target, 'dispose');
    const rig = makeRenderer({ probes: [probe], meshes: [mesh], render: () => { throw new Error('driver rejected the probe render'); } });
    await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError,
      createTarget: () => target,
    });
    expect(onError).toHaveBeenCalledWith('warm-draw', expect.any(Error));
    const after = rig.state();
    expect(after.current).toBeNull();
    expect(after.viewport).toEqual([0, 0, 640, 480]);
    expect(after.scissorTest).toBe(false);
    expect(probe.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('`compiled` settles only once compileAsync itself settles', async () => {
    const { scene, probe, camera } = makeScene();
    let resolveCompile!: () => void;
    const rig = makeRenderer({ probes: [probe], compile: () => new Promise<void>((r) => { resolveCompile = r; }) });
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      timeoutMs: 10,
    });
    let settled = false;
    void compiled.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    resolveCompile();
    await compiled;
    expect(settled).toBe(true);
  });

  it('a failing target RESTORE is reported as its own stage and the draw still happens', async () => {
    const { scene, probe, camera } = makeScene();
    const onError = vi.fn();
    const before = new THREE.WebGLRenderTarget(8, 8);
    const rig = makeRenderer({ probes: [probe], initialTarget: before, failRestoreTo: before });
    await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError,
      createTarget: () => new THREE.WebGLRenderTarget(1, 1),
    });
    expect(onError).toHaveBeenCalledWith('restore', expect.any(Error));
    expect(rig.renders).toHaveLength(1);
  });

  it('a throwing target factory is fail-open: reported, target restored, draw still happens', async () => {
    const { scene, probe, camera } = makeScene();
    const onError = vi.fn();
    const before = new THREE.WebGLRenderTarget(8, 8);
    const rig = makeRenderer({ probes: [probe], initialTarget: before });
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError,
      createTarget: () => { throw new Error('out of memory'); },
    });
    await compiled;
    expect(onError).toHaveBeenCalledWith('compile', expect.any(Error));
    expect(rig.renders).toHaveLength(1);
    expect(rig.state().current).toBe(before);
  });

  it('a throwing error reporter cannot break the warm-up or reject `compiled`', async () => {
    const { scene, probe, camera } = makeScene();
    const rig = makeRenderer({ probes: [probe], compile: () => Promise.reject(new Error('link failed')), render: () => { throw new Error('draw failed'); } });
    const { compiled } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: true,
      probeGroups: [probe],
      onError: () => { throw new Error('reporter exploded'); },
    });
    await expect(compiled).resolves.toBeUndefined();
    expect(rig.state().current).toBeNull();
    expect(probe.visible).toBe(false);
  });
});

describe('resolveProgramLinks', () => {
  it('forces one program per frame: a status read and three’s own first-use path, once each', async () => {
    const programs = [makeProgram('a'), makeProgram('b'), makeProgram('c')];
    const { resolver, parameterCalls } = makeResolver(programs);
    const frames: number[] = [];
    const timings = await resolveProgramLinks(resolver, {
      nextFrame: async () => { frames.push(frames.length); },
    });
    // One frame per program, and the first program waits for one too: the task
    // that awaited the compile must not be the one that pays a build.
    expect(frames).toHaveLength(3);
    expect(parameterCalls).toHaveLength(3);
    expect(parameterCalls.map((c) => (c as { pname: number }).pname)).toEqual([0x8b82, 0x8b82, 0x8b82]);
    expect(programs.map((p) => p.calls)).toEqual([['getUniforms'], ['getUniforms'], ['getUniforms']]);
    expect(timings.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(timings.every((t) => Number.isFinite(t.ms) && t.ms >= 0)).toBe(true);
  });

  it('resolves several per frame when asked, and all of them on no frame at all when unbounded', async () => {
    const four = [makeProgram('a'), makeProgram('b'), makeProgram('c'), makeProgram('d')];
    let frames = 0;
    await resolveProgramLinks(makeResolver(four).resolver, {
      perFrame: 2,
      nextFrame: async () => { frames++; },
    });
    expect(frames).toBe(2);

    const boot = [makeProgram('e'), makeProgram('f'), makeProgram('g')];
    let bootFrames = 0;
    const timings = await resolveProgramLinks(makeResolver(boot).resolver, {
      perFrame: Number.POSITIVE_INFINITY,
      nextFrame: async () => { bootFrames++; },
    });
    // Behind the load screen a yielded frame is boot time, so none is yielded.
    expect(bootFrames).toBe(0);
    expect(timings).toHaveLength(3);
  });

  it('skips programs already resolved this session, and costs no frame when there is nothing left', async () => {
    const programs = [makeProgram('a'), makeProgram('b')];
    const first = makeResolver(programs);
    await resolveProgramLinks(first.resolver, { nextFrame: async () => {} });
    expect(first.parameterCalls).toHaveLength(2);

    const again = makeResolver(programs);
    let frames = 0;
    const timings = await resolveProgramLinks(again.resolver, { nextFrame: async () => { frames++; } });
    expect(again.parameterCalls).toHaveLength(0);
    expect(frames).toBe(0);
    expect(timings).toEqual([]);
    expect(programs.map((p) => p.calls.length)).toEqual([1, 1]);

    // A program the list gained since is the only one the next pass touches.
    const grown = makeResolver([...programs, makeProgram('c')]);
    const grownTimings = await resolveProgramLinks(grown.resolver, { nextFrame: async () => {} });
    expect(grownTimings.map((t) => t.name)).toEqual(['c']);
  });

  it('names a row by the material type when the material itself was never named', async () => {
    const unnamed = makeProgram('', { type: 'MeshStandardMaterial' });
    const timings = await resolveProgramLinks(makeResolver([unnamed]).resolver, {
      nextFrame: async () => {},
    });
    expect(timings.map((t) => t.name)).toEqual(['MeshStandardMaterial']);
  });

  it('a program with no GL program behind it is not counted as resolved work', async () => {
    const alive = makeProgram('alive');
    const destroyed = { name: 'destroyed', program: undefined, getUniforms: () => ({}) };
    const { resolver, parameterCalls } = makeResolver([destroyed as never, alive]);
    const timings = await resolveProgramLinks(resolver, { nextFrame: async () => {} });
    expect(timings.map((t) => t.name)).toEqual(['alive']);
    expect(parameterCalls).toHaveLength(1);
  });

  it('is fail-open on a context it cannot read: reported, nothing forced, no frame spent', async () => {
    const onError = vi.fn();
    let frames = 0;
    const { resolver } = makeResolver([makeProgram('a')], { contextThrows: true });
    const timings = await resolveProgramLinks(resolver, {
      onError,
      nextFrame: async () => { frames++; },
    });
    expect(timings).toEqual([]);
    expect(frames).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('is fail-open per program: a thrower is reported, never retried, and the rest still resolve', async () => {
    const onError = vi.fn();
    const bad = makeProgram('bad', { getUniformsThrows: true });
    const good = makeProgram('good');
    const timings = await resolveProgramLinks(makeResolver([bad, good]).resolver, {
      onError,
      nextFrame: async () => {},
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(timings.map((t) => t.name)).toEqual(['bad', 'good']);

    // One attempt per program per session: a program that throws every time
    // would otherwise cost a frame on every warm-up for the rest of the run.
    const retry = makeResolver([bad, good]);
    expect(await resolveProgramLinks(retry.resolver, { nextFrame: async () => {} })).toEqual([]);
    expect(retry.parameterCalls).toHaveLength(0);
  });

  it('a throwing reporter cannot stop the phase', async () => {
    const { resolver, parameterCalls } = makeResolver(
      [makeProgram('a'), makeProgram('b')],
      { parameterThrows: true },
    );
    const timings = await resolveProgramLinks(resolver, {
      onError: () => { throw new Error('reporter exploded'); },
      nextFrame: async () => {},
    });
    expect(parameterCalls).toHaveLength(2);
    expect(timings).toHaveLength(2);
  });
});

describe('warmUpSceneShaders resolve phase', () => {
  it('resolves between the compile and the warm draw, never inside it', async () => {
    const { scene, probe, camera } = makeScene();
    const programs = [makeProgram('warm-a'), makeProgram('warm-b')];
    const rig = makeRenderer({ probes: [probe], programs });
    let frames = 0;
    const { resolved, warmDrawMs } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: false,
      probeGroups: [probe],
      nextFrame: async () => { frames++; },
    });
    // compile, then every resolve, then the one draw.
    expect(rig.events.filter((e) => e === 'compile' || e === 'resolve' || e === 'render'))
      .toEqual(['compile', 'resolve', 'resolve', 'render']);
    expect(frames).toBe(2);
    expect(resolved.map((r) => r.name)).toEqual(['warm-a', 'warm-b']);
    expect(warmDrawMs).toBeGreaterThanOrEqual(0);
  });

  it('the boot path resolves every program without yielding a frame', async () => {
    const { scene, probe, camera } = makeScene();
    const programs = [makeProgram('boot-a'), makeProgram('boot-b'), makeProgram('boot-c')];
    const rig = makeRenderer({ probes: [probe], programs });
    let frames = 0;
    const { resolved } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: false,
      probeGroups: [probe],
      resolvePerFrame: Number.POSITIVE_INFINITY,
      nextFrame: async () => { frames++; },
    });
    expect(frames).toBe(0);
    expect(resolved).toHaveLength(3);
    expect(rig.renders).toHaveLength(1);
  });

  it('a resolve phase that cannot run reports its own stage and the draw still happens', async () => {
    const { scene, probe, camera } = makeScene();
    const onError = vi.fn();
    const rig = makeRenderer({ probes: [probe] });
    rig.renderer.getContext = () => { throw new Error('context is gone'); };
    const { resolved } = await warmUpSceneShaders(rig.renderer, scene, camera, {
      drawsThroughComposer: false,
      probeGroups: [probe],
      onError,
    });
    expect(onError).toHaveBeenCalledWith('resolve', expect.any(Error));
    expect(resolved).toEqual([]);
    expect(rig.renders).toHaveLength(1);
  });
});
