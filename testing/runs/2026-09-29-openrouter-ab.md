# Run notebook: old search against new search, Gemma 4 26B-A4B on OpenRouter

**Status: pre-registered.** This section was written and committed before the
first request of the run. Results go below it; the rules above them do not
change.

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
