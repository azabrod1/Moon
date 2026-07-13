# Spike S1 — Depth / Composer Findings

> Risk-killing spike for **R1** (two-scene split vs the shared composer). Scope per
> [ROADMAP.md](../ROADMAP.md) "S1 + S2 + S3 — Spikes" and [TECH.md](../TECH.md) §2.1, §3, §6, §9.
> **Verdict: R1 retired.** The two-pass sky/world split renders correctly at real lunar
> scale through the refactored shell composer and the no-bloom fallback, with no z-fighting or
> precision jitter at either altitude extreme. One AC (per-frame pass cost) could not be
> measured on this box — no working headless GPU — and is flagged for real-hardware QA; the
> mechanism is proven, only the absolute number is missing.

## What shipped vs what was thrown away

| Kind | Path | Fate |
|---|---|---|
| **Surviving** | `src/app/renderPipeline.ts` (+ `.test.ts`) — per-mode pass-list assembly for the composer and the no-bloom fallback | Production code; P1's `DescentMode` renders through it |
| **Surviving** | `src/main.ts` — `buildComposer(cam, bloom, passes, opts)`, `renderScene` → `renderPassesDirect`, `getTargetPixelRatio` descent branch (≤1.5 desktop / ≤1.25 mobile), `?nobloom=1`, spike dev hooks | Behaviour-preserving for the three existing modes (a one-element pass list reduces to today's exact call) |
| **Throwaway** | `src/descent/spikes/s1/*` (`frames.ts`+test, `spikeWorld.ts`, `spikeSky.ts`, `SpikeS1Mode.ts`) — gray sphere at real scale, camera-relative transforms, the 450 km → 2 m fly | Deleted when P1's real terrain/sky land; `frames.ts`'s radius-parameterized depth math is the piece worth porting |

Entry is QA-only: `?spike=s1` (no UI button), driven headless through the `window.__moon.spike*`
bridge. Build clean (strict tsc), **605 tests pass** (11 new: `renderPipeline` 6, `frames` 5).

## Acceptance criteria

| # | AC (ROADMAP/TECH) | Result | Evidence |
|---|---|---|---|
| 1 | No z-fighting / jitter at either extreme (450 km and 2 m) | **PASS** | Stills clean at both ends; camera-relative path is 8× steadier than the naive absolute-float32 path, which is measurably displaced |
| 2 | Terrain never blooms at any exposure (exposure applied pre-bloom) | **PASS (within envelope) — calibration finding** | At the nominal operating point (+2 EV) sun glare blooms, terrain does not (ground Δ ≈ 0.015%). At +4 EV extreme overexposure terrain crosses the threshold — this bounds the auto-exposure clamp, see below |
| 3 | World scene `background` null verified | **PASS** | Dev guard `warnNonNullLaterBackground` never fired across the whole capture run (0 page warnings) |
| 4 | Both render paths correct (bloom + no-bloom fallback) | **PASS** | Bloom path: all stills. No-bloom (`&nobloom=1`): sky + ground both render (ground lum 131, sky lum 4.0 — lit ground under a dark star sky) |
| 5 | `toneMappingExposure` restored on exit | **PASS** | 1.2 in-spike → **1.0** after `spikeExit()` (the app's startup default); `autoClear` restored to true |
| 6 | Extra pass cost < 0.5 ms | **DEFERRED — no GPU on this box** | Software rasterizer only (frames 240–275 ms). The sky pass is one extra `RenderPass` (a `Points` buffer + 2 small meshes); sub-ms on real GPU. Needs on-hardware QA |
| + | AA decision (MSAA through composer vs FXAA) | **RESOLVED** | `samples: 4` on both composer targets builds and renders through the two-pass chain with no artifacts; silhouette edge smooths. Recommend MSAA 4× — gated on the VRAM line in TECH §9 |
| + | Pixel-ratio policy ≤ 1.5 (TECH §9) | **DONE** | `getTargetPixelRatio()` descent branch: ≤1.5 desktop, ≤1.25 mobile |

### AC 1 — precision at scale (the core of the spike)

Real lunar radius (1,737,400 m) with a 2 m eye is exactly where float32 absolute coordinates
quantize to ~0.25 m and shimmer. The spike proves the camera-relative fix and includes the
counter-proof (`spikeSetNaive(true)` bakes the absolute selenocentric coordinate into float32
before the GPU sees it — the classic bug):

| Metric | Camera-relative (default) | Naive absolute-float32 |
|---|---|---|
| Frame-to-frame changed-pixel **spread** while panning | 0.012 | 0.093 (**8× noisier**) |
| Static frame displacement vs the correct render | — | 14.7% of pixels differ, mean Δ 9.8/255 |

The static-frame number is the money shot: with the camera *not moving*, the naive path renders
in a visibly different place than the correct path — that displacement is the float32 quantization
the floating-origin pattern removes. `frames.test.ts` pins the depth anchors from TECH §3/Appendix
(horizon 1,329 km @ 450 km; relief term 125 km @ 4.5 km peak; near 150 m @ 450 km, 0.4 m @ 2 m eye).

The near/far table across the descent (relief-inflated far so a distant massif isn't clipped at
the limb — the TECH §3 correction from review):

| Alt | near | far | note |
|---|---|---|---|
| 450 km | 150 m | 1,537 km | orbit |
| 20 km | 6.67 m | 419 km | |
| 2 km | 0.667 m | — | worst depth ratio, still comfortable on 24-bit depth |
| 100 m | 0.40 m | 161 km | final approach |
| 2 m | 0.40 m | 144 km | touchdown; checker + horizon curve rock-steady |

### AC 2 — the bloom boundary (a real finding, not a pass/fail)

The mechanism (TECH §6): tone mapping runs in `OutputPass` **after** bloom, so the renderer's
`toneMappingExposure` can never pull terrain below the bloom threshold. Exposure is therefore
applied **pre-bloom** by scaling the sun `DirectionalLight` (`intensity = 2.2·2^EV`), and the
per-mode bloom threshold is **1.0** so only the deliberately-HDR sky (sun glare, stars) blooms.

Measured, this holds cleanly through the **operational** exposure range and then crosses:

| Exposure | Ground blooms? (Δ bloom-on vs -off, below horizon) | Sky blooms? |
|---|---|---|
| +2 EV (nominal operating point) | **No** — 0.015% of ground pixels, mean Δ 0.44/255 | Yes — 82% of sky, mean Δ 28 |
| +4 EV (16× — extreme overexposure) | **Yes** — 100% of ground, mean Δ 29 | Yes — 100% |

At +2 EV sunlit terrain lands at ~0.4–0.8 pre-bloom radiance (albedo/π · 8.8 · N·L), below 1.0.
The crossover sits between +2 and +4 EV. **This is the useful spike output**: it quantifies the
headroom between nominal terrain luminance and the bloom threshold, so P1's analytic auto-exposure
(TECH §6 — expose *up* on a shadowed terminator frame) must **clamp its pre-bloom scale** to keep
peak sunlit terrain under threshold, rather than boosting freely. The alternative — a higher
per-mode threshold — is on the table but weaker, since it also lets brighter sky slip the bloom.
The +4 EV frame (`frames/03-bloom-ev4-overexposed.png`) is the deliberate over-crank showing the
ceiling; it is not a defect.

## Committed evidence frames (`frames/`)

| File | Beat |
|---|---|
| `01-orbit-450km.png` | 450 km, near-nadir; HUD shows near 150 m / far 1,537 km |
| `02-eye-2m.png` | 2 m eye: crisp high-frequency checker to a curved horizon, reference cubes with hard shadows, obelisk silhouette, stars, blue Earth, sun glare |
| `03-bloom-ev4-overexposed.png` | +4 EV over-crank — the bloom ceiling (AC 2) |
| `04-postexit-planetarium.png` | Planetarium renders correctly after a full spike round-trip (regression proof: exposure/autoClear restored, composer rebuilt) |

Frames are software-rendered (this box has no working headless GPU — SwiftShader, ~250 ms/frame);
they are correct, only slow. The full capture set + numeric report land in `planning/spike-s1/`
(gitignored); the driver is committed at **`tools/descent/spike-s1-capture.mjs`** — it defaults
to the real GPU, so re-running it on real hardware (`node tools/descent/spike-s1-capture.mjs
spike` against `npm run dev -- --port 5174 --strictPort`) is how the deferred pass-cost AC gets
its number.

## Carry-forward into P1

1. **Pass-cost number** — measure the sky-pass delta on real desktop + phone GPUs; confirm < 0.5 ms.
2. **AA** — adopt MSAA `samples: 4` on the composer targets, but re-check it against the TECH §9
   VRAM budget on a mid GPU before committing (FXAA is the fallback if the multisampled float
   targets blow the composer VRAM line).
3. **Auto-exposure clamp** — the pre-bloom exposure scale must be capped so peak sunlit terrain
   stays < 1.0 threshold (AC 2 finding); wire this into `sky/exposure.ts` when it lands.
4. **Depth is proven; port `frames.ts`** — its radius-parameterized `computeNearFar` /
   `horizonDistance` / `toCameraRelative` are correct and body-agnostic (extend-to-other-bodies
   ready). The rest of `src/descent/spikes/` is throwaway.
