# Run notebook: sci_find called directly against through pi's codemode (Bonsai 2 27B)

**Status: run (2026-10-08 to 2026-10-09).** Everything above "Results" was
written before the first graded probe of the run. The smoke check ran before
the run and is not part of it.

## Questions

1. **Codemode on.** pi 0.99 added an opt-in `codemode` tool: the model writes
   a script that calls the other tools as `tools.<name>(args)`. With it on
   (`defaultTools: ["+codemode"]`), `sci_find`, `read` and `bash` are still
   declared too. Does a small local model still find and read the right
   skill as often as without it?
2. **Codemode only.** With `codemode.mode: "only"`, codemode is the only
   declared tool, so the model reaches `sci_find` and `read` through scripts.
   1.8.1 gives `sci_find` an `outputSchema`, so a script gets its result as
   an object with SKILL.md paths. Does the model use that to read the skill?

## Arms

| Arm | Package | pi settings | Declared tools |
|---|---|---|---|
| `direct` | 1.8.1, the run's commit (in `sources.txt`), `--prompt-skills none` | none | `read`, `bash`, `edit`, `write`, `sci_find` (pi defaults plus the extension) |
| `cm-on` | the same | `defaultTools: ["+codemode"]`, `codemode.mode: "on"` | the `direct` tools plus `codemode` |
| `cm-only` | the same | `defaultTools: ["+codemode"]`, `codemode.mode: "only"` | `codemode` only |

`direct` has the same flags as `v17` in
[`2026-09-25-night-arms.md`](2026-09-25-night-arms.md), on 1.8.1 and pi 1.0.
It is the control: the two codemode arms differ from it only in the pi
settings `seedAgentDir` writes (`scripts/lib/agent-seed.mjs`).

## Conditions

Same as 2026-09-25 (model `prism-llama/Ternary-Bonsai-2-27B-PQ2_0`, the
maintainer's server script and flags, persona `claude-opus-5-5`, judge
`claude-fable-5-1`, sandbox, probe file, one attempt per probe per arm, up to
5 responses, 1200 s per response, read endpoint, timeout gate at 10 calls,
warm-up, frozen sources, chunks of 10 with Core first, seed 20260925, arm
order rotated per chunk). Differences:

- **pi 1.0.0 or later** on PATH in every arm (codemode needs 0.99; the
  harness refuses `--codemode` on an older pi and records `piVersion` on each
  line). 2026-09-25 ran pi 0.84.3, so `direct` is not pooled with its `v17`.
- **Nested calls count.** pi does not write the calls a script makes as tool
  calls. It records them, with their arguments and status but not their
  results, as `nestedCalls` on the codemode result. `responses()` in
  `scripts/lib/pi-session.mjs` adds each as a call of its own after the
  script, marked `via: "codemode"`. So a script's `read` of
  `skills/<target>/SKILL.md` with status `ok` reaches the endpoint, and a
  script's `sci_find`, `read` of a SKILL.md or bash naming one counts as
  skill-seeking for the gate. A codemode call itself is one call for the gate.

Command:

```bash
scripts/find-live-arms.sh --out testing/transcripts/find-live/2026-10-06-codemode \
  --server <start-bonsai2-server.sh> --arms direct,cm-on,cm-only [--stop-after <HH:MM>]
```

Per arm and chunk it runs the 2026-09-25 harness command with the arm flags:
`direct` `--package-dir src/v17 --prompt-skills none`; `cm-on` the same plus
`--codemode on`; `cm-only` the same plus `--codemode only`.

## Rules fixed before the run

Overflow and compaction, analysis set (complete chunks only), harness errors
and probe-invalid: as on 2026-09-25. The primary analysis uses raw grades.

## Outcomes

**Primary 1: `cm-on` against `direct`, non-inferiority.** Paired by probe,
attempt-1 read rate. `cm-on` is non-inferior if the lower bound of the 95% CI
for `cm-on − direct` (Newcombe method 10) is above −5 points.

**Primary 2: `cm-only` against `direct`, non-inferiority**, the same way.

