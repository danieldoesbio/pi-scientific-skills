/**
 * Curated skill profiles for the pi-scientific-skills package.
 *
 * Data only. The taxonomy is reproduced verbatim from the package's published
 * curation so that the profile ids persisted in a user's config keep meaning the
 * same thing across releases: renaming an id silently invalidates saved selections.
 *
 * Nothing here touches skills/ on disk — profiles are applied by filtering the
 * package entry in settings.json, never by editing SKILL.md frontmatter.
 */

/** A named bundle of skills a user can switch on or off as a unit. */
export interface SkillProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly skills: readonly string[];
}

/** A skill deliberately left out of every profile, with the reason why. */
export interface UnassignedSkill {
  readonly skill: string;
  readonly reason: string;
}

/** Every skill shipped by the package. Used for the "vs. all skills" delta. */
export const TOTAL_SKILL_COUNT = 159;

/**
 * Measured cost of one skill's name + description in the system prompt:
 * 65,455 chars across 157 skills ~= 18k tokens ~= 113 tokens per skill.
 * Descriptions stay in context permanently, so this is a per-session floor.
 */
export const TOKENS_PER_SKILL = 113;

/** Context cost of loading the package unfiltered. */
export const BASELINE_TOKEN_COST = TOTAL_SKILL_COUNT * TOKENS_PER_SKILL;

