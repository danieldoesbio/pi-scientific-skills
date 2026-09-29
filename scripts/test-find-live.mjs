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
// The model keeps pi's default tools, bash included, so every pi run happens
// inside a macOS sandbox-exec profile (scripts/lib/sandbox.mjs): reads and
// writes only in its own attempt directory, a fake HOME, and the network only
// to the model's endpoint when that endpoint is local.
//
// Usage:
//   node scripts/test-find-live.mjs [--model <id>] [--timeout <s>] [--keep]
//   node scripts/test-find-live.mjs --probes testing/find-probes.json \
//        --model prism-llama/Ternary-Bonsai-2-27B-PQ2_0 --results <file.jsonl> [--resume]
//
//   --model <id>       Default deepseek/deepseek-v4-flash. Use a small model on
//                      purpose — a frontier model proves nothing about the floor.
//                      A local model needs its provider in the real agent dir's
//                      models.json, which is copied into the throwaway one.
//   --timeout <s>      Wall clock per model response, default 180.
//   --thinking <lvl>   Pass pi's --thinking level through. Omitted = pi's default.
//   --keep             Leave transcripts and workspaces in place; print the path.
//   --no-sandbox       Run pi unsandboxed. The model has bash: do not, unless
//                      the probes are known to be harmless.
//   --probes <file>    Supervised per-skill mode: one probe per skill from a JSON
//                      file (format: testing/find-probes.json), each run as up to
//                      --attempts fresh conversations of up to --responses model
//                      responses, with a blind persona (scripts/lib/supervisor.mjs)
//                      answering follow-up questions. Graded by the attempt in
//                      which the target skill first reached the model
//                      (scripts/lib/converse.mjs).
//   --attempts <n>     Default 3.
//   --responses <n>    Default 5.
//   --prompt-skills <none|core|all>  Which skills the system prompt lists. none
//                      (default): an empty filter, the configuration
//                      `/sci search` writes since 1.7.0, so sci_find is the
//                      only way to any skill. core: the Core profile, what
//                      `/sci search` wrote before 1.7.0. all: no filter, every
//                      skill listed (the normal install). Recorded on every
//                      result line.
//   --no-extension     Load the package's skills but not its extension
//                      (`extensions: []`): no sci_find, no /sci. With
//                      --prompt-skills all, this is a plain skills install.
//   --package-dir <dir>  Pack and test this package tree instead of the one
//                      this script lives in (e.g. an older release, checked
//                      out with `git archive`).
//   --package-label <text>  Recorded on every result line as `package`.
//   --endpoint <listed|read|first-find>  What counts as reaching the target.
//                      listed (default): a sci_find result, bash output or file
//                      read puts it in front of the model. read: the model read
//                      the target's SKILL.md. The response stops at the
//                      endpoint. first-find: no target; the attempt stops at
//                      the first sci_find call and records its query (ends as
//                      `searched`). Needs --attempts 1 and the extension.
//   --find-ranker <current|bm25f>  PI_SCI_FIND_RANKER for pi. Default bm25f,
//                      the package default since 1.7.0. A package older than
//                      5123f67 has no bm25f and runs current: pass current for
//                      it, so the result lines record what ran.
//   --models-json <file>  Seed the throwaway agent dir with this models.json
//                      instead of the real one (e.g. a provider on another
//                      port). The real agent dir is never written.
//   --gate-calls <n>   End an attempt as `gated` (a miss) once its first n tool
//                      calls hold no skill-seeking call (scripts/lib/pi-session.mjs
//                      `gateTripped`). Default 0: off.
//   --warmup           Before the first probe, send one ungraded request with the
//                      same agent dir, so the cold prefill of the system prompt
//                      does not count against the first probe. Recorded in
//                      <results>.warmup.jsonl.
//   --archive-to <dir> At the end, copy the transcripts and a tarball of the
//                      attempt workspaces into <dir>.
//   --supervisor-model <id>  Persona model for the claude CLI, default claude-opus-5-5.
//   --judge-model <id> Probe-check judge for the claude CLI, default
//                      claude-fable-5-1. It runs only on a probe that failed
//                      with the persona satisfied, and decides whether the
//                      target was needed at all (scripts/lib/probe-check.mjs).
//   --only <a,b>       Run only these probe ids (skill names with --probes).
//   --results <file>   Append one JSON line per finished probe, as it finishes.
//   --resume           With --results: skip probes already graded there with
//                      the same task text. A probe that hit a harness error
//                      (no-run, supervisor-error) or was rewritten runs again.
//   --offline          No model. Rank each probe's task text through sci_find's
//                      own search and report where the target lands. Separates
//                      "the probe is vague / search has a gap" from "the model
//                      did not search".
//
// Exit codes: 0 = every probe called sci_find (with --probes: every probe got a
//             grade), 1 = at least one did not (or a probe never
//             ran, reported separately as ERROR), 2 = usage error.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSupervisedProbe, summarizeSupervised } from "./lib/converse.mjs";
import { hitNames, readEntries, sessionMeasures } from "./lib/pi-session.mjs";
import { networkFor, SANDBOX_EXEC, sandboxAvailable, sandboxProfile } from "./lib/sandbox.mjs";
import { createPersona } from "./lib/supervisor.mjs";
import { checkProbe, createJudge } from "./lib/probe-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

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
    want: ["pysam", "genomic-intelligence"],
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
  const opts = {
    model: "deepseek/deepseek-v4-flash",
    timeout: 180,
    keep: false,
    thinking: null,
    probes: null,
    only: null,
    results: null,
    resume: false,
    offline: false,
    sandbox: true,
    attempts: 3,
    responses: 5,
    promptSkills: "none",
    extension: true,
    packageDir: null,
    packageLabel: null,
    endpoint: "listed",
    gateCalls: 0,
    findRanker: "bm25f",
    modelsJson: null,
    warmup: false,
    archiveTo: null,
    supervisorModel: "claude-opus-5-5",
    judgeModel: "claude-fable-5-1",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--model") opts.model = next();
    else if (arg === "--timeout") opts.timeout = Number(next());
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--thinking") opts.thinking = next();
    else if (arg === "--probes") opts.probes = resolve(next());
    else if (arg === "--only") opts.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--results") opts.results = resolve(next());
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--offline") opts.offline = true;
    else if (arg === "--no-sandbox") opts.sandbox = false;
    else if (arg === "--attempts") opts.attempts = Number(next());
    else if (arg === "--responses") opts.responses = Number(next());
    else if (arg === "--supervisor-model") opts.supervisorModel = next();
    else if (arg === "--judge-model") opts.judgeModel = next();
    else if (arg === "--prompt-skills") opts.promptSkills = next();
    else if (arg === "--no-extension") opts.extension = false;
    else if (arg === "--package-dir") opts.packageDir = resolve(next());
    else if (arg === "--package-label") opts.packageLabel = next();
    else if (arg === "--endpoint") opts.endpoint = next();
    else if (arg === "--gate-calls") opts.gateCalls = Number(next());
    else if (arg === "--find-ranker") opts.findRanker = next();
    else if (arg === "--models-json") opts.modelsJson = resolve(next());
    else if (arg === "--warmup") opts.warmup = true;
    else if (arg === "--archive-to") opts.archiveTo = resolve(next());
    else die(`unknown option ${arg}`);
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) die("--timeout must be a positive number");
  for (const key of ["attempts", "responses"]) {
    if (!Number.isInteger(opts[key]) || opts[key] < 1) die(`--${key} must be a positive integer`);
  }
  if (!["core", "none", "all"].includes(opts.promptSkills)) die("--prompt-skills must be none, core or all");
  if (!["listed", "read", "first-find"].includes(opts.endpoint)) die("--endpoint must be listed, read or first-find");
  if (opts.endpoint === "first-find" && (opts.attempts !== 1 || !opts.extension)) {
    die("--endpoint first-find needs --attempts 1 and the extension (it records the first sci_find query)");
  }
  if (!["current", "bm25f"].includes(opts.findRanker)) die("--find-ranker must be current or bm25f");
  if (opts.modelsJson && !existsSync(opts.modelsJson)) die(`no models.json at ${opts.modelsJson}`);
  if (!Number.isInteger(opts.gateCalls) || opts.gateCalls < 0) die("--gate-calls must be a non-negative integer");
  if (opts.packageDir && !existsSync(join(opts.packageDir, "package.json"))) die(`no package.json in ${opts.packageDir}`);
  if (opts.promptSkills === "all" && opts.endpoint === "listed") {
    die("--prompt-skills all needs --endpoint read: the system prompt already lists every target");
  }
  if (opts.resume && !opts.results) die("--resume needs --results");
  return opts;
}

