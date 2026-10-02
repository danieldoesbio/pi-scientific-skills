# Report: can a small local model find 162 skills it cannot see?

This report summarizes the supervised live search test of 2026-09-23. The
full lab record is the run notebook,
[`runs/2026-09-23-bonsai2-27b.md`](runs/2026-09-23-bonsai2-27b.md). What the
results mean for `sci_find`, and what to change, is in
[`analysis.md`](analysis.md).

## Summary

A 27B model that fits in 7.2 GB ran in pi on a laptop, with **no skill listed
in its system prompt**. It had only `sci_find`, pi's file tools and bash. For
each of 161 probes, the model had to find a skill that the probe never named.

- **The model found the target skill on the first attempt for 143 of 157
  valid probes** (143 of 161 raw). It found it within three attempts for 156
  of 157.
- **The whole starting context was about 1.8k tokens:** pi's own system
  prompt, five tool definitions and the task together. Listing all 162
  skills in the system prompt instead costs about 23k tokens (estimate, see
  "Context cost").
- **When the model searched, the search worked.** 156 `sci_find` reaches;
  the target was rank 1 in 125 of them, and never below rank 8.
- **Most misses came from not searching.** On valid probes, 15 of the 19
  missed attempts never called `sci_find`. One skill (`esm`) is a real gap in
  the index.

"Found" means that a `sci_find` result listed the target (or the model read
a file inside the skill). The response stopped at that point, so this test
does not show whether the model then read and followed the skill.

## Setup

| Item | Value |
|---|---|
| Model | Ternary Bonsai 2 27B, PQ2_0 GGUF: 27B dense parameters at about 2 bits per weight. File size 7,206,168,928 bytes (7.2 GB, 6.7 GiB). |
| Server | PrismML llama.cpp fork (b10709-9a9394a), one slot, 65,536-token context, thinking capped at 8192 tokens per model call, reasoning effort medium |
| Hardware | Apple M4 Pro laptop, 48 GB unified memory |
| Agent | pi 0.84.3 with pi-scientific-skills 1.6.0 (162 skills, upstream snapshot v2.69.0) |
| Skills in the prompt | None (`--prompt-skills none`) |
| Probes | [`find-probes.json`](find-probes.json): one per skill, written as a scientist would ask. No probe names its skill. 161 run; `autoskill` is untestable ([`README.md`](README.md)). |

## Method

- **A blind persona plays the user.** Claude Opus 5.5 reads only the task and
  the model's replies. It never sees the skill list and never names a skill.
  It answers questions, says when data is not available, and ends the
  conversation when it is satisfied.
- **Limits.** Up to 3 fresh attempts per probe, up to 5 responses per
  attempt, 1200 s per response. A timeout uses up its attempt.
- **Grades.** The target reached the model in attempt 1: success; attempt 2:
  partial-success; attempt 3: functional; never: fail. A reach through
  `sci_find`, bash output or a file read counts. The response stops at the
  reach.
- **Probe check.** A persona accepts any plausible answer. So a judge (Claude
  Fable 5.1, high effort) reads every attempt that the persona ended
  satisfied before the target appeared. If the model served the request well
  without the skill, the probe did not test search: it is marked
  probe-invalid and sent back for a rewrite. Raw grades stay visible.
- **Sandbox.** Each attempt runs under `sandbox-exec` with its own workspace
  and fake home directory. The network is limited to the model's own server.
- **Offline replay.** Every `sci_find` call in the transcripts was replayed
  through the package's `search()` function. The replay matched the live
  tool for 183 of 183 calls.

## Results

| | Core (n = 10) | non-Core (n = 151) | All (n = 161) |
|---|---|---|---|
| Probe-invalid | 0 | 4 | 4 |
| Graded | 10 | 147 | 157 |
| success | 8 | 135 | 143 |
| partial-success | 1 | 9 | 10 |
| functional | 1 | 2 | 3 |
| fail | 0 | 1 | 1 |
| Raw (probe-invalid kept): success / partial / functional / fail | 8 / 1 / 1 / 0 | 135 / 10 / 2 / 4 | 143 / 11 / 3 / 4 |

- **Harness errors:** 0 (no run failed to start, no persona error, no judge
  error).
- **Probe-invalid:** `consciousness-council`, `get-available-resources`,
  `pi-agent`, `scholar-evaluation`. In each, the model served the request
  well without the skill (for `pi-agent`, from pi's own installed docs).
- **The one fail:** `esm`. The model searched five times, but the index never
  listed `esm`: its description names the SDK and model IDs, not what the
  skill does.
- **Recovery:** 13 valid probes missed in attempt 1 and reached the target in
  a later attempt. Inside one conversation, the model recovered twice (it
  first searched in response 2).
- **Time:** the median reaching attempt took 30 s (90th percentile 54 s).
  The whole run took about 10 hours.

## Context cost

| Item | Tokens | Source |
|---|---|---|
| Whole first prompt: pi's system prompt, 5 tool definitions, the task | 1,828–1,869 (median 1,844) | Measured: pi's usage record, 185 attempts |
| `sci_find` tool definition | about 150–200 | Estimate (code comment and character count) |
| All 162 skills listed in the system prompt | about 23,200 | Estimate: tiktoken over pi's rendered skill blocks (`extensions/profiles.ts`) |
| The 10 Core skills listed | about 1,400 | Estimate, same method |
| Peak context in an attempt | median 2,095; 90th percentile 19,419; maximum 46,673 (56,150 in the server log, which includes turns cut by a timeout) | Measured |

Compare like with like: about 23k tokens of skill index against about 200
tokens of tool definition. The 23k estimate uses OpenAI tokenizers, not
Bonsai's own, so the real count on this model may differ.

## Speed

From the server log archived with the run. Generation speed falls as the
context grows:

| Context at the end of the request | Requests | Generation, median tok/s | Prompt processing, median tok/s |
|---|---|---|---|
| under 4k | 245 | 19.1 | 110 |
| 4k–8k | 54 | 18.7 | 109 |
| 8k–16k | 80 | 17.7 | 107 |
| 16k–32k | 109 | 16.3 | 93 |
| 32k and more | 23 | 13.4 | 77 |

Generation counts requests with 100 or more new tokens. Prompt processing
counts requests with 1000 or more new prompt tokens, so its bins are small
(3 to 33 requests). Most reaching requests ran in the first bin. A 23k skill
index would put every request at 23k or more, the 16k–32k bin or above.

## Limits

- **The probes are easy on search.** The model's queries copy 77% of their
  words from the probe task. Pasting each probe task as a query puts the
  target in the top 8 for 155 of 162. The test measures whether the model
  searches, and whether the index has gaps. It does not measure how well
  search ranks a vague need.
- **The adjusted line reads high by design.** The judge audits only attempts
  that the persona ended satisfied before the target appeared. It does not
  audit first-attempt reaches, and it cannot audit timeouts.
- **One run.** Each probe ran once, at temperature 1.0. The run gives no
  variance estimate.
- **One model, one package version.** Other models, and other versions of pi
  or of this package, can give other results.
- **"Found" is not "used".** The response stopped when the target appeared.

## Data

Raw transcripts stay out of git, in the main checkout under
`testing/transcripts/find-live/2026-09-23-bonsai2-27b-none/`. The notebook
lists the files. The ledger entry is the `extensionRuns` item dated 2026-09-23,
"supervised live search test, all testable probes: sci_find only, no skills in
the prompt", in
[`ledger.json`](ledger.json).
