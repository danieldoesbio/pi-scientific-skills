// Golden queries for sci_find, shared by scripts/test-search.mjs (which checks
// them) and scripts/find-embed-compare.mjs (which scores other rankers on
// them). They run against the real vendored descriptions: the point is
// whether upstream's actual wording can be found from the words a scientist
// would type.

/** `want` lists acceptable answers: several skills legitimately fit some queries. */
export const QUERIES = [
  ["I have a 10x matrix and want to cluster cells", ["scanpy", "anndata"]],
  ["variant calling from a bam file", ["pysam", "pathogen-variant-surveillance"]],
  ["dock this ligand into the binding site", ["diffdock"]],
  ["fit a survival model with censoring", ["scikit-survival"]],
  ["predict protein structure from sequence", ["esm", "tamarind"]],
  ["differential expression between two conditions", ["pydeseq2", "bulk-rnaseq"]],
  ["make a publication figure with panels", ["scientific-visualization", "matplotlib"]],
  ["find papers about CRISPR off-target effects", ["paper-lookup", "literature-review"]],
  ["how many samples do I need for 80% power", ["statistical-power"]],
  ["read a DICOM series from the scanner", ["pydicom"]],
  ["spike sorting neuropixels recording", ["neuropixels-analysis"]],
  ["my dataframe is too big for memory", ["dask", "polars", "vaex"]],
  ["build a phylogenetic tree from newick", ["phylogenetics", "etetoolkit"]],
  ["run a nextflow pipeline", ["nextflow"]],
  ["compute SMILES descriptors for compounds", ["rdkit", "datamol"]],
  ["write the methods section of my paper", ["scientific-writing"]],
  ["bayesian hierarchical model with mcmc", ["pymc"]],
  ["whole slide image tiling for pathology", ["histolab", "pathml"]],
  ["gene set enrichment analysis", ["pathway-enrichment"]],
  ["molecular dynamics simulation setup", ["molecular-dynamics"]],
  ["single cell batch correction across donors", ["scvi-tools", "scanpy"]],
  ["ECG signal processing heart rate variability", ["neurokit2"]],
  ["query clinical trials for a condition", ["clinical-decision-support", "database-lookup"]],
  ["train a graph neural network on molecules", ["torch-geometric", "torchdrug", "deepchem"]],
  ["geospatial raster analysis", ["geopandas", "geomaster"]],
  // Single-word queries: one term scores little in absolute terms, so these
  // pass the no-match rule through its share of the most the query could
  // score (bm25f.ts, NO_MATCH.minShare), not through its absolute floor.
  ["statistical", ["statistical-analysis"]],
  ["statistics", ["statistical-analysis"]],
  ["genome", ["genomic-coordinates"]],
  ["medical image segmentation", ["pydicom", "histolab"]],
  ["predict the effect of a non-coding variant", ["alphagenome"]],
  ["alphagenome", ["alphagenome"]],
  // Plural and underscore forms of the short alias triggers. These have no
  // route but the whole-word match (triggers under MIN_COMPACT_LENGTH never
  // get the compacted fallback), so without singular/plural surface forms
  // "SNPs" and "BAMs" would not fire their aliases.
  ["call SNPs from a VCF", ["pysam", "onekgpd"]],
  ["sort my BAMs", ["pysam", "deeptools"]],
  ["sort my bam_file", ["pysam", "deeptools"]],
  ["make plots of my results", ["matplotlib", "scientific-visualization", "seaborn"]],
  ["find DEGs between two conditions", ["pydeseq2", "bulk-rnaseq", "scanpy"]],
];

/**
 * Queries that must rank a specific skill FIRST, not merely present.
 * `mustBeFirst` is checked against `names[0]`.
 */
export const RANKED = [["variant calling from a bam file", "pysam"]];

/**
 * Queries that must return nothing at all.
 *
 * Principle: a plausible-but-wrong skill handed to someone designing an
 * experiment is worse than no answer. "book a flight" is here because it caught
 * a real bug: substring matching scored `open-notebook`, since "notebook"
 * contains "book".
 */
export const NEGATIVES = [
  "what is the weather today",
  "book a flight to paris",
  "asdfghjkl",
  "remind me to call my mother",
  // Whole-word alias matching (matchesPhrase): the first two caught real
  // substring false positives before the fix ("bam" inside "bamboo", "deg"
  // inside "degradation"). The other four guard the no-match rule, which must
  // not turn an unrelated word into a confident answer.
  "bamboo growth",
  "protein degradation",
  "lunch",
  "plumbing",
  "gossip",
  "furniture",
  // Hyphenated: a hyphen makes a joined pair token, and the bm25f no-match rule
  // counts single words only. These must still return nothing.
  "e-mail my landlord",
  "asdf-ghjk",
];
