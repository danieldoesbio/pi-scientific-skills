# DOCUMENTATION — pi-scientific-skills port

Maintainer-facing documentation for the pi distribution of
[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills).

## What this package is

A pi package that bundles the upstream **scientific-agent-skills** collection as
pi-native resources. Pi implements the open [Agent Skills
specification](https://agentskills.io/specification), so the skills are loaded
as-is — no translation layer, no code conversion. The "port" consists of:

1. Packaging (`package.json` with a `pi` manifest and the `pi-package` keyword so
   the package appears in the [pi package gallery](https://pi.dev/packages)).
2. A pinned snapshot of upstream skills (`skills/`), kept byte-identical.
3. Tooling to re-sync from upstream and to validate against pi's rules.

## Provenance

- **Upstream:** https://github.com/K-Dense-AI/scientific-agent-skills
- **Upstream version:** 2.62.0 (from `pyproject.toml`)
- **Source snapshot:** `scientific-agent-skills-main.zip` downloaded to
  `~/Downloads`, extracted, `skills/` copied byte-identical into this repo.
- **License:** MIT, © 2025 K-Dense Inc. (`LICENSE.md` is the upstream text verbatim).
- **Relationship:** this repo is an independent distribution of the open-source
  skill collection. It is not affiliated with K-Dense Inc.

### Why not the "Claude Scientific Skills" repo

An older snapshot of the same project (`claude-scientific-skills`) also exists.
Upstream states **"Claude Scientific Skills is now Scientific Agent Skills"** —
the claude repo is deprecated. We port only the current repo so the package can
stay in sync with upstream. The deprecated repo contains ~60 unique skills
(mostly a `*-database` series) that were not carried into the current repo; we do
not merge them because doing so would fork the collection and break future
synchronization. If a specific legacy skill is needed, port it individually as a
custom skill.

## Structure

```
package.json            # pi manifest: "pi": { "skills": ["./skills"] }, keyword "pi-package"
skills/                 # 158 skill directories, each with SKILL.md (+ references/scripts/assets)
scripts/sync-upstream.sh  # re-sync skills/ from upstream
scripts/validate.mjs    # pi-rule validation across all skills
LICENSE.md              # upstream MIT verbatim
README.md               # pi-user-facing
DOCUMENTATION.md        # this file
```

## Port process (how a new upstream version lands)

1. `npm run sync:upstream` — fetches the latest upstream archive and replaces
   `skills/` wholesale. The script pins to the latest release tag when one
   exists, else falls back to `main`.
2. `npm run validate` — checks every `SKILL.md` against pi's validation rules
   (below). Warnings are acceptable (pi is lenient); **missing descriptions are
   not** (pi refuses to load those skills).
3. Spot-check with pi: `pi -e .` then `-p` prompt asking the model to list
   available skills; verify a few names (e.g. `scanpy`,
   `pathogen-variant-surveillance`).
4. Bump `version` in `package.json` to mirror the upstream version.
5. Commit, tag `v<version>`, push, `npm publish`.

## Validation rules (pi)

Per `docs/skills.md` in the pi docs, pi validates skills against the Agent
Skills standard, warning on most violations but still loading them:

| Rule | Enforced? |
|------|-----------|
| `name` present, ≤64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens | warning |
| `description` present | **hard — skill not loaded if missing** |
| `description` ≤1024 chars | warning |
| unknown frontmatter fields | ignored |

Pi does not require the name to match its parent directory.

## Sync script details

`scripts/sync-upstream.sh`:

- Downloads the upstream tarball (latest release, else `main`) to a temp dir.
- Replaces `skills/` in this repo with the upstream `skills/`.
- Prints a diff summary (added/removed/changed skill names) for the changelog.
- Does **not** commit — review the diff and commit deliberately.

## Validation script details

`scripts/validate.mjs` (no dependencies, Node ≥18):

- Walks `skills/**/SKILL.md`.
- Parses YAML frontmatter with a conservative line-based parser (frontmatter is
  simple `key: value` / `key:`-scalar; nested `metadata:` is skipped).
- Reports violations of the table above; exits non-zero only when a skill is
  missing its `description` (pi would refuse to load it).

## Publishing checklist

- [ ] `npm run validate` clean (no missing descriptions)
- [ ] `pi -e .` smoke test passes (skills appear)
- [ ] `package.json` version mirrors upstream
- [ ] git commit + tag + push (GitHub)
- [ ] `npm publish` (requires npm login) → gallery auto-lists via `pi-package`
      keyword; confirm with
      `npm search --json pi-package` or the npm registry keyword endpoint
