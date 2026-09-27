# Run notebook: a BM25F ranker for `sci_find`

**Status: development done; live checks not pre-registered yet.** The
pre-registrations of the query-writer panel (step 3) and the choice-turn
replay (step 4a) are added to this notebook and committed before each launch.

## Why

The model reads a listed target even when it is not first (32 of 32 in the
2026-09-25 night run; the `full` arm of the 2026-09-27 replay read 158 of
158). So the lever is whether the target is in the list that `sci_find`
shows. `full` (8 hits) stays the default format, so the cut-off is the top 8.

The goal is older and smaller models in general, not one model. The ranker's
settings stay frozen from here on; no query writer's queries change them.

## The ranker (`extensions/bm25f.ts`, `PI_SCI_FIND_RANKER=bm25f`)

- BM25F over three fields: name (weight 2), description (1, b 0.5) and the
  SKILL.md body below the frontmatter (0.2, b 0.9); k1 1.2.
- Tokens: lowercase, split on anything but letters, digits and "+"; a plural
  "s" folded (length > 3, not "ss"); each adjacent pair joined when it has 5
  or more letters ("rna seq", "rna-seq" and "rnaseq" meet).
- IDF `log(1 + (N − df + 0.5) / (df + 0.5))`, df over all three fields.
- Query terms: `expandQuery()` as in the current ranker, so alias terms are
  added; the alias skill boost is 0.
- Exact name: a query whose compacted form equals a skill name lists that
  skill first.
- No-match: hits only when the best score is at least 2.5, or at least 35% of
  the most the query could score (the sum of IDF over its unique tokens).
- The settings came from a 2-fold cross-validation on 425 recorded first
  `sci_find` queries (split by target skill), before the paraphrased probes
  existed.

## Development results (offline)

**Development set.** 1,069 queries, each with one target: the 425 recorded
first queries of Bonsai 2 27B (2026-09-23, 2026-09-25 `v16` and `v17`), the
162 probe texts, and 482 paraphrases of the probes (synonym, plain, expert;
written blind to the skill names; 4 cells that name their own target are
dropped). The paraphrases were first a held-out test of the settings; from
here on they are development data. A fresh held-out set is below.

The sets are in `testing/find-rank/`; `node scripts/find-rank-bench.mjs` prints
the table below, and `test-search.mjs` checks one floor (bm25f, recorded,
top 3 ≥ 98%).

**Parity.** The TypeScript port gives the same full ranking as the scratchpad
prototype for all 1,125 queries it was given (every recorded query, the probe
texts and the paraphrases): 0 differ.

**Target in the top k (%), no-match rule included:**

| Set | n | current top 1 | current top 8 | bm25f top 1 | bm25f top 3 | bm25f top 8 |
|---|---|---|---|---|---|---|
| recorded | 425 | 77.2 | 97.2 | 92.9 | 98.8 | 99.8 |
| probe text | 162 | 72.8 | 95.7 | 96.3 | 98.8 | 100.0 |
| synonym | 161 | 64.0 | 88.8 | 89.4 | 98.1 | 100.0 |
| plain | 161 | 36.0 | 77.0 | 72.0 | 88.8 | 95.0 |
| expert | 160 | 67.5 | 96.3 | 96.3 | 100.0 | 100.0 |

**Additions, one at a time:**

- Exact name: no change on the development set (no query there is a skill
  name). Kept as a safety rule.
- Alias skill boost: 1, 2 and 4 were all worse than 0. Putting the alias
  skills into the last places of the top 8 was also worse (plain top 8 95.0 →
  93.2). Boost 0.
- Alias term expansion off: mixed, top 8 slightly worse. Kept on.
- No-match rule: chosen to lose none of the 1,069 development queries (0
  lost). Other rules tried: best score ≥ 2.5 alone ("statistics",
  "statistical" and "genome" return nothing); a hybrid with the current
  ranker's rule (loses 1 query); share ≥ 0.25 (3 of test-search.mjs's 10
  negatives get hits).

**Negatives.** Queries that get any hit (lower is better):

| Negative set | n | current | bm25f |
|---|---|---|---|
| test-search.mjs negatives | 10 | 0 | 0 |
| agent-written, off-domain, as a query | 60 | 26 | 16 |
| agent-written, in-domain with no skill, as a query | 40 | 19 | 11 |
| agent-written, off-domain, full request text | 60 | 37 | 34 |
| agent-written, in-domain with no skill, full request text | 40 | 33 | 29 |

**Known miss.** "write the methods section of my paper" (a golden query in
`test-search.mjs`): `scientific-writing` ranks 11th. "write", "methods",
"section" and "paper" occur in 76 to 148 of the 159 skills, so they weigh
almost nothing, and bm25f has no alias boost. The current ranker finds it
through its alias table. It is listed as a known bm25f miss in
`test-search.mjs`, reported and not checked. Not tuned for.

**Speed.** The index is built on the first `bm25f` call: about 120 ms
(budget 150 ms; 3 runs, 118–127 ms). Later calls take under 3 ms.

## Limits of the development results

- Offline rank only. The query that a model writes is not the request text:
  it can add technical words (smaller gap) or not search at all (a loss no
  ranker fixes). Step 3 measures this.
- The short queries come only from `test-search.mjs` (all development
  queries have 4 or more terms), and the no-match rule was chosen with its
  lists in view.
- The negatives were written by agents; the in-domain set has 40 items.

## Held-out set (locked, unread)

Blind agents wrote two new styles per probe, "novice" and "terse", under the
same rules (no skill names). 162 probes × 2 styles, complete. A script
checked completeness and name leaks without printing the text: 3 cells name
their own target (the target name as whole words) and are dropped
(p145 novice and terse, p152 terse). The set is used once, before any
default change, and reported whatever the result.

## Next

- Step 3: first queries from a panel of small models (Bonsai 2 27B, Gemma 4
  12B, Gemma 4 E4B, Claude Haiku 4.5), current vs bm25f offline on each
  writer's queries. Pre-registered here before launch.
- Step 4a: choice-turn replay with bm25f hit lists, non-inferiority at −5
  points. Pre-registered here before launch.
