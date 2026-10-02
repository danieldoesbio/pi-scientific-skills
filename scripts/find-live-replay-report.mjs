#!/usr/bin/env node
// The pre-registered outcomes of a choice-turn replay
// (testing/runs/2026-09-27-find-compact-replay.md) from the results.jsonl of
// scripts/find-live-replay.mjs: the analysis set, the validity check (full
// replay against the recorded choice), the primary paired comparison of
// <variant> − full (Newcombe method 10 CI, non-inferiority at −5 points,
// McNemar exact) and the secondary measures. <variant> is compact (the
// default) or bm25f (testing/runs/2026-09-27-find-ranker.md).
//
//   node scripts/find-live-replay-report.mjs <replay-out-dir> [--variant compact|bm25f] [-o <file>]
//
// Report on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";
import { REPLAY_RULES, replayAnalysisSet, replayValidity, verdictOf } from "./lib/replay.mjs";
import { median } from "./lib/server-log.mjs";

/** Fixed before the run (the pre-registration). */
const { margin: MARGIN, validitySlack: VALIDITY_SLACK, maxPromptFailures: MAX_PROMPT_FAILURES } = REPLAY_RULES;
const RANK_GROUPS = [
  ["1", (rank) => rank === 1],
  ["2", (rank) => rank === 2],
  ["3–6", (rank) => rank >= 3 && rank <= 6],
  ["7+ or not in the first list", (rank) => rank === 0 || rank > 6],
];

function parseArgs(argv) {
  const opts = { out: null, output: null, variant: "compact" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") opts.output = argv[++i];
    else if (arg === "--variant") opts.variant = argv[++i];
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.out === null) opts.out = resolve(arg);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.out === null) usage(2, "a replay output directory is required");
  if (opts.output === undefined) usage(2, "--output needs a file");
  if (!["compact", "bm25f"].includes(opts.variant)) usage(2, "--variant takes compact or bm25f");
  if (!existsSync(join(opts.out, "results.jsonl"))) usage(2, `results.jsonl not found in ${opts.out}`);
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-live-replay-report.mjs <replay-out-dir> [--variant compact|bm25f] [-o <file>]");
  process.exit(code);
}

const points = (x) => (100 * x).toFixed(1);
const count = (values, predicate) => values.filter(predicate).length;
const tally = (values) => {
  const out = new Map();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return [...out].sort((p, q) => q[1] - p[1]).map(([key, n]) => `${key} ${n}`).join(", ") || "none";
};

/** One paired comparison line: first − second on a binary outcome. */
function comparisonLine(label, ids, first, second, margin) {
  const n = ids.length;
  if (n === 0) return `  ${label}: no probes`;
  const { a, b, c, d } = pairCounts(ids, first.hit, second.hit);
  const [low, high] = newcombePaired(a, b, c, d);
  const verdict = margin == null ? "" : ` | margin ${points(margin)}: ${verdictOf(low, high, margin)}`;
  return (
    `  ${label.padEnd(26)} n ${String(n).padEnd(4)} ${first.name} ${a + b}/${n} ${second.name} ${a + c}/${n} | ` +
    `diff ${points((b - c) / n)} pts, 95% CI ${points(low)} to ${points(high)} | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toPrecision(2)}${verdict}`
  );
}

/** Medians of a paired numeric measure and of the per-probe difference <variant> − full. */
function pairedLine(label, ids, pairs, value, variant) {
  const both = ids.filter((id) => value(pairs.get(id).full) != null && value(pairs.get(id)[variant]) != null);
  const diffs = both.map((id) => value(pairs.get(id)[variant]) - value(pairs.get(id).full));
  return (
    `  ${label.padEnd(20)} n ${String(both.length).padEnd(4)} median full ${median(both.map((id) => value(pairs.get(id).full)))}, ` +
    `${variant} ${median(both.map((id) => value(pairs.get(id)[variant])))} | paired median ${variant} − full ${median(diffs)} | ${variant} lower on ${count(diffs, (x) => x < 0)}`
  );
}

