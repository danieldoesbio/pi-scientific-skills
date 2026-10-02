#!/usr/bin/env node
// The pre-registered pooled analysis of two choice-turn replay samples
// (testing/runs/2026-09-27-find-compact-replay-2.md): validity of each sample
// on its own, then compact − full over both samples, paired by probe and
// sample. Two 95% intervals: Newcombe method 10 on the (probe, sample) pairs,
// and a cluster bootstrap over probes (10,000 resamples, fixed seed). A
// verdict counts only when both intervals give it; otherwise inconclusive.
//
//   node scripts/find-live-replay-pooled.mjs <sample-1-dir> <sample-2-dir> [-o <file>]
//
// Report on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clusterBootstrapDiff, mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";
import { REPLAY_RULES, replayAnalysisSet, replayValidity, verdictOf } from "./lib/replay.mjs";

/** Fixed before the second sample (the pre-registration). */
const BOOTSTRAP = { resamples: 10000, seed: 20260927 };

function parseArgs(argv) {
  const opts = { dirs: [], output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") opts.output = argv[++i];
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.dirs.length < 2) opts.dirs.push(resolve(arg));
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.dirs.length !== 2) usage(2, "two replay output directories are required");
  if (opts.output === undefined) usage(2, "--output needs a file");
  for (const dir of opts.dirs) if (!existsSync(join(dir, "results.jsonl"))) usage(2, `results.jsonl not found in ${dir}`);
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-live-replay-pooled.mjs <sample-1-dir> <sample-2-dir> [-o <file>]");
  process.exit(code);
}

const points = (x) => (100 * x).toFixed(1);
const readLines = (dir) => readFileSync(join(dir, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const read = (row) => row.outcome === "target";

/** The pooled report for two analysis sets (one per sample). */
export function pooledReport(sets) {
  const { margin } = REPLAY_RULES;
  const out = [];
  const validity = sets.map((set, k) => {
    const v = replayValidity(set);
    out.push(
      `Sample ${k + 1}: analysis set ${set.ids.length}; full replay ${v.fullHits}, recorded ${v.recordedHits}; ` +
        `rule 1 ${v.rule1 ? "met" : "NOT met"}, rule 2 ${v.rule2 ? "met" : "NOT met"} (${v.promptFailures} prompt failures) → ${v.faithful ? "faithful" : "NOT faithful"}`,
    );
    return v;
  });
  if (!validity.every((v) => v.faithful)) return `${[...out, "A sample is not faithful: no comparison is reported."].join("\n")}\n`;

  const ids = sets[0].ids.filter((id) => sets[1].pairs.has(id));
  const keys = ids.flatMap((id) => [0, 1].map((k) => ({ id, k, pair: sets[k].pairs.get(id) })));
  const { a, b, c, d } = pairCounts(keys, (key) => read(key.pair.compact), (key) => read(key.pair.full));
  const n = keys.length;
  const newcombe = newcombePaired(a, b, c, d);
  const bootstrap = clusterBootstrapDiff(
    ids.map((id) => [0, 1].map((k) => [read(sets[k].pairs.get(id).compact), read(sets[k].pairs.get(id).full)])),
    BOOTSTRAP,
  );
  const verdicts = [newcombe, bootstrap].map(([low, high]) => verdictOf(low, high, margin));
  const verdict = verdicts[0] === verdicts[1] ? verdicts[0] : "inconclusive";
  const perSample = [0, 1].map((k) => {
    const hits = (variant) => ids.filter((id) => read(sets[k].pairs.get(id)[variant])).length;
    return `sample ${k + 1}: compact ${hits("compact")}/${ids.length}, full ${hits("full")}/${ids.length}`;
  });
  const lost = keys.filter((key) => read(key.pair.full) && !read(key.pair.compact)).map((key) => `${key.id}#${key.k + 1}`);
  const gained = keys.filter((key) => read(key.pair.compact) && !read(key.pair.full)).map((key) => `${key.id}#${key.k + 1}`);
  out.push(
    "",
    `Pooled: ${ids.length} probes in both analysis sets, ${n} (probe, sample) pairs; ${perSample.join("; ")}`,
    `  compact ${a + b}/${n}, full ${a + c}/${n} | diff ${points((b - c) / n)} pts | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toPrecision(2)}`,
    `  Newcombe method 10:           95% CI ${points(newcombe[0])} to ${points(newcombe[1])} → ${verdicts[0]}`,
    `  cluster bootstrap by probe:   95% CI ${points(bootstrap[0])} to ${points(bootstrap[1])} → ${verdicts[1]} (${BOOTSTRAP.resamples} resamples, seed ${BOOTSTRAP.seed})`,
    `  margin ${points(margin)}: ${verdict}${verdicts[0] === verdicts[1] ? "" : " (the two intervals disagree)"}`,
    ...(verdict === "non-inferior" && Math.max(newcombe[1], bootstrap[1]) < 0 ? ["  note: both upper bounds are below 0, so compact reads less often than full, by less than the margin"] : []),
    `  compact lost: ${lost.join(", ") || "none"}; compact gained: ${gained.join(", ") || "none"}`,
  );
  return `${out.join("\n")}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const text = pooledReport(opts.dirs.map((dir) => replayAnalysisSet(readLines(dir))));
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
