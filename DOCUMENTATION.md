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
- **Upstream version:** 2.69.0 (from `pyproject.toml`), recorded in
  `package.json` as `upstreamVersion`
- **Our version is independent of upstream's.** This package uses its own semver
  line starting at 1.0.0. It deliberately does *not* mirror the upstream number:
  the two artifacts differ (162 skills vs upstream's 166, plus the `/sci`
  extension), and upstream ships patch releases — 16 of 106 tags at v2.69.0
  have a non-zero patch, e.g. `v2.37.2`. Mirroring would mean an
  extension-only fix has to burn a number like `2.63.1` that upstream may
  later claim for itself, and npm versions can never be reused.
  `upstreamVersion` carries the snapshot
  identity instead, so bump `version` for *our* changes and `upstreamVersion`
  for *theirs*.
- **Source snapshot:** `scripts/sync-upstream.sh <tag>` shallow-clones the
  upstream tag and copies `skills/` byte-identical into this repo. (The 1.0.0
  snapshot predated the script and came from a `-main.zip` download; every
  release since is tag-pinned.)
- **`upstreamCommit` pins the exact upstream commit taken**, independent of
  `upstreamVersion`. The two diverge whenever a sync takes a SHA on `main`
  instead of a tag: `upstreamVersion` still records the latest tag by semver
  (a human-readable line), while `upstreamCommit` records exactly what was
  copied. This snapshot is `main@49c6e97` on the v2.69.0 line — nine commits
  past the `v2.69.0` tag, untagged upstream at the time of the sync.
- **License:** MIT, © 2025 K-Dense Inc. (`LICENSE.md` is the upstream text verbatim).
- **Relationship:** this repo is an independent distribution of the open-source
  skill collection. It is not affiliated with K-Dense Inc.
- **Licensing notes on individual skills.** A skill's own `license:`
  frontmatter (MIT, inherited from upstream) describes the skill's text, not
  what it drives. `alphagenome` is MIT as a skill but calls DeepMind's
  AlphaGenome API, which is free for non-commercial use only, whose outputs
  may not be used to train other ML models, and which the skill's own
  description labels research use only. A commercial user should read the
  skill's `compatibility` line before building on it — MIT on the skill text
  does not carry a license to the API's outputs.

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
package ships 162 skills and not upstream's 166. `scripts/sync-upstream.sh`
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

### The citation block is carried, not stripped (arrived with v2.66.0)

Upstream v2.66.0 appended a `## Citing Scientific Agent Skills` section to 135
of its 163 skills. It asks the model to add upstream's paper
(Kassis et al. 2026, arXiv:2609.00065) to the references or software section
of any manuscript, report, presentation or code release the skill materially
contributed to, and to tell the user it did so. It arrived here wholesale with
the sync, in the body of each `SKILL.md`.

- **It is skill body text, not a licence term.** `LICENSE.md` is unchanged
  (MIT, © 2025 K-Dense Inc.). MIT requires only that the copyright notice be
  preserved, which this package does. Nothing in the block is enforceable
  against this package or its users; it is a request.
- **It is carried because it cannot be stripped safely.** Exclusions here are
  declarative name lists that `sync-upstream.sh` re-applies. There is no
  mechanism to drop a section from 135 files, and a hand edit inside `skills/`
  is silently reverted by the next `rm -rf skills/ && cp -R`. Rewriting the
  script to strip it would be the first edit inside vendored content, which
  the scope note below rules out.
- **Side effect worth knowing.** The block tells the model to fetch
  `arxiv.org/abs/2609.00065` before writing the reference when network access
  is available. That reaches skills which otherwise make no network calls,
  including `analytical-method-validation`, whose own description advertises
  none.
