#!/usr/bin/env node
// Ranking tests for sci_find.
//
// These run against the REAL vendored descriptions, not fixtures. That is the point:
// the thing under test is whether upstream's actual wording can be found from
// the words a scientist would actually type, and a fixture corpus would only
// test the scoring arithmetic while hiding every vocabulary gap.
//
// Two obligations, and the negative half matters as much as the positive:
//   - a query a researcher would type must surface the right skill in the top N
//   - an off-topic query must return NOTHING, never a low-scoring guess
//
// Usage: node scripts/test-search.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { createSuite } from "./lib/harness.mjs";
import { loadSets, targetRanks, topShare } from "./lib/rank-bench.mjs";

const TOP_N = 8;

/** `want` lists acceptable answers — several skills legitimately fit some queries. */
const QUERIES = [
  ["I have a 10x matrix and want to cluster cells", ["scanpy", "anndata"]],
  ["variant calling from a bam file", ["pysam", "pathogen-variant-surveillance"]],
  ["dock this ligand into the binding site", ["diffdock"]],
  ["fit a survival model with censoring", ["scikit-survival"]],
  ["predict protein structure from sequence", ["esm", "tamarind"]],
  ["differential expression between two conditions", ["pydeseq2", "bulk-rnaseq"]],
  ["make a publication figure with panels", ["scientific-visualization", "matplotlib"]],
  ["find papers about CRISPR off-target effects", ["paper-lookup", "literature-review"]],
  ["how many samples do I need for 80% power", ["statistical-power"]],
  ["read a DICOM series from the scanner", ["pydicom"]],
  ["spike sorting neuropixels recording", ["neuropixels-analysis"]],
  ["my dataframe is too big for memory", ["dask", "polars", "vaex"]],
  ["build a phylogenetic tree from newick", ["phylogenetics", "etetoolkit"]],
  ["run a nextflow pipeline", ["nextflow"]],
  ["compute SMILES descriptors for compounds", ["rdkit", "datamol"]],
  ["write the methods section of my paper", ["scientific-writing"]],
  ["bayesian hierarchical model with mcmc", ["pymc"]],
  ["whole slide image tiling for pathology", ["histolab", "pathml"]],
  ["gene set enrichment analysis", ["pathway-enrichment"]],
  ["molecular dynamics simulation setup", ["molecular-dynamics"]],
  ["single cell batch correction across donors", ["scvi-tools", "scanpy"]],
  ["ECG signal processing heart rate variability", ["neurokit2"]],
  ["query clinical trials for a condition", ["clinical-decision-support", "database-lookup"]],
  ["train a graph neural network on molecules", ["torch-geometric", "torchdrug", "deepchem"]],
  ["geospatial raster analysis", ["geopandas", "geomaster"]],
  // Single-word queries: the MIN_SCORE floor drops to one description point
  // for this exact shape (one un-aliased term, nothing boosted), so a plain
  // word that matches a description now surfaces something instead of
  // nothing. The corpus spells it "statistical" (adjective), never
  // "statistics" (noun), so the noun reaches statistical-analysis only
  // through its alias trigger; the adjective reaches it through the floor.
  ["statistical", ["statistical-analysis"]],
  ["statistics", ["statistical-analysis"]],
  ["genome", ["genomic-coordinates"]],
  ["medical image segmentation", ["pydicom", "histolab"]],
  ["predict the effect of a non-coding variant", ["alphagenome"]],
  ["alphagenome", ["alphagenome"]],
  // Plural and underscore forms of the short alias triggers. These have no
  // route but the whole-word match (triggers under MIN_COMPACT_LENGTH never
  // get the compacted fallback), so without singular/plural surface forms
  // "SNPs" and "BAMs" returned nothing and "DEGs" returned confident noise.
  ["call SNPs from a VCF", ["pysam", "onekgpd"]],
  ["sort my BAMs", ["pysam", "deeptools"]],
  ["sort my bam_file", ["pysam", "deeptools"]],
  ["make plots of my results", ["matplotlib", "scientific-visualization", "seaborn"]],
  ["find DEGs between two conditions", ["pydeseq2", "bulk-rnaseq", "scanpy"]],
];

/**
 * Queries that must rank a specific skill FIRST, not merely present.
 * `mustBeFirst` is checked against `names[0]`.
 */
const RANKED = [["variant calling from a bam file", "pysam"]];

/**
 * Queries that must return nothing at all.
 *
 * Principle: a plausible-but-wrong skill handed to someone designing an
 * experiment is worse than no answer. "book a flight" is here because it caught
 * a real bug — substring matching scored `open-notebook`, since "notebook"
 * contains "book".
 */
