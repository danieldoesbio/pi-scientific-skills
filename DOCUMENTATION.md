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
2. A pinned snapshot of upstream skills (`skills/`), kept byte-identical apart
   from four deliberately excluded skills (see Provenance).
3. Tooling to re-sync from upstream and to validate against pi's rules.

## Provenance

- **Upstream:** https://github.com/K-Dense-AI/scientific-agent-skills
- **Upstream version:** 2.63.0 (from `pyproject.toml`), recorded in
  `package.json` as `upstreamVersion`
- **Our version is independent of upstream's.** This package uses its own semver
  line starting at 1.0.0. It deliberately does *not* mirror the upstream number:
  the two artifacts differ (157 skills vs upstream's 161, plus the `/sci`
  extension), and upstream ships patch releases — 16 of their 99 tags have a
  non-zero patch, e.g. `v2.37.2`. Mirroring would mean an extension-only fix has
  to burn a number like `2.63.1` that upstream may later claim for itself, and
  npm versions can never be reused. `upstreamVersion` carries the snapshot
  identity instead, so bump `version` for *our* changes and `upstreamVersion`
  for *theirs*.
- **Source snapshot:** `scripts/sync-upstream.sh <tag>` shallow-clones the
  upstream tag and copies `skills/` byte-identical into this repo. (The 1.0.0
  snapshot predated the script and came from a `-main.zip` download; every
  release since is tag-pinned.)
- **License:** MIT, © 2025 K-Dense Inc. (`LICENSE.md` is the upstream text verbatim).
- **Relationship:** this repo is an independent distribution of the open-source
  skill collection. It is not affiliated with K-Dense Inc.

### Deliberate exception to the byte-identical rule — do not "restore" these

