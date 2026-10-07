#!/bin/bash
# Two-arm live search test through a cloud model: the same probes through two
# package commits, both arms at the same time.
#
# Arms (all through scripts/test-find-live.mjs, supervised mode, no skill in
# the prompt, extension loaded):
#   old   the --old-ref package with PI_SCI_FIND_RANKER=--old-ranker.
#   new   the --new-ref package with PI_SCI_FIND_RANKER=--new-ranker.
# A package after 1.8.0 ignores PI_SCI_FIND_RANKER and ranks with bm25f.
#
# Frozen sources: at the first start, both refs are `git archive`d into
# <out>/src/, and every invocation runs from there (the harness and the probes
# from src/new). An edit to the working tree during the run cannot change an
# arm. <out>/sources.txt records the commits.
#
# Probes: one file per paraphrase style (scripts/find-probes-styled.mjs), in
# <out>/probes-<style>.json. The probe ids are shuffled once with a fixed seed
# and cut into chunks of --chunk-size ids; a chunk holds every style of its ids
# (<out>/order.tsv: chunk, style, id). All invocations of a chunk (arm × style)
# start together and the next chunk starts when all have ended, so the two
# arms of a probe meet the same provider routing and load, and a run stopped
# at a chunk boundary leaves a paired sample.
#
# A chunk whose units all have a result in both arms is skipped, so a second
# pass (run at the end, and on any restart with the same --out) retries only
# the chunks with a harness error (no-run, supervisor-error). The run aborts
# when a chunk ends with --max-harness-errors or more harness errors, a harness
# preflight fails, or the harness exits 2 or more. It runs under `caffeinate`.
#
# Usage:
#   scripts/find-ab.sh --out <dir> [options]
#
#   --out <dir>            Results, logs, archives and frozen sources. Required.
#   --model <id>           Default openrouter/google/gemma-4-26b-a4b-it.
#   --models-json <file>   Passed to the harness (sampling settings, a provider).
#   --old-ref <rev>        Default 0a8ddfd (before the search change).
#   --new-ref <rev>        Default HEAD.
#   --old-ranker <name>    Default current.
#   --new-ranker <name>    Default bm25f.
#   --styles <a,b>         Default plain,expert.
#   --chunk-size <n>       Probe ids per chunk. Default 10.
#   --seed <n>             Shuffle seed. Default 20260929.
#   --max-chunks <n>       Stop after this many chunks in this invocation.
#   --only <a,b,...>       Run just these probe ids as one chunk (a smoke test).
#   --gate-calls <n>       Default 10.
#   --timeout <s>          Per response. Default 300.
#   --max-harness-errors <n>  Per chunk. Default 3.
#
# Exit codes: 0 done or stopped on schedule, 1 aborted, 2 bad arguments.
set -euo pipefail

if [ -z "${FIND_LIVE_CAFFEINATED:-}" ] && command -v caffeinate > /dev/null; then
  export FIND_LIVE_CAFFEINATED=1
  exec caffeinate -dimsu "$0" "$@"
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="" MODEL="openrouter/google/gemma-4-26b-a4b-it" MODELS_JSON=""
OLD_REF="0a8ddfd" NEW_REF="HEAD" OLD_RANKER="current" NEW_RANKER="bm25f"
STYLES="plain,expert" CHUNK_SIZE=10 SEED=20260929 MAX_CHUNKS=0 ONLY=""
GATE=10 TIMEOUT=300 MAX_ERRORS=3
ARMS=(old new)

usage() { echo "error: $1" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    --models-json) MODELS_JSON="${2:?}"; shift 2 ;;
    --old-ref) OLD_REF="${2:?}"; shift 2 ;;
    --new-ref) NEW_REF="${2:?}"; shift 2 ;;
    --old-ranker) OLD_RANKER="${2:?}"; shift 2 ;;
    --new-ranker) NEW_RANKER="${2:?}"; shift 2 ;;
    --styles) STYLES="${2:?}"; shift 2 ;;
    --chunk-size) CHUNK_SIZE="${2:?}"; shift 2 ;;
    --seed) SEED="${2:?}"; shift 2 ;;
    --max-chunks) MAX_CHUNKS="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --gate-calls) GATE="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    --max-harness-errors) MAX_ERRORS="${2:?}"; shift 2 ;;
    *) usage "unknown option $1" ;;
  esac
done
[ -n "$OUT" ] || usage "--out is required"
[ -z "$MODELS_JSON" ] || [ -f "$MODELS_JSON" ] || usage "--models-json: $MODELS_JSON not found"
[ -z "$MODELS_JSON" ] || MODELS_JSON="$(cd "$(dirname "$MODELS_JSON")" && pwd)/$(basename "$MODELS_JSON")"
IFS=',' read -r -a STYLE_LIST <<< "$STYLES"

mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd)"
# Raw transcripts embed local paths and never belong in git.
[ -f "$OUT/.gitignore" ] || printf '*\n' > "$OUT/.gitignore"
LOG="$OUT/driver.log"
say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

# ---------------------------------------------------------------- sources
SRC="$OUT/src"
if [ ! -d "$SRC" ]; then
  old_sha="$(git -C "$REPO" rev-parse --verify "$OLD_REF^{commit}")"
  new_sha="$(git -C "$REPO" rev-parse --verify "$NEW_REF^{commit}")"
  if [ -n "$(git -C "$REPO" status --porcelain)" ] && [ "$NEW_REF" = "HEAD" ]; then
    say "note: the working tree has uncommitted changes; they are NOT in this run (it uses $new_sha)"
  fi
  mkdir -p "$SRC/old" "$SRC/new"
  git -C "$REPO" archive "$old_sha" | tar -x -C "$SRC/old"
  git -C "$REPO" archive "$new_sha" | tar -x -C "$SRC/new"
  {
    echo "old: $old_sha ($(git -C "$REPO" log -1 --format=%s "$old_sha")) ranker $OLD_RANKER"
    echo "new: $new_sha ($(git -C "$REPO" log -1 --format=%s "$new_sha")) ranker $NEW_RANKER"
  } > "$OUT/sources.txt"
fi
HARNESS="$SRC/new/scripts/test-find-live.mjs"
label() { echo "$(node -p "require('$SRC/$1/package.json').version")@$(sed -n "s/^$1: \([0-9a-f]\{7\}\).*/\1/p" "$OUT/sources.txt")"; }
OLD_LABEL="$(label old)"
NEW_LABEL="$(label new)"

# ---------------------------------------------------------------- probes and order
for style in "${STYLE_LIST[@]}"; do
  [ -f "$OUT/probes-$style.json" ] ||
    node "$SRC/new/scripts/find-probes-styled.mjs" "$style" -o "$OUT/probes-$style.json" 2>> "$LOG" ||
    usage "no probes for style $style"
done
ORDER="$OUT/order.tsv"
[ -z "$ONLY" ] || ORDER="$OUT/order-only.tsv"
if [ -n "$ONLY" ] || [ ! -f "$ORDER" ]; then
  node --input-type=module - "$OUT" "$SEED" "$CHUNK_SIZE" "$ONLY" "${STYLE_LIST[@]}" > "$ORDER" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [out, seedText, sizeText, only, ...styles] = process.argv.slice(2);
const testable = (style) =>
  new Set(JSON.parse(readFileSync(join(out, `probes-${style}.json`), "utf8")).filter((p) => !p.untestable).map((p) => p.skill));
const byStyle = new Map(styles.map((style) => [style, testable(style)]));
let ids = [...new Set(styles.flatMap((style) => [...byStyle.get(style)]))].sort();
if (only) ids = only.split(",").filter((id) => ids.includes(id));
else {
  // mulberry32: a fixed, portable shuffle for a given seed.
  let state = Number(seedText) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
}
const size = only ? ids.length : Number(sizeText);
const lines = [];
ids.forEach((id, index) => {
  for (const style of styles) if (byStyle.get(style).has(id)) lines.push(`${1 + Math.floor(index / size)}\t${style}\t${id}`);
});
console.log(lines.join("\n"));
EOF
fi
[ -s "$ORDER" ] || usage "no probe to run"
CHUNKS="$(cut -f1 "$ORDER" | sort -n | uniq | tr '\n' ' ')"

# ---------------------------------------------------------------- run
PIDS=()
on_signal() {
  say "interrupted"
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -TERM "$pid" 2> /dev/null || true; done
  wait 2> /dev/null || true
  exit 1
}
trap on_signal INT TERM

arm_args() {
  case "$1" in
    old) ARM_ARGS=(--package-dir "$SRC/old" --package-label "$OLD_LABEL" --find-ranker "$OLD_RANKER") ;;
    new) ARM_ARGS=(--package-dir "$SRC/new" --package-label "$NEW_LABEL" --find-ranker "$NEW_RANKER") ;;
  esac
  [ -z "$MODELS_JSON" ] || ARM_ARGS+=(--models-json "$MODELS_JSON")
}
lines_in() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
ids_of() { awk -F '\t' -v c="$1" -v s="$2" '$1 == c && $2 == s { print $3 }' "$ORDER" | paste -sd, -; }

