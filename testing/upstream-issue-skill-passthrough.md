# Upstream issue — fact sheet, not yet filed

Target: https://github.com/earendil-works/pi/issues → "Bug report" template.
pi's CONTRIBUTING.md auto-closes issues from new contributors and rejects
LLM-written text, so this is a fact sheet: file it in your own words, short.
Once a maintainer answers `lgtm`, push `upstream-fix-skill-unknown-name.patch`
to a fork and open the PR; before `lgtm`, a PR is auto-closed.

Prior art to mention: #8413 asked for whitespace splitting only and was closed
`no-action`. No open or closed issue reports the silent miss itself.

---

**What happened?**

`/skill:<name>` with a name that is not loaded is sent to the model as the
literal user message `"/skill:<name>"`. Nothing is shown in the TUI. The model
usually answers as if the skill had loaded.

Two ways to hit it: a typo, or a skill removed by a per-package `skills`
filter in `settings.json` (the filter removes the skill from the registry, so
the name misses).

Where: `_expandSkillCommand` in `packages/coding-agent/src/core/agent-session.ts`
returns `text` unchanged on a miss. The same method already emits a
`skill_expansion` error when the file read fails, so the miss is the only
silent branch. `prompt()`, `steer()` and `followUp()` all go through it, so an
extension cannot fully patch around it (the `input` event covers `prompt()` only).

**Steps to reproduce**

1. `pi`
2. type `/skill:does-not-exist explain this`
3. no error is shown; the model receives `/skill:does-not-exist explain this`

**Expected**

An error line, the way a failed skill read already shows one:
`Extension "skill:does-not-exist" error: Unknown skill: does-not-exist`.

**Version**

0.85.1 (source at 6160683). Also in 0.84.3.

**Fix**

Emit the error on the miss with the existing `emitError` channel and keep
forwarding the text, matching the read-failure branch. Regression test in
`agent-session-prompt.test.ts`. `npm run check` and the test file pass.
Patch: `testing/upstream-fix-skill-unknown-name.patch` in this repo.
