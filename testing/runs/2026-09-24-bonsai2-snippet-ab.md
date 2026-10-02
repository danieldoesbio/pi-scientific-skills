# Run notebook: `sci_find` prompt snippet, A/B pilot (Bonsai 2 27B)

**Status: stopped early (2026-09-24 10:13 to 11:14), 15 of 20 probes on both
arms plus `paper-lookup` on the treatment arm. Predictions and the decision rule
were written before any model call. Stopped by decision: the control arm was at
the ceiling, and a larger run was planned instead (see "Next").**

## Question

Does the 1.7.0 prompt change make a small local model call `sci_find` on
tasks where, in the 2026-09-23 run, it did not search?

## Arms

| Arm | Code | What the model sees |
|---|---|---|
| Control | commit `98cb371` (1.6.0), in a separate worktree | `sci_find` only in the tool schema. Not under "Available tools". No guideline. |
| Treatment | commit `2a1637f` (1.7.0) | `sci_find` under "Available tools" (`promptSnippet`), one guideline, one more scope sentence in the tool description. |

Both arms run `--prompt-skills none`: no skill in the system prompt.

**The treatment is a bundle:** snippet, guideline and description sentence
together. A difference between the arms does not show which part caused it.

## Probes (20)

- **The 12 no-search probes:** the valid probes that had an attempt without
  a `sci_find` call on 2026-09-23. `dask`, `exploratory-data-analysis`,
  `fluidsim`, `genomic-intelligence`, `matlab`, `modal`, `open-notebook`,
  `parallel-web`, `polars`, `pysam`, `pytorch-lightning`, `qutip`.
- **The other 8 Core probes:** `citation-management`, `experimental-design`,
  `matplotlib`, `paper-lookup`, `scientific-critical-thinking`,
  `scientific-visualization`, `scientific-writing`, `statistical-analysis`.
  With 1.7.0, Core is no longer in the prompt by default, so the Core probes
  must not get worse.

## Conditions

Same as 2026-09-23 (see that notebook), except:

- `--attempts 1`: one attempt per probe per arm.
- One probe per invocation (`--only <probe>`). The arm order alternates per
  probe: control first on probes 1, 3, 5, …, treatment first on 2, 4, 6, ….
  This keeps a slow drift of the laptop (heat) from mixing with the arm.
- Each arm runs its own harness from its own tree, so each packs and tests its
  own code.

Command, per probe and arm:

```bash
node scripts/test-find-live.mjs --probes testing/find-probes.json \
  --model prism-llama/Ternary-Bonsai-2-27B-PQ2_0 --thinking medium \
  --prompt-skills none --attempts 1 --timeout 1200 \
  --only <probe> --results <scratch>/<arm>.jsonl --keep
```

## Smoke check (before the pilot)

One probe per arm. Pass conditions:

- Treatment: the extension registers `sci_find` with the snippet and the
  guideline; control: without them.
- The first-prompt size (pi usage, input + cache read) differs by about the
  size of the added text. Control should match the 2026-09-23 median, 1,844
  tokens.
- Neither arm has a skills block.

If the control arm loads the treatment code, or the reverse, stop: the pilot
would measure nothing.

**Smoke check result (2026-09-24, before the pilot): pass.**

- Each arm's own loader and pi's own `buildSystemPrompt` (pi 0.84.3), with no
  skills: the control has no snippet and no guideline, and "- sci_find:" is
  not in its prompt. The treatment prompt has both. It is 272 characters
  longer, and the tool description is 109 characters longer. Neither prompt
  has an `<available_skills>` block.
- Live, probe `scanpy` (not a pilot probe), one attempt per arm. First
  request (pi usage, input + cache read): control 1,862 tokens, treatment
  1,951 tokens, **+89**. Inside the predicted 60 to 110. Both reached `scanpy`
  through `sci_find` in response 1.
- pi's session record does not hold the system prompt, so the live check
  rests on the token difference, not on the request text.

## Outcomes

- **Primary:** of the 12 no-search probes, how many call `sci_find` in
  response 1 (`firstFindResponse === 1`).
