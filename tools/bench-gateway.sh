#!/usr/bin/env bash
# ---------------------------------------------------------------------
# Gateway per-stream throughput benchmark  (macOS / BSD-userland port)
#
# Measures OUTPUT tokens/second delivered through the internal models-gateway
# using the real Claude Code client in headless mode (`claude -p`). Because it
# uses the same client, it needs NO manual auth/header handling -- it exercises
# exactly the path a developer hits.
#
# It reports:
#   1. baseline per-stream rate (concurrency 1)
#   2. per-stream rate under concurrency N (separate parallel processes)
#      -> if (2) ~= (1), the gateway scales and the bottleneck is the FIXED
#         per-stream rate, not contention.
#
# Metric: uses `duration_api_ms` from the result event (pure API time, excludes
# client/node startup), so the number reflects the gateway + model, not the CLI.
#
# Usage:
#   bash bench-gateway.sh
#   MODELS="opus sonnet" CONC=5 NLINES=150 bash bench-gateway.sh
#
# A/B the gateway vs a direct endpoint by pointing the client elsewhere:
#   ANTHROPIC_BASE_URL=https://api.anthropic.com/ ANTHROPIC_API_KEY=sk-... bash bench-gateway.sh
#
# macOS notes (differences from the Windows/Git-Bash original):
#   - macOS has no GNU `timeout`. We use `gtimeout` (brew install coreutils)
#     when present, else GNU `timeout`, else a portable bash watchdog.
#   - Stock macOS bash is 3.2; this script stays 3.2-compatible (no arrays,
#     no `wait -n`, no associative arrays, no ${var^^}).
#   - awk is BSD awk here; only POSIX printf/-v features are used.
# ---------------------------------------------------------------------
set -uo pipefail

MODELS="${MODELS:-opus sonnet}"
CONC="${CONC:-5}"
NLINES="${NLINES:-150}"
REQ_TIMEOUT="${REQ_TIMEOUT:-300}"
OUTDIR="$(mktemp -d)"
trap 'rm -rf "$OUTDIR"' EXIT

# Fixed, mechanical task -> ~identical output size every run, ~zero model
# "thinking", so we measure raw token delivery rate rather than reasoning volume.
PROMPT="Output exactly ${NLINES} lines and nothing else; line N must be exactly: N: the quick brown fox jumps over the lazy dog  (for N from 1 to ${NLINES})."

# --- portable per-request timeout -------------------------------------
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  TIMEOUT_CMD=""
fi

# Fallback watchdog for stock macOS (no coreutils): run the command in the
# background, poll for completion, kill it if it overruns.
run_with_watchdog() { # $1=seconds  $2...=command
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  local waited=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 2
      kill -KILL "$cmd_pid" 2>/dev/null
      wait "$cmd_pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$cmd_pid" 2>/dev/null
}

# Extract (output_tokens, duration_api_ms) from a claude -p json result,
# tolerating any non-JSON startup banner the launcher prints before the JSON.
parse() {
  python3 - "$1" <<'PY'
import json, sys
raw = open(sys.argv[1], errors="ignore").read()
idx = [x for x in (raw.find("["), raw.find("{")) if x >= 0]
js = raw[min(idx):] if idx else raw
try:
    data = json.loads(js)
except Exception:
    data = [json.loads(l) for l in js.splitlines() if l.strip().startswith("{")]
if isinstance(data, dict):
    data = [data]
res = [e for e in data if isinstance(e, dict) and e.get("type") == "result"] or data
e = res[-1] if res else {}
print(e.get("usage", {}).get("output_tokens", 0), e.get("duration_api_ms", 0))
PY
}

run_one() { # $1=model  $2=outfile
  if [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$REQ_TIMEOUT" claude -p "$PROMPT" --output-format json --model "$1" < /dev/null > "$2" 2>/dev/null
  else
    run_with_watchdog "$REQ_TIMEOUT" claude -p "$PROMPT" --output-format json --model "$1" < /dev/null > "$2" 2>/dev/null
  fi
}

row() { # $1=label  $2=outfile
  local r ot ms
  r=$(parse "$2"); ot=${r% *}; ms=${r#* }
  awk -v l="$1" -v ot="$ot" -v ms="$ms" \
    'BEGIN{printf "  %-14s out=%-6s api=%6.1fs  %6.0f tok/s\n", l, ot, ms/1000, (ms>0?ot/(ms/1000):0)}'
}

echo "=============================================================="
echo " Gateway per-stream throughput benchmark"
echo "  endpoint : ${ANTHROPIC_BASE_URL:-<client default>}"
echo "  models   : $MODELS"
echo "  task     : generate $NLINES fixed lines (mechanical, ~no thinking)"
echo "  concurrency tested: 1 (baseline) and $CONC (parallel processes)"
echo "  timeout  : ${TIMEOUT_CMD:-bash-watchdog} ${REQ_TIMEOUT}s"
echo "=============================================================="
echo

echo "--- baseline: 1 request at a time ---"
for m in $MODELS; do
  run_one "$m" "$OUTDIR/base_$m.json"
  row "$m" "$OUTDIR/base_$m.json"
done
echo

for m in $MODELS; do
  echo "--- $m: $CONC requests in parallel (separate processes) ---"
  pids=""
  for i in $(seq 1 "$CONC"); do
    run_one "$m" "$OUTDIR/conc_${m}_$i.json" &
    pids="$pids $!"
  done
  wait $pids
  for i in $(seq 1 "$CONC"); do
    row "#$i" "$OUTDIR/conc_${m}_$i.json"
  done
  echo
done

echo "Read: if per-stream tok/s at concurrency $CONC ~= baseline, the gateway scales"
echo "cleanly (no per-account throttle) and the limit is the fixed per-stream rate."
echo "Compare that rate against a direct api.anthropic.com run to size the gateway tax."
