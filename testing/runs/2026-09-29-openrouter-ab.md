# Run notebook: old search against new search, Gemma 4 26B-A4B on OpenRouter

**Status: done (2026-09-29). Verdict: non-inferior.** The pre-registration was
written and committed before the first request of the run. Results are at the
end; the rules above them do not change.

## Why

1.7.0 changes `sci_find` in three ways (713d6e8): the BM25F ranker is the
default, the first search after a prompt shows 3 hits and later searches 5,
and the model can no longer set `limit`. Offline, bm25f top 3 beat current
top 8 on the locked held-out set (pooled +8.4 points, 95% CI 5.0 to 12.2;
testing/runs/2026-09-27-find-ranker.md). Fewer hits means a shorter prompt
for the choice turn, so faster prefill.

This run asks whether the product still gets the model to the right skill in
a live conversation, and how many prompt tokens the change saves. It is also
the first full pi workflow through a cloud inference provider.

## Arms

| Arm | Package | Ranker | Hits shown | `limit` |
|---|---|---|---|---|
| `old` | 0a8ddfd (`git archive`), the last commit before the change; its `extensions/` equals d75588b's | current | 8 unless the model sets `limit` | in the schema |
| `new` | the commit of this pre-registration (`git archive`) | bm25f | 3 for the first search after a prompt, then 5 | not in the schema |

Both arms list no skill in the prompt and load the extension (the 1.7.0
default). The tool description differs: `new` adds one sentence on the hit
counts, and `old` has the `limit` field. So this compares product against
product, not the ranker alone. The `old` hit count is not fixed at 8: a model
can set `limit` (578 of 1,341 panel calls did).

## Setup

- **Model.** `openrouter/google/gemma-4-26b-a4b-it` (mixture of experts,
  25.2B parameters in total, 3.8B active), thinking `medium`, sampling 1.0 /
  0.95 / top_k 64 from a `--models-json` override (not committed). No provider
  pin (a pin returned 404; see the ranker notebook).
- **Probes.** Two paraphrase styles from `testing/find-rank/paraphrases.json`
  through `scripts/find-probes-styled.mjs`: `plain` (160 testable) and
  `expert` (159 testable). A unit is one probe in one style: **319 units in
  160 probes**. `autoskill` is untestable in both.
- **Harness.** `scripts/test-find-live.mjs`, supervised: `--attempts 1
  --responses 5 --timeout 300 --gate-calls 10 --endpoint read`. The persona is
  claude-opus-5-5 and the probe-check judge claude-fable-5-1 (the harness
  defaults), the same in both arms.
- **Driver.** `scripts/find-ab.sh`. It `git archive`s both commits into
  `<out>/src/` and runs the harness and probes from `src/new`. The 160 probe
  ids are shuffled with seed 20260929 into 16 chunks of 10. All four
  invocations of a chunk (2 arms × 2 styles) start at the same moment, so the
  two arms of a unit meet the same provider routing and load. The next chunk
  starts when all four end. A second pass retries chunks with a harness error
  (no-run, supervisor-error). The run aborts when a chunk has 3 or more harness
  errors, a preflight fails, or the harness exits 2 or more.
- **Output.** The main checkout's `testing/transcripts/find-live/2026-09-29-openrouter-ab/`
  (it ignores itself; transcripts embed local paths).

## Rules fixed before this run

- **Analysis set.** Units in chunks complete in both arms. A unit with a
  harness error in either arm, after the second pass, leaves both arms.
- **Read.** The attempt's endpoint: the model read the target's SKILL.md in
  any of its up to 5 responses (`endedBy: "reached"`). Raw grades: the judge's
  probe-invalid calls do not change the primary.
- **Primary.** new − old read rate, pooled over both styles, paired by unit.
  Two 95% intervals: Newcombe method 10 over the units, and a percentile
  bootstrap that resamples whole probes (the two styles of a probe share a
  target; 10,000 resamples, seed 1).
  - **Non-inferior** when both lower bounds are above −5 points.
  - **Inferior** when both upper bounds are below 0.
  - **Inconclusive** otherwise.