/** The ten field profiles, in menu order. */
export const PROFILES: readonly SkillProfile[] = [
  {
    id: "core",
    label: "Core (recommended)",
    description:
      "Stats, EDA, figures, dataframes, literature and writing — the dozen skills nearly every scientific user reaches for regardless of field.",
    skills: [
      "exploratory-data-analysis",
      "statistical-analysis",
      "polars",
      "scientific-visualization",
      "matplotlib",
      "experimental-design",
      "scientific-writing",
      "citation-management",
      "paper-lookup",
      "scientific-critical-thinking",
    ],
  },
  {
    id: "genomics-bioinformatics",
    label: "Genomics & Bioinformatics",
    description:
      "NGS day: reads, alignments, variants, genomic intervals, bulk RNA-seq, phylogenies, gene/variant databases and pipeline orchestration.",
    skills: [
      "pysam",
      "biopython",
      "scikit-bio",
      "genomic-coordinates",
      "polars-bio",
      "gtars",
      "geniml",
      "tiledbvcf",
      "deeptools",
      "bulk-rnaseq",
      "pydeseq2",
      "pathway-enrichment",
      "pacsomatic",
      "pathogen-variant-surveillance",
      "genomic-intelligence",
      "waypoint-bio",
      "onekgpd",
      "phylogenetics",
      "etetoolkit",
      "gget",
      "bioservices",
      "cobrapy",
      "depmap",
      "ontology-term-resolution",
      "database-lookup",
      "nextflow",
      "statsmodels",
    ],
  },
  {
    id: "ml-data-science",
    label: "Scientific ML & Data Science",
    description:
      "Model-building day: scikit-learn to PyTorch, transformers, GNNs, RL, forecasting and explainability, plus scaling out to big data and GPUs.",
    skills: [
      "scikit-learn",
      "pytorch-lightning",
      "transformers",
      "torch-geometric",
      "hugging-science",
      "shap",
      "umap-learn",
      "aeon",
      "timesfm-forecasting",
      "stable-baselines3",
      "pufferlib",
      "pymoo",
      "arbor",
      "dask",
      "vaex",
      "zarr-python",
      "polars",
      "optimize-for-gpu",
      "modal",
      "get-available-resources",
      "statsmodels",
      "pymc",
      "seaborn",
      "networkx",
    ],
  },
  {
    id: "scholarly-communication",
    label: "Writing, Literature & Presentation",
    description:
      "Manuscript-and-deadline day: systematic search, reference management, drafting, peer review, grants, slides, posters, diagrams and document conversion.",
    skills: [
      "literature-review",
      "research-lookup",
      "exa-search",
      "pyzotero",
      "citation-management",
      "scientific-writing",
      "peer-review",
      "scholar-evaluation",
      "research-grants",
      "venue-templates",
      "scientific-slides",
      "pptx-posters",
      "latex-posters",
      "markitdown",
      "liteparse",
      "markdown-mermaid-writing",
      "scientific-schematics",
      "infographics",
      "generate-image",
      "open-notebook",
      "hypothesis-generation",
      "scientific-brainstorming",
    ],
  },
  {
    id: "single-cell-omics",
    label: "Single-Cell Omics",
    description:
      "scanpy-centric day: AnnData objects, QC to UMAP, batch correction and integration, RNA velocity, regulatory networks, cytometry and public census data.",
    skills: [
      "scanpy",
      "anndata",
      "scvi-tools",
      "scvelo",
      "cellxgene-census",
      "deepspot-m",
      "arboreto",
      "umap-learn",
      "pydeseq2",
      "pathway-enrichment",
      "flowio",
      "lamindb",
      "zarr-python",
      "dask",
      "polars",
      "seaborn",
      "scikit-learn",
      "ontology-term-resolution",
      "gget",
      "bioservices",
    ],
  },
  {
    id: "drug-discovery",
    label: "Drug Discovery & Computational Chemistry",
    description:
      "Med-chem and structural-biology day: molecules in and out, docking, molecular dynamics, protein models, mass spec, ADMET/PK and hosted modeling platforms.",
    skills: [
      "rdkit",
      "datamol",
      "medchem",
      "molfeat",
      "deepchem",
      "torchdrug",
      "pytdc",
      "diffdock",
      "molecular-dynamics",
      "rowan",
      "tamarind",
      "esm",
      "glycoengineering",
      "biopython",
      "pkpd-modeling",
      "depmap",
      "primekg",
      "ncats-arax",
      "matchms",
      "pyopenms",
      "shap",
      "scikit-learn",
      "pymoo",
    ],
  },
  {
    id: "clinical-translational",
    label: "Clinical & Translational Research",
    description:
      "Patient-data day: EHR and cohort modeling, survival analysis, PK/PD, DICOM, biomedical/regulatory evidence lookup and safety-bounded clinical documentation.",
    skills: [
      "pyhealth",
      "scikit-survival",
      "clinical-decision-support",
      "clinical-reports",
      "treatment-plans",
      "pkpd-modeling",
      "pydicom",
      "imaging-data-commons",
      "paperclip",
      "iso-standards-readiness",
      "analytical-method-validation",
      "statsmodels",
      "statistical-power",
      "pymc",
      "scikit-learn",
      "shap",
      "primekg",
      "ncats-arax",
      "database-lookup",
      "pathogen-variant-surveillance",
    ],
  },
  {
    id: "physical-sciences",
    label: "Physics, Astronomy, Materials & Earth Science",
    description:
      "Simulation-and-instrument day: symbolic and numerical math, quantum stacks, CFD/PIV, materials structures, astronomy, geospatial and remote sensing, with units and uncertainty tracked.",
    skills: [
      "astropy",
      "qiskit",
      "cirq",
      "pennylane",
      "qutip",
      "sympy",
      "matlab",
      "uncertainty-and-units",
      "fluidsim",
      "openpiv",
      "simpy",
      "pymatgen",
      "molecular-dynamics",
      "geomaster",
      "geopandas",
      "networkx",
      "pymoo",
      "dask",
      "zarr-python",
      "optimize-for-gpu",
      "modal",
      "get-available-resources",
      "statsmodels",
    ],
  },
  {
    id: "imaging-neuroscience",
    label: "Bioimaging & Neuroscience",
    description:
      "Pixels-and-signals day: BIDS datasets, spike sorting, physiological time series, whole-slide pathology and radiology images, and the array stack that carries them.",
    skills: [
      "bids",
      "neuropixels-analysis",
      "neurokit2",
      "pydicom",
      "imaging-data-commons",
      "histolab",
      "pathml",
      "deepspot-m",
      "omero-integration",
      "zarr-python",
      "dask",
      "aeon",
      "umap-learn",
      "scikit-learn",
      "pytorch-lightning",
      "optimize-for-gpu",
      "networkx",
      "statsmodels",
      "seaborn",
    ],
  },
  {
    id: "lab-operations",
    label: "Lab Operations, Automation & Platforms",
    description:
      "Bench-and-core-facility day: ELN/LIMS and protocol systems, liquid handlers and cloud labs, instrument and image data management, compute platforms and compliance evidence.",
    skills: [
      "benchling-integration",
      "labarchive-integration",
      "protocolsio-integration",
      "opentrons-integration",
      "pylabrobot",
      "ginkgo-cloud-lab",
      "adaptyv",
      "lab-hardware-cad",
      "omero-integration",
      "lamindb",
      "dnanexus-integration",
      "latchbio-integration",
      "nextflow",
      "iso-standards-readiness",
      "analytical-method-validation",
      "relsa-severity-assessment",
      "flowio",
      "pyopenms",
      "matchms",
      "uncertainty-and-units",
      "ontology-term-resolution",
      "database-lookup",
      "get-available-resources",
      "statistical-power",
    ],
  },
];

