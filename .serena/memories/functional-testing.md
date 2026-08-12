# Functional testing and adoption metrics

Two testing tiers, deliberately unequal. See `mem:sync-and-divergence` for the
pi invocation traps that shaped the harness.

| Tier | Covers | Cost | Where |
|------|--------|------|-------|
| Discovery / frontmatter | all 157, every sync | seconds | `npm run validate` + tarball probe |
| Functional (skill actually run) | 4–8 per release, accumulating | model call + minutes each | `npm run test:batch` |

As of 1.0.2: **10 of 157** PASS. TIMEOUT rows are harness faults and do not
count. README's "Functional runs — N of 157" counts PASS. The bar is whether
pi sees and loads the skill. **Do not collect API keys, request Hub access, or
download tool weights.** Following SKILL.md up to a documented login/download
step is PASS.

## The batch harness

`scripts/test-batch.mjs`. User convention: **test another 4–8 at random every
update.**

```bash
npm run test:batch -- --version <ver> --include <skills-new-this-release>
node scripts/test-batch.mjs --version <ver> --distill-only   # rebuild summaries, no tokens
```

- Batch = `--include` + random fill to `--size` (default 6) from skills never
  given a conclusive verdict. TIMEOUT stays in the pool. Seeded by version
  string (FNV-1a + mulberry32).
- Packed tarball in a scratch dir, one skill per run (`-ne -ns --skill <dir>`).
- Per-skill sandbox is **wiped before each run**. Scratch is keyed only on
  version; the arbor re-run at 1.0.2 otherwise resumed a killed first attempt.
- stdout is a **file descriptor**, not a pipe. `--mode json` emits a cumulative
  `message_update` per token; `maxBuffer` SIGTERM'd arbor at 67 MB.
- Raw `.jsonl` is gitignored (MB-scale, embeds `$HOME` and the username).
  Committed record is scrubbed `<skill>.summary.json`.
- Distiller pairs results on `toolCallId`, never tool name. Name-matching
  stapled pip output onto a `find` call. Read the model's VERDICT from
  distilled `finalText` only — matching the raw stream catches the probe prompt.
- Script does **not** grade. Grade from tool results: was the skill offered,
  was SKILL.md loaded, did the model follow it.

Pin `deepseek/deepseek-v4-flash`. Avoid `~deepseek-v4-flash-latest`.

## Ledger verdicts

PASS / FAIL / BLOCKED / TIMEOUT. **BLOCKED and TIMEOUT are not skill failures.**
Never fold either into a pass rate.

1.0.0 PASS: `statistical-analysis`, `pathogen-variant-surveillance` (model
unrecorded), `experimental-design`, `scientific-visualization` (`z-ai/glm-5.2`).
1.0.2 under `deepseek/deepseek-v4-flash`: PASS `ncats-arax`, `relsa-severity-assessment`,
`etetoolkit`, `venue-templates` (author-regex rough edge, report upstream),
`arbor`, `deepspot-m` (pi loaded SKILL.md; install path followed).

## Adoption metrics

`npm run metrics:downloads` → `metrics/downloads.json`. Merge by date; npm
revisions go into `revisions[]`. npm counts **tarball fetches, not people**.
First snapshot 2026-08-12: 278 over 12 days, 242 on publish day (1.0.0 and
1.0.1 both landed 2026-08-06).

Neither ledger nor metrics ships in the npm tarball (`files[]` is `extensions`,
`skills`, three markdown files). They do reach `pi install git:github.com/...`.