/**
 * Probes from a JSON file: `[{skill, task, accept[], namesPlatform, untestable?}]`.
 * `untestable` holds the reason a skill cannot be tested in this harness
 * (testing/README.md); such a probe loads but never runs.
 *
 * `target` is kept apart from `accept` so a report can say how often the
 * probe's own skill came back, not only whether something acceptable did — a
 * broad accept list would otherwise inflate the score.
 */
function loadProbes(file, coreSkills) {
  if (!existsSync(file)) die(`no probe file at ${file}`);
  const skillsDir = join(root, "skills");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.probes;
  if (!Array.isArray(list)) die(`${file}: expected an array or {probes: [...]}`);
  return list.map((entry) => {
    for (const name of [entry.skill, ...(entry.accept ?? [])]) {
      if (!existsSync(join(skillsDir, name, "SKILL.md"))) die(`${file}: no skill named "${name}"`);
    }
    // A task that names its own skill tests string matching, not search. Whole
    // words only: "Shapley" does not name shap. (Skill names are [a-z0-9-].)
    const task = entry.task.toLowerCase();
    const leaks = [entry.skill, entry.skill.replaceAll("-", " "), entry.skill.replaceAll("-", "")];
    if (leaks.some((form) => new RegExp(`\\b${form}\\b`).test(task))) die(`${file}: the task for "${entry.skill}" names the skill`);
    if (entry.untestable !== undefined && (typeof entry.untestable !== "string" || !entry.untestable.trim())) {
      die(`${file}: "untestable" for "${entry.skill}" must be a non-empty reason`);
    }
    return {
      id: entry.skill,
      task: entry.task,
      target: entry.skill,
      want: [entry.skill, ...(entry.accept ?? [])],
      core: coreSkills.includes(entry.skill),
      namesPlatform: entry.namesPlatform === true,
      untestable: entry.untestable ?? null,
    };
  });
}