- **No token-budget change.** `validate.mjs` estimates the always-loaded index
  from `name` + `description` only; the block touches neither. Drift stayed at
  1.7% before and after the sync, so `TOKENS_PER_SKILL` and every `/sci`
  figure are unchanged. The block is body cost, paid only when a skill is
  read, roughly 155 tokens per read.

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
  Plugins conformance for hosts this package has never been run against. 43
  skills have been functionally exercised (see [Functional
  testing](#functional-testing)), all in pi, none in Cursor/Codex/Copilot.
  Advertising those clients on that basis is unsupported.
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
skills/                 # 162 skill directories, each with SKILL.md (+ references/scripts/assets)
extensions/index.ts     # the ONLY file that registers anything with pi (command, tool, hooks); onboarding notices
extensions/types.ts     # shared constants + types (COMMAND_NAME, SUBCOMMANDS, UiContext, ...) — no imports
extensions/paths.ts     # settings.json / config-file paths, and the report() output helper
extensions/settings.ts  # reads/writes settings.json + this package's own config file; commitPlan
extensions/catalog.ts   # token accounting, the skill catalogue, sci_find's search, /skill:<name> rebuild
extensions/picker.ts    # the /sci profiles checkbox list (focused multiselect + select()-loop fallback)
extensions/commands.ts  # /sci's subcommands and bare-menu dispatch (status, search, all/none/reset)
extensions/profiles.ts  # profile taxonomy (PROFILES, UNASSIGNED, TOGGLES, TOTAL_SKILL_COUNT)
extensions/search.ts    # sci_find's catalogue + ranking, and skills/ root resolution
extensions/bm25f.ts     # the BM25F ranker, the default (PI_SCI_FIND_RANKER=current for the old one)
extensions/aliases.ts   # curated query→skill aliases, each from an observed miss
extensions/frontmatter.ts    # the one YAML parser, shared with validate.mjs
extensions/package-info.ts   # PACKAGE_NAME / PACKAGE_VERSION; validate.mjs guards the drift
scripts/lib/load-extension.mjs  # loads extensions/ the way pi does (jiti + host aliases)
scripts/doc-count.mjs   # each suite checks the check-count the README claims for it
scripts/sync-upstream.sh  # re-sync skills/ from upstream
scripts/validate.mjs    # pi-rule validation across all skills + extensions/ drift checks
scripts/test-search.mjs # sci_find ranking against the real 162 descriptions
scripts/test-extension.mjs   # command + startup behaviour against a stubbed ExtensionAPI
scripts/test-filter.mjs # that pi itself honours the filter we write
scripts/test-skill-expand.mjs  # the /skill: block we build is byte-identical to pi's, oracle = pi's own method
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
testing/ledger.json     # which skills have actually been RUN, with verdicts (+ extensionRuns)
testing/find-rank/      # ranker query sets: recorded first sci_find queries, blind probe paraphrases
testing/transcripts/    # raw pi output per graded run, kept as evidence
metrics/downloads.json  # gitignored: npm daily series + publish dates, with revisions
LICENSE.md              # upstream MIT verbatim
README.md               # pi-user-facing
DOCUMENTATION.md        # this file
test-artifacts/         # gitignored: output from local skill verification runs
```

`scripts/` and `testing/` are maintainer-side and do not ship — `package.json`
`files[]` whitelists `extensions`, `skills` and the three markdown files. They
do reach anyone installing via `pi install git:github.com/...`, which ships the
whole tree. `metrics/` reaches neither: it is gitignored, so the download ledger
stays on the maintainer's disk.

**One registrar.** pi's extension loader runs every file under `extensions/`
(`dist/core/extensions/loader.js`, a glob over the directory), and it does not
deduplicate: a second `registerCommand` for the same name is silently renamed
(`sci:2`), and a second `registerTool` for the same name is silently dropped.
So `extensions/index.ts` is the only file allowed to call `pi.registerCommand`,
`pi.registerTool`, or `pi.on` — every other file above ends in the same inert
`export default function noopExtension(): void {}`, and
`scripts/test-extension.mjs` asserts that each one calls nothing on the
`ExtensionAPI` it is handed.

## The `/sci` extension

### Why it exists

Pi injects every skill's name, description, and absolute `SKILL.md` path into
the system prompt at startup, one XML-escaped `<skill>` block each
(`formatSkillsForPrompt` in pi's `core/skills.js`); only skill *bodies* are
deferred. Measured across this collection as pi renders it: about 99k
characters ≈ **23k tokens**, about 143 tokens per skill, of which the bare
description is roughly 88 (recipe and both tokenizers in `profiles.ts`'s
`TOKENS_PER_SKILL` comment).
That is most of a 32k context and more than a 16k context can hold. Pi
is frequently run with small local models, so the index cost — not the skill
content — is the binding constraint.

Two distinct problems follow, and the profile design addresses both: the context
budget, and selection accuracy (a small model discriminates poorly among 162
similar descriptions, many of which are near-neighbours).

### Why it writes settings.json rather than filtering at runtime

Four mechanisms could filter skills. Only one is compatible with this port:

| Mechanism | Verdict |
|---|---|
| `disable-model-invocation: true` in frontmatter | **Rejected.** Edits `SKILL.md`, breaking byte-identity with upstream, and `sync-upstream.sh` replaces `skills/` wholesale — every sync would silently wipe the user's selection. |
| Intercept `resources_discover` and return filtered `skillPaths` | **Impossible**, not merely undesirable — see below. |
| `before_agent_start` returning a rewritten `systemPrompt` | **Rejected.** Would strip the skills index while leaving pi's registry intact — the only route that preserves `/skill:<name>`. But it is per-turn prompt surgery, fragile across pi versions, and invisible to `pi config`. |
| Set `disableModelInvocation` on the live `Skill[]` at runtime (via `ctx.getSystemPromptOptions().skills` or `before_agent_start`'s `systemPromptOptions`, both returned by reference) | **Rejected (decided at 1.4.0).** This is the one pi feature whose semantics match "hide from the prompt, keep `/skill:`": `formatSkillsForPrompt` (`skills.js:276`) is the only consumer of the flag, and pi's own comment says such skills "can only be invoked explicitly via /skill:name". But it requires **all 162 to load** so `/skill:` can resolve, which means abandoning the `settings.json` filter entirely. That costs `pi config` composition, hand-editability, and survival of extension removal — and `pi config` would then show all 162 enabled while the prompt carried 10, actively misreporting rather than merely not knowing. |
| Write pi's own per-package filter into `settings.json` | **Chosen.** Native, inspectable, hand-editable, composes with `pi config`, survives sync, and outlives the extension. |

**`resources_discover` cannot filter at all.** An earlier version of this document
called it "rejected" on the grounds that the selection would die with the
extension. The conclusion was right and the premise was wrong, which is worse
than being wrong outright — it invites someone to re-litigate the decision on a
false basis. The hook is **additive only**: `emitResourcesDiscover`
(`dist/core/extensions/runner.js:891-928`) does nothing with a handler's return
value except push it into accumulator arrays, and `agent-session.js:1854` feeds
those to `resource-loader.js`'s `extendResources` (`:230`), which *merges*
into the already-discovered set. No return value can remove a skill. (Line
numbers as of pi 0.84.3; they move about one release at a time.)

The filter is the object form that pi documents in `docs/packages.md` (in
`docs/settings.md` up to pi 0.87):

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy"] } ] }
```

### Search mode — progressive disclosure for the model (v1.1.0)

Profiles solve the context budget for the **human**: you pick a field before the
work starts. They do nothing for the **model**, and a profile is a bet — when it
is wrong, the skill the scientist needed is invisible.

`sci_find` closes that half. It loads no skills; it searches the names,
descriptions and SKILL.md text of all 162 skills and returns the ones that
match, with full descriptions and the absolute `SKILL.md` path for the model to
`read`. That is mechanically identical to how pi loads a skill natively, one
level further down: descriptions deferred rather than bodies.

`/sci search` writes an empty `skills` filter — no skill in the system prompt,
~0 tokens — through the same `commitPlan` path everything else uses —
deliberately **no second write path**, so the empty-array footgun handling
below stays single-sourced. `/sci none` is an alias: while `sci_find` is
registered, an empty filter is search mode, not "off".

**Why no skills, since 1.7.0.** Before 1.7.0, search mode loaded the ten Core
skills (~1.4k tokens). The 2026-09-23 live test
([`testing/report.md`](testing/report.md)) ran a 27B local model with no skill
in its prompt: it reached all ten Core targets through `sci_find` (8 on the
first attempt), and 143 of 157 valid targets overall. The risk, stated: the two
Core probes below first-attempt success (`exploratory-data-analysis`, `polars`)
were attempts that never searched. With Core in the prompt, those skills would
have been listed. The `promptSnippet` below exists to cover that. A small A/B
pilot (`testing/runs/2026-09-24-bonsai2-snippet-ab.md`) showed no effect on the
search rate (11/12 in both arms). A three-arm run over 161 probes then measured
the default change itself (`testing/runs/2026-09-25-night-arms.md`): the model
read the target skill on 157 with the 1.7.0 design as first built, 116 with 1.6.0
search mode (+25.5 points, 95% CI 18.4 to 32.9) and 158 with all 162 skills
listed. It read all ten Core targets in every arm. That 1.7.0 arm is the build at
commit `08aff2e`, not the shipped tip: the old ranker, 8 hits and a `limit`
argument the model could set. The BM25F ranker and the 3-then-5 list came later
(`713d6e8`). The gain belongs to that design as a whole: it also added the
`sci_find` snippet and guideline, which 1.6.0 did not have. The evidence for the
shipped tip is a chain of two runs on two models: Bonsai 2 27B, first-built
1.7.0 against 1.6.0, +25.5 points; then Gemma 4 26B-A4B, new search against old,
+6.0 points (below). No single run compares the shipped tip with 1.6.0 on one
model. Profiles still put a field's skills in the prompt for anyone who wants
them there. Existing users keep their filter; the 1.7.0 upgrade notice says what
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
The scope reads "scientific, research and analysis" and not only "scientific":
in the pilot's one treatment miss (`parallel-web`), the model's thinking named
`sci_find` as a tool for "scientific skills" and judged a web-monitoring task
out of its scope. The wording does not name web search, because that would fit
one probe directly. Known trade-off: "analysis" lets the guideline fire in
ordinary data-coding sessions, which costs one tool call. The live tests cannot
measure that, because every probe has a target.

**A custom system prompt gets neither the listing nor the guideline.** pi adds
a tool's snippet and guidelines only when it builds its own default prompt. With
a custom one (`SYSTEM.md` or `--system-prompt`) it leaves out the tools section
and the guidelines (`buildSystemPrompt` in pi's `system-prompt.js`, the
`customPrompt` branch; pi 0.84.3, 0.87.0 and 1.0.0 all do this). `sci_find` is still
registered and in the tool schema, but the prompt never names it. In search
mode that is the state of the 2026-09-23 run, where 15 of the 19 misses on valid
probes were attempts that never called it. If you use a custom prompt, add a
line that names `sci_find`, for example the package's own guideline: "Use
`sci_find` before you write code, install a package or set up a service for
scientific, research or analysis work: a skill may already cover it. Then read
the SKILL.md it returns." No live run used a custom prompt, so the effect of
that line is not measured.

**Codemode (pi 0.99 and later).** Codemode is off by default. With
`codemode.mode: "only"`, pi's tools list shows only `codemode`; scripts call
`sci_find` as `tools.sci_find`, the guideline stays in the prompt, and the
3-then-5 hit rule still applies. pi also turns codemode on when an MCP server
with the default `codemode` exposure connects; `"autoEnableCodemode": false`
beside `mcpServers` in `mcp.json` stops that (pi's `docs/mcp.md`). Codemode
adds its own tool and a line to each tool description, so with a small local
model keep it off unless you use it.

**`/sci none`, `/sci search` and the way back to Core (1.7.0).** An empty
`skills` filter now means search mode, not "off": `sci_find` stays registered.
1.6.0's `/sci none` wrote an empty filter to mean off, and 1.7.0 reads that
same file as search mode without changing it. `/sci search` writes an empty
filter where 1.6.0 wrote the Core list. An empty filter cannot carry pi config
overrides (`!x`, `+x`, `-x`; see "The empty-array footgun" below), so
`/sci search` drops them, and its report names each one: "Dropped pi config
overrides: !polars. Re-add them with pi config if you want them back." The way
back to Core is the picker: `/sci profiles`, tick Core, choose "Apply and
reload". `test-extension.mjs` starts from four settings files: three 1.6.0
states (Core accepted; offer declined, which leaves only the install entry;
`/sci none`) and one with a pi config override added (Core plus `!polars`). It
checks that startup leaves each byte-identical and that the round trip
(`/sci search`, then Core through the picker) restores the Core file byte for
byte. To turn `sci_find` and `/sci` off, set
`"extensions": []` on the package's object entry in `settings.json`; this was
checked against pi's own resolver in 0.84.3, 0.87.0 and 1.0.0, and the `skills` filter
then works as written.

**Design decisions worth not re-deriving:**

- **The tool is registered unconditionally**, not behind a mode flag. About 200
  tokens of tool definition, snippet and guideline against a ~23k index is not
  a trade worth a config toggle,
  and someone running all 162 still benefits from looking a skill up by need
  rather than by name. `/sci status` says so.
- **Recall beats precision, in a short list.** `sci_find` does not have to
  pick the right skill, only get it into a short list with full descriptions
  attached. Even a small model discriminates well among a few labelled options
  and badly among 162 in a system prompt. That is why scoring is OR-based:
  requiring every term to match returns nothing for ordinary phrasings
  ("variant calling" matches no single description verbatim).
- **3 hits, then 5.** The first turn that searches after a prompt gets
  the top 3 (parallel calls in that turn too); later turns get the top 5
  (`createSearchStage` in `catalog.ts`, fed by pi's `agent_start`,
  `message_start` and `turn_start` events). A user message starts a new first
  search: the prompt, and each steer and follow-up message. So does a custom
  message that opens an agent run. An extension's `pi.sendMessage` with
  `triggerTurn: true` on an idle agent starts a run with no user message, and pi sends its
  custom message to the model as one. A custom message later in a run does not
  start a new first search. Nor does a retry or compaction that restarts the
  agent loop (`agent_start`, no new message). Profile listings do not count as
  a search. The result text is most of the prefill of the turn after a search,
  so a shorter list is a faster turn: about 850 characters per hit, and 8 hits
  took about 17 of the 25 seconds on 2026-09-25. Under bm25f the target is in
  the top 3 for 98.7% of the first queries Bonsai 2 27B wrote and 96.4% of
  Haiku 4.5's. The old ranker's top 8 held 97.2% and 96.3%: equal for Haiku,
  1.5 points lower for Bonsai. There is no `limit` argument: in the same data
  the models set one in 578 of 1,341 calls, mostly 10 to 20. `/sci find` and
  callers that pass no count get 8, from the same ranker.
- **After a miss, and the live A/B.** When the target is not in the 3, the tool
  description tells the model to search again with other words. One run
  measured what it does
  ([`testing/runs/2026-09-29-openrouter-ab.md`](testing/runs/2026-09-29-openrouter-ab.md)):
  Gemma 4 26B-A4B through OpenRouter, the old search (commit `0a8ddfd`: old
  ranker, up to 8 hits, a `limit` argument) against the new one, 319 units (161
  probes in two paraphrase styles). The target's `SKILL.md` was read in 244 of
  319 with the new search and 225 of 319 with the old (+6.0 points, 95% CI 1.0
  to 10.9; the pre-registered test was non-inferiority, which it met). The
  choice turn's prompt tokens fell by a paired median of 867.5 (n 226). Among
  attempts whose first list lacked the target (19 new, 17 old), the model called
  `sci_find` again in 12 and read the target in 10 with the new search, against
  6 and 4 with the old; those counts are small. When Gemma called `sci_find` at
  all, it read the right skill in 244 of 255 attempts (95.7%) with the new
  search and 225 of 245 (91.8%) with the old. Most of its misses never
  searched (64 of 75, against 74 of 94). Limits: one model, an unpinned
  provider, and the paraphrases were development data for the ranker, which
  favours the new search.
- **A compact result format is experimental, behind a flag, and off.** With
  `PI_SCI_FIND_FORMAT=compact`, `sci_find` shows the top 2 hits
  in full and the others with the first sentence of their description only
  (with 3, then 5 hits, that is 1 or 3 short ones). `/sci find` and other
  callers that pass no count then get 6 hits, not 8; `sci_find` itself always
  passes 3 or 5, so the 6 never applies to it. On 2026-09-25 the top 6 held
  the target in 152 of 158 searches, and the choice turn after the search spent
  most of its time in prefill of the result. The first choice-turn replay
  ([`testing/runs/2026-09-27-find-compact-replay.md`](testing/runs/2026-09-27-find-compact-replay.md))
  was inconclusive: the target was read in 155 of 158 choice turns with
  `compact` and 158 of 158 with `full` (95% CI −5.4 to 0.8 points, margin −5),
  and `compact` saved a median 951 prompt tokens. The second sample, pooled
  with the first, was non-inferior
  ([`testing/runs/2026-09-27-find-compact-replay-2.md`](testing/runs/2026-09-27-find-compact-replay-2.md)).
  The flag stays off by decision, not for lack of a replay: the shorter list
  (3, then 5) took its place as the way to cut result tokens. Profile listings
  and no-match results are the same in both formats.
- **The ranker is BM25F (since 1.7.0).** `sci_find` ranks with BM25F over three fields
  per skill: name, description and SKILL.md body (`extensions/bm25f.ts`). A
  word's weight falls with the number of skills that use it, and the body lets
  a query reach a skill through words its description does not use. The
  settings are fixed; they came from cross-validation on 425 recorded first
  `sci_find` queries. A query equal to a skill name lists that skill first.
  The no-match rule is its own: the best score must reach 2.5, or 35% of the
  most the query could score. On development data it put the target in the
  top 8 for 99.8% of recorded queries (current ranker: 97.2%) and 95.0% of
  plain-language rewrites of the probes (current: 77.0%), and lost none of
  1,069 development queries to the no-match rule. It also returns hits for
  fewer requests that no skill covers. On agent-written sets (60 off-domain
  and 40 in-domain requests with no matching skill), a hit came back for 16 and
  11 as queries (current ranker: 26 and 19) and for 34 and 29 with the full
  request text as the query (current: 37 and 33). Every count is lower than the
  current ranker's, yet most full-text requests with no skill still get hits, so
  the no-match rule is a filter, not a guarantee; the in-domain set has only 40
  items. Its cost: it has no alias boost, so a query made only of common words
  can miss ("write the methods section of my paper" ranks `scientific-writing`
  11th; `test-search.mjs` lists it as a known miss). The index is built on the
  first call (about 120 ms) and later calls take under 3 ms. Before it became
  the default:
  a choice-turn replay (the model read the target in 158 of 158 turns with
  bm25f lists, against 156 of 158), a panel of two query writers (Claude
  Haiku 4.5 and Bonsai 2 27B; top 8 99.3% against 96.7%), and one run on a
  locked held-out set of 321 requests no setting was chosen on (top 3 96.6%
  against the old ranker's top 8, 88.2%). All in
  [`testing/runs/2026-09-27-find-ranker.md`](testing/runs/2026-09-27-find-ranker.md).
  With 3 hits, the "methods section" miss above shows no writing skill; a
  query that names the kind of writing ("scientific manuscript methods")
  does. `PI_SCI_FIND_RANKER=current` restores the old ranking order for one
  release. It is the order only: the first search still shows 3 hits, later
  ones 5, and there is still no `limit` argument.
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
- **The catalogue is read lazily from disk** (~18ms for 162 files, head 8KB
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
  It defaults that flag to `false` (`agent-session.js:1133` in pi 0.84.3) — the
  opposite of `prompt()`, which defaults it to `true` (`:796`) — and
  extension-command dispatch is gated on it (`:802`). Without it, accepting the offer sends the
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

### `/skill:<name>` under a filter — the stopgap, and what it does not cover (1.4.0)

**The defect, precisely.** pi never validates a `/skill:` name.
`_expandSkillCommand` (`agent-session.js:956-978` in pi 0.84.3) looks the name
up in `resourceLoader.getSkills().skills` and on a miss returns the input
unchanged (`:963-964`, "Unknown skill, pass through"). The `emitError` path in
the same method exists only for a *read* failure on a skill that was found. A
filtered skill reaches the miss branch because the filter removes it from the
registry entirely rather than hiding it from the prompt: `applyPackageFilter`
(`package-manager.js:1856`) marks the file `enabled: false`, `resource-loader.js`
keeps only survivors, and `getSkills()` has no entry. The model then receives
the user message `"/skill:pysam"` and usually answers as if the skill loaded.

Two bounds on that, both of which matter:

- **Search was never affected.** `sci_find` returns `SKILL.md` paths for the
  model to `read`; nothing on the model's path goes through `/skill:`. The
  defect surface is exactly one thing: a human typing `/skill:<filtered-name>`.
- **The same branch has a second, filter-free instance.** `text.indexOf(" ")`
  splits on the first *space*, not the first whitespace, so
  `/skill:<loaded-skill>\nrest` also misses on stock pi, with no filter at all.

**Why not the `disable-model-invocation` route.** That is a real pi feature with
exactly the wanted semantics — see the mechanism table above — but it needs
all 162 loaded, which means giving up the `settings.json` filter and having
`pi config` misreport. Recorded there so it is not re-derived.

**The stopgap.** An `input`-event handler in `extensions/index.ts`. `prompt()`
runs extension commands, then `emitInput`, then `_expandSkillCommand`, then
`expandPromptTemplate` (`agent-session.js:802-831`), with nothing touching the
text in between; pi 0.87's `docs/extensions.md` showed a literal "intercept
skill commands before expansion" example on this hook. The handler:

1. stands down for `source === "extension"` (`sendUserMessage` defaults
   `expandPromptTemplates` to false, and the event does not carry that flag,
   so source is the only readable proxy);
2. parses the command with pi's own split, quirks included (constraint 5);
3. stands down when `pi.getCommands()` lists `skill:<name>` with
   `source: "skill"` — that is `getSkills().skills` mapped unfiltered
   (`agent-session.js:1927-1932`), the exact array `_expandSkillCommand`
   searches, so the gate is not an approximation. It also keeps pi's
   resolution for a same-named skill from another package;
4. otherwise looks the name up in a **Map built from the `sci_find`
   catalogue**, reads the file, strips frontmatter with pi's own exported
   `stripFrontmatter`, and returns pi's wrapper verbatim as a `transform`.

Because the output starts with `<`, both downstream expanders no-op on their
first-character guard, so there is no double expansion. A throw is swallowed
and the text passes through, which is today's behaviour, never worse.

Five constraints that are not negotiable, each pinned by a test:

1. **Name resolution is a Map lookup, never a path join.** `join(SKILLS_DIR,
   name, "SKILL.md")` turns `/skill:../../../../home/user/.ssh/id_rsa` into an
   arbitrary file read whose contents land in the user turn. The catalogue
   enumerates real directory entries, so there is nothing to escape.
2. **`stripFrontmatter` is resolved lazily, not statically imported.**
   `peerDependencies` pins no floor. On a pi build lacking the export a static
   named import fails at module link and takes `/sci` and `sci_find` down with
   it; a lazy import degrades to pi's existing behaviour. If anyone converts it
   to a static import, add a version floor.
3. **`extensions/frontmatter.ts` is not reused.** It returns fields only,
   computes no body, and its `m`-flag regex can match a mid-document `---`.
4. **The gate is `pi.getCommands()`, not a regex over the system prompt.**
   The `<available_skills>` block drops `disableModelInvocation` skills and is
   omitted entirely unless `read` or `bash` is active, so it is a lossy
   projection that misfires in exactly the case the fix is for.
5. **pi's parsing quirks are reproduced, including the multi-line miss.**
   Repairing it here would make a filtered skill behave differently from an
   active one, the opposite of the goal.

**Verified live, not only in the suites.** With the packed 1.4.0 tarball
installed into a throwaway agent dir filtered to `["scanpy"]`,
`pi --mode json -p "/skill:pysam …"` delivered pi's `<skill name="pysam" …>`
block to the model, and `/skill:scanpy` (loaded) still went through pi's own
expansion. `settings.json` was untouched. Note that pi blocks on an open,
non-TTY stdin in `-p` mode, so a scripted run needs `</dev/null`.

**Byte fidelity is proven, not assumed.** `scripts/test-skill-expand.mjs`
borrows `AgentSession.prototype._expandSkillCommand` onto a fake `this` holding
pi's own `loadSkillsFromDir` output and compares it against the handler across
all 161 skills × 3 argument forms: 483 of 483 identical at 1.5.0. It is
circular on one axis — both sides read the same `skills/` — so it proves string
fidelity, not that pi's package manager resolves the same path for an installed
copy. `validate.mjs` guards the three content invariants the handler depends
on and a sync could break: frontmatter `name` equals the directory name (the
handler keys on the directory; pi uses `frontmatter.name || dirname`), no body
contains `<skill ` or `</skill>` (pi's `parseSkillBlock` is non-greedy and
would truncate), and the `disable-model-invocation` count (0, informational).

**Residual limits.** Narrowed, not closed. This list is the disclosure. The
README and `/sci status` state what works (type the name at the prompt); the
paths that still forward literal text are written down here, where someone who
finds a literal `/skill:` in a transcript will look. Until 1.4.1 the status
line repeated items 1 and 3 to every filtered user; it no longer does.

1. **On pi 0.84 and 0.85, `steer()` and `followUp()` bypass the hook.** Both
   call `_expandSkillCommand` directly with no `emitInput` (0.84.3
   `agent-session.js:995`, `:1012`). Reached from `interactive-mode.js`
   (`flushCompactionQueue`, lines 3640-3680: on the retry branch every queued
   message bypasses; on the normal branch the first goes through `prompt()` and
   the rest bypass) and from `rpc-mode.js:322,326` (RPC `steer` and
   `follow_up`, unconditionally). So on those versions a `/skill:<filtered>`
   typed while compaction is running, or sent as an RPC steer, still forwards
   literal text. Not closable from the input hook. pi's changelog lists the RPC
   fix in 0.86.0 (0.86 code not checked). On pi 0.87.0 (code) and 1.0.0 (code
   and an RPC run) every queued path runs the hook, and the filtered skill
   reaches the model expanded.
2. **No autocomplete.** `interactive-mode.js:520` builds the `/skill:`
   completion list from `getSkills().skills` only. The user types the name
   from `/sci find` output.
3. **Only this package's skills.** The defect is global; another package's
   filtered skills, or a skill disabled through `pi config` in another
   package, still leak literal text. This covers 162 names out of an open set.
4. **The multi-line variant is untouched**, deliberately (constraint 5).
5. **Extension-injected `/skill:` is skipped** on `source === "extension"`.
   The proxy is lossy in both directions.
6. **An earlier `input` handler can silently disable this.** `emitInput`
   chains transforms, so an extension that prepends text makes
   `startsWith("/skill:")` false, and a later `{action: "handled"}` discards
   the transform. Package extensions load last, so this one is maximally
   exposed.
7. **On any doubt the handler is inert by design**, so a silent no-op is a
   possible failure mode. Do not document it as "always fires".
8. **`location=` is the realpath; pi's is not.** `resolveSkillsDir()` goes
   through `import.meta.url`, which jiti hands back resolved, while pi's
   `mapSkillPath` does a plain `join` with no `realpath`. Observed in a live run
   under a filter on macOS: the hook emitted
   `/private/var/folders/.../skills/pysam/SKILL.md` where pi emits
   `/var/folders/.../skills/scanpy/SKILL.md` for a loaded skill. Both name the
   same file and the model can `read` either, so this is a cosmetic
   difference on a symlinked install path and no difference at all on a
   normal one. It is the one axis `test-skill-expand.mjs` cannot see.

**Upstream.** The complete fix is a few lines in pi: `emitError` on the miss
the way the read failure already does. That would make the miss visible on
every path (`prompt`, `steer`, `followUp`, RPC) for every package; it would not
make a filtered-out skill load, which is the filter's job. A patch with a
regression test was prepared against pi 6160683 (0.85.1) and passes pi's
`npm run check`; it is kept out of the tree (`testing/upstream-*`, gitignored)
and has not been filed. Sending it is a maintainer decision, not something
this package does, and pi's contributor gate needs an issue in the filer's own
words plus a maintainer `lgtm` before any PR. Whitespace splitting is not part
of it: pi closed #8413 on that as `no-action`. Until pi changes, the handler
above is the supported behaviour and the limits above stand.

### The empty-array footgun

`applyPackageFilter` (pi `dist/core/package-manager.js:1856` in 0.84.3) treats a **literally
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

`npm test` runs seven things, none of which spend model tokens:

| Script | What it proves |
|---|---|
| `validate.mjs` | All 162 frontmatters parse and have descriptions; `profiles.ts`, `aliases.ts` and `package-info.ts` agree with `skills/` and `package.json`. |
| `test-search.mjs` | `sci_find`'s ranking, against the **real** 162 descriptions — including queries that must return *nothing*. Every check runs under both rankers (`bm25f`, the default, and `current`); bm25f's known misses are listed and reported, not checked. A floor: bm25f puts the target in the top 3 for at least 98% of the recorded first queries in `testing/find-rank/`. |
| `test-extension.mjs` | Command and startup behaviour against a stubbed `ExtensionAPI` with `PI_CODING_AGENT_DIR` at a throwaway dir. |
| `test-filter.mjs` | That **pi itself** honours the filter we write, via a real `DefaultPackageManager`. |
| `test-skill-expand.mjs` | That the `/skill:` block the input hook builds for a filtered-out skill is **byte-identical** to what pi builds for a loaded one, with `AgentSession.prototype._expandSkillCommand` as the oracle, across all 162 skills × 3 argument forms. Also that pi's `parseSkillBlock` reads it back, and that both sides agree on the miss cases. |
| `test-frontmatter.mjs` | That `extensions/frontmatter.ts` parses all 162 SKILL.md files and 13 edge cases the way pi's own parser does. |
| `test-live-lib.mjs` | The live harness's grading helpers on synthetic pi sessions: the read endpoint, the skill-seeking test and the timeout gate, the context and overflow measures, and how the conversation loop ends an attempt (`reached`, `gated`, `overflow`, `searched` under `first-find`, a provider error as `no-run`); the llama-server log parser and its join to pi's messages (`find-live-timing.mjs`); the paired statistics and the analysis set (`find-live-arms-report.mjs`); the choice-turn replay helpers, the replay's analysis set and validity rules (`find-live-replay.mjs`), the pooled analysis of two samples with its seeded cluster bootstrap (`find-live-replay-pooled.mjs`), and the first-search facts of `find-ab-report.mjs`. A wrong endpoint, gate, join, interval or analysis set still gives numbers in a live run, so it is checked here. |
| `test-tui-offer.py` | The first-run offer in pi's **real TUI**, driven through a pty: accepting writes the empty search-mode filter, declining and timing out write nothing. The only check that exercises the unstubbed accept path — and the only one that catches a missing `expandPromptTemplates`. Spends no tokens; needs a pty, so it is not in `npm test`. |
| `doc-count.mjs` | Not a suite — a helper each suite calls last, so the check counts the README quotes cannot silently rot. Added because they already had: five checks landed and the README still said 44. |
| `try-it.sh` | Not a test — a sandbox. Packs the tarball, seeds a throwaway `PI_CODING_AGENT_DIR` for one of five startup scenarios, and opens pi. `~/.pi/agent` is never touched, the credential copy is deleted on any exit, and it reports afterwards whether `settings.json` moved. `--check` asserts the scenario's message headlessly instead of opening the TUI. |

`npm run typecheck` (`scripts/typecheck.mjs`) is one more check, kept separate
from `npm test`: it runs real `tsc` against `extensions/*.ts`, using pi's own
shipped `.d.ts` files as the types for `@earendil-works/pi-coding-agent` and
`typebox` — the same declarations an installed pi actually exposes, not a
hand-written stub. Node's own loader only strips TypeScript syntax; it never
checks it, so a call like `ctx.ui.select(..., { timeout })` with one argument
too many for the local `UiContext` interface loads and runs regardless, and
only `tsc` catches it. The tsconfig is generated at runtime (`findPiDist()`
locates pi; `typeRoots` pins `@types/node` to pi's own copy, since a stray
`~/node_modules/@types/node` must not be picked up instead) and written to a
`mkdtempSync` directory that is removed afterward. TypeScript is not a
dependency of this package — there is no lockfile or `node_modules` to put it
in — so this script shells out to `npx --yes -p typescript@5 tsc`, which
downloads it into npm's cache on first run. That download is why it is its
own script and its own CI step rather than folded into `npm test`.

Three things are worth knowing before changing these:

- `resolve()` returns *all* resources with an `enabled` flag, so `.length` does
  not change when a filter applies. Count `resolve().skills.filter(s => s.enabled)`
  or the test proves nothing.
- `getAgentDir()` reads `PI_CODING_AGENT_DIR` on **every** call (`config.js:412-418`),
  so a single test process can point successive cases at different throwaway dirs.
- Since pi 0.84.x the `pi` binary is `dist/bundle/cli.js`, a single-file build
  with no `core/` beside it. `findPiDist()` steps up to the unbundled `dist/`
  when that is where `core/` lives; without that, every suite importing
  `core/*.js` by path fails with `ERR_MODULE_NOT_FOUND`. `PI_DIST` overrides it.

`scripts/test-find-live.mjs` is the release gate and is **not** in `npm test`
because it spends tokens. It installs the packed tarball into a throwaway agent
dir in search mode (no skill in the prompt) and asks a small model three
questions whose skills are not loaded, then checks the transcript for a `sci_find` call. If a weak model does
not reach for the tool, the tool description and `aliases.ts` are the fix — not
the test. It never copies `auth.json` into the throwaway dir: the model can
read anything there (Gemma 4 26B-A4B listed `../agent/auth.json` with `ls -R ..`,
2026-09-29). For a cloud model the harness reads the API key itself (from
`auth.json`, else `<PROVIDER>_API_KEY`) and holds it in a proxy on 127.0.0.1
(`scripts/lib/key-proxy.mjs`); the throwaway `models.json` points the provider
at that proxy with a placeholder key, and the proxy swaps in the real one on
the way upstream, in the auth header only (swapped in the path or another
header, the model could make the upstream echo the key back). Neither a deny rule for the file nor an environment variable
works instead: pi and its bash tool run under one sandbox profile, so a deny
would block pi too, and the bash tool inherits pi's whole environment. Without
a key pi fails every probe with "No API key found", so the harness separates
"never ran" from "declined". It copies `models.json` too, so a local provider
(Ollama, MLX) resolves, and for a cloud model `models-store.json`, pi's cached
model list, which holds no credentials.

The model keeps pi's default tools: restricting them to `read,sci_find` leaves
it little else to do but search, which inflates the score. Some probe tasks
invite real action ("review my screen activity"), and with bash a model will
try — an unsandboxed run once searched the whole home directory. So every pi
run happens under a macOS `sandbox-exec` profile (`scripts/lib/sandbox.mjs`):
reads and writes only inside that attempt's own directory (its agent-dir copy,
a fake `HOME`, `TMPDIR`, working directory and session file), the staged
package read-only, and the network limited to one loopback port: the local
provider's, or the key proxy's for a cloud provider. pi gets an allowlisted
environment, not the caller's, with no API keys: the model can run `printenv`,
and a shell environment carries tokens and paths into the real home. It also
sets `MPLBACKEND=Agg`: the profile does not fence the window server, and with
matplotlib's macOS backend a model's `plt.show()` opened windows on the
user's screen and blocked until someone closed them (2026-09-29).
The profile also denies programs that act through another process, outside the
sandbox: `launchctl` (launchd starts a loaded job unsandboxed), `open`,
`osascript`, `automator` and `shortcuts`, and it blocks Apple events. A model
asked for "a recurring check" tried `launchctl load` (parallel-web,
2026-09-23); it failed, probably on a wrong path. Limits that remain: the model
can reach its own inference server on the allowed port (one model sent itself
chat completions with `curl`); through the key proxy that bills the key but
does not show it. It can also see host process names (`pgrep`, `lsof`). `--no-sandbox` turns the profile off. Transcripts are written outside the sandbox,
so no attempt can read another's.

With `--probes testing/find-probes.json` it runs one supervised probe per skill
instead of the three built-in ones (`scripts/lib/converse.mjs`): 162
first-person tasks that never name their skill, each with a `target` and an
optional `accept` list of siblings that also fit. A probe is up to
`--attempts` (3) fresh conversations of up to `--responses` (5) model
responses. Between responses a blind persona (`scripts/lib/supervisor.mjs`,
`claude-opus-5-5` at low effort via the `claude` CLI) plays the scientist: it
answers follow-up questions and ends the conversation when the request is
answered. It sees only the task and the assistant's visible text — never the
target, the tool calls or `sci_find` output. The target *reaches* the model
when a `sci_find` result lists it, a bash command's output points at it, or a
file inside it is read; a result naming more than 20 skills is a catalogue dump
and counts for none. An attempt that ends without a reach is wiped and the
probe starts again. Grade: reached in attempt 1 = `success`, 2 =
`partial-success`, 3 = `functional`, never = `fail`, reported for the target
alone and for target-or-accepted. The harness polls the session while the
model works and stops the response the moment the target is reached
(`stoppedEarly`); nothing after that changes the grade. A response past
`--timeout` ends its attempt and the attempt counts. The limit is a budget per
response, not a loop detector — a slow local model can spend it on real work —
so each timeout is flagged and the summary counts the grades a timeout
touched. `no-run` and `supervisor-error` are harness
failures and never a grade. Persona replies that name a skill the assistant
never said, or nudge toward search, are flagged for review. `--results`
appends one JSON line per probe as it finishes and `--resume` skips graded
ones, so a long local-model batch survives a restart. `--offline` spends
nothing: it ranks each task's full text through `sci_find`'s own search, to
tell a vague probe or a search gap apart from a model that did not search.
`--prompt-skills none` (the default since 1.7.0, matching `/sci search`)
empties the skills filter, so no skill is listed in the system prompt and
`sci_find` is the only way in; `core` lists the Core profile, what
`/sci search` wrote before 1.7.0, where a listed skill can stand in for a
search. `all` sets no filter: every skill is listed, as in a normal install.
Each result line records which one ran; a line from before the option
existed counts as `core`.

Options for comparing configurations (added for the 2026-09-25 three-arm run,
[`testing/runs/2026-09-25-night-arms.md`](testing/runs/2026-09-25-night-arms.md)):

- `--no-extension` writes `extensions: []` into the package entry: pi loads the
  skills but not the extension, so there is no `sci_find`, no `/sci` and no
  input hook. Not `--exclude-tools sci_find`, which would leave the hook
  running.
- `--package-dir <dir>` packs another package tree (an older release from
  `git archive`), and `--package-label` records it on every line.
- `--endpoint read` moves the endpoint from "listed" to "read": the model read
  the target's SKILL.md with `read`, or printed it with bash (the command names
  `<target>/SKILL.md` and the output holds its `name:` line). With every skill
  in the prompt a listing proves nothing, so `--prompt-skills all` requires
  it. The first listing is still recorded (`listed`, `listedSeconds`).
- `--gate-calls <n>` ends an attempt as `gated`, a miss, once its first n tool
  calls hold no skill-seeking call (`sci_find`, or a `read` or bash call that
  touches a SKILL.md or a `/skills/` path segment). On 2026-09-23 every
  reaching attempt looked for a skill by its eighth call, and n = 10 would have
  ended 12 of 28 misses early (10 of them timeouts) and lost no reach.
- `--warmup` sends one ungraded request first, so the cold prefill of a large
  system prompt does not count against the first probe (llama.cpp keeps the
  prefix; pi's skills block comes before the working-directory line).
- `--archive-to <dir>` copies the transcripts and a tarball of the workspaces
  out of the temporary directory at the end.
- `--endpoint first-find` has no target: the attempt stops at the model's
  first `sci_find` call and ends as `searched`, with the query in `queries[0]`.
  It measures which query a model writes and how often it searches (with
  `--gate-calls`, an attempt with no search in its first n calls ends as
  `gated`). It needs `--attempts 1`. The queries are ranked offline.
- `--find-ranker <current|bm25f>` sets `PI_SCI_FIND_RANKER` for pi, and is
  recorded on every line. The default is `bm25f`, the package default since
  1.7.0. A package older than 5123f67 has no bm25f and runs `current`: pass
  `current` for it, so the lines record what ran.
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
`original`) with `--endpoint first-find --attempts 1`. It `git archive`s
`--ref` into `<dir>/src/` at the first start and runs from there; running it
again with the same `--out` continues (`--resume`). A local writer needs
`--health-url`, checked before each style. Each invocation archives into its
own time-stamped folder. `<dir>/src/scripts/find-panel-report.mjs <dir>...`
(the frozen copy, so the rankers match the run) reads
`results-<writer>-<style>.jsonl`: the search rate by outcome, then the target
in the top 8 for the first query of the first `sci_find` message, paired
bm25f − current (Newcombe method 10, McNemar exact) per writer and style.
Pooled rows repeat each target once per style, so they add a cluster
bootstrap by target. A writer with fewer than 50 searched attempts (30 in
the plain style, for the 4b rule) counts toward no rule. The union of that
message's queries and the raw request text are secondary rows.

Every attempt now also records the first request's prompt size (pi usage:
input + cacheRead + cacheWrite), peak context, output tokens, tool calls, the
index of the first skill-seeking call, pi's `compaction` entries and provider
overflow errors. A response that ends on an overflow pi could not recover from
ends its attempt as `overflow`. A response that ends on any other provider
error (the server died, an HTTP 500) is a harness error, `no-run`, not a
grade: `--resume` runs it again.

`scripts/find-live-arms.sh` runs several arms unattended. It `git archive`s
the two commits into `<out>/src/` at the start and runs only from there, so an
edit to the working tree cannot change an arm mid-run. It starts the model
server from a script you pass, checks it before each invocation and restarts
it once if it died, stops after three harness errors in a row, and runs under
`caffeinate`. Probes run in chunks (Core first, then a seeded shuffle); each
chunk runs every arm, with the order rotated per chunk, so a run stopped at a
chunk boundary is still balanced and paired. `--stop-after HH:MM` starts no
chunk after that time; the same `--out` continues on a later night.

`scripts/find-live-timing.mjs <out>` splits each attempt's time by the
server. It pairs every finished request in `llama-server.log` with the pi
message it produced: pi's `usage.input` is the prompt tokens llama.cpp
processed and `usage.output` the tokens it generated, and the clock offset is
fit from the pairs. Per attempt and warm-up it gives prefill and generation
seconds, tokens processed and cached, and the **queue wait**: the time from
pi's request to the server starting it. The queue wait exists because a stop
(reach or gate) kills pi, but llama.cpp finishes the prefill of the cancelled
request first, about 11 s (v16) to 17 s (`full`) on 2026-09-25. The next
attempt's first request waits for it, inside its recorded time to read.
`endpointSecondsNet` is the time to read without that wait. A stop can also
slow the next request's prefill (2026-09-25, whole night: `full` 44 against
78 tok/s, `v16` 93 against 110, `v17` no change);
that stays inside the net time, and `firstAfterStop` marks the attempts it
can touch. The script also prints prefill and generation tok/s by prompt
size per arm, without warm-ups and requests right after a stop. It needs the
archived session files: an invocation stopped by a signal archives nothing,
so its attempts are not timed.

`scripts/find-live-arms-report.mjs <out> [--timing <jsonl>]` gives the
pre-registered outcomes. The analysis set is the chunks with a results line
in every arm, less any probe with a harness error in any arm; an intersection
of finished probes would let a part-done chunk in. Per arm it gives the read
rate (Core and non-Core apart), how attempts ended, the context and output
medians, compactions and overflow errors. For `v17 − v16` (non-inferiority
at −5 points) and `v17 − full` it gives the paired difference with the
Newcombe method 10 interval and McNemar's exact test, for all probes, Core,
non-Core and without probe-invalid probes; the discordant probes with how the
miss ended; and the paired time to read on probes read in both arms. With
`--timing` (the `--jsonl` output of `find-live-timing.mjs`) it adds the
server-exact and queue-net times, labelled post hoc.

`scripts/find-ab.sh --out <dir> --models-json <file>` compares two package
commits (`--old-ref`, default 0a8ddfd, the last commit before the 3-then-5
search; `--new-ref`, default HEAD) through a cloud model (default Gemma 4
26B-A4B on OpenRouter). It `git archive`s both into `<dir>/src/` and runs the
harness and probes from `src/new`. The probes are paraphrase styles
(`--styles plain,expert`); each chunk of probe ids starts every arm × style
invocation at the same moment, so both arms of a probe meet the same provider
routing and load. A second pass retries the chunks with a harness error; the
same `--out` continues. `scripts/find-ab-report.mjs <dir>` gives the
read-rate difference new − old pooled over styles (Newcombe method 10, and a
bootstrap over probes, since the styles of one probe share a target), then
per style, among attempts that searched in both arms, and without
provider errors or timeouts. Per arm it gives the search rate, `sci_find`
calls, the first result's hits and characters, whether it listed the target,
the `limit` the model set, and the prompt tokens of the choice turn (the
request after the first result), from the archived session files.

`scripts/find-live-replay.mjs <run-dir> --out <dir>` replays one turn of a
finished run: the model response after the first `sci_find` result (the
choice turn). It cuts each recorded session after that result and writes two
copies: the recorded text (`full`), and the same hits rendered by the compact
format (`compact`). A parser gate first renders each recorded hit list again
in the full format and requires a byte-identical match. For each copy,
`scripts/lib/replay-worker.mjs` runs in a child process with its own `HOME`
and agent dir, opens the session with pi's SDK (`SessionManager.open`), and
continues the agent for one turn. Every tool is a stub that throws, and the
turn stops at the first assistant message (`--prove-stub` lets it reach
`turn_end` to show the stub ran). The runner needs the model server; it
checks `/health` from `models.json` and does not start the server.
`--dry-run` prepares every probe without it and prints the target's rank,
the recorded choices and the text sizes. `full` replays record prompt-token
parity with the recorded request. `scripts/find-live-replay-report.mjs <out>`
gives the pre-registered outcomes. The analysis set needs both variants ok,
parity, and the same system prompt and tool hashes within a probe (the
system prompt holds the recorded working directory, so it differs across
probes). A validity line compares the `full` replay with the recorded choice
before any comparison of the formats. `--flip-order` starts each probe with the other arm, for a
second sample. `scripts/find-live-replay-pooled.mjs <sample-1> <sample-2>`
pools two samples: validity per sample, then `compact` − `full` over the
(probe, sample) pairs with two intervals (Newcombe method 10, and a cluster
bootstrap over probes with a fixed seed); a verdict counts only when both
give it. `--variants full,bm25f` replaces `compact` with `bm25f`: each
`sci_find` call of the choice turn runs again through the extension's own
`runToolSearch` under `PI_SCI_FIND_RANKER=bm25f`, in the full format, with
the recorded package's paths. Before that, the same call under the current
ranker must reproduce the recorded result byte for byte, or the probe is an
error. `find-live-replay-report.mjs --variant bm25f` reports `bm25f` − `full`.

Two summary lines show recovery: the
response in which the target was reached, and every attempt split by when it
first called `sci_find` (response 1, later, never) with how many of each
reached the target. A late first search that still reaches is recovery inside
a conversation; a grade below `success` is recovery by a fresh attempt.

A fail can mean the probe, not the model, is wrong: the model answered the
request well without the skill. `scripts/lib/probe-check.mjs` checks each
graded probe, whatever its final grade, in which the persona ended an attempt
satisfied before any wanted skill reached the model. A judge (`--judge-model`, default
`claude-fable-5-1`, via the `claude` CLI) sees the task, the target's
SKILL.md and that attempt's conversation. It answers two questions: (a) did
the first request go unserved while the target could have served it in the
sandbox (drift the model caused), and (b) would the target have materially
improved the model's answer? Being on topic is not enough, and a yes must
name the concrete gap the target fills; an unnamed benefit counts as no. When
every judged attempt is no on both, the line gets `probeCheck.invalid`. It
keeps its raw grade, but the summary counts it as `probe-invalid`, leaves it
out of the grades and the recovery lines, and lists it with the judge's
reason as a probe to rewrite. A probe reached in its first attempt is never
audited, so a probe that did not need its skill but was searched at once
keeps its success: the summary therefore also prints the raw target line,
with each probe-invalid at its raw grade, and a report quotes both.
`scripts/check-probes.mjs <results.jsonl> --transcripts <dir> -o <file>`
runs the check again on a finished run from its kept transcripts (for a run
made before the check or its current rule, or with another judge), and
writes the latest line per probe with a fresh `probeCheck`. A judge failure is `check-error`: the grade stands and the
run goes on. Rewrites must make the skill necessary and must not name it.
Probes the model failed where the skill was needed are never rewritten, so
the score cannot drift upward through prompt edits. Each line records its
`task` text: `--resume` and the summary count a line only for the probe's
current wording, so a rewritten probe runs fresh. A probe with `untestable`
set (a skill that runs only on local state the sandbox cannot supply) loads
but never runs. Each run names it at the start, and `--only` refuses it.
`testing/README.md` records the criterion and each case.

## Port process (how a new upstream version lands)

1. `npm run sync:upstream` — fetches the latest upstream archive and replaces
   `skills/` wholesale. The script pins to the latest release tag when one
   exists, else falls back to `main`.
2. Read the sync script's `::warning::` output. It fetches upstream `main` and
   warns when `main` has moved past the tag just synced. When it has, decide
   whether to sync the tag as-is or move to a specific commit on `main`
   instead (`bash scripts/sync-upstream.sh <40-hex-sha>`) — the script accepts
   a SHA as well as a tag or `main`, and records it in `package.json` as
   `upstreamCommit` regardless of which ref was named.
3. `npm run validate` — checks every `SKILL.md` against pi's validation rules
   (below). Warnings are acceptable (pi is lenient); **missing descriptions are
   not** (pi refuses to load those skills).
4. Spot-check with pi: `pi -e .` then `-p` prompt asking the model to list
   available skills; verify a few names (e.g. `scanpy`,
   `pathogen-variant-surveillance`).
5. Bump `version` in `package.json` and `PACKAGE_VERSION` in
   `extensions/package-info.ts` to match — minor for a new upstream snapshot,
   patch for an extension-only fix (`scripts/validate.mjs` enforces the two
   agreeing; `upstreamVersion`, `upstreamCommit` and `licenseSha256` are
   already written by `scripts/sync-upstream.sh` in step 1). Never copy
   upstream's number into `version` (see Provenance for why). Update the
   upstream-version mentions in README.
6. Commit, push, `npm publish`, confirm with `npm view pi-scientific-skills version`,
   then tag `v<version>` (ours, e.g. `v1.1.0`) and push the tag. Publish before
   tagging: a failed publish must not leave a tag no registry has.

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

`scripts/sync-upstream.sh [tag|main|<40-hex-commit-sha>]`:

- Resolves the ref: the argument if given, else the latest upstream tag by
  semver, else `main`.
- Fetches that ref from upstream to a temp dir. A tag or `main` gets a shallow
  `git clone --depth 1 --branch`; a raw 40-hex commit SHA cannot be named that
  way (a shallow clone-by-branch does not accept one), so that case instead
  does `git init` + `git remote add` + `git fetch --depth 1 origin <sha>` +
  `git checkout -q FETCH_HEAD`.
- Aborts before touching `skills/` if the checkout has no `skills/` directory
  at all, or holds fewer than half as many skills as the current tree — a
  malformed ref, an interrupted clone, or an upstream layout change must not
  `rm -rf` the real thing on the strength of an empty or thin checkout.
- Strips the skills listed in `scripts/excluded-skills.txt` (one name per
  line, `#` comments and blanks ignored — today `docx`, `pdf`, `pptx`, `xlsx`,
  vendored upstream from anthropics/skills under a licence that forbids
  redistribution) from the clone's skill list before comparing or copying.
- Replaces `skills/` wholesale (`rm -rf` then copy), then deletes the excluded
  skills from the copy.
- Copies `LICENSE.md` byte-identical from the upstream checkout (no
  reformatting), and records its sha256 in `package.json`'s `licenseSha256` —
  `validate.mjs` hard-fails if the two ever disagree.
- Writes `upstreamVersion` (the tag this snapshot belongs to — resolved from
  the live tag list even when the ref given was a raw SHA) and `upstreamCommit`
  (the exact 40-hex commit SHA actually cloned, via `git rev-parse HEAD`) into
  `package.json`, via a `node -e` one-liner that reads the file, spreads it,
  and writes it back with two-space indent and a trailing newline — never
  `sed -i`, which cannot round-trip JSON safely.
- When the ref is a tag (not `main`, not a raw SHA), also fetches `main` to
  depth 50 and warns — never acts — if it is ahead: names the commit count and
  lists the commits with `git log --oneline`, says "at least 50 commits ahead"
  when the count reaches the edge of that shallow window, and reports a failed
  fetch of `main` separately instead of guessing at a distance. This is what
  caught upstream's `main` sitting 9 commits past `v2.69.0` while
  `plugin.json` still read `2.69.0` — a tag-based sync would have been a
  silent no-op with a new skill and two rewrites sitting on `main` unsynced.
- Prints how many skills were added and removed (by directory name) and lists
  them, for the changelog.
- Does **not** commit or bump `package.json`'s own `version` — it prints those
  as a manual next-steps reminder, along with a prompt to check any drift
  warning above before deciding whether to sync the tag as-is or move to a SHA
  on `main` instead.

## Validation script details

`scripts/validate.mjs` (no dependencies, Node ≥ 22.18):

- Walks `skills/**/SKILL.md`.
- Parses YAML frontmatter with a line-based parser covering the constructs this
  collection actually uses: plain scalars, quoted scalars, and block scalars
  (`>`/`|` with chomping and indent indicators). Nested mappings (`metadata:`)
  are consumed and skipped — none are validated. The fence-finding step copies
  pi's own algorithm (BOM strip, newline normalization, fence required at
  offset 0) rather than a permissive regex, and is checked field by field
  against pi's real parser by `scripts/test-frontmatter.mjs`.
