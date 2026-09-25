#!/bin/bash
# Unattended multi-arm live search test: the same probes through several
# package configurations, one local model server, one probe at a time.
#
# Arms (all through scripts/test-find-live.mjs, supervised mode):
#   v16   the --v16-ref package (1.6.0), Core in the prompt, sci_find without
#         a prompt snippet: the 1.6.0 `/sci search` default.
#   v17   the --ref package, no skill in the prompt, sci_find listed: the
#         1.7.0 default.
#   full  the --ref package with its extension not loaded, every skill in the
#         prompt, no sci_find: a plain skills install.
#
# Frozen sources: at the first start, both refs are `git archive`d into
# <out>/src/, and every invocation runs from there. An edit to the working tree
# during the run cannot change an arm. <out>/sources.txt records the commits.
#
# Probes run in chunks (default 10): chunk 1 is the Core probes, then the rest
# in a fixed seeded shuffle (<out>/order.tsv). Each chunk runs every arm before
# the next chunk starts, with the arm order rotated per chunk, so a run stopped
# at any chunk boundary leaves a balanced, paired sample. Run it again with the
# same --out to continue: finished probes are skipped (--resume).
#
# The server is started from --server (a script that execs llama-server in the
# foreground), checked before every invocation, and restarted once if it died.
# The run aborts after --max-harness-errors harness errors in a row (no-run,
# supervisor-error), for example an expired `claude` login. It runs under
# `caffeinate` so the machine does not sleep.
#
# Usage:
#   scripts/find-live-arms.sh --out <dir> --server <start-script> [options]
#
#   --out <dir>            Results, logs, archives and frozen sources. Required.
#   --server <script>      Starts the model server in the foreground. Required
#                          unless --use-running-server.
#   --use-running-server   Use a server already answering --health-url; never
#                          start or stop one.
#   --health-url <url>     Default http://127.0.0.1:8090/health.
#   --model <id>           Default prism-llama/Ternary-Bonsai-2-27B-PQ2_0.
#   --ref <rev>            Package and harness for v17 and full. Default HEAD.
#   --v16-ref <rev>        Package for v16. Default 98cb371 (1.6.0).
#   --arms <a,b,c>         Default v16,v17,full.
#   --chunk-size <n>       Default 10.
#   --seed <n>             Shuffle seed. Default 20260925.
#   --max-chunks <n>       Stop after this many chunks in this invocation.
#   --stop-after <HH:MM>   Start no new chunk after this local time.
#   --only <a,b,...>       Run just these probes as one chunk (a smoke test).
#   --gate-calls <n>       Default 10.
#   --timeout <s>          Per response. Default 1200.
#   --max-harness-errors <n>  Default 3.
#
# Exit codes: 0 done or stopped on schedule, 1 aborted, 2 bad arguments.
set -euo pipefail

if [ -z "${FIND_LIVE_CAFFEINATED:-}" ] && command -v caffeinate > /dev/null; then
  export FIND_LIVE_CAFFEINATED=1
  exec caffeinate -dimsu "$0" "$@"
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="" SERVER="" USE_RUNNING=0 HEALTH="http://127.0.0.1:8090/health"
MODEL="prism-llama/Ternary-Bonsai-2-27B-PQ2_0" REF="HEAD" V16_REF="98cb371"
ARMS="v16,v17,full" CHUNK_SIZE=10 SEED=20260925 MAX_CHUNKS=0 STOP_AFTER="" ONLY=""
GATE=10 TIMEOUT=1200 MAX_ERRORS=3

usage() { echo "error: $1" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    --server) SERVER="${2:?}"; shift 2 ;;
    --use-running-server) USE_RUNNING=1; shift ;;
    --health-url) HEALTH="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --v16-ref) V16_REF="${2:?}"; shift 2 ;;
    --arms) ARMS="${2:?}"; shift 2 ;;
    --chunk-size) CHUNK_SIZE="${2:?}"; shift 2 ;;
    --seed) SEED="${2:?}"; shift 2 ;;
    --max-chunks) MAX_CHUNKS="${2:?}"; shift 2 ;;
    --stop-after) STOP_AFTER="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --gate-calls) GATE="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    --max-harness-errors) MAX_ERRORS="${2:?}"; shift 2 ;;
    *) usage "unknown option $1" ;;
  esac
done
[ -n "$OUT" ] || usage "--out is required"
[ "$USE_RUNNING" = 1 ] || [ -x "$SERVER" ] || usage "--server must be an executable script (or pass --use-running-server)"
STOP_EPOCH=0
if [ -n "$STOP_AFTER" ]; then
  STOP_EPOCH="$(date -j -f '%Y-%m-%d %H:%M' "$(date +%F) $STOP_AFTER" +%s 2> /dev/null)" || usage "--stop-after takes HH:MM"
  # A time already past today means tomorrow: a run started at 21:00 with --stop-after 07:30.
  [ "$STOP_EPOCH" -gt "$(date +%s)" ] || STOP_EPOCH=$((STOP_EPOCH + 86400))