/** Harness failures: they say nothing about the model, so --resume runs them again. */
const RERUN_OUTCOMES = new Set(["no-run", "supervisor-error"]);

/** A result line for the probe as the probe file words it now. Lines from before `task` was recorded never match. */
const ranCurrentTask = (line, taskOf) => typeof line.task === "string" && line.task === taskOf.get(line.id);

/**
 * Probe ids already recorded in a results file, so --resume can skip them. A
 * line counts only if it ran the probe's current task text: a rewritten probe
 * is a new probe and runs again.
 */
function doneIds(file, taskOf) {
  if (!existsSync(file)) return new Set();
  const latest = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line);
      latest.set(entry.id, entry);
    } catch {
      // A line cut short by a kill mid-write: that probe simply runs again.
    }
  }
  return new Set(
    [...latest.values()]
      .filter((entry) => !RERUN_OUTCOMES.has(entry.outcome) && ranCurrentTask(entry, taskOf))
      .map((entry) => entry.id),
  );
}

/** Pack the package (`source`, a package tree) and extract it, so the run exercises what ships. */
function stageTarball(scratch, source) {
  const stage = join(scratch, "pkg");
  mkdirSync(stage, { recursive: true });
  // --silent: npm pack lists every file in the tarball on stderr, which buries
  // the probe results this script exists to show.
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", stage], {
    cwd: source,
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
 * An agent dir holding nothing but this package, its skills filter set to
 * `promptSkills`: empty (the configuration `/sci search` writes since 1.7.0,
 * so the run tests the shipped default; sci_find the only way in), the Core
 * profile (what `/sci search` wrote before 1.7.0), or `null` for no filter
 * (every skill listed). `extension: false` loads no extension (`extensions:
 * []`, pi's "none of this type"), so sci_find, /sci and the input hook are
 * absent — a plain skills install.
 *
 * Credentials and the model catalogue are copied in because isolating the agent
 * dir also isolates them: without this, every probe fails with "No API key
 * found" and the script reports a model that declined to call the tool, when in
 * fact no model ran. Copied at 0600 and deleted at exit, including under --keep.
 * models.json goes with them: it is where custom providers (a local Ollama or
 * MLX server) are declared, and without it a local model is not found at all.
 *
 * A model served on loopback needs no credentials, and the model can read
 * anything in its own agent dir, so for one the API keys are not copied at all.
 *
 * This is the SEED: each attempt gets its own copy (startAttempt), so nothing a
 * run writes there — pi's own state, or a model editing settings.json — reaches
 * the next one. The seed itself is outside every sandbox.
 */
function seedAgentDir(scratch, packageDir, promptSkills, { credentials, extension, modelsJson }) {
  const agentDir = join(scratch, "agent-seed");
  mkdirSync(agentDir, { recursive: true });
  const entry = {
    source: packageDir,
    ...(promptSkills !== null && { skills: promptSkills }),
    ...(!extension && { extensions: [] }),
  };
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [entry] }, null, 2)}\n`);

  const auth = join(realAgentDir, "auth.json");
  if (credentials && !existsSync(auth)) {
    die(`no credentials at ${auth} — run \`pi\` and /login first`, 1);
  }
  const names = credentials ? ["auth.json", "models-store.json", "models.json"] : ["models.json"];
  for (const name of names) {
    const from = name === "models.json" && modelsJson ? modelsJson : join(realAgentDir, name);
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

let probes;
if (opts.probes) {
  probes = loadProbes(opts.probes, core.skills);
} else {
  probes = PROBES;
  for (const probe of PROBES) {
    const overlap = probe.want.filter((skill) => core.skills.includes(skill));
    if (overlap.length > 0) {
      die(`probe "${probe.id}" wants ${overlap.join(", ")}, which Core already loads — it proves nothing`, 1);
    }
  }
}
// Declared untestable in this harness (testing/README.md): never run, always
// named, so a report states how many skills it did not cover.
const untestable = probes.filter((probe) => probe.untestable);
probes = probes.filter((probe) => !probe.untestable);
if (untestable.length > 0) {
  console.log(`untestable here, not run: ${untestable.map((probe) => probe.id).join(", ")} (testing/README.md)`);
}
/** Every probe's current task text, before --only narrows the list: results match on it. */
const taskOf = new Map(probes.map((probe) => [probe.id, probe.task]));
if (opts.only) {
  const skipped = opts.only.filter((id) => untestable.some((probe) => probe.id === id));
  if (skipped.length > 0) die(`--only names probe(s) declared untestable: ${skipped.join(", ")} (testing/README.md)`);
  const unknown = opts.only.filter((id) => !probes.some((probe) => probe.id === id));
  if (unknown.length > 0) die(`--only names unknown probe(s): ${unknown.join(", ")}`);
  probes = probes.filter((probe) => opts.only.includes(probe.id));
}

if (opts.offline) {
  const { loadExtensionModule } = await import(pathToFileURL(join(root, "scripts", "lib", "load-extension.mjs")).href);
  const search = await loadExtensionModule("extensions/search.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const top = search.DEFAULT_LIMIT;
  let targetInTop = 0;
  let wantInTop = 0;
  for (const probe of probes) {
    const names = search.search(catalog, probe.task, search.MAX_LIMIT).map((hit) => hit.entry.name);
    const rank = probe.target ? names.indexOf(probe.target) + 1 : 0;
    const anyWant = probe.want.some((skill) => names.slice(0, top).includes(skill));
    if (rank > 0 && rank <= top) targetInTop++;
    if (anyWant) wantInTop++;
    const shown = rank > 0 ? `#${rank}` : probe.target ? `>${search.MAX_LIMIT}` : "-";
    console.log(`${anyWant ? "ok  " : "MISS"} ${shown.padStart(4)}  ${probe.id}${probe.core ? " [core]" : ""}  top: ${names.slice(0, 3).join(", ") || "(nothing)"}`);
  }
  console.log(`\ntarget in top ${top}: ${targetInTop}/${probes.length} | any wanted skill in top ${top}: ${wantInTop}/${probes.length}`);
  console.log("Whole task text used as the query. A model writes its own, shorter query, so this is a floor on the probe, not a prediction.");
  process.exit(0);
}

const skip = opts.resume ? doneIds(opts.results, taskOf) : new Set();
const pending = probes.filter((probe) => !skip.has(probe.id));
if (skip.size > 0) console.log(`resume: ${probes.length - pending.length} probe(s) already in ${opts.results}, ${pending.length} to run`);

if (opts.sandbox && !sandboxAvailable()) {
  die(`${SANDBOX_EXEC} not found. The model has bash; pass --no-sandbox only if you accept that.`);
}

// realpath: /var is a symlink into /private, and the sandbox matches real paths.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sci-find-live-")));
const outDir = join(scratch, "transcripts");
mkdirSync(outDir, { recursive: true });

const network = networkFor(opts.model, realAgentDir, opts.modelsJson ?? undefined);
console.log(`model: ${opts.model} | thinking: ${opts.thinking ?? "default"}`);
console.log(
  opts.sandbox
    ? `sandbox: on | network: ${network.kind === "loopback" ? `localhost:${network.port} only` : "open (cloud provider)"}`
    : "sandbox: OFF — the model can read and write as you",
);
console.log("staging tarball…");
const packageDir = stageTarball(scratch, opts.packageDir ?? root);
const promptSkills = { core: [...core.skills], none: [], all: null }[opts.promptSkills];
const seedDir = seedAgentDir(scratch, packageDir, promptSkills, {
  credentials: network.kind !== "loopback",
  extension: opts.extension,
  modelsJson: opts.modelsJson,
});
const listing =
  promptSkills === null
    ? "every skill in the prompt"
    : promptSkills.length > 0
      ? `Core only — ${promptSkills.length} skills in the prompt`
      : "no skills in the prompt";
console.log(
  `package: ${opts.packageLabel ?? "this tree"} | endpoint: ${opts.endpoint} | gate: ${opts.gateCalls || "off"} | ranker: ${opts.findRanker}\n` +
    `agent dir seed: ${seedDir} (${listing}; ${opts.extension ? "extension loaded, sci_find available" : "extension NOT loaded, no sci_find"})\n`,
);
const skillsDir = join(packageDir, "skills");
const catalogue = new Set(readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md"))));

// Every agent dir may hold a copy of the real API key (seedAgentDir). A kill
// mid-run — Ctrl-C, a CI job timeout's SIGTERM — must not let a copy outlive
// the process, so clean up on every exit path, not only the successful one at
// the bottom of the script.
const agentDirs = new Set([seedDir]);
const cleanupAgentDirs = () => {
  for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
  agentDirs.clear();
};
process.on("exit", cleanupAgentDirs);

/** Signal pi and whatever its bash tool started: each run is its own process group. */
function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

/** The pi run in flight, so a signal can stop it rather than wait it out. */
let currentChild = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killGroup(currentChild, "SIGKILL");
    cleanupAgentDirs();
    // Re-raise the conventional 128+signum code (130 / 143) instead of this
    // script's own 0/1/2, so whatever killed it sees "killed", not a verdict.
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/**
 * A fresh attempt: its own agent dir (a copy of the seed), fake HOME, TMPDIR,
 * working directory and session file, and a sandbox profile that allows
 * nothing outside them except the package, read-only. Transcripts go to a
 * directory outside the sandbox, so no probe can read another's.
 */
function startAttempt(probeId, label) {
  const dir = join(scratch, "runs", probeId, label);
  const run = {
    label,
    agent: join(dir, "agent"),
    home: join(dir, "home"),
    tmp: join(dir, "tmp"),
    work: join(dir, "work"),
    sessionFile: join(dir, "session.jsonl"),
    transcripts: join(outDir, probeId),
    profile: null,
  };
  for (const path of [run.agent, run.home, run.tmp, run.work, run.transcripts]) mkdirSync(path, { recursive: true });
  for (const name of readdirSync(seedDir)) {
    copyFileSync(join(seedDir, name), join(run.agent, name));
    chmodSync(join(run.agent, name), 0o600);
  }
  agentDirs.add(run.agent);
  if (opts.sandbox) {
    run.profile = join(scratch, "profiles", `${probeId}-${label}.sb`);
    mkdirSync(dirname(run.profile), { recursive: true });
    writeFileSync(run.profile, sandboxProfile({ readWrite: [dir], readOnly: [packageDir], network }));
  }
  run.finish = () => {
    if (existsSync(run.sessionFile)) copyFileSync(run.sessionFile, join(run.transcripts, `${label}.session.jsonl`));
    rmSync(run.agent, { recursive: true, force: true });
    agentDirs.delete(run.agent);
  };
  return run;
}

/**
 * pi's environment: an allowlist, not a copy of ours. The model can run
 * `printenv`, and the parent environment carries session tokens, an SSH agent
 * socket and paths into the real home. A cloud provider may read its key from
 * the environment, so `*_API_KEY` passes through for one — never for a
 * loopback model, which needs none.
 */
const piEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL"].includes(name) ||
      (network.kind !== "loopback" && /^[A-Z0-9_]+_API_KEY$/.test(name)),
  ),
);

/**
 * One pi run, awaited rather than spawnSync'd: a synchronous loop never yields
 * to the event loop, so the SIGINT/SIGTERM handlers above could not run until
 * the whole batch finished — a kill only ended the current probe and the batch
 * moved on to the next, with the credential copy still on disk.
 *
 * stdout is piped to the transcript, not handed over as a file descriptor:
 * under sandbox-exec, node aborts at startup when its stdout is a file outside
 * the sandbox. Piped, never buffered: --mode json emits a cumulative
 * message_update per token.
 *
 * `stopWhen`, if given, is polled while pi runs; once it returns true the run
 * is stopped (`stoppedEarly`). The supervised mode stops a response the moment
 * the target is reached: nothing after that point changes the grade, and a
 * slow local model can spend many minutes reading the skill it just found.
 */
function runPi(run, args, transcript, timeoutMs, stopWhen) {
  const [command, argv] = opts.sandbox ? [SANDBOX_EXEC, ["-f", run.profile, "pi", ...args]] : ["pi", args];
  return new Promise((resolveRun) => {
    const child = spawn(command, argv, {
      cwd: run.work,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...piEnv, HOME: run.home, TMPDIR: run.tmp, PI_CODING_AGENT_DIR: run.agent, PI_SCI_FIND_RANKER: opts.findRanker },
    });
    currentChild = child;
    const out = createWriteStream(transcript);
    child.stdout.pipe(out);
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const stop = () => {
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    let stoppedEarly = false;
    const poll = stopWhen
      ? setInterval(() => {
          if (stoppedEarly || timedOut || !stopWhen()) return;
          stoppedEarly = true;
          stop();
        }, 2000)
      : null;
    let settled = false;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      currentChild = null;
      // Also ends anything the bash tool left running in the background.
      killGroup(child, "SIGKILL");
      const done = () => resolveRun({ status, stderr, timedOut, stoppedEarly, error });
      if (out.writableFinished) done();
      else {
        out.once("finish", done);
        if (!out.writableEnded) out.end();
      }
    };
    child.on("close", (status) => finish(status, undefined));
    child.on("error", (error) => finish(null, error));
  });
}

