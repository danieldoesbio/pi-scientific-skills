# Run notebook: a BM25F ranker for `sci_find`

**Status: development done; step 4a pre-registered.** Each pre-registration
below was written and committed before its first request. The query-writer
panel (step 3) is added after its setup smokes, before it runs.

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

The files are kept out of git (the maintainer's `test-artifacts/`, which is
gitignored). Their SHA-256, recorded here so that a change shows:

| File | SHA-256 |
|---|---|
| `part-1.json` | `58b5a4ecba57be6a2c0a73a3ac15586ea8dabf39f19ef1c947cdd34592cbce67` |
| `part-2.json` | `08bd0b530b88c099024dee1909193539964bbafe416ca4e1be5d36a4bcda639d` |
| `leaks.json` | `22031fa928a0bd7c0b0d3b026d84b8b0531c139fba8c66c4b56c134ae5863c9d` |

## Step 4a: choice-turn replay with bm25f hit lists (pre-registered)

### Why

The model reads a listed target even when it is not first, but bm25f changes
the order of the list and the skills beside the target. This step checks
that the new lists do not confuse the model at the moment it picks a skill.

### Design

The same as the first compact replay
([`2026-09-27-find-compact-replay.md`](2026-09-27-find-compact-replay.md)) in
every point (source run `2026-09-25-night-arms`, arm `v17`, frozen package,
Bonsai 2 27B, server script and flags, one slot, temperature 1.0, thinking
`medium`, pi's SDK, stubbed tools, one request per copy per probe, the parser
gate, arm order alternating by probe, `full` first on the 1st included
probe), with `bm25f` in place of `compact`:

- **`bm25f` copy.** Each `sci_find` call of the choice turn runs again
  through the extension's own `runToolSearch` with
  `PI_SCI_FIND_RANKER=bm25f`, in the full format, with the recorded
  package's paths. Gate: the same call under the current ranker must give
  the recorded result byte for byte, or the probe is an error.
- **Checked before this notebook was committed.** The dry run prepared 158
  attempts with 0 errors (the gate passed on all 158); 3 have no `sci_find`
  call and are excluded. `skills/` of this tree is identical to the frozen
  `v17` package (`diff -rq`), so bm25f's index is the one `v17` would build.
- **The lists (dry run).** The target is in a hit list of the choice turn
  for all 158 probes in both copies. It is first in the first list for 147
  with bm25f and 124 in the recorded run. Median `sci_find` text in the
  choice turn: `full` 6,816 characters, `bm25f` 6,396.

### This is a ceiling test

The target is listed in both copies for every included probe, and the `full`
copy read it in 158 of 158 turns in the first replay. The replay can detect a
loss from the new order or the new neighbours; it cannot show a gain. The
gain of bm25f is in the lists (step 2) and in the queries of other models
(step 3).

### Rules fixed before this run

- **Validity.** Rule 1 (the `full` replay reads the target at least as often
  as the recorded run minus 5) and rule 2 (parity failures plus hash
  mismatches at most 5), as in the compact notebook. If either fails, no
  comparison is reported.
- **Analysis set.** Probes with both copies `ok`, `full` prompt-token parity,
  and the same system prompt and tools in both copies.
- **Primary.** `bm25f` − `full`, target read in the choice turn, paired by
  probe; Newcombe method 10 95% CI; margin −5 points. Lower bound above −5:
  non-inferior. Upper bound below 0: inferior. Otherwise: inconclusive.
  McNemar exact p is reported.
- **Secondary.** Outcomes of the choice turn per copy; the discordant probes
  with the target's rank in each list; prompt tokens, output tokens and
  `sci_find` characters (paired medians).
- **Report:** `node scripts/find-live-replay-report.mjs <out> --variant bm25f`.

### Decision rule

- **Non-inferior:** 4a passes. bm25f can become the default in 1.8.0 when
  step 3's rule also holds (and 4b, if it runs, shows no loss); the held-out
  set is run once and reported before the change.
- **Inferior:** bm25f does not become the default. The discordant probes are
  examined.
- **Inconclusive:** no default change and no automatic second sample.
  Daniel decides.

### Predictions

- Faithful: the `full` replay reads the target in 153 or more.
- `bm25f` reads the target in 155–158; discordant pairs 0–3 in total.
- Verdict: non-inferior, about 75%. Most of the rest: inconclusive.
- Prompt tokens: `bm25f` about 100 lower (median), from the shorter lists.

