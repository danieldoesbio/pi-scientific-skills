#!/usr/bin/env node
// The locked held-out set (testing/runs/2026-09-27-find-ranker.md, "Held-out
// set" and the 2026-09-29 addendum), scored once: the request text of each
// cell is the query, as in the development table. Prints counts only, never
// the texts.
//
// Reads part-*.json ([{id, novice, terse}]) and leaks.json ({cells}: the
// "<id>.<style>" cells that name their own target, dropped) from <dir>, and
// maps each id to its target through testing/find-rank/paraphrases.json.
//
// Primary: bm25f top 3 against current top 8, paired by cell, per style and
// pooled (Newcombe method 10, McNemar exact). Secondary: top 1, 2, 3, 5 and 8
// and the no-hit share for both rankers.
//
//   node scripts/find-rank-heldout.mjs <dir> [-o <file>]
//
// Table on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mcnemarExact, newcombePaired, pairCounts } from "./lib/arms-report.mjs";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { topShare } from "./lib/rank-bench.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = ["novice", "terse"];
const RANKERS = ["current", "bm25f"];
const TOP_K = [1, 2, 3, 5, 8];
const MARGIN = -0.05;

function parseArgs(argv) {
  const opts = { dir: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      opts.output = argv[++i];
      if (!opts.output) usage(2, "--output needs a file");
    } else if (arg === "--help" || arg === "-h") usage(0);
    else if (arg.startsWith("-") || opts.dir) usage(2, `unexpected argument: ${arg}`);
    else opts.dir = arg;
  }
  if (!opts.dir) usage(2, "give the held-out directory");
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-rank-heldout.mjs <dir> [-o <file>]");
  process.exit(code);
}

/** @returns {{ style: string, query: string, target: string }[]} */
export function loadHeldOut(dir) {
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const targets = new Map(readJson(join(ROOT, "testing/find-rank/paraphrases.json")).rows.map((row) => [row.id, row.skill]));
  const dropped = new Set(readJson(join(dir, "leaks.json")).cells);
  const rows = readdirSync(dir)
    .filter((file) => /^part-\d+\.json$/.test(file))
    .sort()
    .flatMap((file) => readJson(join(dir, file)));
  const unknown = rows.filter((row) => !targets.has(row.id));
  if (unknown.length) throw new Error(`${unknown.length} held-out ids have no target`);
  return rows.flatMap((row) =>
    STYLES.filter((style) => !dropped.has(`${row.id}.${style}`)).map((style) => ({ style, query: row[style], target: targets.get(row.id) })),
  );
}

const pct = (x) => (100 * x).toFixed(1);

function primaryLine(label, cells) {
  const { a, b, c, d } = pairCounts(cells.keys(), (i) => cells[i].bm25f <= 3 && cells[i].bm25f > 0, (i) => cells[i].current <= 8 && cells[i].current > 0);
  const n = a + b + c + d;
  const [low, high] = newcombePaired(a, b, c, d);
  const diff = (b - c) / n;
  const verdict = diff >= 0 && low > MARGIN ? "met" : "not met";
  return (
    `  ${label.padEnd(7)} n ${String(n).padEnd(4)} bm25f top 3 ${a + b}/${n} (${pct((a + b) / n)}%) | current top 8 ${a + c}/${n} (${pct((a + c) / n)}%) | ` +
    `diff ${pct(diff)} pts, 95% CI ${pct(low)} to ${pct(high)} | discordant ${b}:${c}, McNemar exact p ${mcnemarExact(b, c).toFixed(2)} | bar: ${verdict}`
  );
}

export function heldOutReport(cells, rank) {
  const ranked = cells.map((cell) => ({
    ...cell,
    ...Object.fromEntries(RANKERS.map((ranker) => [ranker, rank(cell.query, ranker).indexOf(cell.target) + 1])),
    noHit: Object.fromEntries(RANKERS.map((ranker) => [ranker, rank(cell.query, ranker).length === 0])),
  }));
  const out = ["Primary: bm25f top 3 against current top 8, paired by cell (bar: diff >= 0 and lower bound above -5 pts, per style):"];
  for (const style of STYLES) out.push(primaryLine(style, ranked.filter((cell) => cell.style === style)));
  out.push(primaryLine("pooled", ranked), "", `Secondary: target in the top k (%), and the share with no hit:`);
  out.push(`  style    n    ranker  ${TOP_K.map((k) => `top${k}`.padStart(7)).join("")}  nohit`);
  for (const style of [...STYLES, "pooled"]) {
    const group = style === "pooled" ? ranked : ranked.filter((cell) => cell.style === style);
    for (const ranker of RANKERS) {
      const ranks = group.map((cell) => cell[ranker]);
      const noHit = group.filter((cell) => cell.noHit[ranker]).length / group.length;
      out.push(`  ${style.padEnd(7)}${String(group.length).padStart(4)}  ${ranker.padEnd(7)}${TOP_K.map((k) => pct(topShare(ranks, k)).padStart(7)).join("")}${pct(noHit).padStart(7)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const lists = new Map();
  const rank = (query, ranker) => {
    const key = `${ranker}\u0000${query}`;
    if (!lists.has(key)) lists.set(key, search.search(catalog, query, Math.max(...TOP_K), ranker).map((hit) => hit.entry.name));
    return lists.get(key);
  };
  const text = heldOutReport(loadHeldOut(opts.dir), rank);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
