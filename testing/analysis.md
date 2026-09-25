# Analysis: what the live search test says about `sci_find`

This document interprets the 2026-09-23 run. The results are in
[`report.md`](report.md). The lab record, with every probe below success, is
[`runs/2026-09-23-bonsai2-27b.md`](runs/2026-09-23-bonsai2-27b.md).

The analysis is offline. It reads the results and transcripts and replays
the model's own `sci_find` queries through `search()` from
`extensions/search.ts`. It sends nothing to the model. The replay matches the
live tool for 183 of 183 calls, so any search change can be tested on the
model's real queries before a new live run.

## Headline

**The bottleneck is whether the model calls the tool, not how the tool
ranks.** On the 157 valid probes, 19 attempts missed the target:

| Cause | Attempts |
|---|---|
| Never called `sci_find` | 15 |
| Called it; the target was not in the top 20 (index gap) | 3, all `esm` |
| The target was in the top 20, but below the limit the model asked for | 1, `simpy` (rank 13 at limit 8) |

## Ranking works

Rank of the target in the result that reached it (156 reaches):

| Rank | Reaches |
|---|---|
| 1 | 125 |
| 2–3 | 24 |
| 4–8 | 7 |
| 9–20 | 0 |

- No reach needed more than the default limit of 8. The model left the limit
  at 8 in 117 of 183 calls.
- In two queries the target sat at rank 9–20, outside the limit the model
  asked for: `simpy` (rank 13) and `umap-learn` (rank 11; the next query
  found it at rank 1). One lost reach is not enough evidence to raise the
  default.

## How much the score depends on the probe wording

- **Copying.** The model's first queries copy 77% of their content words
  from the probe task. Pasting each probe task as the query puts the target
  in the top 8 for 155 of 162 probes.
- **Name words.** 86 of 156 reaching queries contain a word of the target's
  name, and in 38 the probe task supplied that word. With those words removed
  (a synthetic rewrite), the target stays in the top 8 for 149 of 161
  queries, against 155 for the original. The score does not rest on name
  leaks.
- **Vague wording.** With only common words left (words that match 10 or more
  skills), the target is in the top 8 for 67 of 161. Search depends on the
  distinctive words of the need.

So the test measures two things well: does the model search, and does the
index have gaps. It measures ranking for vague requests poorly. A probe set
with short, vague requests would measure that.

## Why the model does not search

- First tool of the first response, over 186 attempts: `sci_find` 93, bash
  88, `read` 2, none 3. Bash first is common and usually harmless: in 67
  attempts the model ran bash and then searched.
- 25 attempts never called `sci_find`. In 20 of them the thinking never
  names the tool. Five name it and still build first (`dask`,
  `database-lookup`, `open-notebook`, `parallel-web` twice).
- The tasks that skip search are mostly build or setup tasks: EDA,
  MATLAB-to-Octave, a Modal deploy, a podcast pipeline, a web monitor, a
  Polars ETL, pysam, a Lightning refactor. The model starts to write code.
- pi's system prompt never names `sci_find`. pi lists a custom tool under
  "Available tools" only when it has a `promptSnippet`, and `sci_find` has
  none. The model sees the tool only in its schema.
- In `dask` the thinking weighed `sci_find` and declined: the task was not
  "a 'scientific skill' task like variant calling or fitting a survival
  model". Those are the two examples in the tool description. Both are
  analysis tasks, and the examples may narrow the model's idea of the tool.
- **Every timeout followed a missing skill.** 18 attempts hit the 1200 s
  limit. 14 never searched; the other 4 searched and missed (`esm` 3,
  `simpy` 1). Without the skill, the model builds the answer itself and runs
  out of time. 16 of the 18 were active tool work (5–39 tool calls, no
  repeated-call loops).

## The index gap: `esm`

The description reads: "Use when working directly with the `esm` Python SDK,
ESM3 or ESMC model IDs, Forge/Biohub inference clients, or ESMFold2 folding
workflows." It names tools, not tasks. A query that states the need ("fill
masked regions of a partial protein sequence", "predict protein 3D structure
from sequence") cannot match it. "esm3 protein" returns no hits at all.

## Alias side effects

The alias boost (+4) put another skill above the target in 18 of the 31
reaches below rank 1. Triggers that fire off-topic in real queries:

| Trigger | Fired on | Effect |
|---|---|---|
| "references" | reference frame, coordinate reference system, reference SNP ID | `astropy` and `geopandas` at rank 6, `research-lookup` at rank 8 |
| "integration" | Benchling, DNAnexus, LabArchives, Zarr integration | batch-correction skills boosted |
| "variants" | GWAS, protein and 1000 Genomes variants | variant-calling skills boosted |
| "lineage" | data lineage (`lamindb`), cell lineage (`scvelo`) | pathogen-lineage skill boosted |
| "trajectory" | MD and quantum trajectories | RNA-velocity skill boosted |

None of these cost a reach in this run, but each can push a target down.

## Scoring has no rarity weight

A name match scores 3 and a description match 1, for any word. In `simpy`,
"discrete-event" matches only `simpy`, but it counted the same as "clinic",
which matches 10 skills. `simpy` ranked 13th. Weighting rare words more (IDF)
might fix this class of miss. Not tested.