Both are run by `scripts/find-live-arms-report.mjs <out> --design codemode`,
which also gives McNemar's exact test, Core and non-Core apart, and the
discordant probes. A CI too wide to rule out a 5-point loss is the result,
stated as such.

**Secondary**, per arm: first-prompt tokens; time to read on probes read in
both arms; peak context, output tokens, tool calls; how attempts ended;
compactions. For the codemode arms also: attempts with any codemode call,
scripts per attempt, and whether the read came through a script (`via`) or a
declared `read` (in `cm-on`).

## Predictions

- **First prompt:** `cm-on` larger than `direct` by the codemode tool
  definition; `cm-only` smaller than `direct`. No numbers predicted.
- **`cm-on`:** within noise of `direct`; most attempts never call codemode.
- **`cm-only`:** no prediction.

## Limits (stated before the run)

- **One attempt per probe per arm, at temperature 1.0**, as on 2026-09-25.
- **Nested results are not kept.** A script's bash `cat` of a SKILL.md cannot
  meet the bash route of the read endpoint, which needs the file's `name:`
  line in the output. In `cm-only` the endpoint is a script's `read` only.
  This can only lower the codemode arms' read rates. The report counts
  scripts that ran bash naming the target's SKILL.md, so the size of this is
  visible.
- **`listed` is not measured through a script**, since `sci_find`'s result
  text is not kept. `listedSeconds` is from declared calls only.
- **The endpoint is checked when the script ends.** A script that reads the
  target and then does more is stopped at its end, not at the read.
- **One server, one laptop**, speed comparable within this run only.

## Smoke check (before the run, not part of it)

Three probes per arm through the driver, with the run's flags:

```bash
scripts/find-live-arms.sh --out testing/transcripts/find-live/2026-10-06-codemode-smoke \
  --server <start-bonsai2-server.sh> --arms direct,cm-on,cm-only --only polars,scanpy,dask
```

## Results

Run on 2026-10-08 and 2026-10-09 on the maintainer's laptop: pi 1.0.0,
package 1.8.1 at `b4af20f` (frozen in `sources.txt`), 17 chunks, all three arms
complete in every chunk, 161 probes (Core 10, non-Core 151), no harness errors,
no compactions or overflows, no restarts. The three-probe smoke check
(polars, scanpy, dask) ran first: all three arms read the target on attempt 1,
and `cm-only` read through scripts. The raw transcripts and `report.md` are in
`testing/transcripts/find-live/2026-10-06-codemode/` (gitignored, local only);
the numbers below are copied from `report.md`
(`scripts/find-live-arms-report.mjs <out> --design codemode`).

### Primary outcomes

Attempt-1 read rate, paired by probe, Newcombe method 10, non-inferiority
margin -5 points.

| Comparison | Set | n | Read | Difference | 95% CI | Discordant | McNemar p | Non-inferior? |
|---|---|---|---|---|---|---|---|---|
| `cm-on` − `direct` | all | 161 | 153 vs 156 | -1.9 | -5.9 to 1.7 | 2:5 | 0.45 | **no** (CI just misses -5) |
| | Core | 10 | 9 vs 9 | 0.0 | -22.2 to 22.2 | 0:0 | 1.0 | |
| | non-Core | 151 | 144 vs 147 | -2.0 | -6.3 to 1.8 | 2:5 | 0.45 | |
| | without probe-invalid | 155 | 152 vs 153 | -0.6 | -4.0 to 2.4 | 1:2 | 1.0 | yes |
| `cm-only` − `direct` | all | 161 | 142 vs 156 | -8.7 | -14.2 to -4.2 | 1:15 | 0.0005 | **no** (a loss) |
| | Core | 10 | 8 vs 9 | -10.0 | -36.2 to 13.4 | 0:1 | 1.0 | |
| | non-Core | 151 | 134 vs 147 | -8.6 | -14.3 to -3.9 | 1:14 | 0.001 | |
| | without probe-invalid | 155 | 141 vs 153 | -7.7 | -13.0 to -3.9 | 0:12 | 0.0005 | no |

