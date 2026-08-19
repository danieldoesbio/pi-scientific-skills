#!/usr/bin/env node
// Validate all skills against pi's Agent Skills rules (docs/skills.md), and
// validate extensions/ against what is actually on disk and in package.json.
//
// Warnings are acceptable (pi loads leniently); a MISSING description is a hard
// failure because pi refuses to load such skills. A profiles.ts that disagrees
// with skills/ is also a hard failure: sync-upstream.sh replaces skills/
// wholesale, and nothing else notices when a release adds, removes or renames a
// skill — leaving /sci quoting stale token counts and stranding new skills in no
// profile, silently, for every user who has applied one.
//
// Requires Node >= 22.18 (native TypeScript type stripping) to read the .ts
// modules under extensions/. Deliberately does NOT require pi: this is the
// pre-publish gate and must run anywhere, unlike the test suites.
//
// Usage: node scripts/validate.mjs  (or: npm run validate)
// Exit codes: 0 = OK, 1 = hard failure, 2 = usage error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");

// The parser is shared with `search.ts`, which reads the same frontmatter at
// runtime to build the sci_find catalogue. Two copies would drift, and the
// drift would be invisible: validation would pass on files the runtime read
// differently. Importing it here also exercises it against all 157 real
// SKILL.md files on every release, including the block-scalar cases it exists
// for.
const { parseFrontmatter } = await import(
  pathToFileURL(join(root, "extensions", "frontmatter.ts")).href
).catch((error) => {
  console.error(`FAIL: cannot import extensions/frontmatter.ts (${error?.message ?? error}).`);
  console.error("Node >= 22.18 is required to strip TypeScript types.");
  process.exit(1);
});

function collectSkills(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!statSync(p).isDirectory()) continue;
    const skillMd = join(p, "SKILL.md");
    try {
      statSync(skillMd);
      out.push({ name: entry, path: skillMd });
    } catch {
      /* not a skill dir */
    }
  }
  return out;
}

const nameRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const problems = { hard: [], warn: [] };
let count = 0;
/** Chars of name + description across all skills — the system-prompt index. */
let indexChars = 0;

for (const skill of collectSkills(skillsDir)) {
  count++;
  const text = readFileSync(skill.path, "utf8");
  const fm = parseFrontmatter(text);

  if (!fm) {
    problems.hard.push(`${skill.name}: no YAML frontmatter`);
    continue;
  }

  // Per pi's rules only a missing description is fatal; every name violation —
  // including absence — is a warning, and pi still loads the skill.
  if (!fm.name) {
    problems.warn.push(`${skill.name}: missing 'name'`);
  } else if (fm.name.length > 64 || !nameRe.test(fm.name)) {
    problems.warn.push(
      `${skill.name}: name '${fm.name}' violates pi rules (≤64 chars, [a-z0-9-], no leading/trailing/consecutive hyphens)`,
    );
  }

  if (!fm.description) {
    problems.hard.push(`${skill.name}: missing 'description' (pi will not load it)`);
  } else if (fm.description.length > 1024) {
    problems.warn.push(`${skill.name}: description ${fm.description.length} chars > 1024 (warning only)`);
  }

  indexChars += (fm.name ?? skill.name).length + (fm.description?.length ?? 0);
}

// ---------------------------------------------------------------------------
// extensions/profiles.ts vs. skills/ on disk
// ---------------------------------------------------------------------------

const profilesPath = join(root, "extensions", "profiles.ts");

async function loadProfiles() {
  try {
    return await import(pathToFileURL(profilesPath).href);
  } catch (error) {
    problems.hard.push(
      `extensions/profiles.ts could not be imported (${error?.message ?? error}). ` +
        `Node >= 22.18 is required to strip TypeScript types.`,
    );
    return null;
  }
}

function validateProfiles(mod, onDisk) {
  const skillDirs = new Set(onDisk);

  if (mod.TOTAL_SKILL_COUNT !== onDisk.length) {
    problems.hard.push(
      `profiles.ts TOTAL_SKILL_COUNT is ${mod.TOTAL_SKILL_COUNT} but skills/ holds ` +
        `${onDisk.length} skills — every /sci token figure is wrong until this is updated`,
    );
  }

  const assigned = new Set();
  for (const profile of mod.PROFILES) {
    const seen = new Set();
    for (const skill of profile.skills) {
      if (seen.has(skill)) problems.hard.push(`profile '${profile.id}' lists '${skill}' twice`);
      seen.add(skill);
      if (!skillDirs.has(skill)) {
        problems.hard.push(`profile '${profile.id}' lists '${skill}', which has no skills/${skill}/SKILL.md`);
      }
      assigned.add(skill);
    }
  }

  for (const { skill } of mod.UNASSIGNED) {
    if (!skillDirs.has(skill)) {
      problems.hard.push(`UNASSIGNED lists '${skill}', which has no skills/${skill}/SKILL.md`);
    }
    if (assigned.has(skill)) {
      problems.hard.push(`'${skill}' is in both a profile and UNASSIGNED — pick one`);
    }
    assigned.add(skill);
  }

  for (const skill of mod.STANDALONE_SKILL_IDS) {
    if (!skillDirs.has(skill)) {
      problems.hard.push(`STANDALONE_SKILL_IDS lists '${skill}', which has no skills/${skill}/SKILL.md`);
    }
  }

  // Toggle ids are persisted in the user's config, so a collision would make a
  // saved selection mean two different things.
  const ids = mod.TOGGLES.map((toggle) => toggle.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) problems.hard.push(`duplicate toggle id '${id}'`);

  const orphans = onDisk.filter((skill) => !assigned.has(skill));
  for (const skill of orphans) {
    problems.hard.push(
      `skills/${skill} is in no profile and no UNASSIGNED entry — /sci users would never see it`,
    );
  }

  console.log(
    `Validated profiles.ts: ${mod.PROFILES.length} profiles, ${assigned.size}/${onDisk.length} skills accounted for`,
  );
}

