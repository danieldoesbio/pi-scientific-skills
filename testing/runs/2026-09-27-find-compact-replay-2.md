# Run notebook: compact `sci_find` replay, second sample (Bonsai 2 27B)

**Status: pre-registered.** Everything above "Results" was written and
committed before the first request of this sample.

## Why

The first sample
([`2026-09-27-find-compact-replay.md`](2026-09-27-find-compact-replay.md))
was faithful and inconclusive: `compact` read the target in 155 of 158 choice
turns and `full` in 158 of 158 (95% CI −5.4 to 0.8 points, margin −5). Its
decision rule names the next step: a second sample with the same design,
analysed with the first as one sample of two requests per probe per arm, with
that analysis fixed before the second sample runs. This notebook fixes it.

## Design

The same as the first sample in every point (source run, arm `v17`, frozen
package, model, server script and flags, one slot, temperature 1.0, thinking
`medium`, pi's SDK, stubbed tools, one request per arm per probe, the parser
gate), with one change:

- **The arm order is flipped** (`--flip-order`): `compact` first on the 1st,
  3rd, … included probe, and `full` first on the others. Across the two
  samples each probe then has each arm once at each position. Position
  changes only the prefix cache (seconds), not the prompt.

## Rules fixed before this sample

- **Validity, each sample on its own.** Rule 1 (the `full` replay reads the
  target at least as often as the recorded run minus 5) and rule 2 (parity
  failures plus hash mismatches at most 5), as in the first notebook. If
  either sample is not faithful, no pooled comparison is reported.
- **Analysis set.** Probes in the analysis set of both samples.
- **Primary: pooled `compact` − `full`**, target read in the choice turn,
  over all (probe, sample) pairs (about 316). Two 95% intervals:
  1. Newcombe method 10 on the (probe, sample) pairs. It treats the pairs as
     independent, so it ignores that both samples share a probe (a target
     missing from the first list is a property of the probe).
  2. A cluster bootstrap over probes: resample probes with replacement, take
     the pooled mean over their pairs; 10,000 resamples, seed 20260927,
     percentile interval. It keeps the probe as the unit, but it collapses to
     [0, 0] when no pair is discordant.
- **Verdict.** Each interval gets the three-way verdict of the first notebook
  (lower bound above −5 points: non-inferior; upper bound below 0: inferior;
  otherwise inconclusive). The pooled verdict is that verdict only when both
  intervals give it; otherwise it is inconclusive. When the verdict is
  non-inferior and both upper bounds are below 0, the report says that
  `compact` reads less often than `full`, by less than the margin.
- **Secondary.** Sample 2 on its own, with the report of the first sample
  (`scripts/find-live-replay-report.mjs`), and the probes lost or gained in
  each sample.
- **Report:** `node scripts/find-live-replay-pooled.mjs <sample-1> <sample-2>`.
  The code was tested on the first sample before this sample ran (sample 1
  given twice: 6:0 discordant, Newcombe −4.1 to −0.3, bootstrap −4.4 to 0.0).

## How strict the pooled margin is

Newcombe method 10 at n = 316 with no probe missed by both arms:

| Pairs read by `full` only | by `compact` only | Lower bound | Upper bound |
|---|---|---|---|
| 3 | 0 | −2.75 | 0.41 |
| 5 | 0 | −3.65 | −0.08 |
| 6 | 0 | −4.08 | −0.32 |
| 8 | 0 | −4.92 | −0.80 |
| 9 | 0 | −5.32 | −1.05 |
| 8 | 2 | −4.33 | 0.18 |

The bootstrap interval is usually wider when the losses fall on few probes.

## Decision rule

- **Non-inferior:** the next step is a live A/B, as in the first notebook. It
  is planned together with the `sci_find` ranker work, so it runs on the
  ranker that the ranker work keeps.
- **Inferior:** stop. `full` stays the only format, and the flag is removed.
- **Inconclusive:** no third sample. The flag stays experimental and Daniel
  decides.

## Predictions

- Sample 2 is faithful: `full` reads the target in 153 or more.
- `compact` loses 0–4 probes in sample 2. At least one of `esm` and `molfeat`
  loses again (their targets are absent from the first list or at rank 4).
- Pooled verdict: non-inferior, about 70%. Most of the rest: inconclusive
  because the bootstrap interval is wider.
- Prompt tokens and output tokens as in the first sample (median −951 and
  about −10).

## Limits

The limits of the first notebook hold. Two samples at temperature 1.0 are
still few for a rate near 100%. The margin (−5 points) was fixed before the
first sample and does not change here.

## Commands

From a checkout at this commit, with the model server running:

```bash
node scripts/find-live-replay.mjs <main-checkout>/testing/transcripts/find-live/2026-09-25-night-arms --out <main-checkout>/testing/transcripts/find-live/2026-09-27-find-compact-replay-2 --flip-order
```

```bash
node scripts/find-live-replay-pooled.mjs <main-checkout>/testing/transcripts/find-live/2026-09-27-find-compact-replay <main-checkout>/testing/transcripts/find-live/2026-09-27-find-compact-replay-2
```

## Results

Run 2026-09-27, 16:28–19:15 (local), `--flip-order`. Raw output in the main
checkout's gitignored `testing/transcripts/find-live/2026-09-27-find-compact-replay-2/`
(`report.txt`, `pooled.txt`).

**Sample 2 on its own.** Analysis set 158 (3 excluded: no `sci_find` call;
0 errors, 0 parity failures, 0 hash mismatches). Faithful: `full` read the
target in 158, the recorded run in 157.

| | `full` | `compact` | Diff (Newcombe 95% CI) | Discordant |
|---|---|---|---|---|
| Target read in the choice turn | 158/158 | 158/158 | 0.0 (−2.4 to 2.4) | 0:0 |

Paired medians: `sci_find` characters −3,534; prompt tokens −951 (lower on
153); output tokens −2. Seconds at position 1: `full` 42.1, `compact` 31.2.

**Pooled (primary).** 316 (probe, sample) pairs.

| | `compact` | `full` | Diff | Newcombe 95% CI | Bootstrap by probe 95% CI | Verdict |
|---|---|---|---|---|---|---|
| Target read | 313/316 | 316/316 | −0.9 | −2.8 to 0.4 | −2.2 to 0.0 | **non-inferior** |

Discordant 0:3, McNemar exact p 0.25. All three losses are in sample 1
(`esm`, `molfeat`, `pytorch-lightning`); none repeats in sample 2.

**Predictions.**

- Faithful (`full` 153 or more): met, 158.
- `compact` loses 0–4 in sample 2: met, 0. At least one of `esm` and
  `molfeat` loses again: not met. Neither lost.
- Pooled verdict non-inferior (about 70%): met, by both intervals.
- Prompt tokens as in sample 1 (−951): met, −951. Output tokens about −10:
  −2.

**Decision.** Non-inferior. By the decision rule, the next step is a live
A/B together with the ranker work (step 4b of
[`2026-09-27-find-ranker.md`](2026-09-27-find-ranker.md)), so it runs on
the ranker that step keeps. The flag stays experimental until then.