- Reports violations of the table above; exits non-zero when a skill is missing
  its `description` (pi would refuse to load it) or when `extensions/profiles.ts`
  disagrees with `skills/`.
- Checks `extensions/aliases.ts`: every alias must name a real skill directory,
  no trigger phrase may be listed twice (a duplicate double-counts its boost and
  quietly distorts ranking), and no rule may expand to nothing.
- Hard-fails when `extensions/package-info.ts` disagrees with `package.json`. A
  stale `PACKAGE_VERSION` silently suppresses the upgrade notice for every user,
  which is the one promise a release makes; it must not be possible to ship that.
- Hard-fails when `package.json`'s `upstreamCommit` is not a 40-hex-char
  commit SHA, when its `licenseSha256` disagrees with `LICENSE.md`'s actual
  hash, or when any name in `scripts/excluded-skills.txt` exists as a
  directory under `skills/` — the sync script's own `rm -rf` is not the only
  way skills land there, and a manual `cp` from an upstream checkout bypasses
  it entirely.
- Hard-fails when README.md's own prose numbers disagree with reality: every
  "N skills" claim (except "N skills have been run") against the real
  catalogue size, and "N skills have been run" against the unique `PASS`
  count in `testing/ledger.json`. Neither number is hardcoded in the
  validator — both are read from the same files the suites already trust.
