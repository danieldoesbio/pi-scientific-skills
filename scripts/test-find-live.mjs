#!/usr/bin/env node
// The release gate for search mode: does a SMALL model actually reach for
// sci_find when the skill it needs is not in the system prompt?
//
// Everything else can pass while this fails. The ranking tests prove sci_find
// returns the right skill *when asked*; this proves it gets asked. If a weak
// model never calls the tool, the trade search mode makes — fewer skills in the
// prompt, all of them reachable — is a loss, not a win, and the fix is the tool
// description and the alias table, before release.
//
// Deliberately run against the PACKED TARBALL and a throwaway
// PI_CODING_AGENT_DIR, for the same reasons as test-batch.mjs: it exercises
// what ships, and it cannot be perturbed by (or perturb) the developer's own
// ~/.pi/agent/settings.json.
//
// This spends model tokens, so it is NOT part of `npm test`.
//
// Usage:
//   node scripts/test-find-live.mjs [--model <id>] [--timeout <s>] [--keep]
//
//   --model <id>    Default deepseek/deepseek-v4-flash. Use a small model on
//                   purpose — a frontier model proves nothing about the floor.
//   --timeout <s>   Per-probe wall clock, default 180.
//   --keep          Leave transcripts in place and print the path.
//
// Exit codes: 0 = every probe called sci_find, 1 = at least one did not (or a
//             probe never ran, reported separately as ERROR), 2 = usage error.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tasks whose skill is deliberately OUTSIDE the Core profile.
 *
 * Phrased the way a scientist would phrase them, never naming the skill: the
 * question is whether the model bridges from intent to tool, which is the whole
 * bet. `want` lists acceptable skills — several legitimately fit.
 */
const PROBES = [
  {
    id: "variants",
    task: "I have a sorted BAM file of sequencing reads and I need to call variants from it. What is the best way to do this here?",
    want: ["pysam", "pathogen-variant-surveillance", "genomic-intelligence"],
  },
  {
    id: "single-cell",
    task: "I have a 10x Genomics single-cell count matrix and want to cluster the cells and find marker genes. How should I approach this?",
    want: ["scanpy", "anndata", "scvi-tools"],
  },
  {
    id: "docking",
    task: "I want to dock a small-molecule ligand into a protein binding site. What should I use?",
    want: ["diffdock", "rdkit", "tamarind"],
  },
];

function die(message, code = 2) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { model: "deepseek/deepseek-v4-flash", timeout: 180, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--model") opts.model = next();
    else if (arg === "--timeout") opts.timeout = Number(next());
    else if (arg === "--keep") opts.keep = true;
    else die(`unknown option ${arg}`);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) die("--timeout must be a positive number");
  return opts;
}

/** Pack the package and extract it, so the run exercises what ships. */
function stageTarball(scratch) {
  const stage = join(scratch, "pkg");
  mkdirSync(stage, { recursive: true });
  // --silent: npm pack lists every file in the tarball on stderr, which buries
  // the probe results this script exists to show.
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", stage], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync("tar", ["xzf", join(stage, packed), "-C", stage]);
  // npm extracts to `package/`. Rename it: /sci finds its own settings entry by
  // matching the package name against the source string, so a differently-named
  // directory would leave the extension believing it is not installed — the run
  // would still filter correctly (pi matches on the literal source) but would
  // exercise the wrong startup branch.
  const named = join(stage, "pi-scientific-skills");
  rmSync(named, { recursive: true, force: true });
  renameSync(join(stage, "package"), named);
  return named;
}

/**
 * An agent dir holding nothing but this package, filtered to Core.
 *
 * This is the configuration `/sci search` produces, reached the way pi reaches
 * it — so the run tests the shipped default, not a hand-assembled approximation.
 *
 * Credentials and the model catalogue are copied in because isolating the agent
 * dir also isolates them: without this, every probe fails with "No API key
 * found" and the script reports a model that declined to call the tool, when in
 * fact no model ran. Copied at 0600 and deleted at exit, including under --keep.
 */
function seedAgentDir(scratch, packageDir, coreSkills) {
  const agentDir = join(scratch, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [{ source: packageDir, skills: coreSkills }] }, null, 2)}\n`,
  );

  const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const auth = join(realAgentDir, "auth.json");
  if (!existsSync(auth)) {
    die(`no credentials at ${auth} — run \`pi\` and /login first`, 1);
  }
  for (const name of ["auth.json", "models-store.json"]) {
    const from = join(realAgentDir, name);
    if (!existsSync(from)) continue;
    const to = join(agentDir, name);
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  }
  return agentDir;
}

/** Pull the tool calls out of a `--mode json` transcript. */
function toolCalls(rawText) {
  const calls = [];
  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "tool_execution_start") {
      calls.push({ id: event.toolCallId, tool: event.toolName, args: event.args ?? {}, result: "" });
    } else if (event.type === "tool_execution_end") {
      // Pair on toolCallId, never on name: pi runs calls concurrently, so
      // name-matching staples one call's output onto another's.
      const target = calls.find((call) => call.id === event.toolCallId);
      if (!target) continue;
      target.result = (event.result?.content ?? [])
        .filter((chunk) => chunk?.type === "text")
        .map((chunk) => chunk.text)
        .join("\n");
    }
  }
  return calls;
}

