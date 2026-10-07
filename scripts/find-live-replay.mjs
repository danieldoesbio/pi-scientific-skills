#!/usr/bin/env node
// Replay the choice turn of a find-live run with a different sci_find result
// format (testing/runs/2026-09-27-find-compact-replay.md).
//
// For each attempt of one arm, the recorded session is cut after the tool
// results of its first sci_find call. Two copies go to the model: `full`, the
// recorded result as it was, and `compact`, the same hits in rank order
// rendered by extensions/catalog.ts's compact format. A third copy, `bm25f`
// (testing/runs/2026-09-27-find-ranker.md), re-runs each sci_find call of the
// turn through the extension's own runToolSearch with PI_SCI_FIND_RANKER=bm25f,
// in the full format; the same call under the current ranker must reproduce
// the recorded result byte for byte first, so this runs only from the tree
// the run was recorded on, or one that ranks the same (lib/rank-bench.mjs).
// One request per copy,
// through pi's own SDK (scripts/lib/replay-worker.mjs), with the arm's frozen
// package and the recorded working directory. Arm order alternates by probe.
//
//   node scripts/find-live-replay.mjs <run-dir> --out <dir> [--arm v17]
//     [--model <id>] [--thinking medium] [--probes a,b] [--max N]
//     [--variants full,compact|full,bm25f] [--flip-order] [--prove-stub] [--resume] [--timeout 900]
//     [--dry-run]
//
// --dry-run prepares every attempt and checks the parser gate without the
// model server, and writes nothing to results.jsonl. Otherwise the model
// server must be running. Results: <out>/results.jsonl, one line per probe and
// variant; session copies in <out>/sessions/. Progress on stderr.
// Exit 0 when done, 1 on a runtime error or 3 harness errors in a row, 2 on
// bad arguments. Analysis: scripts/find-live-replay-report.mjs.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPiDist, loadExtensionModule } from "./lib/load-extension.mjs";
import { NO_OLD_RANKER, hasOldRanker } from "./lib/rank-bench.mjs";
import { choiceTurn, classifyChoice, listedNames, parseHits, promptTokens, textOf, truncateAndReplace } from "./lib/replay.mjs";

const VARIANTS = ["full", "compact", "bm25f"];
const DEFAULT_VARIANTS = ["full", "compact"];
const WORKER = fileURLToPath(new URL("./lib/replay-worker.mjs", import.meta.url));

function parseArgs(argv) {
  const opts = { runDir: null, out: null, arm: "v17", model: "prism-llama/Ternary-Bonsai-2-27B-PQ2_0", thinking: "medium",
    probes: null, max: Infinity, variants: DEFAULT_VARIANTS, flipOrder: false, proveStub: false, resume: false, timeout: 900, dryRun: false };
  const value = (i) => argv[i] ?? usage(2, `${argv[i - 1]} needs a value`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") opts.out = resolve(value(++i));
    else if (arg === "--arm") opts.arm = value(++i);
    else if (arg === "--model") opts.model = value(++i);
    else if (arg === "--thinking") opts.thinking = value(++i);
    else if (arg === "--probes") opts.probes = new Set(value(++i).split(","));
    else if (arg === "--max") opts.max = Number(value(++i));
    else if (arg === "--variants") opts.variants = value(++i).split(",");
    else if (arg === "--timeout") opts.timeout = Number(value(++i));
    else if (arg === "--flip-order") opts.flipOrder = true;
    else if (arg === "--prove-stub") opts.proveStub = true;
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.runDir === null) opts.runDir = resolve(arg);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!opts.runDir || !opts.out) usage(2, "a run directory and --out are required");
  if (opts.variants.length !== 2 || opts.variants[0] !== "full" || !VARIANTS.slice(1).includes(opts.variants[1])) {
    usage(2, "--variants takes full,compact or full,bm25f");
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0 || !(opts.max > 0)) usage(2, "--timeout and --max take positive numbers");
  for (const need of ["order.tsv", `results-${opts.arm}.jsonl`, join("src", opts.arm, "package.json")]) {
    if (!existsSync(join(opts.runDir, need))) usage(2, `${need} not found in ${opts.runDir}`);
  }
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-live-replay.mjs <run-dir> --out <dir> [--arm v17] [--probes a,b] [--max N] [--variants full,compact|full,bm25f] [--flip-order] [--prove-stub] [--resume]");
  process.exit(code);
}

const jsonLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** The model server must answer before any request is made. */
async function checkServer(realAgentDir, model) {
  const provider = model.split("/")[0];
  const models = JSON.parse(readFileSync(join(realAgentDir, "models.json"), "utf8"));
  const baseUrl = models.providers?.[provider]?.baseUrl;
  if (!baseUrl) throw new Error(`provider ${provider} not in ${join(realAgentDir, "models.json")}`);
  const health = `${new URL(baseUrl).origin}/health`;
  const ok = await fetch(health).then((response) => response.ok, () => false);
  if (!ok) throw new Error(`the model server does not answer at ${health}; start it first`);
}

/** An agent dir with only the frozen package (no skills listed) and the model catalogue. */
function seedAgentDir(out, packageDir, realAgentDir) {
  const seed = join(out, "agent-seed");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "settings.json"), `${JSON.stringify({ packages: [{ source: packageDir, skills: [] }] }, null, 2)}\n`);
  copyFileSync(join(realAgentDir, "models.json"), join(seed, "models.json"));
  chmodSync(join(seed, "models.json"), 0o600);
  return seed;
}

/**
 * Every variant of one attempt's choice turn, or `{excluded: reason}`.
 * `render`: (hits, format, limit) → text, from extensions/catalog.ts.
 * `rerun`: (args, ranker, skillsDir) → the sci_find text for these arguments
 * under that ranker, with paths under the recorded `skillsDir`.
 * `targetRank`: the target's place in the first hit list (0 when absent);
 * `bm25fRank` the same for the bm25f copy.
 * `listed`: whether any hit list of the turn names the target, per variant.
 */
function prepare(entries, target, render, rerun) {
  const turn = choiceTurn(entries);
  if (!turn) return { excluded: "no sci_find call" };
  if (!turn.choice) return { excluded: "no recorded choice turn" };
  const results = turn.results.filter((entry) => entry.message.toolName === "sci_find");
  const compact = new Map();
  const listed = { full: false, compact: false, bm25f: false };
  let targetRank = null;
  let skillsDir = null;
  for (const result of results) {
    const text = textOf(result.message);
    const parsed = parseHits(text);
    if (parsed.kind === "other") continue;
    if (parsed.kind === "malformed") return { error: `unparsed sci_find result (${result.id})` };
    if (render(parsed.hits, "full", parsed.hits.length) !== text) return { error: `full format does not reproduce the recorded result (${result.id})` };
    const short = render(parsed.hits, "compact", turn.argsById.get(result.message.toolCallId)?.limit);
    compact.set(result.id, short);
    targetRank ??= parsed.hits.findIndex((hit) => hit.name === target) + 1;
    skillsDir ??= dirname(parsed.hits[0].dir);
    listed.full ||= parsed.hits.some((hit) => hit.name === target);
    listed.compact ||= listedNames(short).includes(target);
  }
  if (compact.size === 0) return { excluded: "no query hits in the choice turn" };
  const bm25f = new Map();
  let bm25fRank = null;
  for (const result of results) {
    const args = turn.argsById.get(result.message.toolCallId) ?? {};
    if (rerun(args, "current", skillsDir) !== textOf(result.message)) {
      return { error: `the current ranker does not reproduce the recorded result (${result.id})` };
    }
    const text = rerun(args, "bm25f", skillsDir);
    bm25f.set(result.id, text);
    const names = listedNames(text);
    if (parseHits(text).kind === "hits") bm25fRank ??= names.indexOf(target) + 1;
    listed.bm25f ||= names.includes(target);
  }
  return {
    cwd: entries[0].cwd,
    targetRank,
    bm25fRank: bm25fRank ?? 0,
    listed,
    recorded: { ...classifyChoice(turn.choice.message, target), promptTokens: promptTokens(turn.choice.message.usage) },
    sessions: {
      full: truncateAndReplace(entries, turn.cut, new Map()),
      compact: truncateAndReplace(entries, turn.cut, compact),
      bm25f: truncateAndReplace(entries, turn.cut, bm25f),
    },
  };
}