## Candidate changes, tested offline

Each variant was applied to a patched copy of the search code and run on all
183 real queries, the 162 probe tasks as queries, the
`scripts/test-search.mjs` suite and 6 new `esm` paraphrases. The repository
was not changed.

| Variant | `esm` queries in top 8 | New `esm` paraphrases in top 8 | Real targets lost | Suite failures | Probe tasks better / worse |
|---|---|---|---|---|---|
| base | 0/5 | 0/6 | 0 | 0 | 0 / 0 |
| A: `esm` trigger alias from the run's queries | 5/5 | 0/6 | 0 | 0 | 1 / 0 |
| K: `esm` index keywords from its SKILL.md | 5/5 | 5/6 | 0 | 0 | 1 / 1 |
| D2: narrow the "references" trigger | 0/5 | 0/6 | 0 | 0 | 5 / 0 |
| K + D2 | 5/5 | 5/6 | 0 | 0 | 6 / 1 |

- K's one worse probe task is `gget`, rank 2 to 3, still in the top 8.
- K + D2 on real queries: `astropy` 6 to 2, `geopandas` 6 to 2,
  `folklore-variant-evidence` 2 to 1, `relsa-severity-assessment` 3 to 1,
  and the `esm` queries from not listed to ranks 1–6.
- A fits this run's wording only (0 of 6 paraphrases). K generalizes.

## Recommendations

In order of evidence:

1. **K: index keywords for `esm`,** from its own SKILL.md, in a package-side
   map. This fixes the only valid fail. It is a new mechanism, so it is a
   design decision. The upstream description is not ours to change.
2. **D2: narrow the "references" trigger** to literature phrases. Test it on
   fresh literature queries first: its phrases were chosen after we saw the
   test queries.
3. **Regression queries** in `scripts/test-search.mjs` from real model
   queries, including a "must not rank first" check.
4. **A `promptSnippet` and wider examples for `sci_find`** that say when to
   search: before writing code, installing a tool or setting up a service for
   a scientific task. This targets the main loss. It needs a live A/B run on
   the 12 valid probes with a no-search attempt: `dask`,
   `exploratory-data-analysis`, `fluidsim`, `genomic-intelligence`, `matlab`,
   `modal`, `open-notebook`, `parallel-web`, `polars`, `pysam`,
   `pytorch-lightning`, `qutip`. **Implemented in 1.7.0** (snippet, one
   guideline, one more scope sentence in the description), together with
   search mode that loads no skills. The A/B pilot was stopped early: both
   arms searched in response 1 on 11 of 12, so it showed no effect on the
   search rate (regression to the mean; see
   [`runs/2026-09-24-bonsai2-snippet-ab.md`](runs/2026-09-24-bonsai2-snippet-ab.md)).
   The default change itself is measured by a three-arm run
   ([`runs/2026-09-25-night-arms.md`](runs/2026-09-25-night-arms.md)).
5. **Open hypotheses for offline tests:** IDF weighting; a `profile` value
   that is not a profile falling back to the query (the model confused the
   two once in 183 calls).

## Proposed next experiment: the full prompt against search

**Status: scheduled** as the `v17` against `full` comparison of
[`runs/2026-09-25-night-arms.md`](runs/2026-09-25-night-arms.md).

**Question.** What does the normal install cost this model: all 162 skill
descriptions in the system prompt, and no `sci_find`? We want the cost in
speed, context and success.

**Arms.** Same model, server flags, probes, persona, judge and limits.

- A: no skills in the prompt, `sci_find` available (this run's setup).
- B: all 162 skills in the prompt, no `sci_find` (the normal install).

**Endpoint.** In B every target is already listed, so "listed" cannot be the
reach. Both arms must use the same endpoint: **the model reads the target's
SKILL.md**. This run stopped at the listing, so it cannot serve as arm A.
Both arms run fresh.

**Harness work before a pilot:**

- `--prompt-skills all`.
- An option that leaves `sci_find` out.
- Stop on a read of the target's SKILL.md instead of on the listing.
- A rule for context overflow and pi's compaction: its own outcome, not a
  harness error and not a fail.

**Primary outcomes:** first-attempt read rate per arm (Core and non-Core
apart), generation tok/s by context, prompt processing time, timeouts and
overflows.

**Predictions from this run's data (write down before B runs):**

- pi puts the skill list before the working-directory line, and the package
  path stays the same within a run. So the llama.cpp prefix cache will
  probably keep the 23k prefix between requests. The main speed cost will
  then be slower generation at longer context, not the prefill.
- A typical request moves from under 4k context (19.1 tok/s) to 23k or more
  (16.3 tok/s or less in this run's data): about 15% slower generation, more
  in long attempts.
- Overflow will be rare. In this run, 2 attempts with a session record
  reached more than 42k tokens (65,536 minus about 23k), both `pi-agent`. The
  server log shows one turn at 56,150, cut by a timeout.
- No prediction for the read rate. The run exists to measure it.

**Cost.** This run took about 10 hours for one arm. Two fresh arms of 161
probes need about 20 hours or more of laptop time, plus persona and judge
calls. A stratified subset (for example, all Core probes, the 12 no-search
probes and a random sample of the rest) would cut that.
