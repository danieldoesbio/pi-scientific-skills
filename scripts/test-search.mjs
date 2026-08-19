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
import { documentedCount } from "./doc-count.mjs";

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
];

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
];

const failures = [];
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

let checks = 0;

note("\n-- queries --");
for (const [query, want] of QUERIES) {
  checks++;
  const names = search.search(catalog, query, TOP_N).map((hit) => hit.entry.name);
  const rank = names.findIndex((name) => want.includes(name));
  if (rank === -1) {
    failures.push(`"${query}" did not surface any of [${want.join(", ")}] in top ${TOP_N}`);
    note(`  FAIL  ${query}\n        want one of [${want.join(", ")}], got [${names.join(", ") || "none"}]`);
  } else {
    note(`  ok #${rank + 1}  ${query} → ${names[rank]}`);
  }
}

note("\n-- must return nothing --");
for (const query of NEGATIVES) {
  checks++;
  const hits = search.search(catalog, query, TOP_N);
  if (hits.length > 0) {
    const shown = hits.map((hit) => `${hit.entry.name}:${hit.score}`).join(", ");
    failures.push(`"${query}" should have matched nothing, got [${shown}]`);
    note(`  FAIL  ${query} → ${shown}`);
  } else {
    note(`  ok      ${query}`);
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

failures.push(...documentedCount("ranking checks", checks));

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
