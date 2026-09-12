# Orbit lines: investigation handover

Written 2026-09-12 against `main` @ `afadb74` (the Standish table blend, which sits on top of
`4602bac` "Orbit lines: anchor the vertices near the ship"). Branch:
`claude/orbit-lines-blunt-edges-zmmcv0`. **No production code was changed in this
investigation.** Everything below is measurement, diagnosis and a reviewed plan.

Read this before touching `src/planetarium/SolarSystem.ts`, `src/planetarium/orbitLineAnchor.ts`
or `src/astronomy/planetary.ts`'s trajectory-line seam. It exists so the next agent does not
re-run 20 experiments that have already been run, and does not implement a fix for a defect that
was measured not to exist.

---

## 1. What started this

A phone screenshot of the deployed app: the ship parked near Pluto, clock Sep 11 2026 06:52,
speed dial "Pluto 25k km/s", and a pale tan line crossing the upper frame with a **sharp corner,
roughly 60 degrees, two straight arms several hundred pixels long**. The question was why the
orbit lines have "blunt edges" when the anchor fix had just shipped.

**Status: that corner is still unidentified.** It is NOT the orbit-line tessellation (section 3
proves this). Two *other*, real, visible orbit-line defects were found while proving it
(section 4). Do not conflate them.

---

## 2. What the orbit lines actually are (orientation)

- Nine `Line2` fat lines, one per `PLANETARIUM_BODIES` entry, built in
  `SolarSystem.ts:createSolarSystem`, named `orbit-<Body>`.
- Realistic layout only. `layoutMode` is initialised `'realistic'` at
  `PlanetariumMode.ts:1531` and **never reassigned**, so the aligned 256-segment circle path
  (`SolarSystem.ts:87`, `:146`) is dead code at runtime. Worth knowing: aligned circles have
  1.4 degree joints and would be a real corner source if ever re-enabled.
- Vertices are the body's own rendered trajectory over one period centred on the line epoch
  (`planetary.ts:325 sampleTrajectoryLinePoints`), so the body sits on its line *by construction
  at the epoch*.
- Segment counts from `SolarSystem.ts:129 orbitLineSegmentCount`: 1024 for most, 1280 Mars,
  1536 Uranus, 2048 Neptune, 8192 Pluto (clamped).
- Float32 vertices are measured from an anchor near the ship and the line is posed at
  (anchor - ship) in double: `orbitLineAnchor.ts`, applied by `SolarSystem.ts:189 poseOrbitLine`
  from `PlanetariumMode.ts:4760`. `?orbitanchor=0` is the kill switch.
- **The setting is OFF by default**: `PlanetariumMode.ts:709 showOrbitLines = false`. Visibility
  rule at `PlanetariumMode.ts:8468`; also forced off in surface view.
- The strip is deliberately **open**, not a closed loop, and that is test-pinned:
  `SolarSystem.test.ts:255` "keeps the realistic strip a strip — the period seam stays open".

---

## 3. Ruled out, with numbers. Do not re-run these.

### 3.1 The tessellation cannot produce a visible corner

Three independent measurements:

| Measurement | Result |
|---|---|
| Largest 3D bend anywhere on Pluto's 8192 joints | 0.060 deg (median 0.040, ratio 1.49) |
| Largest ratio of worst joint to own median, any body | Pluto 1.49, Mercury 1.37, rest below 1.1 |
| Exhaustive projection search, worst on-screen corner | **0.3 deg Pluto, 1.9 deg Earth** |

The exhaustive search is the decisive one: eye positions from 1e3 km to 1e9 km from the line,
five out-of-plane fractions, and for **every** joint the camera aimed straight at it so that any
joint can be framed, with both arms required to be at least 50 px. Nothing exceeds 1.9 degrees.

In the running app it is even more clear-cut: at every Pluto distance reachable through
`__moon.jumpTo`, **zero orbit-line vertices land inside the frame**. One chord spans the whole
view; there is no joint on screen to corner. Captures confirm a clean straight line, including
the close pass where the line grazes the disc.

### 3.2 Also ruled out

- **The Standish table blend (`afadb74`) did not introduce a kink.** No line has an anomalous
  bend anywhere; see the table above.
- **The strip seam** is not the corner: Pluto's two strip ends are 0.8 px apart with a 0.1 deg
  tangent turn. (Saturn's seam IS a real defect, section 4.2, but it is a *gap*, not a corner,
  and it sits ~19 AU from a ship at Saturn.)
