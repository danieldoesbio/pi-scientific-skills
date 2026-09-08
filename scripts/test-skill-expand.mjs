#!/usr/bin/env node
// Is the block this extension builds for a filtered-out skill byte-identical to
// the one pi builds for a loaded one?
//
// The /skill: input hook in extensions/index.ts exists because pi forwards an
// unknown /skill:<name> to the model as literal text, and a filtered-out skill
// is unknown to pi's registry. The hook rebuilds pi's own wrapper. "Rebuilds"
// is a promise about bytes, so it is pinned against pi's real method —
// AgentSession.prototype._expandSkillCommand, borrowed onto a fake `this` —
// rather than against a copied template string that could drift when pi's does.
//
// One axis is circular and worth knowing: the oracle loads skills from the same
// skills/ directory the hook reads, so this validates string fidelity, not that
// pi's package manager would resolve the same path for an installed copy.
//
// Usage: node scripts/test-skill-expand.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDist, loadExtensionModule } from "./lib/load-extension.mjs";
import { documentedCount } from "./doc-count.mjs";

// Not a skip: without pi there is no oracle, and a green run that compared
// nothing would be the worst possible outcome for a byte-fidelity check.
const piDist = findPiDist();
if (!piDist) {
  console.error("FAIL: pi is not on PATH and PI_DIST is unset — its /skill: expansion cannot be compared.");
  process.exit(1);
}

const dist = (file) => pathToFileURL(join(piDist, "core", file)).href;
const { AgentSession, parseSkillBlock } = await import(dist("agent-session.js"));
const { loadSkillsFromDir } = await import(dist("skills.js"));

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const failures = [];
let checks = 0;
const check = (label, condition, detail = "") => {
  checks++;
  if (!condition) {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL    ${label}${detail ? `\n          ${detail}` : ""}`);
  }
};

// --- pi's side --------------------------------------------------------------

// pi's own loader over the same directory, so filePath/baseDir/name are what pi
// would hold for these skills when nothing filters them.
const { skills } = loadSkillsFromDir({ dir: join(ROOT, "skills"), source: "pi-scientific-skills" });
if (skills.length === 0) {
  console.error("FAIL: pi's skill loader found nothing under skills/");
  process.exit(1);
}

const oracle = (text) =>
  AgentSession.prototype._expandSkillCommand.call(
    {
      resourceLoader: { getSkills: () => ({ skills }) },
      _extensionRunner: {
        emitError: (error) => {
          throw new Error(`pi could not expand: ${error.error}`);
        },
      },
    },
    text,
  );

// --- our side ---------------------------------------------------------------

const agentDir = mkdtempSync(join(tmpdir(), "sci-expand-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const extension = await loadExtensionModule("extensions/index.ts");
let inputHandler;
extension.default({
  registerCommand: () => {},
  registerTool: () => {},
  on: (event, handler) => {
    if (event === "input") inputHandler = handler;
  },
  // Nothing loaded: every name is "filtered out", so the hook must answer for all of them.
  getCommands: () => [],
  sendUserMessage: async () => {},
});
if (typeof inputHandler !== "function") {
  console.error("FAIL: the extension registered no input handler");
  process.exit(1);
}

const ours = async (text) => {
  const result = await inputHandler(
    { type: "input", text, images: undefined, source: "interactive", streamingBehavior: undefined },
    {},
  );
  return result?.action === "transform" ? result.text : text;
};

// --- the comparison ---------------------------------------------------------

console.log(`-- ${skills.length} skills x 3 argument forms, against pi's _expandSkillCommand --`);

const FORMS = [
  ["no args", (name) => `/skill:${name}`],
  ["with args", (name) => `/skill:${name} explain the first step`],
  ["whitespace-only args", (name) => `/skill:${name}   `],
];

let compared = 0;
for (const skill of skills) {
  for (const [form, make] of FORMS) {
    const text = make(skill.name);
    const expected = oracle(text);
    const actual = await ours(text);
    compared++;
    check(`${skill.name} (${form}) is byte-identical to pi's`, actual === expected, diffHint(expected, actual));
  }
}
console.log(`  ${compared - failures.length}/${compared} identical`);

// pi's wrapper must still parse back out on pi's side, or a later pi that
// renders the block from parseSkillBlock would show the raw text instead.
{
  const sample = skills[0];
  const parsed = parseSkillBlock(await ours(`/skill:${sample.name} go`));
  check("pi's parseSkillBlock reads the block back", parsed?.name === sample.name, JSON.stringify(parsed)?.slice(0, 120));
  check("...with the args as the user message", parsed?.userMessage === "go", JSON.stringify(parsed?.userMessage));
}

// The two miss cases must agree as well: both sides hand the text on untouched.
for (const text of ["/skill:not-a-real-skill", `/skill:${skills[0].name}\nsecond line`]) {
  check(`miss parity: ${JSON.stringify(text)}`, (await ours(text)) === oracle(text));
}

rmSync(agentDir, { recursive: true, force: true });

failures.push(...documentedCount("byte-identity checks against pi's own `/skill:` expansion", checks));

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);

/** First differing offset, so a failure says where rather than dumping two 30KB strings. */
function diffHint(expected, actual) {
  if (expected === actual) return "";
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  return `differs at ${i}: expected ${JSON.stringify(expected.slice(i, i + 40))}, got ${JSON.stringify(actual.slice(i, i + 40))}`;
}
