#!/usr/bin/env node
// The query-writer panel's outcomes (testing/runs/2026-09-27-find-ranker.md,
// step 3) from the results of scripts/find-panel.sh: how often each writer
// searched, and whether its first query puts the target in the top 8 under
// the current ranker and under bm25f.
//
// Unit: one attempt. Its query is the first sci_find call of the first
// message that made one (`firstFind.calls[0]`); a message with several calls
// was written before any result, so the union of its queries is reported as
// a secondary. Each query runs through search() with the ranker's own
// no-match rule. The raw request text of the same attempts is ranked too, as
// a model-free comparison.
//
//   node scripts/find-panel-report.mjs <panel-dir>... [-o <file>]
//
// Reads results-<writer>-<style>.jsonl in each directory. Report on stdout
// (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";

const STYLES = ["original", "synonym", "plain", "expert"];
const RANKERS = ["current", "bm25f"];
const TOP = 8;
/** Fixed before the panel ran (the pre-registration). */
export const PANEL_RULES = { skipGain: 0.03 };

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
  console.error("usage: node scripts/find-panel-report.mjs <panel-dir>... [-o <file>]");
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

/** bm25f − current at top 8 over `rows` (each with .hit.current and .hit.bm25f), paired. */
function paired(rows, key = "hit") {
  const n = rows.length;
  const { a, b, c, d } = pairCounts(rows, (row) => row[key].bm25f, (row) => row[key].current);
  const [low, high] = n ? newcombePaired(a, b, c, d) : [NaN, NaN];
  return { n, current: a + c, bm25f: a + b, diff: n ? (b - c) / n : NaN, low, high, b, c, p: mcnemarExact(b, c) };
}

const pairedText = (s) =>
  s.n === 0
    ? "no queries"
    : `current ${s.current}/${s.n} (${share(s.current, s.n)}), bm25f ${s.bm25f}/${s.n} (${share(s.bm25f, s.n)}) | ` +
      `diff ${points(s.diff)} pts, 95% CI ${points(s.low)} to ${points(s.high)} | discordant ${s.b}:${s.c}, McNemar p ${s.p.toPrecision(2)}`;

export function panelReport(attempts, rank) {
  const inTop = (query, target) => Object.fromEntries(RANKERS.map((ranker) => [ranker, rank(query, ranker).slice(0, TOP).includes(target)]));
  const rows = attempts
    .filter((attempt) => attempt.category === "searched")
    .map((attempt) => {
      const queries = queriesOf(attempt.line.attempts[0]);
      const target = attempt.line.target;
      const union = queries.map((query) => inTop(query, target));
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
  out.push("", `Primary: target in the top ${TOP} for the first query, bm25f − current, paired by attempt (Newcombe method 10):`);
  const verdicts = [];
  for (const writer of writers) {
    for (const style of STYLES) {
      const group = rows.filter((row) => row.writer === writer && row.style === style);
      if (group.length) out.push(`  ${writer.padEnd(12)} ${style.padEnd(9)} ${pairedText(paired(group))}`);
    }
    const all = paired(rows.filter((row) => row.writer === writer));
    const plain = paired(rows.filter((row) => row.writer === writer && row.style === "plain"));
    verdicts.push({ writer, all, plain });
    out.push(`  ${writer.padEnd(12)} ${"pooled".padEnd(9)} ${pairedText(all)}`);
  }
  const everyone = paired(rows);
  out.push(`  ${"all writers".padEnd(22)} ${pairedText(everyone)}`);
  const noWorse = verdicts.filter((v) => v.all.n > 0 && !(v.all.diff >= 0));
  const skip = verdicts.every((v) => v.plain.n === 0 || v.plain.diff < PANEL_RULES.skipGain);
  out.push(
    "",
    "Rules:",
    `  no worse for every writer (pooled point estimate >= 0): ${noWorse.length === 0 ? "met" : `NOT met (${noWorse.map((v) => v.writer).join(", ")})`}`,
    `  better on average (all writers, lower bound > 0): ${everyone.low > 0 ? "met" : "NOT met"}`,
    `  plain-style gain per writer: ${verdicts.map((v) => `${v.writer} ${v.plain.n ? `${points(v.plain.diff)} pts` : "-"}`).join(", ")}` +
      ` → ${skip ? `under ${points(PANEL_RULES.skipGain)} for every writer: skip 4b` : "4b stays in the plan"}`,
    "",
    "Secondary: any query of the first sci_find message in the top 8:",
    ...writers.map((writer) => `  ${writer.padEnd(22)} ${pairedText(paired(rows.filter((row) => row.writer === writer), "union"))}`),
    "",
    "Model-free comparison: the request text itself as the query, same attempts:",
    ...writers.map((writer) => `  ${writer.padEnd(22)} ${pairedText(paired(rows.filter((row) => row.writer === writer), "raw"))}`),
  );
  const errors = attempts.filter((attempt) => attempt.category === "harness-error");
  if (errors.length) out.push("", `Harness errors (left out): ${errors.map((a) => `${a.writer}/${a.style}/${a.line.id}`).join(", ")}`);
  return `${out.join("\n")}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const rank = (query, ranker) => search.search(catalog, query, TOP, ranker).map((hit) => hit.entry.name);
  const text = panelReport(loadAttempts(opts.dirs), rank);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
