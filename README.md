# pi-scientific-skills

A pi package bundling **154 scientific and research Agent Skills** for the [pi coding agent](https://pi.dev). Ported from [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) (MIT), which implements the open [Agent Skills](https://agentskills.io/) standard that pi supports natively.

Use pi as an AI scientist: single-cell RNA-seq, drug discovery, protein design, medical imaging, clinical research, ML/AI, statistics, physics, geospatial analysis, scientific writing, grant proposals, and more — with curated, version-pinned documentation and, where useful, helper scripts.

## Install

```bash
pi install npm:pi-scientific-skills
# or from source
pi install git:github.com/danieldoesbio/pi-scientific-skills
```

Try without installing:

```bash
pi -e npm:pi-scientific-skills
```

After install, all 154 skills are available. When a task matches, pi loads the skill on demand; you can also force one:

```bash
/skill:scanpy             # single-cell RNA-seq analysis
/skill:scientific-writing # papers, reports, proposals
/skill:pathogen-variant-surveillance
```

List installed packages with `pi list`, and enable/disable individual skills with `pi config`.

## `/sci` — pick what you load

All 154 skill descriptions sit in the system prompt at startup, because pi's
progressive disclosure keeps descriptions always-in-context and loads only the
skill *bodies* on demand. Measured, that index costs **~17k tokens** — over
half a 32k context window, and more than an 8k window can hold at all. On a
small local model that is the difference between usable and unusable.

`pi config` can already toggle skills one at a time. `/sci` puts a curated
profile layer on top so you don't have to do that 154 times:

```bash
/sci            # interactive menu
/sci status     # what's active now, and what it costs
/sci profiles   # jump straight to the picker
/sci all        # re-enable everything
/sci none       # disable all skills from this package
/sci reset      # forget saved profiles, re-enable everything
```

Ten profiles — Core, Genomics & Bioinformatics, Scientific ML & Data Science,
Writing/Literature/Presentation, Single-Cell Omics, Drug Discovery, Clinical &
Translational, Physics/Astronomy/Materials/Earth, Bioimaging & Neuroscience, and
Lab Operations. An eleventh toggle, `pi-agent`, covers the pi harness itself.
Each field profile is standalone: the data-acquisition skills a field needs
live in that field's profile, so you never enable a second profile just to fetch
your own data. The picker is a checkbox list — arrows move, **space** toggles,
**a** selects all, **n** clears, **enter** applies, **esc** cancels — and it
shows the live token cost as you toggle:

```
Scientific skills — 12/154 skills, ~1.3k tokens, saves ~15.6k
```

`/sci` writes a normal per-package filter into your `~/.pi/agent/settings.json`:

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy", "pysam"] } ] }
```

That means it composes with `pi config` rather than replacing it — fine-tune
there afterward and `/sci status` will tell you it did. No `SKILL.md` is ever
modified, so `npm run sync:upstream` cannot clobber your selection, and
uninstalling the extension leaves your settings working. Overrides you wrote by
hand (`!pattern`, `+path`, `-path`) are preserved — except when you disable
everything (`/sci none`, or applying an empty selection), which has to write an
empty list and cannot carry them. `/sci` refuses to write —
naming the file — rather than guess, if your settings are malformed or a
project-local `.pi/settings.json` would override the global one.

## What's inside

154 skills across scientific domains — bioinformatics & genomics, cheminformatics & drug discovery, proteomics, clinical research & precision medicine, medical imaging, ML/AI & deep learning, materials science, physics & astronomy, engineering & simulation, data analysis & visualization, geospatial science, laboratory automation, scientific communication (writing, slides, schematics, posters), research methodology (grants, critical thinking, scholar evaluation), and 100+ database lookups (PubMed, ChEMBL, UniProt, COSMIC, ClinicalTrials.gov, and more).

Each skill directory ships `SKILL.md` (frontmatter + instructions) and, where useful, `references/` (on-demand docs), `scripts/` (helper code), and `assets/` (templates). Pi implements the Agent Skills standard, so discovery and on-demand loading work exactly as with Claude Code / Cursor / Codex.

## Tested in pi

Verified end-to-end in pi — not just packaged:

- **Discovery & validation:** all 154 skills load into the pi system prompt with correct name/description/location; frontmatter passes pi's validation rules (0 warnings, 0 hard issues).
- **Functional runs:** representative skills executed successfully in pi — `statistical-analysis` (ran its assumption-check script, correct decision path), `pathogen-variant-surveillance` (live GenSpectrum API query, real data), `experimental-design` (ran `randomization.py`, correct stratified allocation), `scientific-visualization` (rendered a 300-DPI figure via the skill's own export helper). Tested with a DeepSeek-class model and with GLM-5.2.
- **Skill assets (upstream's suite, not run in pi):** upstream's own pytest battery passes 2,512 tests on the byte-identical content.

Upstream notes that review depth varies by authorship: K-Dense-authored skills go through their internal review, while community-contributed skills are reviewed "to the best of our ability, but with limited resources" — and upstream advises against enabling everything at once. This package ships the full v2.62.0 snapshot, so `/sci` (or `pi config`) is how you narrow it to what you actually intend to run. Treat an enabled skill as third-party code you are choosing to execute.

Caveats: `allowed-tools` is inert in pi (no pre-approval gate; no functional harm). Skills requiring heavy Python stacks (scanpy, rdkit, torch, …) need those installed in your environment — same as any harness.

## Updating

The skills here are a snapshot of upstream at v2.62.0. As a user, get a newer
snapshot by reinstalling:

```bash
pi install npm:pi-scientific-skills
```

Maintainers re-vendor from upstream by cloning this repo (`scripts/` is not shipped
in the package) and running:

```bash
npm run sync:upstream   # pulls the latest scientific-agent-skills release and replaces skills/
npm run validate        # pi-rule frontmatter check across all skills
```

See [DOCUMENTATION.md](DOCUMENTATION.md) for the port process, sync procedure, and validation rules.

## License & Credits

- The collection is © 2025 **K-Dense Inc.**, MIT — see [LICENSE.md](LICENSE.md) (upstream text verbatim). This package is an independent distribution of [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills); **all credit for the skills goes to the upstream maintainers and their community contributors.** Nothing in `skills/` is this maintainer's work — it is a byte-identical snapshot. If you use this in a project or publication, please cite upstream using the formats in their [Citation section](https://github.com/K-Dense-AI/scientific-agent-skills#-citation) — the collection, plus each individual skill that contributed to your work.
- Many skills were contributed to upstream by **third-party authors**, credited in each skill's `metadata.skill-author` frontmatter field (pointing at the field rather than listing names here, so credit cannot drift out of date on a sync). A few declare their own terms for the skill text: `what-if-oracle` is CC BY-NC-SA 4.0 (**non-commercial**, © AHK Strategies), `bids` and `depmap` are CC BY 4.0, and `pacsomatic` ships its own `LICENSE` (MIT, © 2026 Beifang Niu). Check that field before commercial or redistributive use. Note that on skills wrapping a library, the `license:` field records *that library's* license (e.g. `cobrapy: GPL-2.0`), not the license of the skill text.
- **Not included:** upstream also vendors Anthropic's `docx`, `pdf`, `pptx` and `xlsx` skills. Their licence reserves all rights and forbids redistribution to third parties, so this package deliberately omits them — that is the only difference from upstream's `skills/`. Get them from Anthropic directly. (`pptx-posters` is K-Dense's own skill and *is* included.)
- Pi packaging, the `/sci` extension, and maintenance by **[danieldoesbio](https://github.com/danieldoesbio)** — © 2026, MIT, same terms as above. This covers `extensions/` and `scripts/` only; `LICENSE.md` is reproduced unmodified from upstream and governs the bundled skills.