- **Shadow guides** (`world/ShadowVisuals.ts`, white fat lines at opacity 0.5) are not drawn at
  Pluto poses; their ancestor group is invisible. Checked in-page with a parent-chain walk.
- **The lens cannot bend a line.** The pre-distortion in `augmentFixedScreenLineForLens`
  (`shared/three/lensShader.ts:239`) places each vertex at `unwarp(warp(ndc) + offset)`, so the
  *centreline* endpoint stays at `ndc` for any lens strength (warp and unwarp share the uniform
  and cancel). Only the width changes. A straight source line warps to a smooth output curve.
  The `lensApplies` guard splitting adjacent chords between the lens and stock paths therefore
  cannot kink the centreline either.
- **No temporal accumulation** exists in the planetarium path, so it is not a motion smear.
- **`OrbitDetailsVisuals`** is a separate line system and is cool blue (`0x7c9aff`, `0x9ab8ff`,
  `0xcfe2ff`), not tan.
- **Constellations** are `0x6688bb` at 0.28 opacity and off by default. They *do* have real
  corners at stars (they are `LineSegments` between bright stars) and are the best remaining
  candidate for the screenshot, but the colour is wrong.
- **The chart's seam pinch** (`SystemMap.ts` pinches the two strip ends onto their midpoint,
  0.24 AU for Saturn) produces only a 3.3 deg kink versus a 2.0 deg typical joint, because the
  pinch is nearly along-track. Not it.

### 3.3 The open question

The object in the screenshot is still unidentified. The cheapest discriminator, one tap on the
device that produced it: **menu, Orbit lines off**. If the line survives, it is not an orbit line
and the candidates are the constellation figures or something on the production-only no-composer
path that dev never exercises. If it vanishes, capture the pose (`__moon.probe`, camera state)
and re-open the question with it, because every pose reachable from here renders clean.

---

## 4. The real defects that WERE found

### 4.1 Mercury walks off the end of its own strip (worst; independent cause)

`ORBIT_LINE_RESAMPLE_MAX_AGE_MS = 60 days` (`SolarSystem.ts:119`) but Mercury's period is 87.9
days, so its half period is 44.0 days. Past day 44 the body has run off the *end* of the sampled
strip and is re-treading a loop that has precessed.

| Body | Worst body-to-line distance | In body radii | 8x denser sampling |
|---|---|---|---|
| Mercury | 9,875 km | 4.05 | **9,875 km (no change)** |
| Venus | 510 km | 0.08 | 8 km |
| Mars | 665 km | 0.20 | 10 km |

That is about 750 px of separation at a four-radii park. Denser sampling, and therefore any
interpolation-based refinement, does **nothing** for it. The fix is to make the age per body,
`min(60 days, P/4)`. The chart reads the same constant (`map/SystemMap.ts:66`,
`map/mapResample.ts`), so it is fixed there too.

### 4.2 Saturn's ring does not close (period error, confirmed)

The strip spans one Kepler period from the catalog semi-major axis
(`planetary.ts:272 trajectoryPeriodMs`), and Saturn's catalog value disagrees with the element
set the positions actually propagate from:

| Body | Catalog `a` | Standish `a` | Disagreement | Kepler yr, catalog | Kepler yr, elements |
|---|---|---|---|---|---|
| **Saturn** | **9.588** | **9.53667594** | **53.8 parts in 1e4** | **29.6888** | **29.4507** |
| Venus | 0.723 | 0.72333566 | 4.6 | 0.6148 | 0.6152 |
| Neptune | 30.061 | 30.06992276 | 3.0 | 164.8182 | 164.8916 |
| Mercury | 0.387 | 0.38709927 | 2.6 | 0.2408 | 0.2408 |

Every other body agrees to within 4.6 parts in 1e4; Saturn is 12x the next worst. Sources:
`planets/planetData.ts:181` and `astronomy/standish.ts:77`.

Consequences measured: the strip's two ends land **71.64 Mkm apart with a 2.54 deg tangent
mismatch**, which from a ship at Saturn (seam ~19 AU away) reads as an **18 px break** in the far
arc. A direct search for the period that closes the strip lands on 29.4498 yr, gap 61,306 km, a
1170x reduction, matching Kepler on the element axis to six digits. **So it is period error, not
element drift.** Every other body's residual gap IS genuine one-period drift (Uranus 3.64 Mkm
floor, Pluto 2.14 Mkm) and must stay open.

Second symptom of the same bad number: `map/mapFacts.ts:135` computes the displayed "Year" as
`semiMajorAxisAU ** 1.5`, so the app tells the user Saturn's year is 29.69 against a true 29.46.