- **Secondary** (reported, no bar):
  - read rate per style; among units that searched in both arms; without
    probe-invalid units (either arm's judge); without units with a provider
    error or a timeout in either arm;
  - per arm: search rate, `sci_find` calls per attempt, two or more searches,
    hits and characters of the first result, target in the first list,
    whether a first list without the target led to a second search, and the
    `limit` the model set;
  - paired medians: first-request prompt tokens; **choice-turn prompt tokens**
    (input + cacheRead + cacheWrite of the first assistant message after the
    first `sci_find` results, from the archived session file; units with a
    choice turn in both arms); first-result characters; time to read (units
    read in both arms). Both token measures skip provider-error messages
    (their usage is all zero; pi retries them with the same context), and the
    choice turn must come before any user message, or the unit has none;
  - provider errors, timeouts, gated attempts.
- Seconds are secondary only. On a fast provider they measure latency and
  retries, not prefill. Prompt tokens are the measure that carries over to a
  local model.

## Power

A simulation with `newcombePaired` (units as independent; the bootstrap over
probes is somewhat wider). If there is no true difference, the chance of
"non-inferior" is about 93% at 6% discordant units, 80% at 10% and 60% at
15%. If `new` is 2 points better, it is 90% or more at all three. Plain
probes alone (160 units) gave 48% at 10%, so the expert style was added
before launch.

## Predictions

- Read rate 80–95% in both arms, pooled; expert at or above plain in both.
- new − old between −3 and +5 points; verdict **non-inferior**.
- Choice-turn prompt tokens: paired median new − old between −800 and −1,300
  (setup smoke: −1,049).
- First-result characters: median about 5,000–7,000 in `old`, 2,000–3,000 in
  `new`.
- First-request prompt tokens: the arms within 50 tokens (the new sentence
  and the removed `limit` field about cancel; smoke 1,728 in both).
- Target in the first list, among first searches: `new` at or above `old`.
- Search rate: the arms within 3 points.
- Two or more searches: `new` 3–15% of searching attempts, `old` 1–10%.
- `limit` set in `old` first calls: under 20% (0 of 4 in the smoke).
- Timeouts under 5% per arm; some retried 429s in both arms.

## Decision rule

- **Non-inferior:** release prep for 1.7.0.
- **Inconclusive:** Daniel decides, with the discordant units and why each
  miss ended.
- **Inferior:** 1.7.0 does not ship the 3-then-5 search as it is. First
  examine the misses: was the target in the first list, and did the model
  search again?

## Limits

- One model, and the serving provider is unknown per request (unpinned; pi
  does not record it). Upstream 429s occur; pi retries them with the same
  context, so they cost time, not content. A stalled request ends as a
  timeout and counts as a miss in its arm; the "without provider error or
  timeout" line shows how much that matters.
- The plain and expert paraphrases are development data: the ranker's
  settings were checked on them. That favors `new`. The locked held-out texts
  are not used live, so that set stays clean.
- Gemma 4 26B-A4B has 3.8B active parameters but 25.2B in total. It is a
  mid-size mixture of experts. The result does not transfer directly to small
  dense models such as Bonsai.
- One attempt per unit at temperature 1.0.

## Setup smoke (2026-09-29, before this pre-registration; no rule depends on it)

`--only diffdock,polars,scanpy`, both styles, both arms, timeout 600: 0
harness errors; 4 of 6 read in each arm, 0 discordant; `new` first results 3
hits (median 2,452 characters) against 8 (5,680); choice-turn prompt tokens
paired median −1,049 (n 4). 3 retried 429s in `new`. One `old` attempt
(polars, expert) timed out at 600 s: after 3 quick tool calls the provider
sent nothing for 594 s. A read takes 4–24 s on this model, so the timeout is
300 s for the run.

## Commands

```bash
scripts/find-ab.sh --out <main checkout>/testing/transcripts/find-live/2026-09-29-openrouter-ab --models-json <override>
node <out>/src/new/scripts/find-ab-report.mjs <out>
```

Estimate: 16 chunks of about 5–10 minutes, 1.5–3 hours. OpenRouter cost:
cents.

### Addendum 2026-09-29 11:30 (after launch; no rule change)

- The run started at 11:25 from bec393a (the token-measure fix on top of the
  pre-registration commit; `extensions/`, `skills/` and `package.json`
  unchanged since 713d6e8).
- The setup above has a counting error. The two styles hold **161** probe
  ids, not 160: 158 in both, `citation-management` and `glycoengineering` in
  plain only, `peer-review` in expert only. So there are **17 chunks**, the
  last with one id (`hypogenic`). The unit count, 319, is right. The bootstrap
  resamples 161 probes.

### Addendum 2026-09-29 11:55: run stopped and restarted behind a key proxy (before the restart's first request)

- **Why.** The harness copied the OpenRouter key (`auth.json`) into each
  attempt's agent dir, where the model can read it with bash, and for a cloud
  model the network was open. In the stopped run, 3 attempts listed the agent
  dir and saw `auth.json`, and 4 ran `env`. None read the file. No transcript
  or workspace holds the key's prefix, and no `env` output held a variable
  named like a secret.
- **Stopped** at 11:45 in chunk 2 of 17. That run
  (`2026-09-29-openrouter-ab`) is void; its data are not analysed.
- **Fix** (e338327, from a parallel session, reviewed here): the key stays in
  a loopback proxy in the harness process, and pi gets a placeholder token.
  No `auth.json` is seeded, and no key is in pi's environment. The sandbox
  fences the network to the proxy's port in both arms.
- **Condition change, the same in both arms:** the model has no network but
  the proxy, as in the local Bonsai runs. `pip`, `curl` and downloads fail
  fast. This can change how misses end (fewer hung installs, so fewer
  timeouts). It does not favor either arm.
- **The new arm** is the commit of this addendum. `extensions/`, `skills/`
  and `package.json` are unchanged since 713d6e8; the packed tarball differs
  from bec393a in DOCUMENTATION.md only.
- **Disclosure.** During a health check at 11:36 I saw chunk 1's read counts
  per arm in the void run: old plain 7/10, new plain 5/10, old expert 5/9,
  new expert 8/9 (25 of 38, below the predicted 80–95%). Those data are
  discarded. No rule or prediction changes.
- **Proxy smoke** (diffdock, polars, scanpy × 2 styles × 2 arms, HTTPS to
  openrouter.ai): 0 harness errors, 0 provider errors; 4 of 6 read in each
  arm; choice-turn prompt tokens paired median −988 (n 4).
- **Output:** `testing/transcripts/find-live/2026-09-29-openrouter-ab-2/`.
  Everything else is as pre-registered.

### Addendum 2026-09-29 12:35: second run stopped; restart with `MPLBACKEND=Agg` (before the restart's first request)

- **Why.** The sandbox does not fence the window server, pi's environment set
  no matplotlib backend, and the Python on PATH (miniforge) defaults to the
  macOS backend. A test model's `plt.show()` (seaborn, matplotlib and aeon
  probes) opened windows on Daniel's screen and blocked the bash call until
  the window closed or the 300 s response timeout. So a person closing a
  window could change an attempt's outcome and time. The macOS log shows the
  backend loaded at 11:51 (matplotlib probe).
