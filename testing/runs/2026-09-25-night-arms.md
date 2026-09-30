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

All 17 chunks, 161 probes, finished in all three arms: 2026-09-25 08:50 to
2026-09-26 22:45, in three sessions (notes below). No harness errors, so the
analysis set is all 161 (Core 10, non-Core 151). The numbers come from:

```bash
node scripts/find-live-timing.mjs <out> --jsonl <out>/timing.jsonl
node scripts/find-live-arms-report.mjs <out> --timing <out>/timing.jsonl
```

| | `v16` | `v17` | `full` |
|---|---|---|---|
| Read | 116/161 | 157/161 | 158/161 |
| Core / non-Core | 10/10, 106/151 | 10/10, 147/151 | 10/10, 148/151 |
| Ended | reached 116, gated 21, timeout 19, persona-end 4, max-responses 1 | reached 157, persona-end 3, timeout 1 | reached 158, gated 2, timeout 1 |

### Primary 1: `v17` against `v16`

**`v17 − v16` = +25.5 points, 95% CI 18.4 to 32.9** (Newcombe method 10);
discordant 43:2, McNemar exact p = 5.9 × 10⁻¹¹. The lower bound is above −5,
so `v17` is **non-inferior**, as pre-registered. The CI also lies wholly
above 0; superiority was not pre-registered.

- Core: 10/10 in both, 0.0 (CI −27.8 to 27.8). Ten probes cannot show a
  difference on Core.
- Non-Core: +27.2 (19.6 to 34.9), 43:2.
- Without probe-invalid probes (156): +25.6 (18.6 to 33.1), 41:1.

**The bundle caveat.** `v17` has the guideline "Then read the SKILL.md it
returns"; `v16` does not. Of the 43 probes only `v16` missed, none had the
target listed and unread, so that line explains none of them:

- 32 never sought a skill (20 gated, 9 timeouts, 2 persona-end, 1
  max-responses).
- 11 sought one: 7 read only listed Core skills (one of them after a
  `sci_find` call), 1 read `phylogenetics`, 1 used `sci_find` and read
  `tamarind` (the target was not in its results), 2 read no skill.

The gap is in whether and where `v16` looks: with ten Core skills in the
prompt it often did not look, or took a listed Core skill. The one case
against `v17`: in `deepchem`, `sci_find` listed the target at 25 s, then the
model read `torchdrug` and `pytdc` and hung on a network test until the
timeout. That is the only listed-without-read in `v17`. The 2 probes only
`v16` read are `deepchem` (`v17` timeout, above) and `scholar-evaluation`
(`v17` persona-end, judged probe-invalid in `v17`).

### Primary 2: `v17` against `full`

**`v17 − full` = −0.6 points, 95% CI −4.2 to 2.8**; discordant 2:3,
McNemar exact p = 1.0. No difference shown. No margin was set, so this is not
a claim of equivalence.

- Core: 10/10 in both. Non-Core: −0.7 (−4.5 to 2.9).
- Without probe-invalid probes (156): +0.6 (−2.4 to 4.0), 2:1.
- `v17` only: `seaborn` (`full` gated), `scikit-survival` (`full` timeout).
  `full` only: `deepchem` (above), `get-available-resources` and
  `scholar-evaluation` (`v17` persona-end; both judged probe-invalid in
  `v17`).

### Secondary

| Per attempt | `v16` | `v17` | `full` |
|---|---|---|---|
| First prompt, median tokens | 3,788 | 1,945 | 30,827 |
| Peak context, median (max) | 7,399 (51,859) | 4,331 (38,250) | 31,050 (56,367) |
| Tool calls, median | 3 | 2 | 1 |
| Output tokens, median | 731 | 348 | 228 |
| Compactions / overflow errors | 1 / 0 | 0 / 0 | 1 / 1, recovered by compaction |
| `listed` without a read | 0 | 1 | — (every target is in the prompt) |
| Attempt time, sum | 864 min | 203 min | 178 min |
| Arm time, driver (warm-ups and supervisor included) | 869 min | 203 min | about 272 min |

The `full` arm time adds about 15 min for the chunk-2 invocation stopped by
`pkill`, which has no END line.

**Warm-up per cold start** (one per invocation): `v16` 30.5–33.6 s for
3.74k–3.78k tokens; `v17` 15.7–16.6 s for 1.91k, or 4.7–4.9 s in the 5 of 17
chunks where the server's cache held 1,397 of its tokens from the arm before;
`full` 290–320 s for 30.6k–31.1k tokens, in every chunk (85 min in all).

**Time to read**, paired, on probes read in both arms:

| | n | `v17` | other | paired median `v17 −` other | `v17` faster |
|---|---|---|---|---|---|
| `v17`/`v16`, recorded | 110 | 56 s | 64.5 s | −8 s | 71 of 110 |
| `v17`/`v16`, server-exact (post hoc) | 110 | 55.9 | 64.4 | −7.6 | 71 |
| `v17`/`v16`, net of queue wait (post hoc) | 110 | 40.7 | 55.8 | −11.2 | 77 |
| `v17`/`full`, recorded | 152 | 56 | 42 | +13 | 21 of 152 |
| `v17`/`full`, server-exact (post hoc) | 147 | 56.1 | 42.1 | +13.3 | 23 |
| `v17`/`full`, net of queue wait (post hoc) | 147 | 40.9 | 27.0 | +13.1 | 21 |

