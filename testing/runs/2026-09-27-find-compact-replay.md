# Run notebook: a compact `sci_find` result, replayed on the choice turn (Bonsai 2 27B)

**Status: pre-registered.** Everything above "Results" was written before the
first request of the run. The smoke check ran before the run and is not part
of it.

## Question

When `sci_find` shows the top 2 hits in full and the others with the first
sentence of their description only, does the model still pick the right skill
as often? And how much context does that save?

## Background (from [`2026-09-25-night-arms.md`](2026-09-25-night-arms.md), arm `v17`)

- **The choice turn** is the model response after the first `sci_find`
  result. In 157 of 157 attempts that read the target, the read came in
  exactly this one turn.
- The median time between the search and the read was 25.2 s. Prefill took
  16.9 s (1,959 new tokens at 114 tok/s) and generation took 7.3 s
  (142 tokens). There was no queue wait. Most of the new tokens are the
  `sci_find` result: its median is 6,816 characters in this turn.
- **The target's place in the first hit list** (158 searches): 1st in 123,
  2nd in 15, 3rd–6th in 14, 7th–8th in 3, absent in 3. The top 6 hold it in
  152 of 158 searches, the top 2 in 138. When the target was listed but not
  first, the model read it anyway, in all 32 cases. (The replay's dry run
  takes the first hit list of the choice turn, not of the first call, and
  gives 124, 15, 14, 3 and 2.)
- A description has a mean of 405 characters (52 words, about 115 tokens).
  The median first sentence is 112 characters.

## Arms

Both arms are the same recorded session, cut after the tool results of the
first `sci_find` call. Only the text of those results differs.

| Arm | The `sci_find` results in the choice turn |
|---|---|
| `full` | As recorded: every hit with its full description, its load line and its references line (the 1.7.0 format). |
| `compact` | The same hits, in the same order, rendered by `extensions/catalog.ts` with `PI_SCI_FIND_FORMAT=compact`. |

The compact format:

```
## <hit 1>
<full description>
Load with: read <…>/<hit 1>/SKILL.md
References inside it are relative to <…>/<hit 1>

## <hit 2>
(the same 4 lines)

More matches, with the first sentence of each description only. Paths inside a SKILL.md are relative to its folder.

## <hit 3>
<first sentence of the description>
Load with: read <…>/<hit 3>/SKILL.md

(hits 4 and on: the same 3 lines)
```

- A call without `limit` gets 6 hits in `compact` (8 in `full`). A call with
  `limit` gets that many hits in both arms. The model passed a `limit` in 66
  of the 180 `sci_find` calls that come before the 158 choice turns.
- A result with 2 hits or fewer is the same in both arms. Profile listings,
  the profile index and no-match results are not changed.
- The descriptions come from the current catalogue. The parser gate (below)
  shows that they are the same as in the recorded run.

## Conditions

- **Source run:** `testing/transcripts/find-live/2026-09-25-night-arms`
  (gitignored), arm `v17`. Its frozen package is `src/v17` (commit
  `49288d1`). `skills/` and `extensions/` have no diff between `49288d1` and
  this commit.
- **Model and server:** the same as 2026-09-25: Ternary Bonsai 2 27B PQ2_0,
  the same server script and flags, one slot, temperature 1.0, thinking
  `medium`. pi 0.84.3.
- **How a request is made:** `scripts/find-live-replay.mjs` writes the cut
  session to a file. `scripts/lib/replay-worker.mjs` opens that file with
  pi's own SDK (`createAgentSession` with `SessionManager.open`) and continues
  the agent for one turn. It uses the recorded working directory, an agent dir
  with only the frozen package (no skills listed) and the recorded
  `models.json`, and a fresh `HOME` and `TMPDIR`. Tools never run: every
  tool's `execute` is a stub that throws. The turn is stopped at the first
  assistant message.
- **One sample per arm per probe.** The arm order alternates by probe:
  `full` first on the 1st, 3rd, … included probe, and `compact` first on the
  others.
- **Parser gate:** before any request, each recorded `sci_find` hit list is
  parsed and rendered again in the full format. The render must equal the
  recorded text byte for byte, or the probe is an error. In the dry run all
  158 prepared probes passed.