### Commands

From a checkout at this commit, with the model server running:

```bash
node scripts/find-live-replay.mjs <main-checkout>/testing/transcripts/find-live/2026-09-25-night-arms --out <main-checkout>/testing/transcripts/find-live/2026-09-27-find-ranker-replay --variants full,bm25f
```

```bash
node scripts/find-live-replay-report.mjs <main-checkout>/testing/transcripts/find-live/2026-09-27-find-ranker-replay --variant bm25f
```

### Results

Run 2026-09-28, 18:09–21:44 (local), from dec0c5f (the night queue; see
the provenance note in the step 3 addendum). Raw output in the main
checkout's gitignored `testing/transcripts/find-live/2026-09-27-find-ranker-replay/`
(`report.txt`).

- **Analysis set.** 158 (3 excluded: no `sci_find` call; 0 errors, 0 parity
  failures, 0 hash mismatches).
- **Validity.** Faithful: `full` read the target in 156, the recorded run
  in 157 (rule 1 met; rule 2 met, 0).

| | `bm25f` | `full` | Diff (Newcombe 95% CI) | Discordant | Verdict (margin −5) |
|---|---|---|---|---|---|
| Target read in the choice turn | 158/158 | 156/158 | +1.3 (−1.3 to 4.5) | 2:0, McNemar p 0.50 | **non-inferior** |

- Discordant, both for `bm25f`: `datalad` (rank 2; `full` made another
  call) and `deepchem` (rank 1; `full` read `torchdrug` and `pytdc`).
- Paired medians, `bm25f` − `full`: `sci_find` characters −333; prompt
  tokens −65.5; output tokens +3.5. Seconds at position 1: 46.4 vs 43.8.
- **Predictions.** Faithful (153 or more): met, 156. `bm25f` 155–158 with
  0–3 discordant: met, 158 and 2. Non-inferior (about 75%): met. Prompt
  tokens about 100 lower: −65.5, smaller than predicted. The run took
  3.6 h, not the 3 h expected.
- **Decision.** 4a passes. By the decision rule, bm25f can become the
  default in 1.8.0 when step 3's rules hold over all writers (and 4b shows
  no loss); the held-out set runs once first.

## Step 3: first queries from a panel of query writers (pre-registered)

### Why

The development results use Bonsai's recorded queries and the raw request
text. The goal is older and smaller models in general, so this step asks
other models to write the first query and ranks each query offline under
both rankers. No writer's queries change the ranker: its settings stay as
committed in 5123f67.

### Writers and styles

| Writer | Model | Styles |
|---|---|---|
| `haiku` | Claude Haiku 4.5 (OpenRouter, through pi) | original, plain, synonym, expert |
| `gemma12b` | Gemma 4 12B (`gemma4:12b-mlx`, Ollama) | original, plain, synonym, expert |
| `gemma-e4b` | Gemma 4 E4B (`gemma4:e4b`, Ollama) | original, plain, synonym, expert |
| `bonsai` | Ternary Bonsai 2 27B (llama-server, the usual script and flags) | plain, synonym, expert |

- Bonsai has no `original` cell: its 425 recorded queries on the original
  tasks are the development data, and a fresh run would repeat them.
- Not qwen3.8:27b: it is Bonsai's base model.
- **Local writers join on setup facts only**, checked on a smoke of 3–5
  probes before their run, never on outcomes: (1) `sci_find` calls arrive as
  structured tool calls, with no response that ends in a parse error;
  (2) the thinking level is accepted (no provider error); (3) the prompt is
  not cut (pi's first-request prompt tokens within 10% of the expected size,
  and no truncation line in the server log). E4B joins by the same rules.
  If a smoke forces a setup change (the thinking level, the context length),
  a dated addendum here names it before that writer runs.

### Design

- `scripts/find-panel.sh`, one `--out` for every writer:
  `testing/transcripts/find-live/2026-09-27-find-panel/` in the main
  checkout (gitignored). At the first start it `git archive`s this commit
  into `<out>/src/`; every writer runs the harness from that copy.
- Per attempt: `--endpoint first-find --attempts 1 --responses 5
  --gate-calls 10 --timeout 600 --thinking medium`, the usual persona. The
  attempt stops at the model's first `sci_find` call; nothing it returns
  reaches the model. The ranker the model sees is `current` (the default)
  but plays no part: the query is written before any result.
