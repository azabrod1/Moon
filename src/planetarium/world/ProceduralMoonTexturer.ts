/**
 * GPU procedural moon-texture painter. Renders the same noise+crater surface the
 * CPU path (createMoonTextures) builds per-pixel, but as a fragment shader into a
 * WebGLRenderTarget — so painting a system costs GPU-command submission instead
 * of 100-360 ms of main-thread work. No readback per paint; the render target's
 * texture becomes the moon material's map/bumpMap directly.
 *
 * This is the implementation of planning/gpu-moon-paint-design.md (§14, the
 * review-hardened spec). The load-bearing invariant — a moon is never shown
 * before it is painted — lives in MoonPainter + the visibility gate, which are
 * unchanged; this class only swaps the per-moon paint from CPU to GPU and is
 * FAIL-CLOSED: any doubt (validation fails, context lost, render throws) falls
 * back to the synchronous CPU path, so "painted" always means a usable texture
 * is assigned, never merely "a render call returned".
 */
import * as THREE from 'three';
import type { MoonMesh } from '../PlanetFactory';
import { paintMoonTextures } from '../PlanetFactory';
import { debugWarn } from '../../shared/debug';
import {
  archetypeCode,
  classifyMoonArchetype,
  generateCraters,
  gpuSeed,
  hashString,
  MAX_CRATERS,
  moonTextureSize,
  seededRng,
} from './proceduralMoon';

const VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Faithful (visually, not bit-exact — §7) port of createMoonTextures' per-pixel
// loop. highp is required (default for ShaderMaterial) or the sin-hash bands.
const FRAG = /* glsl */ `
uniform int   uPass;        // 0 = colour, 1 = bump
uniform int   uValidate;    // 1 = flat uBaseColor (prewarm colourspace probe)
uniform vec2  uTexSize;
uniform vec3  uBaseColor;   // THREE.Color components (same values the CPU used)
uniform float uSeed;        // reduced seed (gpuSeed) — f32-safe
uniform int   uArchetype;   // 0 icy, 1 volcanic, 2 rocky
uniform int   uCraterCount;
uniform vec3  uCraters[${MAX_CRATERS}]; // (cx, cy, radius) in texels, top-origin

float valueNoise(float x, float y, float seed) {
  float a = sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return a - floor(a);
}
float fractalNoise(float x, float y, float seed, int octaves) {
  float value = 0.0, amplitude = 1.0, frequency = 1.0, maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    value += valueNoise(x * frequency, y * frequency, seed + float(i) * 100.0) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2.2;
  }
  return value / maxAmp;
}

// three r0.183 sRGB-encodes on write to an sRGB-colourSpace render target. The
// old CanvasTexture stored RAW bytes (a linear THREE.Color value) and the
// sampler sRGB-decoded them. To reproduce that exactly, output sRGB->linear of
// our value: three's encode-on-write then cancels it, storing the same raw bytes
// the canvas did, and the sampler's sRGB-decode yields the identical final
// colour. (The prewarm probe validates this round-trip; if a three version stops
// encoding, the probe fails and we fall back to CPU.)
vec3 sRGBToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(0.04045, c));
}

void main() {
  if (uValidate == 1) { gl_FragColor = vec4(sRGBToLinear(uBaseColor), 1.0); return; }

  // Top-origin integer texel coords: matches the CPU loop's x, y (x/width,
  // y/height) AND compensates for the RT having flipY=false where the old
  // CanvasTexture had flipY=true, so the rendered image matches the canvas.
  vec2 texel = vec2(gl_FragCoord.x - 0.5, uTexSize.y - (gl_FragCoord.y - 0.5));
  float nx = texel.x / uTexSize.x;
  float ny = texel.y / uTexSize.y;

  float terrain = fractalNoise(nx * 6.0,  ny * 6.0,  uSeed,          3);
  float detail  = fractalNoise(nx * 18.0, ny * 18.0, uSeed + 500.0,  2);
  float grain   = valueNoise (nx * 50.0,  ny * 50.0, uSeed + 1000.0);

  float variation;
  if (uArchetype == 0)      variation = terrain * 0.15 + detail * 0.08 + grain * 0.03; // icy
  else if (uArchetype == 1) variation = terrain * 0.30 + detail * 0.12 + grain * 0.04; // volcanic
  else                      variation = terrain * 0.22 + detail * 0.10 + grain * 0.04; // rocky

  vec3  color  = uBaseColor + (variation - 0.15); // == (baseR + shift) / 255 on the CPU
  float height = terrain * 0.7 + detail * 0.3;     // bump, 0..1

  for (int i = 0; i < ${MAX_CRATERS}; i++) {
    if (i >= uCraterCount) break;
    vec3 c = uCraters[i];
    float dx = texel.x - c.x;
    dx -= uTexSize.x * floor(dx / uTexSize.x + 0.5); // wrap in x to nearest (as CPU)
    float dy = texel.y - c.y;
    float dist = sqrt(dx * dx + dy * dy);
    if (dist > c.z) continue;
    float t = dist / c.z;
    if (t < 0.75) { float d = (1.0 - t / 0.75) * (30.0 / 255.0);        color -= d; height -= d * 2.0; }
    else          { float b = (1.0 - (t - 0.75) / 0.25) * (20.0 / 255.0); color += b; height += b * 2.0; }
  }

  // Colour: pre-decode so three's sRGB encode-on-write restores the canvas bytes
  // (see sRGBToLinear above). Bump is a linear (NoColorSpace) RT — raw write, no
  // cancellation needed, matching the CPU 'data' map.
  if (uPass == 0) gl_FragColor = vec4(sRGBToLinear(clamp(color, 0.0, 1.0)), 1.0);
  else            gl_FragColor = vec4(vec3(clamp(height, 0.0, 1.0)), 1.0);
}
`;