function report(lines, variant) {
  const set = replayAnalysisSet(lines, variant);
  const { ids, pairs } = set;
  const view = (name, pick) => ({ name, hit: (id) => pick(id) === "target" });
  const full = view("full", (id) => pairs.get(id).full.outcome);
  const compact = view(variant, (id) => pairs.get(id)[variant].outcome);
  const recorded = view("recorded", (id) => pairs.get(id).full.recorded.outcome);
  const { recordedHits, fullHits, promptFailures, faithful } = replayValidity(set);
  const rankOf = (id) => pairs.get(id).full.targetRank;

  const out = [
    `Analysis set: ${ids.length} probes (both variants ok, full-replay prompt-token parity, same system prompt and tools within the probe).`,
    `Left out: excluded ${set.excluded.length}, errors ${set.errors.length}, parity failures ${set.parityFailures.length}, hash mismatches ${set.hashMismatches.length}.`,
    ...[...set.excluded, ...set.errors].map((line) => `  ${line}`),
    ...(set.parityFailures.length ? [`  parity failures: ${set.parityFailures.join(", ")}`] : []),
    ...(set.hashMismatches.length ? [`  hash mismatches: ${set.hashMismatches.join(", ")}`] : []),
    "",
    "Validity: full replay against the recorded choice turn (target read)",
    comparisonLine("full replay − recorded", ids, full, recorded, null),
    `  rule 1: full replay ≥ recorded − ${VALIDITY_SLACK} (${recordedHits - VALIDITY_SLACK}); full replay ${fullHits} → ${fullHits >= recordedHits - VALIDITY_SLACK ? "met" : "NOT met"}`,
    `  rule 2: parity failures + hash mismatches ≤ ${MAX_PROMPT_FAILURES}; ${promptFailures} → ${promptFailures <= MAX_PROMPT_FAILURES ? "met" : "NOT met"}`,
    `  ${faithful ? "faithful" : "NOT faithful: no comparison is reported"}`,
    "",
    "Outcomes of the choice turn:",
    `  full:     ${tally(ids.map((id) => pairs.get(id).full.outcome))}`,
    `  ${`${variant}:`.padEnd(9)} ${tally(ids.map((id) => pairs.get(id)[variant].outcome))}`,
    `  recorded: ${tally(ids.map((id) => pairs.get(id).full.recorded.outcome))}`,
  ];
  if (!faithful) return `${out.join("\n")}\n`;

  const inBoth = ids.filter((id) => pairs.get(id).full.listed?.full && pairs.get(id).full.listed?.[variant]);
  out.push(
    "",
    `Primary: ${variant} − full, target read in the choice turn, paired by probe (Newcombe method 10)`,
    comparisonLine("all", ids, compact, full, MARGIN),
    "Secondary: the format alone (target listed in both variants)",
    ids.every((id) => pairs.get(id).full.listed)
      ? comparisonLine("target in both lists", inBoth, compact, full, MARGIN)
      : "  not available: results.jsonl lines lack the `listed` field (written before it was added)",
    `  discordant: ${ids
      .filter((id) => full.hit(id) !== compact.hit(id))
      .map((id) => {
        const { full: f, [variant]: c } = pairs.get(id);
        const loser = full.hit(id) ? c : f;
        return `${id} (rank ${rankOf(id)}; ${loser.variant} ${loser.outcome}${loser.reads?.length ? ` ${loser.reads.join("+")}` : ""})`;
      })
      .join("; ") || "none"}`,
    "",
    "By the target's rank in the first hit list:",
    ...RANK_GROUPS.map(([label, inGroup]) => {
      const group = ids.filter((id) => inGroup(rankOf(id)));
      return `  rank ${label.padEnd(28)} n ${String(group.length).padEnd(4)} full ${count(group, full.hit)} | ${variant} ${count(group, compact.hit)}`;
    }),
    "",
    "Secondary measures (paired):",
    pairedLine("sci_find chars", ids, pairs, (row) => row.sciFindChars, variant),
    pairedLine("prompt tokens", ids, pairs, (row) => row.promptTokens, variant),
    pairedLine("output tokens", ids, pairs, (row) => row.outputTokens, variant),
    "",
    "Seconds (the second request of a probe reuses the cached prefix, so position-1 rows only are compared):",
    ...["full", variant].map((name) => {
      const at = (order) => ids.map((id) => pairs.get(id)[name]).filter((row) => row.order === order && row.seconds != null).map((row) => row.seconds);
      const [first, second] = [at(1), at(2)];
      return `  ${name.padEnd(8)} position 1: n ${String(first.length).padEnd(4)} median ${median(first)?.toFixed(1)} s | position 2: n ${String(second.length).padEnd(4)} median ${median(second)?.toFixed(1)} s`;
    }),
  );
  return `${out.join("\n")}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lines = readFileSync(join(opts.out, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const text = report(lines, opts.variant);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