- Probe files: `testing/find-probes.json` (original, 162) and
  `scripts/find-probes-styled.mjs` (synonym 161, plain 161, expert 160).
- One attempt per probe per style, at each provider's default sampling
  (the harness sets no temperature).
- Harness errors (`no-run`) are run again once with `--resume`; the rest
  are listed and left out.
- **Disclosure.** Commit 7a4c7e3 changed the harness's names-the-skill rule
  to whole words. The only probe it lets in is the expert paraphrase for
  `shap` ("Shapley-consistent"), a strong hint at SHAP. It stays in: the
  bench already includes it. The step 4a replay does not load probes through
  that rule, so its registered design is unchanged.

### Rules fixed before this run

- **Unit and denominator.** One attempt. It counts when its first
  `sci_find` message has a query ("searched"). Profile-only messages,
  gated attempts and attempts that sought a skill another way are tallied
  in the search rate, not scored.
- **Primary.** The target in the top 8 for the first query of the first
  `sci_find` message, ranked by `search()` with each ranker's own no-match
  rule; `bm25f` − `current`, paired by attempt. Per writer and style:
  Newcombe method 10. Pooled per writer and over the counted writers:
  Newcombe and a cluster bootstrap by target (10,000 resamples, seed
  20260927), because a target repeats once per style.
- **Counted writers.** A writer counts toward a rule with 50 or more
  searched attempts over its styles; toward the 4b rule with 30 or more in
  the plain style. Fewer: "no data" for that writer.
- **Rule A, no worse for every writer.** Each counted writer's pooled point
  estimate is 0 or more. A loss for any writer is examined before anything
  ships.
- **Rule B, better on average.** Over the counted writers, both lower
  bounds are above 0: met. Both at 0 or below: not met. They disagree:
  inconclusive, and Daniel decides.
- **4b skip rule.** If the plain-style gain is under 3 points for every
  counted writer, step 4b does not run. With no counted writer, 4b stays.
- **Secondary.** The search rate by outcome, per writer and style; the
  union of the first message's queries in the top 8; the raw request text
  as the query (model-free). Top 1 and top 3 are not in the rules.