Reads with no recorded time: 5 in `v16` (`molfeat`, `rdkit`, `deepchem`,
`cirq`, `scvi-tools`), 0 in `v17`, 4 in `full` (`deepchem`, `statsmodels`,
`astropy`, `cobrapy`). The stop lands after the read call but before its tool
result is written, so the harness has no `resultAt` stamp. These reads leave
the time comparisons: 4 of the 114 pairs read in both `v16` and `v17`, and 3
of the 155 read in both `v17` and `full`. Their effect on the medians is not
measured. Five `full` probes of chunk 2 have no server timing. The `full` time
to read leaves out its 5-minute warm-up per cold start.

**Server speed** (not warm-ups, not right after a stop): prefill /
generation tok/s by prompt size, (n).

| | <4k | 4k–8k | 8k–16k | 16k–32k | ≥32k |
|---|---|---|---|---|---|
| `v16` | 108 / 19 (39) | 110 / 18 (257) | 110 / 18 (112) | 100 / 16 (81) | 79 / 11 (7) |
| `v17` | 113 / 19 (107) | 115 / 19 (89) | 111 / 18 (9) | 96 / 17 (6) | 84 / 13 (1) |
| `full` | — | — | — | 75 / 14 (44) | 74 / 13 (14) |

The first request after a stop prefilled more slowly: `full` 42 against 77
tok/s, `v16` 97 against 108, `v17` 106 against 108.

**Probe-invalid** (judge): `v16` `pi-agent`, `consciousness-council`, `dask`;
`v17` `pi-agent`, `get-available-resources`, `scholar-evaluation`; `full`
none.

### Predictions

- First prompt: `v17` 1,945 (predicted about 1.95k: held). `v16` 3,788
  (predicted about 3.3k: higher). `full` 30,827 (predicted about 25k: higher;
  Bonsai counts the index at about 29k, not 23k).
- Generation, in the bins the prediction names: 19 tok/s under 4k in `v16`
  and `v17` (predicted 19: held); `full` 14 at 16k–32k (predicted 16:
  slower). Most `v16` requests were at 4k–16k, at 18 tok/s.
- Read rate on non-Core, `v17` against `v16`: predicted within noise.
  **Wrong:** +27.2 points in favor of `v17`.
- Core, `v16` reads sooner: **held**, 10 of 10 faster in `v16`, median 29.5 s
  against 56 s.
  All Core probes are in chunk 1, so this is the same data as the interim
  look.
- Overflow rare and in `full` only: held (1). Compactions mostly in `full`:
  not shown (1 in `v16`, 1 in `full`).

### Deviation: external fans off for part of the run (not pre-registered)

The external fans were on for the run, as planned, except 15:37:55–19:39:55
on 2026-09-26, when Daniel turned them off to test them. Chunk 12: the first
17 minutes of `full` had the fans on, the rest off. Chunk 13: all off. Chunk
14: `v17` and `full` off, `v16` off for its first 47 minutes. Generation was
3–5% slower with the fans off in every arm and prompt-size bin with data in
all three periods (on, off, on again), for example `v16` at 4k–8k: 19.30,
18.52, 19.07 tok/s (n 21, 41, 44). The effect on read rates is probably
small: 5% of the 1,200 s timeout is 60 s, and the gate counts calls, not
time. Details in the third-session notes below.

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
(`seconds: null` in `reaches`; the cause is in Results), so they drop out of
every time-to-read comparison.

- **Post-stop prefill slowdown, whole night** (first request of an attempt,
  after a stop against not): `v16` 93 tok/s (76) against 110 (14); `v17` 107
  (80) against 109 (10); `full` 44 (76) against 78 (9). The early `v16`
  figure (59) was small-n. The slowdown stays inside `endpointSecondsNet` and
  costs `full` the most.
- **Warm-up per chunk:** `full` 290–303 s every chunk. `v17` reused the
  server's cache in chunks 2, 5 and 8 (515 processed, 1,397 cached).

**2026-09-26, third session (resumed 11:34, DONE 22:45).** Chunks 10–17
finished in all arms. No harness errors. The server log now holds three
server runs, one per session; the join found clock offsets of 0.2, 0.5 and
0.7 s and paired 1,223 of 1,234 finished requests.

- **A hung tool call.** In `v17` `deepchem`, the model ran a Python network
  test in the sandbox that did not return; the 1,200 s timeout ended the
  attempt. The backstop worked as intended.
