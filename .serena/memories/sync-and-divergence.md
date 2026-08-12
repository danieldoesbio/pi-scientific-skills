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

## Smoke-testing in pi, non-interactively

**pi exposes skills as a tool, not as system-prompt text.** So `--no-tools`
hides every skill and the run reports zero — which looks exactly like a load
failure and is not one. This cost an hour once; do not repeat it.

The invocation that works, run from the **extracted tarball** in a scratch dir:

```bash
npm pack --pack-destination "$SCRATCH"
tar xzf "$SCRATCH"/pi-scientific-skills-*.tgz -C "$SCRATCH"   # -> $SCRATCH/package
cd "$SCRATCH/package"
pi -ne --skill ./skills --no-session -p "<probe>"
```

Two more traps, both still true:

- `pi -e .` does **not** load the package's `pi.skills`; `-e` loads an
  *extension*. Use `--skill <dir>`.
- `~/.pi/agent/settings.json` on this machine holds a live `/sci` filter for
  `../../Developer/pi-scientific-skills` pinning it to ~46 skills. Testing from
  the repo path silently applies it, so anything outside that list reads ABSENT.
  The tarball-in-scratch path dodges this, and also keeps `__pycache__` out of
  the vendored tree.

Verify **by name presence**, not by total count: the reported total includes the
user's own personal skills (173 at 1.0.2 = our 157 + ~16 personal).

The batch harness built on this is `mem:functional-testing`.
