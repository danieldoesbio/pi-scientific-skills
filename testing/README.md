# Testing notes

This file records which skills the live search test cannot cover, and why.
The harness itself (`scripts/test-find-live.mjs`, the supervised probes in
`find-probes.json`) is described in `DOCUMENTATION.md`.

## Untestable skills

The supervised live test cannot test a skill when both of these are true:

1. **The skill works only on local state that the sandbox cannot supply.**
   Examples: a running daemon or desktop app, or the user's own captured data.
2. **The request cannot be stated without that state.** The persona says that
   the data is not available in this environment and asks for a method or an
   example (`scripts/lib/supervisor.mjs`). The conversation then moves to a
   different task, and the model can answer that task without the skill.
   Every fail then measures the move to the new task, not search.

A skill is **not** untestable only because it needs credentials, a cloud
account, a paid service, network access or lab hardware. The persona declines
actions with real-world side effects and asks for code or a plan. The skill
still carries the API knowledge the answer needs. Examples:
`latchbio-integration`, `ncats-arax` and `pyzotero`.

### How to declare a skill untestable

- In `find-probes.json`, set `"untestable": "<reason>"` on the skill's probe,
  and add a row to the table below.
- The live test loads the probe but never runs it. It names the probe at the
  start of every run and refuses it in `--only`.
- A report states the covered count, for example 161 of 162.

### Where candidates come from

Candidates come from the list of `probe-invalid` probes that the probe check
writes (`scripts/lib/probe-check.mjs`).

- **The judge says the skill cannot run in the sandbox:** the probe is a
  candidate for this list.
- **The judge says the model answered well without the skill:** the probe
  needs a rewrite, not this list.

| Skill | Needs | Evidence | Declared |
|---|---|---|---|
| `autoskill` | A running screenpipe daemon (`SCREENPIPE_TOKEN`) and the user's own screen history | See below the table. | 2026-09-23 |

**Evidence for `autoskill`:**

- **Pilots.** In two pilots on 2026-09-23 (Ternary Bonsai 2 27B, no skills in
  the prompt), the persona gave a spoken description of the routine in place
  of the missing recordings. The model then searched for tools for that
  routine, or did not search at all. No attempt reached `autoskill`.
- **Probe-check judge.** Its verdict was `probe-invalid`, because the skill
  "reads exclusively from a running screenpipe daemon". Without the daemon,
  the skill cannot run.
- **Rewrite.** A rewrite cannot fix the probe unless it names screenpipe
  (`namesPlatform`). Naming it makes the probe a test of string matching, not
  of search.
