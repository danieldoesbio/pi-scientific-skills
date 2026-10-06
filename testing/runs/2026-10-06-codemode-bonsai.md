# Run notebook: sci_find called directly against through pi's codemode (Bonsai 2 27B)

**Status: pre-registered.** Everything above "Results" was written before the
first graded probe of the run. The smoke check runs before the run and is not
part of it.

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

Not run yet.