- **Stopped** at 12:24 in chunk 3 of 17. The second run
  (`2026-09-29-openrouter-ab-2`) is void; its data are not analysed. Its
  health checks showed me harness errors, one timeout line (`pptx-posters`,
  new expert) and two `plt.show()` tool calls (`seaborn`), not read counts.
- **Fix** (8aaae45): pi's environment sets `MPLBACKEND=Agg` in both arms, so
  `plt.show()` warns and returns at once (checked with the same Python: 0.01
  s). The model sees one more warning line; nothing else changes.
- **Earlier live runs** had the same exposure. At night nobody closed a
  window, so a `plt.show()` blocked until the timeout, in any arm. Not
  examined here.
- **The new arm** is the commit of this addendum. `extensions/`, `skills/`
  and `package.json` are unchanged since 713d6e8.
- **Output:** `testing/transcripts/find-live/2026-09-29-openrouter-ab-3/`.
  Everything else is as pre-registered and as the 11:55 addendum.

## Results (third run, 2026-09-29 12:27–15:17)

All 17 chunks completed in 169 minutes. The run had 0 harness errors, so the
second pass had nothing to retry. The analysis set is all 319 units (161
probes). `node <out>/src/new/scripts/find-ab-report.mjs <out>` gives the
numbers below. `MPLBACKEND=Agg` worked: one `plt.show()` (pylabrobot, chunk
7) printed the Agg warning and returned.

### Primary

| | new | old | new − old | Newcombe 95% CI | Bootstrap over probes 95% CI |
|---|---|---|---|---|---|
| Read, pooled | 244/319 (76.5%) | 225/319 (70.5%) | **+6.0 pts** | 1.0 to 10.9 | 0.6 to 11.2 |