## Rules fixed before the run

- **Analysis set.** A probe is in the set when all 3 of these hold:
  1. Both arms returned a message (`status: ok`).
  2. **Parity:** the prompt tokens of the `full` replay (input + cache read +
     cache write) equal the recorded choice-turn request exactly.
  3. **Same prompt:** within the probe, both arms saw the same system prompt
     and tool definitions (hashes). The system prompt holds the recorded
     working directory, so it differs across probes by design. It is compared
     within a probe only.
  Probes with no `sci_find` call before the choice, or no recorded choice
  turn, are excluded. The dry run expects 158 probes: 161 minus `pi-agent`,
  `get-available-resources` and `scholar-evaluation`, which have no
  `sci_find` call. A `--resume` re-run of an error replaces it (the last line
  wins).
- **Validity.** The `full` replay must reproduce the live choice. The rule:
  on the analysis set, the number of `full` replays that read the target must
  be at least the recorded number minus 5. The recorded number is 157 of 158
  in the dry run. If the rule fails, the replay is not faithful and no
  comparison between arms is reported. The paired `full` replay − recorded
  discordance is reported either way: it is the noise floor of one sample
  at temperature 1.0.
- **Same-request rule.** More than 5 probes with a parity failure or a hash
  mismatch (counted together) means the replay is not the recorded request.
  Within one probe a hash mismatch can only come from a bug. Then the replay
  is not faithful and no comparison is reported. The report applies both
  validity rules and prints which one failed.
- **Stop rule for errors.** The runner stops after 3 errors in a row.

## Outcomes

- **Primary:** the target's `SKILL.md` is read in the choice turn (a `read`
  of `…/<target>/SKILL.md`, or a bash command that names
  `<target>/SKILL.md`, alone or together with other reads;
  `classifyChoice` in `scripts/lib/replay.mjs`). The comparison is
  `compact` − `full`, paired by probe, with the Newcombe method 10 95% CI.
  **`compact` is non-inferior when the lower bound is above −5 points.**
  McNemar exact p is also reported.
- **Secondary (format alone):** the same test, restricted to probes where the
  target is listed in both arms. On this sample it is the primary set: no
  target falls out because of the 6-hit default, because every target at
  rank 7–8 came from a call with an explicit `limit` (dry run: 0 cut off). In
  every choice turn some hit list names the target (dry run: 0 with no list;
  the 2 probes absent from the first list are in a later list of the same
  turn). It is reported for use on other samples.
- **Secondary measures (paired, median of compact − full):** characters of
  the `sci_find` text, prompt tokens and output tokens.
- **Choice outcomes per arm:** target, other skill, a new search, another
  call, no call. Results are also given by the target's rank in the first
  list: 1, 2, 3–6, and 7+ or absent.
- **Seconds (descriptive only).** With one slot, the second request of a
  probe reuses the cached prefix (about 1,890 tokens in the smoke). The first
  request of a probe shares no cache with the probe before it, because the
  working directory in the system prompt differs. So seconds are compared
  only between rows at position 1: this is unpaired, with about 79 rows per
  arm. The position-2 rows are listed apart. The replay prefills the whole
  prompt at position 1, while the live run had its prefix cached, so seconds
  here are not comparable with the live run.
- **Report:** `node scripts/find-live-replay-report.mjs <out>`.

## Decision rule

If the replay is not faithful, no comparison is made; find the cause first.
If it is faithful, the primary 95% CI gives one of three results:

- **Non-inferior** (lower bound above −5 points): the next step is a live
  A/B. The harness gets a `--find-format` passthrough, and one night runs
  `full` against `compact` on the whole attempt. The default does not change
  on the replay alone.
- **Inferior** (upper bound below 0): stop. `full` stays the only format, and
  the flag is removed.
- **Inconclusive** (otherwise): the run cannot rule out a loss of 5 points,
  which is not the same as a loss. The next step is a second sample with the
  same design, analysed with the first as one sample of two requests per
  probe per arm. That analysis is pre-registered before the second sample
  runs.

## How strict the margin is

The ceiling is near 100%, so the discordant count decides the test. At
n = 158 with no probe missed by both arms (Newcombe method 10):