const opts = parseArgs(process.argv.slice(2));

const profiles = await import(pathToFileURL(join(root, "extensions", "profiles.ts")).href);
const core = profiles.PROFILES.find((profile) => profile.id === "core");
if (!core) die("no 'core' profile in profiles.ts", 1);

for (const probe of PROBES) {
  const overlap = probe.want.filter((skill) => core.skills.includes(skill));
  if (overlap.length > 0) {
    die(`probe "${probe.id}" wants ${overlap.join(", ")}, which Core already loads — it proves nothing`, 1);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "sci-find-live-"));
const outDir = join(scratch, "transcripts");
mkdirSync(outDir, { recursive: true });

console.log(`model: ${opts.model}`);
console.log("staging tarball…");
const packageDir = stageTarball(scratch);
const agentDir = seedAgentDir(scratch, packageDir, [...core.skills]);
console.log(`agent dir: ${agentDir} (Core only — ${core.skills.length} skills in the prompt)\n`);

const failures = [];
/** Setup problems — reported separately so they can never read as a verdict. */
const errors = [];

for (const [index, probe] of PROBES.entries()) {
  process.stderr.write(`[${index + 1}/${PROBES.length}] ${probe.id} … `);

  // stdout to a file descriptor, not a pipe: --mode json emits a cumulative
  // message_update per token, so buffering makes maxBuffer a silent kill switch.
  const transcript = join(outDir, `${probe.id}.jsonl`);
  const fd = openSync(transcript, "w");
  const started = Date.now();
  let result;
  try {
    result = spawnSync(
      "pi",
      ["--no-session", "--mode", "json", "--model", opts.model, "-p", probe.task],
      {
        cwd: scratch,
        encoding: "utf8",
        timeout: opts.timeout * 1000,
        stdio: ["ignore", fd, "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      },
    );
  } finally {
    closeSync(fd);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  if (result.error?.code === "ETIMEDOUT") {
    console.error(`TIMEOUT after ${opts.timeout}s`);
    failures.push(`${probe.id}: timed out`);
    continue;
  }

  const raw = readFileSync(transcript, "utf8");
  if (result.stderr) writeFileSync(join(outDir, `${probe.id}.stderr.txt`), result.stderr);

  // A run that never reached the model is a broken harness, not a verdict.
  // Reporting it as "never called sci_find" would be exactly the confident
  // wrong answer this package refuses to give.
  const answered = raw.split("\n").some((line) => {
    try {
      const event = JSON.parse(line);
      return event.type === "message_end" && event.message?.role === "assistant";
    } catch {
      return false;
    }
  });
  if (!answered) {
    const detail = (result.stderr ?? "").trim().split("\n")[0] || `pi exit ${result.status}`;
    console.error(`NO RUN (${elapsed}s) — ${detail}`);
    errors.push(`${probe.id}: the model never answered (${detail}) — this is a setup failure, not a result`);
    continue;
  }

  const calls = toolCalls(raw);
  const found = calls.filter((call) => call.tool === "sci_find");

  if (found.length === 0) {
    const attempted = [...new Set(calls.map((call) => call.tool))].join(", ") || "none";
    console.error(`NO CALL (${elapsed}s) — tools used: ${attempted}`);
    failures.push(
      `${probe.id}: never called sci_find. The tool description or the alias table is the fix, not the test.`,
    );
    continue;
  }

  // Secondary, reported but not gating: did the search surface a usable skill,
  // and did the model go on to read it? A model that calls the tool and then
  // ignores it is a weaker signal than one that never called, but still worth
  // seeing.
  const surfaced = probe.want.filter((skill) =>
    found.some((call) => call.result.includes(skill)),
  );
  const readPaths = calls
    .filter((call) => call.tool === "read")
    .map((call) => String(call.args?.filePath ?? call.args?.path ?? ""));
  const readSkill = probe.want.some((skill) =>
    readPaths.some((path) => path.includes(`/skills/${skill}/`)),
  );

  console.error(
    `called sci_find ×${found.length} (${elapsed}s)` +
      ` | surfaced: ${surfaced.join(", ") || "none of the expected"}` +
      ` | read SKILL.md: ${readSkill ? "yes" : "no"}`,
  );

  if (surfaced.length === 0) {
    failures.push(`${probe.id}: called sci_find, but none of [${probe.want.join(", ")}] came back`);
  }
}

// The agent dir holds a copy of the real API key, so it goes regardless of --keep.
rmSync(agentDir, { recursive: true, force: true });
if (opts.keep) {
  console.log(`\ntranscripts: ${outDir}`);
} else {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.log(`\nERROR — ${errors.length} probe(s) never ran; no conclusion can be drawn.`);
  for (const error of errors) console.log(`  [ERROR] ${error}`);
  process.exit(1);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