The pre-registered primary analysis is the "all" row. On it:

- **`cm-on` is not shown non-inferior.** The point estimate is -1.9 points but
  the CI's lower end, -5.9, is past the -5 margin. The seven discordant probes
  (2 for `cm-on`, 5 for `direct`) are mostly attempts that ended on a persona
  end with no skill-seeking call at all, in either direction, so this reads as
  noise at n = 161, but the data do not rule out a loss of 5 or 6 points. The
  "without probe-invalid" row passes (-0.6, CI -4.0 to 2.4); it is secondary,
  and it uses a different set for each arm's invalid probes.
- **`cm-only` is worse than `direct`**, by 8.7 points, and the whole CI is
  below zero. 15 probes were read only in `direct`; 1 only in `cm-only`.

### Secondary, per arm

| | `direct` | `cm-on` | `cm-only` |
|---|---|---|---|
| Read | 156/161 | 153/161 | 142/161 |
| Ended | reached 156, persona-end 3, timeout 2 | reached 153, gated 3, persona-end 3, timeout 2 | reached 142, gated 11, timeout 4, persona-end 4 |
| First prompt, median (tokens) | 1980 | 2457 | 2374 |
| Peak context, median / max | 3038 / 33813 | 3517 / 38092 | 3770 / 37267 |
| Tool calls, median | 2 | 2 | 5 |
| Output tokens, median | 311 | 351 | 499 |
| Attempt time, total | 188 min | 242 min | 346 min |
| Compactions, overflow errors | 0, 0 | 0, 0 | 0, 0 |
| Probe-invalid | pi-agent, get-available-resources, markdown-mermaid-writing | consciousness-council, scholar-evaluation | consciousness-council, what-if-oracle, scholar-evaluation |

Time to read, on probes read in both arms (`endpointSeconds`): `cm-on` median
45 s against 43 s for `direct` (paired difference 2 s, n = 149); `cm-only`
median 54 s against 42.5 s (paired difference 10.5 s, n = 140; `cm-only` was
faster on 30).

Codemode use: in `cm-on`, **no attempt called codemode**; every read there was
a declared `read`. In `cm-only`, 160 of 161 attempts ran a script (483 scripts
in all, 595 calls from scripts), and all 142 reads came through a script. One
attempt ran a script whose bash named the target's SKILL.md.

### Predictions against outcomes

- **First prompt: `cm-on` larger than `direct` by the codemode tool
  definition; `cm-only` smaller than `direct`.** Half right. `cm-on` was larger
  (2457 against 1980). `cm-only` was **larger** too (2374), not smaller. The
  prediction was wrong. The likely reason is that the codemode tool's
  definition is bigger than the declared tools it replaces; this was not
  checked.
- **`cm-on`: within noise of `direct`; most attempts never call codemode.**
  Right on both, with the CI caveat above. Not one attempt called codemode.
- **`cm-only`: no prediction.** It lost 8.7 points, mostly attempts gated at 10
  calls with no skill-seeking call (11 gated against 0 in `direct`), and cost
  more calls, tokens and time. Of the 16 probes where one arm read and the
  other did not, 15 favour `direct`.

### Limits that applied

The limits listed before the run held. The nested-call bias against the
codemode arms was small here: a script's bash named the target's SKILL.md in
one attempt out of 161, so it cannot account for `cm-only`'s 14-probe gap. The
`listed` measure was not available through scripts, as stated. One attempt per
probe per arm at temperature 1.0: a different draw could move a rate by a few
points, which is why a CI that just misses the margin is reported as not shown
rather than as a loss. `cm-on`'s per-arm rates are 95% to 97%, so the paired
CI is mostly set by the discordant probes (7 of 161). Everything is one
model, one server, one laptop; times compare within this run only.

### What this does not say

It does not show that codemode hurts a larger model, or that `cm-on` is worse
than `direct`; it shows that a 27B ternary model on this prompt did not use
the opt-in tool at all, and that taking away the declared tools cost it 15
reads. It does not test `cm-only` with a prompt written for scripts.