fi

mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
# Raw transcripts embed local paths and never belong in git.
[ -f "$OUT/.gitignore" ] || printf '*\n' > "$OUT/.gitignore"
LOG="$OUT/driver.log"
say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

# ---------------------------------------------------------------- sources
SRC="$OUT/src"
if [ ! -d "$SRC" ]; then
  ref_sha="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
  v16_sha="$(git -C "$REPO" rev-parse --verify "$V16_REF^{commit}")"
  if [ -n "$(git -C "$REPO" status --porcelain)" ] && [ "$REF" = "HEAD" ]; then
    say "note: the working tree has uncommitted changes; they are NOT in this run (it uses $ref_sha)"
  fi
  mkdir -p "$SRC/v17" "$SRC/v16"
  git -C "$REPO" archive "$ref_sha" | tar -x -C "$SRC/v17"
  git -C "$REPO" archive "$v16_sha" | tar -x -C "$SRC/v16"
  {
    echo "v17 and full: $ref_sha ($(git -C "$REPO" log -1 --format=%s "$ref_sha"))"
    echo "v16: $v16_sha ($(git -C "$REPO" log -1 --format=%s "$v16_sha"))"
  } > "$OUT/sources.txt"
fi
HARNESS="$SRC/v17/scripts/test-find-live.mjs"
PROBES="$SRC/v17/testing/find-probes.json"
V16_LABEL="$(node -p "require('$SRC/v16/package.json').version")@$(sed -n 's/^v16: \([0-9a-f]\{7\}\).*/\1/p' "$OUT/sources.txt")"
V17_LABEL="$(node -p "require('$SRC/v17/package.json').version")@$(sed -n 's/^v17 and full: \([0-9a-f]\{7\}\).*/\1/p' "$OUT/sources.txt")"

# ---------------------------------------------------------------- order
ORDER="$OUT/order.tsv"
if [ -n "$ONLY" ]; then
  ORDER="$OUT/order-only.tsv"
  echo "$ONLY" | tr ',' '\n' | awk 'NF { print 1 "\t" $1 }' > "$ORDER"
elif [ ! -f "$ORDER" ]; then
  node --input-type=module - "$SRC/v17" "$SEED" "$CHUNK_SIZE" > "$ORDER" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, seedText, sizeText] = process.argv.slice(2);
const { PROFILES } = await import(pathToFileURL(join(root, "extensions", "profiles.ts")).href);
const core = new Set(PROFILES.find((profile) => profile.id === "core").skills);
const raw = JSON.parse(readFileSync(join(root, "testing", "find-probes.json"), "utf8"));
const ids = (Array.isArray(raw) ? raw : raw.probes).filter((probe) => !probe.untestable).map((probe) => probe.skill).sort();
// mulberry32: a fixed, portable shuffle for a given seed.
let state = Number(seedText) >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rest = ids.filter((id) => !core.has(id));
for (let i = rest.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [rest[i], rest[j]] = [rest[j], rest[i]];
}
const size = Number(sizeText);
const lines = ids.filter((id) => core.has(id)).map((id) => `1\t${id}`);
rest.forEach((id, index) => lines.push(`${2 + Math.floor(index / size)}\t${id}`));
console.log(lines.join("\n"));
EOF
fi
CHUNKS="$(cut -f1 "$ORDER" | sort -n | uniq | tr '\n' ' ')"

# ---------------------------------------------------------------- server
SERVER_PID=""
CHILD_PID=""
healthy() { curl -s --max-time 3 "$HEALTH" | grep -q '"ok"'; }
start_server() {
  [ "$USE_RUNNING" = 1 ] && return 0
  say "starting server: $SERVER"
  "$SERVER" >> "$OUT/llama-server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 90); do
    healthy && { say "server up (pid $SERVER_PID)"; return 0; }
    kill -0 "$SERVER_PID" 2> /dev/null || break
    sleep 2
  done
  say "server did not come up"
  return 1
}
stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2> /dev/null; then
    say "stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2> /dev/null || true
    wait "$SERVER_PID" 2> /dev/null || true
  fi
  SERVER_PID=""
}
on_signal() {
  say "interrupted"
  if [ -n "$CHILD_PID" ]; then
    kill -TERM "$CHILD_PID" 2> /dev/null || true
    wait "$CHILD_PID" 2> /dev/null || true
  fi
  exit 1
}
trap 'stop_server' EXIT
trap on_signal INT TERM

if [ "$USE_RUNNING" = 1 ]; then
  healthy || { say "no server answers $HEALTH"; exit 1; }
elif healthy; then
  say "a server already answers $HEALTH; stop it, or pass --use-running-server"
  exit 1
else
  start_server || exit 1
fi