Two module-header paragraphs are now known false and must be rewritten with the fix:
`planetary.ts:318-320` ("the gap ... far too small to see") and `:322` ("Kepler's third law from
the catalog semi-major axis is plenty"). Note `isMeeusPositioned` (`planetary.ts:246`) makes
Earth an exception: Earth renders from Meeus, the Standish Earth row is EM Bary used only by
tests, and Earth's catalog period is already the closing minimum (13,118 km), so keeping the
catalog for Earth is correct but must be *stated*, not accidental. `trajectoryPeriodMs` is also
shared with `trajectoryLineBodyFraction` (`planetary.ts:354`) by explicit design, so changing it
moves every fraction consumer and will move `planetary.test.ts:479-519`.

### 4.3 Bodies cut the corner of their own chord (the general case)

Between resamples the body slides along a chord that cuts the corner of the true curve. Worst
distance from the body to its drawn line over a 60-day window, and what it subtends from a
four-radii park:

| Body | Offset | In radii | Pixels at 4 radii |
|---|---|---|---|
| Mercury | 9,875 km | 4.05 | ~750 (but see 4.1, different cause) |
| Pluto | 519 km | 0.44 | 80 |
| Uranus | 5,857 km | 0.23 | 42 |
| Neptune | 5,363 km | 0.22 | 40 |
| Mars | 665 km | 0.20 | 36 |
| Saturn | 6,965 km | 0.12 | 21 |
| Earth | 706 km | 0.11 | 20 |
| Venus | 510 km | 0.08 | 15 |
| Jupiter | 3,521 km | 0.05 | 9 |

`SolarSystem.ts:126-127` already documents this as accepted ("it clamps at 8192 for ~0.37 R
there"). The measurement says the accepted budget is a 40-to-80 px separation at the poses people
park at. That paragraph must be rewritten by whatever fixes this: the right budget is sized
against *viewing distance*, not body radius.

---

## 5. The plan (post-review). Ship in this order; the order is load-bearing.

An Opus reviewer went over the first draft of this plan, found the Mercury omission and refuted
one of its headline claims. What follows is the corrected version.

1. **Per-body resample age**, `min(60 days, P/4)`. One DOM-free function, fixes the largest
   instance of the defect, propagates to the chart for free. Ship alone, first.
2. **Trajectory period from the element set**, with an explicit Earth branch, plus the two header
   rewrites and `mapFacts.ts:135`. Near-zero cost. Independent of everything else.
3. **Insert the body's own position as a vertex in its nearest chord, each frame.** Twelve floats
   written into the existing pair buffer (split one segment into two through the body's exact
   position). This makes the body sit on its line *exactly*, is the same real trajectory, needs no
   second geometry, no draw-range trick, no seam-straddle rule, and tracks the *body*, which is
   what the defect is about. Must be re-applied after every re-anchor (see 6.1). **Unsafe before
   step 1** (see 6.2).
4. **Only if step 3's residual mid-chord bow still reads on a device**: refine. Measure first,
   it has never been measured. If it does read, the honest first move is to lift the 8192 clamp in
   `orbitLineSegmentCount` for Pluto alone (8x gets Pluto to 8 km, 0.007 radii, measured) and
   price the 1.5 MB buffer, before building a second line system.

### 5.1 The near-arc design, shelved but recorded

The first draft proposed a "near arc": one extra fat line tracking the ship, rebuilt by
uniform-parameter Catmull-Rom over the frame's existing Float64 samples (never fresh ephemeris
calls; interpolation error is millimetres at Pluto's 0.00083 rad sample spacing, ~20 ns/point
against ~1 us for an ephemeris eval), sized so a chord's sagitta `chord^2/(8*rho)` seen from
distance `d` stays under half a pixel, i.e. `chord <= sqrt(8*rho*d*epsilon)`.

Useful results from that work, kept because they will be needed if step 4 ever fires:

- **The refine region is bounded and small.** It is everything within `chord^2/(8*rho*epsilon)`
  of the camera: 780,000 km at Pluto, ~1e6 km at Earth. Both are under one base chord, so the arc
  never needs to span more than one or two base chords and a uniform subdivision suffices.
- **Worst refinement factor at a surface park**: Pluto 26x, Uranus 18.5, Neptune 17.7, Mars 17,
  Earth 12.7, Jupiter 8.5. A fixed 128-segment buffer covers everything with margin.
- **Size the criterion from the camera, not the ship.** `poseOrbitLine` is fed
  `player.pos*` (`PlanetariumMode.ts:4728`) but the camera orbits the ship out to
  `controls.maxDistance = 5` AU (`PlanetariumMode.ts:2417`) and can swing to the body side,
  putting the camera far closer to the line than the ship is.
- **Defining the arc by a span around the ship's nearest point is wrong**; define it by the error
  criterion itself. Then it provably contains the body whenever the body's own offset is visible,
  because the body's pixel offset is bounded by the same quantity.

### 5.2 Rejected, and why

- **Raise the global segment count.** Matching the near-camera requirement uniformly needs tens of
  thousands of segments per line and still does not reach it.
- **Resample more often.** Costs the whole line for a partial benefit; at high time rates it runs
  every frame (see 6.1). Note this is *not* the same as fix 1, which changes the age only for
  bodies whose half period is under the age.
- **Snap the body to the line.** Backwards and dishonest; the line should follow the body.
- **"Inserting a vertex at the body will make a sharp corner near the camera."** This was the
  first draft's reason for preferring the arc and **it is false.** Measured worst on-screen corner
  from the inserted vertex, sweeping both perpendicular and along-track (grazing) eye offsets at
  1.2 to 2000 body radii: **Pluto 0.10 deg, Uranus 0.22 deg**. Same order as the corners the line
  already has everywhere, and consistent with section 3.1. It was asserted without measurement.

---

## 6. Implementation hazards (found by review; all still apply)

1. **`writeOrbitLine` reassigns `instanceCount` on every rewrite** (`SolarSystem.ts:427`), and a
   re-anchor calls it. At high time rates with the ride frame near Pluto that can be *every
   frame* (the ship's heliocentric position moves millions of km per frame against a
   `drift/100` trip threshold). Any per-frame vertex bookkeeping (fix 3) or draw-range
   bookkeeping (the arc) must be re-applied after each rewrite or it silently reverts.
   `resampleOrbitLines` also re-fires whenever the 60-day age trips, which at 1 yr/s is every
   ~0.16 s for all nine lines. That path is already hot; price anything added to it.
2. **Fix 3 must not ship before fix 1.** Measured: inserting Mercury's body position today, with
   the body 9,875 km off the strip, produces a **179.9 degree** on-screen corner at 2 body radii,
   i.e. the line visibly doubles back on itself. The insert is a refinement of an already-close
   line, not a repair for a grossly wrong one.
3. **The two-draw-range trick works in three 0.183 but is not "one extra line".** Verified in
   `node_modules/three/examples/jsm/lines/LineSegmentsGeometry.js`: two
   `InterleavedBufferAttribute`s over one `InstancedInterleavedBuffer` do share a single upload,
   and an offset view with a reduced `instanceCount` draws in bounds. But WebGL has no
   base-instance and `drawRange` applies to the quad's vertices, not instances, so hiding a
   *middle* run needs base `[0,m)` + a second `Line2` at offset `k` + the arc: three draw calls
   and three objects, all transparent, all `depthWrite:false`, all carrying the same whole-loop
   bounding sphere. `_maxInstanceCount` is cached on the geometry and cleared only on dispose.
4. **`segmentPairBufferOf` asserts the exact layout** (`SolarSystem.ts:377`, offsets 0 and 3) and
   `SolarSystem.test.ts:176-180, 227-249, 282-295` pin the layout, attribute identity across
   rewrites, and instance counts. Any offset view must be excluded without weakening the guard.
5. **Do not turn `lineWithinAU` into the nearest-point query.** It early-outs on first hit
   (`orbitLineAnchor.ts:190`) and runs every frame for all nine lines. Add a separate
   nearest-point function and keep the boolean fast path for the anchor test.
6. **Material identity.** Any added line must use the *same material instance* as its base line,
   not an equivalent one: same lens augment, same `customProgramCacheKey`
   (`'orbit-line-lens-buttcap-v2'`), same stencil ref, same `renderOrder = -1`, and the per-frame
   `material.opacity` write from `orbitLineOpacity` happens once. A second instance gets its own
   program and a second opacity write to keep in sync, and any mismatch shows as a width or
   brightness step at the seam.
7. **Three line systems share the "a planet sits on its orbit" invariant** and only one is in
   scope here: the cruise lines (`SolarSystem.ts`), the chart
   (`map/SystemMap.ts:254 ORBIT_SEGMENTS = 180`, its own sample/recompress path), and
   `world/OrbitDetailsVisuals.ts`. Fix 1 reaches the chart through the shared constant; fix 3 does
   not.
8. **The probe needs a second scenario, not an extension.** `tools/orbit-line-probe.mjs`
   deliberately pushes the body's disc *off* screen (`--off=1.8`) because parallax swamps its
   reading. A "body sits on its line" assertion needs the body *on* screen and must also sweep the
   camera orbit, or it will not see hazard 5.1's camera-versus-ship hole.
9. **Kill switch**: `?orbitpatch=0` (or whatever the fix is called) belongs in the CLAUDE.md URL
   param list next to `?orbitanchor=0`. Decide deliberately whether it is also a
   `src/app/perfSwitches.ts` entry, because the perf sweep enumerates those.

---

## 7. Harness notes for this container (saves an hour)

- **Chromium**: the installed build is `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` but
  `playwright-core` 1.60 wants build 1223. Every script must pass
  `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'` or it throws
  "Executable doesn't exist".
- **No GPU here.** Launch with `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist --no-sandbox`. Frames are correct, just slow.
  On a real machine use the Metal flags from the `headless-webgl-screenshots` skill.
- **Browser lock**: `tools/browserLock.mjs` `takeBrowserLock()` serialises runs. It prints a
  harmless `pgrep` warning.
- **First-run overlay**: set `localStorage 'planetarium-help-seen' = '1'` in an init script, plus
  clearing storage and `indexedDB.deleteDatabase('orbital-sim-storage')`, or the welcome modal
  covers the scene. Copy the block from `tools/shoot.mjs:55`.
- **Orbit lines are off by default**; call `__moon.setOrbitLines(true)`.
- **The camera is not in the scene graph.** To analyse projections in-page, capture it from a
  draw: `obj.onBeforeRender = (r, s, camera) => { window.__cam = camera; }` on any drawn object.
- **`__moon.jumpTo(name, mul)` clamps** its distance; beyond a few hundred body radii the pose
  stops changing. Use `__moon.frame(name, fill, phaseDeg, distMul, offNdcX, offNdcY)` for
  distance sweeps, and note `frame`'s fill argument overrides the distance.
- **`__moon.pilotTo` did not fly** in a headless run with the clock frozen; use `jumpTo`/`frame`.
- **Ad-hoc Playwright scripts must live in the repo** (`tools/` or `planning/`), never `/tmp`:
  ESM resolves `node_modules` from the script's location. Scratch vitest files must live under a
  path vitest includes (`planning/*.test.ts` works; a repo-root file does not match the default
  include glob). **Note the trap**: vitest's default include is `**/*.{test,spec}.?(c|m)[jt]s?(x)`
  with no config file, so it picks up `planning/` too. A stale scratch test left there fails
  `npm test` for everyone. Delete scratch tests when done.

### Scratch probes written during this work

They are in `planning/` which is **gitignored and will be lost with this container**:
`zz_kink.test.ts`, `zz_kink2.test.ts`, `zz_kink3.test.ts`, `zz_verify.test.ts`, `zz_a.test.ts`,
and the Playwright scripts `repro-kink.mjs`, `kink-scan.mjs`, `corner-hunt.mjs`, `hunt2.mjs`,
`guides.mjs`, `scene-dump.mjs`, `pixel-bend.mjs`, `bend2.mjs`. The three worth recreating, and
their shapes:

- **Body-to-line distance** (produced section 4.3 and 4.1): sample the line with
  `sampleTrajectoryLinePoints(body, NOW, orbitLineSegmentCount(body))`, then for each day of clock
  drift 0..60 compute the point-to-polyline distance from `computeBodyPositionAU(body, NOW + d)`.
  Run it again at `segs * 8` to separate "chord cuts the corner" (shrinks) from "body ran off the
  strip" (does not).
- **Exhaustive on-screen corner** (produced section 3.1): for a grid of eye positions, aim a
  pinhole camera (60 deg vertical, 844 px, so 731 px/rad) straight at each joint in turn, project
  its two neighbours, require both arms >= 50 px, and take the max direction change. Aiming at the
  joint is what makes the search exhaustive over camera orientation.
- **Inserted-vertex corner** (refuted the arc's premise, section 5.2): same projection, but sweep
  the eye direction over a mix of perpendicular and **along-track** offsets. The along-track
  (grazing) mixes are the only ones where projection can amplify a bend; an azimuth-only sweep
  around the chord misses them and will wrongly report near-zero.

---

## 8. State of the tree

Clean. No tracked file was modified by this investigation apart from this document. At handover `npx vitest run`
is green: **133 test files, 3052 tests, 0 failures**. `npm run build` was not run, as no source
changed.