- **Temperature log (not pre-registered).** From 13:51 a small logger
  (`thermal/thermlog.c` in the run folder; no root needed) wrote one row
  every 10 s: macOS thermal pressure, GPU load, both internal fan speeds, GPU
  temperature (SMC `Tg*` keys) and SoC die temperature (HID `PMU tdie`
  sensors). The external fan times are in `thermal/fans.csv`. Rows during
  generation (GPU load 90% or more), by period, first 5 min after a switch
  left out, medians:

  | | On, 13:56–15:37 | Off, 15:42–19:39 | On, 19:44–22:45 |
  |---|---|---|---|
  | Rows | 353 | 876 | 589 |
  | Internal fans, rpm | 4,951 / 5,352 | 4,950 / 5,352 | 4,951 / 5,352 |
  | GPU temperature, mean / max sensor | 87.9 / 93.8 °C | 84.6 / 90.2 °C | 86.8 / 92.4 °C |
  | Rows at "heavy" thermal pressure | 39% | 45% | 40% |

  The internal fans stayed at the same speed in every period, about two
  thirds of their 7,826 rpm maximum. The energy mode is Automatic
  (`powermode 0`), which probably holds them there. With the external fans
  off, the GPU was about 3 °C cooler, heavy thermal pressure was more common,
  and generation was 3–5% slower (Results). A likely reading, not measured
  (the log has no GPU clock or power): with less cooling, macOS lowers GPU
  power sooner, so the GPU runs cooler and slower. The external fans help
  speed a little; they do not take load off the internal fans.

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
Speed from `scripts/find-live-timing.mjs`. The read rates, intervals and
times to read above come again from `scripts/find-live-arms-report.mjs`
(written after this look, same numbers).

## Release-review notes (2026-09-30)

Written at the release review, after the results. They add facts from git.
They change no rule, number or result above. Times are commit times from
`git log` (-0700).

### The interim look was not pre-registered

- The pre-registration (08aff2e, 2026-09-25 08:45:13) has no interim look.
  `git show 08aff2e:testing/runs/2026-09-25-night-arms.md` holds no such
  section. It says only that a night may not finish all 17 chunks and that
  the run continues on later nights.
- 5acfbea (2026-09-26 10:45:27) added the look at chunks 1–9 (90 paired
  probes). 6cb0728 (10:47:34) scored the predictions against it. By the
  notebook's session notes, the look came between the second session
  (stopped 07:34) and the third (resumed 11:34).
- The look gave `v17 − v16` = +22.2 points on 90 probes. The prediction
  "within noise" on non-Core was scored "Wrong" against this interim data,
  before chunks 10–17 ran. The run then went on to all 17 chunks, and the
  final figure is +25.5 on 161. The look says chunks 10–17 run as planned
  whatever the numbers show, and that its CIs are not adjusted. Git cannot
  show what would have happened with other numbers.
- What did not change, from git, between 08aff2e and 62e359d (the final
  results commit): nothing under `extensions/`, `skills/` or `package.json`.
  In `scripts/`, five files changed: the four new files named below, and
  `scripts/test-live-lib.mjs` (checks for the new scripts, and one header
  comment reworded). The harness and its scoring (`scripts/test-find-live.mjs`
  and everything it imports from `scripts/lib/`) are unchanged. The
  registered outcomes, the −5 margin and the analysis-set rule are as
  registered. The arms ran from `git archive` copies of their launch commits.

### Code added during the run

- Two timing scripts, `scripts/find-live-timing.mjs` and
  `scripts/lib/server-log.mjs`, were added in 84cffea (2026-09-25 16:35:48).
  8f52d14 (16:39:37) changed both. They join the server log to the session
  files and give the pre-registered speed and warm-up measures. They also give
  `endpointSecondsNet`, which was not pre-registered (see the session notes).
- A report script, `scripts/find-live-arms-report.mjs` with
  `scripts/lib/arms-report.mjs`, was added in 4af7aa5 (2026-09-26 12:38:45).
  It computes the pre-registered primary outcomes. It came after the interim
  look and during the third session, before the last chunks finished. The
  notebook says it gives the same numbers as the look.

### Launch commit and the status line

- The `v17` and `full` arms ran from 49288d1 (2026-09-25 08:50:17), the
  launch commit that `sources.txt` in the run folder records (outside git).
  `v16` ran from 98cb371. 49288d1 changed only this notebook since 08aff2e,
  by the 7 lines of the per-arm request check. So the `v17` package is the
  package content of 08aff2e, launched from 49288d1. Above "Results", this
  notebook differs from 08aff2e only by those 7 lines.
- The status line at the top still reads "pre-registered". It was true at
  launch. Now read the notebook as the pre-registration above "Results" and
  the record below it.

### Scope of the evidence

The 157-against-116 read (+25.5 points, 95% CI 18.4 to 32.9) was measured on
the package content of 08aff2e, launched from 49288d1: the old ranker, 8 hits
and a `limit` argument the model could set. The BM25F ranker and the
3-then-5 list (713d6e8) came later. They were measured on another model,
Gemma 4 26B-A4B, in
[`2026-09-29-openrouter-ab.md`](2026-09-29-openrouter-ab.md) (+6.0 points).
No single run compares the shipped tip with 1.6.0 on one model.
