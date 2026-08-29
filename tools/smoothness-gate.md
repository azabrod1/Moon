# The smoothness gate

Two oracles answer the same question — *did any frame arrive late, and what was
happening on it* — and they disagree in useful ways. The headless battery is
the one you run every time; real Chrome through the chrome-devtools MCP is the
one you run when the battery says FAIL and you need to see the stack.

The rule both oracles score against, per scenario:

> **PASS** when, after the loading screen is gone and outside the arrival
> veil's sanctioned cuts, no frame took longer than **two vsyncs at the
> machine's own refresh rate**, **p99 ≤ 20 ms**, and no **long task ran past
> 50 ms**. Otherwise **FAIL**, naming the frames and what fired on them.

The machine's refresh is read from the run itself: on an unloaded run the
median gap *is* one vsync, so the budget is 2 × p50 — 16.7 ms on a 120 Hz Mac,
33 ms on a 60 Hz one. Stating it that way keeps one rule meaning one thing
everywhere, instead of quietly handing the faster machine two extra refreshes
of slack. A four-vsync count rides along as the severity split, and the fixed
33 ms / 50 ms columns stay in the table so two machines' runs can be read side
by side.

One check on the rule: a run whose own median has drifted to two refreshes
would relax its own budget. So p50 is printed beside every verdict — a p50 that
is not near a plausible refresh rate invalidates the run, not the rule.

Frames under the arrival veil are counted and reported but not scored: the veil
is an opaque cover the app raises on purpose, and the point of separating them
is to see a hitch that merely *hid* behind a cut rather than to forgive it.

Thresholds move; the runs behind them are expensive. `--rescore=<dir>` re-scores
stored traces under the current rule without opening a browser.

A run that outran its frame buffer scores **INCOMPLETE**, never PASS: frames the
recorder could not hold are unmeasured, not clean, and a PASS over them would be
a claim about seconds nobody looked at. Each scenario sizes its own buffer from
the wall time it expects (`?smoothFrames=`); a scenario that grows needs its
budget grown with it.

Two things about how a gap is attributed, both of which have misled a reading of
this data before:

- A frame's gap is `raf(N) − raf(N−1)`, so the work that made it late ran during
  frame **N−1**. A 19 ms texture upload tagged on frame 309 shows up as a 49.9 ms
  gap on frame 310. The worst-frame report blames N−1 for that reason; a report
  that blamed N would show an empty cause list for every hitch it found.
- That off-by-one, plus the veil windows' one-frame dilation, makes the gate
  slightly lenient at a veil's leading edge: unveiled work whose cost lands on
  the veil's first frame is excused. That is the right way to err for a cut the
  app raises on purpose, but it is a choice, not an accident.

## Oracle 1 — the headless battery

```bash
# In this checkout, one terminal each:
npx vite --port 5656 --strictPort
node planning/_tiles-serve.mjs                 # tiles on :5622

node tools/smoothness-gate.mjs --label=baseline
node tools/smoothness-gate.mjs --scenario=earth-near,terminator --json
```

JSON lands under `/tmp/moon-shots/smooth/<label>/`: one file per scenario
(analysis plus the whole frame trace) and a `summary.json`. Exit status is
non-zero when any scenario failed.

Only one browser run may touch this machine at a time — a second Chromium on the
same GPU makes every number fiction, and has already killed one battery
mid-scenario. The gate takes `/tmp/moon-browser.lock` itself and waits for it,
so there is nothing to remember; every other browser run on the machine takes
the same lock:

```bash
until mkdir /tmp/moon-browser.lock 2>/dev/null; do sleep 10; done
echo $$ > /tmp/moon-browser.lock/pid
trap 'rm -rf /tmp/moon-browser.lock' EXIT
```

A lock whose pid is dead may be removed — the gate clears one automatically and
says so. Within its own run the battery uses one browser and one tab, closing
each context before opening the next, and it refuses to run at all if the
renderer string says SwiftShader.

## Verifying the instrument

`--scenario=selftest` injects deliberate 30, 60 and 120 ms main-thread blocks
after the reveal and fails unless the trace shows a gap for each. A gate that
cannot see a stall it caused itself is not evidence when it reports none, so run
this after any change to the recorder.

### Scenarios

| id | what it exercises |
| --- | --- |
| `boot` | Cold boot → first frame → the idle warm settling. Nothing may cost a frame after the reveal. |
| `earth-near` | `travelTo('Earth')` → arrival → `jumpTo` 0.13 → a governed descent on the throttle → 20 s hover while L0 and L1 tiles arrive. |
| `terminator` | The same near band, then a slow yaw pan across the terminator so the day and night sector families swap. |
| `hops` | Earth → Moon → Mars → Earth: four arrivals and three departures. |
| `squeeze` | Boots at `?envelope=200` so a desktop sits under a phone's memory pressure, hovers, then hops away and back to force a release and a re-fetch. |
| `moonlets` | Tiny-moon flybys: Phobos, then Styx. |
| `tour-60x` | Mercury through Neptune at 60× time rate. |
| `phone-earth-near`, `phone-terminator` | The same two near-band runs at 430×932, DPR 3, iPhone UA — which is a different device profile, so a different app. |

