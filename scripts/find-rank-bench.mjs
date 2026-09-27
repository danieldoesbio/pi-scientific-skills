#!/usr/bin/env node
// Offline top-k rates of sci_find's rankers on the fixed query sets
// (scripts/lib/rank-bench.mjs): the share of queries whose target is in the
// top 1, 2, 3 and 8 hits, and the share with no hit at all. The rankers run
// through search(), so each one's no-match rule applies.
//
//   node scripts/find-rank-bench.mjs [--ranker current|bm25f] [-o <file>]
//
// Table on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { writeFileSync } from "node:fs";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { TOP_K, loadSets, topShare } from "./lib/rank-bench.mjs";

const RANKERS = ["current", "bm25f"];

function parseArgs(argv) {
  const opts = { rankers: RANKERS, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ranker") {
      const value = argv[++i];
      if (!RANKERS.includes(value)) usage(2, `--ranker must be one of ${RANKERS.join(", ")}`);
      opts.rankers = [value];
    } else if (arg === "--output" || arg === "-o") {
      opts.output = argv[++i];
      if (!opts.output) usage(2, "--output needs a file");
    } else if (arg === "--help" || arg === "-h") usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-rank-bench.mjs [--ranker current|bm25f] [-o <file>]");
  process.exit(code);
}

const pct = (x) => (100 * x).toFixed(1).padStart(6);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const sets = loadSets();
  const lines = [`set          n  ranker   ${TOP_K.map((k) => `top${k}`.padStart(6)).join("")}  nohit`];
  for (const [name, set] of Object.entries(sets)) {
    for (const ranker of opts.rankers) {
      const hits = set.map(({ query }) => search.search(catalog, query, Math.max(...TOP_K), ranker).map((hit) => hit.entry.name));
      const ranks = set.map((row, i) => hits[i].indexOf(row.target) + 1);
      const noHit = hits.filter((list) => list.length === 0).length / set.length;
      lines.push(`${name.padEnd(9)}${String(set.length).padStart(5)}  ${ranker.padEnd(7)}${TOP_K.map((k) => pct(topShare(ranks, k))).join("")}${pct(noHit)}`);
    }
  }
  const text = `${lines.join("\n")}\n`;
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
