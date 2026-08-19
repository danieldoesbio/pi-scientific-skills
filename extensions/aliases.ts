/**
 * Curated query aliases for `sci_find`.
 *
 * Upstream descriptions are written for humans who already know the tool's
 * name. A scientist asks for "variant calling"; `pysam`'s description says
 * "VCF/BCF" and never once says "variant". Ranking cannot bridge that on its
 * own, so the gaps are bridged here, by hand, with evidence.
 *
 * Every entry must come from an observed miss — a query that returned nothing
 * useful against the real descriptions — not from imagination. Adding aliases
 * speculatively makes results worse, because each one injects extra terms that
 * dilute genuine hits.
 *
 * `scripts/validate.mjs` hard-fails if any `skills:` entry names a directory
 * that no longer exists, so an upstream rename cannot silently rot this file.
 */

/** One alias rule: trigger phrases, plus what they should search for. */
export interface Alias {
  /** Phrases that activate this rule, matched against the normalized query. */
  readonly match: readonly string[];
  /** Extra search terms injected into the query. Scored like typed terms. */
  readonly terms?: readonly string[];
  /** Skill directory names to surface directly. Validated to exist on disk. */
  readonly skills?: readonly string[];
}

export const ALIASES: readonly Alias[] = [
  // --- genomics / variants -------------------------------------------------
  {
    match: ["variant calling", "variant caller", "call variants", "variants", "variant"],
    terms: ["vcf", "bcf", "mutation"],
    skills: ["pysam", "genomic-intelligence", "pacsomatic", "pathogen-variant-surveillance"],
  },
  {
    match: ["snp", "indel", "genotype"],
    terms: ["vcf", "variant"],
    skills: ["pysam", "onekgpd"],
  },
  {
    match: ["bam", "sam file", "read alignment", "aligned reads"],
    terms: ["alignment", "sequencing"],
    skills: ["pysam", "deeptools"],
  },
  {
    match: ["rna-seq", "rnaseq", "rna seq", "differential expression", "deg"],
    terms: ["expression", "transcript"],
    skills: ["bulk-rnaseq", "pydeseq2", "scanpy"],
  },
  {
    match: ["gene set", "go enrichment", "pathway analysis", "gsea"],
    terms: ["enrichment", "pathway"],
    skills: ["pathway-enrichment"],
  },
  {
    match: ["phylogeny", "phylogenetic tree", "newick", "tree of life"],
    terms: ["phylogenetic", "tree"],
    skills: ["phylogenetics", "etetoolkit"],
  },

  // --- single cell ---------------------------------------------------------
  {
    match: ["single cell", "single-cell", "scrna", "10x", "cell ranger", "umap", "clustering cells"],
    terms: ["anndata", "cells"],
    skills: ["scanpy", "anndata", "scvi-tools", "cellxgene-census"],
  },
  {
    match: ["batch correction", "integration", "harmony"],
    terms: ["batch", "integrate"],
    skills: ["scvi-tools", "scanpy"],
  },
  {
    match: ["rna velocity", "trajectory", "pseudotime"],
    terms: ["velocity", "dynamics"],
    skills: ["scvelo"],
  },

  // --- structure / chemistry ----------------------------------------------
  {
    match: [
      "protein structure",
      "structure prediction",
      "protein folding",
      "fold a protein",
      "alphafold",
    ],
    terms: ["esmfold", "structure", "protein"],
    skills: ["esm", "tamarind"],
  },
  {
    match: ["docking", "dock a ligand", "dock this ligand", "binding pose", "virtual screening"],
    terms: ["docking", "ligand"],
    skills: ["diffdock", "rowan"],
  },
  {
    match: ["smiles", "molecule", "cheminformatics", "compound"],
    terms: ["molecular", "chemistry"],
    skills: ["rdkit", "datamol", "medchem"],
  },
  {
    match: ["md simulation", "molecular dynamics", "force field"],
    terms: ["simulation", "dynamics"],
    skills: ["molecular-dynamics"],
  },
  {
    match: ["admet", "toxicity", "pharmacokinetics", "pk model"],
    terms: ["admet", "pharmacokinetic"],
    skills: ["pkpd-modeling", "pytdc"],
  },

  // --- clinical / stats ----------------------------------------------------
  {
    match: ["survival analysis", "kaplan meier", "kaplan-meier", "cox model", "hazard ratio"],
    terms: ["survival", "time-to-event"],
    skills: ["scikit-survival", "statistical-analysis"],
  },
  {
    match: ["sample size", "power calculation", "powered"],
    terms: ["power", "sample"],
    skills: ["statistical-power", "experimental-design"],
  },
  {
    match: ["clinical trial", "trial design", "cohort"],
    terms: ["clinical", "trial"],
    skills: ["clinical-decision-support", "pyhealth"],
  },
  {
    match: ["mixed model", "regression", "anova", "hypothesis test", "p value", "p-value"],
    terms: ["statistical", "model"],
    skills: ["statistical-analysis", "statsmodels"],
  },
  {
    match: ["bayesian", "mcmc", "posterior"],
    terms: ["bayesian", "probabilistic"],
    skills: ["pymc"],
  },

  // --- imaging / neuro -----------------------------------------------------
  {
    match: ["dicom", "radiology", "ct scan", "mri"],
    terms: ["medical", "imaging"],
    skills: ["pydicom", "imaging-data-commons"],
  },
  {
    match: ["histology", "whole slide", "pathology slide", "wsi"],
    terms: ["histopathology", "slide"],
    skills: ["histolab", "pathml"],
  },
  {
    match: ["spike sorting", "electrophysiology", "ephys", "neural recording"],
    terms: ["neural", "spike"],
    skills: ["neuropixels-analysis"],
  },
  {
    match: ["ecg", "eeg", "heart rate", "physiological signal"],
    terms: ["physiological", "signal"],
    skills: ["neurokit2"],
  },

  // --- writing / literature -----------------------------------------------
  {
    match: ["write a paper", "manuscript", "draft a paper", "methods section"],
    terms: ["writing", "manuscript"],
    skills: ["scientific-writing", "venue-templates"],
  },
  {
    match: ["find papers", "literature search", "pubmed", "citation", "references"],
    terms: ["literature", "papers"],
    skills: ["paper-lookup", "literature-review", "citation-management"],
  },
  {
    match: ["make a figure", "plot", "chart", "visualization", "graph the"],
    terms: ["figure", "plotting"],
    skills: ["scientific-visualization", "matplotlib", "seaborn"],
  },
  {
    match: ["slides", "presentation", "poster", "talk"],
    terms: ["slides", "poster"],
    skills: ["scientific-slides", "pptx-posters", "latex-posters"],
  },
  {
    match: ["grant", "funding proposal", "specific aims"],
    terms: ["grant", "proposal"],
    skills: ["research-grants"],
  },

  // --- data / compute ------------------------------------------------------
  {
    match: ["big dataframe", "out of memory", "large csv", "parallel compute"],
    terms: ["scale", "parallel"],
    skills: ["dask", "polars", "vaex"],
  },
  {
    match: ["gpu", "cuda", "out of gpu memory", "training slow"],
    terms: ["gpu", "accelerate"],
    skills: ["optimize-for-gpu", "get-available-resources"],
  },
  {
    match: ["deep learning", "neural network", "train a model", "transformer"],
    terms: ["training", "model"],
    skills: ["pytorch-lightning", "transformers", "scikit-learn"],
  },
  {
    match: ["pipeline", "workflow", "nextflow", "reproducible run"],
    terms: ["pipeline", "workflow"],
    skills: ["nextflow"],
  },
];

/**
 * Inert default export — see `frontmatter.ts` for why every module under
 * `extensions/` needs one.
 */
export default function noopExtension(): void {}