// ---------------------------------------------------------------------------
// extensions/package-info.ts vs. package.json
// ---------------------------------------------------------------------------

/**
 * The extension keeps its own name and version as constants so the upgrade
 * notice cannot fail on a file read. The price is drift, and drift here is
 * silent in the worst way: a stale PACKAGE_VERSION suppresses the "what
 * changed" notice for every user, which is the one promise a release makes.
 */
async function validatePackageInfo() {
  let info;
  try {
    info = await import(pathToFileURL(join(root, "extensions", "package-info.ts")).href);
  } catch (error) {
    problems.hard.push(`extensions/package-info.ts could not be imported (${error?.message ?? error})`);
    return;
  }

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  if (info.PACKAGE_VERSION !== manifest.version) {
    problems.hard.push(
      `package-info.ts PACKAGE_VERSION is "${info.PACKAGE_VERSION}" but package.json says ` +
        `"${manifest.version}" — existing users would get no upgrade notice for this release`,
    );
  }
  if (info.PACKAGE_NAME !== manifest.name) {
    problems.hard.push(
      `package-info.ts PACKAGE_NAME is "${info.PACKAGE_NAME}" but package.json says "${manifest.name}" — ` +
        `/sci looks the package up in settings.json by this name and would find nothing`,
    );
  }
}

// ---------------------------------------------------------------------------
// extensions/aliases.ts vs. skills/ on disk
// ---------------------------------------------------------------------------

/**
 * An alias naming a skill that no longer exists is inert but harmful: the query
 * it was written for silently loses its best match, and nothing surfaces that.
 * sync-upstream.sh replaces skills/ wholesale, so this is exactly the kind of
 * breakage a release introduces without touching extensions/.
 */
async function validateAliases(onDisk) {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, "extensions", "aliases.ts")).href);
  } catch (error) {
    problems.hard.push(`extensions/aliases.ts could not be imported (${error?.message ?? error})`);
    return;
  }

  const skillDirs = new Set(onDisk);
  const triggers = new Set();
  let targets = 0;

  for (const alias of mod.ALIASES) {
    if (!alias.match?.length) {
      problems.hard.push(`an alias entry has no "match" phrases, so it can never fire`);
      continue;
    }
    for (const phrase of alias.match) {
      const key = phrase.toLowerCase();
      // Duplicate triggers double-count their boost, quietly distorting ranking.
      if (triggers.has(key)) problems.hard.push(`alias phrase "${phrase}" is listed twice`);
      triggers.add(key);
    }
    if (!alias.terms?.length && !alias.skills?.length) {
      problems.hard.push(`alias "${alias.match[0]}" expands to nothing`);
    }
    for (const skill of alias.skills ?? []) {
      targets++;
      if (!skillDirs.has(skill)) {
        problems.hard.push(`alias "${alias.match[0]}" names '${skill}', which has no skills/${skill}/SKILL.md`);
      }
    }
  }

  console.log(`Validated aliases.ts: ${mod.ALIASES.length} rules, ${targets} skill targets`);
}

// ---------------------------------------------------------------------------
// TOKENS_PER_SKILL ratchet
// ---------------------------------------------------------------------------

/** Chars per token in the original measurement (65,455 chars ≈ 17.7k tokens). */
const CHARS_PER_TOKEN = 3.69;
/** Drift below this is noise in a hand-calibrated estimate; above it, /sci lies. */
const DRIFT_TOLERANCE = 0.1;

/**
 * TOKENS_PER_SKILL has to stay a constant — the picker needs a cost for a
 * selection synchronously, before anything is on disk to measure. But upstream
 * rewrites descriptions, and every /sci token figure is derived from this one
 * number, so a silent 30% drift would turn honest guidance into confident
 * nonsense. Warn rather than fail: the number is an estimate by construction.
 */
function checkTokenEstimate(profiles, skillCount) {
  if (!profiles || skillCount === 0) return;
  const measured = indexChars / skillCount / CHARS_PER_TOKEN;
  const drift = Math.abs(measured - profiles.TOKENS_PER_SKILL) / profiles.TOKENS_PER_SKILL;
  const summary =
    `TOKENS_PER_SKILL is ${profiles.TOKENS_PER_SKILL}; skills/ now measures ` +
    `${measured.toFixed(1)} (${(drift * 100).toFixed(1)}% drift)`;

  if (drift > DRIFT_TOLERANCE) {
    problems.warn.push(`${summary} — update it in profiles.ts, or every /sci figure is off by that much`);
  } else {
    console.log(`Validated token estimate: ${summary}`);
  }
}

const onDiskNames = collectSkills(skillsDir).map((skill) => skill.name);
const profiles = await loadProfiles();
if (profiles) validateProfiles(profiles, onDiskNames);
await validateAliases(onDiskNames);
await validatePackageInfo();
checkTokenEstimate(profiles, count);

console.log(`Validated ${count} skills in ${skillsDir}`);
for (const p of problems.warn) console.log(`  [warn] ${p}`);
for (const p of problems.hard) console.log(`  [FAIL] ${p}`);

console.log(
  `\n${count} skills, ${problems.warn.length} warning(s), ${problems.hard.length} hard issue(s)`,
);
process.exit(problems.hard.length > 0 ? 1 : 0);