/** Did the model answer at all? A run that never reached it is a broken harness, not a verdict. */
function answeredIn(raw) {
  return raw.split("\n").some((line) => {
    try {
      const event = JSON.parse(line);
      return event.type === "message_end" && event.message?.role === "assistant";
    } catch {
      return false;
    }
  });
}

/** The line of pi's stderr worth showing: an error if there is one, else the last line. */
function stderrDetail(result) {
  const lines = (result.stderr ?? "").trim().split("\n").filter(Boolean);
  return lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? `pi exit ${result.status}`;
}

const failures = [];
/** Setup problems — reported separately so they can never read as a verdict. */
const errors = [];
/** One line per finished probe; also appended to --results the moment it lands. */
const records = [];
const record = (line) => {
  records.push(line);
  if (opts.results) appendFileSync(opts.results, `${JSON.stringify(line)}\n`);
};

const baseRecord = (probe) => ({
  id: probe.id,
  task: probe.task,
  target: probe.target ?? null,
  want: probe.want,
  core: probe.core === true,
  namesPlatform: probe.namesPlatform === true,
  model: opts.model,
  thinking: opts.thinking ?? "default",
  promptSkills: opts.promptSkills,
  extension: opts.extension,
  package: opts.packageLabel,
  endpoint: opts.endpoint,
  gateCalls: opts.gateCalls,
  findRanker: opts.findRanker,
  sandbox: opts.sandbox,
  date: new Date().toISOString().slice(0, 10),
});

