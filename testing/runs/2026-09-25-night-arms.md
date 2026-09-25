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
