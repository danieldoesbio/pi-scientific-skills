# Run notebook: `sci_find` prompt snippet, A/B pilot (Bonsai 2 27B)

**Status: planned. Predictions and the decision rule are written before any
model call.**

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

(Not run yet.)