- **Secondary:** reach in the one attempt (all 20; the 12 and the 8 Core
  apart), timeouts, time to reach, first-prompt tokens.

## Predictions

- First-prompt tokens: control about 1,844; treatment 60 to 110 tokens more.
- Primary: control 4 to 8 of 12 (these probes were chosen because they failed
  once, so at temperature 1.0 some will search this time by chance).
  Treatment 8 to 12 of 12.
- Core probes: both arms reach 7 or more of 8.
- Timeouts: fewer in the treatment arm, because on 2026-09-23 every timeout
  followed a missing skill.

## Decision rule (fixed before the run)

Keep the 1.7.0 prompt change if both hold:

1. On the 12 no-search probes, the treatment calls `sci_find` in response 1
   on at least 3 more probes than the control.
2. No Core probe that the control reaches is missed by the treatment.

If rule 1 fails but rule 2 holds, keep the change (it costs about 100 tokens
and loses nothing), but record that the pilot did not show an effect.
If rule 2 fails, look at the transcript before any decision.

## Limits (stated before the run)

- **n = 12 detects only a large effect.** One attempt per probe per arm, at
  temperature 1.0. A null result is not evidence against the change.
- **Regression to the mean.** The 12 probes were selected for a miss. The
  control arm will do better on them than on 2026-09-23 by chance alone. That
  is why the comparison is against a fresh control arm, not against the old
  run.
- **Bundle.** See "Arms".
- **Guideline side effects are not measured.** Every probe has a target. The
  guideline can make the model call `sci_find` in sessions that need no
  skill; this pilot cannot see that.

## Results

Stopped after probe 15 (`matplotlib`). Not run: `scientific-critical-thinking`,
`scientific-visualization`, `scientific-writing`, `statistical-analysis`, and
`paper-lookup` on the control arm. One attempt per probe per arm.

| | Control (1.6.0) | Treatment (1.7.0) |
|---|---|---|
| No-search 12: `sci_find` in response 1 | 11/12 | 11/12 |
| No-search 12: reached | 11/12 | 11/12 |
| Core probes run: reached | 3/3 | 4/4 |
| Timeouts (1200 s) | 1 of 15 | 1 of 16 |
| First request, tokens (range) | 1,835–1,857 | 1,925–1,948 |

- **The misses differ.** Control: `pytorch-lightning`, bash only, no
  `sci_find`, timeout. Treatment: `parallel-web`, timeout. In the treatment
  miss the model listed its tools in its thinking, with `sci_find` as
  "searching scientific skills", then treated a web-search task as outside
  that scope and wrote its own page-watch script for 1200 s. The snippet made
  the tool visible; its word "scientific" may have made it look off-topic.
  One case at temperature 1.0: this can be chance.
- **Rule 1 fails** (treatment − control = 0, not ≥ 3). **Rule 2 holds** on the
  Core probes that ran (no Core probe that the control reached was missed).
  By the pre-set rule, keep the change and record that the pilot showed no
  effect on search rate.
- **Why no effect could show:** the control arm searched in response 1 on 11
  of 12 probes that each had a no-search attempt on 2026-09-23. This is the
  regression to the mean stated under "Limits": the selection was a miss at
  temperature 1.0, not a stable property of the probe.
- **Cost:** the 1.7.0 prompt text adds about 90 tokens to the first request.
- Raw results, logs and transcripts: in the main checkout, gitignored, under
  `testing/transcripts/find-live/2026-09-24-bonsai2-snippet-ab/`
  (`pilot-*.jsonl`, `smoke-*.jsonl`, `pilot.log`, `llama-server.log`,
  `logs.tgz`, and `transcripts.tgz` with the 34 kept attempt directories,
  staged package excluded).

## Next

- Widen the wording from "scientific" to scientific, research and analysis
  work, without naming web search (that would fit `parallel-web` directly).
- A larger overnight run: 1.6.0 default (Core listed) against 1.7.0 default
  (nothing listed), and 1.7.0 against all 162 skills listed without
  `sci_find`. Endpoint: the model reads the target's `SKILL.md`. Speed and
  context are measured, not only the reach rate.
