#!/usr/bin/env node
// The pre-registered outcomes of a find-ab run
// (testing/runs/2026-09-29-openrouter-ab.md) from its run directory: the
// analysis set, the primary read-rate comparison new − old (pooled over styles,
// Newcombe method 10 and a bootstrap over probes), and the secondary measures
// from the result lines and the archived session files.
//
// A unit is one probe in one style. Its two styles share a target, so the
// bootstrap resamples whole probes.
//
//   node scripts/find-ab-report.mjs <run-dir> [-o <file>]
//
// Report on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analysisSet, clusterBootstrapDiff, mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";
import { choiceTurn, listedNames, promptTokens, textOf } from "./lib/replay.mjs";
import { median } from "./lib/server-log.mjs";

const ARMS = ["old", "new"];
/** Fixed before the run: non-inferior when both lower bounds are above −5 points. */
const MARGIN = -0.05;
const BOOTSTRAP = { resamples: 10000, seed: 1 };

function parseArgs(argv) {
  const opts = { runDir: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      opts.output = argv[++i];
      if (!opts.output) usage(2, "--output needs a file");
    } else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.runDir === null) opts.runDir = resolve(arg);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.runDir === null) usage(2, "a run directory is required");
  if (!existsSync(join(opts.runDir, "order.tsv"))) usage(2, `order.tsv not found in ${opts.runDir}`);
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-ab-report.mjs <run-dir> [-o <file>]");
  process.exit(code);
}

const jsonLines = (file) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

/** order.tsv → [{chunk, style, probe, id}], `id` = "<style>/<probe>". */
export const readOrder = (runDir) =>
  readFileSync(join(runDir, "order.tsv"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [chunk, style, probe] = line.split("\t");
      return { chunk: Number(chunk), style, probe, id: `${style}/${probe}` };
    });

/** Unit id → the last results line of one arm (a --resume re-run replaces a no-run). */
const lastRows = (runDir, arm, styles) =>
  new Map(styles.flatMap((style) => jsonLines(join(runDir, `results-${arm}-${style}.jsonl`)).map((row) => [`${style}/${row.id}`, row])));

/** Unit id → the newest archived a1.session.jsonl of one arm. Archive dirs are named <tag>-<epoch>. */
function sessionFiles(runDir, arm, styles) {
  const files = new Map();
  for (const style of styles) {
    const base = join(runDir, "archive", `${arm}-${style}`);
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).sort((p, q) => Number(p.split("-").pop()) - Number(q.split("-").pop()));
    for (const dir of dirs) {
      const transcripts = join(base, dir, "transcripts");
      if (!existsSync(transcripts)) continue;
      for (const probe of readdirSync(transcripts)) {
        const file = join(transcripts, probe, "a1.session.jsonl");
        if (existsSync(file)) files.set(`${style}/${probe}`, file);
      }
    }
  }
  return files;
}

/** What the first sci_find turn of a session shows: hits, characters, target listed, choice-turn prompt tokens. */
export function firstFindFacts(entries, target) {
  const turn = choiceTurn(entries);
  if (!turn) return null;
  const texts = turn.results.map((entry) => textOf(entry.message));
  const names = texts.flatMap(listedNames);
  return {
    hits: names.length,
    chars: texts.reduce((total, text) => total + text.length, 0),
    targetListed: names.includes(target),
    choiceTokens: turn.choice ? promptTokens(turn.choice.message?.usage) : null,
  };
}

const points = (x) => (100 * x).toFixed(1);
const count = (values, predicate) => values.filter(predicate).length;
const share = (x, n) => `${x}/${n} (${n ? points(x / n) : "-"}%)`;
const round = (x) => (Number.isFinite(x) ? Math.round(x) : "-");
const tenth = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : "-");
const tally = (values) => {
  const out = new Map();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return [...out].sort((p, q) => q[1] - p[1]).map(([key, n]) => `${key} ${n}`).join(", ") || "-";
};

function comparisonLine(label, ids, x, y) {
  const { a, b, c, d } = pairCounts(ids, x, y);
  const n = ids.length;
  if (n === 0) return `  ${label}: no units`;
  const [low, high] = newcombePaired(a, b, c, d);
  return (
    `  ${label.padEnd(25)} n ${String(n).padEnd(4)} new ${a + b}/${n} old ${a + c}/${n} | diff ${points((b - c) / n)} pts, ` +
    `Newcombe 95% CI ${points(low)} to ${points(high)} | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toPrecision(2)}`
  );
}

