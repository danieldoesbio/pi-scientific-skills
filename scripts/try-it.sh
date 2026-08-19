#!/usr/bin/env bash
# Launch this branch in a throwaway pi, so the startup paths can be seen with
# human eyes before anything is published.
#
# ~/.pi/agent is never touched. The sandbox gets its own PI_CODING_AGENT_DIR —
# which also isolates auth, so auth.json and models-store.json are copied in at
# 0600 and deleted when pi exits, however it exits. Your model, theme and
# thinking-level preferences are copied across so the sandbox is usable; your
# other pi packages are not, because they would have to re-download and none of
# them is what we are testing.
#
# It runs the PACKED TARBALL, not the working tree: what you try is what ships.
#
# Usage: scripts/try-it.sh [scenario] [--keep]
#
#   mine       (default) your real pi-scientific-skills.json and your filter on
#              this package → the upgrade notice, which is the path you would
#              personally land on
#   new        nothing configured at all → the first-run offer dialog
#   upgrading  a 1.0.2 user with Genomics saved → upgrade notice; the filter
#              must come out byte-identical
#   filtered   hand-filtered, never ran /sci → "your filter is unchanged"
#   current    already told about 1.1.0 → startup says nothing
#
#   --keep     leave the sandbox in place and print the path (credentials are
#              still deleted)
#   --check    don't open the TUI: run pi headless, assert this scenario prints
#              the message it owes, and say PASS or FAIL. Costs one tiny model
#              call ($CHECK_MODEL, default deepseek/deepseek-v4-flash) because
#              pi will not start a turn without one.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
real="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
scenario="mine"
keep=""
check=""

for arg in "$@"; do
  case "$arg" in
    mine|new|upgrading|filtered|current) scenario="$arg" ;;
    --keep) keep=1 ;;
    --check) check=1 ;;
    *) echo "unknown argument: $arg" >&2; sed -n '15,27p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
  esac
done

[ -f "$real/auth.json" ] || { echo "no credentials at $real/auth.json — run pi and /login first" >&2; exit 1; }

scratch="$(mktemp -d "${TMPDIR:-/tmp}/sci-try-XXXXXX")"
agent="$scratch/agent"
project="$scratch/project"
mkdir -p "$agent" "$project"

# The credential copy goes even if this script dies, and even on Ctrl-C. The
# whole sandbox goes with it unless --keep, so a failure halfway through
# staging cannot quietly leave one behind.
cleanup() {
  rm -f "$agent/auth.json" "$agent/models-store.json"
  [ -n "$keep" ] || rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

cd "$root"
echo "packing this branch…"
tgz="$(cd "$root" && npm pack --silent --pack-destination "$scratch" | tail -1)"
tar xzf "$scratch/$tgz" -C "$scratch"
pkg="$scratch/pi-scientific-skills"
rm -rf "$pkg"
mv "$scratch/package" "$pkg"

for f in auth.json models-store.json; do
  [ -f "$real/$f" ] && install -m 600 "$real/$f" "$agent/$f"
done

REAL="$real" AGENT="$agent" PKG="$pkg" SCENARIO="$scenario" node --input-type=module - <<'NODE'
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionModule } from "./scripts/lib/load-extension.mjs";

const { REAL: real, AGENT: agent, PKG: pkg, SCENARIO: scenario } = process.env;

const read = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const realSettings = read(join(real, "settings.json"), {});
const realConfig = read(join(real, "pi-scientific-skills.json"), {});

// Model/theme preferences only. Your other packages are deliberately left out:
// they would have to re-download into the sandbox and none of them is under test.
const carried = ["theme", "defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels"];
const settings = Object.fromEntries(carried.filter((key) => key in realSettings).map((key) => [key, realSettings[key]]));

// Your real entry, so an empty `skills: []` — "none" — survives verbatim.
const mine = (realSettings.packages ?? []).find(
  (entry) => typeof entry === "object" && String(entry.source ?? "").includes("pi-scientific-skills"),
);

// A real profile, read from profiles.ts, so "upgrading" reproduces a filter
// /sci could actually have written rather than a plausible-looking invention.
const { PROFILES } = await loadExtensionModule("extensions/profiles.ts");
const saved = PROFILES.find((profile) => profile.id === "genomics-bioinformatics");
if (!saved) throw new Error("no 'genomics-bioinformatics' profile — profiles.ts has moved on; update this script");