Discordant units: 42 read by `new` only, 23 by `old` only (McNemar exact p
0.025). Both lower bounds are above −5, so the verdict is **non-inferior**.
Both lower bounds are also above 0, but no superiority test was
pre-registered, so "better" is an observation only. The paraphrases are
development data, and that favors `new` (Limits).

### Secondary

| Subset | n | new | old | new − old (Newcombe 95% CI) | Discordant, McNemar p |
|---|---|---|---|---|---|
| plain | 160 | 126 (78.8%) | 118 (73.8%) | +5.0 (−1.7 to 11.7) | 19:11, 0.20 |
| expert | 159 | 118 (74.2%) | 107 (67.3%) | +6.9 (−0.3 to 14.1) | 23:12, 0.090 |
| searched in both arms | 226 | 218 | 209 | +4.0 (−0.2 to 8.5) | 16:7, 0.093 |
| without probe-invalid | 290 | 239 | 222 | +5.9 (0.8 to 11.0) | 37:20, 0.033 |
| without provider error or timeout | 313 | 241 | 224 | +5.4 (0.6 to 10.3) | 39:22, 0.040 |

| Per arm | new | old |
|---|---|---|
| Searched | 255/319 (79.9%) | 245/319 (76.8%) |
| Read when searched | 244/255 (95.7%) | 225/245 (91.8%) |
| Two or more searches, of searching attempts | 12/255 (4.7%) | 6/245 (2.4%) |
| First list: hits | 3 in 243 of 255 | 8 in 110 of 245; 1–7 in 133; 0 in 2 |
| First list: characters, median | 2,072 | 5,316 |
| Target in the first list | 236/255 (92.5%) | 228/245 (93.1%) |
| Listed first, not read | 2/236 | 7/228 |
| Not listed first: searched again, read | 12 and 10 of 19 | 6 and 4 of 17 |
| `limit` set by the model | not in the schema | 0 of 251 calls |
| Endings: persona-end, gated, max-responses, timeout | 40, 23, 10, 2 | 40, 31, 19, 4 |
| Provider errors | 0 | 0 |
| Probe-invalid (judge) | 23 | 20 |

| Paired medians | n | new | old | new − old |
|---|---|---|---|---|
| First-request prompt tokens | 319 | 1,723 | 1,722 | 0 |
| **Choice-turn prompt tokens** | 226 | 2,789 | 3,735 | **−867.5** (new lower on 172) |
| First-result characters | 226 | 2,082 | 5,270 | −3,063 |
| Time to read, s (both read) | 202 | 5 | 6 | 0 |

**Where the difference comes from.** The net +19 discordant units split in
two. In 23 of the discordant units, the arm that missed had searched: 16
favor `new`, 7 favor `old` (p 0.093). This part is the effect of the list.
In the other 42, the arm that missed never called `sci_find`: 26 favor
`new`, 16 favor `old` (exact binomial p 0.16). There the arms differ only in
the tool description, so that part is noise at temperature 1.0 or an effect
of the description. It is not the ranker. Live, the two arms listed the
target in the first list about equally often (92.5% against 93.1%), but each
arm ranked its own queries, so this compares query sets as well as rankers.
The paired re-rank below separates the two. `new` also did better after the
list: it read a listed target more often (234/236 against
221/228), and when the target was not listed it searched again more often
(12/19 against 6/17).

**The weak point is the decision to search.** 64 of 319 `new` attempts and 74
of 319 `old` attempts never called `sci_find`, and none of them read the
target: 64 of the 75 `new` misses and 74 of the 94 `old` misses never
searched. This is a property of the model and of the tool description.
The ranker cannot fix it.

### Predictions

| Prediction | Result | |
|---|---|---|
| Read rate 80–95% in both arms | new 76.5%, old 70.5% | miss |
| Expert at or above plain in both arms | expert lower in both (new 74.2 vs 78.8, old 67.3 vs 73.8) | miss |
| new − old between −3 and +5 | +6.0 | miss |
| Verdict non-inferior | non-inferior | hit |
| Choice-turn tokens −800 to −1,300 | −867.5 | hit |
| First-result characters: old 5,000–7,000, new 2,000–3,000 | 5,316 and 2,072 | hit |
| First-request prompt tokens within 50 | 0 | hit |
| Target in the first list: new ≥ old | 92.5% against 93.1% | miss (small) |
| Search rate within 3 points | 3.1 points | miss (small) |
| Two or more searches: new 3–15%, old 1–10% | 4.7%, 2.4% | hit |
| `limit` set in under 20% of `old` first calls | 0% | hit |
| Timeouts under 5% per arm | new 0.6%, old 1.3% | hit |
| Some retried 429s | 0 provider errors recorded | miss |

