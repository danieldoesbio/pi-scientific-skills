# pi-scientific-skills — project overview

npm package that redistributes K-Dense-AI/scientific-agent-skills as a **pi**
package, plus a `/sci` extension for curating which skills load.

- Repo: `~/Developer/pi-scientific-skills`, remote `github.com/danieldoesbio/pi-scientific-skills` (**PUBLIC**)
- Package version and upstream tag are independent: `package.json` carries both
  `version` (ours) and `upstreamVersion` (the vendored tag).
- As of 1.1.0 / upstream v2.63.0: **157 skills**.

## Layout

| Path | Owner | Notes |
|------|-------|-------|
| `skills/` | upstream | byte-identical snapshot; never hand-edit (see `mem:sync-and-divergence`) |
| `extensions/index.ts` | ours | the `/sci` slash command, its picker TUI, and the `sci_find` tool |
| `extensions/profiles.ts` | ours | `TOTAL_SKILL_COUNT`, `TOKENS_PER_SKILL`, 10 field profiles + `pi-agent` |
| `scripts/sync-upstream.sh` | ours | re-vendors a tag; not shipped in the npm tarball |
| `scripts/validate.mjs` | ours | reimplements pi's frontmatter rules; `npm run validate` |
| `extensions/search.ts` + `aliases.ts` + `frontmatter.ts` + `package-info.ts` | ours | search mode; see `mem:search-mode` |
| `scripts/test-batch.mjs` | ours | 4–8 functional runs per release; see `mem:functional-testing` |
| `scripts/track-downloads.mjs` | ours | appends npm daily counts to `metrics/downloads.json` |
| `testing/ledger.json` | ours | conclusive functional-run record; README's N of 157 derives from it |

## Why `/sci` exists

pi's progressive disclosure keeps every skill's *name + description* in the
system prompt for the whole session and defers only the bodies. Measured at 157
skills that index is ~18k tokens (~113 tokens/skill) — over half a 32k context.
`/sci` writes a normal per-package filter into `~/.pi/agent/settings.json`; it
never modifies a `SKILL.md`, so a sync cannot clobber a user's selection.

Since 1.1.0 that is only half the story: `sci_find` lets the model search all 157
on demand, so the recommended default is Core (~1.1k tokens) with everything
still reachable. See `mem:search-mode` — including the startup-messaging promise
and the pi internals verified for it.

## Gotchas

- `npm run validate` **hard-fails** if `TOTAL_SKILL_COUNT` drifts from the
  directory count, if any skill is in no profile and no UNASSIGNED entry, if an
  `aliases.ts` entry names a missing skill, or if `package-info.ts` disagrees
  with `package.json`. Every sync therefore requires a `profiles.ts` edit.
- `npm test` needs an **installed pi**: every suite loads the extension through
  pi's own jiti. `npm run validate` alone does not.
- Four Anthropic skills (`docx`, `pdf`, `pptx`, `xlsx`) are deliberately
  excluded — their licence forbids redistribution. `EXCLUDED_SKILLS` in
  `sync-upstream.sh` matches exact names so `pptx` does not catch K-Dense's own
  `pptx-posters`.
- `license:` frontmatter on a skill records the *wrapped library's* licence, not
  the skill text's (e.g. `cobrapy: GPL-2.0`). The real redistribution test is a
  `LICENSE*` file **inside** the skill directory — currently only
  `skills/pacsomatic/LICENSE` (MIT).
