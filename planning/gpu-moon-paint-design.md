# GPU procedural moon-texture painting — design

**Branch:** `obs-surface-swap-fix` (off `planet-beauty-overhaul`)
**Status:** design, pre-implementation — for review by 2 subagents + 2 codex passes
**Author:** Claude (Opus 4.8)

---

## 1. Problem

Landing on / flying near a moon for the first time freezes the main thread while its
procedural surface texture is generated on the CPU. Measured (`tools/io-isolate.mjs`,
GPU/ANGLE-Metal): **Io 108 ms, Europa 359 ms** on first visit, cached after. This is the
synchronous per-pixel canvas loop in `createMoonTextures` (`PlanetFactory.ts:698-823`),
reached through two call sites:

- the **visibility gate** — `paintSystemNow` at `PlanetariumMode.ts:1401`, run every frame
  before render so a system is never shown unpainted; and
- the **arrival veil** — `paintSystemNow` at `PlanetariumMode.ts:4574`, behind an opaque
  cover during teleports.

Per-pixel cost: for each of `512×256 = 131 072` texels we evaluate `fractalNoise` (3 octaves)
+ `fractalNoise` (2 octaves) + `valueNoise`, each octave a `sin`-hash, twice (colour + bump),
then a crater stamp loop. That is the freeze.

## 2. Goal & hard constraint

**Goal:** move the per-pixel generation to the GPU (fragment shader → render target, *no
readback*) so painting a system costs GPU-command submission (sub-millisecond on the CPU
timeline) instead of 100–360 ms of main-thread work. Fixes fly-in, teleport, and fly-by
uniformly.

**Hard constraint (project-critical — `no-incomplete-results-guarantee`):** a player must
**never** see an unrendered / partially-rendered moon **or planet** — no grey/placeholder
body ever reaches the screen, and no jump/teleport lands in a scene before it is loaded.
This design must *preserve* that guarantee, not relax it. The GPU work only removes the
freeze; it must not introduce any path where an unpainted body becomes visible.

Non-goals: changing how planets are textured (planets load real maps; only *moons* use the
procedural generator), changing the look beyond unavoidable f32-vs-f64 noise differences,
or removing the gate/veil.

## 3. Design overview

A new `ProceduralMoonTexturer` (in `src/planetarium/world/`) owns:

- a reusable offscreen **quad scene** (one `THREE.PlaneGeometry(2,2)` mesh + an
  `OrthographicCamera`), and
- a single `THREE.ShaderMaterial` (`uProcMoonMaterial`) implementing the noise + crater
  generation, with a `uPass` toggle (0 = colour, 1 = bump) and per-moon uniforms.

To paint a moon it renders that quad into a per-moon `WebGLRenderTarget` (one for colour,
one for bump) using the app's existing `THREE.WebGLRenderer`, then assigns
`renderTarget.texture` as `material.map` / `material.bumpMap`. No `readPixels`, no canvas.

**Crucially, the guarantee-enforcing code does not change.** `MoonPainter` already takes its
paint function by injection (`MoonPainter.ts:18`, constructed at
`PlanetariumMode.ts:219` as `new MoonPainter(paintMoonTextures)`). We swap the injected
function to the GPU path:

```ts
// PlanetariumMode.ts (construction)
this.moonTexturer = new ProceduralMoonTexturer(renderer);   // renderer available in ctor
this.moonPainter  = new MoonPainter((moon) => this.moonTexturer.paint(moon));
```

The queue, the gate (`:1399-1412`), the per-moon `m.mesh.visible = visible && m.painted`
check, the veil (`arriveThen`), and `paintSystemNow` are **untouched**. Only the body of
"paint one moon" moves from CPU to GPU. `moon.painted` still flips to `true` only after the
texture is assigned, so the existing invariant ("never visible while unpainted") holds by
construction.

## 4. Why the same-frame timing is safe

`animate()` (`main.ts:340-346`) runs `planetariumMode.update(dt)` **then** `renderScene()`.
The gate's `paintSystemNow` runs inside `update()`. So for any moon painted this frame:

1. During `update()`: `renderer.setRenderTarget(rt); renderer.render(quadScene, quadCam);
   renderer.setRenderTarget(prev)` — GL draw commands for the RT are submitted.