# Units of a chunk with no usable result (missing, or a harness error as the last line) in either arm.
pending_in() {
  node --input-type=module - "$OUT" "$ORDER" "$1" "${ARMS[@]}" <<'EOF'
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [out, order, chunk, ...arms] = process.argv.slice(2);
const units = readFileSync(order, "utf8").split("\n").filter(Boolean).map((line) => line.split("\t")).filter(([c]) => c === chunk);
const last = new Map();
for (const arm of arms)
  for (const [, style] of units) {
    const file = join(out, `results-${arm}-${style}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      last.set(`${arm}/${style}/${row.id}`, row.outcome);
    }
  }
const bad = (outcome) => outcome === undefined || outcome === "no-run" || outcome === "supervisor-error";
console.log(units.filter(([, style, id]) => arms.some((arm) => bad(last.get(`${arm}/${style}/${id}`)))).length);
EOF
}

# Harness errors among the lines appended to a results file after line `from`.
errors_after() {
  [ -f "$1" ] || { echo 0; return; }
  tail -n +"$(($2 + 1))" "$1" |
    node -e 'let n = 0; require("readline").createInterface({ input: process.stdin }).on("line", (l) => { try { if (["no-run", "supervisor-error"].includes(JSON.parse(l).outcome)) n++; } catch {} }).on("close", () => console.log(n))'
}

run_chunk() {
  local chunk="$1" tag stamp started errors=0 failed=0
  tag="$(printf 'chunk-%02d' "$chunk")"
  stamp="$(date +%s)"
  started="$stamp"
  PIDS=()
  local labels=() befores=()
  for style in "${STYLE_LIST[@]}"; do
    local ids
    ids="$(ids_of "$chunk" "$style")"
    [ -n "$ids" ] || continue
    for arm in "${ARMS[@]}"; do
      local results="$OUT/results-$arm-$style.jsonl"
      arm_args "$arm"
      befores+=("$(lines_in "$results")")
      labels+=("$arm $style")
      node "$HARNESS" --probes "$OUT/probes-$style.json" --model "$MODEL" --thinking medium \
        --attempts 1 --responses 5 --timeout "$TIMEOUT" --gate-calls "$GATE" \
        --endpoint read "${ARM_ARGS[@]}" \
        --only "$ids" --results "$results" --resume \
        --archive-to "$OUT/archive/$arm-$style/$tag-$stamp" \
        > "$OUT/logs/$tag-$arm-$style-$stamp.log" 2>&1 &
      PIDS+=($!)
    done
  done
  say "START $tag (${#PIDS[@]} invocations)"
  local i rc
  for i in "${!PIDS[@]}"; do
    wait "${PIDS[$i]}" && rc=0 || rc=$?
    local arm="${labels[$i]% *}" style="${labels[$i]#* }"
    local results="$OUT/results-$arm-$style.jsonl"
    local added=$(($(lines_in "$results") - ${befores[$i]}))
    local errs
    errs="$(errors_after "$results" "${befores[$i]}")"
    errors=$((errors + errs))
    say "  $tag $arm $style rc=$rc lines=+$added harness-errors=$errs"
    # A preflight failure (the persona did not answer) exits 1 and writes no line.
    if [ "$rc" -ge 2 ] || { [ "$rc" -eq 1 ] && [ "$added" -eq 0 ]; }; then failed=1; fi
  done
  PIDS=()
  say "END   $tag $((($(date +%s) - started) / 60)) min, harness errors $errors"
  if [ "$failed" = 1 ]; then
    say "a harness invocation failed (exit >= 2, or a preflight failure); see logs/$tag-*-$stamp.log"
    return 1
  fi
  if [ "$errors" -ge "$MAX_ERRORS" ]; then
    say "$errors harness errors in $tag; see logs/$tag-*-$stamp.log"
    return 1
  fi
}

say "run: model $MODEL | styles $STYLES | chunks $CHUNKS| gate $GATE | timeout $TIMEOUT s | old $OLD_LABEL ($OLD_RANKER) | new $NEW_LABEL ($NEW_RANKER)"
RUN_START="$(date +%s)"
DONE_CHUNKS=0
for pass in 1 2; do
  for chunk in $CHUNKS; do
    if [ "$MAX_CHUNKS" -gt 0 ] && [ "$DONE_CHUNKS" -ge "$MAX_CHUNKS" ]; then
      say "stopping: --max-chunks $MAX_CHUNKS reached"
      say "DONE"
      exit 0
    fi
    [ "$(pending_in "$chunk")" -gt 0 ] || continue
    [ "$pass" = 1 ] || say "pass 2: retrying chunk $chunk"
    run_chunk "$chunk" || { say "ABORTED"; exit 1; }
    DONE_CHUNKS=$((DONE_CHUNKS + 1))
    say "run elapsed $((($(date +%s) - RUN_START) / 60)) min"
  done
done
say "DONE"