export class ProceduralMoonTexturer {
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadGeo = new THREE.PlaneGeometry(2, 2);
  private readonly material: THREE.ShaderMaterial;
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext;
  private readonly anisotropy: number;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpViewport = new THREE.Vector4();

  // RTs whose textures are live on moon materials — tracked for teardown only;
  // ownership otherwise transfers to the material (disposed via the owner tag in
  // applyColorTierTexture when a photo replaces the procedural floor).
  private readonly tracked = new Set<THREE.WebGLRenderTarget>();
  // Moons painted via GPU RTs — RT textures have no CPU backing, so on a context
  // loss the caller must reset these to repaint (they'd otherwise stay black).
  private readonly rtPaintedMoons = new Set<MoonMesh>();

  private warmed = false;
  /** Fail-closed master switch: false → every paint uses the CPU path. */
  private gpuUsable = false;
  // DEV-only counters (stripped from prod) so a headless probe can confirm the
  // GPU path actually engages and separate procedural cost from photo upload.
  private gpuPaints = 0;
  private cpuPaints = 0;
  private gpuMs = 0; // total main-thread ms in GPU paints (command submission)
  private cpuMs = 0; // total main-thread ms in CPU paints (the pixel loop)

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext();
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const uCraters: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_CRATERS; i++) uCraters.push(new THREE.Vector3());
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      precision: 'highp',
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uPass: { value: 0 },
        uValidate: { value: 0 },
        uTexSize: { value: new THREE.Vector2(512, 256) },
        uBaseColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        uSeed: { value: 0 },
        uArchetype: { value: 2 },
        uCraterCount: { value: 0 },
        uCraters: { value: uCraters },
      },
    });
    const quad = new THREE.Mesh(this.quadGeo, this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /**
   * Compile the shader and validate the GPU path ONCE, off the hot path (called
   * at mode activation, before any visibility gate can run). The validation is a
   * flat-colour probe: render a known linear 0.5 into an sRGB colour RT and read
   * the stored byte. Raw-write sRGB storage (matching the old CanvasTexture)
   * stores ~128; sRGB-encode-on-write would store ~188 and gamma-shift, so we
   * reject that and fall back to CPU. A black/garbage read (failed render) also
   * fails the check → CPU. One-time readback; never per paint.
   */
  prewarm(): void {
    if (this.warmed) return;
    this.warmed = true;
    let rt: THREE.WebGLRenderTarget | null = null;
    try {
      if (this.gl.isContextLost()) { this.gpuUsable = false; return; }
      rt = this.makeRT(4, 4, 'color');
      this.material.uniforms.uValidate.value = 1;
      this.material.uniforms.uBaseColor.value.set(0.5, 0.5, 0.5);
      this.renderToRT(rt);
      const buf = new Uint8Array(4);
      this.renderer.readRenderTargetPixels(rt, 2, 2, 1, 1, buf);
      this.material.uniforms.uValidate.value = 0;
      // ~128 = raw write into sRGB storage (parity with the CanvasTexture path).
      const ok = !this.gl.isContextLost() && Math.abs(buf[0] - 128) <= 10;
      this.gpuUsable = ok;
      if (!ok) debugWarn('GPU moon texturer disabled (validation failed); using CPU', { sample: buf[0] });
    } catch (err) {
      this.gpuUsable = false;
      debugWarn('GPU moon texturer prewarm failed; using CPU', { err: String(err) });
    } finally {
      rt?.dispose();
      this.publishStats();
    }
  }

  /**
   * Paint one moon (the function injected into MoonPainter). Transactional and
   * fail-closed: render both targets first, confirm the context is alive, THEN
   * assign and set painted — so the visibility gate can never see a half-painted
   * or context-lost (black) moon. Any failure → synchronous CPU fallback, which
   * itself sets painted; if that throws too it propagates, leaving the system
   * pending for a retry (never silently dropped, never painted-but-blank).
   */
  paint = (moon: MoonMesh): void => {
    if (moon.painted) return;
    if (!this.warmed) this.prewarm();
    const mat = moon.mesh.material as THREE.MeshStandardMaterial;

    // DEV-only A/B switch: force the CPU path to compare it against the GPU one
    // (set window.__forceCpuMoonPaint = true before the first paint).
    const forceCpu = import.meta.env.DEV && (globalThis as Record<string, unknown>).__forceCpuMoonPaint === true;
    if (!this.gpuUsable || this.gl.isContextLost() || forceCpu) {
      const t = performance.now();
      paintMoonTextures(moon);
      this.cpuMs += performance.now() - t;
      this.cpuPaints++;
      this.publishStats();
      return;
    }

    const { width, height } = moonTextureSize(moon.data.radiusKm);
    try {
      const start = performance.now();
      this.renderAndAssign(moon, mat, width, height);
      this.gpuPaints++;
      this.gpuMs += performance.now() - start;
      this.publishStats();
    } catch (err) {
      debugWarn('GPU moon paint failed; CPU fallback', { name: moon.data.name, err: String(err) });
      const tFallback = performance.now();
      paintMoonTextures(moon); // sets painted; if it throws, propagate (stays pending)
      this.cpuMs += performance.now() - tFallback;
      this.cpuPaints++;
      this.publishStats();
    }
  };

  /**
   * Raise an already-observed moon's procedural texture to `width`. The landed/
   * Observatory view magnifies every body to a fixed screen fraction regardless
   * of physical size, so a tiny moon's small baseline texture looks low-res up
   * close; this re-renders it sharper. Cheap on the GPU, so it runs on observe
   * and the result stays (no revert). Fail-closed: any problem leaves the
   * current texture exactly as it was.
   *
   * Race-safe: JS is single-threaded, so this never interleaves with the gate's
   * paint(); renderAndAssign is transactional and assign-new-before-dispose-old,
   * so no in-flight frame samples a freed texture and a failed render keeps the
   * old one. Only touches GPU-painted moons (proceduralWidth set) — never a
   * CPU-fallback CanvasTexture or a photo.
   *
   * Returns whether the texture was actually upgraded, so a per-frame throttle
   * can spend its one slot on a real upgrade: an ineligible moon (CPU-painted,
   * already sharp, or a fully photo-backed one) returns false without consuming
   * the slot.
   */
  upgrade(moon: MoonMesh, width: number): boolean {
    if (!this.gpuUsable || this.gl.isContextLost()) return false; // keep the baseline
    const mat = moon.mesh.material as THREE.MeshStandardMaterial;
    const current = mat.userData.proceduralWidth as number | undefined;
    if (current === undefined || current >= width) return false; // CPU-painted, or already sharp enough
    if (mat.userData.photoLoaded && mat.userData.hasRealNormal) return false; // nothing procedural to sharpen
    try {
      const start = performance.now();
      this.renderAndAssign(moon, mat, width, width / 2);
      this.gpuMs += performance.now() - start;
      this.publishStats();
      return true;
    } catch (err) {
      debugWarn('GPU moon texture upgrade failed; keeping current', { name: moon.data.name, err: String(err) });
      return false;
    }
  }

  /**
   * Render the procedural colour (unless a photo owns it) and bump (unless a real
   * normal owns it) at width×height into fresh render targets and swap them onto
   * the material. Transactional: if a render fails or the context drops it throws
   * BEFORE touching the material (disposing any partial RT), so the caller's
   * existing texture is never left broken. New RTs are assigned before the
   * outgoing procedural RTs are disposed, so no in-flight frame samples a freed
   * texture. Sets moon.painted only after a clean assignment.
   */
  private renderAndAssign(moon: MoonMesh, mat: THREE.MeshStandardMaterial, width: number, height: number): void {
    const needColor = !mat.userData.photoLoaded;
    const needBump = !mat.userData.hasRealNormal;
    let colorRT: THREE.WebGLRenderTarget | null = null;
    let bumpRT: THREE.WebGLRenderTarget | null = null;
    try {
      if (needColor || needBump) {
        this.setUniformsFor(moon, width, height);
        if (needColor) {
          this.material.uniforms.uPass.value = 0;
          colorRT = this.makeRT(width, height, 'color');
          this.renderToRT(colorRT);
        }
        if (needBump) {
          this.material.uniforms.uPass.value = 1;
          bumpRT = this.makeRT(width, height, 'data');
          this.renderToRT(bumpRT);
        }
      }
      // A lost context doesn't throw — render() silently no-ops, leaving a black
      // RT. Check before trusting the result.
      if (this.gl.isContextLost()) throw new Error('context lost during paint');
    } catch (err) {
      colorRT?.dispose();
      bumpRT?.dispose();
      throw err; // nothing on the material changed yet
    }

    // Capture the outgoing procedural RTs to free AFTER the new ones are live.
    const oldColor = mat.userData.proceduralColorRT as THREE.WebGLRenderTarget | undefined;
    const oldBump = mat.userData.proceduralBumpRT as THREE.WebGLRenderTarget | undefined;
    if (colorRT) {
      colorRT.texture.userData.ownerRenderTarget = colorRT; // owner-aware dispose on photo replace
      mat.map = colorRT.texture;
      mat.color.setRGB(1, 1, 1);
      mat.userData.colorTierRank = 0; // procedural floor, as the CPU path sets
      mat.userData.proceduralColorRT = colorRT;
      this.tracked.add(colorRT);
    }
    if (bumpRT) {
      mat.bumpMap = bumpRT.texture;
      mat.bumpScale = Math.max(moon.data.radiusAU * 0.15, 0.0000005);
      mat.userData.proceduralBumpRT = bumpRT;
      this.tracked.add(bumpRT);
    }
    mat.needsUpdate = true;
    // Dispose the replaced RTs only now that the new ones are assigned.
    if (colorRT && oldColor) { this.tracked.delete(oldColor); oldColor.dispose(); }
    if (bumpRT && oldBump) { this.tracked.delete(oldBump); oldBump.dispose(); }
    if (colorRT || bumpRT) {
      mat.userData.proceduralWidth = width;
      this.rtPaintedMoons.add(moon);
    }
    moon.painted = true;
  }

  private publishStats(): void {
    if (import.meta.env.DEV) {
      (globalThis as Record<string, unknown>).__gpuMoonStats = {
        gpuUsable: this.gpuUsable,
        gpuPaints: this.gpuPaints,
        cpuPaints: this.cpuPaints,
        gpuMs: +this.gpuMs.toFixed(1),
        cpuMs: +this.cpuMs.toFixed(1),
      };
    }
  }

  /** WebGL context lost — RT textures are now invalid. Stop using the GPU path
   *  until re-validated; return the moons whose RT textures must be repainted so
   *  the caller can reset their painted flag and re-enqueue (else they'd render
   *  black). */
  onContextLost(): MoonMesh[] {
    this.gpuUsable = false;
    this.warmed = false; // force re-validation on restore
    const moons = [...this.rtPaintedMoons];
    this.rtPaintedMoons.clear();
    this.tracked.clear(); // GL objects are gone; nothing to dispose
    return moons;
  }

  /** WebGL context restored — re-run the one-time validation so the GPU path can
   *  resume (or stay on CPU if it no longer validates). */
  onContextRestored(): void {
    this.prewarm();
  }

  dispose(): void {
    // Iterate a copy: each rt.dispose() fires the 'dispose' listener (makeRT)
    // that removes it from this.tracked, which would mutate the set mid-iteration.
    for (const rt of [...this.tracked]) rt.dispose();
    this.tracked.clear();
    this.rtPaintedMoons.clear();
    this.material.dispose();
    this.quadGeo.dispose();
  }

  private setUniformsFor(moon: MoonMesh, width: number, height: number): void {
    const u = this.material.uniforms;
    this.tmpColor.set(moon.data.color);
    u.uBaseColor.value.set(this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    const flags = classifyMoonArchetype(moon.data.color);
    u.uArchetype.value = archetypeCode(flags);
    u.uSeed.value = gpuSeed(moon.data.name);
    u.uTexSize.value.set(width, height);
    // Crater placement uses the FULL hashString seed (same as the CPU path) so
    // craters are identical between paths; only the noise field (uSeed) differs.
    const craters = generateCraters(seededRng(hashString(moon.data.name)), width, height, flags.isIcy);
    const count = Math.min(craters.length, MAX_CRATERS);
    u.uCraterCount.value = count;
    for (let i = 0; i < MAX_CRATERS; i++) {
      const v = u.uCraters.value[i] as THREE.Vector3;
      if (i < count) v.set(craters[i].cx, craters[i].cy, craters[i].cr);
      else v.set(0, 0, 0);
    }
    u.uValidate.value = 0;
  }

  private makeRT(width: number, height: number, kind: 'color' | 'data'): THREE.WebGLRenderTarget {
    // All sampler/storage params at allocation — three sets them in
    // setupRenderTarget; mutating after the first render is too late.
    const rt = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType, // colourspace parity depends on byte storage (§14.1)
      colorSpace: kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      wrapS: THREE.ClampToEdgeWrapping, // parity: the CanvasTextures were clamp
      wrapT: THREE.ClampToEdgeWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, // trilinear, like the CanvasTextures
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      anisotropy: this.anisotropy,
    });
    // Whoever disposes this RT (upgrade swap, photo-replace owner dispose, or
    // teardown) auto-removes it from tracking — no stale entries to leak.
    rt.addEventListener('dispose', () => { this.tracked.delete(rt); });
    return rt;
  }

  private renderToRT(rt: THREE.WebGLRenderTarget): void {
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.getViewport(this.tmpViewport);
    try {
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.quadScene, this.quadCam);
    } finally {
      // Restore in finally so a throw mid-render can't leave the renderer bound
      // to the moon RT for the next renderScene().
      this.renderer.setRenderTarget(prevRT);
      this.renderer.setViewport(this.tmpViewport);
    }
  }
}
