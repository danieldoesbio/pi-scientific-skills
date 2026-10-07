# DOCUMENTATION: pi-scientific-skills port

Maintainer-facing documentation for the pi distribution of
[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills).

## What this package is

A pi package that bundles the upstream **scientific-agent-skills** collection as
pi-native resources. Pi implements the open [Agent Skills
specification](https://agentskills.io/specification), so it loads the skills as
they are, with no translation layer or code conversion. The "port" consists of:

1. Packaging (`package.json` with a `pi` manifest and the `pi-package` keyword so
   the package appears in the [pi package gallery](https://pi.dev/packages)).
2. A pinned snapshot of upstream skills (`skills/`), byte-identical to upstream
   apart from deliberately excluded skills (see Provenance).
3. Tooling to re-sync from upstream and to validate against pi's rules.

Alongside the port, the package ships the `/sci` extension (see
[The `/sci` extension](#the-sci-extension)).

## Provenance

- **Upstream:** https://github.com/K-Dense-AI/scientific-agent-skills
- **Upstream version:** 2.72.0 (from `pyproject.toml`), recorded in
  `package.json` as `upstreamVersion`
- **Our version is independent of upstream's.** This package has its own semver
  line, starting at 1.0.0. The two artifacts differ (176 skills against
  upstream's 177, plus the `/sci` extension), and upstream ships patch releases
  (for example `v2.37.2`): mirroring would force an extension-only fix onto a
  number like `2.63.1` that upstream may later claim, and npm never lets a
  version be reused. `version` moves with *our* changes; `upstreamVersion`
  (written by `scripts/sync-upstream.sh`) identifies *their* snapshot.
- **Source snapshot:** `scripts/sync-upstream.sh <tag>` shallow-clones the
  upstream tag and copies its `skills/` byte-identical into this repo. It also
  accepts `main` or a commit SHA (see [Sync script details](#sync-script-details)).
- **`upstreamCommit` pins the exact upstream commit taken**, independent of
  `upstreamVersion`. The two diverge when a sync takes a SHA on `main` instead
  of a tag: `upstreamVersion` still records the latest tag by semver (a
  human-readable label), while `upstreamCommit` records what was copied. This
  snapshot is the `v2.72.0` tag itself (`526ebce`); upstream `main` was two
  commits past it at the time, neither touching `skills/`.
- **License:** MIT, © 2025 K-Dense Inc. (`LICENSE.md` is the upstream text verbatim).
- **Relationship:** this repo is an independent distribution of the open-source
  skill collection. It is not affiliated with K-Dense Inc.
- **Licensing notes on individual skills.** A skill's `license:` frontmatter
  (its value varies across the collection) does not license the services the
  skill drives. `alphagenome` declares MIT but calls DeepMind's AlphaGenome
  API, which is free for non-commercial use only, whose outputs may not be used
  to train other ML models, and which the skill's own description labels
  research use only. A commercial user should read the skill's `compatibility`
  line before building on it: MIT on the skill text carries no license to the
  API's outputs.

### Deliberate exception to the byte-identical rule: do not "restore" these

Upstream vendored four skills from [anthropics/skills](https://github.com/anthropics/skills):
`docx`, `pdf`, `pptx`, `xlsx`. They are not MIT. Each ships a `LICENSE.txt`
reading `© 2025 Anthropic, PBC. All rights reserved.` whose ADDITIONAL
RESTRICTIONS forbid, verbatim:

> - Extract these materials from the Services or retain copies of these materials outside the Services
> - Reproduce or copy these materials […]
> - Distribute, sublicense, or transfer these materials to any third party

Publishing this package to npm and hosting it in a public git repo does all
three, so they are **excluded from this distribution**. Upstream dropped them
itself on 2026-10-01 (`f7a50ed2`, first released in v2.72.0). They stay in
`scripts/excluded-skills.txt` so a re-vendor cannot quietly reintroduce them:
`scripts/sync-upstream.sh` deletes every listed skill after each sync
(`EXCLUDED_SKILLS`), and `npm run validate` fails if one is present in
`skills/`.

From v2.72.0 the list also excludes **`fictiv`**, for a different reason. It
drives app.fictiv.com in the user's logged-in browser through to checkout and
can place paid manufacturing orders that its own references say cannot be
cancelled. A skill that spends money irreversibly on a commercial platform does
not belong in a redistributed package, and `/sci` has no browser-automation
surface to run it. This exclusion is why the package ships 176 skills where
upstream has 177. Everything else in `skills/` is byte-identical to upstream.

Two traps for whoever touches this next:

- **`pptx-posters` is K-Dense's own skill and is shipped.** For that reason the
  exclusion list matches exact directory names; never make it a prefix match.
- Removing a skill means updating `TOTAL_SKILL_COUNT` in `extensions/profiles.ts`
  and its profile memberships, or `npm run validate` fails the drift check.

Only written permission from Anthropic would change this decision. Accurate
licence labelling alone does not confer the right to redistribute.

### The citation block is carried, not stripped (arrived with v2.66.0)

Since v2.66.0, upstream appends a `## Citing Scientific Agent Skills` section to
most of its skills. It asks the model to add upstream's paper
(Kassis et al. 2026, arXiv:2609.00065) to the references or software section
of any manuscript, report, presentation or code release the skill materially
contributed to, and to tell the user it did so. It arrives with each sync, in
the body of each `SKILL.md`.

- **It is a request in the skill body; it is not a licence term.** `LICENSE.md`
  is unchanged (MIT, © 2025 K-Dense Inc.). MIT requires only that the
  copyright and permission notice be kept, which this package does. Nothing in
  the block is enforceable against this package or its users.
- **It is carried because it cannot be stripped safely.** Exclusions here are
  declarative name lists that `sync-upstream.sh` re-applies. There is no
  mechanism to drop a section from inside the files that carry it, and the next
  `rm -rf skills/ && cp -R` silently reverts a hand edit inside `skills/`.
  Making the script strip it would be the first edit inside vendored content,
  which the scope note below rules out.
- **Side effect: network calls.** The block tells the model to fetch
  `arxiv.org/abs/2609.00065` before writing the reference when network access
  is available. That reaches skills which otherwise make no network calls,
  including `analytical-method-validation`, whose own `compatibility` line
  promises no network access.
- **No token-budget change.** `validate.mjs` estimates the always-loaded index
  from each skill's prompt entry (`name`, `description` and `SKILL.md` path),
  and the block touches none of these, so `TOKENS_PER_SKILL` and every `/sci`
  figure are unchanged (`npm run validate` reports the drift on every run).
  The block is body cost, paid only when a skill is read: roughly 155 tokens
  per read.

### Upstream's `plugin.json` is deliberately not carried (decided at v2.63.0)

Upstream v2.63.0 added a root `plugin.json` declaring the repo an
[Agent Plugins](https://agent-plugins.org/) 1.0.0 package, so plugin-capable
clients (Cursor, Codex, Copilot) can load the collection. This package does not
carry it. The sync script needs no change to keep it out: from the upstream
checkout it copies only `skills/` and `LICENSE.md`.

The reasons, recorded so this is not reopened on every sync:

- **Copying it verbatim would misattribute.** The manifest hardcodes
  `name: scientific-agent-skills`, `version: 2.63.0`, and upstream's repository
  URL. None of those describe this package.
- **Rewriting it would overclaim.** A manifest under our name asserts Agent
  Plugins conformance for hosts this package has never been run in. All
  [functional testing](#functional-testing) has been in pi, none in Cursor,
  Codex or Copilot, so advertising those clients is unsupported.
- **It contradicts the independent-versioning decision above.** Upstream's
  `AGENTS.md` requires `plugin.json` `version` to track `pyproject.toml`. This
  package versions independently and has no `pyproject.toml`.
- **The package is not conformant anyway.** It ships `extensions/` for `/sci`,
  which is not part of the portable Agent Plugins layout.

Size played no part: the manifest is about 700 bytes, negligible next to the
tarball. This is a scope decision.

**Scope note this establishes.** This package is a pi-focused distribution.
Its divergence from upstream belongs in the *packaging layer*: what is excluded
(`scripts/excluded-skills.txt`), what ships alongside (`/sci`, the docs), and
the independent version line. It must never move inside the contents of a
vendored file, because `sync-upstream.sh` does a wholesale
`rm -rf skills/ && cp -R` and would silently revert such an edit on the next
sync with nothing to flag it. Exclusions survive because they stay declarative
(a name list the script re-applies).

### Adding skills of our own: the mechanism, decided in advance

The README reserves the option to ship maintainer-authored skills alongside
upstream's. None exist yet. The first one must follow this, for a mechanical
reason: `sync-upstream.sh` does `rm -rf skills/` followed by `cp -R`, so
**the next sync deletes anything placed in `skills/`**, and the only trace in
its output is one more `removed:` line, easy to miss.

- Local skills live in a **separate top-level directory** (`skills-local/`),
  never inside `skills/`. Pi supports this:
  `DefaultPackageManager.collectFilesFromManifestEntries` in pi's
  `core/package-manager.js` resolves every entry of `pi.skills`
  (`sourceEntries.flatMap(...)`), so multiple roots work. Register it as a
  second entry: `"skills": ["./skills", "./skills-local"]`.
- Add it to `files` in `package.json` or it will not ship.
- `validate.mjs` scans `skills/` only (`const skillsDir = join(root, "skills")`)
  and hard-fails when `TOTAL_SKILL_COUNT` disagrees with what it finds there.
  Extend it to scan both roots and count them **separately**: the upstream
  count is a provenance claim in the README and must not silently absorb local
  additions.
- `/sci` gets a distinct toggle for local skills. Do not fold them into `core`.
- Each local skill states its own authorship in frontmatter.

All of this keeps the README's attribution ("nothing in `skills/` is this
maintainer's work") literally true and checkable from the file tree, without
depending on anyone's memory.

### Why not the "Claude Scientific Skills" repo

An older snapshot of the same project (`claude-scientific-skills`) also exists.
Upstream states "Claude Scientific Skills is now Scientific Agent Skills", so
the claude repo is deprecated. We port only the current repo so the package can
stay in sync with upstream. The deprecated repo contains ~60 unique skills
(mostly a `*-database` series) that were not carried into the current repo. We
do not merge them, because that would fork the collection and break future
synchronization. If a specific legacy skill is needed, port it individually as
a custom skill (see "Adding skills of our own" above).
## Structure

```
package.json            # pi manifest: "pi": { "skills": [...], "extensions": [...] }, keyword "pi-package"
skills/                 # 176 skill directories, each with SKILL.md (+ references/scripts/assets)
extensions/index.ts     # the only file that registers anything with pi (command, tool, hooks); onboarding notices
extensions/types.ts     # shared constants and types (COMMAND_NAME, SUBCOMMANDS, UiContext, ...); no imports
extensions/paths.ts     # settings.json and config-file paths, and the report() output helper
extensions/settings.ts  # reads/writes settings.json and this package's own config file; commitPlan
extensions/catalog.ts   # token accounting, the skill catalogue, sci_find's search, /skill:<name> rebuild
extensions/picker.ts    # the /sci profiles checkbox list (focused multiselect, select()-loop fallback)
extensions/commands.ts  # /sci's subcommands and bare-menu dispatch (status, search, all/none/reset)
extensions/profiles.ts  # profile taxonomy (PROFILES, UNASSIGNED, TOGGLES, TOTAL_SKILL_COUNT)
extensions/search.ts    # sci_find's catalogue and ranking, and skills/ root resolution
extensions/bm25f.ts     # the BM25F ranker sci_find uses
extensions/aliases.ts   # curated query→skill aliases, each from an observed miss
extensions/frontmatter.ts    # the one YAML parser, shared with validate.mjs
extensions/package-info.ts   # PACKAGE_NAME / PACKAGE_VERSION; validate.mjs guards the drift
scripts/lib/load-extension.mjs  # loads extensions/ the way pi does (jiti + host aliases)
scripts/doc-count.mjs   # lets each suite check the check count README claims for it
scripts/sync-upstream.sh  # re-sync skills/ from upstream
scripts/validate.mjs    # pi-rule validation across all skills, plus extensions/ drift checks
scripts/test-search.mjs # sci_find ranking against the real 176 descriptions
scripts/test-extension.mjs   # command and startup behaviour against a stubbed ExtensionAPI
scripts/test-filter.mjs # checks that pi itself honours the filter we write
scripts/test-skill-expand.mjs  # checks our /skill: block is byte-identical to pi's (pi's own method is the oracle)
scripts/test-tui-offer.py    # pi's real TUI, driven through a pty (no tokens)
scripts/try-it.sh       # launch this branch in a throwaway pi, to try it by hand
scripts/test-find-live.mjs   # release gate: does a small model reach for sci_find? (spends tokens)
scripts/find-live-arms.sh    # unattended multi-arm live run (v16 / v17 / full), frozen sources
scripts/test-live-lib.mjs    # the live harness's endpoint, gate and measures, on synthetic sessions
scripts/find-live-timing.mjs # server-side prefill, generation and queue wait per attempt of a find-live-arms run
scripts/find-live-arms-report.mjs # the pre-registered outcomes of a find-live-arms run
scripts/find-ab.sh           # two package commits through a cloud model, both arms at once, frozen sources
scripts/find-ab-report.mjs   # the pre-registered outcomes of a find-ab run
scripts/find-live-replay.mjs # replay the choice turn of a find-live run with another sci_find format
scripts/find-live-replay-report.mjs # the pre-registered outcomes of a replay
scripts/find-live-replay-pooled.mjs # two replay samples pooled (Newcombe + cluster bootstrap)
scripts/find-rank-bench.mjs  # offline top-k rates of the sci_find rankers on the fixed query sets
scripts/find-rank-heldout.mjs # the locked held-out set, scored once (counts only, never the texts)
scripts/find-probes-styled.mjs # a probe file whose tasks are one paraphrase style
scripts/find-panel.sh        # first sci_find queries of one query writer, per style, frozen sources
scripts/find-panel-report.mjs # the writer panel's search rate and top-8 rates, current vs bm25f
scripts/test-batch.mjs  # run 4-8 skills for real in pi, capture transcripts for grading
scripts/track-downloads.mjs  # append npm daily counts to metrics/downloads.json
testing/ledger.json     # which skills have been run for real, with verdicts (+ extensionRuns)
testing/find-rank/      # ranker query sets: recorded first sci_find queries, blind probe paraphrases
testing/transcripts/    # raw pi output per graded run, kept as evidence
metrics/downloads.json  # gitignored: npm daily series + publish dates, with revisions
LICENSE.md              # upstream MIT verbatim
README.md               # pi-user-facing
DOCUMENTATION.md        # this file
test-artifacts/         # gitignored: output from local skill verification runs
```

`scripts/` and `testing/` are maintainer-side and are not in the npm package:
`package.json` `files[]` lists only `extensions`, `skills` and the three
markdown files. An install via `pi install git:github.com/...` gets the whole
tree, so git users do receive them. `metrics/` reaches neither: it is
gitignored, so the download ledger stays on the maintainer's disk.

**One registrar.** `extensions/index.ts` is the only file allowed to call
`pi.registerCommand`, `pi.registerTool` or `pi.on`. Every other file in
`extensions/` ends in the same inert
`export default function noopExtension(): void {}`, and
`scripts/test-extension.mjs` asserts that each one calls nothing on the
`ExtensionAPI` it is handed. Through the manifest's `./extensions` entry, pi
loads only `index.ts`: `collectAutoExtensionEntries`
(`dist/core/package-manager.js`) treats a directory with an `index.ts` as one
extension. Without that file, pi would load
each `.ts` as an extension of its own, and it does not deduplicate: same-named
commands are all silently renumbered (`sci:1`, `sci:2`), so `/sci` stops
resolving, and a same-named tool after the first is dropped and reported as a
conflict. The inert export keeps a sibling harmless if it is ever loaded that
way.

## The `/sci` extension

### Why it exists

Pi puts every skill's name, description and absolute `SKILL.md` path into the
system prompt at startup, one XML-escaped `<skill>` block each
(`formatSkillsForPrompt` in pi's `core/skills.js`). Only skill *bodies* are
deferred. For this collection as pi renders it, that is about 104k characters,
about **25k tokens**: about 143 tokens per skill, of which the bare description
is roughly 88 (the recipe and both tokenizers are in the `TOKENS_PER_SKILL`
comment in `profiles.ts`). That is most of a 32k context and more than a 16k
context can hold. Pi is often used with small local models, and for them this
index is the binding constraint.

Two problems follow, and the profile design addresses both: the context budget,
and selection accuracy (a small model tells 176 similar descriptions apart
poorly, and many of them are near-neighbours).

### Why it writes settings.json rather than filtering at runtime

Of the ways to filter skills, only one fits this port:

| Mechanism | Verdict |
|---|---|
| `disable-model-invocation: true` in frontmatter | **Rejected.** It edits `SKILL.md`, which breaks byte-identity with upstream, and `sync-upstream.sh` replaces `skills/` wholesale, so every sync would silently wipe the user's selection. |
| Intercept `resources_discover` and return filtered `skillPaths` | **Impossible.** The hook can only add skills (see below). |
| `before_agent_start` returning a rewritten `systemPrompt` | **Rejected.** It would strip the skills index while leaving pi's registry intact, so `/skill:<name>` would keep working. But it is per-turn prompt surgery, fragile across pi versions, and invisible to `pi config`. |
| Set `disableModelInvocation` on the live `Skill[]` at runtime (via `ctx.getSystemPromptOptions().skills` or `before_agent_start`'s `systemPromptOptions`, both returned by reference) | **Rejected (decided at 1.4.0).** This is the one pi feature whose semantics match "hide from the prompt, keep `/skill:`": `formatSkillsForPrompt` (pi's `core/skills.js`) is the only reader of the flag, and pi's own comment says such skills "can only be invoked explicitly via /skill:name". But `/skill:` resolves only loaded skills, so **all 176 would have to load**, which means abandoning the `settings.json` filter. That gives up `pi config` composition, hand-editability and survival of extension removal, and `pi config` would show all 176 enabled while the prompt carried 10, misreporting the selection. |
| Write pi's own per-package filter into `settings.json` | **Chosen.** Native, inspectable, hand-editable, composes with `pi config`, survives sync, and outlives the extension. |

**`resources_discover` cannot filter at all.** The hook is additive only.
`ExtensionRunner.emitResourcesDiscover` (`dist/core/extensions/runner.js`) does
nothing with a handler's return value except push its paths into accumulator
arrays. `AgentSession.extendResourcesFromExtensions` passes those to
`DefaultResourceLoader.extendResources` (`resource-loader.js`), which merges
them into the already-discovered set. No return value can remove a skill.

The filter is the object form that pi documents in `docs/packages.md`:

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy"] } ] }
```

### Search mode: progressive disclosure for the model (v1.1.0)

Profiles solve the context budget for the human, who picks a field before the
work starts. They do nothing for the model, and a profile is a bet: when it is
wrong, the skill the scientist needed is invisible.

`sci_find` covers the model's side. It loads no skills; it searches the names,
descriptions and SKILL.md text of all 176 skills and returns the ones that
match, with full descriptions and the absolute `SKILL.md` path for the model to
`read`. This is how pi loads a skill natively, one level further down: pi
defers the bodies, and search mode defers the descriptions as well.

`/sci search` writes an empty `skills` filter (no skill in the system prompt,
~0 tokens) through the same `commitPlan` path everything else uses. There is
deliberately no second write path, so the empty-array footgun handling below
stays in one place. `/sci none` is an alias: while `sci_find` is registered, an
empty filter means search mode.

**Why no skills, since 1.7.0.** Before 1.7.0, search mode loaded the ten Core
skills (~1.4k tokens). The 2026-09-23 live test
([`testing/report.md`](testing/report.md)) ran a 27B local model with no skill
in its prompt: it reached all ten Core targets through `sci_find` (8 on the
first attempt), and 156 of 157 valid targets within three attempts (143 on the
first). The risk: the two Core probes that missed on the first attempt
(`exploratory-data-analysis`, `polars`) were attempts that never searched, and
with Core in the prompt those skills would have been listed. The
`promptSnippet` below exists to cover that. A small A/B pilot of the snippet
(`testing/runs/2026-09-24-bonsai2-snippet-ab.md`) showed no effect on the
search rate (11/12 in both arms).

A three-arm run over 161 probes then measured the default change itself
(`testing/runs/2026-09-25-night-arms.md`): the model read the target skill on
157 with the 1.7.0 design as first built, on 116 with 1.6.0 search mode (+25.5
points, 95% CI 18.4 to 32.9) and on 158 with all 162 skills listed. It read all
ten Core targets in every arm. That 1.7.0 arm is the build at commit `08aff2e`,
which still had the old ranker, 8 hits and a `limit` argument the model could
set; the BM25F ranker and the 3-then-5 list came later (`713d6e8`). The gain
belongs to that design as a whole, which also added the `sci_find` snippet and
guideline that 1.6.0 lacked. The evidence for the shipped design is a chain of
two runs on two models: Bonsai 2 27B, first-built 1.7.0 against 1.6.0, +25.5
points; then Gemma 4 26B-A4B, new search against old, +6.0 points (below). No
single run compares the shipped design with 1.6.0 on one model.

Profiles still put a field's skills in the prompt for anyone who wants them
there. Existing users keep their filter; the 1.7.0 upgrade notice says what
changed and how to get Core back (below).

**`sci_find` in the system prompt, since 1.7.0.** pi lists a custom tool in the
tools section of its default system prompt only when it has a `promptSnippet`
(`system-prompt.js` filters on it); until 1.7.0 the model saw `sci_find` only in
the tool schema. In the 2026-09-23 test, 15 of the 19 misses on valid probes
were attempts that never called it. The tool now carries a one-line snippet and
one guideline: use `sci_find` before writing code, installing a package or
setting up a service for scientific, research or analysis work. pi puts
guidelines into its own list with no tool heading, so the guideline names the
tool. `test-extension.mjs` renders both through pi's own `buildSystemPrompt`.

The scope says "scientific, research and analysis" because of the pilot's one
treatment miss (`parallel-web`): the model's thinking named `sci_find` as a
tool for "scientific skills" and judged a web-monitoring task out of its scope.
The wording does not name web search, because that would fit one probe
directly. Known trade-off: "analysis" lets the guideline fire in ordinary
data-coding sessions, which costs one tool call. The live tests cannot measure
that, because every probe has a target.

**A custom system prompt gets neither the listing nor the guideline.** pi adds
a tool's snippet and guidelines only when it builds its own default prompt.
With a custom one (`SYSTEM.md` or `--system-prompt`) it leaves out the tools
section and the guidelines (the `customPrompt` branch of
`buildSystemPromptSections` in pi 1.0.0's `system-prompt.js`; pi 0.84.3 and
0.87.0 do the same). `sci_find` is still registered and in the tool schema, but
the prompt never names it. In search mode that is the state of the 2026-09-23
run, where most misses never called the tool. If you use a custom prompt, add a
line that names `sci_find`, for example the package's own guideline: "Use
`sci_find` before you write code, install a package or set up a service for
scientific, research or analysis work: a skill may already cover it. Then read
the SKILL.md it returns." No live run used a custom prompt, so the effect of
that line is not measured.

**Codemode (checked on pi 1.0.0; codemode first shipped in 0.99.0).** Codemode
is off by default. With `codemode.mode: "only"`, pi's tools list shows only
`codemode`; scripts call `sci_find` as `tools.sci_find`, the guideline stays in
the prompt, and the 3-then-5 hit rule still applies. pi also turns codemode on
when an MCP server with the default `codemode` exposure connects;
`"autoEnableCodemode": false` beside `mcpServers` in `mcp.json` stops that
(pi's `docs/mcp.md`). Codemode adds its own tool and a line to each tool
description, so with a small local model keep it off unless you use it.

**`/sci none`, `/sci search` and the way back to Core (1.7.0).** An empty
`skills` filter means search mode; it does not turn `sci_find` off. 1.6.0's
`/sci none` wrote an empty filter to mean off, and 1.7.0 reads that same file
as search mode without changing it. `/sci search` writes an empty filter where
1.6.0 wrote the Core list. An empty filter cannot carry pi config overrides
(`!x`, `+x`, `-x`; see "The empty-array footgun" below), so `/sci search` drops
them, and its report names each one: "Dropped pi config overrides: !polars.
Re-add them with pi config if you want them back." The way back to Core is the
picker: `/sci profiles`, tick Core, press Enter.

`test-extension.mjs` starts from four settings files: three 1.6.0 states (Core
accepted; offer declined, which leaves only the install entry; `/sci none`) and
one with a pi config override added (Core plus `!polars`). It checks that
startup leaves each byte-identical, and that the round trip (`/sci search`,
then Core through the picker) restores the Core file byte for byte.

To turn `sci_find` and `/sci` off, set `"extensions": []` on the package's
object entry in `settings.json`. This was checked against pi's own resolver in
0.84.3, 0.87.0 and 1.0.0, and the `skills` filter then works as written.

**Design decisions worth not re-deriving:**

- **The tool is registered unconditionally**, with no mode flag. A tool
  definition of about 200 tokens, plus a one-line snippet and one guideline,
  against a ~25k index is not a trade worth a config toggle, and someone
  running all 176 still benefits from looking a skill up by need rather than
  by name. `/sci status` reports the tool as active whatever the filter.
- **Recall beats precision, in a short list.** `sci_find` only has to get the
  right skill into a short list with full descriptions attached; the model
  picks from there. Even a small model discriminates well among a few labelled
  options and badly among 176 in a system prompt. That is why scoring is
  OR-based: requiring every term to match returns nothing for ordinary
  phrasings ("variant calling" matches no single description verbatim).
- **3 hits, then 5.** The first turn that searches after a prompt gets the top
  3 (parallel calls in that turn too); later turns get the top 5
  (`createSearchStage` in `catalog.ts`, fed by pi's `agent_start`,
  `message_start` and `turn_start` events). A user message (the prompt, a
  steer, a follow-up) starts a new first search, and so does a custom message
  that opens an agent run (an extension's `pi.sendMessage` with
  `triggerTurn: true` on an idle agent, which pi sends to the model as a user
  message). A custom message later in a run does not, and neither does a
  retry or compaction that restarts the agent loop (`agent_start` with no new
  message). Profile listings are not searches. The `createSearchStage`
  comment covers each case, including two it still counts wrong.

  The list is short because the result text is most of the prefill of the
  turn after a search: about 850 characters per hit, and 8 hits took about 17
  of the 25 seconds between the search and the read on 2026-09-25. It is 3
  because BM25F's top 3 holds the target at least as often as the old
  ranker's top 8 did: 98.7% against 97.2% of the first queries Bonsai 2 27B
  wrote, 96.4% against 96.3% of Haiku 4.5's
  ([`testing/runs/2026-09-27-find-ranker.md`](testing/runs/2026-09-27-find-ranker.md)).
  There is no `limit` argument: in the same data the models set one in 578 of
  1,341 calls, mostly 10 to 20, which undoes a short list. `/sci find` and
  callers that pass no count get 8, from the same ranker.
- **After a miss, and the live A/B.** When the target is not in the 3, the tool
  description tells the model to search again with other words. One run
  measured the new search against the old
  ([`testing/runs/2026-09-29-openrouter-ab.md`](testing/runs/2026-09-29-openrouter-ab.md)):
  Gemma 4 26B-A4B through OpenRouter, the old search (commit `0a8ddfd`: old
  ranker, up to 8 hits, a `limit` argument) against the new one, over 319
  units (161 probes in two paraphrase styles). The model read the target's
  `SKILL.md` in 244 of 319 with the new search and 225 of 319 with the old
  (+6.0 points, 95% CI 1.0 to 10.9), which met the pre-registered
  non-inferiority test, and the choice turn's prompt tokens fell by a paired
  median of 867.5. After a first list without the target, the model searched
  again and read the target more often with the new search (12 and 10 of 19
  attempts, against 6 and 4 of 17); those counts are small. Most misses never
  searched (64 of 75 new, 74 of 94 old). Limits: one model, an unpinned
  provider, and the paraphrases were development data for the ranker, which
  favours the new search.
- **A compact result format is experimental, behind a flag, and off.** With
  `PI_SCI_FIND_FORMAT=compact`, `sci_find` shows the top 2 hits in full and the
  others with the first sentence of their description only (with 3, then 5
  hits, that is 1 or 3 short ones). `/sci find` and other callers that pass no
  count then get 6 hits instead of 8, because the top 6 held the target in 152
  of 158 searches on 2026-09-25; `sci_find` itself always passes 3 or 5, so
  the 6 never applies to it. Profile listings and no-match results are the
  same in both formats. The first choice-turn replay
  ([`testing/runs/2026-09-27-find-compact-replay.md`](testing/runs/2026-09-27-find-compact-replay.md))
  was inconclusive (target read in 155 of 158 choice turns with `compact` and
  158 of 158 with `full`; the 95% CI of −5.4 to 0.8 points crossed the −5
  margin), and `compact` saved a median 951 prompt tokens. The second sample,
  pooled with the first, was non-inferior
  ([`testing/runs/2026-09-27-find-compact-replay-2.md`](testing/runs/2026-09-27-find-compact-replay-2.md)).
  The flag stays off by decision, with both replays done: the shorter list (3,
  then 5) took its place as the way to cut result tokens.
- **The ranker is BM25F (since 1.7.0).** `sci_find` ranks with BM25F over three
  fields per skill: name, description and SKILL.md body (`extensions/bm25f.ts`).
  A word's weight falls with the number of skills that use it, and the body
  lets a query reach a skill through words its description does not use. The
  settings are fixed; they came from cross-validation on 425 recorded first
  `sci_find` queries. A query equal to a skill name lists that skill first.
  BM25F has its own no-match rule: the best score must reach 2.5, or 28% of
  the most the query could score (35% until the v2.72.0 sync; see
  [`testing/runs/2026-10-05-v2.72.0-sync.md`](testing/runs/2026-10-05-v2.72.0-sync.md)).
  On development data the rule lost none of 1,069 queries. On small
  agent-written sets of requests that no skill covers, BM25F returns hits for
  fewer than the old ranker did, but most of them, given as full text, still
  get hits: the no-match rule reduces such hits without preventing them.

  Before it became the default it passed a choice-turn replay (the model read
  the target in 158 of 158 turns with BM25F lists, against 156 of 158), a
  panel of two query writers (Claude Haiku 4.5 and Bonsai 2 27B), and one run
  on a locked held-out set of 321 requests no setting was chosen on (top 3
  96.6% against the old ranker's top 8, 88.2%). All three, and the
  development figures, are in
  [`testing/runs/2026-09-27-find-ranker.md`](testing/runs/2026-09-27-find-ranker.md).

  Its cost: it has no alias boost, so a query made only of common words can
  miss. "write the methods section of my paper" ranked `scientific-writing`
  11th until the v2.72.0 sync's condensed descriptions moved it to 2nd. The
  index is built on the first call (about 120 ms); later calls take under
  3 ms.

  The old ranker and its `PI_SCI_FIND_RANKER=current` switch shipped through
  1.8.0 and were then removed; the variable is now ignored. The scripts that
  compare against the old ranker run from a checkout of that release
  (`OLD_RANKER_COMMIT` in `scripts/lib/rank-bench.mjs`) and refuse to run
  without it.
- **Never a confident wrong answer.** A query that fails the no-match rule gets
  nothing: a plausible but wrong skill handed to someone designing an
  experiment is worse than no answer. BM25F scores whole tokens and alias
  triggers match whole words. Raw substring matching once scored
  `open-notebook` for "book a flight to paris", the failure this rule exists
  to prevent; `test-search.mjs` keeps that query among those that must return
  nothing.
- **`aliases.ts` entries must come from an observed miss**, never from
  imagination. `pysam`'s description says VCF/BCF but never "variant";
  `esm`'s says ESMFold2 but never "protein structure prediction". Speculative
  aliases make results worse, because each adds terms that dilute real hits,
  and `validate.mjs` hard-fails on any alias naming a skill that no longer
  exists. A rule's `terms` are what reach the ranker. Its `skills` name what
  it exists to help find and get no boost; `test-search.mjs` checks that each
  trigger phrase, searched alone, lists one of them in the top 3, and reports
  the phrases that miss today as known misses.
- **The catalogue is read lazily from disk** (~18ms for 176 files, head 8KB
  each) and cached for the session. A committed generated catalog was
  rejected: to save 18ms, it would duplicate ~65KB of upstream description
  text into `extensions/`, breaching the "everything in `skills/` is
  upstream's" claim this repo keeps checkable.

**Locating our own `skills/` at runtime.** `import.meta.url` survives jiti: a TS
module evaluated through pi's loader sees it rewritten to its own path
(verified against pi's bundled jiti 2.7.0 through `jiti.import`, the loader's
own call). So `join(dirname(fileURLToPath(import.meta.url)), "..", "skills")` is
correct. The result must pass a `SKILL.md` check: if the directory does not
hold skills, the tool is not registered, so the model is never handed paths
that do not exist.

### Startup messaging: the obligation, and where it is enforced

This package writes into a file it does not own. Two rules follow, and
`scripts/test-extension.mjs` exists mainly to hold them:

1. **A new user gets an offer and nothing more.** The first-run dialog has a
   recommended answer; escape, timeout (20s) and decline all write nothing. The
   answer is recorded before acting, so the question is asked once either way.
2. **An existing user gets a notice and no question.** Their `settings.json` is
   byte-identical before and after an upgrade. The tests assert that directly,
   because nothing weaker proves it.

Four details that are easy to get wrong:

- **Gate the dialog on `ctx.mode === "tui"`, not `ctx.hasUI`.** `hasUI` is true in
  RPC too, so gating on it hands a scripted client a modal with nobody to answer.
  At `session_start`, `ctx.mode` is already set, no longer its `"print"` default:
  pi's `AgentSession.bindExtensions` stores the mode and applies it to the
  runner (`_applyExtensionBindings`) before it emits `session_start` (checked in
  pi 0.84.2 and 1.0.0).
- **Report through `report()`, not `ctx.ui.notify`.** `notify` is a documented
  no-op with no UI bound, so a `pi -p` user would be informed into the void and
  then marked as told. `report()` falls back to stderr. For the same reason the
  `session_start` handler is not gated on `ctx.hasUI`.
- **`pi.sendUserMessage` needs `expandPromptTemplates: true` to run a command.**
  pi's `AgentSession.sendUserMessage` defaults that flag to `false`, while
  `AgentSession.prompt` defaults it to `true` and dispatches extension commands
  only when it is set (pi 0.84.3; unchanged in 1.0.0). Without the flag,
  accepting the offer sends the literal string `/sci search` to the model as a
  user message: the user says yes, no filter is written, and a turn is spent on
  nothing. The accept path goes through the command at all because only a
  command context can reload: `ExtensionRunner.emit` hands `session_start`
  handlers the plain `createContext()`, which has no `reload()`, and only
  `ExtensionRunner.createCommandContext` adds one. The test asserts the
  **options** passed to `sendUserMessage` as well as the text: a text-only
  assertion passes either way, which is how this bug slipped through once.
- **Someone who hand-filtered the package gets a notice too.** They are offered
  nothing, since they already answered that question. But `sci_find` reaches the
  skills their filter excludes, and shipping that without saying so would change
  what they chose behind their back. A filter was never a boundary (the model
  could always `read` any `SKILL.md`), which is why it has to be said out loud.

### `/skill:<name>` under a filter: the stopgap, and what it does not cover (1.4.0)

**The defect.** pi never validates a `/skill:` name (pi 0.84.3; unchanged in
1.0.0). `AgentSession._expandSkillCommand` looks the name up in
`resourceLoader.getSkills().skills` and on a miss returns the input unchanged
("Unknown skill, pass through"). Its `emitError` path runs only when a skill was
found and reading its file failed. A filtered skill takes the miss branch
because the filter removes it from the registry entirely:
`DefaultPackageManager.applyPackageFilter` marks the file `enabled: false`,
`resource-loader.js` keeps only enabled resources, and `getSkills()` has no
entry. The model then receives the user message `"/skill:pysam"` and usually
answers as if the skill had loaded.

Two bounds on that:

- **Search was never affected.** `sci_find` returns `SKILL.md` paths for the
  model to `read`; nothing on the model's path goes through `/skill:`. The
  defect affects one thing only: a human typing `/skill:<filtered-name>`.
- **The same branch has a second, filter-free instance.** `text.indexOf(" ")`
  splits on the first space, not the first whitespace, so
  `/skill:<loaded-skill>\nrest` also misses on stock pi, with no filter at all.

**Why not the `disable-model-invocation` route.** That pi feature has the wanted
semantics, but it needs all 176 skills loaded, which means giving up the
`settings.json` filter and having `pi config` misreport. The reasoning is
recorded in the mechanism table under "Why it writes settings.json rather than
filtering at runtime".

**The stopgap.** An `input`-event handler in `extensions/index.ts`.
`AgentSession.prompt` runs extension commands, then `emitInput`, then
`_expandSkillCommand`, then `expandPromptTemplate`, and nothing touches the text
in between (pi 0.84.3; 1.0.0 keeps the order and calls `emitInput` through
`AgentSession._runInputHandlers`). pi's `docs/extensions.md` up to 0.87 showed
an "intercept skill commands before expansion" example on this hook. The
handler:

1. stands down for `source === "extension"`: `sendUserMessage` defaults
   `expandPromptTemplates` to false, and the event does not carry that flag,
   so the source is the only readable proxy;
2. parses the command with pi's own split, quirks included (constraint 5);
3. stands down when `pi.getCommands()` lists `skill:<name>` with
   `source: "skill"`. pi builds those entries by mapping `getSkills().skills`
   unfiltered (the `getCommands` function in `AgentSession._bindExtensionCore`),
   the same array `_expandSkillCommand` searches, so the gate is exact. It also
   keeps pi's resolution for a same-named skill from another package;
4. otherwise looks the name up in a **Map built from the `sci_find`
   catalogue**, reads the file, strips frontmatter with pi's own exported
   `stripFrontmatter`, and returns pi's wrapper verbatim as a `transform`.

The output starts with `<`, so both downstream expanders no-op on their
first-character guard and nothing is expanded twice. A throw is swallowed and
the text passes through, as it would without the hook.

Five constraints the handler must keep, each pinned by a test:

1. **Name resolution is a Map lookup, never a path join.** `join(SKILLS_DIR,
   name, "SKILL.md")` turns `/skill:../../../../home/user/.ssh/id_rsa` into an
   arbitrary file read whose contents land in the user turn. The catalogue
   lists real directory entries, so there is nothing to escape.
2. **`stripFrontmatter` is resolved lazily, not statically imported.**
   `peerDependencies` pins no floor. On a pi build without the export, a static
   named import fails at module link and takes `/sci` and `sci_find` down with
   it; a lazy import falls back to pi's existing behaviour. If anyone converts
   it to a static import, add a version floor.
3. **`extensions/frontmatter.ts` is not reused.** It returns fields only,
   computes no body, and its `m`-flag regex can match a `---` in mid-document.
4. **The gate is `pi.getCommands()`, not a regex over the system prompt.**
   The `<available_skills>` block drops `disableModelInvocation` skills and is
   left out entirely unless `read` or `bash` is active. It is a lossy projection
   that misfires in the case the fix is for.
5. **pi's parsing quirks are reproduced, including the multi-line miss.**
   Repairing it here would make a filtered skill behave differently from an
   active one, the opposite of the goal.

**Verified live.** With the packed 1.4.0 tarball
installed into a throwaway agent dir filtered to `["scanpy"]`,
`pi --mode json -p "/skill:pysam …"` delivered pi's `<skill name="pysam" …>`
block to the model, and `/skill:scanpy` (loaded) still went through pi's own
expansion. `settings.json` was untouched. pi blocks on an open, non-TTY stdin in
`-p` mode, so a scripted run needs `</dev/null`.

**Byte fidelity is tested.** `scripts/test-skill-expand.mjs` borrows
`AgentSession.prototype._expandSkillCommand` onto a fake `this` holding pi's own
`loadSkillsFromDir` output and compares its result with the handler's for every
skill in three argument forms (see "Testing it"). It is circular on one axis:
both sides read the same `skills/`, so it proves string fidelity, not that pi's
package manager resolves the same path for an installed copy. `validate.mjs`
guards the content the handler depends on and a sync could break. It hard-fails
when a frontmatter `name` differs from its directory name (the handler keys on
the directory; pi uses `frontmatter.name || dirname`) or when a body contains
`<skill ` or `</skill>` (pi's `parseSkillBlock` is non-greedy and would
truncate), and it reports the `disable-model-invocation` count (0,
informational).

**Residual limits.** The stopgap narrows the defect without closing it. This
list is the disclosure. The README and `/sci status` say what works (type the
name at the prompt); the paths that still forward literal text are written down
here, where someone who finds a literal `/skill:` in a transcript will look.

1. **On pi 0.84 and 0.85, `steer()` and `followUp()` bypass the hook.** In
   0.84.3, `AgentSession.steer` and `AgentSession.followUp` call
   `_expandSkillCommand` directly with no `emitInput`. Their callers are
   `InteractiveMode.flushCompactionQueue` (on the retry branch every queued
   message bypasses; on the normal branch the first goes through `prompt()` and
   the rest bypass) and, unconditionally, the RPC `steer` and `follow_up`
   commands (`handleCommand` in `runRpcMode`). So on those versions a
   `/skill:<filtered>` typed while compaction is running, or sent as an RPC
   steer, still forwards literal text, and the input hook cannot close that.
   pi's changelog lists the RPC fix in 0.86.0 (0.86 code not checked). On pi
   0.87.0 (code) and 1.0.0 (code and an RPC run) every queued path runs the hook
   (`AgentSession._queueUserInput` runs the input handlers first), and the
   filtered skill reaches the model expanded.
2. **No autocomplete.** `InteractiveMode.createBaseAutocompleteProvider` builds
   the `/skill:` completion list from `getSkills().skills` only. The user types
   the name from `/sci find` output.
3. **Only this package's skills.** The defect is global; another package's
   filtered skills, or a skill disabled through `pi config` in another
   package, still leak literal text. This covers 176 names out of an open set.
4. **The multi-line variant is left alone** on purpose (constraint 5).
5. **Extension-injected `/skill:` is skipped** on `source === "extension"`.
   The proxy is lossy in both directions.
6. **An earlier `input` handler can silently disable this.** `emitInput`
   chains transforms, so an extension that prepends text makes
   `startsWith("/skill:")` false, and a later `{action: "handled"}` discards
   the transform. Package extensions load last, so this one is the most
   exposed.
7. **On any doubt the handler is inert by design**, so a silent no-op is a
   possible failure mode. Do not document it as "always fires".
8. **`location=` is the realpath; pi's is not.** `resolveSkillsDir()` goes
   through `import.meta.url`, which jiti hands back resolved, while pi's
   `mapSkillPath` does a plain `join` with no `realpath`. Observed in a live run
   under a filter on macOS: the hook emitted
   `/private/var/folders/.../skills/pysam/SKILL.md` where pi emits
   `/var/folders/.../skills/scanpy/SKILL.md` for a loaded skill. Both name the
   same file and the model can `read` either, so the difference is cosmetic on a
   symlinked install path and absent on a normal one. It is the one axis
   `test-skill-expand.mjs` cannot see.

**Upstream.** The complete fix is a few lines in pi: `emitError` on the miss,
as the read failure already does. That would make the miss visible on every
path (`prompt`, `steer`, `followUp`, RPC) for every package; it would not make a
filtered-out skill load, which is the filter's job. A patch with a regression
test was prepared against pi 6160683 (0.85.1) and passes pi's `npm run check`.
It is kept out of the tree (`testing/upstream-*`, gitignored) and has not been
filed. Sending it is the maintainer's decision, and pi's contributor gate needs
an issue in the filer's own words plus a maintainer `lgtm` before any PR.
Whitespace splitting is not part of it: pi closed #8413 on that as `no-action`.
Until pi changes, the handler above is the supported behaviour and the limits
above stand.

### The empty-array footgun

pi's `DefaultPackageManager.applyPackageFilter` (`dist/core/package-manager.js`;
checked in pi 0.84.3 and 1.0.0) treats a **literally empty** `skills` array as
"disable all". A non-empty array containing only override patterns (`!x`, `+x`,
`-x`) instead falls through to `applyPatterns` in the same file, which starts
from **all** paths when there are no plain includes. So carrying a user's
`!pattern` overrides into a "disable all" would invert it into "enable all"
while reporting ~0 tokens. `applyPlanToEntry` therefore writes `[]` in that one
case and keeps overrides everywhere else. Do not "fix" this without re-reading
both functions.

### Why the picker is a custom component

`ctx.ui.select` builds a fresh selector on every call
(`ExtensionSelectorComponent` in pi's interactive mode) with `selectedIndex` 0,
and `ExtensionUIDialogOptions` carries only `signal` and `timeout`: there is no
initial-index option. A picker built from repeated `select()` calls therefore
resets the cursor to the top after every toggle, which makes ticking two
adjacent profiles needlessly slow.

So the picker renders through `ctx.ui.custom`: a focused component that owns
its cursor and checkbox state (`createProfileList`). Space toggles, arrows move,
enter applies, esc cancels, `a`/`n` select all/none. Plain characters are safe
to bind: pi-tui's `SelectList.handleInput` handles only up/down/confirm/cancel
and ignores everything else.

Two fallback conditions matter:

- `ui.custom` may be **absent** on older pi builds.
- RPC mode **defines it but returns `undefined` without rendering** (the
  `custom()` method of the UI context that `runRpcMode` builds in pi's
  `dist/modes/rpc/rpc-mode.js`).

In both cases `choose()` falls back to the original `select()` loop
(`chooseViaSelect`). That is why the picker always returns an object,
`{action, selected}`, even on cancel: an `undefined` return can then only mean
"unsupported".

A custom component must implement `invalidate()`. pi-tui's `Component` requires
it even when nothing is cached.

### Other constraints encoded in the code

- Config dir comes from pi's own `getAgentDir()`, so `PI_CODING_AGENT_DIR` is honoured.
- Writes are atomic (temp + rename) but resolve symlinks first, so a dotfiles-managed
  `settings.json` is updated in place instead of being replaced with a regular file.
- A `settings.json.lock` directory is taken around read-modify-write, matching
  proper-lockfile's protocol, with stale-lock stealing after 10s.
- Malformed or unreadable settings cause a refusal with an explanation and no write.
- A project `.pi/settings.json` that lists this package wins over the global one, so
  `/sci` refuses and names that file instead of writing a change that would do nothing.
- `scripts/validate.mjs` imports `profiles.ts` and hard-fails if it drifts from
  `skills/`, so an upstream sync that adds or renames a skill cannot silently strand
  it in no profile. It needs Node ≥ 22.18 for TypeScript type stripping.
### Testing it

Pi loads extensions with jiti (`loadExtensionModule` in pi's
`dist/core/extensions/loader.js`), which resolves extensionless relative
imports: `from "./profiles"` is correct, although raw Node ESM rejects it.
`scripts/lib/load-extension.mjs` reproduces that load path (it finds pi on
`PATH`, rebuilds the alias map and imports `jiti/lib/jiti-static.mjs`
directly), so the suites exercise the same module graph pi does. An installed
pi is therefore a hard prerequisite for `npm test`.

`npm test` runs seven things, none of which spend model tokens:

| Script | What it proves |
|---|---|
| `validate.mjs` | All 176 frontmatters parse and have descriptions; `profiles.ts`, `aliases.ts` and `package-info.ts` agree with `skills/` and `package.json`; the synced skills still carry the third-party terms README's License & Credits section names (deepspot-m eligibility, TimesFM 3.0, molfeat, latex-posters GPL, Pathoplexus and others). |
| `test-search.mjs` | `sci_find`'s ranking against the real 176 descriptions, including queries that must return nothing. Known misses are listed and reported without failing. Each alias trigger phrase, searched alone, must list one of its rule's `skills` in the top 3. Floor: bm25f puts the target in the top 3 for at least 98% of the recorded first queries in `testing/find-rank/`. |
| `test-extension.mjs` | Command and startup behaviour against a stubbed `ExtensionAPI`, with `PI_CODING_AGENT_DIR` at a throwaway dir. |
| `test-filter.mjs` | That pi itself honours the filter we write, through a real `DefaultPackageManager`. |
| `test-skill-expand.mjs` | That the `/skill:` block the input hook builds for a filtered-out skill is byte-identical to the one pi builds for a loaded skill, with `AgentSession.prototype._expandSkillCommand` as the oracle, across all 176 skills × 3 argument forms. Also that pi's `parseSkillBlock` reads it back, and that both sides agree on the miss cases. |
| `test-frontmatter.mjs` | That `extensions/frontmatter.ts` parses all 176 SKILL.md files and 13 edge cases the way pi's own parser does. |
| `test-live-lib.mjs` | The live harness's grading helpers, on synthetic pi sessions: the read endpoint, the skill-seeking test, the timeout gate, the context and overflow measures, and how the conversation loop ends an attempt (`reached`, `gated`, `overflow`, `searched` under `first-find`, a provider error as `no-run`). Also the llama-server log parser and its join to pi's messages (`find-live-timing.mjs`); the paired statistics and analysis set (`find-live-arms-report.mjs`); the choice-turn replay helpers and the replay's analysis set and validity rules (`find-live-replay.mjs`); the pooled analysis of two samples with its seeded cluster bootstrap (`find-live-replay-pooled.mjs`); the first-search facts of `find-ab-report.mjs`; and the category and panel-report helpers of `find-panel-report.mjs`. A wrong endpoint, gate, join, interval or analysis set still produces numbers in a live run, so they are checked here. Last, that no provider key reaches the model's side of the sandbox (`scripts/lib/key-proxy.mjs`, `scripts/lib/agent-seed.mjs`). |
| `test-tui-offer.py` | The first-run offer in pi's real TUI, driven through a pty: accepting writes the empty search-mode filter; declining and timing out write nothing. The only check that runs the unstubbed accept path, so the only one that proves pi dispatches the accepted offer as a command and the filter is written (`test-extension.mjs` checks only that `expandPromptTemplates: true` reaches its stub). Spends no tokens, but needs a pty, so it is not in `npm test`. |
| `doc-count.mjs` | Not a suite: the five suites built on `scripts/lib/harness.mjs` call it last, so the README's check count for each of them cannot silently go stale. |
| `try-it.sh` | Not a test: a sandbox. Packs the tarball, seeds a throwaway `PI_CODING_AGENT_DIR` for one of five startup scenarios, and opens pi. It never touches `~/.pi/agent`, deletes the credential copy on any exit, and reports afterwards whether `settings.json` changed. `--check` asserts the scenario's message headlessly instead of opening the TUI. |

`npm run typecheck` (`scripts/typecheck.mjs`) runs real `tsc` on
`extensions/*.ts`, with pi's own shipped `.d.ts` files as the types for
`@earendil-works/pi-coding-agent` and `typebox`: the declarations an installed
pi exposes, which a hand-written stub could drift from. Node's loader strips
TypeScript syntax without checking it, so a call like
`ctx.ui.select(..., { timeout })` with one argument too many for the local
`UiContext` interface loads and runs; only `tsc` catches it.

The script writes a generated tsconfig to a `mkdtempSync` directory and
removes it afterwards. `findPiDist()` locates pi, and `typeRoots` pins
`@types/node` to pi's own copy so a stray `~/node_modules/@types/node` is never
used instead. TypeScript is not a dependency (there is no lockfile or
`node_modules` to put it in), so the script runs
`npx --yes -p typescript@5 tsc`, which downloads it into npm's cache on first
run. That download is why typecheck has its own script and its own CI step,
outside `npm test`.

Three things are worth knowing before changing these:

- `resolve()` returns all resources with an `enabled` flag, so `.length` does
  not change when a filter applies. Count `resolve().skills.filter(s => s.enabled)`,
  or the test proves nothing.
- `getAgentDir()` (pi's `dist/config.js`) reads `PI_CODING_AGENT_DIR` on every
  call, so one test process can point successive cases at different throwaway
  dirs.
- Since pi 0.84.x the `pi` binary is `dist/bundle/cli.js`, a single-file build
  with no `core/` beside it. `findPiDist()` steps up to the unbundled `dist/`
  when that is where `core/` lives; without that step, every suite that imports
  `core/*.js` by path fails with `ERR_MODULE_NOT_FOUND`. `PI_DIST` overrides it.

`scripts/test-find-live.mjs` is the release gate. It spends tokens, so it is
not in `npm test`. It installs the packed tarball into a throwaway agent dir in
search mode (no skill in the prompt), asks a small model three questions whose
skills are not loaded, and checks the transcript for a `sci_find` call. If a
weak model does not reach for the tool, fix the tool description and
`aliases.ts`, and leave the test alone.

The throwaway dir never gets `auth.json`, because the model can read anything
there (Gemma 4 26B-A4B listed `../agent/auth.json` with `ls -R ..` on
2026-09-29). For a cloud model the harness reads the API key itself (from
`auth.json`, else `<PROVIDER>_API_KEY`) and holds it in a proxy on 127.0.0.1
(`scripts/lib/key-proxy.mjs`). The throwaway `models.json` points the provider
at that proxy with a placeholder key, and the proxy swaps in the real key on
the way upstream, in the auth header only: the model can read the placeholder,
and a swap in the path or another header would let it make the upstream echo
the key back. A deny rule for the file or a key in an environment variable
would not work: pi and its bash tool run under one sandbox profile, so a deny
would block pi too, and the bash tool inherits pi's whole environment. The
throwaway dir also gets `models.json`, so a local provider (Ollama, MLX)
resolves, and for a cloud model `models-store.json`, pi's cached model list,
which holds no credentials.

Without a key pi fails every probe with "No API key found". The harness reports
a run in which the model never answered as `no-run`, so it cannot pass for a
model that declined to search.

The model keeps pi's default tools: restricted to `read,sci_find`, it has
little to do but search, which inflates the score. Some probe tasks invite real
action ("review my screen activity"), and with bash a model will try: an
unsandboxed run once searched the whole home directory. So every pi run happens
under a macOS `sandbox-exec` profile (`scripts/lib/sandbox.mjs`):

- writes only inside that attempt's own directory (its agent-dir copy, a fake
  `HOME`, `TMPDIR`, working directory and session file), which it can also
  read;
- no reads under the real home, other volumes or the shared temp dirs (paths
  below), apart from that directory and the staged package, which is
  read-only;
- the network on one loopback port only: the local provider's, or the key
  proxy's for a cloud provider.

pi gets an allowlisted environment with no API keys, because the model can run
`printenv` and the caller's environment carries tokens and paths into the real
home. That environment sets `MPLBACKEND=Agg`: the profile does not fence the
window server, and with matplotlib's macOS backend a model's `plt.show()`
opened windows on the user's screen and blocked until someone closed them
(2026-09-29).

The profile also denies programs that act through another process, outside the
sandbox: `launchctl` (launchd starts a loaded job unsandboxed), `open`,
`osascript`, `automator` and `shortcuts`. It blocks Apple events too. A model
asked for "a recurring check" tried `launchctl load` (parallel-web,
2026-09-23).

Limits that remain: the model can reach its own inference server on the
allowed port (one model sent itself chat completions with `curl`); through the
key proxy that bills the key but does not show it. It can also see host process
names (`pgrep`, `lsof`). Transcripts are written outside the sandbox, so no
attempt can read another's. `--no-sandbox` turns the profile off.

The harness starts a bare `pi`, which under the profile is the first `pi` on
`PATH` that the sandbox can read. Reads are denied under `/Users`, `/Volumes`,
`/private/tmp` and `/private/var/folders`, so a pi installed there and put
first on `PATH` is passed over with no warning and the next `pi` runs (the
1.7.0 gate's first pass ran pi 0.84.3 this way). To test another pi version,
install it outside those paths (for example under `/private/var/tmp`) and check
`command -v pi; pi --version` inside a profile first.

With `--probes testing/find-probes.json` it runs one supervised probe per skill
instead of the three built-in ones (`scripts/lib/converse.mjs`): 162
first-person tasks that never name their skill, each with a `target` and an
optional `accept` list of siblings that also fit.

A probe is up to `--attempts` (3) fresh conversations of up to `--responses`
(5) model responses. Between responses a blind persona
(`scripts/lib/supervisor.mjs`; by default `claude-opus-5-5` at low effort via
the `claude` CLI) plays the scientist: it answers follow-up questions and ends
the conversation when the request is answered. It sees only the task and the
assistant's visible text, never the target, the tool calls or `sci_find`
output. Persona replies that name a skill the assistant never said, or nudge
toward search, are flagged for review.

The target *reaches* the model when a `sci_find` result lists it, a bash
command's output points at it, or a file inside it is read. A result naming
more than 20 skills is a catalogue dump and counts for none. An attempt that
ends without a reach is wiped and the probe starts again. Grade: reached in
attempt 1 = `success`, 2 = `partial-success`, 3 = `functional`, never = `fail`,
reported for the target alone and for target-or-accepted. The harness polls the
session while the model works and stops the response the moment the target is
reached (`stoppedEarly`), since nothing after that changes the grade.

A response past `--timeout` ends its attempt, and the attempt counts. The limit
is a budget per response, and a slow local model can spend it on real work, so
a timeout does not mean the model was stuck. Each timeout is therefore flagged,
and the summary counts the grades a timeout touched, so a too-short limit shows
up. `no-run` and `supervisor-error`
are harness failures and never a grade.

`--results` appends one JSON line per probe as it finishes, and `--resume`
skips probes already graded with the same task text (harness failures run
again), so a long local-model batch survives a restart. `--offline` spends
nothing: it ranks each task's full text through `sci_find`'s own search, to
tell a vague probe or a search gap apart from a model that did not search.

`--prompt-skills none` (the default) empties the skills filter, as `/sci search`
has done since 1.7.0: no skill is listed in the system prompt and `sci_find` is the
only way in. `core` lists the Core profile, what `/sci search` wrote before
1.7.0; there a listed skill can stand in for a search. `all` sets no filter: every
skill is listed, as in a normal install. Each result line records which one
ran; a line from before the option existed counts as `core`.

Options for comparing configurations, as in the 2026-09-25 three-arm run
([`testing/runs/2026-09-25-night-arms.md`](testing/runs/2026-09-25-night-arms.md)):

- `--no-extension` writes `extensions: []` into the package entry: pi loads the
  skills but not the extension, so there is no `sci_find`, no `/sci` and no
  input hook. (`--exclude-tools sci_find` would leave the hook running.)
- `--package-dir <dir>` packs another package tree (an older release from
  `git archive`), and `--package-label` records it on every line.
- `--endpoint read` moves the endpoint from "listed" to "read": the model read
  the target's SKILL.md with `read`, or printed it with bash (the command names
  `<target>/SKILL.md` and the output holds its `name:` line). With every skill
  in the prompt a listing proves nothing, so `--prompt-skills all` requires
  it. The first listing is still recorded (`listed`, `listedSeconds`).
- `--gate-calls <n>` ends an attempt as `gated`, a miss, once its first n tool
  calls hold no skill-seeking call (`sci_find`, or a `read` or bash call that
  touches a SKILL.md or a `/skills/` path segment). It is off by default. A
  replay of the 2026-09-23 sessions backs n = 10: it lost no reach and ended
  12 of 28 misses early ("Evidence for the gate" in the run record above).
- `--warmup` sends one ungraded request first, so the cold prefill of a large
  system prompt does not count against the first probe (llama.cpp keeps the
  prefix; pi's skills block comes before the working-directory line).
- `--archive-to <dir>` copies the transcripts and a tarball of the workspaces
  out of the temporary directory at the end.
- `--endpoint first-find` has no target: the attempt stops at the model's
  first `sci_find` call and ends as `searched`, with the query in `queries[0]`.
  It measures which query a model writes and how often it searches (with
  `--gate-calls`, an attempt with no search in its first n calls ends as
  `gated`). It needs `--attempts 1` and the extension. The queries are ranked
  offline.
- `--find-ranker <current|bm25f>` sets `PI_SCI_FIND_RANKER` for pi and is
  recorded on every line. The default is `bm25f`, the package default since
  1.7.0. A package older than 5123f67 has no bm25f and runs `current`: pass
  `current` for it, so the lines record what ran. A package after 1.8.0 has
  bm25f only, so `current` needs `--package-dir`.
- `--models-json <file>` seeds the throwaway agent dir with that models.json
  instead of the real one (a provider on another port, say); the real agent
  dir is not written.
- `scripts/find-probes-styled.mjs <synonym|plain|expert>` writes a probe file
  whose tasks are one paraphrase style from `testing/find-rank/`.
- The harness refuses a probe whose task names its own skill (the name, or
  the name with its hyphens as spaces or removed). It matches whole words
  only, so "Shapley" in the expert paraphrase for `shap` passes.

`scripts/find-panel.sh --out <dir> --writer <label> --model <id>` runs one
query writer over one or more styles (`--styles plain,synonym,expert`, or
`original`) with `--endpoint first-find --attempts 1`. At the first start it
`git archive`s `--ref` into `<dir>/src/` and runs from there; running it again
with the same `--out` continues (`--resume`). A local writer needs
`--health-url`, checked before each style. Each invocation archives into its
own time-stamped folder. Report with the frozen copy,
`<dir>/src/scripts/find-panel-report.mjs <dir>...`, so the rankers match the
run. It reads `results-<writer>-<style>.jsonl` and gives the search rate by
outcome, then whether the first query of the first `sci_find` message puts the
target in the top 8, paired bm25f − current (Newcombe method 10, McNemar
exact) per writer and style. Pooled rows repeat each target once per style, so
they add a cluster bootstrap by target. A writer counts toward a rule only
with at least 50 searched attempts (30 in the plain style for the 4b rule of
`testing/runs/2026-09-27-find-ranker.md`). Secondary rows rank the union of
that message's queries and the raw request text.

Every attempt also records the first request's prompt size (pi usage:
input + cacheRead + cacheWrite), peak context, output tokens, tool calls, the
index of the first skill-seeking call, pi's `compaction` entries and provider
overflow errors. A response that ends on an overflow pi could not recover from
ends its attempt as `overflow`. A response that ends on any other provider
error (the server died, an HTTP 500) is a harness error, `no-run`, and gets no
grade, so a dying server cannot turn probes into fails; `--resume` runs it
again.

`scripts/find-live-arms.sh` runs several arms unattended. At the start it
`git archive`s the two commits (`--ref` and `--v16-ref`) into `<out>/src/` and
runs only from there, so an edit to the working tree cannot change an arm
mid-run. It starts the model server from a script you pass, checks it before
each invocation and restarts it once if it died, stops after three harness
errors in a row, and runs under `caffeinate`. Probes run in chunks (Core
first, then a seeded shuffle). Each chunk runs every arm, with the order
rotated per chunk, so a run stopped at a chunk boundary is still balanced and
paired. `--stop-after HH:MM` starts no chunk after that time; the same `--out`
continues on a later night.

`scripts/find-live-timing.mjs <out>` splits each attempt's time by the
server. It pairs every finished request in `llama-server.log` with the pi
message it produced (pi's `usage.input` is the prompt tokens llama.cpp
processed, `usage.output` the tokens it generated) and fits the clock offset
from the pairs. Per attempt and warm-up it gives prefill and generation
seconds, tokens processed and cached, and the **queue wait**: the time from
pi's request to the server starting it. The queue wait matters because a stop
(reach or gate) kills pi, but llama.cpp first finishes the prefill of the
cancelled request: about 11 s (`v16`) to 17 s (`full`) on 2026-09-25. The
next attempt's first request waits for it, inside its recorded time to read,
which biases that time by arm. `endpointSecondsNet` is the time to read
without that wait. A stop can also slow the next request's prefill, by an
amount that differs by arm (most in `full`, not at all in `v17` on
2026-09-25); that slowdown stays inside the net time, and `firstAfterStop`
marks the attempts it can touch (figures in
`testing/runs/2026-09-25-night-arms.md`). The script also prints prefill and
generation tok/s by prompt size per arm, without warm-ups and requests right
after a stop. It needs the archived session files: an invocation stopped by a
signal archives nothing, so its attempts are not timed.

`scripts/find-live-arms-report.mjs <out> [--timing <jsonl>]` gives the
pre-registered outcomes. The analysis set is the chunks in which every probe
has a results line in every arm, less any probe with a harness error in any
arm (an intersection of finished probes would let a part-done chunk in). Per
arm it gives the read rate (Core and non-Core apart), how attempts ended, the
context and output medians, compactions and overflow errors. For `v17 − v16`
(non-inferiority at −5 points) and `v17 − full` it gives the paired
difference (Newcombe method 10, McNemar exact) for all probes, Core, non-Core
and without probe-invalid probes; the discordant probes with how the miss
ended; and the paired time to read on probes read in both arms. With
`--timing` (the `--jsonl` output of `find-live-timing.mjs`) it adds the
server-exact and queue-net times, labelled post hoc.

`scripts/find-ab.sh --out <dir> --models-json <file>` compares two package
commits (`--old-ref`, default 0a8ddfd, the last commit before the 3-then-5
search; `--new-ref`, default HEAD) through a cloud model (default Gemma 4
26B-A4B on OpenRouter). It `git archive`s both into `<dir>/src/` and runs the
harness and probes from `src/new`. The probes are paraphrase styles
(`--styles plain,expert`). Each chunk of probe ids starts every arm × style
invocation at the same moment, so both arms of a probe meet the same provider
routing and load. A second pass retries the chunks with a harness error; the
same `--out` continues. `scripts/find-ab-report.mjs <dir>` gives the
read-rate difference new − old pooled over styles (Newcombe method 10, and a
bootstrap over probes, since the styles of one probe share a target), then
per style, among attempts that searched in both arms, and without provider
errors or timeouts. Per arm it gives the search rate, `sci_find` calls and
the `limit` the model set, and, from the archived session files, the first
result's hits and characters, whether it listed the target, and the prompt
tokens of the choice turn (the request after the first result).

`scripts/find-live-replay.mjs <run-dir> --out <dir>` replays the choice turn
of a finished run: the model response after the first `sci_find` result. It
cuts each recorded session after that result and writes two copies: the
recorded text (`full`) and the same hits rendered in the compact format
(`compact`). A parser gate first renders each recorded hit list again in
the full format and requires a byte-identical match. For each copy,
`scripts/lib/replay-worker.mjs` runs in a child process with its own `HOME`
and agent dir (so nothing from the real home reaches pi's system prompt),
opens the session with pi's SDK (`SessionManager.open`), and continues the
agent for one turn. Every tool is a stub that throws, and the turn stops at
the first assistant message (`--prove-stub` lets it reach `turn_end` to show
the stub ran). The runner needs the model server: it checks `/health` from
`models.json` and does not start it. `--dry-run` prepares every probe
without it and prints the target's rank, the recorded choices and the text
sizes. `full` replays record prompt-token parity with the recorded request.

`scripts/find-live-replay-report.mjs <out>` gives the pre-registered
outcomes. The analysis set needs both variants ok, parity, and the same
system prompt and tool hashes within a probe (the system prompt holds the
recorded working directory, so it differs across probes). A validity line
compares the `full` replay with the recorded choice before any comparison of
the formats. A second sample comes from replaying with `--flip-order`, which
starts each probe with the other variant.
`scripts/find-live-replay-pooled.mjs <sample-1> <sample-2>` pools two
samples: validity per sample, then `compact` − `full` over the (probe,
sample) pairs with two intervals (Newcombe method 10, and a cluster bootstrap
over probes with a fixed seed). A verdict counts only when both intervals
give it.

`--variants full,bm25f` replaces `compact` with `bm25f`: each `sci_find` call
of the choice turn runs again through the extension's own `runToolSearch`
under `PI_SCI_FIND_RANKER=bm25f`, in the full format, with the recorded
package's paths. `find-live-replay-report.mjs --variant bm25f` reports
`bm25f` − `full`. Whatever the variants, each recorded `sci_find` call must
first reproduce its result byte for byte under the current ranker, or the
probe is an error, so the replay runs only from a checkout of 1.8.0 or
earlier, which still has that ranker; elsewhere it refuses to start.

Two lines of the supervised `test-find-live.mjs` summary show recovery: the
response in which the target was reached, and every attempt split by when it
first called `sci_find` (response 1, later, never) with how many of each
reached the target. A late first search that still reaches is recovery inside
a conversation; a grade below `success` is recovery by a fresh attempt.

A fail can mean the probe is wrong: the model answered the request well
without the skill. `scripts/lib/probe-check.mjs` checks each graded probe,
whatever its final grade, in which the persona ended an attempt satisfied
before any wanted skill reached the model. A judge (`--judge-model`, default
`claude-fable-5-1`, via the `claude` CLI) sees the task, the target's
SKILL.md and that attempt's conversation, and answers two questions:

- (a) did the first request go unserved while the target could have served
  it in the sandbox (drift the model caused)?
- (b) would the target have materially improved the model's answer?

Being on topic is not enough: a yes must name the concrete gap the target
fills, and an unnamed benefit counts as no. When every judged attempt is no
on both, the line gets `probeCheck.invalid`. It keeps its raw grade, but the
summary counts it as `probe-invalid`, leaves it out of the grades and the
recovery lines, and lists it with the judge's reason as a probe to rewrite.
A probe reached in its first attempt is never audited, so a probe that did
not need its skill but was reached at once keeps its success. The summary
therefore also prints the raw target line, with each probe-invalid at its
raw grade, and a report quotes both. A judge failure is `check-error`: the
grade stands and the run goes on.

`scripts/check-probes.mjs <results.jsonl> --transcripts <dir> -o <file>`
runs the check again on a finished run from its kept transcripts (for a run
made before the check or its current rule, or with another judge), and
writes the latest line per probe with a fresh `probeCheck`.

Rewrites must make the skill necessary and must not name it. Probes the
model failed where the skill was needed are never rewritten, so the score
cannot drift upward through prompt edits. Each line records its `task` text:
`--resume` and the summary count a line only for the probe's current
wording, so a rewritten probe runs fresh. A probe with `untestable` set (a
skill that runs only on local state the sandbox cannot supply) loads but
never runs. Each run names it at the start, and `--only` refuses it.
`testing/README.md` records the criterion and each case.
## Port process (how a new upstream version lands)

1. `npm run sync:upstream` fetches upstream and replaces `skills/` wholesale.
   With no argument it takes the latest release tag, or `main` when upstream
   has no tags.
2. Read the sync script's `::warning::` output. After syncing a tag, the script
   fetches upstream `main` and warns when `main` has moved past that tag. If it
   has, decide whether to sync the tag as it is or a specific commit on `main`
   (`bash scripts/sync-upstream.sh <40-hex-sha>`). Whichever ref is named,
   `package.json`'s `upstreamCommit` records the commit taken.
3. `npm run validate` checks every `SKILL.md` against pi's validation rules
   (below). Warnings are acceptable, since pi still loads those skills. A
   missing description is not: pi refuses to load that skill.
4. Spot-check with pi: run `pi -e .` with a `-p` prompt asking the model to
   list the available skills, and check a few names (e.g. `scanpy`,
   `pathogen-variant-surveillance`).
5. Bump `version` in `package.json` and `PACKAGE_VERSION` in
   `extensions/package-info.ts` to match: minor for a new upstream snapshot,
   patch for an extension-only fix. `scripts/validate.mjs` fails if the two
   disagree. `upstreamVersion`, `upstreamCommit` and `licenseSha256` were
   already written by `scripts/sync-upstream.sh` in step 1. Never copy
   upstream's number into `version` (Provenance explains why). Update the
   upstream-version mentions in README.
6. Add the release to `RELEASES` in `extensions/index.ts`, with a `snapshot`
   naming the new `upstreamVersion` and what it adds. Both startup notices
   read that table: the upgrade notice and the notice for a hand-written
   filter. `scripts/test-extension.mjs` fails until the newest snapshot there
   is `package.json`'s `upstreamVersion`.
7. Commit, push, `npm publish`, confirm with `npm view pi-scientific-skills version`,
   then tag `v<version>` (our version, e.g. `v1.1.0`) and push the tag.
   Publish before tagging, so a failed publish cannot leave a tag that no
   registry version matches.

## Validation rules (pi)

Per `docs/skills.md` in the pi docs, pi validates skills against the Agent
Skills standard. It warns on most violations and still loads the skill:

| Rule | Enforced? |
|------|-----------|
| `name` present, ≤64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens | warning |
| `description` present | **hard: skill not loaded if missing** |
| `description` ≤1024 chars | warning |
| unknown frontmatter fields | ignored |

Pi does not require the name to match its parent directory. `validate.mjs`
does, for the `/skill:` stopgap (see below).

## Sync script details

`scripts/sync-upstream.sh [tag|main|<40-hex-commit-sha>]`:

- Resolves the ref: the argument if given, else the latest upstream tag by
  semver, else `main`.
- Fetches that ref from upstream into a temp dir. A tag or `main` gets a
  shallow `git clone --depth 1 --branch`. A shallow clone by branch cannot
  take a raw 40-hex commit SHA, so for a SHA the script runs `git init` +
  `git remote add` + `git fetch --depth 1 origin <sha>` +
  `git checkout -q FETCH_HEAD`.
- Aborts before touching `skills/` if the checkout has no `skills/` directory,
  or holds fewer than half as many skills as the current tree. A malformed
  ref, an interrupted clone or an upstream layout change must not trigger an
  `rm -rf` of the real tree.
- Reads `scripts/excluded-skills.txt` (one name per line; `#` comment lines and
  blanks ignored); today it lists `docx`, `pdf`, `pptx`, `xlsx` and `fictiv`,
  and Provenance gives the reasons. Those names are dropped from the upstream
  skill list before the added/removed comparison, so they never show up as
  removed.
- Replaces `skills/` wholesale (`rm -rf` then copy), then deletes the excluded
  skills from the copy.
- Copies `LICENSE.md` byte-identical from the upstream checkout and records its
  sha256 in `package.json` as `licenseSha256`. `validate.mjs` hard-fails if the
  two ever disagree.
- Writes `upstreamVersion` and `upstreamCommit` into `package.json`.
  `upstreamVersion` is the tag the snapshot belongs to; for a raw SHA it is the
  newest tag in the live tag list. `upstreamCommit` is the 40-hex SHA actually
  cloned (`git rev-parse HEAD`). A `node -e` one-liner does the write: it
  reads the file, spreads it, and writes it back with two-space indent and a
  trailing newline. Never `sed -i`, which cannot round-trip JSON safely.
- When the ref is a tag (not `main` or a raw SHA), also fetches `main` to
  depth 50 and warns if `main` is ahead; it never acts on it. The warning gives
  the commit count and lists the commits with `git log --oneline`. At the edge
  of that shallow window it says "at least 50 commits ahead", and a failed
  fetch of `main` gets its own warning instead of a guessed distance. A tag can
  lag `main` without a version bump (upstream `main` once sat 9 commits past
  `v2.69.0` with `plugin.json` still at `2.69.0`), and a tag-based sync then
  silently misses what is on `main`.
- Prints how many skills were added and removed (by directory name) and lists
  them, for the changelog.
- Does not commit or bump `package.json`'s own `version`. It prints those as
  next steps, with a reminder to check any drift warning before deciding
  between the tag as it is and a SHA on `main`.

## Validation script details

`scripts/validate.mjs` (no dependencies, Node ≥ 22.18):

- Walks `skills/*/SKILL.md`.
- Parses YAML frontmatter with a line-based parser covering the constructs this
  collection uses: plain scalars, quoted scalars, and block scalars (`>`/`|`
  with chomping and indent indicators). Nested mappings (`metadata:`) are
  consumed and skipped; none are validated. The fence-finding step copies pi's
  own algorithm (BOM strip, newline normalization, fence required at offset 0)
  instead of a permissive regex. `scripts/test-frontmatter.mjs` checks the
  parser field by field against pi's real one.
- Reports violations of the table above. It exits non-zero when a skill has no
  frontmatter or no `description` (pi would refuse to load it), when a
  frontmatter `name` differs from its directory or a body contains a `<skill>`
  tag (both break the `/skill:` stopgap; see "`/skill:<name>` under a
  filter"), or when `extensions/profiles.ts` disagrees with `skills/`.
- Checks `extensions/aliases.ts`: every alias `skills` entry must name a real
  skill directory, no trigger phrase may be listed twice, every rule must add
  search terms (only `terms` reach the ranker), and a trigger with fewer than
  five letters and digits must be in `SHORT_TRIGGER_ALLOWLIST`.
- Hard-fails when `extensions/package-info.ts` disagrees with `package.json`. A
  stale `PACKAGE_VERSION` would silently suppress the upgrade notice, the one
  promise a release makes, for every user.
- Hard-fails when `package.json`'s `upstreamCommit` is not a 40-hex-char
  commit SHA, when its `licenseSha256` disagrees with `LICENSE.md`'s actual
  hash, or when any name in `scripts/excluded-skills.txt` exists as a
  directory under `skills/`. The sync script's `rm -rf` is not the only way
  skills land there: a manual `cp` from an upstream checkout bypasses it.
- Hard-fails when README.md's own prose numbers disagree with reality: every
  "N skills" claim (except "N skills have been run") against the real
  catalogue size, and "N skills have been run" against the unique `PASS`
  count in `testing/ledger.json`. Neither number is hardcoded; both come from
  the files the suites already trust.
- Hard-fails when a synced skill loses a third-party notice that README's
  License & Credits section names (`REQUIRED_NOTICES`).
- Warns when `TOKENS_PER_SKILL` drifts more than 10% from what `skills/` now
  measures. It stays a constant because the picker needs a cost synchronously,
  before anything is on disk to measure. Every `/sci` figure derives from it,
  so unnoticed drift would make them all confidently wrong. It warns instead
  of failing because the number is an estimate by construction.
  The measurement prefers a real tiktoken count via `python3` (`cl100k_base`,
  with the corpus fed in on a file descriptor, never in `argv`) and falls back
  to the calibrated `CHARS_PER_TOKEN` ratio when `python3` or `tiktoken` is
  unavailable or times out. Either way it prints which mode ran.

The parser is not defined in `validate.mjs`. It lives in
`extensions/frontmatter.ts` and is shared with `search.ts`, which parses the
same files at runtime to build the `sci_find` catalogue. Two copies would drift
invisibly: validation would pass on files the runtime read differently.
Importing it here also exercises it against all 176 real files on every
release.

Some skills (`bids`, `onekgpd`, `pyzotero`) write `description: >` (or `>-`)
with the text on the following lines. A naive line-based parser records the
`>` indicator itself as the value, so a skill with an empty block body would
show a non-empty description, pass the presence check and ship, although pi
would refuse to load it. That is the hard failure this script exists to catch,
so the parser resolves block bodies.

## Repo hygiene (important when re-syncing)

`skills/` must stay byte-identical to upstream, apart from the excluded skills.
Two by-products of testing routinely break that:

- **`__pycache__/` inside `skills/`.** Running a skill's Python helper compiles
  bytecode next to the source. Bytecode is machine-specific build output,
  never upstream content, and `skills/` is in `package.json`'s `files` list, so
  anything left there is distributed. It is gitignored; do not force-add it.
- **Skill output written to the repo root.** Some skills (e.g.
  `experimental-design`) write CSV or Markdown into the working directory. That
  output belongs in `test-artifacts/` (gitignored). `files` keeps stray root
  files out of the npm tarball, but a committed one still reaches a
  `pi install git:github.com/...` install, which ships the whole tree.

After any sync or test run, confirm the tree is clean:

```bash
diff -rq /path/to/upstream/skills skills   # must list only the excluded skills
npm pack --dry-run | grep -iE 'pycache|\.pyc'   # must be empty
```

npm strips `.gitignore` files from a package (and reads each one as ignore
rules for its directory), so the installed package lacks
`skills/autoskill/.gitignore`. Its three rules (`__pycache__/`, `*.pyc`,
`.pytest_cache/`) exclude nothing that ships, so the difference is harmless
and known.

### Uninstalling

Run `/sci reset` first, so the package's filter is cleared before you remove
it. After removing the package you can delete two files under `~/.pi/agent/`
by hand if you want them gone: the state file `pi-scientific-skills.json` and
the one-time backup `settings.json.pi-scientific-skills.bak`.
## Functional testing

Two kinds of testing, with very different costs:

- **Discovery:** does pi offer the skill, with the right name and description?
  Cheap, covers all 176, and runs on every sync (`npm run validate` plus the
  tarball probe in the checklist below).
- **Functional:** does pi load the skill, and does a model follow SKILL.md?
  Each run costs a model call and several minutes, so coverage grows by a few
  skills per release and is never complete. The bar is whether pi sees and
  loads the skill. Do not collect API keys, request Hub access, or download
  tool weights as part of testing. If SKILL.md's next step needs a login or a
  large download, following it up to that point is a pass. An artifact is
  extra evidence when the skill produces one; it is not required.

`testing/ledger.json` records the functional runs. README's count of skills
run end to end comes from it (`npm run validate` fails when the two disagree).
The per-release narrative is under "Run record by release" below, and the
README's caveats are under "What pi does and does not enforce". The README is
the landing page on npm and GitHub and stays positive and short, so the hedges
live here.

README's search test rests on these `extensionRuns` entries:

- 1.1.0, 1.2.0, 1.3.0, 1.4.0 and 1.5.0: `deepseek/deepseek-v4-flash` with Core
  in the prompt, three questions, `sci_find` called unprompted each time.
  1.4.1 has no entry.
- 1.6.0: no entry for that test with that model. The 1.6.0 search test is the
  local-model run of 2026-09-23 (Ternary Bonsai 2 27B, no skill in the prompt;
  report in `testing/report.md`).
- 1.7.0: the same three questions on pi 1.0.0 with no skill in the prompt, on
  Bonsai 2 27B, Gemma 4 26B-A4B and `openrouter/deepseek/deepseek-v4-flash`
  (entry of 2026-10-02). Bonsai and DeepSeek read an expected `SKILL.md` on
  all three questions, Gemma on two.

```bash
npm run test:batch -- --version 1.0.3 --include <skills-new-this-release>
```

The batch is this release's new skills plus a random fill up to `--size`
(default 6; 4–8 is the working range). The fill draws only from skills never
tested before, so coverage accumulates instead of resampling. The version
string seeds the selection, so any batch can be re-derived months later.

Deliberate choices:

- **Runs against the packed tarball in a scratch dir**, never `./skills`. This
  tests what ships, avoids any `/sci` filter in your settings that would
  silently hide the skill, and keeps skill scripts from leaving `__pycache__`
  in the vendored tree, which must stay byte-identical to upstream.
- **One skill per run** (`-ne -ns --skill <one dir>`), so nothing else is in
  play. Tools stay enabled: pi lists skills in the system prompt only when a
  tool that can read them is enabled (`read` or `bash`, in pi's
  `buildSystemPromptSections`), so `--no-tools` hides the skill and every run
  reports a false zero.
- **The script does not decide pass/fail.** It writes a raw `.jsonl`
  (gitignored: several MB, and it embeds `$HOME` paths and the operating
  username) and a scrubbed `<skill>.summary.json` (tool calls, truncated
  results, final text). A human or a stronger model grades the transcripts in
  a separate pass. A model's claim that it succeeded is the thing under test,
  so it cannot count as evidence. After a distiller change, rebuild the
  summaries with `--distill-only` instead of paying for the model calls again.
- **Stdout goes to a file descriptor.** pi's `--mode json` emits a cumulative
  `message_update` per token, so a pipe buffered under `maxBuffer` kills long
  runs: the first `arbor` run died that way at 67 MB, with a SIGTERM that
  reads as a skill failure and is not one.
- **The per-skill sandbox is wiped before each run.** Scratch is keyed only on
  version, so a re-run would otherwise resume leftover state.
- **Pair tool results on `toolCallId`, never on tool name.** pi returns
  concurrent results out of order, and matching by name staples one command's
  output onto another command.

Verdicts are `PASS`, `FAIL`, `BLOCKED` or `TIMEOUT`. `BLOCKED` and `TIMEOUT`
are not failures of the skill: BLOCKED means a missing dependency, credential
or network; TIMEOUT is a fact about the run (wall clock or a harness fault).
Neither counts toward a pass rate, and TIMEOUT skills stay in the sampling
pool.

### Run record by release

Model is `deepseek/deepseek-v4-flash` unless noted. Verdicts, timings and the
full notes, including every `harnessNote`, are in `testing/ledger.json`; the
scrubbed transcripts are in `testing/transcripts/<version>/`.

- **1.0.0 (4):** `statistical-analysis`, `pathogen-variant-surveillance`,
  `experimental-design`, `scientific-visualization` (the last two under
  `z-ai/glm-5.2`; the model for the first two was not recorded).
- **1.0.2 (6):** `ncats-arax` (live ARAX/TRAPI one-hop, imatinib → ABL1),
  `relsa-severity-assessment` (bundled cohort scored, KDE plot written),
  `etetoolkit` (ete4 Newick I/O, prune, reroot, Robinson-Foulds),
  `venue-templates` (Nature scaffold generated; the author-substitution regex
  is a rough edge that does not fail the run), `arbor` (HTR cycle via bundled
  `tree.py`; the merge gate correctly rejected a non-generalizing candidate),
  `deepspot-m` (pi offered it; the model loaded SKILL.md and followed the
  documented install path).
- **1.2.0 (6), including both skills new in v2.64.0:** `lab-hardware-cad`
  (bundled `check.py` ran; ANSI/SLAS standards listed and inspected with
  tolerances), `waypoint-bio` (PyPI package installed, `waypoint` CLI verified
  with all five subcommands, stopped correctly at the gated Hugging Face
  login), `networkx` (workflow steps 1–2 scripted and run), `generate-image`
  (bundled script listed 43 models over the documented no-key path),
  `pi-agent` (First Decision routing followed to the overview reference),
  `scikit-bio` (installed 0.7.3 in a venv, Section 1 reverse-complement
  verified).
- **1.3.0 (9), including `rowan`, the skill that release changed:** `aeon`
  (installed 1.5.0 and ran the Quick Start RocketClassifier on GunPoint to
  100% accuracy), `pkpd-modeling` (bundled `nca.py` ran a full
  non-compartmental analysis on a one-compartment oral profile), `bids` (wrote
  a valid `dataset_description.json` and the `sub-01/anat`, `sub-01/func`
  layout), `glycoengineering` (implemented and ran the documented N-X-S/T
  sequon scan on the IgG1 Fc example; the model's "N297" gloss mixes EU
  numbering with a fragment-local index, a rough edge that does not fail the
  run), `research-lookup` (installed the pinned
  `parallel-web-tools[cli]==0.7.1`), and four that stop at a documented
  credential or install gate: `rowan` (needs `ROWAN_API_KEY`), `scanpy`,
  `literature-review`, `dnanexus-integration`. Two of these runs installed
  packages onto the host instead of into the sandbox (see `harnessNote` in the
  ledger); later entries count these host installs.
- **1.4.0 (6), none new (v2.66.0 adds no skills):** `markdown-mermaid-writing`
  (status report written from the bundled template with a Mermaid timeline,
  footnote citations and the style guide's emoji rule), `pytdc` (SKILL.md's
  ephemeral `uv run` form listed all 27 ADME datasets from the metadata
  registry, no data download), `hypogenic` (bundled `validate_config.py`
  passed both the example run policy and the example task config, no model
  call), `cellxgene-census` (installed 1.17.0 and opened the 2025-11-08 LTS
  Census: 217,768,036 cells, matching SKILL.md's figure; installed into the
  host's conda base env with `uv pip install --system`, the third host
  install), and two that stop at a documented gate: `deeptools` (Quick Start
  step 1 script ran; no input BAM and no deepTools install) and `adaptyv`
  (`.env` check and SDK presence check, then the API-key gate).
- **1.4.1 (0):** a patch release carrying the 1.4.0 grades above, the README
  rewrite that moved the caveats into this file, and a shorter upgrade notice
  for patch bumps. No skill changed, so nothing new was run.
- **1.5.0 (6), including both skills new since v2.66.0:** `datalad` (installed
  datalad 1.6.2 plus the git-annex PyPI wheel and ran the documented
  `datalad wtf` health check; installed into the host's conda base env with
  `uv pip install --system`, the fourth host install),
  `folklore-variant-evidence` (the documented `tools/list` and the
  rs80357914 smoke test against the live api.helena.bio MCP endpoint, no
  credentials; the model reported the ambiguous outcome and left it
  unresolved, as SKILL.md's outcome table requires), `pymoo` (venv, bundled
  `single_objective_example.py` ran GA to convergence), `pydeseq2` (pinned
  0.5.4, Quick Start steps 1–2 on a toy count matrix; the fifth host install,
  same `--system` cause), `gget` (venv, pinned 0.30.5, live Ensembl search
  for BRCA1 returned ENSG00000012048) and `pydicom` (venv, pinned 3.0.2, the
  "Read datasets safely" pattern on the package's own CT_small.dcm). Two of
  six runs wrote into the host again; the venv-per-run harness fix is still
  open. This release also carries the `/sci status` fix: under a filter, the
  status line states what `/skill:<name>` does instead of listing where pi's
  own paths still forward literal text. Those paths are listed under
  "Residual limits".
- **1.6.0 (6), including the one skill new in the main@49c6e97 sync and the
  two it updated:** `alphagenome` (new; read SKILL.md, ran the probe's
  one-command preflight, `pip show alphagenome`, found the package absent,
  then correctly stopped before the install step, one step short of the
  `ALPHAGENOME_API_KEY` gate: a free DeepMind key nobody has here, and getting
  one means creating a third-party account, which the probe rules forbid),
  `ontology-term-resolution` (bumped to 1.2; the bundled `resolve_terms.py`
  resolved "liver" to `UBERON:0002107` against the live OLS4 API, matching
  SKILL.md's own example), `genomic-intelligence` (bumped to 1.2; no
  `GI_API_KEY` set, so the model followed SKILL.md's keyless path and
  completed a live MCP handshake against the hosted demo; the server returned
  15 tools, the 14 names SKILL.md gives for its MCP path plus `list_jobs`,
  which only `references/mcp.md` documents), `scikit-learn` (Quick Start's
  stratified split plus a `RandomForestClassifier` on iris, 0.900 test
  accuracy), `geniml` (ran the bundled, dependency-free
  `bed_validator.py --help` and got back the documented safety-gate contract;
  the sandbox had no real BED file to validate), and `torch-geometric`
  (installed 2.8.0.post1 against the existing PyTorch 2.13.0 and imported it;
  installed into the host's miniforge base env with `uv pip install --system`,
  the sixth host install). alphagenome is graded PASS rather than BLOCKED
  because SKILL.md's own Setup was followed as far as it goes before the
  credential gate, the same bar `rowan`, `adaptyv`, `scanpy`,
  `literature-review`, `dnanexus-integration` and `deeptools` were held to.
  The record does not claim the AlphaGenome Atlas itself was queried, only
  that pi loaded the skill and the model followed it up to the key it does
  not have.
- **1.7.0 (0):** no skill batch. `skills/` is the same git tree as in 1.6.0
  (`786d69d`), so `test-batch` was not run (as in 1.4.1) and the count of
  skills run stays at 43. The release changes search, and three runs
  measured its design. Each has an `extensionRuns` entry in
  `testing/ledger.json` and a notebook in `testing/runs/`:
  `2026-09-25-night-arms.md` (Bonsai 2 27B, three arms over 161 probes: the
  target skill read on 157 with the 1.7.0 design as first built, on 116 with
  1.6.0 search mode, on 158 with all 162 skills listed),
  `2026-09-27-find-ranker.md` (offline, 321 held-out requests: BM25F top 3
  held the target 310 times, the old ranker's top 8, 283 times) and
  `2026-09-29-openrouter-ab.md` (Gemma 4 26B-A4B, old search against new
  search over 319 units: new on 244, old on 225, +6.0 points, non-inferior).
  All three ran on pre-release builds (the package content of `08aff2e`,
  `69eea24` and `713d6e8`), before later fix commits, so none ran the final
  tarball. The release gates then ran on the packed tarball on pi 1.0.0
  (2026-10-02, one `extensionRuns` entry): `scripts/try-it.sh new --check` and
  `upgrading --check` passed, the discovery probe found the four skills it
  asked about and reported the made-up one absent, and
  `node scripts/test-find-live.mjs` passed on three small models (Bonsai 2
  27B, Gemma 4 26B-A4B, DeepSeek V4 Flash): `sci_find` called and an expected
  skill returned on 3 of 3 questions for each.
- **1.8.0 (0):** no skill batch and no live `sci_find` run. The release is the
  upstream v2.72.0 snapshot, 14 new skills among 176, and the maintainer's
  call is that new upstream skills join the untested pool instead of being
  tested on arrival. The offline gates ran on pi 0.87.0 and 1.0.0: `npm test`
  (ranking re-checked on the rewritten descriptions,
  `testing/runs/2026-10-05-v2.72.0-sync.md`) and `npm run typecheck`. The
  count of skills run stays at 43.
- The other 133 have not been exercised here; they ship as upstream ships them.

### What pi does and does not enforce

- `allowed-tools` in a skill's frontmatter is inert in pi: there is no
  pre-approval gate, and ignoring the field does no functional harm. Skills
  that need heavy Python stacks (scanpy, rdkit, torch, …) need those installed
  in the user's environment, as in any harness.
- Upstream notes that review depth varies by authorship: K-Dense-authored
  skills go through their internal review, while community-contributed skills
  are reviewed "to the best of our ability, but with limited resources", and
  upstream advises against enabling everything at once. This package ships the
  full snapshot; `/sci` (or `pi config`) is how a user narrows it to what they
  intend to run. An enabled skill is third-party code the user is choosing to
  execute.
- Upstream's own pytest battery passes on the byte-identical content. The
  2,512-test figure quoted in early releases was counted at v2.62.0. Later
  upstream releases add suites for their new skills and the figure has not
  been re-counted, so upstream's CI badge is the current source.

## Adoption metrics

```bash
npm run metrics:downloads
```

Appends npm's daily download counts to `metrics/downloads.json`. Re-running is
safe: days merge by date, and when npm later revises a count, the change goes
into a `revisions` array instead of silently overwriting the old value. The
recent tail is provisional, and the file should show that.

The file is gitignored, so it lives on one machine and no clone has it. The
local copy exists because npm's range endpoint serves only ~18 months and
cannot say what it reported last week. Anything older than that window is lost
if the file is; back it up off-repo if the deep tail is worth keeping.

When reading the series, keep two things in mind. npm counts tarball fetches,
so mirrors, CI caches and registry scrapers land in the same bucket as people.
And a publish-day spike is almost certainly automated traffic: at 1.0.2 the
series was 278 downloads over 12 days, 242 of them on publish day.

Neither the download series nor the functional-test ledger is a quality
measure. They exist so that later claims about adoption and coverage have
something behind them.

## Publishing checklist

- [ ] `npm test` clean: validation plus the six offline suites (search,
      extension, filter, skill-expand, frontmatter and live-lib; requires an
      installed pi; they load the extension through pi's own jiti)
- [ ] Read `sync-upstream.sh`'s drift warning, printed when upstream `main`
      has moved past the tag (see "Sync script details"). If it has, decide
      whether to sync the tag as-is or a SHA on `main` instead
      (`bash scripts/sync-upstream.sh <40-hex-sha>`). A tag can sit behind
      `main` for weeks without its own version bump, the warning is the only
      thing that says so, and re-syncing a stale tag is a silent no-op while
      real changes sit unsynced on `main`.
- [ ] License exceptions re-checked after any sync: `find skills -iname 'LICENSE*'` and
      `grep -h '^license:' skills/*/SKILL.md | sort -u`; record new non-MIT or
      NonCommercial skills under Provenance and in README credits
- [ ] `skills/` byte-identical to upstream (`diff -rq`): no `__pycache__`, no stray output
- [ ] `npm pack --dry-run` shows no `.pyc` and no test artifacts
- [ ] Discovery smoke test passes. Run it against the **packed tarball extracted
      into a scratch dir**, not the repo, whose path picks up whatever `/sci`
      filter is in your `~/.pi/agent/settings.json`:
      `cd $SCRATCH/package && pi -ne --skill ./skills --no-session -p "<name-presence probe>"`
      `-e .` does not load `pi.skills`, and `--no-tools` hides every skill (pi
      lists skills only when a tool that can read them is enabled), so either
      reads as a false zero. Check by name presence, because the reported
      total also counts your personal skills.
- [ ] `node scripts/test-batch.mjs --version <ver>` run, transcripts graded, and
      `testing/ledger.json` updated with the new batch (see "Functional testing")
- [ ] `node scripts/test-find-live.mjs` passes on a **small** model, recorded under
      `extensionRuns` in the ledger. This is the gate for search mode: if a weak
      model does not reach for `sci_find`, fix the tool description and
      `aliases.ts` before release
- [ ] `extensions/package-info.ts` `PACKAGE_VERSION` bumped alongside
      `package.json`. `npm run validate` hard-fails otherwise, but bump it
      deliberately: it decides whether existing users see the upgrade notice
      at all
- [ ] The upgrade notice says what changed in this release, and a seeded
      prior-version config still leaves `settings.json` byte-identical
      (`npm run test:extension` asserts this; re-read the wording by hand)
- [ ] `package.json` `version` bumped on our own line; `upstreamVersion` matches
      the synced tag; README's `v<upstream>` mentions agree with it
- [ ] git commit + push, PR merged to `main` (GitHub)
- [ ] `npm publish` from `main` (requires npm login) → gallery auto-lists via
      `pi-package` keyword; confirm with `npm view pi-scientific-skills version`
      or the npm registry keyword endpoint
- [ ] tag `v<version>` on the published commit and push the tag, only after
      the publish is confirmed (v1.1.0 once sat untagged; a tag with no
      registry version is worse)