const NEGATIVES = [
  "what is the weather today",
  "book a flight to paris",
  "asdfghjkl",
  "remind me to call my mother",
  // Whole-word alias matching (matchesPhrase): the first two caught real
  // substring false positives before the fix ("bam" inside "bamboo", "deg"
  // inside "degradation"). The other four already returned nothing under the
  // old matcher; they guard the single-word floor, which must not turn an
  // unrelated word into a confident answer.
  "bamboo growth",
  "protein degradation",
  "lunch",
  "plumbing",
  "gossip",
  "furniture",
  // Hyphenated: a hyphen makes a joined pair token, and the bm25f no-match rule
  // counts single words only. These must still return nothing.
  "e-mail my landlord",
  "asdf-ghjk",
];

/**
 * Golden queries that the bm25f ranker (the default) misses, each with its
 * reason. They are reported under bm25f, not checked. bm25f has no alias boost
 * (development data set it to 0), so a query made of words that are in most
 * SKILL.md bodies carries almost no weight (testing/runs/2026-09-27-find-ranker.md).
 */
const BM25F_KNOWN_MISSES = new Map([
  // "write the methods section of my paper" was listed here until the v2.72.0
  // sync, whose condensed descriptions put scientific-writing at #2. It is
  // checked again.
]);

const suite = createSuite("ranking checks");
const { failures, finish } = suite;
const note = (message) => console.log(message);

const search = await loadExtensionModule("extensions/search.ts");

const skillsDir = search.resolveSkillsDir();
if (!skillsDir) {
  console.error("FAIL: resolveSkillsDir() returned undefined — skills/ not locatable");
  process.exit(1);
}

const started = Date.now();
const catalog = search.loadCatalog(skillsDir);
const elapsed = Date.now() - started;
note(`catalogue: ${catalog.length} skills parsed in ${elapsed}ms`);

if (catalog.length === 0) {
  console.error("FAIL: catalogue is empty");
  process.exit(1);
}

// Every entry must carry what the model needs to actually load the skill.
for (const entry of catalog) {
  if (!entry.name || !entry.description || !entry.path || !entry.dir) {
    failures.push(`catalogue entry is incomplete: ${JSON.stringify(entry)}`);
    break;
  }
}

