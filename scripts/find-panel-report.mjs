#!/usr/bin/env node
// The query-writer panel's outcomes (testing/runs/2026-09-27-find-ranker.md,
// step 3) from the results of scripts/find-panel.sh: how often each writer
// searched, and whether its first query puts the target in the top 8 under
// the current ranker and under bm25f.
//
// Unit: one attempt. Its query is the first query of the first message that
// called sci_find (`firstFind.calls`); a message with several calls was
// written before any result, so the union of its queries is reported as a
// secondary. Each query runs through search() with the ranker's own no-match
// rule. The raw request text of the same attempts is ranked too, as a
// model-free comparison.
//
// A target appears once per style, so pooled rows repeat it. They carry a
// cluster bootstrap by target next to Newcombe, as the pooled replay does.
//
//   node <out>/src/scripts/find-panel-report.mjs <panel-dir>... [-o <file>]
//
// Run the frozen copy: the rankers load from this script's own tree. Reads
// results-<writer>-<style>.jsonl in each directory. Report on stdout (or -o).
// Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { clusterBootstrapDiff, mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = ["original", "synonym", "plain", "expert"];
const RANKERS = ["current", "bm25f"];
const TOP = 8;
const BOOTSTRAP = { resamples: 10000, seed: 20260927 };
/**
 * Fixed before the panel ran (the pre-registration). A writer counts toward
 * a rule only with at least `minSearched` searched attempts over its styles
 * (`minPlain` in the plain style for the 4b rule).
 */
export const PANEL_RULES = { skipGain: 0.03, minSearched: 50, minPlain: 30 };

function parseArgs(argv) {
  const opts = { dirs: [], output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") opts.output = argv[++i] ?? usage(2, "--output needs a file");
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-")) opts.dirs.push(resolve(arg));
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.dirs.length === 0) usage(2, "at least one panel directory is required");
  for (const dir of opts.dirs) if (!existsSync(dir)) usage(2, `no directory ${dir}`);
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node <out>/src/scripts/find-panel-report.mjs <panel-dir>... [-o <file>]");
  process.exit(code);
}

/** The queries of the first sci_find message, in call order (a profile-only call has none). */
const queriesOf = (attempt) => (attempt.firstFind?.calls ?? []).map((call) => call.query?.trim()).filter(Boolean);

/** How an attempt ended, for the search-rate tally. */
export function category(line) {
  if (line.outcome !== "graded") return "harness-error";
  const attempt = line.attempts?.[0];
  if (!attempt) return "harness-error";
  if (attempt.endedBy === "searched") return queriesOf(attempt).length ? "searched" : "searched, no query";
  if (attempt.endedBy === "gated") return "gated";
  if (attempt.firstSeekCall != null) return "sought without sci_find";
  return attempt.endedBy;
}

/** The last line per probe id in each results file, with its writer and style. */
export function loadAttempts(dirs) {
  const out = [];
  for (const dir of dirs) {
    for (const file of readdirSync(dir).sort()) {
      const match = /^results-(.+)-(original|synonym|plain|expert)\.jsonl$/.exec(file);
      if (!match) continue;
      const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const latest = [...new Map(lines.map((line) => [line.id, line])).values()];
      for (const line of latest) out.push({ writer: match[1], style: match[2], line, category: category(line) });
    }
  }
  return out;
}

const points = (x) => (100 * x).toFixed(1);
const share = (n, d) => (d ? `${points(n / d)}%` : "-");

/**
 * bm25f − current over `rows` (each with row[key].current and row[key].bm25f),
 * paired by attempt; with `cluster`, also a bootstrap over targets.
 */
export function paired(rows, key = "hit", cluster = false) {
  const n = rows.length;
  if (n === 0) return { n };
  const { a, b, c, d } = pairCounts(rows, (row) => row[key].bm25f, (row) => row[key].current);
  const stats = { n, current: a + c, bm25f: a + b, diff: (b - c) / n, newcombe: newcombePaired(a, b, c, d), b, c, p: mcnemarExact(b, c) };
  if (!cluster) return stats;
  const byTarget = Map.groupBy(rows, (row) => row.line.target);
  const clusters = [...byTarget.values()].map((group) => group.map((row) => [row[key].bm25f, row[key].current]));
  return { ...stats, bootstrap: clusterBootstrapDiff(clusters, BOOTSTRAP), clusters: byTarget.size };
}

function pairedText(s) {
  if (s.n === 0) return "no data";
  const head = `current ${s.current}/${s.n} (${share(s.current, s.n)}), bm25f ${s.bm25f}/${s.n} (${share(s.bm25f, s.n)}) | diff ${points(s.diff)} pts`;
  const boot = s.bootstrap ? `; bootstrap by target (${s.clusters}) ${points(s.bootstrap[0])} to ${points(s.bootstrap[1])}` : "";
  return `${head} | Newcombe ${points(s.newcombe[0])} to ${points(s.newcombe[1])}${boot} | discordant ${s.b}:${s.c}, McNemar p ${s.p.toPrecision(2)}`;
}

/** The "better on average" rule: both lower bounds above 0. */
function betterVerdict(s) {
  if (s.n === 0) return "no data";
  const above = [s.newcombe[0] > 0, s.bootstrap[0] > 0];
  if (above.every(Boolean)) return "met";
  if (!above.some(Boolean)) return "not met";
  return "inconclusive (the two intervals disagree)";
}