- Warns when `TOKENS_PER_SKILL` drifts more than 10% from what `skills/` now
  measures. It stays a constant because the picker needs a cost synchronously,
  before anything is on disk to measure — but every `/sci` figure derives from
  it, so silent drift turns honest guidance into confident nonsense. A warning,
  not a failure: the number is an estimate by construction. The measurement
  itself prefers a real tiktoken count via `python3` (`cl100k_base`, corpus
  fed in on a file descriptor, not `argv`) and falls back to the calibrated
  `CHARS_PER_TOKEN` ratio when `python3` or `tiktoken` is unavailable; either
  way it prints which mode ran.

The parser is **not** defined here. It lives in `extensions/frontmatter.ts` and
is shared with `search.ts`, which parses the same files at runtime to build the
`sci_find` catalogue. Two copies would drift, and the drift would be invisible —
validation would pass on files the runtime read differently. Importing it here
also exercises it against all 162 real files on every release.

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

npm strips `.gitignore` files from a package (and reads each one as ignore
rules for its directory), so the installed package lacks
`skills/autoskill/.gitignore`. Its three rules (`__pycache__/`, `*.pyc`,
`.pytest_cache/`) exclude nothing that ships. Harmless, and known.

### Uninstalling

Run `/sci reset` first, so the package's filter is cleared before you remove
it. After removing the package, two files under `~/.pi/agent/` can be deleted
by hand if you want them gone: the state file `pi-scientific-skills.json`, and
the one-time backup `settings.json.pi-scientific-skills.bak`.