// Every check runs under both rankers: "bm25f" (the default) and "current"
// (PI_SCI_FIND_RANKER=current, kept for one release). Neither may regress the
// other's obligations while both ship.
for (const ranker of ["current", "bm25f"]) {
  const run = (query) => search.search(catalog, query, TOP_N, ranker);
  const tag = ranker === "current" ? "" : ` [${ranker}]`;

  note(`\n-- queries (${ranker}) --`);
  for (const [query, want] of QUERIES) {
    const names = run(query).map((hit) => hit.entry.name);
    const rank = names.findIndex((name) => want.includes(name));
    if (ranker === "bm25f" && BM25F_KNOWN_MISSES.has(query)) {
      note(`  known miss  ${query} (${rank === -1 ? BM25F_KNOWN_MISSES.get(query) : `now found at #${rank + 1}: remove it from the list`})`);
      continue;
    }
    suite.record(rank !== -1, `"${query}"${tag} did not surface any of [${want.join(", ")}] in top ${TOP_N}`);
    if (rank === -1) {
      note(`  FAIL  ${query}\n        want one of [${want.join(", ")}], got [${names.join(", ") || "none"}]`);
    } else {
      note(`  ok #${rank + 1}  ${query} → ${names[rank]}`);
    }
  }

  note(`\n-- must return nothing (${ranker}) --`);
  for (const query of NEGATIVES) {
    const hits = run(query);
    const shown = hits.map((hit) => `${hit.entry.name}:${Number(hit.score.toFixed(2))}`).join(", ");
    suite.record(hits.length === 0, `"${query}"${tag} should have matched nothing, got [${shown}]`);
    if (hits.length > 0) {
      note(`  FAIL  ${query} → ${shown}`);
    } else {
      note(`  ok      ${query}`);
    }
  }

  note(`\n-- must rank first (${ranker}) --`);
  for (const [query, mustBeFirst] of RANKED) {
    const names = run(query).map((hit) => hit.entry.name);
    suite.record(
      names[0] === mustBeFirst,
      `"${query}"${tag} must rank "${mustBeFirst}" first, got [${names.join(", ") || "none"}]`,
    );
    if (names[0] !== mustBeFirst) {
      note(`  FAIL  ${query}\n        want "${mustBeFirst}" first, got [${names.join(", ") || "none"}]`);
    } else {
      note(`  ok      ${query} → ${mustBeFirst}`);
    }
  }
}

note("\n-- ranker switch and bm25f specifics --");
{
  const before = process.env.PI_SCI_FIND_RANKER;
  process.env.PI_SCI_FIND_RANKER = "current";
  const on = search.findRanker();
  process.env.PI_SCI_FIND_RANKER = "something-else";
  const other = search.findRanker();
  delete process.env.PI_SCI_FIND_RANKER;
  const unset = search.findRanker();
  if (before !== undefined) process.env.PI_SCI_FIND_RANKER = before;
  suite.record(
    on === "current" && other === "bm25f" && unset === "bm25f",
    `PI_SCI_FIND_RANKER: "current" selects the current ranker, anything else or unset bm25f (got ${on}, ${other}, ${unset})`,
  );
  const exact = search.search(catalog, "pytorch lightning", TOP_N, "bm25f").map((hit) => hit.entry.name);
  suite.record(exact[0] === "pytorch-lightning", `bm25f: a query equal to a skill name lists it first, got [${exact.join(", ")}]`);
  const limited = search.search(catalog, "single cell rna-seq clustering", 3, "bm25f");
  suite.record(limited.length === 3, `bm25f: limit caps the hit count (got ${limited.length})`);
  const sorted = search.rankBm25f(catalog, "protein structure prediction").every((hit, i, all) => i === 0 || all[i - 1].score >= hit.score);
  suite.record(sorted, "bm25f: hits come best first");
  // Floor on the recorded first queries (development data; the rate there was 98.8%).
  const { recorded } = loadSets();
  const top3 = topShare(targetRanks(recorded, (query) => search.search(catalog, query, 3, "bm25f").map((hit) => hit.entry.name)), 3);
  note(`  bm25f: target in the top 3 for ${(100 * top3).toFixed(1)}% of ${recorded.length} recorded first queries`);
  suite.record(top3 >= 0.98, `bm25f: target in the top 3 for ${(100 * top3).toFixed(1)}% of recorded first queries, floor 98%`);
}

// A hyphenated word makes a joined pair token ("massspec"). The pair is usually
// in no skill, so it can never score. It must not count toward the most a
// query could score, or a short hyphenated query falls under the no-match
// share and gets "No skill matched" where its spaced form finds the skills.
note("\n-- hyphenated queries (bm25f) --");
{
  const run = (query) => search.search(catalog, query, TOP_N, "bm25f").map((hit) => hit.entry.name);
  const massSpec = run("mass-spec");
  suite.record(
    ["matchms", "pyopenms"].every((name) => massSpec.includes(name)),
    `bm25f: "mass-spec" must list matchms and pyopenms in top ${TOP_N}, got [${massSpec.join(", ") || "none"}]`,
  );
  const readAlignment = run("read-alignment");
  suite.record(
    ["deeptools", "pysam"].some((name) => readAlignment.includes(name)),
    `bm25f: "read-alignment" must list deeptools or pysam in top ${TOP_N}, got [${readAlignment.join(", ") || "none"}]`,
  );
  // The pair also scores when a SKILL.md uses the phrase. "massspec" is in no
  // skill, so "mass-spec" scores exactly as "mass spec": the same top hit.
  // "readalignment" is in 3 SKILL.md bodies (biopython, pysam, scikit-bio), so
  // the pair lifts them and "read-alignment" may reorder the top of the list
  // against "read alignment": its top hit must stay in that form's top 3.
  for (const [hyphenated, spaced, window] of [
    ["mass-spec", "mass spec", 1],
    ["read-alignment", "read alignment", 3],
  ]) {
    const [hyphenHits, spacedHits] = [run(hyphenated), run(spaced)];
    suite.record(
      hyphenHits.length > 0 && spacedHits.slice(0, window).includes(hyphenHits[0]),
      `bm25f: the top hit of "${hyphenated}" must be in the top ${window} of "${spaced}", got "${hyphenHits[0] ?? "none"}" and [${spacedHits.slice(0, window).join(", ") || "none"}]`,
    );
    note(`  ${hyphenated} → ${hyphenHits[0] ?? "none"} | ${spaced} → ${spacedHits[0] ?? "none"}`);
  }
}

note("\n-- aliases resolve to real skills --");
const aliases = await loadExtensionModule("extensions/aliases.ts");
const known = new Set(catalog.map((entry) => entry.name));
let aliasSkills = 0;
for (const alias of aliases.ALIASES) {
  for (const skill of alias.skills ?? []) {
    aliasSkills++;
    if (!known.has(skill)) failures.push(`alias "${alias.match[0]}" names missing skill "${skill}"`);
  }
}
note(`  checked ${aliasSkills} alias targets across ${aliases.ALIASES.length} rules`);

finish();