### Notes

- **Arms table correction.** The `old` hit count is "up to 8", not "8
  unless the model sets `limit`". The current ranker has a score floor
  (`MIN_SCORE`, higher for a one-term query), and 133 of 245 first lists had
  1–7 hits. No `old` call set `limit`. The comparison stays product against
  product.
- **Disclosure.** During the run I saw pooled counts for both arms together:
  endings at chunk 3 (73 of 118 read) and at chunk 6 (161 of 233 read, 61 of
  72 misses without a search). I also saw per-arm token and cost totals for
  chunks 1 and 2. I did not see per-arm read counts before the report.
- **Cost.** Gemma, from pi's price table: $1.47 in total, `new` $0.60,
  `old` $0.87. No request had a cache read. The persona and judge calls
  (`claude -p`) were not recorded.

### Post hoc: both rankers on the same Gemma queries

Not pre-registered. It answers whether the equal listing rate above means
that bm25f lists the target less well for Gemma. The first query of each
searching attempt (500: 245 `old`, 255 `new`) runs through both rankers
offline, from the frozen `src/new` copy. It reproduces the live rates: `old`
queries, current top 8, 93.1%; `new` queries, bm25f top 3, 92.5%.

| Queries | n | current top 8 | current top 3 | bm25f top 3 | bm25f top 5 | bm25f top 8 | bm25f top 3 only : current top 8 only |
|---|---|---|---|---|---|---|---|
| `old` arm | 245 | 93.1% | 82.0% | 95.9% | 97.1% | 98.4% | 12:5 |
| `new` arm | 255 | 90.2% | 82.0% | 92.5% | 94.9% | 96.5% | 16:10 |
| both | 500 | 91.6% | 82.0% | 94.2% | 96.0% | 97.4% | 28:15 (McNemar exact p 0.066) |

On the same queries, bm25f top 3 lists the target more often than current
top 8 (+2.6 points). The live arms were about equal because the `new` arm's
queries were harder: current top 8 lists 90.2% of them and 93.1% of the
`old` arm's. At temperature 1.0 the two arms write different queries. The
panel gave the same direction for the first queries of Bonsai (bm25f top 3
98.7%, current top 8 97.2%) and Haiku (96.4%, 96.3%). Gemma's queries are
weaker under both rankers.

### Finding: when Gemma searches, it reads the right skill

| | new | old |
|---|---|---|
| Read the target, all attempts | 244/319 (76.5%) | 225/319 (70.5%) |
| Read the target, when it searched | 244/255 (95.7%) | 225/245 (91.8%) |
| Misses without a `sci_find` call | 64 of 75 | 74 of 94 |
| Read the target, probe-invalid units left out (either arm) | 239/290 (82.4%) | 222/290 (76.6%) |

With 162 skills installed and 3.8B active parameters, Gemma 4 26B-A4B reads
the right skill in 96% of the attempts where it calls `sci_find` (new
search). Most misses are attempts that never search: the model starts the
task itself. It searched in 80% of attempts. In the panel, Haiku searched in
615 of 640 (96.1%) and Bonsai in 462 of 479 (96.5%); that harness and those
probe styles differ, so the comparison is loose.

So, for small models, the next gain is in the decision to search: the tool
description and prompt wording, not the ranker. Limit: there is no Gemma run
with all 162 skills listed in the prompt (the normal install), so this run
does not compare the extension with that baseline for this model.

### Decision

Non-inferior, so, by the decision rule, release prep for 1.7.0 goes ahead.
The search decision (20–23% of attempts never searched) is a separate
problem for the tool description.

## Release-review notes (2026-09-30)

Written at the release review, after the results. They add facts from git.
They change no rule, number or result above. Times are commit times from
`git log` on 2026-09-29 (-0700).

### A pre-registered outcome definition was edited in place

- 02bb091 (11:22:01) pre-registered this run. bec393a (11:25:20, 3 min 19 s
  later) edited the "Secondary" paragraph of the rules in place. The list of
  paired medians first ended "time to read (units read in both arms);", with
  no rule for errors. bec393a added two rules: both token measures skip
  provider-error messages, and the choice turn must come before any user
  message, or the unit has none. The same commit changed
  `scripts/find-ab-report.mjs` and `scripts/test-live-lib.mjs` to match. It
  also flipped one test expectation: for a fixture in which a user message
  comes before the next answer, the choice-turn tokens were 100 and are now
  none.