/**
 * Skills held out of every profile. Kept as data (not deleted) so the reasoning
 * is auditable and so a future release can promote one without archaeology.
 */
export const UNASSIGNED: readonly UnassignedSkill[] = [
  {
    skill: "pi-agent",
    reason:
      "About the pi harness itself (installing pi, providers, authoring skills/extensions/packages), not a scientific skill. Highly relevant to this package's own audience — surface it as a standalone toggle in the picker rather than burying it in a field profile.",
  },
  {
    skill: "autoskill",
    reason:
      "Requires a screenpipe daemon on localhost:3030 to observe the user's screen, with no fallback, so it fails for essentially every user. Continuous screen observation is a privacy decision a user must make explicitly; it must never arrive as a profile default.",
  },
  {
    skill: "hypogenic",
    reason:
      "Thin planning/audit wrapper around one academic package (ChicagoHAI HypoGeniC/HypoRefine) that explicitly disclaims manual hypothesis work. hypothesis-generation and scientific-brainstorming in scholarly-communication cover the same moment for everyone else.",
  },
  {
    skill: "consciousness-council",
    reason:
      "Generic multi-perspective 'Mind Council' deliberation on any question or creative challenge. Not scientific method; duplicates scientific-brainstorming and scientific-critical-thinking with weaker evidence bounds.",
  },
  {
    skill: "what-if-oracle",
    reason:
      "Generic branch/scenario ideation (best/likely/worst/wild case) with no scientific scoping. Same ground as scientific-brainstorming, which is already in scholarly-communication.",
  },
  {
    skill: "dhdna-profiler",
    reason:
      "Extracts 'cognitive patterns and thinking fingerprints' from arbitrary text. No scientific workflow fits it and its scientific standing is questionable.",
  },
  {
    skill: "bgpt-paper-search",
    reason:
      "Vendor MCP service for paper search. paper-lookup (11 literature APIs, in core) plus literature-review and paperclip already cover this; a fourth search vendor is pure token cost for users without a BGPT account.",
  },
  {
    skill: "paperzilla",
    reason:
      "Proprietary recommendation/chat feed requiring a Paperzilla account. Redundant with paper-lookup and research-lookup for everyone else.",
  },
  {
    skill: "parallel-web",
    reason:
      "Parallel CLI web search/enrichment. research-lookup already wraps Parallel and exa-search covers general scientific web search; keeping all three loaded is duplicate capability.",
  },
  {
    skill: "usfiscaldata",
    reason:
      "U.S. Treasury Fiscal Data REST API — federal financial data. Not a scientific-research skill; off-topic for every profile.",
  },
  {
    skill: "market-research-reports",
    reason:
      "Business market sizing (TAM/SAM/SOM) and forecast scenario decks. Commercial analysis, not scientific research.",
  },
];

/**
 * Held-out skills that still deserve a one-click toggle. pi-agent is about the
 * harness itself rather than any scientific field, so it belongs to no profile —
 * but it is the single most useful skill for someone configuring pi, which is
 * exactly what they are doing when this picker is open.
 */
export const STANDALONE_SKILL_IDS: readonly string[] = ["pi-agent"];

/**
 * Toggle ids are persisted, so standalone skills are namespaced to guarantee they
 * can never collide with a profile id added by a later release.
 */
export const STANDALONE_ID_PREFIX = "skill:";

/** Standalone skills rendered as single-skill pseudo-profiles in the picker. */
export const STANDALONE_PROFILES: readonly SkillProfile[] = STANDALONE_SKILL_IDS.map(
  (skill) => ({
    id: `${STANDALONE_ID_PREFIX}${skill}`,
    label: skill,
    description:
      UNASSIGNED.find((entry) => entry.skill === skill)?.reason ?? "",
    skills: [skill],
  }),
);

/** Everything the picker can toggle: field profiles first, standalone skills last. */
export const TOGGLES: readonly SkillProfile[] = [...PROFILES, ...STANDALONE_PROFILES];

/**
 * Inert default export. Pi discovers extensions as `extensions/*.ts` as well as
 * `extensions/*\/index.ts`, so this data module may be loaded as an extension in
 * its own right. Registering nothing keeps that harmless instead of erroring on a
 * missing default export.
 */
export default function noopExtension(): void {}