2. `m.painted = true`, `m.mesh.visible = true` set the same tick.
3. After `update()` returns: `renderScene()` runs `composer.render()` /
   `renderer.render(scene, camera)`, which samples `mat.map` (= the RT texture).

GL executes commands in submission order on one context: a texture written by an earlier
`render(rt)` is correctly sampled by a later `render(canvas)` in the same JS frame (the
standard reflection-probe / ping-pong pattern). **No flush/finish needed**, and there is no
frame in which the moon is visible-but-unwritten. The first frame the moon appears, it is
fully textured.

## 5. The shader (GLSL)

Faithful port of `createMoonTextures`. Noise math identical in form; only precision (f32 vs
JS f64) and the seed range differ (§7). Crater *placement* stays on the CPU (seeded RNG,
identical sequence) and is passed as a uniform array, so the only thing that moved to the
GPU is the expensive per-pixel loop.

```glsl
precision highp float;            // highp required — mediump bands the sin-hash

varying vec2 vUv;                 // 0..1 across the texture
uniform int   uPass;             // 0 = colour, 1 = bump
uniform vec2  uTexSize;          // (width, height) in texels — crater math is in texel space
uniform vec3  uBaseColor;        // THREE.Color components (same values the CPU used)
uniform float uSeed;             // small (< 1024) — see §7
uniform int   uArchetype;        // 0 icy, 1 volcanic, 2 rocky
uniform int   uCraterCount;
uniform vec3  uCraters[25];      // (cx, cy, radius) in texels; MAX_CRATERS = 25

float valueNoise(float x, float y, float seed){
  float a = sin(x*12.9898 + y*78.233 + seed) * 43758.5453;
  return a - floor(a);                                   // == JS fract
}
float fractalNoise(float x, float y, float seed, int octaves){
  float value=0.0, amplitude=1.0, frequency=1.0, maxAmp=0.0;
  for (int i=0;i<8;i++){                                  // const bound; break at octaves
    if (i>=octaves) break;
    value  += valueNoise(x*frequency, y*frequency, seed + float(i)*100.0) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2.2;
  }
  return value / maxAmp;
}

void main(){
  float nx = vUv.x, ny = vUv.y;
  float terrain = fractalNoise(nx*6.0,  ny*6.0,  uSeed,         3);
  float detail  = fractalNoise(nx*18.0, ny*18.0, uSeed+500.0,   2);
  float grain   = valueNoise (nx*50.0,  ny*50.0, uSeed+1000.0);

  float variation;
  if (uArchetype==0)      variation = terrain*0.15 + detail*0.08 + grain*0.03; // icy
  else if (uArchetype==1) variation = terrain*0.30 + detail*0.12 + grain*0.04; // volcanic
  else                    variation = terrain*0.22 + detail*0.10 + grain*0.04; // rocky

  // base colour + brightness shift; (variation-0.15) == CPU shift/255
  vec3  color   = uBaseColor + (variation - 0.15);
  float height  = terrain*0.7 + detail*0.3;              // bump, 0..1

  // craters — texel-space distance, x wraps, identical darken/brighten as CPU
  vec2 px = vec2(nx*uTexSize.x, ny*uTexSize.y);
  for (int i=0;i<25;i++){
    if (i>=uCraterCount) break;
    vec3 c = uCraters[i];
    float dx = px.x - c.x;  dx -= uTexSize.x * floor(dx/uTexSize.x + 0.5);  // wrap to nearest
    float dy = px.y - c.y;
    float dist = sqrt(dx*dx + dy*dy);
    if (dist > c.z) continue;
    float t = dist / c.z;
    if (t < 0.75){ float d = (1.0 - t/0.75) * (30.0/255.0);
                   color -= d;  height -= d*2.0; }
    else         { float b = (1.0 - (t-0.75)/0.25) * (20.0/255.0);
                   color += b;  height += b*2.0; }
  }

  if (uPass==0) gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  else          gl_FragColor = vec4(vec3(clamp(height, 0.0, 1.0)), 1.0);
}
```

Notes:
- **Two draws per moon** (colour pass, bump pass) for clarity. Could be one MRT pass later;
  two tiny quad draws are sub-ms regardless.
