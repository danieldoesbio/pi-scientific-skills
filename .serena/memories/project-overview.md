# pi-scientific-skills — project overview

npm package that redistributes K-Dense-AI/scientific-agent-skills as a **pi**
package, plus a `/sci` extension for curating which skills load.

- Repo: `~/Developer/pi-scientific-skills`, remote `github.com/danieldoesbio/pi-scientific-skills` (**PUBLIC**)
- Package version and upstream tag are independent: `package.json` carries both
  `version` (ours) and `upstreamVersion` (the vendored tag).
- As of 1.0.2 / upstream v2.63.0: **157 skills**.

## Layout

| Path | Owner | Notes |
|------|-------|-------|
| `skills/` | upstream | byte-identical snapshot; never hand-edit (see `mem:sync-and-divergence`) |
| `extensions/index.ts` | ours | the `/sci` slash command and its picker TUI |
| `extensions/profiles.ts` | ours | `TOTAL_SKILL_COUNT`, `TOKENS_PER_SKILL`, 10 field profiles + `pi-agent` |
| `scripts/sync-upstream.sh` | ours | re-vendors a tag; not shipped in the npm tarball |
| `scripts/validate.mjs` | ours | reimplements pi's frontmatter rules; `npm run validate` |

## Why `/sci` exists

pi's progressive disclosure keeps every skill's *name + description* in the
system prompt for the whole session and defers only the bodies. Measured at 157
skills that index is ~18k tokens (~113 tokens/skill) — over half a 32k context.
`/sci` writes a normal per-package filter into `~/.pi/agent/settings.json`; it
never modifies a `SKILL.md`, so a sync cannot clobber a user's selection.

## Gotchas

- `npm run validate` **hard-fails** if `TOTAL_SKILL_COUNT` drifts from the
  directory count, or if any skill is in no profile and no UNASSIGNED entry.
  Every sync therefore requires a `profiles.ts` edit.
- Four Anthropic skills (`docx`, `pdf`, `pptx`, `xlsx`) are deliberately
  excluded — their licence forbids redistribution. `EXCLUDED_SKILLS` in
  `sync-upstream.sh` matches exact names so `pptx` does not catch K-Dense's own
  `pptx-posters`.
- `license:` frontmatter on a skill records the *wrapped library's* licence, not
  the skill text's (e.g. `cobrapy: GPL-2.0`). The real redistribution test is a
  `LICENSE*` file **inside** the skill directory — currently only
  `skills/pacsomatic/LICENSE` (MIT).
