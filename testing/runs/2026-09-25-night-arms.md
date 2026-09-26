# Run notebook: three arms — 1.6.0 against 1.7.0, and 1.7.0 against all skills listed (Bonsai 2 27B)

**Status: pre-registered.** Everything above "Results" was written before the
first graded probe of the run. The smoke check ran before the run and is not
part of it.

## Questions

1. **1.6.0 against 1.7.0 defaults.** 1.7.0 removed the ten Core skills from the
   search-mode prompt and listed `sci_find` in it. Does the model still read
   the right skill as often? What does the change save in context and time?
2. **1.7.0 against the normal install.** With all 162 skills listed in the
   system prompt and no `sci_find`: how often does the model read the right
   skill, and what does the 23k-token index cost in context and speed?

## Arms

| Arm | Package | Skills in the system prompt | `sci_find` |
|---|---|---|---|
| `v16` | 1.6.0, commit `98cb371` | Core, 10 skills (the 1.6.0 `/sci search` default) | Yes. In the tool schema only: no prompt snippet, no guideline. |
| `v17` | 1.7.0, the launch commit (in `sources.txt`) | None (the 1.7.0 default) | Yes, listed under "Available tools", with one guideline. |
| `full` | The same 1.7.0 package, extension not loaded (`extensions: []`) | All 162 | No. No `/sci` either: a plain skills install. |

`v17` is in both comparisons. Each arm is a bundle. `v17` against `v16`
changes three things together: Core leaves the prompt, `sci_find` gets its
snippet and guideline, and the description and scope sentence change.

## Conditions

Same as 2026-09-23 ([`2026-09-23-bonsai2-27b.md`](2026-09-23-bonsai2-27b.md)):
model, server script and flags, pi 0.84.3, persona `claude-opus-5-5`, judge
`claude-fable-5-1`, sandbox, probe file. Differences:

- **One attempt per probe per arm**, up to 5 responses, 1200 s per response.
- **Endpoint: read, not listed.** In `full` every target is already listed, so
  a listing cannot be the endpoint. The endpoint is a successful `read` of
  `skills/<target>/SKILL.md`, or a bash command that names
  `<target>/SKILL.md` and prints its `name: <target>` line
  (`scripts/lib/pi-session.mjs`, `skillReads`). The response stops there. The
  time of the first listing is also recorded (`listed`, `listedSeconds`).
- **Timeout gate at 10 calls.** An attempt ends as `gated`, a miss, when its
  first 10 tool calls (counted across responses) hold no skill-seeking call.
  A skill-seeking call is a `sci_find` call, or a `read` or bash call whose
  path, command or bash output holds `SKILL.md` or a `/skills/` path segment
  (`isSeek`). The 1200 s limit stays as the backstop.
- **Warm-up.** Each harness invocation first sends one ungraded request
  ("Reply with the single word OK."). It pays the cold prefill of the system
  prompt, which llama.cpp keeps in its prefix cache (pi puts the skills block
  before the working-directory line and adds no date). Its cost is recorded in
  `results-<arm>.warmup.jsonl`.
- **Frozen sources.** The driver `git archive`s both commits into `src/` at the
  start. Every invocation runs from that copy.
- **Chunks and order.** Chunk 1 is the 10 Core probes. The other 151 follow
  in a shuffle fixed by seed 20260925, in chunks of 10 (`order.tsv`). Each
  chunk runs all three arms before the next starts. The arm order rotates per
  chunk: `v16 v17 full`, then `v17 full v16`, then `full v16 v17`. A run that
  stops at a chunk boundary leaves a balanced, paired sample.

Command (the driver, `scripts/find-live-arms.sh`, fixed per-arm flags):

```bash
scripts/find-live-arms.sh --out testing/transcripts/find-live/2026-09-25-night-arms \
  --server <start-bonsai2-server.sh> [--stop-after <HH:MM>]
```

Per arm and chunk it runs:

```bash
node src/v17/scripts/test-find-live.mjs --probes src/v17/testing/find-probes.json \
  --model prism-llama/Ternary-Bonsai-2-27B-PQ2_0 --thinking medium \
  --attempts 1 --responses 5 --timeout 1200 --gate-calls 10 \
  --endpoint read --warmup <arm flags> --only <chunk> \
  --results results-<arm>.jsonl --resume --archive-to archive/<arm>/chunk-NN
```