export function panelReport(attempts, rank, rules = PANEL_RULES) {
  const inTop = (query, target) => Object.fromEntries(RANKERS.map((ranker) => [ranker, rank(query, ranker).slice(0, TOP).includes(target)]));
  const rows = attempts
    .filter((attempt) => attempt.category === "searched")
    .map((attempt) => {
      const target = attempt.line.target;
      const union = queriesOf(attempt.line.attempts[0]).map((query) => inTop(query, target));
      return {
        ...attempt,
        hit: union[0],
        union: Object.fromEntries(RANKERS.map((ranker) => [ranker, union.some((hit) => hit[ranker])])),
        raw: inTop(attempt.line.task, target),
      };
    });
  const writers = [...new Set(attempts.map((attempt) => attempt.writer))];
  const out = ["Search rate (attempts by how they ended; 'searched' has a query in its first sci_find message):"];
  for (const writer of writers) {
    for (const style of STYLES) {
      const group = attempts.filter((attempt) => attempt.writer === writer && attempt.style === style);
      if (group.length === 0) continue;
      const tally = new Map();
      for (const attempt of group) tally.set(attempt.category, (tally.get(attempt.category) ?? 0) + 1);
      const graded = group.filter((attempt) => attempt.category !== "harness-error").length;
      out.push(
        `  ${writer.padEnd(12)} ${style.padEnd(9)} n ${String(group.length).padEnd(4)} searched ${share(tally.get("searched") ?? 0, graded)} | ` +
          [...tally].sort((p, q) => q[1] - p[1]).map(([key, n]) => `${key} ${n}`).join(", "),
      );
    }
  }
  out.push("", `Primary: target in the top ${TOP} for the first query, bm25f − current, paired by attempt (95% CIs):`);
  const verdicts = [];
  for (const writer of writers) {
    for (const style of STYLES) {
      const group = rows.filter((row) => row.writer === writer && row.style === style);
      if (group.length) out.push(`  ${writer.padEnd(12)} ${style.padEnd(9)} ${pairedText(paired(group))}`);
    }
    const mine = rows.filter((row) => row.writer === writer);
    const all = paired(mine, "hit", true);
    const plain = paired(mine.filter((row) => row.style === "plain"));
    verdicts.push({ writer, all, plain, counts: all.n >= rules.minSearched, countsPlain: plain.n >= rules.minPlain });
    out.push(`  ${writer.padEnd(12)} ${"pooled".padEnd(9)} ${pairedText(all)}`);
  }
  const counted = verdicts.filter((v) => v.counts);
  const everyone = paired(rows.filter((row) => counted.some((v) => v.writer === row.writer)), "hit", true);
  out.push(`  ${"counted writers".padEnd(22)} ${pairedText(everyone)}`);
  const worse = counted.filter((v) => v.all.diff < 0);
  const plainCounted = verdicts.filter((v) => v.countsPlain);
  const skip = plainCounted.length > 0 && plainCounted.every((v) => v.plain.diff < rules.skipGain);
  const noWorse = counted.length === 0 ? "no data" : worse.length === 0 ? "met" : `NOT met (${worse.map((v) => v.writer).join(", ")})`;
  const gains = verdicts.map((v) => `${v.writer} ${v.countsPlain ? `${points(v.plain.diff)} pts` : `no data (${v.plain.n})`}`).join(", ");
  const skipText = plainCounted.length === 0 ? "no data: 4b stays in the plan" : skip ? `under ${points(rules.skipGain)} for every counted writer: skip 4b` : "4b stays in the plan";
  out.push(
    "",
    `Rules (a writer counts with >= ${rules.minSearched} searched attempts; ${rules.minPlain} in plain for the 4b rule):`,
    `  counted: ${verdicts.map((v) => `${v.writer} ${v.counts ? "yes" : `no (${v.all.n})`}`).join(", ")}`,
    `  no worse for every counted writer (pooled point estimate >= 0): ${noWorse}`,
    `  better on average (counted writers, Newcombe and bootstrap lower bounds > 0): ${betterVerdict(everyone)}`,
    `  plain-style gain: ${gains} → ${skipText}`,
    "",
    `Secondary: any query of the first sci_find message in the top ${TOP}:`,
    ...writers.map((writer) => `  ${writer.padEnd(22)} ${pairedText(paired(rows.filter((row) => row.writer === writer), "union", true))}`),
    "",
    "Model-free comparison: the request text itself as the query, same attempts:",
    ...writers.map((writer) => `  ${writer.padEnd(22)} ${pairedText(paired(rows.filter((row) => row.writer === writer), "raw", true))}`),
  );
  const errors = attempts.filter((attempt) => attempt.category === "harness-error");
  if (errors.length) out.push("", `Harness errors (left out): ${errors.map((a) => `${a.writer}/${a.style}/${a.line.id}`).join(", ")}`);
  return `${out.join("\n")}\n`;
}

/** Where the rankers come from, per panel directory. */
function sourceLines(dirs) {
  const here = realpathSync(ROOT);
  return dirs.map((dir) => {
    const frozen = join(dir, "src");
    const sources = existsSync(join(dir, "sources.txt")) ? readFileSync(join(dir, "sources.txt"), "utf8").trim() : "no sources.txt";
    const mine = existsSync(frozen) && realpathSync(frozen) === here;
    return `Sources: ${sources}; rankers ${mine ? "from that frozen copy" : "from ANOTHER tree, not the frozen copy"}`;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const rank = (query, ranker) => search.search(catalog, query, TOP, ranker).map((hit) => hit.entry.name);
  const text = `${sourceLines(opts.dirs).join("\n")}\n\n${panelReport(loadAttempts(opts.dirs), rank)}`;
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
