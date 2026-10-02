#!/usr/bin/env node
// Run the probe check (scripts/lib/probe-check.mjs) on a finished results file.
//
// The live test runs the check as each probe finishes. This runs it again
// afterwards: on a run made before the check existed or before its rule
// changed, or with another judge model. It reads the transcripts the run kept
// (test-find-live.mjs --keep prints the path), judges every graded probe the
// rule selects, and writes the latest line per probe id with a fresh
// `probeCheck` (or none, when no attempt qualifies). The input file is not
// changed. The summary goes to stderr.
//
// Usage:
//   node scripts/check-probes.mjs <results.jsonl> --transcripts <dir> [-o <file>]
//
//   --transcripts <dir>  The run's transcripts directory: <dir>/<id>/<label>.session.jsonl.
//   --skills <dir>       Skill sources, default skills/ in this repo.
//   --judge-model <id>   Default claude-fable-5-1.
//   -o, --output <file>  Checked results, one JSON line per probe. Default stdout.
//
// Exit codes: 0 = done (check errors are recorded on their lines),
//             1 = runtime error, 2 = usage error.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeSupervised } from "./lib/converse.mjs";
import { checkProbe, createJudge } from "./lib/probe-check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function die(message, code = 2) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { results: null, transcripts: null, skills: join(root, "skills"), judgeModel: "claude-fable-5-1", output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--transcripts") opts.transcripts = resolve(next());
    else if (arg === "--skills") opts.skills = resolve(next());
    else if (arg === "--judge-model") opts.judgeModel = next();
    else if (arg === "-o" || arg === "--output") opts.output = resolve(next());
    else if (arg.startsWith("-")) die(`unknown option ${arg}`);
    else if (!opts.results) opts.results = resolve(arg);
    else die(`unexpected argument ${arg}`);
  }
  if (!opts.results) die("give a results file");
  if (!opts.transcripts) die("--transcripts is required");
  for (const path of [opts.results, opts.transcripts, opts.skills]) if (!existsSync(path)) die(`not found: ${path}`);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const lines = readFileSync(opts.results, "utf8")
  .split("\n")
  .flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return []; // A line cut short by a kill mid-write.
    }
  });
const latest = [...new Map(lines.map((line) => [line.id, line])).values()];

// Outside the repo, so no project settings or CLAUDE.md reach the judge.
const judgeDir = mkdtempSync(join(tmpdir(), "check-probes-"));
const judge = createJudge({ model: opts.judgeModel, cwd: judgeDir });
const checked = [];
try {
  for (const line of latest) {
    const { probeCheck: _old, ...rest } = line;
    if (line.outcome !== "graded") {
      checked.push(rest);
      continue;
    }
    const probeCheck = await checkProbe({ id: line.id, target: line.target, task: line.task }, line, {
      judge,
      transcriptsDir: opts.transcripts,
      skillsDir: opts.skills,
    });
    if (probeCheck) {
      const verdict = probeCheck.error ? `ERROR — ${probeCheck.error}` : probeCheck.invalid ? "INVALID" : "valid";
      console.error(`${line.id} (${line.grade}): ${verdict}${probeCheck.verdicts[0] ? ` — ${probeCheck.verdicts[0].reason}` : ""}`);
    }
    checked.push(probeCheck ? { ...rest, probeCheck } : rest);
  }
} catch (error) {
  console.error(`check failed: ${error.stack ?? error}`);
  process.exit(1);
} finally {
  rmSync(judgeDir, { recursive: true, force: true });
}

const text = checked.map((line) => JSON.stringify(line)).join("\n") + "\n";
if (opts.output) writeFileSync(opts.output, text);
else process.stdout.write(text);
summarizeSupervised(checked, (line) => console.error(line));
