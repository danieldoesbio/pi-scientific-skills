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
import { NEGATIVES, QUERIES, RANKED } from "./lib/golden-queries.mjs";
import { loadSets, targetRanks, topShare } from "./lib/rank-bench.mjs";

const TOP_N = 8;

/**
 * Golden queries the ranker misses, each with its reason. They are reported,
 * not checked. BM25F has no alias boost, so a query made of words that are in
 * most SKILL.md bodies carries almost no weight
 * (testing/runs/2026-09-27-find-ranker.md).
 */
const KNOWN_MISSES = new Map([
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

const run = (query) => search.search(catalog, query, TOP_N);

note("\n-- queries --");
for (const [query, want] of QUERIES) {
  const names = run(query).map((hit) => hit.entry.name);
  const rank = names.findIndex((name) => want.includes(name));
  if (KNOWN_MISSES.has(query)) {
    note(`  known miss  ${query} (${rank === -1 ? KNOWN_MISSES.get(query) : `now found at #${rank + 1}: remove it from the list`})`);
    continue;
  }
  suite.record(rank !== -1, `"${query}" did not surface any of [${want.join(", ")}] in top ${TOP_N}`);
  if (rank === -1) {
    note(`  FAIL  ${query}\n        want one of [${want.join(", ")}], got [${names.join(", ") || "none"}]`);
  } else {
    note(`  ok #${rank + 1}  ${query} → ${names[rank]}`);
  }
}

note("\n-- must return nothing --");
for (const query of NEGATIVES) {
  const hits = run(query);
  const shown = hits.map((hit) => `${hit.entry.name}:${Number(hit.score.toFixed(2))}`).join(", ");
  suite.record(hits.length === 0, `"${query}" should have matched nothing, got [${shown}]`);
  if (hits.length > 0) {
    note(`  FAIL  ${query} → ${shown}`);
  } else {
    note(`  ok      ${query}`);
  }
}

note("\n-- must rank first --");
for (const [query, mustBeFirst] of RANKED) {
  const names = run(query).map((hit) => hit.entry.name);
  suite.record(names[0] === mustBeFirst, `"${query}" must rank "${mustBeFirst}" first, got [${names.join(", ") || "none"}]`);
  if (names[0] !== mustBeFirst) {
    note(`  FAIL  ${query}\n        want "${mustBeFirst}" first, got [${names.join(", ") || "none"}]`);
  } else {
    note(`  ok      ${query} → ${mustBeFirst}`);
  }
}

note("\n-- ranker specifics --");
{
  // PI_SCI_FIND_RANKER=current selected the older ranker up to 1.8.0. It is
  // gone; a user who still sets it must get the same results as anyone else.
  const query = "variant calling from a bam file";
  const plain = JSON.stringify(run(query).map((hit) => hit.entry.name));
  const before = process.env.PI_SCI_FIND_RANKER;
  process.env.PI_SCI_FIND_RANKER = "current";
  const withSwitch = JSON.stringify(run(query).map((hit) => hit.entry.name));
  if (before === undefined) delete process.env.PI_SCI_FIND_RANKER;
  else process.env.PI_SCI_FIND_RANKER = before;
  suite.record(plain === withSwitch, `PI_SCI_FIND_RANKER=current changes no result (got ${withSwitch}, want ${plain})`);
  const exact = run("pytorch lightning").map((hit) => hit.entry.name);
  suite.record(exact[0] === "pytorch-lightning", `a query equal to a skill name lists it first, got [${exact.join(", ")}]`);
  const limited = search.search(catalog, "single cell rna-seq clustering", 3);
  suite.record(limited.length === 3, `limit caps the hit count (got ${limited.length})`);
  const sorted = search.rankBm25f(catalog, "protein structure prediction").every((hit, i, all) => i === 0 || all[i - 1].score >= hit.score);
  suite.record(sorted, "hits come best first");
  // Floor on the recorded first queries (development data; the rate there was 98.8%).
  const { recorded } = loadSets();
  const top3 = topShare(targetRanks(recorded, (query) => search.search(catalog, query, 3).map((hit) => hit.entry.name)), 3);
  note(`  target in the top 3 for ${(100 * top3).toFixed(1)}% of ${recorded.length} recorded first queries`);
  suite.record(top3 >= 0.98, `target in the top 3 for ${(100 * top3).toFixed(1)}% of recorded first queries, floor 98%`);
}

// A hyphenated word makes a joined pair token ("massspec"). The pair is usually
// in no skill, so it can never score. It must not count toward the most a
// query could score, or a short hyphenated query falls under the no-match
// share and gets "No skill matched" where its spaced form finds the skills.
note("\n-- hyphenated queries --");
{
  const names = (query) => run(query).map((hit) => hit.entry.name);
  const massSpec = names("mass-spec");
  suite.record(
    ["matchms", "pyopenms"].every((name) => massSpec.includes(name)),
    `"mass-spec" must list matchms and pyopenms in top ${TOP_N}, got [${massSpec.join(", ") || "none"}]`,
  );
  const readAlignment = names("read-alignment");
  suite.record(
    ["deeptools", "pysam"].some((name) => readAlignment.includes(name)),
    `"read-alignment" must list deeptools or pysam in top ${TOP_N}, got [${readAlignment.join(", ") || "none"}]`,
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
    const [hyphenHits, spacedHits] = [names(hyphenated), names(spaced)];
    suite.record(
      hyphenHits.length > 0 && spacedHits.slice(0, window).includes(hyphenHits[0]),
      `the top hit of "${hyphenated}" must be in the top ${window} of "${spaced}", got "${hyphenHits[0] ?? "none"}" and [${spacedHits.slice(0, window).join(", ") || "none"}]`,
    );
    note(`  ${hyphenated} → ${hyphenHits[0] ?? "none"} | ${spaced} → ${spacedHits[0] ?? "none"}`);
  }
}

// Each alias rule names the skills it exists to help find. They get no ranking
// boost, so the rule earns its place only if its terms do the work: each
// trigger phrase, searched alone, must list one of them in the first search's
// hits. The phrases listed here miss today (found 2026-10-07). The suite
// reports what each one lists and does not fail on it.
const ALIAS_KNOWN_MISSES = new Set(["indel", "aligned reads", "deg", "batch correction", "write a paper", "train a model"]);

note(`\n-- alias targets (each trigger phrase alone, top ${search.FIRST_SEARCH_LIMIT}) --`);
{
  const aliases = await loadExtensionModule("extensions/aliases.ts");
  const known = new Set(catalog.map((entry) => entry.name));
  let phrases = 0;
  const missesSeen = new Set();
  for (const alias of aliases.ALIASES) {
    const want = alias.skills ?? [];
    for (const skill of want) {
      if (!known.has(skill)) failures.push(`alias "${alias.match[0]}" names missing skill "${skill}"`);
    }
    if (want.length === 0) continue;
    for (const phrase of alias.match) {
      phrases++;
      const names = search.search(catalog, phrase, search.FIRST_SEARCH_LIMIT).map((hit) => hit.entry.name);
      const found = names.some((name) => want.includes(name));
      if (ALIAS_KNOWN_MISSES.has(phrase)) {
        missesSeen.add(phrase);
        note(`  known miss  ${phrase} (${found ? "now found: remove it from the list" : `lists ${names.join(", ") || "nothing"}`})`);
        continue;
      }
      suite.record(found, `alias "${phrase}" lists none of [${want.join(", ")}] in the top ${search.FIRST_SEARCH_LIMIT}, got [${names.join(", ") || "none"}]`);
      if (!found) note(`  FAIL  ${phrase} → [${names.join(", ") || "none"}], want one of [${want.join(", ")}]`);
    }
  }
  for (const phrase of ALIAS_KNOWN_MISSES) {
    if (!missesSeen.has(phrase)) failures.push(`ALIAS_KNOWN_MISSES lists "${phrase}", which is no alias trigger phrase`);
  }
  note(`  checked ${phrases - missesSeen.size} trigger phrases across ${aliases.ALIASES.length} rules, ${missesSeen.size} known misses`);
}

finish();
