#!/usr/bin/env node
// A probe file for test-find-live.mjs --probes in which each task is one
// paraphrase style from testing/find-rank/paraphrases.json (synonym, plain or
// expert). Everything else comes from testing/find-probes.json. Cells listed
// as excluded (they name their own target) are left out.
//
//   node scripts/find-probes-styled.mjs <synonym|plain|expert> [-o <file>]
//
// JSON on stdout (or -o). Exit 0, 1 on a runtime error, 2 on bad arguments.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLES } from "./lib/rank-bench.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error(`usage: node scripts/find-probes-styled.mjs <${STYLES.join("|")}> [-o <file>]`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { style: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      opts.output = argv[++i];
      if (!opts.output) usage(2, "--output needs a file");
    } else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.style === null) opts.style = arg;
    else usage(2, `unknown argument: ${arg}`);
  }
  if (!STYLES.includes(opts.style)) usage(2, `the style must be one of ${STYLES.join(", ")}`);
  return opts;
}

function main() {
  const { style, output } = parseArgs(process.argv.slice(2));
  const probes = JSON.parse(readFileSync(join(ROOT, "testing/find-probes.json"), "utf8"));
  const { excluded, rows } = JSON.parse(readFileSync(join(ROOT, "testing/find-rank/paraphrases.json"), "utf8"));
  const skip = new Set(excluded);
  const bySkill = new Map(rows.filter((row) => !skip.has(`${row.id}.${style}`)).map((row) => [row.skill, row[style]]));
  const styled = probes.filter((probe) => bySkill.has(probe.skill)).map((probe) => ({ ...probe, task: bySkill.get(probe.skill) }));
  console.error(`${style}: ${styled.length} of ${probes.length} probes`);
  const text = `${JSON.stringify(styled, null, 2)}\n`;
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
