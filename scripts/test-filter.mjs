#!/usr/bin/env node
// Does pi actually honour the filter we write?
//
// Everything else in this package is downstream of one assumption: that writing
// a `skills` array into settings.json makes pi load fewer skills, in the exact
// way we predict. That assumption was originally read out of pi's source. This
// runs it against the real `DefaultPackageManager` instead.
//
// It also pins the two edge cases `applyPlanToEntry` exists to handle, which are
// the difference between "load ten skills" and "load none" / "load all 157":
//
//   []              → 0 enabled   ("none" is expressible ONLY by an empty array)
//   ["!scanpy"]     → 156 enabled (overrides alone INVERT to "everything minus")
//
// Note `resolve()` returns every skill with an `enabled` flag rather than a
// filtered list, so `.length` proves nothing — only the `enabled` count does.
//
// Usage: node scripts/test-filter.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDist, loadExtensionModule } from "./lib/load-extension.mjs";

// Not a skip: every suite in this package loads the extension through pi's own
// jiti, so an installed pi is a hard prerequisite for `npm test` and pretending
// otherwise would report a green run that checked nothing.
const piDist = findPiDist();
if (!piDist) {
  console.error("FAIL: pi is not on PATH and PI_DIST is unset — its filter behaviour cannot be checked.");
  process.exit(1);
}

const { DefaultPackageManager } = await import(
  pathToFileURL(join(piDist, "core", "package-manager.js")).href
);

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const scratch = [];
const failures = [];

const check = (label, actual, expected) => {
  if (actual === expected) {
    console.log(`  ok      ${label} → ${actual} enabled`);
  } else {
    failures.push(`${label}: expected ${expected} enabled, got ${actual}`);
    console.log(`  FAIL    ${label} → ${actual} enabled, expected ${expected}`);
  }
};

/**
 * Count skills pi would actually load, given a `skills` filter.
 *
 * The repo root doubles as the package source: this is a local-path install,
 * the same shape as `pi install <path>`. Only the settings-manager surface
 * `resolve()` touches is stubbed — package resolution and pattern matching are
 * pi's own, unmodified.
 *
 * @param {string[] | null} patterns null = no filter at all (the string form)
 */
const enabledCount = async (patterns) => {
  const cwd = mkdtempSync(join(tmpdir(), "sci-filter-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sci-filter-agent-"));
  scratch.push(cwd, agentDir);

  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: {
      getGlobalSettings: () => ({
        packages: [patterns === null ? ROOT : { source: ROOT, skills: patterns }],
      }),
      getProjectSettings: () => ({}),
      // cwd is an empty temp dir; untrusted keeps auto-discovery out of the count.
      isProjectTrusted: () => false,
    },
  });

  const resolved = await manager.resolve();
  return resolved.skills.filter((skill) => skill.enabled).length;
};

const profiles = await loadExtensionModule("extensions/profiles.ts");
const core = profiles.PROFILES.find((profile) => profile.id === "core");
if (!core) {
  console.error("FAIL: no 'core' profile to test against");
  process.exit(1);
}
const CORE = [...core.skills];

console.log("-- pi's own resolver --");

// Compare against the constant the extension quotes to users, so a skills/
// sync that changes the count fails here instead of silently making /sci lie.
const baseline = await enabledCount(null);
check("no filter (today's default)", baseline, profiles.TOTAL_SKILL_COUNT);

check("Core profile", await enabledCount(CORE), CORE.length);

check(
  "Core + an override naming a skill outside it",
  await enabledCount([...CORE, "!scanpy"]),
  CORE.length,
);

check(
  "Core + an override naming a skill inside it",
  await enabledCount([...CORE, "!statistical-analysis"]),
  CORE.length - 1,
);

// The footgun, from both sides. `applyPlanToEntry` is written the way it is
// solely because of these two lines.
check("empty array — the only way to say 'none'", await enabledCount([]), 0);
check("overrides alone — inverts to 'everything minus'", await enabledCount(["!scanpy"]), baseline - 1);

// Patterns are globs, so counting the array is not counting the skills. This is
// why `/sci status` refuses to report a number for a hand-written filter.
const globbed = await enabledCount(["sc*"]);
if (globbed > 1) {
  console.log(`  ok      one glob pattern is not one skill → ${globbed} enabled`);
} else {
  failures.push(`glob "sc*" enabled ${globbed} skills; expected more than 1`);
  console.log(`  FAIL    one glob pattern is not one skill → ${globbed} enabled`);
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