- The colour write equals the CPU's: CPU stored `baseColor.r*255 + (variation-0.15)*255`
  into a byte buffer; sampled that is `baseColor.r + (variation-0.15)`. Shader outputs
  exactly that. `clamp(...,0,1)` mirrors `Uint8ClampedArray` clamping.
- Crater `darken/brighten` divided by 255 to land in 0..1; bump uses `*2` exactly as CPU.

## 6. Colour-space equivalence (the #1 correctness risk)

CPU path: writes raw values into a canvas, then `applyTextureDefaults(tex,'color')` sets
`tex.colorSpace = SRGBColorSpace`; the moon's `MeshStandardMaterial` decodes sRGB→linear when
sampling `map`. We must reproduce that *exactly*.

Plan:
- Use a **`ShaderMaterial`** for the quad (not `MeshBasicMaterial`). `ShaderMaterial` does not
  inject three's `colorspace_fragment` / tonemapping chunks, so `gl_FragColor` is written to
  the render target **raw** — the same raw values the CPU put in the canvas.
- After rendering, set `colorRT.texture.colorSpace = SRGBColorSpace` (via
  `applyTextureDefaults(colorRT.texture,'color')`) and `bumpRT.texture` to `NoColorSpace`
  (`'data'`). Downstream sampling then decodes identically to the canvas path.
- Create the RT with default (`NoColorSpace`) so three performs **no encode on write**; the
  colorSpace tag is set afterward purely to instruct the *sampler*.

This is the one place a gamma shift could sneak in. **Verification is empirical**: before/after
screenshots per archetype (§10). If a shift appears, the single knob is whether/where
`colorSpace` is set and whether `ShaderMaterial` is emitting an encode chunk on this three
version (r0.183).

## 7. f32 precision / seed range

`valueNoise` is `fract(sin(x*12.9898 + y*78.233 + seed)*43758.5453)`. In f32 (GPU) vs f64
(JS) the hash differs — fine, it's decorative. But the CPU seed is `hashString(name)` which
can be ~1e9; at that magnitude an f32 ulp is ~64, so the `x,y` contribution (range ~1e3)
would **quantise/band**. Mitigation: pass a **reduced** seed to the shader,
`uSeed = hashString(name) mod 997` (a small prime keeps moons distinct) as a float. The
shader's `+500/+1000/+i*100` offsets then stay < ~2500, where f32 ulp is ~2e-4 — smooth.
Each moon still gets a deterministic, distinct texture. The CPU crater RNG keeps the full
seed (it runs in f64). Visual parity is by-eye, not bit-exact (acceptable — noise).

## 8. The paint function (TS sketch)

```ts
// world/ProceduralMoonTexturer.ts
export class ProceduralMoonTexturer {
  private quadScene = new THREE.Scene();
  private quadCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;  // the shader in §5
  private rts: THREE.WebGLRenderTarget[] = [];   // tracked for dispose()
  private warmed = false;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({ /* §5, uniforms initialised */ });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** Compile the quad shader once so the first real paint has no compile stall. */
  private prewarm() {
    if (this.warmed) return;
    const tiny = new THREE.WebGLRenderTarget(1, 1);
    this.renderToRT(tiny);   // forces program link now, off the hot path
    tiny.dispose();
    this.warmed = true;
  }

  /** Replaces createMoonTextures' work for one moon. Mirrors paintMoonTextures' guards. */
  paint(moon: MoonMesh): void {
    if (moon.painted) return;                       // idempotent (gate + veil both call)
    const mat = moon.mesh.material as THREE.MeshStandardMaterial;
    try {
      this.prewarm();
      const w = moon.data.radiusKm < SMALL_MOON_RADIUS_KM ? 256 : 512;
      const h = w / 2;
      this.setUniformsFor(moon, w, h);              // base colour, archetype, seed, craters

      if (!mat.userData.photoLoaded) {
        const colorRT = this.makeRT(w, h);
        this.material.uniforms.uPass.value = 0;
        this.renderToRT(colorRT);
        applyTextureDefaults(colorRT.texture, 'color');
        colorRT.texture.userData.ownerRenderTarget = colorRT;   // §9 leak-safe replace
        mat.map = colorRT.texture;
        mat.color.setRGB(1, 1, 1);
        mat.userData.colorTierRank = 0;             // procedural floor, as today
      }
      if (!mat.userData.hasRealNormal) {
        const bumpRT = this.makeRT(w, h);
        this.material.uniforms.uPass.value = 1;
        this.renderToRT(bumpRT);
        applyTextureDefaults(bumpRT.texture, 'data');
        mat.bumpMap = bumpRT.texture;
        mat.bumpScale = Math.max(moon.data.radiusAU * 0.15, 0.0000005);
      }
      mat.needsUpdate = true;
      moon.painted = true;
    } catch (err) {
      debugWarn('GPU moon paint failed; CPU fallback', { name: moon.data.name, err });
      paintMoonTextures(moon);                      // CPU path — guarantee never depends on GPU
    }
  }

  private renderToRT(rt: THREE.WebGLRenderTarget) {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.quadScene, this.quadCam);
    this.renderer.setRenderTarget(prev);            // restore — composer/main render unaffected
  }

  private makeRT(w: number, h: number) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false, stencilBuffer: false,
      // wrapS = RepeatWrapping (equirect longitude wraps), wrapT = ClampToEdge — match
      // applyTextureDefaults' filtering; set min/mag + generateMipmaps as the CPU texs had.
    });
    this.rts.push(rt);
    return rt;
  }

  dispose() { for (const rt of this.rts) rt.dispose(); this.rts.length = 0; }
}
```

