#!/usr/bin/env node
// Does `extensions/frontmatter.ts` parse the way pi's own parser does?
//
// pi's real parser is `dist/utils/frontmatter.js` in an installed pi — hidden
// behind the bundled `cli.js` but still on disk, and it depends on the `yaml`
// package, which is NOT reachable from this repo (no node_modules of our own).
// So the hand-rolled parser stays hand-rolled, copying pi's fence-finding and
// scalar rules by hand, and this suite is what keeps the copy honest: every
// real `SKILL.md` plus a set of synthetic edge cases, run through both
// parsers, field by field.
//
// pi's `parseFrontmatter` never returns null — no fence gives `{frontmatter:
// {}, body: <untouched input>}`. So "has frontmatter" is derived rather than
// read off a return value: `stripFrontmatter(doc)` equals the normalized
// input verbatim exactly when no fence was found (the found-fence path always
// trims and slices the body), so inequality is pi's own signal that a fence
// existed. This is not in the required edge-case list: `---\n---\nbody` (a
// fence found around nothing) still counts as "has frontmatter" by this
// measure, which agrees with our contract (`parseFrontmatter` returns `{}`,
// not `null`, when the fence is found but the YAML inside is empty).
//
// Block scalars: pi's `yaml` keeps YAML's default "clip" chomping, so a `>`/`|`
// body carries one trailing newline that our contract trims away. Comparing
// trimmed values on both sides loses nothing for the defects this suite exists
// to catch (fence offset, BOM, CR, comments, escapes) and avoids failing on
// every skill that uses a block scalar.
//
// Nested mappings/sequences (`metadata:`) are a documented exception to the
// Record<string,string> contract: pi's yaml returns a real object, ours
// records the key present with an empty string. Every skill in this corpus
// has a `metadata:` mapping, so this is not a rare case — it is compared
// explicitly rather than through blind `String()` coercion.
//
// Usage: node scripts/test-frontmatter.mjs  (or: npm run test:frontmatter)
// Exit codes: 0 = OK, 1 = failures.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDist, loadExtensionModule } from "./lib/load-extension.mjs";
import { documentedCount } from "./doc-count.mjs";

// Not a skip: without pi there is no oracle, and a green run that compared
// nothing would be the worst possible outcome for a parity check.
const piDist = findPiDist();
if (!piDist) {
  console.error("FAIL: pi is not on PATH and PI_DIST is unset — its frontmatter parser cannot be compared.");
  process.exit(1);
}

const oracleModule = (file) => pathToFileURL(join(piDist, "utils", file)).href;
const { parseFrontmatter: oracleParse, stripFrontmatter } = await import(oracleModule("frontmatter.js"));

const { parseFrontmatter: localParse } = await loadExtensionModule("extensions/frontmatter.ts");

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SKILLS_DIR = join(ROOT, "skills");

const failures = [];
let checks = 0;
const check = (label, condition, detail = "") => {
  checks++;
  if (!condition) {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL    ${label}${detail ? `\n          ${detail}` : ""}`);
  }
};

// --- "has frontmatter", derived from pi's own behaviour ---------------------

const normalizeLikePi = (text) => {
  const stripped = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
};
const oracleHasFrontmatter = (text) => stripFrontmatter(text) !== normalizeLikePi(text);

// --- the comparison ---------------------------------------------------------

/** @returns a list of human-readable mismatches; empty means the two parsers agree. */
function diffDocument(text) {
  const problems = [];

  const oracleHas = oracleHasFrontmatter(text);
  const localResult = localParse(text);
  const localHas = localResult !== null;
  if (oracleHas !== localHas) {
    problems.push(`has-frontmatter: pi=${oracleHas} ours=${localHas}`);
  }

  const oracleFields = oracleParse(text).frontmatter ?? {};
  const localFields = localResult ?? {};
  const keys = new Set([...Object.keys(oracleFields), ...Object.keys(localFields)]);
  for (const key of keys) {
    const oracleValue = oracleFields[key];
    const localValue = localFields[key] ?? "";

    if (oracleValue !== null && typeof oracleValue === "object") {
      // Nested mapping/sequence: our contract is "present, recorded empty".
      if (localValue !== "") {
        problems.push(`'${key}': nested mapping should be present-but-empty, got ${JSON.stringify(localValue)}`);
      }
      continue;
    }

    const expected = String(oracleValue ?? "").trim();
    const actual = localValue.trim();
    if (expected !== actual) {
      problems.push(`'${key}': expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  return problems;
}

function runDocument(label, text) {
  const problems = diffDocument(text);
  check(`${label} parses like pi's parser`, problems.length === 0, problems.join("; "));
}

// --- real skills -------------------------------------------------------------

const skillDirs = readdirSync(SKILLS_DIR).filter((name) => {
  try {
    return statSync(join(SKILLS_DIR, name, "SKILL.md")).isFile();
  } catch {
    return false;
  }
});
if (skillDirs.length === 0) {
  console.error("FAIL: no skills/*/SKILL.md found to compare");
  process.exit(1);
}

console.log(`-- ${skillDirs.length} skills, against pi's real frontmatter parser --`);
for (const name of skillDirs) {
  const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
  runDocument(name, text);
}

// --- synthetic edge cases ----------------------------------------------------

// Every value here is a complete document, fence included where one is meant
// to be found — no implicit wrapping, so what is written is what is parsed.
const SYNTHETIC = {
  "UTF-8 BOM before the fence": "\uFEFF---\ndescription: bom test\nname: bomtest\n---\nbody",
  "CRLF line endings": "---\r\ndescription: crlf test\r\nname: crlftest\r\n---\r\nbody",
  "lone CR line endings": "---\rdescription: cr test\rname: crtest\r---\rbody",
  "leading blank line before the fence (no frontmatter, on both sides)":
    "\n---\ndescription: x\n---\nbody",
  "no fence, but a --- rule later in the body (no frontmatter, on both sides)":
    "not frontmatter at all\n---\ndescription: x\n---\nmore text",
  'double-quoted description containing \\"':
    '---\ndescription: "quote \\"inside\\" here"\nname: dqtest\n---\nbody',
  "single-quoted description containing ''":
    "---\ndescription: 'it''s a test'\nname: sqtest\n---\nbody",
  "inline # comment after a quoted value":
    '---\ndescription: "foo" # a note\nname: qcommenttest\n---\nbody',
  "inline # comment after an unquoted value":
    "---\ndescription: bar # a note\nname: ucommenttest\n---\nbody",
  "folded > block scalar":
    "---\ndescription: >\n  This is\n  folded text.\nname: foldtest\n---\nbody",
  "literal | block scalar":
    "---\ndescription: |\n  line one\n  line two\nname: littest\n---\nbody",
  "empty block scalar (description: > with nothing after)":
    "---\ndescription: >\nname: emptytest\n---\nbody",
  "nested metadata: mapping":
    "---\ndescription: nested test\nmetadata:\n  version: 1\n  tags:\n    - a\n    - b\nname: nestedtest\n---\nbody",
};

console.log(`\n-- ${Object.keys(SYNTHETIC).length} synthetic edge cases --`);
for (const [label, text] of Object.entries(SYNTHETIC)) {
  runDocument(label, text);
}

console.log(`\n  ${checks - failures.length}/${checks} documents parse like pi's parser`);

failures.push(...documentedCount("frontmatter parity checks", checks));

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
