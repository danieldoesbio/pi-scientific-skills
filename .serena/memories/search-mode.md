# Search mode — `sci_find` (v1.1.0)

The model-facing half of progressive disclosure. `/sci` profiles let a *human*
narrow the index ahead of time; `sci_find` lets the *model* reach the rest on
demand, so narrowing no longer means making skills unreachable.

Default it enables: **Core (10 skills, ~1.1k tokens) instead of all 159 (~18k)**,
with all 159 still reachable. `/sci search` applies it. See
`mem:project-overview` for why the index cost is the binding constraint.

## Shape

| File | Role |
|------|------|
| `extensions/search.ts` | catalogue (lazy, cached), ranking, `resolveSkillsDir()` |
| `extensions/aliases.ts` | 32 curated query→skill rules, 67 targets |
| `extensions/frontmatter.ts` | the ONE YAML parser — shared with `validate.mjs` |
| `extensions/package-info.ts` | `PACKAGE_NAME` / `PACKAGE_VERSION`, guarded against drift |

`runFind` (the human `/sci find`) collapses onto the same `runToolSearch` the
tool uses, so a human and a model can never see different answers.

## Rules that are load-bearing, not taste

- **Recall beats precision.** `sci_find` need not pick the right skill, only get
  it into a list of 8 with full descriptions. Small models discriminate well
  among 8 labelled options, badly among 159 in a prompt. Hence OR-scoring —
  AND-matching returns nothing for "variant calling".
- **Never a confident wrong answer.** Below `MIN_SCORE` return nothing.
  Matching is **word-boundary, not substring**: substring matching scored
  `open-notebook` for "book a flight to paris".
- **Every alias must come from an observed miss**, never imagination. Speculative
  aliases make results worse. `validate.mjs` hard-fails on aliases naming a
  missing skill, on duplicate trigger phrases, and on rules expanding to nothing.
- **No second settings write path.** `/sci search` goes through the existing
  `commitPlan` → `applyToSettings`, so the empty-array footgun handling stays
  single-sourced.

## Startup messaging — the promise this release makes

The user's explicit constraint: *any difference for existing users must be made
explicit on first load.* Enforced by `scripts/test-extension.mjs`.

- New user → **offered** (recommended answer first, 20s timeout). Escape,
  timeout and decline all write nothing. Answer recorded *before* acting.
- Existing user → **told, never asked.** `settings.json` **byte-identical**
  before and after; asserted directly, because nothing weaker proves it.
- Hand-filtered user (filter present, no config) → **also told.** `sci_find`
  reaches past their filter; shipping that silently would change what they chose.
- Gate the dialog on **`ctx.mode === "tui"`, not `hasUI`** (true in RPC too).
- Report via **`report()`, not `ctx.ui.notify`** — notify is a no-op with no UI
  bound, so a `pi -p` user would be informed into the void and marked as told.
  Same reason the `session_start` handler is NOT gated on `ctx.hasUI`.

## Facts verified against pi 0.84.2 (do not re-derive)

- `import.meta.url` **survives jiti** — rewritten to the module's own path.
  `join(dirname(fileURLToPath(import.meta.url)), "..", "skills")` is correct.
  Guarded by an actual `SKILL.md` check; no skills found → tool not registered.
- `ctx.mode` is populated at `session_start`: `bindExtensions` sets it
  (`agent-session.js:1746`), applies it (`:1805`), *then* emits (`:1761`).
- `resources_discover` is **additive-only and cannot filter at all**
  (`runner.js:891-926` → `resource-loader.js:229-255` merges). DOCUMENTATION.md
  previously gave the right verdict on a false premise; corrected in 1.1.0.
- `getAgentDir()` reads `PI_CODING_AGENT_DIR` on **every** call
  (`config.js:412-418`) — one test process can isolate many cases.
- Filter semantics, measured via a real `DefaultPackageManager`: `[]` → 0
  enabled; `["!scanpy"]` alone → 156 (inverts to "everything minus"); Core → 10.

## Known trade-off

`/skill:<name>` for a filtered-out skill fails **silently** —
`_expandSkillCommand` (`agent-session.js:953-961`) misses and passes the literal
text through. Disclosed in `/sci status` and README. Real fix is `/sci use
<name>` (v1.3.0 at the earliest), NOT 159 shadow commands.

## Testing

`npm test` = validate + `test-search` + `test-extension` + `test-filter`, no
tokens, but **requires an installed pi** (all load through pi's jiti via
`scripts/lib/load-extension.mjs`). `scripts/test-find-live.mjs` is the release
gate and spends tokens — see `mem:functional-testing`.


## pi fact: `sendUserMessage` will not run a command by default

`pi.sendUserMessage(text, opts)` defaults `expandPromptTemplates` to **false**
(`agent-session.js:1130`). `prompt()` defaults the same flag to **true**
(`:793`), and extension-command dispatch is gated on it (`:799`).

So `sendUserMessage("/sci search", { deliverAs: "followUp" })` sends the literal
string to the model as a user message. Shipped that way, accepting the first-run
offer wrote nothing and burned a turn. Always pass
`expandPromptTemplates: true` when the text is a command.

The accept path routes through the command at all because `session_start` emits
with the plain context (`runner.js:579`), which has no `reload()`; only the
*command* context gets one (`:567`).

Caught by asserting the **options** passed to `sendUserMessage`, not just the
text — the text assertion passes either way. `scripts/test-tui-offer.py` drives
pi's real TUI over a pty and fails if the flag is removed; it is the only check
that exercises the unstubbed path.

## Trying it by hand: `scripts/try-it.sh`

`npm run try [scenario] [--check|--keep]`. Packs the tarball, seeds a throwaway
`PI_CODING_AGENT_DIR`, launches pi, then reports whether `settings.json` moved.
`~/.pi/agent` is never written to; isolating the agent dir also isolates auth,
so auth.json/models-store.json are copied at 0600 and removed by an EXIT trap
along with the whole sandbox.

Five scenarios, one per startup branch in `handleStartup`:
`mine` (your real config, pointed at this build) · `new` (first-run offer) ·
`upgrading` (1.0.2 + a saved profile → notice, filter untouched) ·
`filtered` (hand-filtered, never ran /sci → "your filter is unchanged") ·
`current` (already told about this version → silence).

`upgrading`/`filtered` read the genomics-bioinformatics profile out of
profiles.ts via the jiti loader rather than hardcoding a skill list — a seeded
filter /sci could not have written would be testing a fiction.

`--check` runs pi headless and asserts the branch's message, so the four notice
paths are verifiable without a human reading a screen. It costs one tiny model
call (pi will not start a turn without a model); `$CHECK_MODEL` overrides the
deepseek-v4-flash default. All five verified PASS on 2026-08-18.