function armLines(arm, rows, facts, ids) {
  const attempts = ids.map((id) => rows.get(id).attempts[0]);
  const searched = ids.filter((id) => rows.get(id).attempts[0].sciFindCalls > 0);
  const found = ids.map((id) => facts.get(id)).filter(Boolean);
  const limits = attempts.flatMap((a) => a.firstFind?.calls ?? []).map((call) => call.limit ?? "none");
  const missedFirst = ids.filter((id) => facts.get(id) && !facts.get(id).targetListed);
  return [
    `${arm}: read ${share(count(attempts, (a) => a.endedBy === "reached"), ids.length)} | ended: ${tally(attempts.map((a) => a.endedBy))}`,
    `  searched ${share(searched.length, ids.length)}; read when searched ${share(count(searched, (id) => rows.get(id).attempts[0].endedBy === "reached"), searched.length)}`,
    `  sci_find calls per attempt: mean ${tenth(attempts.reduce((t, a) => t + a.sciFindCalls, 0) / ids.length)}, two or more ${share(count(attempts, (a) => a.sciFindCalls >= 2), ids.length)}`,
    `  first search: hits ${tally(found.map((f) => f.hits))} | characters median ${round(median(found.map((f) => f.chars)))} | target listed ${share(count(found, (f) => f.targetListed), found.length)}`,
    `  target not in the first list: ${missedFirst.length}; searched again ${count(missedFirst, (id) => rows.get(id).attempts[0].sciFindCalls >= 2)}, read anyway ${count(missedFirst, (id) => rows.get(id).attempts[0].endedBy === "reached")}`,
    `  limit set in the first search call: ${tally(limits)}`,
    `  medians: first prompt ${round(median(attempts.map((a) => a.firstPromptTokens)))} | choice-turn prompt ${round(median(found.map((f) => f.choiceTokens).filter(Number.isFinite)))} | peak context ${round(median(attempts.map((a) => a.peakContext)))} | output tokens ${round(median(attempts.map((a) => a.outputTokens)))} | tool calls ${median(attempts.map((a) => a.toolCalls))}`,
    `  provider errors ${attempts.reduce((t, a) => t + (a.providerErrors?.length ?? 0), 0)} | timeouts ${count(attempts, (a) => a.timedOut)} | probe-invalid ${ids.filter((id) => rows.get(id).probeCheck?.invalid).join(", ") || "none"}`,
  ];
}

function pairedMedianLine(label, ids, value, unit) {
  const both = ids.filter((id) => Number.isFinite(value("new", id)) && Number.isFinite(value("old", id)));
  const diffs = both.map((id) => value("new", id) - value("old", id));
  return (
    `  ${label.padEnd(30)} n ${String(both.length).padEnd(4)} median new ${tenth(median(both.map((id) => value("new", id))))}${unit}, ` +
    `old ${tenth(median(both.map((id) => value("old", id))))}${unit} | paired median new − old ${tenth(median(diffs))}${unit} | new lower on ${count(diffs, (x) => x < 0)}`
  );
}