- **Report:** `node <out>/src/scripts/find-panel-report.mjs <out>` (the
  frozen copy, so the rankers are this commit's; the report says so).

### Limits

- The tasks are development data. The synonym, plain and expert texts were
  the development bench (raw text as the query), and the original tasks
  gave Bonsai's recorded queries. The writers' queries are new, but a gain
  here is not a clean test. The held-out set (novice and terse styles, step
  1) is the clean test, run once at step 5.
- One attempt per probe, and the sampling defaults differ by provider.
- Haiku runs through OpenRouter, and the route may change between calls.
- D (rewritten descriptions) is not scored here; it stays deferred.

### Predictions

- Search rate: Haiku 95% or more in every style; Bonsai 85–95%; Gemma 12B
  70–95%; E4B 40–90% (little evidence for the Gemma models).
- Top 8 under `current`: Haiku and Bonsai 90–97%; the Gemma models lower.
  The writers' queries are keyword lists more than requests, so the gap is
  much smaller than on the raw plain text (77.0 → 95.0).
- Pooled gain per writer: +1 to +5 points; larger for the smaller writers.
- Rule A met: about 80%. Rule B met: about 60%; most of the rest
  inconclusive (few discordant attempts per target).
- The plain-style gain is 3 points or more for at least one counted writer
  (4b stays): about 60%.
- Cost: Haiku about 640 attempts at about $0.004, about $2.5.

### Commands

The Haiku run needs no GPU and can run at any time:

```bash
scripts/find-panel.sh --out <main-checkout>/testing/transcripts/find-live/2026-09-27-find-panel --writer haiku --model openrouter/anthropic/claude-haiku-4.5 --styles original,plain,synonym,expert
```

Local writers add `--health-url` (and `--models-json` for Ollama) and never
run while another model server holds the GPU.

### Addendum 2026-09-27 17:10 (before any local writer ran)

- **Sampling (a correction).** "Each provider's default sampling" is not
  exact. pi sends the `samplingParams` of the model's models.json entry.
  Bonsai: temperature 1.0, top_p 0.95, top_k 20 (the usual entry). Gemma
  12B and E4B: temperature 1.0, top_p 0.95, top_k 64 (Google's defaults,
  the 12B tag's own defaults) in a `--models-json` override that is not
  committed. The E4B tag's own defaults (temperature 0.2, a system line)
  are thereby replaced. Haiku has no entry: pi's default for that provider.
  This changes no rule.

### Addendum 2026-09-27 19:35: setup smokes (no setup change)

Five plain-style probes per local writer (diffdock, polars, pymc, scanpy,
shap), through `scripts/find-panel.sh`, outside the panel directory.

| Writer | Tool calls | Thinking `medium` | Prompt (first request) | Context | Joins |
|---|---|---|---|---|---|
| Bonsai 2 27B | structured | accepted | 1,954–1,997 tokens | 65,536 | yes |
| Gemma 4 12B | structured | accepted, no provider error | 1,731–1,773; the server processed all of it | 131,072 | yes |
| Gemma 4 E4B | structured | accepted, no provider error | 1,732–1,774; `truncated = 0` | 32,768 (the tag's `num_ctx`) | yes |

Timing: a searched attempt takes 8–56 s. An attempt that does not search
runs 5 responses (270–350 s for the Gemma models on polars).

- E4B: the override replaces temperature, top_p and top_k; the tag's
  `repeat_penalty` 1.05 still applies. The tag's own system line is not
  used: on every probe the E4B prompt is exactly 1 token longer than the
  12B prompt (1,746 vs 1,745, 1,732 vs 1,731, ...), where a prepended
  system line would add about 15.
- Step 4a runs from the launch commit, which `commit.txt` records. The diff
  of `scripts/find-live-replay.mjs`, `scripts/lib/`, `extensions/` and
  `skills/` since 945684d is empty, and the replay does not import
  `scripts/test-find-live.mjs`.

### Results

**Haiku 4.5** (2026-09-27, 17:04–18:48, 640 attempts; `autoskill` is
untestable and not run). Report from the frozen copy (c816e82).

| Style | Searched | Top 8, current | Top 8, bm25f | Diff (Newcombe 95% CI) | Discordant |
|---|---|---|---|---|---|
| original | 155/161 | 152/155 (98.1%) | 154/155 (99.4%) | +1.3 (−1.9 to 4.9) | 3:1 |
| synonym | 153/160 | 145/153 (94.8%) | 152/153 (99.3%) | +4.6 (0.6 to 9.4) | 8:1 |
| plain | 153/160 | 144/153 (94.1%) | 149/153 (97.4%) | +3.3 (−0.3 to 7.6) | 6:1 |
| expert | 154/159 | 151/154 (98.1%) | 154/154 (100%) | +1.9 (−0.8 to 5.6) | 3:0 |
| pooled | 615/640 | 592/615 (96.3%) | 609/615 (99.0%) | +2.8 (1.3 to 4.5; bootstrap by target 0.8 to 5.2) | 20:3 |

- Not searched: 13 gated, 11 persona-end, 1 max-responses. No harness
  errors. The probe-check judge flagged 10 attempts; the rules do not drop
  them (the query comes before any result).
- Secondary: any query of the first message in the top 8: current 98.5%,
  bm25f 99.2% (+0.7, −0.4 to 1.9). A second query in the same message
  recovers most of the current ranker's misses.
- Model-free: the request text as the query, same attempts: current 89.1%,
  bm25f 98.7% (+9.6, 7.3 to 12.3). This is development data.
- For Haiku alone, rules A and B are met. The plain-style gain is 3.3
  points, so 4b stays in the plan whatever the other writers show. The
  rules are decided over all counted writers, after the local writers run.
- Predictions: search rate 95% or more in every style, met (95.6–96.9%).
  Current 90–97%: pooled 96.3%, in range (original and expert 98.1%, just
  above). Pooled gain +1 to +5: +2.8, in range.

**Bonsai 2 27B** (2026-09-28 21:43 – 2026-09-29 05:22, 479 attempts, the
night queue from dec0c5f; the harness from the frozen c816e82 copy).

| Style | Searched | Top 8, current | Top 8, bm25f | Diff (Newcombe 95% CI) | Discordant |
|---|---|---|---|---|---|
| synonym | 154/160 | 151/154 (98.1%) | 153/154 (99.4%) | +1.3 (−1.9 to 5.0) | 3:1 |
| plain | 156/160 | 149/156 (95.5%) | 155/156 (99.4%) | +3.8 (0.9 to 8.2) | 6:0 |
| expert | 152/159 | 149/152 (98.0%) | 152/152 (100%) | +2.0 (−0.8 to 5.6) | 3:0 |
| pooled | 462/479 | 449/462 (97.2%) | 460/462 (99.6%) | +2.4 (0.9 to 4.3; bootstrap by target 0.6 to 4.7) | 12:1 |

- Not searched: 7 timeouts (a response past 600 s; Bonsai sometimes spends
  its whole 8,192-token thinking budget), 6 persona-end, 4 gated. No
  harness errors; the second pass ran nothing.
- Secondary: any query of the first message: current 97.6%, bm25f 99.6%
  (+1.9, 0.6 to 3.7). Model-free: current 86.8%, bm25f 98.3% (+11.5).
- Predictions: search rate 85–95%: 95.6–97.5%, above the range. Current
  90–97%: 97.2%, just above. Pooled gain +1 to +5: +2.4, in range.
- The panel took 7.6 h (the smoke suggested about 4 h).

**Two writers so far (Haiku, Bonsai).** Counted: both. Rule A (no worse
for every writer): met. Rule B (better on average): current 96.7%, bm25f
99.3%, +2.6 (Newcombe 1.6 to 3.8; bootstrap by target 0.8 to 4.9): met.
Plain-style gain: Bonsai 3.8, Haiku 3.3, so 4b stays. These verdicts are
final only when the Gemma writers have run.

### Addendum 2026-09-29: two writers, and the design to ship

Written before the held-out set is read and before any Gemma run.

- **Gemma 4 12B and E4B do not run.** Daniel decided this on 2026-09-29,
  after the Haiku and Bonsai results were in. The step 3 rules are final
  over the two counted writers: rule A met, rule B met (+2.6, Newcombe 1.6
  to 3.8, bootstrap by target 0.8 to 4.9), and the plain-style gain is 3
  points or more (Bonsai 3.8, Haiku 3.3), so a live test stays in the plan.
  The Gemma predictions are not scored.
- **What this loses.** Whether a 4B-class model calls `sci_find` at all. No
  ranker changes that. Both counted writers are larger than the smallest
  models in the goal (Bonsai 2 is a 27B dense model; Haiku's size is not
  public). The case that the ranker result holds for weaker writers rests on
  the raw request text, the worst query a writer can give: bm25f top 3 is
  equal to or above current top 8 in every development set (for example
  plain, 88.8 against 77.0).
- **The design to ship (changes step 5).** bm25f becomes the default
  (`PI_SCI_FIND_RANKER=current` keeps the old ranker for one release). The
  first `sci_find` search after a user prompt shows 3 results; later
  searches show 5. The `limit` parameter goes. The compact format stays
  experimental and does not ship.
- **Why a fixed count.** The goal is fewer result tokens (shorter prefill).
  In the panel's first messages, Haiku set `limit` in 415 of 813 calls (322
  asked for 10, 40 for 12 to 20) and Bonsai in 163 of 528 (77 asked for 10,
  62 for 12 to 20). A default alone would leave those calls at 10 or more.
- **Why 3, then 5.** The panel's first queries under bm25f: top 3 98.7%
  (Bonsai), 96.4% (Haiku; plain 92.8%); top 5 99.4% and 98.2%. Top 1 to 5
  are secondary measures, outside the step 3 rules.
- **Not yet tested.** Top 3 at the model's choice. The finding that the
  model reads a listed target that is not first (32 of 32) comes from lists
  of 8. When the target is not in the 3, the model must search again with
  other words. The form of the live test is decided after the held-out run.

### Held-out run (pre-registered 2026-09-29, before the set is read)

- **Data.** The locked set: 162 probes × novice and terse, less the 3 leak
  cells, 321 cells. The SHA-256 of the three files is checked against the
  table above before the run.
- **Query.** The request text of the cell, with no model (as in the
  development table). This is harsher than a model's query.
- **Script.** `scripts/find-rank-heldout.mjs <dir>` prints counts only. A dry
  run on a copy built from the development paraphrases (plain as novice,
  synonym as terse) gave the development table's values exactly.
- **Primary bar: the first search's 3 results against today's 8.** Per
  style, bm25f top 3 − current top 8, paired by cell: the point estimate is
  0 or more and the Newcombe lower bound is above −5 points. Met for both
  styles: the work goes on to the code change and the live test. Not met for
  either style: stop; Daniel decides; no default changes on this evidence.
- **Secondary.** Top 1, 2, 3, 5 and 8 and the no-hit share, both rankers.
  Top 5 is the size of later searches. An absolute 95% for top 3 applies to
  model queries (the panel); on raw text it is reported, not a bar.
- **Predictions.** Novice: bm25f top 3 80–92%, current top 8 70–85%.
  Terse: bm25f top 3 88–98%, current top 8 80–95%. The bar is met for both
  styles: about 85%. bm25f top 3 is lower than on the development
  paraphrases (the settings were chosen there): about 75%.
- **Used once.** The result is reported whatever it is. After this run the
  set is development data.

```bash
node scripts/find-rank-heldout.mjs <main-checkout>/test-artifacts/find-rank-heldout
```

**Results** (2026-09-29, once, from 69eea24; the three hashes matched the
table above).

| Style | n | bm25f top 3 | current top 8 | Diff (Newcombe 95% CI) | Discordant | Bar |
|---|---|---|---|---|---|---|
| novice | 161 | 151 (93.8%) | 130 (80.7%) | +13.0 (6.9 to 19.7) | 25:4 | met |
| terse | 160 | 159 (99.4%) | 153 (95.6%) | +3.8 (0.9 to 8.0) | 6:0 | met |
| pooled | 321 | 310 (96.6%) | 283 (88.2%) | +8.4 (5.0 to 12.2) | 31:4 | met |

Target in the top k (%), request text as the query:

| Style | Ranker | Top 1 | Top 2 | Top 3 | Top 5 | Top 8 | No hit |
|---|---|---|---|---|---|---|---|
| novice | current | 47.8 | 57.8 | 64.6 | 77.0 | 80.7 | 0.0 |
| novice | bm25f | 77.0 | 91.9 | 93.8 | 94.4 | 96.9 | 0.0 |
| terse | current | 62.5 | 78.8 | 85.6 | 91.3 | 95.6 | 0.0 |
| terse | bm25f | 94.4 | 98.1 | 99.4 | 100.0 | 100.0 | 0.0 |

- The bar is met for both styles. bm25f top 3 is above current top 8 even
  with no model writing the query.
- Predictions: bm25f top 3 above both ranges (novice 93.8 against 80–92,
  terse 99.4 against 88–98). Current top 8 in range for novice (80.7), just
  above for terse (95.6). "bm25f lower than on the development paraphrases"
  was not met: novice 93.8 against plain 88.8, terse 99.4 against synonym
  98.1 (different styles, so a loose comparison).
- The set is now development data.

### Addendum 2026-09-29: OpenRouter smoke, Gemma 4 26B-A4B (no setup change)

- **Model.** `openrouter/google/gemma-4-26b-a4b-it` (mixture of experts,
  25.2B parameters in total, 3.8B active per token), thinking `medium`,
  sampling 1.0 / 0.95 / top_k 64 in a `--models-json` override (not
  committed).
- **Provider.** A pin failed: with `only: ["deepinfra"]` (with and without
  the fp8 and require-parameters filters) OpenRouter answered 404, "No
  allowed providers". With no routing preferences the model runs. pi's
  session file does not record the serving provider, so routing is a limit
  of any run on this model.
- **New search** (713d6e8, bm25f, 3 then 5), five plain probes (diffdock,
  polars, pymc, scanpy, shap), endpoint `read`: structured tool calls,
  thinking blocks present, no error stops, first prompt 1,734–1,751 tokens.
  Four read the target in response 1 (8–10 s). polars never called
  `sci_find`; the model wrote the code itself. Every first search showed 3
  hits with the target among them (scanpy 2nd).
- **Later searches.** A scripted task with two searches in two turns: the
  first showed 3 hits, the second 5. The event wiring works in pi 0.84.3.
- **Control** (a `git archive` of 0a8ddfd, whose `extensions/` equals
  d75588b's; `--find-ranker current`): shap and scanpy read in response 1;
  8 hits, 5,690–7,400 characters per result.

## Next

- Step 4b (live A/B on the full attempt), if step 3 does not skip it.
- Step 5: ship 1.8.0 when the rules hold; the held-out set runs once first.
