#!/bin/bash
# First sci_find queries of one query writer, for the ranker's writer panel
# (testing/runs/2026-09-27-find-ranker.md, step 3). Each style is one
# invocation of scripts/test-find-live.mjs with --endpoint first-find: the
# attempt stops at the model's first sci_find call and records its query.
#
# Styles: original (testing/find-probes.json) or a paraphrase style from
# testing/find-rank/paraphrases.json (synonym, plain, expert), in the order
# given. Results: <out>/results-<writer>-<style>.jsonl. Run it again with the
# same --out to continue: finished probes are skipped (--resume).
#
# Frozen sources: at the first start, --ref is `git archive`d into <out>/src/
# and every invocation runs from there. <out>/sources.txt records the commit.
# The model server is not started here; for a local writer, --health-url must
# answer before each style. Runs under `caffeinate`.
#
# Usage:
#   scripts/find-panel.sh --out <dir> --writer <label> --model <id> [options]
#
#   --styles <a,b>        Default plain,synonym,expert.
#   --health-url <url>    Checked before each style (local writers). Default none.
#   --models-json <file>  Passed through to the harness.
#   --thinking <level>    Default medium.
#   --ref <rev>           Default HEAD.
#   --only <a,b>          Just these probes (a smoke test).
#   --gate-calls <n>      Default 10.
#   --timeout <s>         Per response. Default 600.
#
# Exit codes: 0 done, 1 a style did not finish (harness errors or no server),
# 2 bad arguments.
set -euo pipefail

if [ -z "${FIND_LIVE_CAFFEINATED:-}" ] && command -v caffeinate > /dev/null; then
  export FIND_LIVE_CAFFEINATED=1
  exec caffeinate -dimsu "$0" "$@"
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="" WRITER="" MODEL="" STYLES="plain,synonym,expert" HEALTH="" MODELS_JSON="" THINKING="medium"
REF="HEAD" ONLY="" GATE=10 TIMEOUT=600

usage() { echo "error: $1" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?}"; shift 2 ;;
    --writer) WRITER="${2:?}"; shift 2 ;;
    --model) MODEL="${2:?}"; shift 2 ;;
    --styles) STYLES="${2:?}"; shift 2 ;;
    --health-url) HEALTH="${2:?}"; shift 2 ;;
    --models-json) MODELS_JSON="${2:?}"; shift 2 ;;
    --thinking) THINKING="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --gate-calls) GATE="${2:?}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?}"; shift 2 ;;
    *) usage "unknown option $1" ;;
  esac
done
[ -n "$OUT" ] || usage "--out is required"
[ -n "$WRITER" ] || usage "--writer is required"
[ -n "$MODEL" ] || usage "--model is required"
for style in ${STYLES//,/ }; do
  case "$style" in original | synonym | plain | expert) ;; *) usage "unknown style $style" ;; esac
done
[ -z "$MODELS_JSON" ] || [ -f "$MODELS_JSON" ] || usage "no models.json at $MODELS_JSON"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# Raw transcripts embed local paths and never belong in git.
[ -f "$OUT/.gitignore" ] || printf '*\n' > "$OUT/.gitignore"
LOG="$OUT/driver.log"
say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG" >&2; }

SRC="$OUT/src"
if [ ! -d "$SRC" ]; then
  sha="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
  if [ -n "$(git -C "$REPO" status --porcelain)" ] && [ "$REF" = "HEAD" ]; then
    say "note: the working tree has uncommitted changes; they are NOT in this run (it uses $sha)"
  fi
  mkdir -p "$SRC"
  git -C "$REPO" archive "$sha" | tar -x -C "$SRC"
  echo "$sha ($(git -C "$REPO" log -1 --format=%s "$sha"))" > "$OUT/sources.txt"
fi
LABEL="$(node -p "require('$SRC/package.json').version")@$(cut -c1-7 "$OUT/sources.txt")"

CHILD_PID=""
on_signal() {
  say "interrupted"
  if [ -n "$CHILD_PID" ]; then
    kill -TERM "$CHILD_PID" 2> /dev/null || true
    wait "$CHILD_PID" 2> /dev/null || true
  fi
  exit 1
}
trap on_signal INT TERM

status=0
for style in ${STYLES//,/ }; do
  if [ -n "$HEALTH" ] && ! curl -sf --max-time 5 "$HEALTH" > /dev/null; then
    say "no server answers $HEALTH; stopping before $WRITER/$style"
    exit 1
  fi
  probes="$SRC/testing/find-probes.json"
  if [ "$style" != original ]; then
    probes="$OUT/probes-$style.json"
    [ -f "$probes" ] || node "$SRC/scripts/find-probes-styled.mjs" "$style" -o "$probes"
  fi
  args=(--probes "$probes" --model "$MODEL" --thinking "$THINKING" --endpoint first-find --attempts 1
    --responses 5 --gate-calls "$GATE" --timeout "$TIMEOUT" --package-label "$LABEL"
    --results "$OUT/results-$WRITER-$style.jsonl" --resume
    --archive-to "$OUT/archive/$WRITER-$style-$(date +%Y%m%d-%H%M%S)")
  [ -z "$MODELS_JSON" ] || args+=(--models-json "$MODELS_JSON")
  [ -z "$ONLY" ] || args+=(--only "$ONLY")
  say "START $WRITER $style ($MODEL)"
  set +e
  node "$SRC/scripts/test-find-live.mjs" "${args[@]}" >> "$OUT/harness-$WRITER-$style.log" 2>&1 &
  CHILD_PID=$!
  wait "$CHILD_PID"
  code=$?
  CHILD_PID=""
  set -e
  say "END $WRITER $style (exit $code)"
  # Exit 1 means a probe has no grade (a harness error); the rest still ran.
  if [ "$code" -ne 0 ]; then
    status=1
    [ "$code" -eq 2 ] && exit 2
  fi
done
exit "$status"