const table = {
  mine: { entry: { ...(mine ?? {}), source: pkg }, config: realConfig },
  new: { entry: { source: pkg }, config: null },
  upgrading: {
    entry: { source: pkg, skills: [...saved.skills] },
    config: { version: 1, onboardingSeen: true, profiles: [saved.id], lastSeenVersion: "1.0.2" },
  },
  filtered: { entry: { source: pkg, skills: [...saved.skills] }, config: null },
  current: { entry: { source: pkg }, config: { version: 1, onboardingSeen: true, lastSeenVersion: "1.1.0" } },
};

const { entry, config } = table[scenario];
settings.packages = [entry];
writeFileSync(join(agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
if (config) writeFileSync(join(agent, "pi-scientific-skills.json"), `${JSON.stringify(config, null, 2)}\n`);

const filter = entry.skills;
console.log(
  `  filter seeded: ${filter === undefined ? "none (unfiltered)" : filter.length === 0 ? "[] — nothing loaded" : `${filter.length} skills (${saved.label ?? saved.id})`}`,
);
console.log(`  extension state: ${config ? JSON.stringify(config) : "none (fresh install)"}`);
NODE

cp "$agent/settings.json" "$scratch/settings.before.json"

cat <<BANNER

  sandbox : $agent
  package : $pkg  (from the tarball, not the working tree)
  scenario: $scenario

BANNER

case "$scenario" in
  mine)      echo "  expect: the upgrade notice — \"updated to 1.1.0 … your current selection is unchanged\"" ;;
  new)       echo "  expect: a dialog offering Core + search. Enter accepts, arrow-down + Enter declines," ;
             echo "          Esc or 20s of silence declines too. Only accepting may write anything." ;;
  upgrading) echo "  expect: the upgrade notice, and the saved profile still filtered afterwards" ;;
  filtered)  echo "  expect: \"your 'skills' filter is unchanged and /sci has not touched it\"" ;;
  current)   echo "  expect: nothing at all from us at startup" ;;
esac

if [ -z "$check" ]; then
cat <<'TRY'

  worth trying once inside:
    /sci status            what mode you are in, the real cost, and the /skill: caveat
    /sci find crispr       the human-facing search
    /sci profiles          the ten field profiles
    ask the model something whose skill is NOT loaded, e.g.
      "I have a 10x single-cell matrix and want to cluster it — what's here?"
    → it should call sci_find, then read the SKILL.md it names

  /exit when you are done; this script then reports whether your settings moved.

TRY
fi

cd "$project"

if [ -n "$check" ]; then
  # Headless. `report` falls back to stderr when no UI is bound, so the startup
  # message is capturable — which is the whole point: this asserts the branch
  # fired, without a human having to read a screenshot.
  out="$(PI_CODING_AGENT_DIR="$agent" pi --no-session -p "reply with the single word: ok" \
        --model "${CHECK_MODEL:-deepseek/deepseek-v4-flash}" 2>&1 || true)"
  case "$scenario" in
    mine)      want='updated to 1.1.0' ;;
    upgrading) want='updated to 1.1.0 (from 1.0.2)' ;;
    new)       want='Run "/sci search" to switch' ;;
    filtered)  want='filter is unchanged' ;;
    current)   want='' ;;   # this one owes nothing, so absence is the assertion
  esac
  printf '%s\n' "$out" | sed 's/^/  | /'
  echo
  if [ -z "$want" ]; then
    if printf '%s' "$out" | grep -q "pi-scientific-skills: all\|pi-scientific-skills updated\|filter is unchanged"; then
      echo "FAIL — said something at startup, and this scenario owes nothing"; exit 1
    fi
    echo "PASS — startup said nothing, as it should"
  elif printf '%s' "$out" | grep -qF "$want"; then
    echo "PASS — found: $want"
  else
    echo "FAIL — expected to find: $want"; exit 1
  fi
else
  PI_CODING_AGENT_DIR="$agent" pi || true
fi

echo
if cmp -s "$scratch/settings.before.json" "$agent/settings.json"; then
  echo "settings.json: unchanged, byte for byte"
else
  echo "settings.json changed:"
  diff -u "$scratch/settings.before.json" "$agent/settings.json" | sed 's/^/  /' || true
fi
echo "extension state now: $(cat "$agent/pi-scientific-skills.json" 2>/dev/null | tr -d '\n ' || echo none)"

cleanup
[ -n "$keep" ] && echo && echo "sandbox kept (credentials removed): $scratch"
exit 0