if (opts.probes) {
  await runSupervised();
} else {
  await runGate();
}

/** --probes: each probe a supervised, multi-attempt conversation (scripts/lib/converse.mjs). */
async function runSupervised() {
  const personaDir = join(scratch, "persona");
  mkdirSync(personaDir);
  const persona = createPersona({ model: opts.supervisorModel, cwd: personaDir });
  const preflight = createPersona({ model: opts.supervisorModel, cwd: personaDir, delays: [] });
  try {
    await preflight.next("Preflight.", [{ assistant: "Here is the complete answer to your request." }]);
  } catch (error) {
    die(`the supervisor (${opts.supervisorModel} via the claude CLI) did not answer: ${error.message}`, 1);
  }
  const judge = createJudge({ model: opts.judgeModel, cwd: personaDir });
  console.log(`supervisor: ${opts.supervisorModel} | judge: ${opts.judgeModel} | ${opts.attempts} attempt(s) × ${opts.responses} response(s)\n`);

  /** One model response: a new session on the first, a continuation after. */
  const respond = async (run, message, response, stopWhen) => {
    const args = ["--session", run.sessionFile, "--mode", "json", "--model", opts.model];
    if (opts.thinking) args.push("--thinking", opts.thinking);
    args.push("-p", message);
    const transcript = join(run.transcripts, `${run.label}-r${response}.jsonl`);
    const result = await runPi(run, args, transcript, opts.timeout * 1000, stopWhen);
    if (result.stderr) writeFileSync(join(run.transcripts, `${run.label}-r${response}.stderr.txt`), result.stderr);
    return {
      // A stop on reach follows a tool result, so the model has answered.
      answered: result.stoppedEarly || answeredIn(readFileSync(transcript, "utf8")),
      timedOut: result.timedOut,
      stoppedEarly: result.stoppedEarly,
      detail: stderrDetail(result),
    };
  };

  if (opts.warmup && pending.length > 0) await warmup(respond);

  let harnessErrorsInARow = 0;
  for (const [index, probe] of pending.entries()) {
    console.error(`[${index + 1}/${pending.length}] ${probe.id}${probe.core ? " [core]" : ""}`);
    const started = Date.now();
    const result = await runSupervisedProbe(probe, {
      startAttempt,
      respond,
      persona,
      catalogue,
      limits: { attempts: opts.attempts, responses: opts.responses },
      endpoint: opts.endpoint,
      gateCalls: opts.gateCalls,
      log: (line) => console.error(`  ${line}`),
    });
    // A judge failure is recorded on the line, not treated as a harness error.
    const probeCheck = await checkProbe(probe, result, { judge, transcriptsDir: outDir, skillsDir });
    if (probeCheck) {
      console.error(
        `  probe check: ${probeCheck.error ? `ERROR — ${probeCheck.error}` : probeCheck.invalid ? "INVALID" : "valid"}` +
          (probeCheck.verdicts[0] ? ` — ${probeCheck.verdicts[0].reason}` : ""),
      );
    }
    record({
      ...baseRecord(probe),
      supervisor: opts.supervisorModel,
      limits: { attempts: opts.attempts, responses: opts.responses, timeoutSeconds: opts.timeout },
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      ...result,
      ...(probeCheck && { probeCheck }),
    });
    const verdict =
      result.outcome === "graded"
        ? `${result.grade} (target or accepted: ${result.wantGrade})`
        : `${result.outcome.toUpperCase()}${result.detail ? ` — ${result.detail}` : ""}`;
    console.error(`  → ${verdict}`);

    if (RERUN_OUTCOMES.has(result.outcome)) {
      errors.push(`${probe.id}: ${result.outcome} (${result.detail}) — a setup failure, not a result`);
      if (++harnessErrorsInARow >= 3) {
        console.error("\n3 harness errors in a row — stopping. Fix the setup, then run again with --resume.");
        break;
      }
    } else {
      harnessErrorsInARow = 0;
    }
  }

  const all = opts.results && existsSync(opts.results)
    ? readFileSync(opts.results, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        // Lines from before --prompt-skills existed all ran with Core. A line
        // for an older task text (a rewritten probe) is not this probe's result.
        .filter(
          (line) =>
            line.model === opts.model &&
            line.supervisor &&
            (line.promptSkills ?? "core") === opts.promptSkills &&
            (line.extension ?? true) === opts.extension &&
            (line.endpoint ?? "listed") === opts.endpoint &&
            (line.findRanker ?? "current") === opts.findRanker &&
            ranCurrentTask(line, taskOf),
        )
    : records;
  summarizeSupervised(all);
}

/**
 * One ungraded request before the first probe. It pays the cold prefill of
 * the system prompt (about 23k tokens with every skill listed), which llama.cpp
 * then keeps in its prefix cache, so that cost does not fall inside the first
 * probe's time budget. Its own cost is a result, recorded apart.
 */
async function warmup(respond) {
  const run = startAttempt("_warmup", "w1");
  const started = Date.now();
  let turn;
  try {
    turn = await respond(run, "Reply with the single word OK. Do not use any tool.", 1, null);
  } finally {
    run.finish();
  }
  const line = {
    kind: "warmup",
    at: new Date(started).toISOString(),
    model: opts.model,
    package: opts.packageLabel,
    promptSkills: opts.promptSkills,
    extension: opts.extension,
    answered: turn.answered,
    timedOut: turn.timedOut,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    ...sessionMeasures(readEntries(join(run.transcripts, "w1.session.jsonl"))),
  };
  console.error(
    `warmup: ${line.answered ? "answered" : `NO ANSWER (${turn.detail})`} in ${line.elapsedSeconds}s,` +
      ` first prompt ${line.firstPromptTokens ?? "?"} tokens`,
  );
  if (opts.results) appendFileSync(opts.results.replace(/\.jsonl$/, "") + ".warmup.jsonl", `${JSON.stringify(line)}\n`);
}

/** Default mode: the three built-in probes, one response each, no supervisor. */
async function runGate() {
  for (const [index, probe] of pending.entries()) {
    process.stderr.write(`[${index + 1}/${pending.length}] ${probe.id} … `);
    const base = baseRecord(probe);

    const piArgs = ["--no-session", "--mode", "json", "--model", opts.model];
    if (opts.thinking) piArgs.push("--thinking", opts.thinking);
    piArgs.push("-p", probe.task);

    const run = startAttempt(probe.id, "a1");
    const transcript = join(run.transcripts, "a1-r1.jsonl");
    const started = Date.now();
    let result;
    try {
      result = await runPi(run, piArgs, transcript, opts.timeout * 1000);
    } finally {
      run.finish();
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);

    if (result.timedOut) {
      console.error(`TIMEOUT after ${opts.timeout}s`);
      failures.push(`${probe.id}: timed out`);
      record({ ...base, outcome: "timeout", elapsedSeconds: Number(elapsed) });
      continue;
    }

    const raw = readFileSync(transcript, "utf8");
    if (result.stderr) writeFileSync(join(run.transcripts, "a1-r1.stderr.txt"), result.stderr);

    // Reporting a run that never reached the model as "never called sci_find"
    // would be exactly the confident wrong answer this package refuses to give.
    if (!answeredIn(raw)) {
      const detail = stderrDetail(result);
      console.error(`NO RUN (${elapsed}s) — ${detail}`);
      errors.push(`${probe.id}: the model never answered (${detail}) — this is a setup failure, not a result`);
      record({ ...base, outcome: "no-run", elapsedSeconds: Number(elapsed), detail });
      continue;
    }

    const calls = toolCalls(raw);
    const found = calls.filter((call) => call.tool === "sci_find");
    const tools = [...new Set(calls.map((call) => call.tool))];

    // Match on the `## name` headings sci_find prints, never on a substring of
    // its output: `polars` is a substring of `polars-bio`, and every hit's
    // description mentions other skills by name.
    const hitSet = new Set(found.flatMap((call) => hitNames(call.result)));
    const surfaced = probe.want.filter((skill) => hitSet.has(skill));
    const readSkills = [
      ...new Set(
        calls
          .filter((call) => call.tool === "read")
          .map((call) => String(call.args?.filePath ?? call.args?.path ?? ""))
          .map((path) => path.match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1])
          .filter(Boolean),
      ),
    ];
    const readSkill = probe.want.some((skill) => readSkills.includes(skill));

    record({
      ...base,
      outcome: "answered",
      elapsedSeconds: Number(elapsed),
      sciFindCalls: found.length,
      queries: found.map((call) => call.args?.query ?? (call.args?.profile ? `profile:${call.args.profile}` : "")),
      surfaced,
      readSkills,
      tools,
    });

    if (found.length === 0) {
      console.error(`NO CALL (${elapsed}s) — tools used: ${tools.join(", ") || "none"}`);
      failures.push(
        `${probe.id}: never called sci_find. The tool description or the alias table is the fix, not the test.`,
      );
      continue;
    }

    // Secondary, reported but not gating: did the search surface a usable skill,
    // and did the model go on to read it? A model that calls the tool and then
    // ignores it is a weaker signal than one that never called, but still worth
    // seeing.
    console.error(
      `called sci_find ×${found.length} (${elapsed}s)` +
        ` | surfaced: ${surfaced.join(", ") || "none of the expected"}` +
        ` | read SKILL.md: ${readSkill ? "yes" : "no"}`,
    );

    if (surfaced.length === 0) {
      failures.push(`${probe.id}: called sci_find, but none of [${probe.want.join(", ")}] came back`);
    }
  }
}

// Goes regardless of --keep — only transcripts and workspaces are worth keeping.
cleanupAgentDirs();
if (opts.archiveTo) {
  mkdirSync(opts.archiveTo, { recursive: true });
  cpSync(outDir, join(opts.archiveTo, "transcripts"), { recursive: true });
  if (existsSync(join(scratch, "runs"))) {
    execFileSync("tar", ["-czf", join(opts.archiveTo, "workspaces.tgz"), "-C", scratch, "runs"]);
  }
  console.log(`\narchived: ${opts.archiveTo}`);
}
if (opts.keep) {
  console.log(`\ntranscripts: ${outDir}\nworkspaces: ${join(scratch, "runs")}`);
} else {
  rmSync(scratch, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.log(`\nERROR — ${errors.length} probe(s) never ran; no conclusion can be drawn for them.`);
  for (const error of errors) console.log(`  [ERROR] ${error}`);
  process.exit(1);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