| Probes read by `full` only | by `compact` only | Lower bound | Non-inferior |
|---|---|---|---|
| 0 | 0 | −2.37 | yes |
| 2 | 0 | −4.50 | yes |
| 3 | 0 | −5.43 | no |
| 3 | 1 | −4.84 | yes |
| 4 | 2 | −5.19 | no |

With no gains, three losses fail the test. This is strict on purpose: the
change is only useful if the pick does not get worse. At temperature 1.0 with
one sample, noise alone can produce a few discordant probes. The validity
line shows how many. A failure of this kind is "inconclusive", not
"inferior" (see the decision rule).

## Predictions

- **Validity:** `full` replay reads the target in 153 or more of about 158
  (recorded 157), with 0–3 discordant probes against the recorded choice.
- **Primary:** `compact` reads the target within 2 probes of `full`, and it
  is non-inferior. I put this at about 65%, because the margin allows little
  noise; most of the rest is inconclusive, not inferior. Any losses fall mostly at ranks 3–6, where the target has only its
  first sentence.
- **Prompt tokens:** median paired difference about −1,000 tokens (dry run:
  median `sci_find` text 6,816 → 3,222 characters, at about 3.5 characters
  per token). Probes with long lists or several `sci_find` calls save more.
- **Output tokens:** no difference (the paired median within ±20).
- **Seconds at position 1:** `compact` about 9 s faster (about 1,000 fewer
  tokens at about 110 tok/s of prefill). Unpaired, so noisy.

## Limits (stated before the run)

- **One turn only.** A wrong pick that the model would correct in a later
  turn counts as a miss in both arms. Whether the model uses the paths of an
  alternate's `SKILL.md` correctly after the read is not tested. An alternate
  has no "References inside it are relative to" line, only the general
  sentence on the alternates line.
- **The first `sci_find` call only.** Later calls in the attempt are not
  changed.
- **One sample per arm at temperature 1.0.** The validity line gives the
  noise floor. A second sample would double the run time.
- **The tool schema still says "default 8".** The model sees that text in
  both arms, and in `compact` a call without `limit` gets 6 hits.
- **The pi SDK, not the `pi -p` CLI.** Parity of prompt tokens in the `full`
  arm shows that the request content is the same. The recorded `models.json`
  is assumed unchanged since the run; parity would also catch a change there.
- **Not in doubt after the smoke:** the recorded working directory no longer
  exists and pi does not need it (parity held). The thinking content is
  present. The tool stub is called and returns its error.
- **Sampling is the only source of difference inside a probe.** Thermal
  state changes over the run. The alternating order balances it between arms
  on average only.

## Smoke check (before the run, not part of it)

On 2026-09-27, with the server started from the same script:

- **Parity:** `full` only, 3 probes (`citation-management`,
  `experimental-design`, `exploratory-data-analysis`). The prompt tokens
  equalled the recorded ones: 3,971, 4,375 and 4,130. The target was read in
  3 of 3. Thinking content was present (65–361 characters).
- **Stub proof** (`--prove-stub`, `citation-management`): the turn ran to its
  `turn_end`. The `read` call returned "replay: tools do not run in a replay"
  with `isError: true`.
- **Both arms,** 2 probes with the target lower in the list: `bioservices`
  (rank 5) and `pathml` (rank 6). The target was read in 4 of 4. Prompt
  tokens `full` → `compact`: 4,269 → 3,188 and 7,441 → 4,764. Parity held on
  both `full` replays.
- **Time:** 37–61 s for a request at position 1, and about 20 s for a short
  request at position 2 (1,888–1,890 cached tokens).
- **Estimate for the run:** 316 requests (158 probes × 2), about 3–3.5 h.
- These rows ran before the `listed` field was added to the result lines. They
  are not part of the run.

## Commands

From a checkout at this commit, with the model server running:

```bash
node scripts/find-live-replay.mjs <main-checkout>/testing/transcripts/find-live/2026-09-25-night-arms --out <main-checkout>/testing/transcripts/find-live/2026-09-27-find-compact-replay
```

After an interruption, add `--resume`. Report:

```bash
node scripts/find-live-replay-report.mjs <main-checkout>/testing/transcripts/find-live/2026-09-27-find-compact-replay
```

## Results

Not run yet.
