# Search mode — `sci_find` (v1.1.0)

The model-facing half of progressive disclosure. `/sci` profiles let a *human*
narrow the index ahead of time; `sci_find` lets the *model* reach the rest on
demand, so narrowing no longer means making skills unreachable.

Default it enables: **Core (10 skills, ~1.1k tokens) instead of all 157 (~18k)**,
with all 157 still reachable. `/sci search` applies it. See
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
  among 8 labelled options, badly among 157 in a prompt. Hence OR-scoring —
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
<name>` (v1.2.0), NOT 157 shadow commands.

## Testing

`npm test` = validate + `test-search` + `test-extension` + `test-filter`, no
tokens, but **requires an installed pi** (all load through pi's jiti via
`scripts/lib/load-extension.mjs`). `scripts/test-find-live.mjs` is the release
gate and spends tokens — see `mem:functional-testing`.
