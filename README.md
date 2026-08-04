# pi-scientific-skills

A pi package bundling **158 scientific and research Agent Skills** for the [pi coding agent](https://pi.com). Ported from [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) (MIT), which implements the open [Agent Skills](https://agentskills.io/) standard that pi supports natively.

Use pi as an AI scientist: single-cell RNA-seq, drug discovery, protein design, medical imaging, clinical research, ML/AI, statistics, physics, geospatial analysis, scientific writing, grant proposals, and more — with curated, version-pinned documentation and helper scripts for each domain.

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

After install, all 158 skills are available. When a task matches, pi loads the skill on demand; you can also force one:

```bash
/skill:scanpy             # single-cell RNA-seq analysis
/skill:scientific-writing # papers, reports, proposals
/skill:pathogen-variant-surveillance
```

List installed packages with `pi list`, and enable/disable individual skills with `pi config`.

## What's inside

158 skills across scientific domains — bioinformatics & genomics, cheminformatics & drug discovery, proteomics, clinical research & precision medicine, medical imaging, ML/AI & deep learning, materials science, physics & astronomy, engineering & simulation, data analysis & visualization, geospatial science, laboratory automation, scientific communication (writing, slides, schematics, posters), research methodology (grants, critical thinking, scholar evaluation), and 100+ database lookups (PubMed, ChEMBL, UniProt, COSMIC, ClinicalTrials.gov, and more).

Each skill directory ships `SKILL.md` (frontmatter + instructions) and, where useful, `references/` (on-demand docs), `scripts/` (helper code), and `assets/` (templates). Pi implements the Agent Skills standard, so discovery and on-demand loading work exactly as with Claude Code / Cursor / Codex.

## Updating

The skills in this package are a snapshot of upstream at v2.62.0. To refresh from upstream:

```bash
npm run sync:upstream   # pulls the latest scientific-agent-skills release and replaces skills/
npm run validate        # pi-rule frontmatter check across all skills
```

See [DOCUMENTATION.md](DOCUMENTATION.md) for the port process, sync procedure, and validation rules.

## License & Credits

- The bundled skills are © 2025 **K-Dense Inc.**, MIT — see [LICENSE.md](LICENSE.md) (upstream text verbatim). This package is an independent distribution of [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills); all credit for the collection goes to the upstream maintainers. If you use this in a project or publication, consider citing upstream: `K-Dense Inc. Scientific Agent Skills. https://github.com/K-Dense-AI/scientific-agent-skills`.
- The `docx`, `pdf`, `pptx`, and `xlsx` skills are created and maintained by **Anthropic**, vendored from [anthropics/skills](https://github.com/anthropics/skills) under their own terms — see each skill's `LICENSE.txt`.
