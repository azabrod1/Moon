# The smoothness gate

Two oracles answer the same question — *did any frame arrive late, and what was
happening on it* — and they disagree in useful ways. The headless battery is
the one you run every time; real Chrome through the chrome-devtools MCP is the
one you run when the battery says FAIL and you need to see the stack.

The rule both oracles score against, per scenario:

> **PASS** when, after the loading screen is gone and outside the arrival
> veil's sanctioned cuts, no frame took more than **33 ms** (two vsyncs at
> 60 Hz), **p99 ≤ 20 ms**, and no **long task ran past 50 ms**.
> Otherwise **FAIL**, naming the frames and what fired on them.

Frames under the arrival veil are counted and reported but not scored: the veil
is an opaque cover the app raises on purpose, and the point of separating them
is to see a hitch that merely *hid* behind a cut rather than to forgive it.

A note on the machine: on a 120 Hz display the median gap is 8.3 ms, so a 33 ms
budget is four vsyncs there, not two. The threshold is stated in milliseconds
because that is what a person feels; read the reported p50 to know how many
refreshes it is on the machine that produced a run.

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

Before you start: `ps aux | grep -i chrom | grep -v grep`. A KTX2 encode or
another builder's Playwright run will be sharing the GPU, and the numbers are
then meaningless — wait for it. The battery runs one browser, one tab, and
closes each context before opening the next, for the same reason. It refuses to
run at all if the renderer string says SwiftShader.

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
