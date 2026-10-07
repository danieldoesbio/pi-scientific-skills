// Query sets and top-k rates for sci_find's rankers (testing/runs/2026-09-27-find-ranker.md).
//
// Sets, each a list of { query, target }:
//   recorded  the first sci_find query of each Bonsai 2 27B attempt (2026-09-23,
//             2026-09-25 v16 and v17), testing/find-rank/recorded-queries.jsonl
//   probe     the probe texts, testing/find-probes.json
//   synonym, plain, expert
//             blind paraphrases of the probes, testing/find-rank/paraphrases.json,
//             without the cells listed as excluded (they name their own target)
import { existsSync, readFileSync } from "node:fs";
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

/**
 * The 1.8.0 release: the last release with the older "current" ranker and its
 * PI_SCI_FIND_RANKER switch. A new comparison against that ranker can run
 * from a checkout of it. A recorded run reproduces only from the tree it ran
 * on, which its run record names: the 2026-09-27 runs predate the v2.72.0
 * sync, whose descriptions rank differently.
 */
export const OLD_RANKER_COMMIT = "e190c57";
export const NO_OLD_RANKER =
  `the "current" ranker was removed after 1.8.0; run this from a checkout that has it (${OLD_RANKER_COMMIT} is the last ` +
  `release with it; to reproduce a recorded run, use the commit its run record names)`;

/**
 * The rankers a package directory's sci_find can run, read from its
 * extensions/search.ts: both while PI_SCI_FIND_RANKER existed (1.7.0 to
 * 1.8.0), bm25f only after, "current" only before bm25f was added.
 */
export function rankersInPackage(packageDir) {
  const path = join(packageDir, "extensions", "search.ts");
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  if (source.includes("PI_SCI_FIND_RANKER")) return ["current", "bm25f"];
  return source.includes("bm25f") ? ["bm25f"] : ["current"];
}

/** Whether `search` (extensions/search.ts, as loaded) still has the "current" ranker. */
export const hasOldRanker = (search) => typeof search.findRanker === "function";

/**
 * `search.search` as (catalog, query, limit, ranker) => hits. Throws on
 * "current" when the loaded tree no longer has it, rather than ranking with
 * bm25f under the old ranker's name.
 */
export function rankWith(search) {
  const old = hasOldRanker(search);
  return (catalog, query, limit, ranker) => {
    if (ranker === "current" && !old) throw new Error(NO_OLD_RANKER);
    return old ? search.search(catalog, query, limit, ranker) : search.search(catalog, query, limit);
  };
}
