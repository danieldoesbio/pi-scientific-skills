#!/usr/bin/env node
// Validate all skills against pi's Agent Skills rules (docs/skills.md), and
// validate extensions/profiles.ts against what is actually on disk.
//
// Warnings are acceptable (pi loads leniently); a MISSING description is a hard
// failure because pi refuses to load such skills. A profiles.ts that disagrees
// with skills/ is also a hard failure: sync-upstream.sh replaces skills/
// wholesale, and nothing else notices when a release adds, removes or renames a
// skill — leaving /sci quoting stale token counts and stranding new skills in no
// profile, silently, for every user who has applied one.
//
// Requires Node >= 22.18 (native TypeScript type stripping) to read profiles.ts.
//
// Usage: node scripts/validate.mjs  (or: npm run validate)
// Exit codes: 0 = OK, 1 = hard failure, 2 = usage error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");

function unquote(s) {
  const m = s.match(/^(['"])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

function parseFrontmatter(text) {
  // Line-based parser for the top-level scalars this collection uses. It must
  // resolve block scalars (`description: >` followed by indented lines), because
  // a naive parser records the `>` indicator itself as the value — which makes a
  // skill with an EMPTY block body look like it has a description and slip past
  // the hard check below, even though pi would refuse to load it.
  //
  // Only top-level scalars are resolved. Nested mappings (`metadata:`) are
  // recorded as present-but-empty and skipped; none are validated.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!m) return null;

  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    i++;

    const kv = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue; // continuation of a construct we skipped, or blank
    const [, key, rawRest] = kv;
    const rest = rawRest.trim();

    // Block scalar: `>`, `|`, plus optional chomping/indent indicators (>-, |2+).
    const block = rest.match(/^([|>])([+-]?\d*|\d*[+-]?)$/);
    if (block) {
      const folded = block[1] === ">";
      const body = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() !== "" && !/^[ \t]/.test(next)) break; // dedent ends block
        body.push(next.trim());
        i++;
      }
      while (body.length && body[body.length - 1] === "") body.pop(); // chomp
      fm[key] = folded ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n").trim();
      continue;
    }

    if (rest === "") {
      // Either an empty scalar or the start of a nested mapping/sequence.
      // Consume any indented block so its inner keys aren't read as top-level.
      while (i < lines.length && (lines[i].trim() === "" || /^[ \t]/.test(lines[i]))) i++;
      fm[key] = "";
      continue;
    }

    fm[key] = unquote(rest);
  }

  return fm;
}

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

const onDiskNames = collectSkills(skillsDir).map((skill) => skill.name);
const profiles = await loadProfiles();
if (profiles) validateProfiles(profiles, onDiskNames);

console.log(`Validated ${count} skills in ${skillsDir}`);
for (const p of problems.warn) console.log(`  [warn] ${p}`);
for (const p of problems.hard) console.log(`  [FAIL] ${p}`);

console.log(
  `\n${count} skills, ${problems.warn.length} warning(s), ${problems.hard.length} hard issue(s)`,
);
process.exit(problems.hard.length > 0 ? 1 : 0);
