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

function parseFrontmatter(text) {
  // Conservative line-based parser for the simple frontmatter this collection
  // uses (key: value / key: block-scalar). Nested mappings are skipped.
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  let key = null;
  let depth = 0;
  for (const line of m[1].split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0 && /^[A-Za-z0-9_-]+:/.test(line)) {
      const [, k, rest] = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      key = k;
      fm[k] = rest.trim();
      depth = rest.trim() === "" ? 0 : -1; // -1: scalar on same line
    } else if (key && depth >= 0 && indent > 0) {
      depth = indent; // nested block under key
    }
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

  if (!fm.name) {
    problems.hard.push(`${skill.name}: missing 'name'`);
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