function runWorker(jobFile, env, cwd, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [WORKER, jobFile], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const search = await loadExtensionModule("extensions/search.ts");
  // Every attempt is checked against the ranker it was recorded under.
  if (!hasOldRanker(search)) throw new Error(NO_OLD_RANKER);
  if (!opts.dryRun) await checkServer(realAgentDir, opts.model);
  const catalog = await loadExtensionModule("extensions/catalog.ts");
  const { MAX_LIMIT } = search;
  const descriptions = catalog.skillIndex();
  const render = (hits, format, limit) => {
    const count = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : format === "compact" ? catalog.COMPACT_DEFAULT_LIMIT : hits.length;
    const entries = hits.slice(0, count).map((hit) => ({ entry: { ...hit, description: descriptions.get(hit.name)?.description ?? "" }, score: 0 }));
    return catalog.formatHits(entries, format);
  };
  const rerun = (args, ranker, skillsDir) => {
    const before = process.env.PI_SCI_FIND_RANKER;
    process.env.PI_SCI_FIND_RANKER = ranker;
    try {
      return catalog.runToolSearch(args, "full").replaceAll(`${catalog.SKILLS_DIR}/`, `${skillsDir}/`);
    } finally {
      if (before === undefined) delete process.env.PI_SCI_FIND_RANKER;
      else process.env.PI_SCI_FIND_RANKER = before;
    }
  };

  for (const dir of ["sessions", "jobs", "work"]) mkdirSync(join(opts.out, dir), { recursive: true });
  const seed = seedAgentDir(opts.out, join(opts.runDir, "src", opts.arm), realAgentDir);
  const resultsFile = join(opts.out, "results.jsonl");
  const done = new Set(
    opts.resume && existsSync(resultsFile) ? jsonLines(resultsFile).filter((l) => l.status !== "error").map((l) => `${l.probe}/${l.variant}`) : [],
  );
  const append = (line) => writeFileSync(resultsFile, `${JSON.stringify(line)}\n`, { flag: "a" });
  const rows = new Map(jsonLines(join(opts.runDir, `results-${opts.arm}.jsonl`)).map((row) => [row.id, row]));
  const order = readFileSync(join(opts.runDir, "order.tsv"), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t"));

  let included = 0;
  const dry = { excluded: [], errors: [], ranks: [], bm25fRanks: [], full: [], compact: [], bm25f: [], recorded: [], cutOff: [], notListed: [], bm25fNotListed: [] };
  let errorsInRow = 0;
  for (const [chunk, probe] of order) {
    if (included >= opts.max) break;
    if (opts.probes && !opts.probes.has(probe)) continue;
    const file = join(opts.runDir, "archive", opts.arm, `chunk-${chunk.padStart(2, "0")}`, "transcripts", probe, "a1.session.jsonl");
    const target = rows.get(probe)?.target ?? probe;
    const base = { probe, chunk: Number(chunk), target };
    if (!existsSync(file)) {
      if (!done.has(`${probe}/null`)) append({ ...base, variant: null, status: "excluded", reason: "no session file" });
      continue;
    }
    const prepared = prepare(jsonLines(file), target, render, rerun);
    if (opts.dryRun) {
      if (prepared.excluded) dry.excluded.push(`${probe}: ${prepared.excluded}`);
      else if (prepared.error) dry.errors.push(`${probe}: ${prepared.error}`);
      else {
        included++;
        dry.ranks.push(prepared.targetRank);
        dry.bm25fRanks.push(prepared.bm25fRank);
        if (!prepared.listed.bm25f) dry.bm25fNotListed.push(probe);
        dry.recorded.push(prepared.recorded.outcome);
        if (prepared.listed.full && !prepared.listed.compact) dry.cutOff.push(`${probe} (rank ${prepared.targetRank})`);
        if (!prepared.listed.full) dry.notListed.push(probe);
        for (const v of VARIANTS) dry[v].push(prepared.sessions[v].filter((e) => e.message?.toolName === "sci_find").reduce((n, e) => n + textOf(e.message).length, 0));
      }
      continue;
    }
    if (prepared.excluded || prepared.error) {
      if (!done.has(`${probe}/null`)) append({ ...base, variant: null, status: prepared.error ? "error" : "excluded", reason: prepared.excluded ?? prepared.error });
      continue;
    }
    const variants = (included + (opts.flipOrder ? 1 : 0)) % 2 === 0 ? opts.variants : [...opts.variants].reverse();
    included++;
    for (const [index, variant] of variants.entries()) {
      if (done.has(`${probe}/${variant}`)) continue;
      const name = `${probe}.${variant}`;
      const sessionFile = join(opts.out, "sessions", `${name}.session.jsonl`);
      writeFileSync(sessionFile, `${prepared.sessions[variant].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      const work = join(opts.out, "work", name);
      for (const sub of ["agent", "home", "tmp"]) mkdirSync(join(work, sub), { recursive: true });
      for (const f of readdirSync(seed)) copyFileSync(join(seed, f), join(work, "agent", f));
      const job = { piDist: findPiDist(), model: opts.model, thinking: opts.thinking, cwd: prepared.cwd, sessionFile,
        output: join(opts.out, "jobs", `${name}.out.json`), proveStub: opts.proveStub };
      const jobFile = join(opts.out, "jobs", `${name}.json`);
      writeFileSync(jobFile, JSON.stringify(job));
      const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? "en_US.UTF-8", HOME: join(work, "home"),
        TMPDIR: join(work, "tmp"), PI_CODING_AGENT_DIR: join(work, "agent"), PI_OFFLINE: "1" };
      console.error(`[${new Date().toISOString().slice(11, 19)}] ${probe} ${variant} (rank ${prepared.targetRank})`);
      const run = await runWorker(jobFile, env, work, opts.timeout * 1000);
      const result = existsSync(job.output) ? JSON.parse(readFileSync(job.output, "utf8")) : { ok: false, errorMessage: `worker exit ${run.code}: ${run.stderr.slice(-400)}` };
      const choice = result.ok ? classifyChoice(result.message, target) : null;
      const usage = result.message?.usage ?? {};
      const replayed = result.ok ? promptTokens(usage) : null;
      const sciFindChars = prepared.sessions[variant].filter((e) => e.message?.toolName === "sci_find").reduce((n, e) => n + textOf(e.message).length, 0);
      append({
        ...base, variant, order: index + 1, targetRank: prepared.targetRank, bm25fRank: prepared.bm25fRank, listed: prepared.listed, status: result.ok ? "ok" : "error",
        reason: result.ok ? undefined : result.errorMessage, outcome: choice?.outcome ?? null, reads: choice?.reads ?? null, calls: choice?.calls ?? null,
        promptTokens: replayed, inputTokens: usage.input ?? null, cachedTokens: usage.cacheRead ?? null, outputTokens: usage.output ?? null,
        thinkingChars: (result.message?.content ?? []).filter((p) => p.type === "thinking").reduce((n, p) => n + (p.thinking ?? "").length, 0),
        seconds: result.seconds ?? null, sciFindChars, recorded: prepared.recorded,
        parity: variant === "full" && result.ok ? replayed === prepared.recorded.promptTokens : null,
        model: result.model ?? null, thinkingLevel: result.thinkingLevel ?? null, systemPromptHash: result.systemPromptHash ?? null,
        toolsHash: result.toolsHash ?? null, toolResults: result.toolResults ?? undefined,
      });
      errorsInRow = result.ok ? 0 : errorsInRow + 1;
      if (!result.ok) console.error(`  error: ${result.errorMessage}`);
      if (errorsInRow >= 3) throw new Error("3 harness errors in a row; stopped (is the model server up?)");
    }
  }
  if (opts.dryRun) {
    const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
    console.error(`dry run: ${included} attempts prepared; ${dry.excluded.length} excluded; ${dry.errors.length} errors`);
    for (const line of [...dry.excluded, ...dry.errors]) console.error(`  ${line}`);
    const ranks = (values) => JSON.stringify(Object.fromEntries([...new Set(values)].sort((a, b) => a - b).map((r) => [r, values.filter((x) => x === r).length])));
    console.error(`target rank in the first hit list: ${ranks(dry.ranks)}`);
    console.error(`target rank in the first bm25f hit list: ${ranks(dry.bm25fRanks)}`);
    console.error(`sci_find text in the choice turn, median chars: full ${median(dry.full)}, compact ${median(dry.compact)}, bm25f ${median(dry.bm25f)}`);
    const tally = (values) => JSON.stringify(Object.fromEntries([...new Set(values)].map((v) => [v, values.filter((x) => x === v).length])));
    console.error(`recorded choice-turn outcome: ${tally(dry.recorded)}`);
    console.error(`target listed in full but cut off in compact: ${dry.cutOff.length}${dry.cutOff.length ? ` — ${dry.cutOff.join(", ")}` : ""}`);
    console.error(`target in no hit list of the choice turn: ${dry.notListed.length}${dry.notListed.length ? ` — ${dry.notListed.join(", ")}` : ""}`);
    console.error(`target in no bm25f hit list of the choice turn: ${dry.bm25fNotListed.length}${dry.bm25fNotListed.length ? ` — ${dry.bm25fNotListed.join(", ")}` : ""}`);
    return;
  }
  const lines = jsonLines(resultsFile).filter((l) => l.variant);
  for (const variant of opts.variants) {
    const ok = lines.filter((l) => l.variant === variant && l.status === "ok");
    console.error(`${variant}: ${ok.length} ok, target read ${ok.filter((l) => l.outcome === "target").length}` +
      (variant === "full" ? `, parity failures ${ok.filter((l) => l.parity === false).length}` : ""));
  }
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