export function report(runDir) {
  const order = readOrder(runDir);
  const styles = [...new Set(order.map((entry) => entry.style))];
  const rows = Object.fromEntries(ARMS.map((arm) => [arm, lastRows(runDir, arm, styles)]));
  const set = analysisSet(order, ARMS.map((arm) => rows[arm]));
  const unit = new Map(order.map((entry) => [entry.id, entry]));
  const facts = Object.fromEntries(
    ARMS.map((arm) => {
      const files = sessionFiles(runDir, arm, styles);
      const out = new Map();
      for (const id of set.ids) {
        if (!files.has(id)) continue;
        out.set(id, firstFindFacts(jsonLines(files.get(id)), rows[arm].get(id).target));
      }
      return [arm, out];
    }),
  );
  const read = (arm) => (id) => rows[arm].get(id).attempts[0].endedBy === "reached";
  const probes = [...new Set(set.ids.map((id) => unit.get(id).probe))];
  const clusters = probes.map((probe) => set.ids.filter((id) => unit.get(id).probe === probe).map((id) => [read("new")(id), read("old")(id)]));
  const { a, b, c, d } = pairCounts(set.ids, read("new"), read("old"));
  const n = set.ids.length;
  const [low, high] = n ? newcombePaired(a, b, c, d) : [NaN, NaN];
  const [bootLow, bootHigh] = n ? clusterBootstrapDiff(clusters, BOOTSTRAP) : [NaN, NaN];
  const verdict = !n ? "no data" : low > MARGIN && bootLow > MARGIN ? "non-inferior" : high < 0 && bootHigh < 0 ? "inferior" : "inconclusive";
  const invalid = new Set(set.ids.filter((id) => ARMS.some((arm) => rows[arm].get(id).probeCheck?.invalid)));
  const searchedBoth = set.ids.filter((id) => ARMS.every((arm) => rows[arm].get(id).attempts[0].sciFindCalls > 0));
  // Provider trouble: a retried provider error (for example a 429) or a timeout in either arm.
  const clean = set.ids.filter((id) =>
    ARMS.every((arm) => {
      const attempt = rows[arm].get(id).attempts[0];
      return !attempt.providerErrors?.length && !attempt.timedOut;
    }),
  );

  const lines = [
    `Analysis set: chunks ${set.complete.join(" ") || "none"} complete in both arms; ${n} units (${probes.length} probes; ${styles
      .map((style) => `${style} ${count(set.ids, (id) => unit.get(id).style === style)}`)
      .join(", ")}).`,
    `Chunks not complete (left out): ${set.incomplete.join(" ") || "none"}. Harness errors (left out in both arms): ${set.harnessErrors.join(", ") || "none"}.`,
    "",
    `Primary: new − old, attempt-1 read rate, all styles pooled, paired by unit (margin ${points(MARGIN)} pts)`,
    `  n ${n} | new ${a + b}/${n} old ${a + c}/${n} | diff ${n ? points((b - c) / n) : "-"} pts | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toPrecision(2)}`,
    `  Newcombe 95% CI ${points(low)} to ${points(high)} | bootstrap over ${probes.length} probes 95% CI ${points(bootLow)} to ${points(bootHigh)}`,
    `  verdict: ${verdict}`,
    "",
    "Secondary: read rate by subset",
    ...styles.map((style) => comparisonLine(style, set.ids.filter((id) => unit.get(id).style === style), read("new"), read("old"))),
    comparisonLine("searched in both arms", searchedBoth, read("new"), read("old")),
    comparisonLine("without probe-invalid", set.ids.filter((id) => !invalid.has(id)), read("new"), read("old")),
    comparisonLine("no provider error/timeout", clean, read("new"), read("old")),
    `  discordant: ${
      set.ids
        .filter((id) => read("new")(id) !== read("old")(id))
        .map((id) => {
          const [winner, loser] = read("new")(id) ? ["new", "old"] : ["old", "new"];
          const miss = rows[loser].get(id).attempts[0];
          const listed = facts[loser].get(id)?.targetListed;
          return `${id} (${winner} only; ${loser} ${miss.endedBy}, sci_find calls ${miss.sciFindCalls}, target in first list ${listed ?? "no search"})`;
        })
        .join("; ") || "none"
    }`,
    "",
    ...ARMS.flatMap((arm) => [...armLines(arm, rows[arm], facts[arm], set.ids), ""]),
    "Secondary: paired medians",
    pairedMedianLine("first prompt tokens", set.ids, (arm, id) => rows[arm].get(id).attempts[0].firstPromptTokens, ""),
    pairedMedianLine("choice-turn prompt tokens", set.ids, (arm, id) => facts[arm].get(id)?.choiceTokens, ""),
    pairedMedianLine("first search characters", set.ids, (arm, id) => facts[arm].get(id)?.chars, ""),
    pairedMedianLine("time to read (both read)", set.ids.filter((id) => read("new")(id) && read("old")(id)), (arm, id) => rows[arm].get(id).attempts[0].endpointSeconds, " s"),
    "",
    `Session files found: ${ARMS.map((arm) => `${arm} ${facts[arm].size}/${n}`).join(", ")}; no sci_find turn: ${ARMS.map((arm) => `${arm} ${count([...facts[arm].values()], (f) => f === null)}`).join(", ")}.`,
    `Probe-invalid in either arm (left out of "without probe-invalid"): ${[...invalid].join(", ") || "none"}.`,
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const text = report(opts.runDir);
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
