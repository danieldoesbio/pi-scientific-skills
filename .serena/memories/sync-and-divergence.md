# Syncing upstream, and where divergence is allowed

## The sync is wholesale replacement

`scripts/sync-upstream.sh <tag>` does `rm -rf skills/` then copies the tag's
`skills/` in, minus `EXCLUDED_SKILLS`. **Any edit made inside `skills/` is
silently reverted on the next sync.**

Consequence, decided at v2.63.0: divergence from upstream must stay
*declarative* and live in the **packaging layer** — a name list in the script, a
constant in `extensions/`, a paragraph in the docs. Never in vendored file
content. See `mem:project-overview` for the layout.

## Sync procedure

```bash
bash scripts/sync-upstream.sh v<tag>   # replaces skills/
npm run validate                        # WILL fail until profiles.ts is updated
```

Then, in order:

1. `extensions/profiles.ts` — bump `TOTAL_SKILL_COUNT`, re-measure
   `TOKENS_PER_SKILL`, assign every new skill to profiles **by actual
   dependency**, not alphabetically. A skill can belong to several.
2. `package.json` — bump `version`, set `upstreamVersion`, update the count in
   `description`.
3. `README.md` + `DOCUMENTATION.md` — sweep counts. **Include derived
   arithmetic**: "4 of N", "the other N-4", the `/sci` sample line's token
   figures, the % of a 32k context.
4. Sweep `*.ts` too. The count also appears in comments in
   `extensions/index.ts`; an earlier sweep missed it because the grep only
   covered `*.md,*.json,*.mjs,*.sh`.
5. `DOCUMENTATION.md` has a **Publishing checklist** near the end — work it.

## Verifying the vendored tree

```bash
git clone --depth 1 --branch <tag> https://github.com/K-Dense-AI/scientific-agent-skills.git up
diff -rq up/skills skills   # expect ONLY "Only in up/skills: docx|pdf|pptx|xlsx"
```

Run this *before* a sync too, to prove the working tree still matches its pinned
tag and the delta really is tag-to-tag.

## Not carried: upstream's `plugin.json`

Upstream added an Agent Plugins 1.0.0 manifest at v2.63.0. This repo does not
ship it. Reasons are recorded in DOCUMENTATION.md; the short version is
misattribution if copied verbatim, overclaiming conformance if rewritten, and
this package versions independently. **Size was explicitly not a reason** (~700
bytes against a 7 MB tarball). No script change was needed — the sync copies
`skills/` only, never repo-root files.

## Smoke-testing in pi is harder than it looks

`pi -e .` does **not** inject the package's skills, and `pi -p` (print mode) does
not expose the system prompt, so a CLI-only check reports 0 skills and proves
nothing. Also, this machine's `~/.pi/agent/settings.json` holds a live `/sci`
filter for the local path that restricts it to ~46 skills — so an in-repo test
reads as ABSENT for anything outside that list. A real check needs an
**interactive** `pi` session or the `pi config` TUI.
