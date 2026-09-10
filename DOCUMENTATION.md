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
- **Upstream version:** 2.66.0 (from `pyproject.toml`), recorded in
  `package.json` as `upstreamVersion`
- **Our version is independent of upstream's.** This package uses its own semver
  line starting at 1.0.0. It deliberately does *not* mirror the upstream number:
  the two artifacts differ (159 skills vs upstream's 163, plus the `/sci`
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
package ships 159 skills and not upstream's 163. `scripts/sync-upstream.sh`
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
skills/                 # 159 skill directories, each with SKILL.md (+ references/scripts/assets)
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
scripts/test-search.mjs # sci_find ranking against the real 159 descriptions
scripts/test-extension.mjs   # command + startup behaviour against a stubbed ExtensionAPI
scripts/test-filter.mjs # that pi itself honours the filter we write
scripts/test-skill-expand.mjs  # the /skill: block we build is byte-identical to pi's, oracle = pi's own method
scripts/test-tui-offer.py    # pi's real TUI, driven through a pty (no tokens)
scripts/try-it.sh       # launch this branch in a throwaway pi, to try it by hand
scripts/test-find-live.mjs   # release gate: does a small model reach for sci_find? (spends tokens)
scripts/test-batch.mjs  # run 4-8 skills for real in pi, capture transcripts for grading
scripts/track-downloads.mjs  # append npm daily counts to metrics/downloads.json
testing/ledger.json     # which skills have actually been RUN, with verdicts (+ extensionRuns)
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

## The `/sci` extension

### Why it exists

Pi injects every skill's name and description into the system prompt at startup;
only skill *bodies* are deferred. Measured across this collection: 65,455
description characters ≈ **17,700 tokens**, ≈113 tokens per skill. That is 54% of
a 32k context and more than an 8k context can hold. Pi is frequently run with
small local models, so the index cost — not the skill content — is the binding
constraint.

Two distinct problems follow, and the profile design addresses both: the context
budget, and selection accuracy (a small model discriminates poorly among 159
similar descriptions, many of which are near-neighbours).

### Why it writes settings.json rather than filtering at runtime

Four mechanisms could filter skills. Only one is compatible with this port:

| Mechanism | Verdict |
|---|---|
| `disable-model-invocation: true` in frontmatter | **Rejected.** Edits `SKILL.md`, breaking byte-identity with upstream, and `sync-upstream.sh` replaces `skills/` wholesale — every sync would silently wipe the user's selection. |
| Intercept `resources_discover` and return filtered `skillPaths` | **Impossible**, not merely undesirable — see below. |
| `before_agent_start` returning a rewritten `systemPrompt` | **Rejected.** Would strip the skills index while leaving pi's registry intact — the only route that preserves `/skill:<name>`. But it is per-turn prompt surgery, fragile across pi versions, and invisible to `pi config`. |
| Set `disableModelInvocation` on the live `Skill[]` at runtime (via `ctx.getSystemPromptOptions().skills` or `before_agent_start`'s `systemPromptOptions`, both returned by reference) | **Rejected (decided at 1.4.0).** This is the one pi feature whose semantics match "hide from the prompt, keep `/skill:`": `formatSkillsForPrompt` (`skills.js:276`) is the only consumer of the flag, and pi's own comment says such skills "can only be invoked explicitly via /skill:name". But it requires **all 159 to load** so `/skill:` can resolve, which means abandoning the `settings.json` filter entirely. That costs `pi config` composition, hand-editability, and survival of extension removal — and `pi config` would then show all 159 enabled while the prompt carried 10, actively misreporting rather than merely not knowing. |
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

The filter is the documented object form (`settings.md`):

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy"] } ] }
```

### Search mode — progressive disclosure for the model (v1.1.0)

Profiles solve the context budget for the **human**: you pick a field before the
work starts. They do nothing for the **model**, and a profile is a bet — when it
is wrong, the skill the scientist needed is invisible.

`sci_find` closes that half. It loads no skills; it searches all 159 names and
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
  and someone running all 159 still benefits from looking a skill up by need
  rather than by name. `/sci status` says so.
- **Recall beats precision.** `sci_find` does not have to pick the right skill,
  only get it into a list of eight with full descriptions attached. Even a small
  model discriminates well among eight labelled options and badly among 159 in a
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
- **The catalogue is read lazily from disk** (~18ms for 159 files, head 8KB
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
all 159 loaded, which means giving up the `settings.json` filter and having
`pi config` misreport. Recorded there so it is not re-derived.

**The stopgap.** An `input`-event handler in `extensions/index.ts`. `prompt()`
runs extension commands, then `emitInput`, then `_expandSkillCommand`, then
`expandPromptTemplate` (`agent-session.js:802-831`), with nothing touching the
text in between; pi's `docs/extensions.md` shows a literal "intercept skill
commands before expansion" example on this hook. The handler:

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
all 159 skills × 3 argument forms: 477 of 477 identical at 1.4.0. It is
circular on one axis — both sides read the same `skills/` — so it proves string
fidelity, not that pi's package manager resolves the same path for an installed
copy. `validate.mjs` guards the three content invariants the handler depends
on and a sync could break: frontmatter `name` equals the directory name (the
handler keys on the directory; pi uses `frontmatter.name || dirname`), no body
contains `<skill ` or `</skill>` (pi's `parseSkillBlock` is non-greedy and
would truncate), and the `disable-model-invocation` count (0, informational).

**Residual limits.** Narrowed, not closed. Every one of these is disclosed in
`/sci status` or the README, because replacing a disclosed bug with an
undisclosed partial fix would repeat the original mistake:

1. **`steer()` and `followUp()` bypass the hook.** Both call
   `_expandSkillCommand` directly with no `emitInput` (`agent-session.js:995`,
   `:1012`). Reached from `interactive-mode.js` (`flushCompactionQueue`, lines
   3640-3680: on the retry branch every queued message bypasses; on the normal
   branch the first goes through `prompt()` and the rest bypass) and from
   `rpc-mode.js:322,326` (RPC `steer` and `follow_up`, unconditionally). So a
   `/skill:<filtered>` typed while compaction is running, or sent as an RPC
   steer, still forwards literal text. Not closable from the input hook.
2. **No autocomplete.** `interactive-mode.js:520` builds the `/skill:`
   completion list from `getSkills().skills` only. The user types the name
   from `/sci find` output.
3. **Only this package's skills.** The defect is global; another package's
   filtered skills, or a skill disabled through `pi config` in another
   package, still leak literal text. This covers 159 names out of an open set.
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

`npm test` runs five things, none of which spend model tokens:

| Script | What it proves |
|---|---|
| `validate.mjs` | All 159 frontmatters parse and have descriptions; `profiles.ts`, `aliases.ts` and `package-info.ts` agree with `skills/` and `package.json`. |
| `test-search.mjs` | `sci_find`'s ranking, against the **real** 159 descriptions — including four queries that must return *nothing*. |
| `test-extension.mjs` | Command and startup behaviour against a stubbed `ExtensionAPI` with `PI_CODING_AGENT_DIR` at a throwaway dir. |
| `test-filter.mjs` | That **pi itself** honours the filter we write, via a real `DefaultPackageManager`. |
| `test-skill-expand.mjs` | That the `/skill:` block the input hook builds for a filtered-out skill is **byte-identical** to what pi builds for a loaded one, with `AgentSession.prototype._expandSkillCommand` as the oracle, across all 159 skills × 3 argument forms. Also that pi's `parseSkillBlock` reads it back, and that both sides agree on the miss cases. |
| `test-tui-offer.py` | The first-run offer in pi's **real TUI**, driven through a pty: accepting writes Core, declining and timing out write nothing. The only check that exercises the unstubbed accept path — and the only one that catches a missing `expandPromptTemplates`. Spends no tokens; needs a pty, so it is not in `npm test`. |
| `doc-count.mjs` | Not a suite — a helper each suite calls last, so the check counts the README quotes cannot silently rot. Added because they already had: five checks landed and the README still said 44. |
| `try-it.sh` | Not a test — a sandbox. Packs the tarball, seeds a throwaway `PI_CODING_AGENT_DIR` for one of five startup scenarios, and opens pi. `~/.pi/agent` is never touched, the credential copy is deleted on any exit, and it reports afterwards whether `settings.json` moved. `--check` asserts the scenario's message headlessly instead of opening the TUI. |

Two things are worth knowing before changing these:

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
   Provenance for why). Update the upstream-version mentions in README.
5. Commit, push, `npm publish`, confirm with `npm view pi-scientific-skills version`,
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
also exercises it against all 159 real files on every release.

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
  Cheap, covers all 159, runs on every sync (`npm run validate` plus the tarball
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
- The other 128 have not been exercised here; they ship as upstream ships them.

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

- [ ] `npm test` clean — validation plus the four offline suites (requires an
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
- [ ] git commit + push, PR merged to `main` (GitHub)
- [ ] `npm publish` from `main` (requires npm login) → gallery auto-lists via
      `pi-package` keyword; confirm with `npm view pi-scientific-skills version`
      or the npm registry keyword endpoint
- [ ] tag `v<version>` on the published commit and push the tag — after the
      publish is confirmed, never before (v1.1.0 sat untagged once; a tag with
      no registry version is worse)