Arm flags: `v16` `--package-dir src/v16 --prompt-skills core`; `v17`
`--package-dir src/v17 --prompt-skills none`; `full` `--package-dir src/v17
--prompt-skills all --no-extension`.

## Rules fixed before the run

- **Overflow and compaction.** pi compacts when the context passes 65,536 −
  16,384 = 49,152 tokens, and writes a `compaction` entry. A compaction is
  recorded and the attempt continues. A provider overflow error (llama.cpp:
  "exceeds the available context size") is recorded; pi then compacts and
  retries once. If the response still ends on an overflow error, the attempt
  ends as `overflow`. It counts as not read, and is reported apart.
- **Analysis set.** Probes in complete chunks only: chunks where all three arms
  finished.
- **Harness errors.** A probe with a `no-run` or `supervisor-error` line in any
  arm is re-run with `--resume` before analysis. If it cannot be re-run, it
  leaves the analysis set in all arms.
- **Probe-invalid.** The judge rules per arm, so one probe can be invalid in
  one arm only. The **primary analysis uses raw grades** and drops nothing. A
  secondary analysis drops a probe from all arms when the judge marks it
  invalid in any arm.

## Outcomes

**Primary 1: `v17` against `v16`, non-inferiority.** Paired by probe,
attempt-1 read rate (read = the endpoint was reached). `v17` is non-inferior
if the lower bound of the 95% CI for the paired difference `v17 − v16`
(Newcombe's hybrid score interval for paired proportions, method 10) is above
−5 percentage points. Core and non-Core are also reported apart.
With about 100 paired probes and few discordant pairs, the CI will be wide.
The run may be unable to rule out a loss of 5 points. If so, that is the
result, stated as such.

**Primary 2: `v17` against `full`.** Paired read-rate difference with 95% CI
(same method), and McNemar's exact test. No margin and no direction are
predicted.

**Secondary**, per arm:

- first-prompt tokens (pi usage: input + cacheRead + cacheWrite of the first
  request);
- time to read (`endpointSeconds`), paired medians on probes read in both
  arms;
- peak context, output tokens, tool calls per attempt;
- generation and prompt-processing tok/s by context bin, from the server log
  joined to arms by the driver log's time windows;
- warm-up cost per invocation;
- attempts ended by `gated`, `timeout`, `overflow`, `persona-end`,
  `max-responses`;
- compactions;
- `listed` without a read: how often a listing did not lead to a read.

## Predictions

- **First prompt:** `v17` about 1.95k tokens (pilot: 1,925–1,948, before the
  wording change); `v16` about 3.3k (1.84k plus about 1.4k for Core); `full`
  about 25k (about 1.65k without the `sci_find` definition, plus about 23.2k
  for the index). The index estimates use OpenAI tokenizers. Bonsai's own
  count may differ.
- **Generation speed:** median about 19 tok/s in `v16` and `v17` (under-4k
  context bin on 2026-09-23), about 16 tok/s in `full` (16k–32k bin).
- **Read rate, `v17` against `v16`:** within noise on non-Core probes. On Core
  probes, `v16` reads the target sooner, because it is listed.
- **Read rate, `v17` against `full`:** no prediction.
- **Overflow:** rare, and in `full` only. Compactions mostly in `full`.

## Evidence for the gate (fixed before the run)

Replay of the gate over the 2026-09-23 session files (185 attempts, listed
endpoint, search mode), with the `isSeek` definition above:

| Gate | Reaches lost | Misses gated (of 28) | Of them timeouts | Time saved, estimate |
|---|---|---|---|---|
| 5 calls | 1 | 18 | 13 | about 4.0 h |
| 8 calls | 0 | 14 | 11 | about 2.6 h |
| **10 calls** | **0** | **12** | **10** | **about 2.1 h** |

- The first skill-seeking call of the 157 reaching attempts was call 0 (90),
  1 (57), 2 (7), 3 (1), 4 (1) or 7 (1), counting from 0.
- The estimate is the attempt's recorded end minus the time of the 10th call's
  result. The 4.0 h figure for N = 10 in the earlier planning notes used a
  different estimate; this replay is the one fixed here.
- A first definition matched `/skills-plugin/` in a PATH that the model
  printed with `env`, and gated only 9. The definition was fixed to need a
  whole `/skills/` path segment before the run.
- **Untested:** the gate's zero loss is measured in search mode with the
  listed endpoint only. It is not tested for `full`, where the seek is a
  `read` of a listed SKILL.md, or for the read endpoint.

## Limits (stated before the run)

- **One attempt per probe per arm, at temperature 1.0.** No variance
  estimate per probe. The 2026-09-24 pilot showed how much one attempt moves:
  11 of 12 probes that had a no-search attempt on 2026-09-23 searched at once.
- **The gate can only lower read rates.** It was fixed from other data before
  the run, and applies the same rule to every arm.
- **The `v17` guideline says "Then read the SKILL.md it returns".** `v16` has
  no such line. Under the read endpoint this favors `v17` for a reason other
  than Core leaving the prompt. It is part of the shipped product, so the
  comparison stands, but the report must say so.
- **One server for all arms.** Speed is comparable within this run only.
  Thermal drift is spread across arms by the rotation, not removed.
- **The judge audits only attempts the persona ended satisfied without a
  read.** It does not audit reads, gated attempts or timeouts.
- **Probes are easy on search** (see [`../analysis.md`](../analysis.md)): the
  run measures whether the model looks and reads, not ranking on vague needs.
- **A night may not finish all 17 chunks.** The run continues on later nights
  with the same `--out`; the order and the sources stay fixed.

## Smoke check (before the run, not part of it)

Three probes (`polars`, `scanpy`, `dask`) per arm, through the driver, with
the run's flags. Harness frozen at commit `af4e299`. Output in the gitignored
`testing/transcripts/find-live/2026-09-25-night-arms-smoke/`.

| Arm | Warm-up | First prompt | Read | Endpoint at | Arm time |
|---|---|---|---|---|---|
| `v16` | 32 s | 3,770–3,792 tokens | 2 of 3 (`scanpy` gated) | 32, 67 s | 5 min |
| `v17` | 17 s | 1,938–1,960 tokens | 3 of 3 | 35–58 s | 2 min |
| `full` | 314 s (cold prefill) | 30,823–30,845 tokens | 3 of 3 | 23–63 s | 7 min |

- **Prompt sizes.** `v17` is as predicted. `v16` and `full` are larger than
  predicted (about 3.3k and 25k): Bonsai's tokenizer counts more tokens than
  the OpenAI estimate. The predictions above are kept as written.
- **Room before compaction in `full`:** peak context 31.1k–31.4k, against the
  49,152 threshold. An attempt that grows by more than about 18k tokens
  compacts. No compaction and no overflow in the smoke.
- **The gate fired once:** `v16` `scanpy` made 10 bash calls (environment
  checks, then a `pip install` that failed on the sandbox network) and no
  seek. The gate ended it at 164 s.
- **Warm-up.** In `full` it costs about 5 min per invocation. The three
  probes after it took about 2 min together, so the prefix cache held.
- **Estimate:** about 1 h per chunk of 10 probes in three arms, so 17 chunks
  need more than one night.
- **Abort rule.** Against a fake server that passes `/health` and returns
  HTTP 500 on every request, three probes ended `no-run`, the harness stopped
  and the driver aborted and stopped the server. A harness exit code of 2 also
  aborts.

- **Arm contents, from the requests.** A fake server recorded the request
  body of each arm at commit `08aff2e`. `v16`: tools `read bash edit write
  sci_find`, `sci_find` not named in the system prompt, 10 skills listed.
  `v17`: the same tools, `sci_find` named in the system prompt, no skills
  listed. `full`: tools `read bash edit write`, no `sci_find` anywhere, 162
  skills listed.

Harness changes after the smoke, before the run (not in the smoke):

- `4fef0ce`: the log says "stopped early", not "stopped on reach", for a gate
  stop. Log text only.
- `00ef62f`: a response that ends on a provider error other than an overflow
  (the server died, an HTTP 500) is a harness error (`no-run`), not a miss.
  Before, it was graded as the model's answer. None occurred in the 185
  sessions of 2026-09-23 or in the smoke. The gate check runs before this
  rule.

## Results

Pending.

### Notes during the run

**2026-09-25, first session (chunk 1 done, chunk 2 part done, paused).** Daniel
stopped the run at 09:53 with `pkill`. Chunk 1 is complete in all arms.
Chunk 2 is complete for `v17`; `full` finished 5 of 10; `v16` did not start.

- **The stop hung** until llama-server got a second TERM: the driver sends
  one and waits. No data was lost to this.
- **Five `full` attempts in chunk 2 have no session files.** The harness
  archives transcripts only when an invocation ends normally, so the stop
  lost them. Their results lines are kept and they stay in the read-rate
  analysis. They have no server timing (below). The attempt in flight
  (`pi-agent`) has no line and runs again on resume.
- **Queue wait (found after the run started, measured post hoc).** A stop on
  reach or gate kills pi, but llama.cpp finishes the prefill of the cancelled
  request before it frees the slot. The next attempt's first request waits
  for it: median 11.2 s in `v16`, 15.8 s in `v17`, 16.7 s in `full`, and
  0–0.7 s when the attempt before did not stop (the first probe of an
  invocation, or after a `persona-end`). The recorded time to read
  (`endpointSeconds`) includes this wait, so it is biased by arm. Read rates
  and the gate do not depend on it.
- **Added measure, not pre-registered:** `endpointSecondsNet`, the time to
  read minus the queue wait of the attempt's requests before the read, from
  `scripts/find-live-timing.mjs` (server log joined to the session files).
  The pre-registered time to read is still reported as recorded, with the net
  value beside it and labelled post hoc. The script also gives prefill and
  generation seconds per attempt and warm-up, which is how the pre-registered
  prompt-processing and generation speeds are measured.
- **A stop may also slow the next prefill (measured post hoc, small n).** The
  first request of an attempt that follows a stop prefilled at 59 tok/s in
  `v16` (9 requests) against 109 (1 request) otherwise, and at 44 against 82
  in `full` (9 against 1). `v17` showed no slowdown: 108 (17) against 110 (3).
  `endpointSecondsNet` removes the queue wait only; this slowdown, about 4–5 s
  per attempt where it occurs, stays inside it and may differ by arm. The
  per-attempt `firstAfterStop` and first-request prefill fields let the
  analysis estimate it once each arm has more first probes (one per
  invocation). The speed table leaves out warm-ups and requests right after a
  stop.
- **Warm-up cost depends on the arm before.** Cold starts (chunk 1): `v16`
  30.6 s for 3,744 tokens, `v17` 15.8 s for 1,913, `full` 293.2 s for 30,634.
  The chunk 2 `v17` warm-up processed 515 tokens and reused 1,397 from the
  server's cache. Warm-up costs are reported with their cached tokens.

**2026-09-25/26, second session (resumed 20:52, stopped by `--stop-after
07:30` at 07:34).** Chunks 2–9 finished in all arms. No `no-run` or
`supervisor-error` lines. The server log holds two server runs; the join
found both clock offsets under 1 s and paired 645 of 656 finished requests.
Five `full` probes of chunk 2 have no timing (sessions lost, above), and
`molfeat` and `rdkit` in `v16` have none: both reads have no recorded time
(`seconds: null` in `reaches`, cause not checked), so they drop out of every
time-to-read comparison.

- **Post-stop prefill slowdown, whole night** (first request of an attempt,
  after a stop against not): `v16` 93 tok/s (76) against 110 (14); `v17` 107
  (80) against 109 (10); `full` 44 (76) against 78 (9). The early `v16`
  figure (59) was small-n. The slowdown stays inside `endpointSecondsNet` and
  costs `full` the most.
- **Warm-up per chunk:** `full` 290–303 s every chunk. `v17` reused the
  server's cache in chunks 2, 5 and 8 (515 processed, 1,397 cached).

### Interim look after night 1 (chunks 1–9, 90 paired probes)

Not the final analysis. Chunks 10–17 run as planned whatever these numbers
show. The CIs are not adjusted for this look. All nine chunks are complete in
all three arms; analysis set 90 (Core 10, non-Core 80).

| | `v16` | `v17` | `full` |
|---|---|---|---|
| Read | 69/90 | 89/90 | 87/90 |
| Core / non-Core | 10/10, 59/80 | 10/10, 79/80 | 10/10, 77/80 |
| Ended | reached 69, timeout 9, gated 9, persona-end 2, max-responses 1 | reached 89, persona-end 1 | reached 87, gated 2, timeout 1 |
| First prompt, median tokens | 3,789 | 1,945 | 30,824.5 |
| Peak context, median / max | 6,874 / 51,859 | 4,353.5 / 38,250 | 31,039 / 56,367 |
| Tool calls, median | 3 | 2 | 1 |
| Output tokens, median | 689.5 | 338.5 | 236 |
| Compactions | 1 | 0 | 1 |
| Overflow errors | 0 | 0 | 1, recovered by compaction |
| Attempt time, sum | 426 min | 100 min | 106 min |

`listed` without a read: 0 in `v16` and `v17`. (In `full` every target is
in the prompt, so the count says nothing there.)

**Primary 1, `v17 − v16`:** +22.2 points, Newcombe 95% CI 14.1 to 31.8;
discordant 20:0, McNemar exact p = 1.9 × 10⁻⁶. The lower bound is far above
−5: non-inferior at this look. Core: 0.0 (CI −27.8 to 27.8, 0:0). Non-Core:
+25.0 (15.9 to 35.4, 20:0).

The 20 `v16` misses and the bundle caveat: 14 never sought a skill (9 gated,
3 timeouts, 1 persona-end, 1 max-responses). 4 read other skills without
`sci_find`: three read listed Core skills (`paper-lookup`,
`citation-management`, `scientific-writing`, `experimental-design`), one read
`phylogenetics`. 2 called `sci_find`, the target was not in its results, and
they read `paper-lookup` and `tamarind`. All 6 ended as timeouts. No miss had the
target listed and unread, so "Then read the SKILL.md it returns" explains
none of the 20. The gap is in whether and where the model looks.

**Primary 2, `v17 − full`:** +2.2 points, Newcombe 95% CI −1.9 to 7.8;
discordant 2:0 (`seaborn` gated, `scikit-survival` timeout in `full`),
McNemar exact p = 0.50. Core: 0.0 (−27.8 to 27.8). Non-Core: +2.5 (−2.1 to
8.7). The CI includes 0.

**Secondary analysis without probe-invalid probes** (`pi-agent` in `v16` and
`v17`, `consciousness-council` in `v16`; 88 left): `v17 − v16` +21.6 (13.2
to 31.3), 19:0, p = 3.8 × 10⁻⁶; `v17 − full` +2.3 (−2.2 to 7.9), 2:0,
p = 0.50.

**Time to read, paired medians on probes read in both arms.**

| | n | `v17` | other arm | paired median `v17 −` other | `v17` faster |
|---|---|---|---|---|---|
| `v17`/`v16`, recorded (`endpointSeconds`) | 67 | 55 s | 62 s | −6 s | 42 of 67 |
| `v17`/`v16`, server-exact (post hoc) | 67 | 55.1 | 61.6 | −6.7 | 42 of 67 |
| `v17`/`v16`, net of queue (post hoc) | 67 | 40.1 | 55.4 | −9.7 | 45 of 67 |
| `v17`/`full`, recorded | 87 | 55 | 42 | +13 | 14 of 87 |
| `v17`/`full`, server-exact (post hoc) | 82 | 55.3 | 42.5 | +13.1 | 15 of 82 |
| `v17`/`full`, net of queue (post hoc) | 82 | 40.6 | 27.3 | +13.1 | 14 of 82 |

Time to read counts reads only (69 and 87 pairs read in both; the
`v16` pairs `molfeat` and `rdkit` have no time). `full` pays its warm-up
(290–303 s per chunk, about 30 s per probe) outside this measure, and its
post-stop slowdown inside it.

**Predictions against the interim data.**

- First prompt: `v17` 1,945 (predicted about 1.95k), `v16` 3,789 (about
  3.3k), `full` 30,824.5 (about 25k). Bonsai counts the index at about 29k,
  not 23k.
- Generation: about 20 tok/s in `v16` and `v17` (predicted 19), 13–14 in
  `full` (predicted 16).
- Read rate on non-Core, `v17` against `v16`: predicted within noise.
  **Wrong:** +25.0 points, in `v17`’s favor.
- Core, `v16` reads sooner: **held.** Recorded time to read, 10 of 10 faster
  in `v16`; median 29.5 s against 56 s.
- Overflow rare and in `full` only: held (1). Compactions mostly in `full`:
  not shown (1 in `v16`, 1 in `full`).

**Speed** (server log, without warm-ups and post-stop requests): prefill /
generation tok/s `v16` 111/20 under 4k tokens and 103/16 at 16k–32k; `v17`
114/20 under 4k; `full` 75/14 at 16k–32k and 74/13 at 32k and more.
Computed with `scripts/find-live-timing.mjs` and scratch tallies; the final
analysis will use a committed report script.