# ---------------------------------------------------------------- arms
# Sets ARM_ARGS to the harness flags of one arm.
arm_args() {
  case "$1" in
    v16) ARM_ARGS=(--package-dir "$SRC/v16" --package-label "$V16_LABEL" --prompt-skills core) ;;
    v17) ARM_ARGS=(--package-dir "$SRC/v17" --package-label "$V17_LABEL" --prompt-skills none) ;;
    full) ARM_ARGS=(--package-dir "$SRC/v17" --package-label "$V17_LABEL" --prompt-skills all --no-extension) ;;
    *) usage "unknown arm $1" ;;
  esac
}
IFS=',' read -r -a ARM_LIST <<< "$ARMS"
for arm in "${ARM_LIST[@]}"; do arm_args "$arm"; done

ERRORS_IN_A_ROW=0
# Harness errors among the lines an invocation appended, in order.
count_errors() {
  local file="$1" from="$2"
  [ -f "$file" ] || return 0
  local outcome
  while IFS= read -r outcome; do
    if [ "$outcome" = "no-run" ] || [ "$outcome" = "supervisor-error" ]; then
      ERRORS_IN_A_ROW=$((ERRORS_IN_A_ROW + 1))
    else
      ERRORS_IN_A_ROW=0
    fi
  done < <(tail -n +"$((from + 1))" "$file" |
    node -e 'require("readline").createInterface({ input: process.stdin }).on("line", (l) => { try { console.log(JSON.parse(l).outcome); } catch {} })')
}
lines_in() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

run_arm() {
  local arm="$1" chunk="$2" ids="$3"
  local results="$OUT/results-$arm.jsonl" tag
  tag="$(printf 'chunk-%02d' "$chunk")"
  if ! healthy; then
    say "server not healthy before $tag $arm; restarting"
    stop_server
    start_server || return 1
  fi
  local before rc started
  before="$(lines_in "$results")"
  started="$(date +%s)"
  say "START $tag $arm $ids"
  arm_args "$arm"
  # In the background and waited on, so a signal to this script is handled at once.
  node "$HARNESS" --probes "$PROBES" --model "$MODEL" --thinking medium \
    --attempts 1 --responses 5 --timeout "$TIMEOUT" --gate-calls "$GATE" \
    --endpoint read --warmup "${ARM_ARGS[@]}" \
    --only "$ids" --results "$results" --resume \
    --archive-to "$OUT/archive/$arm/$tag" \
    > "$OUT/logs/$tag-$arm.log" 2>&1 &
  CHILD_PID=$!
  wait "$CHILD_PID" && rc=0 || rc=$?
  CHILD_PID=""
  local added=$(($(lines_in "$results") - before))
  count_errors "$results" "$before"
  # A preflight failure (the persona did not answer) exits 1 and writes no line.
  [ "$rc" -eq 1 ] && [ "$added" -eq 0 ] && ERRORS_IN_A_ROW=$((ERRORS_IN_A_ROW + 1))
  say "END   $tag $arm rc=$rc lines=+$added $((($(date +%s) - started) / 60)) min"
  if [ "$rc" -ge 2 ]; then
    say "harness exit $rc (usage error or crash); see logs/$tag-$arm.log"
    return 1
  fi
  if [ "$ERRORS_IN_A_ROW" -ge "$MAX_ERRORS" ]; then
    say "$ERRORS_IN_A_ROW harness errors in a row; see logs/$tag-$arm.log"
    return 1
  fi
}

# ---------------------------------------------------------------- run
say "run: arms $ARMS | chunks $CHUNKS| gate $GATE | timeout $TIMEOUT s | v16 $V16_LABEL | v17 $V17_LABEL"
RUN_START="$(date +%s)"
DONE_CHUNKS=0
for chunk in $CHUNKS; do
  if [ "$MAX_CHUNKS" -gt 0 ] && [ "$DONE_CHUNKS" -ge "$MAX_CHUNKS" ]; then
    say "stopping: --max-chunks $MAX_CHUNKS reached"
    break
  fi
  if [ "$STOP_EPOCH" -gt 0 ] && [ "$(date +%s)" -ge "$STOP_EPOCH" ]; then
    say "stopping: past --stop-after $STOP_AFTER"
    break
  fi
  ids="$(awk -F '\t' -v c="$chunk" '$1 == c { print $2 }' "$ORDER" | paste -sd, -)"
  count="${#ARM_LIST[@]}"
  shift_by=$(((chunk - 1) % count))
  chunk_start="$(date +%s)"
  timing=""
  for i in $(seq 0 $((count - 1))); do
    arm="${ARM_LIST[$(((i + shift_by) % count))]}"
    arm_start="$(date +%s)"
    run_arm "$arm" "$chunk" "$ids" || { say "ABORTED"; exit 1; }
    timing="$timing $arm $((($(date +%s) - arm_start) / 60))m"
  done
  DONE_CHUNKS=$((DONE_CHUNKS + 1))
  say "CHUNK $chunk done in $((($(date +%s) - chunk_start) / 60)) min ($timing ); run elapsed $((($(date +%s) - RUN_START) / 60)) min"
done
say "DONE"
