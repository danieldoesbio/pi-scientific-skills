// Query sets and top-k rates for sci_find's rankers (testing/runs/2026-09-27-find-ranker.md).
//
// Sets, each a list of { query, target }:
//   recorded  the first sci_find query of each Bonsai 2 27B attempt (2026-09-23,
//             2026-09-25 v16 and v17), testing/find-rank/recorded-queries.jsonl
//   probe     the probe texts, testing/find-probes.json
//   synonym, plain, expert
//             blind paraphrases of the probes, testing/find-rank/paraphrases.json,
//             without the cells listed as excluded (they name their own target)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STYLES = ["synonym", "plain", "expert"];
export const TOP_K = [1, 2, 3, 8];

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

/** @returns {Record<string, { query: string, target: string }[]>} */
export function loadSets() {
  const recorded = readFileSync(join(ROOT, "testing/find-rank/recorded-queries.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((row) => ({ query: row.query, target: row.target }));
  const probe = readJson("testing/find-probes.json").map((row) => ({ query: row.task, target: row.skill }));
  const { excluded, rows } = readJson("testing/find-rank/paraphrases.json");
  const skip = new Set(excluded);
  const styles = Object.fromEntries(
    STYLES.map((style) => [
      style,
      rows.filter((row) => !skip.has(`${row.id}.${style}`)).map((row) => ({ query: row[style], target: row.skill })),
    ]),
  );
  return { recorded, probe, ...styles };
}

/**
 * The 1-based rank of each query's target (0 when it is not listed) under
 * `rank`, a function from a query to skill names, best first.
 */
export const targetRanks = (set, rank) =>
  set.map(({ query, target }) => rank(query).indexOf(target) + 1);

/** Share of ranks in 1..k. */
export const topShare = (ranks, k) => ranks.filter((r) => r >= 1 && r <= k).length / Math.max(1, ranks.length);
