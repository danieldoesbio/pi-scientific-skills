#!/usr/bin/env node
// Validate all skills against pi's Agent Skills rules (docs/skills.md).
// Warnings are acceptable (pi loads leniently); a MISSING description is a hard
// failure because pi refuses to load such skills.
//
// Usage: node scripts/validate.mjs  (or: npm run validate)
// Exit codes: 0 = OK, 1 = hard failure (missing description), 2 = usage error.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log(`Validated ${count} skills in ${skillsDir}`);
for (const p of problems.warn) console.log(`  [warn] ${p}`);
for (const p of problems.hard) console.log(`  [FAIL] ${p}`);

console.log(
  `\n${count} skills, ${problems.warn.length} warning(s), ${problems.hard.length} hard issue(s)`,
);
process.exit(problems.hard.length > 0 ? 1 : 0);