## Functional testing

Two kinds of testing here, with very different costs:

- **Discovery** — does pi offer the skill, with the right name and description.
  Cheap, covers all 162, runs on every sync (`npm run validate` plus the tarball
  probe in the checklist below).
- **Functional** — does pi load the skill and does a model follow SKILL.md.
  Costs a model call and several minutes each, so it accumulates a few skills
  per release rather than ever being complete. The bar is whether pi sees and
  loads the skill. **Do not collect API keys, request Hub access, or download
  tool weights as part of testing.** If SKILL.md's next step needs a login or a
  large download, following it up to that point is a pass. An artifact is extra
  evidence when the skill produces one; it is not required.

`testing/ledger.json` is the record of the second kind. README's count of
skills run end to end derives from it; the per-release narrative is under "Run
record by release" below, and the caveats that used to sit on the README are
under "What pi does and does not enforce". The README is the landing page on
npm and GitHub and stays positive and short; this file is where the hedges live.

The README reports the search test with `deepseek/deepseek-v4-flash` (Core in
the prompt, three questions, `sci_find` called unprompted each time) for 1.1.0,
1.2.0, 1.3.0, 1.4.0 and 1.5.0 (1.4.1 has no entry). `extensionRuns` holds no
entry for that test with this model for 1.6.0 or 1.7.0. The 1.6.0 search test is the local-model run of 2026-09-23 (Ternary
Bonsai 2 27B, no skill in the prompt; report in `testing/report.md`).

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

