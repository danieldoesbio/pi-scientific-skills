#!/usr/bin/env node
// The pre-registered outcomes of a find-live-arms run
// (testing/runs/2026-09-25-night-arms.md) from its run directory: the
// analysis set, the per-arm measures, the two paired read-rate comparisons
// (Newcombe method 10 CI, McNemar exact) and the paired time to read.
// Server-side speed and warm-up come from scripts/find-live-timing.mjs; pass
// its --jsonl output as --timing to add the server-exact and queue-net times.
//
//   node scripts/find-live-arms-report.mjs <run-dir> [--timing <jsonl>] [-o <file>]
//
// Report on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analysisSet, mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";
import { median } from "./lib/server-log.mjs";

const ARMS = ["v16", "v17", "full"];
/** Fixed before the run: primary 1 is non-inferiority at −5 points, primary 2 has no margin. */
const COMPARISONS = [
  { name: "Primary 1", first: "v17", second: "v16", margin: -0.05 },
  { name: "Primary 2", first: "v17", second: "full", margin: null },
];

function parseArgs(argv) {
  const opts = { runDir: null, timing: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timing") opts.timing = argv[++i];
    else if (arg === "--output" || arg === "-o") opts.output = argv[++i];
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.runDir === null) opts.runDir = resolve(arg);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.runDir === null) usage(2, "a run directory is required");
  if (opts.timing === undefined) usage(2, "--timing needs a file");
  if (opts.output === undefined) usage(2, "--output needs a file");
  for (const name of ["order.tsv", ...ARMS.map((arm) => `results-${arm}.jsonl`)]) {
    if (!existsSync(join(opts.runDir, name))) usage(2, `${name} not found in ${opts.runDir}`);
  }
  if (opts.timing && !existsSync(opts.timing)) usage(2, `${opts.timing} not found`);
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-live-arms-report.mjs <run-dir> [--timing <jsonl>] [-o <file>]");
  process.exit(code);
}

const jsonLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Probe id → the last results line (a --resume re-run replaces a no-run). */
const lastRows = (runDir, arm) => new Map(jsonLines(join(runDir, `results-${arm}.jsonl`)).map((row) => [row.id, row]));

const readOrder = (runDir) =>
  readFileSync(join(runDir, "order.tsv"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [chunk, id] = line.split("\t");
      return { chunk: Number(chunk), id };
    });

const points = (x) => (100 * x).toFixed(1);
const tenth = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const count = (values, predicate) => values.filter(predicate).length;
const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
const tally = (values) => {
  const out = new Map();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return [...out].sort((p, q) => q[1] - p[1]).map(([key, n]) => `${key} ${n}`).join(", ");
};

function armLines(arm, rows, set) {
  const attempts = set.ids.map((id) => rows.get(id).attempts[0]);
  const read = (id) => rows.get(id).attempts[0].endedBy === "reached";
  const core = set.ids.filter((id) => rows.get(id).core);
  const nonCore = set.ids.filter((id) => !rows.get(id).core);
  return [
    `${arm}: read ${count(set.ids, read)}/${set.ids.length} | Core ${count(core, read)}/${core.length} | non-Core ${count(nonCore, read)}/${nonCore.length}`,
    `  ended: ${tally(attempts.map((a) => a.endedBy))}`,
    `  medians: first prompt ${median(attempts.map((a) => a.firstPromptTokens))} | peak context ${median(attempts.map((a) => a.peakContext))} (max ${Math.max(...attempts.map((a) => a.peakContext ?? 0))}) | tool calls ${median(attempts.map((a) => a.toolCalls))} | output tokens ${median(attempts.map((a) => a.outputTokens))}`,
    `  compactions ${sum(attempts.map((a) => a.compactions?.length))} | overflow errors ${sum(attempts.map((a) => a.overflows))} | listed without a read ${count(attempts, (a) => a.listed != null && a.endedBy !== "reached")} | attempt time ${Math.round(sum(attempts.map((a) => a.elapsedSeconds)) / 60)} min`,
    `  probe-invalid: ${set.ids.filter((id) => rows.get(id).probeCheck?.invalid).join(", ") || "none"}`,
  ];
}

