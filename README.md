# pi-scientific-skills

A pi package bundling **159 scientific and research Agent Skills** for the [pi coding agent](https://pi.dev). Ported from [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) (MIT), which implements the open [Agent Skills](https://agentskills.io/) standard that pi supports natively.

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

After install, all 159 skills are available. When a task matches, pi loads the skill on demand; you can also force one:

```bash
/skill:scanpy             # single-cell RNA-seq analysis
/skill:scientific-writing # papers, reports, proposals
/skill:pathogen-variant-surveillance
```

List installed packages with `pi list`, and enable/disable individual skills with `pi config`.

## `/sci` — pick what you load

All 159 skill descriptions sit in the system prompt at startup: pi's progressive
disclosure keeps descriptions always in context and loads only the skill *bodies*
on demand. Measured, that index costs **~18k tokens**. That's over half a 32k
context window, and more than an 8k window can hold at all. On a small local
model it's the difference between usable and unusable.

`pi config` can already toggle skills one at a time. `/sci` puts a curated
profile layer on top so you don't have to do that 159 times:

```bash
/sci            # interactive menu
/sci search     # recommended — load Core, reach the rest on demand
/sci find <q>   # search all 159 by what you're trying to do
/sci status     # what's active now, and what it costs
/sci profiles   # jump straight to the picker
/sci all        # re-enable everything
/sci none       # disable all skills from this package
/sci reset      # forget saved profiles, re-enable everything
```

### Search mode — the recommended setup

Choosing a profile means betting on what you'll need before the work starts.
When the bet is wrong, the skill you needed is simply invisible.

`/sci search` removes the bet. It loads the ten Core skills — **~1.1k tokens
instead of ~18k** — and the model reaches everything else through a `sci_find`
tool that searches all 159 by description and returns the path to load:

```
> I have a sorted BAM and need to call variants from it

  sci_find("variant calling from a bam file")
    → pysam, pathogen-variant-surveillance, genomic-intelligence …
  read .../skills/pysam/SKILL.md
```

That's the same two-step pi already uses for skills — descriptions first, body
on demand — pushed one level further, so narrowing what's always loaded no
longer means making anything unreachable.

`sci_find` is registered whether or not you run `/sci search`, so it works
alongside any profile, and `/sci find` runs the same search for you. Verified
against a small model (deepseek-v4-flash), not just a frontier one — the whole
point is the low end.

**One caveat.** With any filter active, `/skill:<name>` for a filtered-out skill
fails *silently*: pi doesn't recognise the name and passes the literal text
through to the model instead of erroring. Use `/sci find` or ask in plain
language and let `sci_find` do it. `/sci status` repeats this warning.

Ten profiles: Core, Genomics & Bioinformatics, Scientific ML & Data Science,
Writing/Literature/Presentation, Single-Cell Omics, Drug Discovery, Clinical &
Translational, Physics/Astronomy/Materials/Earth, Bioimaging & Neuroscience, and
Lab Operations. An eleventh toggle, `pi-agent`, covers the pi harness itself.
Each field profile is standalone: the data-acquisition skills a field needs
live in that field's profile, so you never enable a second profile just to fetch
your own data.

The picker is a checkbox list. Arrows move, **space** toggles, **a** selects all,
**n** clears, **enter** applies, **esc** cancels. It shows the live token cost as
you toggle:

```
Scientific skills — 12/159 skills, ~1.4k tokens, saves ~16.6k
```

`/sci` writes a normal per-package filter into your `~/.pi/agent/settings.json`:

```json
{ "packages": [ { "source": "pi-scientific-skills", "skills": ["scanpy", "pysam"] } ] }
```

So it composes with `pi config` instead of replacing it. Fine-tune there
afterward and `/sci status` will tell you it did. No `SKILL.md` is ever modified,
so `npm run sync:upstream` can't clobber your selection, and uninstalling the
extension leaves your settings working.

Overrides you wrote by hand (`!pattern`, `+path`, `-path`) are preserved. The one
exception is disabling everything (`/sci none`, or applying an empty selection),
which has to write an empty list and can't carry them. If your settings are
malformed, or a project-local `.pi/settings.json` would override the global one,
`/sci` names the file and refuses to write rather than guess.

Nothing is written unless you ask for it. On a first run `/sci` *offers* search
mode and does nothing if you decline, escape, or ignore it. On an upgrade it
tells you once what changed and leaves your selection exactly as it was — your
`settings.json` is not touched by an upgrade you didn't ask for.

## What's inside

159 skills across scientific domains — bioinformatics & genomics, cheminformatics & drug discovery, proteomics, clinical research & precision medicine, medical imaging, ML/AI & deep learning, materials science, physics & astronomy, engineering & simulation, data analysis & visualization, geospatial science, laboratory automation, scientific communication (writing, slides, schematics, posters), research methodology (grants, critical thinking, scholar evaluation), and 100+ database lookups (PubMed, ChEMBL, UniProt, COSMIC, ClinicalTrials.gov, and more).

Each skill directory ships `SKILL.md` (frontmatter + instructions) and, where useful, `references/` (on-demand docs), `scripts/` (helper code), and `assets/` (templates). Pi implements the Agent Skills standard, so discovery and on-demand loading work exactly as with Claude Code / Cursor / Codex.

## Tested in pi

What's actually been tested, with the numbers:

- **Discovery & validation — all 159:** every skill is offered to the model in pi with the correct name and description, checked against the packed tarball; frontmatter passes a validator that reimplements pi's rules (0 warnings, 0 hard issues). The four omitted Anthropic skills are confirmed absent in the same run.
- **Functional runs — 16 of 159.** Record in `testing/ledger.json` (in the repo; not shipped in the npm package). Four at 1.0.0: `statistical-analysis`, `pathogen-variant-surveillance`, `experimental-design`, `scientific-visualization` (the last two under `z-ai/glm-5.2`; the first two's model was not recorded). Six at 1.0.2 under `deepseek/deepseek-v4-flash`: `ncats-arax` (live ARAX/TRAPI one-hop, imatinib → ABL1), `relsa-severity-assessment` (bundled cohort scored, KDE plot written), `etetoolkit` (ete4 Newick I/O, prune, reroot, Robinson-Foulds), `venue-templates` (Nature scaffold generated; the author-substitution regex is a rough edge, not a fail), `arbor` (HTR cycle via bundled `tree.py`; merge gate correctly rejected a non-generalizing candidate), `deepspot-m` (pi offered it; the model loaded SKILL.md and followed the documented install path). Six at 1.2.0 under the same model, including both skills new in v2.64.0: `lab-hardware-cad` (bundled `check.py` ran; ANSI/SLAS standards listed and inspected with tolerances), `waypoint-bio` (PyPI package installed, `waypoint` CLI verified with all five subcommands, stopped correctly at the gated Hugging Face login), `networkx` (workflow steps 1–2 scripted and run), `generate-image` (bundled script listed 43 models over the documented no-key path), `pi-agent` (First Decision routing followed to the overview reference), `scikit-bio` (installed 0.7.3 in a venv, Section 1 reverse-complement verified). The other 143 have not been exercised here, so take them as upstream ships them.
- **`/sci` and `sci_find` — automated, on every change:** 49 behavioural checks against a stubbed pi (`/sci search` writes the Core filter and preserves hand-written `!pattern` overrides; a seeded prior-version config leaves `settings.json` byte-identical; malformed settings refuse without writing), 29 ranking checks against the real 159 descriptions including four queries that must return *nothing*, and 7 checks that **pi itself** honours the filter, run through a real `DefaultPackageManager`. The first-run offer is additionally driven through **pi's real TUI** over a pty: accepting writes Core's 10 skills, declining and timing out write nothing at all. To try any of it by hand, `npm run try` opens this package in a throwaway pi — your own `~/.pi/agent` is never touched.
- **Search mode against a small model — 3 of 3.** With only Core loaded, `deepseek/deepseek-v4-flash` was asked three questions whose skills were not in its prompt (call variants from a BAM, cluster a 10x matrix, dock a ligand). It called `sci_find` unprompted every time, got a correct skill back, and read the `SKILL.md`. Re-run against the 1.2.0 tarball with the same result. Recorded under `extensionRuns` in `testing/ledger.json`. The probes never name the skill — that's the whole test.
- **Skill assets (upstream's suite, not run in pi):** upstream's own pytest battery passes on the byte-identical content. The 2,512-test figure quoted in earlier releases was counted at v2.62.0; upstream releases since then add suites for their new skills, and I have not re-counted, so treat upstream's CI badge as the current source.

Upstream notes that review depth varies by authorship: K-Dense-authored skills go through their internal review, while community-contributed skills are reviewed "to the best of our ability, but with limited resources" — and upstream advises against enabling everything at once. This package ships the full v2.64.0 snapshot, so `/sci` (or `pi config`) is how you narrow it to what you actually intend to run. Treat an enabled skill as third-party code you are choosing to execute.

Caveats: `allowed-tools` is inert in pi (no pre-approval gate; no functional harm). Skills requiring heavy Python stacks (scanpy, rdkit, torch, …) need those installed in your environment — same as any harness.

## Updating

The skills here are a snapshot of upstream at **v2.64.0**. This package's own
version is separate — it starts at 1.0.0 and tracks changes to *this*
distribution, since the contents differ from upstream (159 skills, plus `/sci`)
and upstream ships patch releases that would collide. The upstream tag a given
release wraps is always recorded in `package.json` as `upstreamVersion`.

As a user, get a newer snapshot by reinstalling:

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

## Contributing

If you use pi and something here could work better in it, please open an issue or
a PR. Two things I'd especially like:

- **pi-specific adaptations.** These skills were written for the Agent Skills
  standard in general, not for pi. If a skill trips over something in the pi
  harness, or its frontmatter and tool expectations could be tuned to fit pi
  better, I want to hear about it.
- **`/sci` profiles.** The ten field profiles are a first guess at how scientists
  group their work, put together by one researcher and a language model. If your
  field is served badly by them — wrong bundle, missing skill, a profile you'd
  have to enable two of — say so.

**Improvements to a skill's actual content should go upstream**, to
[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills).
`skills/` here is a byte-identical snapshot, and
`npm run sync:upstream` replaces it wholesale, so a fix patched in here would
disappear on my next sync. Upstream it sticks, helps every other harness too,
and flows back here on its own. If a pi-specific change can't go upstream, open
it here and I'll carry it as a clearly marked local addition.

### On future additions of my own

I may add skills of my own here over time — things that come out of my research
and seem worth sharing. If I do:

- They won't go in `skills/`. That directory stays upstream's. Mine will live in
  a separate directory registered as its own root (pi's `skills` field accepts
  several), so you can tell them apart from the file tree.
- Each one will name its author in its frontmatter, and I'll list them here.
- The counts in this README will stay separate, so "159 skills from upstream"
  doesn't quietly drift into "159 skills" of mixed origin.

None exist yet. **All 159 skills shipped today are upstream's.**

## License & Credits

- The collection is © 2025 **K-Dense Inc.**, MIT — see [LICENSE.md](LICENSE.md) (upstream text verbatim). This package is an independent distribution of [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills); **all credit for the skills goes to the upstream maintainers and their community contributors.** Nothing in `skills/` is this maintainer's work — it is a byte-identical snapshot. If you use this in a project or publication, please cite upstream using the formats in their [Citation section](https://github.com/K-Dense-AI/scientific-agent-skills#-citation) — the collection, plus each individual skill that contributed to your work.
- Many skills were contributed to upstream by **third-party authors**, credited in each skill's `metadata.skill-author` frontmatter field (pointing at the field rather than listing names here, so credit cannot drift out of date on a sync). A few declare their own terms for the skill text: `what-if-oracle` is CC BY-NC-SA 4.0 (**non-commercial**, © AHK Strategies), `bids` and `depmap` are CC BY 4.0, and `pacsomatic` ships its own `LICENSE` (MIT, © 2026 Beifang Niu). Check that field before commercial or redistributive use. Note that on skills wrapping a library, the `license:` field records *that library's* license (e.g. `cobrapy: GPL-2.0`), not the license of the skill text. One of those wrapped tools is itself non-commercial: `deepspot-m` documents the DeepSpot-M package (PolyForm Noncommercial 1.0.0) and its gated Hugging Face weights (CC BY-NC-SA 4.0). The skill text is MIT like the rest; the tool it drives is not, so check before commercial use.
- **Not included:** upstream also vendors Anthropic's `docx`, `pdf`, `pptx` and `xlsx` skills. Their licence reserves all rights and forbids redistribution to third parties, so this package deliberately omits them — that is the only difference from upstream's `skills/`. Get them from Anthropic directly. (`pptx-posters` is K-Dense's own skill and *is* included.)
- Pi packaging, the `/sci` extension, and maintenance by **[danieldoesbio](https://github.com/danieldoesbio)** — © 2026, MIT, same terms as above. This covers `extensions/` and `scripts/` only; `LICENSE.md` is reproduced unmodified from upstream and governs the bundled skills.

### How this port was made

I started by downloading the K-Dense repository and the pi extensions page as
source material. The porting itself was done by
**`deepseek/deepseek-v4-flash-0731`** running under a **`moonshotai/kimi-k3`**
advisor. Initial testing in pi used **`z-ai/glm-5.2`**. A final pass in
**Claude Code** with **Opus 5** handled the licence review, documentation, and
release prep.

I directed the work and made the calls, and I'm responsible for what shipped.
The packaging and the `/sci` extension are largely model-written, so I'd rather
say that outright. None of it touched `skills/`.

### Built with the pi ecosystem

Put together while leaning on other people's pi packages, all of which shaped
this one:
[`pi-subagents`](https://www.npmjs.com/package/pi-subagents),
[`pi-lens`](https://www.npmjs.com/package/pi-lens),
[`pi-web-access`](https://www.npmjs.com/package/pi-web-access),
[`pi-memory`](https://www.npmjs.com/package/pi-memory),
[`context-mode`](https://www.npmjs.com/package/context-mode),
[`pi-markdown-preview`](https://www.npmjs.com/package/pi-markdown-preview), and
[`@juicesharp/rpiv-advisor`](https://www.npmjs.com/package/@juicesharp/rpiv-advisor).
Thanks to everyone building in this space.

---

I've gotten a lot of use out of these K-Dense skills while working on my own research. I personally want to thank them for curating the list and everyone who contributed to it so far!!!

— [danieldoesbio](https://github.com/danieldoesbio)