### Run record by release

Model is `deepseek/deepseek-v4-flash` unless noted. Verdicts, timings and the
full notes, including every `harnessNote`, are in `testing/ledger.json`; the
scrubbed transcripts are beside them in `testing/transcripts/<version>/`.

- **1.0.0 (4):** `statistical-analysis`, `pathogen-variant-surveillance`,
  `experimental-design`, `scientific-visualization` (the last two under
  `z-ai/glm-5.2`; the first two's model was not recorded).
- **1.0.2 (6):** `ncats-arax` (live ARAX/TRAPI one-hop, imatinib → ABL1),
  `relsa-severity-assessment` (bundled cohort scored, KDE plot written),
  `etetoolkit` (ete4 Newick I/O, prune, reroot, Robinson-Foulds),
  `venue-templates` (Nature scaffold generated; the author-substitution regex is
  a rough edge, not a fail), `arbor` (HTR cycle via bundled `tree.py`; the merge
  gate correctly rejected a non-generalizing candidate), `deepspot-m` (pi
  offered it; the model loaded SKILL.md and followed the documented install
  path).
- **1.2.0 (6), including both skills new in v2.64.0:** `lab-hardware-cad`
  (bundled `check.py` ran; ANSI/SLAS standards listed and inspected with
  tolerances), `waypoint-bio` (PyPI package installed, `waypoint` CLI verified
  with all five subcommands, stopped correctly at the gated Hugging Face login),
  `networkx` (workflow steps 1–2 scripted and run), `generate-image` (bundled
  script listed 43 models over the documented no-key path), `pi-agent` (First
  Decision routing followed to the overview reference), `scikit-bio` (installed
  0.7.3 in a venv, Section 1 reverse-complement verified).
- **1.3.0 (9), including `rowan`, the skill that release changed:** `aeon`
  (installed 1.5.0 and ran the Quick Start RocketClassifier on GunPoint to 100%
  accuracy), `pkpd-modeling` (bundled `nca.py` ran a full non-compartmental
  analysis on a one-compartment oral profile), `bids` (wrote a valid
  `dataset_description.json` and the `sub-01/anat`, `sub-01/func` layout),
  `glycoengineering` (implemented and ran the documented N-X-S/T sequon scan on
  the IgG1 Fc example; the model's "N297" gloss mixes EU numbering with a
  fragment-local index, a rough edge, not a fail), `research-lookup` (installed
  the pinned `parallel-web-tools[cli]==0.7.1`), and four that stop at a
  documented credential or install gate: `rowan` (needs `ROWAN_API_KEY`),
  `scanpy`, `literature-review`, `dnanexus-integration`. Two of these runs
  installed packages onto the host rather than into the sandbox; see
  `harnessNote` in the ledger.
- **1.4.0 (6), none new in v2.66.0, which adds no skills:**
  `markdown-mermaid-writing` (status report written from the bundled template
  with a Mermaid timeline, footnote citations and the style guide's emoji rule),
  `pytdc` (SKILL.md's ephemeral `uv run` form listed all 27 ADME datasets from
  the metadata registry, no data download), `hypogenic` (bundled
  `validate_config.py` passed both the example run policy and the example task
  config, no model call), `cellxgene-census` (installed 1.17.0 and opened the
  2025-11-08 LTS Census: 217,768,036 cells, matching SKILL.md's figure; this run
  installed into the host's conda base env with `uv pip install --system`, a
  third `harnessNote`), and two that stop at a documented gate: `deeptools`
  (Quick Start step 1 script ran; no input BAM and no deepTools install) and
  `adaptyv` (`.env` check and SDK presence check, then the API-key gate).
- **1.4.1 (0):** a patch release. It carries the 1.4.0 grades above, the
  README rewrite that moved the caveats into this file, and a shorter
  upgrade notice for patch bumps. No skill changed, so nothing new was run.
- **1.5.0 (6), including both skills new since v2.66.0:** `datalad` (installed
  datalad 1.6.2 plus the git-annex PyPI wheel and ran the documented
  `datalad wtf` health check; this run installed into the host's conda base
  env with `uv pip install --system`, a fourth `harnessNote`),
  `folklore-variant-evidence` (the documented `tools/list` and the
  rs80357914 smoke test against the live api.helena.bio MCP endpoint, no
  credentials; the ambiguous outcome was reported and not auto-resolved,
  as SKILL.md's outcome table requires), `pymoo` (venv, bundled
  `single_objective_example.py` ran GA to convergence), `pydeseq2` (pinned
  0.5.4, Quick Start steps 1–2 on a toy count matrix; a fifth `harnessNote`,
  same `--system` cause), `gget` (venv, pinned 0.30.5, live Ensembl search for
  BRCA1 returned ENSG00000012048) and `pydicom` (venv, pinned 3.0.2, the
  "Read datasets safely" pattern on the package's own CT_small.dcm). Two of
  six runs wrote into the host again; the venv-per-run harness fix is still
  open. This release also carries the `/sci status` fix: under a filter the
  status line now states what `/skill:<name>` does instead of listing where
  pi's own paths still forward literal text; those stay under "Residual
  limits".
- **1.6.0 (6), including the one skill new in the main@49c6e97 sync and the
  two it updated:** `alphagenome` (new; read SKILL.md, ran the probe's
  one-command preflight, `pip show alphagenome`, package absent, then
  correctly stopped before the install step, one step short of the
  `ALPHAGENOME_API_KEY` gate — a free DeepMind key nobody has here, and
  getting one means creating a third-party account, which the probe rules
  forbid), `ontology-term-resolution` (bumped to 1.2; the bundled
  `resolve_terms.py` resolved "liver" to `UBERON:0002107` against the live
  OLS4 API, matching SKILL.md's own example), `genomic-intelligence` (bumped
  to 1.2; no `GI_API_KEY` set, so the model followed SKILL.md's keyless path
  and completed a live MCP handshake against the hosted demo; the server
  returned 15 tools, the 14 names SKILL.md gives for its MCP path plus
  `list_jobs`, which only `references/mcp.md` documents), `scikit-learn` (Quick Start's stratified split plus a
  `RandomForestClassifier` on iris, 0.900 test accuracy), `geniml` (ran the
  bundled, dependency-free `bed_validator.py --help` and got back the
  documented safety-gate contract; no real BED file in the sandbox to
  validate), and `torch-geometric` (installed 2.8.0.post1 against the
  existing PyTorch 2.13.0 and imported it; this run installed into the
  host's miniforge base env with `uv pip install --system`, a sixth
  `harnessNote`). alphagenome is graded PASS, not BLOCKED: SKILL.md's own
  Setup was followed as far as it goes before the credential gate, the same
  bar `rowan`, `adaptyv`, `scanpy`, `literature-review`, `dnanexus-integration`
  and `deeptools` were held to; nothing here claims the AlphaGenome Atlas
  itself was queried, only that pi loaded and followed the skill up to the
  key it does not have.
- **1.7.0 (0):** no skill batch. `skills/` is the same git tree as in 1.6.0
  (`786d69d`), so `test-batch` was not run, as in 1.4.1, and the count of
  skills run stays at 43. The release changes search, not skills. Three runs
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
  `69eea24` and `713d6e8`), before the fix commits that came after, so none of
  them ran the final tarball. **Still owed for 1.7.0:**
  `node scripts/test-find-live.mjs` on a small model, the tarball discovery
  probe from the publishing checklist, and `scripts/try-it.sh new --check` and
  `upgrading --check` on the packed tarball. None has been run against the
  final tarball.
- The other 119 have not been exercised here; they ship as upstream ships them.

### What pi does and does not enforce

- `allowed-tools` in a skill's frontmatter is inert in pi: there is no
  pre-approval gate, and no functional harm. Skills that need heavy Python
  stacks (scanpy, rdkit, torch, …) need those installed in the user's
  environment, as in any harness.
- Upstream notes that review depth varies by authorship: K-Dense-authored
  skills go through their internal review, while community-contributed skills
  are reviewed "to the best of our ability, but with limited resources", and
  upstream advises against enabling everything at once. This package ships the
  full snapshot; `/sci` (or `pi config`) is how a user narrows it to what they
  intend to run. An enabled skill is third-party code the user is choosing to
  execute.
- Upstream's own pytest battery passes on the byte-identical content. The
  2,512-test figure quoted in early releases was counted at v2.62.0; later
  upstream releases add suites for their new skills and it has not been
  re-counted, so upstream's CI badge is the current source.

## Adoption metrics

```bash
npm run metrics:downloads
```

Appends npm's daily download counts to `metrics/downloads.json`. Re-running is
safe: days merge by date, and a count that npm later revises is recorded in a
`revisions` array rather than silently overwritten — the recent tail is
provisional and the ledger should show that rather than hide it.

The ledger is gitignored, so it lives on one machine and no clone will have it.
The local copy exists because npm's range endpoint only serves ~18 months and
offers no way to ask what it said last week. Anything older than that window is
gone if the file is; back it up off-repo if the deep tail is worth keeping. Two things to keep in mind when
reading the series: npm counts **tarball fetches, not people**, so mirrors, CI
caches and registry scrapers are in the same bucket; and a publish-day spike is
almost certainly automated traffic. At 1.0.2 the series was 278 downloads over
12 days, 242 of them on publish day.

Neither this nor the ledger is a quality measure. They are here so that later
claims about adoption and coverage have something behind them.

## Publishing checklist

- [ ] `npm test` clean — validation plus the six offline suites (search,
      extension, filter, skill-expand, frontmatter and live-lib; requires an
      installed pi; they load the extension through pi's own jiti)
- [ ] Read `sync-upstream.sh`'s main-ahead warning. When upstream `main` has
      moved past the tag, sync a SHA on `main` instead of the stale tag
      (`bash scripts/sync-upstream.sh <40-hex-sha>`) — a tag-based sync would
      otherwise be a silent no-op while real changes sit unsynced on `main`.
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
- [ ] Checked `sync-upstream.sh`'s drift warning (if it printed one) before
      deciding whether to sync the tag as-is or re-run against a SHA on `main`
      instead — a tag can sit behind `main` for weeks without its own version
      bump, and the warning is the only thing that says so
- [ ] git commit + push, PR merged to `main` (GitHub)
- [ ] `npm publish` from `main` (requires npm login) → gallery auto-lists via
      `pi-package` keyword; confirm with `npm view pi-scientific-skills version`
      or the npm registry keyword endpoint
- [ ] tag `v<version>` on the published commit and push the tag — after the
      publish is confirmed, never before (v1.1.0 sat untagged once; a tag with
      no registry version is worse)