### What the record contains

The battery does not sample from outside; it reads the app's own DEV frame
trace (`src/planetarium/smoothnessTrace.ts`), armed by `?smooth=1` at module
load so the cold boot has frame zero. Per frame: the raf-to-raf gap, whether
the arrival veil was over it, a JS heap sample every 15th frame, and a
one-word cause for the heavy events that fired inside it —

- `veil` — the arrival veil was covering the screen
- `tile` / `release` — a sector tile materialised into a mesh, or was given back
- `rung` — a colour or relief tier swapped onto a material
- `upload` — the warm pump paid a GPU texture upload (carries the map's name, size and ms)
- `mark` — a scripted phase label from the harness (`reveal`, `hover`, `pan`, `travel:Mars`, …)

Long tasks come from a `PerformanceObserver`; GC shows up as a drop of more
than 5 MiB between heap samples. The recorder writes into preallocated typed
arrays and allocates only for the rare heavy events, because a GC pause is one
of the faults it exists to catch.

`traceStart`/`traceStop` are a different instrument and cannot serve here: they
sample one **moon's** rendered screen position for motion forensics, and return
false for anything that is not a moon.

## Oracle 2 — real Chrome through the chrome-devtools MCP

Run this when the battery fails and you want the stack, or when you suspect the
headless shell is flattering the app. It is the same scenarios driven by hand
through the page's own `__moon` bridge, with Chrome's tracer recording.

Two things that have wasted time here before: a headed Chrome window that gets
**occluded** throttles rAF to 1 Hz and every gap reads as 1000 ms — keep the
window visible and frontmost for the whole run. And `performance_start_trace`
only writes a file if you pass `filePath` to `performance_stop_trace`, and the
path must be inside the repo.

Checklist, once per scenario:

1. Close every other app tab. One WebGL tab, or the GPU process is shared and
   the run is fiction.
2. `new_page` → `http://localhost:5656/?auto=planetarium&smooth=1&tiles=http://localhost:5622/`
   (add `&envelope=200` for the squeeze scenario). For the phone scenarios,
   `resize_page` to 430×932 first; `emulate` for CPU throttling if you want the
   slower profile too.
3. `evaluate_script`: clear the storage the app boots from —
   `localStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage')` —
   then reload. A stale "Welcome back" prompt darkens every frame and reads as
   a rendering fault.
4. `wait_for` the loading screen to go, then `evaluate_script` →
   `window.__moon.smoothMark('reveal')`.
5. `performance_start_trace` with `reload: false`, `autoStop: false`.
6. Drive the scenario with `evaluate_script` calls on `window.__moon`, exactly
   as the battery's scenario list does — `travelTo`, `jumpTo`, `setTimeRate`,
   and `press_key` for the throttle and yaw holds. Call
   `window.__moon.smoothMark('<phase>')` at each phase boundary so the trace
   and the frame record can be lined up afterwards.
7. `performance_stop_trace` with a `filePath` inside the repo.
8. `evaluate_script` → `JSON.stringify(window.__moon.smoothStop())` and save it
   next to the trace. This is the record that carries the causes; the Chrome
   trace is what carries the stacks.
9. `performance_analyze_insight` for each insight Chrome offers, and read the
   trace with `planning/perf-traces/trace-summary.mjs <trace.json> localhost`
   for main-thread busy time and the `plm:*` user-timing marks.

Score it with the same rule. Chrome's own long-task and layout-shift insights
are extra evidence, not the verdict — the verdict is the frame record.

### Reading a FAIL

Every failing scenario prints its worst ten frames with the causes that fired
on them. Read them together with the notes in the JSON:

- worst frames tagged `upload` with a big `durationMs` → the warm pump paid an
  unsliceable map on a frame the veil was not covering. The map's name and
  pixel size are in the event.
- tagged `tile` → a sector mesh was built on that frame. Check
  `tileMaterializations` against `tileReleases`: churn means the working set is
  flapping, not that one tile was expensive.
- tagged `rung` → a tier swapped onto a material, which forces a shader
  recompile if the define set changed.
- no cause at all → it is not texture or tile work. Go to oracle 2 for the
  stack, and consider that some stutters leave the frame time alone entirely
  (a per-frame position quantisation looks perfect here and terrible on
  screen; `tools/stutter-probe.mjs` is the instrument for that class).