- The run began at 11:25 from bec393a (first addendum), so the edit came
  before the first request. The first addendum is in a3146f4, 36 s after
  bec393a, and says the run had started. Git does not hold the launch time.
- The edit covers the secondary token measures only. The primary outcome
  (read rate), both intervals, the verdict rule and the decision rule are as
  registered in 02bb091.
- The headline token result uses the amended definition: choice-turn prompt
  tokens, paired median −867.5 (the subject line of 9dc417c rounds it to
  −868). The prediction "−800 to −1,300" was scored as a hit under the
  amended definition too. The notebook did not compute the value under the
  02bb091 text, and I did not. The amendment probably changed nothing here.
  Both arms show 0 provider errors, and `providerErrors` in
  `scripts/lib/pi-session.mjs` counts every assistant message with stop
  reason "error", so the first rule had nothing to skip. The choice-turn line
  and the first-result line both have n 226, equal to "searched in both
  arms", so the second rule left out no unit. The choice that the old report
  used is the first assistant entry after the results, whatever comes
  between (`choiceTurn` in `scripts/lib/replay.mjs`). So, with no error
  messages and no unit left out, the old and the new definition pick the
  same message in every paired unit. I did not check this against the
  transcripts.

### Addendum times

The clock time in each addendum heading is later than the commit that holds
it:

| Heading | Commit | Commit time | Heading is later by |
|---|---|---|---|
| "Addendum 2026-09-29 11:30 (after launch; no rule change)" | a3146f4 | 11:25:56 | 4 min 4 s |
| "Addendum 2026-09-29 11:55: run stopped and restarted behind a key proxy (before the restart's first request)" | e526e04 | 11:50:31 | 4 min 29 s |
| "Addendum 2026-09-29 12:35: second run stopped; restart with `MPLBACKEND=Agg` (before the restart's first request)" | 0453a70 | 12:26:20 | 8 min 40 s |

The commit times are the record.

- **First run.** Started at 11:25 from bec393a. The addendum text says it
  stopped at 11:45. It is void.
- **Second run.** Started after e526e04 (11:50:31). The 12:35 addendum gives
  11:51 as the time its matplotlib probe loaded the backend, the earliest
  time the notebook gives for its requests. The addendum text says it stopped
  at 12:24. It is void.
- **Third run.** Started after 0453a70 (12:26:20). The Results heading gives
  12:27 to 15:17. This run is the one analysed.

Git holds no record of the stop times and the health-check times in the
addendum text. Each of them is earlier than the commit that reports it. The
claim in the two restart headings, "before the restart's first request",
holds against the commit times, not against the heading times. The 11:55
heading is later than the matplotlib load (11:51) of the run it introduces,
and the 12:35 heading is later than the third run's start (12:27).

### Sections written after the results

- "Post hoc: both rankers on the same Gemma queries" was added by 8ba6328
  (15:41:30), 20 min 23 s after the results commit 9dc417c (15:21:07). It is
  post hoc, as its text says.
- The same commit, 8ba6328, also rewrote three lines of the results
  paragraph "Where the difference comes from". 9dc417c said that among
  searches `new` "did not put the target in the first list more often".
  8ba6328 says the arms listed the target about equally often, but that each
  arm ranked its own queries. No number changed. The notebook did not
  disclose the rewrite. The earlier wording is in git history.
- "Finding: when Gemma searches, it reads the right skill" was added by
  63b55db (15:45:41). It is also written after the results and was not
  pre-registered.
- The status line at the top (written in 9dc417c) says the pre-registration
  was committed before the first request and that the rules do not change.
  Read it with the first section above: the rules are those of 02bb091 as
  amended by bec393a before launch.

### Scope of the evidence

This run compares the old search (0a8ddfd) with the new search on one model,
Gemma 4 26B-A4B. The earlier 157-against-116 result (+25.5 points, Bonsai 2
27B, [`2026-09-25-night-arms.md`](2026-09-25-night-arms.md)) was measured on
the package content of 08aff2e, launched from 49288d1: the old ranker, 8
hits and a `limit` argument the model could set. The BM25F ranker and the
3-then-5 list (713d6e8) came later. No single run compares the shipped tip
with 1.6.0 on one model.