Upstream vendors four skills from [anthropics/skills](https://github.com/anthropics/skills):
`docx`, `pdf`, `pptx`, `xlsx`. They are **not MIT**. Each ships a `LICENSE.txt`
reading `© 2025 Anthropic, PBC. All rights reserved.` whose ADDITIONAL
RESTRICTIONS forbid, verbatim:

> - Extract these materials from the Services or retain copies of these materials outside the Services
> - Reproduce or copy these materials […]
> - Distribute, sublicense, or transfer these materials to any third party

Publishing this package to npm and hosting it in a public git repo does all
three. They are therefore **excluded from this distribution**, which is why the
package ships 157 skills and not upstream's 161. `scripts/sync-upstream.sh`
strips them after every sync (`EXCLUDED_SKILLS`), so a re-vendor cannot quietly
reintroduce them. Everything else in `skills/` remains byte-identical to upstream.

Two traps for whoever touches this next:

- **`pptx-posters` is K-Dense's own skill and IS shipped.** The exclusion list is
  matched on exact directory names for that reason; never make it a prefix match.
- Removing a skill means updating `TOTAL_SKILL_COUNT` in `extensions/profiles.ts`
  *and* its profile memberships, or `npm run validate` fails the drift check.

If you ever obtain written permission from Anthropic, that is the only thing that
changes this decision — accurate licence labelling alone does not confer the
right to redistribute.

### Upstream's `plugin.json` is deliberately not carried (decided at v2.63.0)

Upstream v2.63.0 added a root `plugin.json` declaring the repo an
[Agent Plugins](https://agent-plugins.org/) 1.0.0 package, so plugin-capable
clients (Cursor, Codex, Copilot) can load the collection. This package does not
carry it, and the sync script does not need changing to keep it out — it copies
`skills/` only, never repo-root files.

Reasons, so this isn't reopened on every sync:

- **Copying it verbatim would misattribute.** The manifest hardcodes
  `name: scientific-agent-skills`, `version: 2.63.0`, and upstream's repository
  URL. None of those describe this package.
- **Rewriting it would overclaim.** A manifest under our name asserts Agent
  Plugins conformance for hosts this package has never been run against. Ten
  skills have been functionally exercised, all in pi, none in Cursor/Codex/
  Copilot. Advertising those clients on that basis is unsupported.
- **It contradicts the independent-versioning decision above.** Upstream's
  `AGENTS.md` requires `plugin.json` `version` to track `pyproject.toml`. This
  package versions independently and has no `pyproject.toml`.
- **The package isn't conformant anyway.** It ships `extensions/` for `/sci`,
  which is not part of the portable Agent Plugins layout.

The size argument is not one of the reasons: the manifest is ~700 bytes against
a 7 MB tarball. This is a scope decision, not a weight decision.

**Scope note this establishes.** This package is a pi-focused distribution, not a
strict mirror — it already excludes four skills, adds `/sci`, and versions
independently. Divergence belongs in the *packaging layer*: what is excluded,
what ships alongside, the docs, the extension. It must never move inside the
contents of a vendored file, because `sync-upstream.sh` does a wholesale
`rm -rf skills/ && cp -R` and would silently revert such an edit on the next
sync with nothing to flag it. Exclusions stay declarative (a name list the
script re-applies), which is why they survive.

### Adding skills of our own — the mechanism, decided in advance

The README reserves the option to ship maintainer-authored skills alongside
upstream's. None exist yet. When the first one lands, it must follow this, and
the reason is mechanical, not stylistic: `sync-upstream.sh` does
`rm -rf skills/` followed by `cp -R`, so **anything placed in `skills/` is
destroyed by the next sync, silently and without a diff to notice.**

- Local skills live in a **separate top-level directory** (`skills-local/`),
  never inside `skills/`. Confirmed supported: pi's manifest reader resolves
  `pi.skills` through `sourceEntries.flatMap(...)` in
  `core/package-manager.js` (`collectFilesFromManifestEntries`), so multiple
  roots work. Register it as a second entry:
  `"skills": ["./skills", "./skills-local"]`.
- Add it to `files` in `package.json` or it will not ship.
- `validate.mjs` scans `skills/` only (`const skillsDir = join(root, "skills")`)
  and hard-fails when `TOTAL_SKILL_COUNT` disagrees with what it finds there.
  Extend it to scan both roots and count them **separately** — the upstream
  count is a provenance claim in the README, not just a number, and must not
  silently absorb local additions.
- `/sci` gets a distinct toggle for local skills. Do not fold them into `core`.
- Each local skill states its own authorship in frontmatter.

The point of all of this is that the README's attribution — "nothing in
`skills/` is this maintainer's work" — stays literally true and checkable from
the file tree, rather than depending on anyone's memory.

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
package.json            # pi manifest: "pi": { "skills": [...], "extensions": [...] }, keyword "pi-package"
skills/                 # 157 skill directories, each with SKILL.md (+ references/scripts/assets)
extensions/index.ts     # the /sci command + sci_find tool — picker, search, settings.json writer
extensions/profiles.ts  # profile taxonomy (PROFILES, UNASSIGNED, TOGGLES, TOTAL_SKILL_COUNT)
extensions/search.ts    # sci_find's catalogue + ranking, and skills/ root resolution
extensions/aliases.ts   # curated query→skill aliases, each from an observed miss
extensions/frontmatter.ts    # the one YAML parser, shared with validate.mjs
extensions/package-info.ts   # PACKAGE_NAME / PACKAGE_VERSION; validate.mjs guards the drift
scripts/lib/load-extension.mjs  # loads extensions/ the way pi does (jiti + host aliases)
scripts/doc-count.mjs   # each suite checks the check-count the README claims for it
scripts/sync-upstream.sh  # re-sync skills/ from upstream
scripts/validate.mjs    # pi-rule validation across all skills + extensions/ drift checks
scripts/test-search.mjs # sci_find ranking against the real 157 descriptions
scripts/test-extension.mjs   # command + startup behaviour against a stubbed ExtensionAPI
scripts/test-filter.mjs # that pi itself honours the filter we write
scripts/test-tui-offer.py    # pi's real TUI, driven through a pty (no tokens)
scripts/try-it.sh       # launch this branch in a throwaway pi, to try it by hand
scripts/test-find-live.mjs   # release gate: does a small model reach for sci_find? (spends tokens)
scripts/test-batch.mjs  # run 4-8 skills for real in pi, capture transcripts for grading
scripts/track-downloads.mjs  # append npm daily counts to metrics/downloads.json
testing/ledger.json     # which skills have actually been RUN, with verdicts (+ extensionRuns)
testing/transcripts/    # raw pi output per graded run, kept as evidence
metrics/downloads.json  # npm daily series + publish dates, with revisions recorded
LICENSE.md              # upstream MIT verbatim
README.md               # pi-user-facing
DOCUMENTATION.md        # this file
test-artifacts/         # gitignored: output from local skill verification runs
```

`scripts/`, `testing/` and `metrics/` are maintainer-side and do not ship —
`package.json` `files[]` whitelists `extensions`, `skills` and the three
markdown files. They do reach anyone installing via
`pi install git:github.com/...`, which ships the whole tree.

## The `/sci` extension

### Why it exists

Pi injects every skill's name and description into the system prompt at startup;
only skill *bodies* are deferred. Measured across this collection: 65,455
description characters ≈ **17,700 tokens**, ≈113 tokens per skill. That is 54% of
a 32k context and more than an 8k context can hold. Pi is frequently run with
small local models, so the index cost — not the skill content — is the binding
constraint.

Two distinct problems follow, and the profile design addresses both: the context
budget, and selection accuracy (a small model discriminates poorly among 157
similar descriptions, many of which are near-neighbours).

### Why it writes settings.json rather than filtering at runtime

Four mechanisms could filter skills. Only one is compatible with this port:

| Mechanism | Verdict |
|---|---|
| `disable-model-invocation: true` in frontmatter | **Rejected.** Edits `SKILL.md`, breaking byte-identity with upstream, and `sync-upstream.sh` replaces `skills/` wholesale — every sync would silently wipe the user's selection. |
| Intercept `resources_discover` and return filtered `skillPaths` | **Impossible**, not merely undesirable — see below. |
| `before_agent_start` returning a rewritten `systemPrompt` | **Rejected.** Would strip the skills index while leaving pi's registry intact — the only route that preserves `/skill:<name>`. But it is per-turn prompt surgery, fragile across pi versions, and invisible to `pi config`. |
| Write pi's own per-package filter into `settings.json` | **Chosen.** Native, inspectable, hand-editable, composes with `pi config`, survives sync, and outlives the extension. |

**`resources_discover` cannot filter at all.** An earlier version of this document
called it "rejected" on the grounds that the selection would die with the
extension. The conclusion was right and the premise was wrong, which is worse
than being wrong outright — it invites someone to re-litigate the decision on a
false basis. The hook is **additive only**: `emitResourcesDiscover`
(`dist/core/extensions/runner.js:891-926`) does nothing with a handler's return
value except push it into accumulator arrays, and `agent-session.js:1764-1780`
feeds those to `resource-loader.js`'s `extendResources` (229-255), which *merges*
into the already-discovered set. No return value can remove a skill.

The filter is the documented object form (`settings.md`):

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy"] } ] }
```

### Search mode — progressive disclosure for the model (v1.1.0)

Profiles solve the context budget for the **human**: you pick a field before the
work starts. They do nothing for the **model**, and a profile is a bet — when it
is wrong, the skill the scientist needed is invisible.

`sci_find` closes that half. It loads no skills; it searches all 157 names and
descriptions and returns the ones that match, with full descriptions and the
absolute `SKILL.md` path for the model to `read`. That is mechanically identical
to how pi loads a skill natively, one level further down: descriptions deferred
rather than bodies.

`/sci search` applies Core (10 skills, ~1.1k tokens) through the same
`commitPlan` path everything else uses — deliberately **no second write path**,
so the empty-array footgun handling below stays single-sourced.

**Design decisions worth not re-deriving:**

- **The tool is registered unconditionally**, not behind a mode flag. ~150 tokens
  of tool definition against a ~18k index is not a trade worth a config toggle,
  and someone running all 157 still benefits from looking a skill up by need
  rather than by name. `/sci status` says so.
- **Recall beats precision.** `sci_find` does not have to pick the right skill,
  only get it into a list of eight with full descriptions attached. Even a small
  model discriminates well among eight labelled options and badly among 157 in a
  system prompt. That is why scoring is OR-based: requiring every term to match
  returns nothing for ordinary phrasings ("variant calling" matches no single
  description verbatim).
- **Never a confident wrong answer.** Below `MIN_SCORE` nothing is returned. A
  plausible-but-wrong skill handed to someone designing an experiment is worse
  than no answer. Matching is **word-boundary, not substring** — raw substring
  matching scored `open-notebook` for "book a flight to paris", which is exactly
  the failure mode this rule exists to prevent.
- **`aliases.ts` entries must come from an observed miss**, never from
  imagination. `pysam`'s description says VCF/BCF but never "variant";
  `esm`'s says ESMFold2 but never "protein structure prediction". Speculative
  aliases make results worse, and `validate.mjs` hard-fails on any alias naming
  a skill that no longer exists.
- **The catalogue is read lazily from disk** (~18ms for 157 files, head 8KB
  each) and cached for the session. A committed generated catalog was rejected:
  it would duplicate ~65KB of upstream description text into `extensions/`,
  breaching the "everything in `skills/` is upstream's" claim this repo keeps
  checkable, to save 18ms.

**Locating our own `skills/` at runtime.** `import.meta.url` survives jiti — a TS
module evaluated through pi's loader sees it rewritten to its own path, verified
empirically against pi's bundled jiti 2.7.0 via `jiti.import`, the loader's own
call. So `join(dirname(fileURLToPath(import.meta.url)), "..", "skills")` is
correct. It is guarded by an actual `SKILL.md` check: if the directory does not
hold skills, the tool is **not registered** rather than handing the model paths
that do not exist.

### Startup messaging — the obligation, and where it is enforced

This package writes into a file it does not own. Two rules follow, and
`scripts/test-extension.mjs` exists mainly to hold them:

1. **A new user is offered, never given.** The first-run dialog has a recommended
   answer; escape, timeout (20s) and decline all write nothing. The answer is
   recorded *before* acting, so the question is asked exactly once either way.
2. **An existing user is told, never asked.** Their `settings.json` is
   **byte-identical** before and after an upgrade — asserted directly, because
   nothing weaker actually proves it.

Four details that are easy to get wrong:

- **Gate the dialog on `ctx.mode === "tui"`, not `ctx.hasUI`.** `hasUI` is true in
  RPC too, so gating on it hands a scripted client a modal with nobody to answer.
  `ctx.mode` is genuinely populated at `session_start`, not still at its `"print"`
  default: `bindExtensions` sets it (`agent-session.js:1746`) and applies it to the
  runner (`:1805`) *before* emitting the event (`:1761`).
- **Report through `report()`, not `ctx.ui.notify`.** `notify` is a documented
  no-op with no UI bound, so a `pi -p` user would be informed into the void and
  then marked as told. `report()` falls back to stderr. For the same reason the
  `session_start` handler is **not** gated on `ctx.hasUI`.
- **`pi.sendUserMessage` needs `expandPromptTemplates: true` to run a command.**
  It defaults that flag to `false` (`agent-session.js:1130`) — the opposite of
  `prompt()`, which defaults it to `true` (`:793`) — and extension-command
  dispatch is gated on it (`:799`). Without it, accepting the offer sends the
  literal string `/sci search` to the model as a user message: the user says
  yes, no filter is written, and a turn is spent on nothing. This is the whole
  reason the accept path is routed through the command at all — `session_start`
  emits with the plain context (`runner.js:579`), which has no `reload()`; only
  the *command* context gets one (`:567`). Caught by asserting the **options**
  passed to `sendUserMessage`, not just the text; asserting only the text passes
  either way, which is exactly how it slipped through the first time.
- **Someone who hand-filtered the package gets a notice too**, not silence. They
  are not offered anything — they already answered that question — but `sci_find`
  reaches the skills their filter excludes, and shipping that without saying so
  would change what they chose out from under them. (A filter was never a
  boundary; the model could always `read` any `SKILL.md`. That is precisely why
  it has to be said out loud.)

### Known trade-off — `/skill:<name>` fails silently under a filter

With a filter active, `/skill:<name>` for a filtered-out skill is not an error.
`_expandSkillCommand` (`agent-session.js:953-961`) misses the lookup and passes
the **literal text** through to the model — worse than a plain failure, because
nothing signals that anything went wrong. Disclosed in `/sci status` and the
README. The real fix is a `/sci use <name>` that reads any of the 157 bodies and
injects it via `pi.sendUserMessage`, wrapped as pi wraps it — deferred to v1.2.0,
and explicitly **not** 157 shadow commands.

### The empty-array footgun

`applyPackageFilter` (pi `dist/core/package-manager.js:1804`) treats a **literally
empty** `skills` array as "disable all". A *non-empty* array containing only
override patterns (`!x`, `+x`, `-x`) instead falls through to `applyPatterns`,
which starts from **all** paths when there are no plain includes
(`package-manager.js:561`). So preserving a user's `!pattern` overrides through a
"disable all" would invert it into "enable all" while reporting ~0 tokens.
`applyPlanToEntry` therefore writes `[]` in that one case and preserves overrides
everywhere else. Do not "fix" this without re-reading both functions.

### Why the picker is a custom component

`ctx.ui.select` builds a fresh `SelectList` on every call with `selectedIndex`
0, and `ExtensionUIDialogOptions` carries only `signal` and `timeout` — there is
no initial-index option. So a picker built from repeated `select()` calls resets
the cursor to the top after every toggle, which makes ticking two adjacent
profiles needlessly slow.

The picker therefore renders through `ctx.ui.custom`, a focused component that
owns its own cursor and checkbox state (`createProfileList`). Space toggles,
arrows move, enter applies, esc cancels, `a`/`n` are select-all/none. Plain
characters are safe to bind: `SelectList.handleInput` only handles
up/down/confirm/cancel and ignores everything else.

Two fallback conditions matter, and both are covered:

- `ui.custom` may be **absent** on older pi builds.
- RPC mode **defines it but returns `undefined` without rendering**
  (`dist/modes/rpc/rpc-mode.js:151`).

So `choose()` falls back to the original `select()` loop
(`chooseViaSelect`) in both cases. This is why the picker's result type is
always a non-`undefined` object — `{action, selected}` — so an `undefined`
return unambiguously means "unsupported" rather than "user cancelled".

Note that a custom component must implement `invalidate()`; it is required by
pi-tui's `Component`, not optional, even when nothing is cached.

### Other constraints encoded in the code

- Config dir comes from pi's own `getAgentDir()`, so `PI_CODING_AGENT_DIR` is honoured.
- Writes are atomic (temp + rename) but resolve symlinks first, so a dotfiles-managed
  `settings.json` is updated in place rather than replaced with a regular file.
- A `settings.json.lock` directory is taken around read-modify-write, matching
  proper-lockfile's protocol, with stale-lock stealing after 10s.
- Malformed or unreadable settings cause a **refusal with an explanation**, never a write.
- A project `.pi/settings.json` that lists this package wins over the global one, so
  `/sci` refuses and names that file instead of writing a change that would do nothing.
- `scripts/validate.mjs` imports `profiles.ts` and hard-fails if it drifts from
  `skills/` — an upstream sync that adds or renames a skill must not silently strand
  it in no profile. Requires Node ≥ 22.18 for TypeScript type stripping.

### Testing it

Pi loads extensions with **jiti** (`dist/core/extensions/loader.js:332`), which
resolves extensionless relative imports — `from "./profiles"` is correct and will
fail under raw Node ESM. `scripts/lib/load-extension.mjs` reproduces that load
path (finds pi on `PATH`, rebuilds the alias map, imports `jiti/lib/jiti-static.mjs`
directly), so the suites exercise the same module graph pi does. An installed pi
is therefore a hard prerequisite for `npm test`.

`npm test` runs four things, none of which spend model tokens:

| Script | What it proves |
|---|---|
| `validate.mjs` | All 157 frontmatters parse and have descriptions; `profiles.ts`, `aliases.ts` and `package-info.ts` agree with `skills/` and `package.json`. |
| `test-search.mjs` | `sci_find`'s ranking, against the **real** 157 descriptions — including four queries that must return *nothing*. |
| `test-extension.mjs` | Command and startup behaviour against a stubbed `ExtensionAPI` with `PI_CODING_AGENT_DIR` at a throwaway dir. |
| `test-filter.mjs` | That **pi itself** honours the filter we write, via a real `DefaultPackageManager`. |
| `test-tui-offer.py` | The first-run offer in pi's **real TUI**, driven through a pty: accepting writes Core, declining and timing out write nothing. The only check that exercises the unstubbed accept path — and the only one that catches a missing `expandPromptTemplates`. Spends no tokens; needs a pty, so it is not in `npm test`. |
| `doc-count.mjs` | Not a suite — a helper each suite calls last, so the check counts the README quotes cannot silently rot. Added because they already had: five checks landed and the README still said 44. |
| `try-it.sh` | Not a test — a sandbox. Packs the tarball, seeds a throwaway `PI_CODING_AGENT_DIR` for one of five startup scenarios, and opens pi. `~/.pi/agent` is never touched, the credential copy is deleted on any exit, and it reports afterwards whether `settings.json` moved. `--check` asserts the scenario's message headlessly instead of opening the TUI. |

Two things are worth knowing before changing these:

- `resolve()` returns *all* resources with an `enabled` flag, so `.length` does
  not change when a filter applies. Count `resolve().skills.filter(s => s.enabled)`
  or the test proves nothing.
- `getAgentDir()` reads `PI_CODING_AGENT_DIR` on **every** call (`config.js:412-418`),
  so a single test process can point successive cases at different throwaway dirs.

`scripts/test-find-live.mjs` is the release gate and is **not** in `npm test`
because it spends tokens. It installs the packed tarball into a throwaway agent
dir filtered to Core and asks a small model three questions whose skills are not
loaded, then checks the transcript for a `sci_find` call. If a weak model does
not reach for the tool, the tool description and `aliases.ts` are the fix — not
the test. It copies `auth.json` into the throwaway dir (deleted at exit,
including under `--keep`): without that, every probe fails with "No API key
found" and the run reports a model that declined to call the tool when in fact
no model ran. It separates "never ran" from "declined" for exactly that reason.

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
4. Set `upstreamVersion` in `package.json` to the tag that was synced, and bump
   our own `version` — minor for a new upstream snapshot, patch for an
   extension-only fix. Never copy upstream's number into `version` (see
   Provenance for why). Update the two `v2.63.0` mentions in README.
5. Commit, tag `v<version>` (ours, e.g. `v1.1.0`), push, `npm publish`.

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

`scripts/validate.mjs` (no dependencies, Node ≥ 22.18):

- Walks `skills/**/SKILL.md`.
- Parses YAML frontmatter with a line-based parser covering the constructs this
  collection actually uses: plain scalars, quoted scalars, and block scalars
  (`>`/`|` with chomping and indent indicators). Nested mappings (`metadata:`)
  are consumed and skipped — none are validated.
- Reports violations of the table above; exits non-zero when a skill is missing
  its `description` (pi would refuse to load it) or when `extensions/profiles.ts`
  disagrees with `skills/`.
- Checks `extensions/aliases.ts`: every alias must name a real skill directory,
  no trigger phrase may be listed twice (a duplicate double-counts its boost and
  quietly distorts ranking), and no rule may expand to nothing.
- Hard-fails when `extensions/package-info.ts` disagrees with `package.json`. A
  stale `PACKAGE_VERSION` silently suppresses the upgrade notice for every user,
  which is the one promise a release makes; it must not be possible to ship that.
- Warns when `TOKENS_PER_SKILL` drifts more than 10% from what `skills/` now
  measures. It stays a constant because the picker needs a cost synchronously,
  before anything is on disk to measure — but every `/sci` figure derives from
  it, so silent drift turns honest guidance into confident nonsense. A warning,
  not a failure: the number is an estimate by construction.

The parser is **not** defined here. It lives in `extensions/frontmatter.ts` and
is shared with `search.ts`, which parses the same files at runtime to build the
`sci_find` catalogue. Two copies would drift, and the drift would be invisible —
validation would pass on files the runtime read differently. Importing it here
also exercises it against all 157 real files on every release.

Block scalars matter more than they look. Two skills (`bids`, `onekgpd`) write
`description: >` with the text on following lines. A naive line-based parser
records the `>` indicator itself as the value, so a skill whose block body was
*empty* would present a 1-character description, pass the presence check, and
ship — even though pi would refuse to load it. That is the exact hard failure
this script exists to catch, so the parser resolves block bodies rather than
treating the indicator as the value.

## Repo hygiene (important when re-syncing)

`skills/` must stay **byte-identical to upstream**. Two things routinely violate
that, both by-products of testing rather than editing:

- **`__pycache__/` inside `skills/`.** Running a skill's Python helper compiles
  bytecode next to the source. Compiled bytecode is machine-specific build
  output, never upstream content, and `skills/` is in `package.json`'s `files`
  list — so anything left there is distributed. It is gitignored; do not
  force-add it.
- **Skill output written to the repo root.** Some skills (e.g.
  `experimental-design`) write CSV/Markdown into the working directory. Those
  belong in `test-artifacts/` (gitignored). Note that `files` keeps stray root
  files out of the npm tarball but **not** out of a
  `pi install git:github.com/...` install, which ships the whole tree.

After any sync or test run, confirm cleanliness:

```bash
diff -rq /path/to/upstream/skills skills   # must report no differences
npm pack --dry-run | grep -iE 'pycache|\.pyc'   # must be empty
```

## Functional testing

Two kinds of testing here, with very different costs:

- **Discovery** — does pi offer the skill, with the right name and description.
  Cheap, covers all 157, runs on every sync (`npm run validate` plus the tarball
  probe in the checklist below).
- **Functional** — does pi load the skill and does a model follow SKILL.md.
  Costs a model call and several minutes each, so it accumulates a few skills
  per release rather than ever being complete. The bar is whether pi sees and
  loads the skill. **Do not collect API keys, request Hub access, or download
  tool weights as part of testing.** If SKILL.md's next step needs a login or a
  large download, following it up to that point is a pass. An artifact is extra
  evidence when the skill produces one; it is not required.

`testing/ledger.json` is the record of the second kind. README's
"Functional runs — N of 157" derives from it.

```bash
npm run test:batch -- --version 1.0.3 --include <skills-new-this-release>
```

The batch is the skills new in this release plus a random fill to `--size`
(default 6; 4–8 is the working range), drawn only from skills never tested
before, so coverage accumulates instead of resampling. Selection is seeded by
the version string, so any batch is re-derivable months later.

Deliberate choices:

- **Runs against the packed tarball in a scratch dir**, never `./skills`. That
  tests what actually ships, dodges any `/sci` filter in your settings that
  would silently hide the skill, and makes it impossible for a skill script to
  leave `__pycache__` in the vendored tree.
- **One skill per run** (`-ne -ns --skill <one dir>`), so nothing else is in
  play. Tools stay enabled: pi exposes skills *as a tool*, so `--no-tools`
  hides the skill entirely and every run reports a false zero.
- **The script does not decide pass/fail.** It writes a raw `.jsonl` (gitignored:
  several MB, embeds `$HOME` paths and the operating username) and a scrubbed
  `<skill>.summary.json` (tool calls, truncated results, final text). Grading
  is a separate human or stronger-model pass. A model's claim that it succeeded
  is the thing under test, not evidence about it. Rebuild summaries after a
  distiller change with `--distill-only` rather than re-spending the model calls.
- **Stdout is a file descriptor, not a pipe.** pi's `--mode json` emits a
  cumulative `message_update` per token; buffering that under `maxBuffer` killed
  the first `arbor` run at 67 MB (SIGTERM, which reads as a skill failure and
  is not one).
- **The per-skill sandbox is wiped before each run.** Scratch is keyed only on
  version, so a re-run otherwise resumes leftover state.
- **Pair tool results on `toolCallId`, never on tool name.** pi returns
  concurrent results out of order; name-matching staples one command's output
  onto a different command.

Verdicts are `PASS`, `FAIL`, `BLOCKED`, or `TIMEOUT`. **`BLOCKED` and `TIMEOUT`
are not failures of the skill.** BLOCKED means a missing dependency, credential
or network; TIMEOUT is a fact about the run (wall clock or a harness fault).
Neither folds into a pass rate, and TIMEOUT skills stay in the sampling pool.

## Adoption metrics

```bash
npm run metrics:downloads
```

Appends npm's daily download counts to `metrics/downloads.json`. Re-running is
safe: days merge by date, and a count that npm later revises is recorded in a
`revisions` array rather than silently overwritten — the recent tail is
provisional and the ledger should show that rather than hide it.

The local copy exists because npm's range endpoint only serves ~18 months and
offers no way to ask what it said last week. Two things to keep in mind when
reading the series: npm counts **tarball fetches, not people**, so mirrors, CI
caches and registry scrapers are in the same bucket; and a publish-day spike is
almost certainly automated traffic. At 1.0.2 the series was 278 downloads over
12 days, 242 of them on publish day.

Neither this nor the ledger is a quality measure. They are here so that later
claims about adoption and coverage have something behind them.

## Publishing checklist

- [ ] `npm test` clean — validation plus the three offline suites (requires an
      installed pi; they load the extension through pi's own jiti)
- [ ] License exceptions re-checked after any sync — `find skills -iname 'LICENSE*'` and
      `grep -h '^license:' skills/*/SKILL.md | sort -u`; record new non-MIT or
      NonCommercial skills under Provenance and in README credits
- [ ] `skills/` byte-identical to upstream (`diff -rq`) — no `__pycache__`, no stray output
- [ ] `npm pack --dry-run` shows no `.pyc` and no test artifacts
- [ ] Discovery smoke test passes — run it against the **packed tarball extracted
      into a scratch dir**, not the repo (the repo path picks up whatever `/sci`
      filter is in your `~/.pi/agent/settings.json`):
      `cd $SCRATCH/package && pi -ne --skill ./skills --no-session -p "<name-presence probe>"`
      Note `-e .` does *not* load `pi.skills`, and `--no-tools` hides every skill
      (pi exposes them as a tool), so both read as a false zero. Check by name
      presence — the reported total also counts your personal skills.
- [ ] `node scripts/test-batch.mjs --version <ver>` run, transcripts graded, and
      `testing/ledger.json` updated with the new batch (see "Functional testing")
- [ ] `node scripts/test-find-live.mjs` passes on a **small** model, recorded under
      `extensionRuns` in the ledger. This is the gate for search mode: if a weak
      model does not reach for `sci_find`, the tool description and `aliases.ts`
      are the fix, before release
- [ ] `extensions/package-info.ts` `PACKAGE_VERSION` bumped alongside
      `package.json` — `npm run validate` hard-fails otherwise, but bump it
      deliberately: it is what decides whether existing users see the upgrade
      notice at all
- [ ] The upgrade notice actually says what changed for this release, and a
      seeded prior-version config still leaves `settings.json` byte-identical
      (`npm run test:extension` asserts this; re-read the wording by hand)
- [ ] `package.json` `version` bumped on our own line; `upstreamVersion` matches
      the synced tag; README's `v<upstream>` mentions agree with it
- [ ] git commit + tag + push (GitHub)
- [ ] `npm publish` (requires npm login) → gallery auto-lists via `pi-package`
      keyword; confirm with
      `npm search --json pi-package` or the npm registry keyword endpoint