`paintMoonTextures` (the CPU function) stays in `PlanetFactory.ts` as the fallback. Its
`photoLoaded` / `hasRealNormal` guards are mirrored above so the GPU path only fills the same
slots the CPU path would, and never clobbers a real photo or LOLA normal.

## 9. Photo-replace race (leak-safe)

Photo-bearing moons (Io, Europa, Ganymede, Triton, Charon, our Moon) hit the procedural
*floor* during the gate when their JPG hasn't arrived yet — that is exactly the measured
freeze. When the JPG later loads, `applyColorTierTexture` (rank 2 > floor 0,
`PlanetFactory.ts:203`) swaps `mat.map` and calls `prev.dispose()` on the old texture. If the
old texture is an RT texture, disposing the texture alone leaks the RT's framebuffer object.

Fix: tag `colorRT.texture.userData.ownerRenderTarget = colorRT`, and make
`applyColorTierTexture` dispose the owner RT when present:

```ts
const owner = (prev as THREE.Texture).userData?.ownerRenderTarget as THREE.WebGLRenderTarget|undefined;
if (owner) owner.dispose(); else prev?.dispose();
```

Same one-line guard for the `bumpMap === prev` alias path already in that function. Small,
contained change; no behavioural change for the CPU path (canvas textures have no owner RT).

## 10. Verification plan

1. **Perf (the bug):** `node tools/io-isolate.mjs` before/after. Expect first-visit max-frame
   for Io/Europa to drop from ~108/359 ms to **< 16 ms**. Add Ganymede/Callisto/Triton.
2. **Visual parity:** before/after screenshots, same view, per archetype — icy (Europa),
   volcanic (Io), rocky (Phobos/Deimos), plus a non-photo moon so the procedural colour is
   actually shown (e.g. a small Saturnian/Uranian moon). GPU flags per the
   `headless-webgl-screenshots` skill. Confirm no gamma shift (§6) and no banding (§7).