function comparisonLine(label, ids, first, second, margin) {
  const { a, b, c, d } = pairCounts(ids, first.read, second.read);
  const n = ids.length;
  if (n === 0) return `  ${label}: no probes`;
  const [low, high] = newcombePaired(a, b, c, d);
  const verdict = margin == null ? "" : ` | non-inferior at ${points(margin)}: ${low > margin ? "yes" : "no"}`;
  return (
    `  ${label.padEnd(24)} n ${String(n).padEnd(4)} ${first.arm} ${a + b}/${n} ${second.arm} ${a + c}/${n} | ` +
    `diff ${points((b - c) / n)} pts, 95% CI ${points(low)} to ${points(high)} | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toPrecision(2)}${verdict}`
  );
}

function timeLine(label, ids, first, second, value) {
  const both = ids.filter((id) => first.read(id) && second.read(id) && value(first.arm, id) != null && value(second.arm, id) != null);
  const diffs = both.map((id) => value(first.arm, id) - value(second.arm, id));
  return (
    `  ${label.padEnd(30)} n ${String(both.length).padEnd(4)} median ${first.arm} ${tenth(median(both.map((id) => value(first.arm, id))))} s, ` +
    `${second.arm} ${tenth(median(both.map((id) => value(second.arm, id))))} s | paired median ${first.arm} − ${second.arm} ${tenth(median(diffs))} s | ` +
    `${first.arm} faster on ${count(diffs, (x) => x < 0)}`
  );
}

function report(opts) {
  const rows = Object.fromEntries(ARMS.map((arm) => [arm, lastRows(opts.runDir, arm)]));
  const set = analysisSet(readOrder(opts.runDir), ARMS.map((arm) => rows[arm]));
  const timing = new Map(
    opts.timing ? jsonLines(opts.timing).filter((t) => t.probe !== "_warmup").map((t) => [`${t.arm}/${t.probe}`, t]) : [],
  );
  const view = (arm) => ({ arm, read: (id) => rows[arm].get(id).attempts[0].endedBy === "reached" });
  const invalid = new Set(set.ids.filter((id) => ARMS.some((arm) => rows[arm].get(id).probeCheck?.invalid)));
  const core = set.ids.filter((id) => rows.v17.get(id).core);

  const lines = [
    `Analysis set: chunks ${set.complete.join(" ") || "none"} complete in all arms; ${set.ids.length} probes (Core ${core.length}, non-Core ${set.ids.length - core.length}).`,
    `Chunks not complete (left out): ${set.incomplete.join(" ") || "none"}. Harness errors (left out in all arms): ${set.harnessErrors.join(", ") || "none"}.`,
    "",
    ...ARMS.flatMap((arm) => armLines(arm, rows[arm], set)),
  ];
  for (const { name, first, second, margin } of COMPARISONS) {
    const [x, y] = [view(first), view(second)];
    lines.push(
      "",
      `${name}: ${first} − ${second}, attempt-1 read rate, paired by probe (Newcombe method 10)`,
      comparisonLine("all", set.ids, x, y, margin),
      comparisonLine("Core", core, x, y, null),
      comparisonLine("non-Core", set.ids.filter((id) => !core.includes(id)), x, y, null),
      comparisonLine("without probe-invalid", set.ids.filter((id) => !invalid.has(id)), x, y, margin),
      `  discordant: ${set.ids
        .filter((id) => x.read(id) !== y.read(id))
        .map((id) => {
          const [winner, loser] = x.read(id) ? [first, second] : [second, first];
          const miss = rows[loser].get(id).attempts[0];
          return `${id} (${winner} only; ${loser} ${miss.endedBy}, first seek call ${miss.firstSeekCall ?? "none"})`;
        })
        .join("; ") || "none"}`,
      "  time to read, probes read in both arms:",
      timeLine("recorded (endpointSeconds)", set.ids, x, y, (arm, id) => rows[arm].get(id).attempts[0].endpointSeconds),
    );
    if (opts.timing) {
      lines.push(
        timeLine("server-exact (post hoc)", set.ids, x, y, (arm, id) => timing.get(`${arm}/${id}`)?.endpointSecondsExact),
        timeLine("net of queue wait (post hoc)", set.ids, x, y, (arm, id) => timing.get(`${arm}/${id}`)?.endpointSecondsNet),
      );
    }
  }
  lines.push("", `Probe-invalid in any arm (left out of "without probe-invalid"): ${[...invalid].join(", ") || "none"}.`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const text = report(opts);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