3. **Guarantee:** scripted land→look-up→swap→jump across systems with the arrival veil and
   gate active; confirm no frame shows a grey/placeholder or unloaded body (the audit's job).
4. `npm run build` (tsc strict, `noUnusedLocals`) + `npm test` (298 tests) green.

## 11. Risks & mitigations (summary)

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | Colour-space gamma shift | `ShaderMaterial` raw write + sRGB tag after; before/after screenshots (§6) |
| 2 | f32 noise banding (large seed) | reduce seed to `mod 997`, highp (§7) |
| 3 | First-paint shader-compile stall | `prewarm()` compiles the quad program off the hot path (§8) |
| 4 | RT framebuffer leak on photo replace | `ownerRenderTarget` tag + owner-aware dispose (§9) |
| 5 | Per-moon RT memory (~ current canvas) | lazy (only visited systems); pool+`copyTextureToTexture` is a later optoption |
| 6 | RT render fails (context loss) | `try/catch` → CPU `paintMoonTextures`; guarantee never depends on GPU (§8) |
| 7 | Renderer state disturbed mid-frame | save/restore `getRenderTarget`; paint runs in `update()`, before `renderScene()` (§4) |

## 12. Guarantee argument (explicit)

1. The gate (`:1401`), the per-moon visibility check (`:1411` `visible && m.painted`), and the
   veil (`arriveThen`) are **not modified**. Only the injected paint *implementation* changes.
2. `moon.painted` is set `true` only after the RT texture is rendered and assigned — so the
   visibility check can never expose an unpainted moon.
3. The RT is rendered during `update()`, before `renderScene()` reads it the same frame (§4)
   — the first visible frame is fully textured, not a one-frame placeholder.
4. `prewarm()` removes the only *new* potential stall (first shader compile).
5. If the GPU path throws, it falls back to the synchronous CPU `paintMoonTextures` — paint
   still completes before `painted=true`, so the worst case degrades to today's behaviour
   (correct, just slow), never to a visible-unpainted body.
6. Nothing here shows a placeholder or relaxes the gate. Planets are unaffected (they load
   real maps and have their own readiness handling; this change is moon-only).

## 13. Open questions for review

- Is the `ShaderMaterial`-raw-write + post-hoc `colorSpace` tag truly encode-free on three
  r0.183, or does three apply output conversion when the RT texture colorSpace is sRGB? (If
  the latter, set colorSpace only after render, or keep RT linear and pre-encode in-shader.)
- Per-moon RTs vs a sized pool + `copyTextureToTexture` into plain textures — worth it now, or
  defer? (Memory is ~ the current CanvasTexture footprint.)
- MRT (colour+bump in one pass) now or later?
- Any place a **planet** (not moon) can show unpainted that this work should also cover, or is
  that fully handled by the existing planet load path?

---

## 14. Review synthesis & v2 decisions — AUTHORITATIVE (supersedes conflicting earlier text)

Four independent reviews ran against §1-13 + the real source:

| review | verdict |
|---|---|
| GPU design — subagent (Opus) | rework |
| GPU design — codex (xhigh) | rework |
| Guarantee audit — subagent (Opus) | guarantee-holds-with-conditions |
| Guarantee audit — codex (xhigh) | guarantee-at-risk |

Consensus: architecture sound, guarantee **preservable**, no redesign — but harden as below.
Where the earlier sections conflict with this one, **this section wins**. Tags cite origin.

### 14.1 Colorspace — RESOLVED (the reviewers' one real disagreement)
- Mechanism (codex, with three r0.183 source refs; **supersedes §6**): the sRGB→linear decode for
  a colour `map` is the **GPU internal format** (`SRGB8_ALPHA8`), which three selects from
  `texture.colorSpace` at **RT allocation** (`setupRenderTarget`, first `setRenderTarget`).
  `MeshStandardMaterial` adds *no* shader-side decode for an ordinary map. So tagging colorSpace
  *after* the first render (my §6) is **too late** — storage is already `RGBA8`/linear → gamma-wrong.
- Both reviewers agree the WRITE is raw (a `ShaderMaterial` doesn't emit the colorspace chunk;
  a non-XR RT forces Linear output + NoToneMapping).
- **Decision:** allocate the colour RT with `colorSpace: SRGBColorSpace` **before first render** (so
  storage = `SRGB8_ALPHA8`); the shader outputs the same raw byte-equivalent values the CPU canvas
  held (`baseColor + (variation-0.15)`); hardware sRGB-decode on sample → matches CPU. Bump RT
  stays `NoColorSpace`. **Pin `type: UnsignedByteType`** — HalfFloat breaks the equivalence (subagent).
- **Empirical guard (codex MISSED + both guarantee audits' fail-closed ask):** at prewarm, render the
  shader to a small RT and **read back a few texels**, compare to the CPU formula within tolerance.
  This one check (a) validates colorspace/parity AND (b) proves the GPU path produces correct,
  non-black output. Fail → **disable GPU path, use CPU `paintMoonTextures`**. One-time, not per-paint.

### 14.2 Fail-closed paint contract (guarantee-critical — both guarantee audits)
- `painted` means **verified-usable texture assigned**, never "render call returned."
- `paint()` is transactional / assign-last: render both RTs → confirm context not lost → assign
  `map`+`bumpMap` → set `painted=true` **last**. On any failure → dispose partial RTs → CPU
  `paintMoonTextures` (sets painted=true) → if CPU also throws, **rethrow** (system stays pending,
  retried next frame; never silently dropped). [codex-guarantee #3, #5; subagent HOLE 3]
- The injected paint fn must end `painted===true` **or throw** — never return painted=false (else
  `paintSystemNow` deletes the system from pending → moon hidden forever / teleport enters an
  incomplete scene). [codex-guarantee #3]
- Silent failure: `try/catch` won't catch a lost context / incomplete FBO that doesn't throw.
  Before `painted=true`, check `renderer.getContext().isContextLost()` + the 14.1 validation.
  If unusable → CPU/abort, not painted. [both guarantee audits, codex-guarantee #1]

### 14.3 Context loss after paint (guarantee-critical — both)
RT textures have no CPU backing; after `webglcontextrestored` they are black but `painted` stays
true → black moon. Add `webglcontextlost`/`webglcontextrestored` handling: mark all RT-painted
moons `painted=false` and re-enqueue (prefer CPU until re-validated). CanvasTextures survive via
three's re-upload; RTs don't. [codex-guarantee #2]

### 14.4 RT allocation — ALL options up front (codex BLOCKER 3; subagent B2)
`makeRT(w,h,kind)` passes every option at construction (three sets RT params in `setupRenderTarget`;
mutating after is too late for sampler state):
`{ depthBuffer:false, stencilBuffer:false, format:RGBAFormat, type:UnsignedByteType,
colorSpace: kind==='color'?SRGBColorSpace:NoColorSpace, wrapS:ClampToEdge, wrapT:ClampToEdge,
minFilter:LinearMipmapLinearFilter, magFilter:LinearFilter, generateMipmaps:true, anisotropy:<captured> }`.
Do **not** call `applyTextureDefaults` after render. Mipmaps auto-generate at end of `render(rt)`.

### 14.5 Parity with CPU (codex MAJOR; subagent B1/B3/M3)
- **Archetype:** replicate `createMoonTextures`' RGB/brightness classifier EXACTLY — `isIcy = luma>0.55`,
  `isVolcanic = r>0.6 && g>0.4 && b<0.35`, else rocky. **NOT** `moonArchetype()`/`ICY_MOONS`
  (25/65 moons disagree; Io & Titan are the only volcanic). The shared module (14.10) guarantees it.
- **Sampling grid:** use `(gl_FragCoord.xy - 0.5)/uTexSize` to match CPU `x/width, y/height` (kill the
  half-texel shift of pixel-centre `vUv`). [codex MAJOR]
- **Wrap:** ClampToEdge for parity — current CanvasTextures are clamp; noise isn't periodic; Repeat
  blends opposite seam edges. The GLSL crater x-wrap is harmless under clamp. [both — supersedes §5/§11]
- **Not bit-exact:** byte-rounding/clamp coupling differs; documented as **visually equivalent**
  (decorative noise, §7). The parity readback (14.1) uses a tolerance, not equality. [subagent M3]

### 14.6 Eager prewarm (all four)
Prewarm in the texturer ctor / mode `activate()`, **before any gate can run** — compile the quad
program + run the validation readback off the hot path. (The moon `MeshStandardMaterial`
USE_MAP/USE_BUMPMAP recompile on first map assign is pre-existing CPU-path behaviour, far cheaper
than the 359 ms loop; prewarming it is optional, not required.) [supersedes §8 lazy prewarm]

### 14.7 Renderer state save/restore (codex BLOCKER 2; subagent HOLE 6)
`renderToRT` in **try/finally**: save/restore render target (+ active cube face, mip level) and
viewport, so a throw mid-paint can't leave the renderer bound to the moon RT for the next
`renderScene()`.

### 14.8 Pump count cap (codex MAJOR; subagent HOLE 8)
GPU paint returns after command submission, so the wall-clock budget never trips → it would drain
all ~64 moons in one frame (FBO/mipmap burst, possible context loss). Add a hard **jobs-per-frame
cap** to `pump`. The gate path is unaffected (it must fully paint the visible system — that's the point).

### 14.9 Lifecycle / ownership (codex MAJOR; subagent MISSED — resolves the §8/§9 conflict)
- An RT's ownership transfers to the material once assigned; track RTs in a Set for **teardown only**.
- `applyColorTierTexture`: owner-aware `disposeTextureOrOwner(prev)` — dispose
  `prev.userData.ownerRenderTarget` if present (the colour photo-replace path), else `prev.dispose()`;
  keep **assign-new-before-dispose-old** (already the order). Remove the RT from the Set on dispose.
- Wire `texturer.dispose()` into `PlanetariumMode.dispose()` (~5560-5593); teardown disposal of
  remaining tracked RTs is safe (scene is going away). Never call `dispose()` while moons are live.

### 14.10 Shared module (codex MAJOR — can't import the private helpers as sketched)
New `src/planetarium/world/proceduralMoon.ts` exporting: `hashString`, `seededRng`, CPU
`valueNoise`/`fractalNoise`, `SMALL_MOON_RADIUS_KM`, `classifyMoonArchetype(colorHex)` (the EXACT
`createMoonTextures` classifier → `{isIcy,isVolcanic}`), `generateCraters(rng,w,h,isIcy)→Crater[]`.
Both the CPU fallback (`createMoonTextures`) and the GPU `setUniformsFor` import it → archetype +
crater placement parity by construction.

### 14.11 Seed (codex MINOR)
`hash % 997` collides (Miranda/Styx already collide). Use a larger bounded seed (≥ 2^16, e.g.
`mod 131071`): f32-smooth (ulp ≈ 0.015 at 1e5) and collision-resistant. Verify no banding (screenshot).

### 14.12 Misc
- Quad `ShaderMaterial`: `depthTest:false, depthWrite:false, toneMapped:false`; do **not** set
  `glslVersion` (keep `gl_FragColor`). [codex NIT/MINOR]
- Include the vertex shader: `vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);`. [subagent m1]
- Assert out-of-loop paint sites (swap/jump/`setCurrentUtcMs` → `refreshLandedScene` →
  `updateMoonPositions`) stay no-ops on already-painted systems; `debugWarn` if a first paint ever
  fires there. [subagent HOLE 2]
- App is **WebGL2-only** on three r183 — dynamic loops fine, but keep const-bounded for clarity. [codex MINOR]
- "sub-ms" → "low-single-digit-ms"; measure with `io-isolate.mjs` (+ Ganymede/Callisto/Triton),
  confirm ANGLE/Metal active, not SwiftShader. [both]
- Planets verified unaffected by both audits. Pre-existing `createFallbackTexture` grey-planet
  placeholder (only on a planet texture-load failure) is **out of scope** — note, don't fix here.

### 14.13 Tests / verification
- Pixel-parity readback harness (one-time; also the runtime fail-closed validator of 14.1).
- Unit test: classifier parity for all catalog moons (shared module) + crater determinism.
- `io-isolate.mjs` before/after (Io/Europa first-visit max-frame ~108/359 ms → low-single-digit-ms).
- Before/after screenshots per archetype (icy/volcanic/rocky + a non-photo moon) — gamma + banding.
- `npm run build` (tsc strict) + `npm test` (298) green.

### 14.14 Implementation order
1. `world/proceduralMoon.ts` shared module (+ unit test for classifier parity).
2. Refactor `createMoonTextures` (CPU fallback) onto the shared module — output unchanged.
3. `world/ProceduralMoonTexturer.ts` (GPU): quad + ShaderMaterial + `makeRT` (14.4) + prewarm/validate
   (14.1/14.6) + transactional `paint` (14.2) + try/finally `renderToRT` (14.7) + owner tagging.
4. Wire into `PlanetariumMode`: construct + inject into `MoonPainter`; pump cap (14.8); context-loss
   handlers (14.3); `dispose()` wiring (14.9); out-of-loop assert (14.12).
5. `applyColorTierTexture` owner-aware dispose (14.9).
6. Verify (14.13).
