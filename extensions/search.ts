/**
 * The catalogue and ranking behind `sci_find`.
 *
 * Why this exists: pi keeps every skill's name + description in the system
 * prompt for the whole session and defers only the bodies. Across the
 * catalogue that index is roughly 25k tokens — most of a 32k
 * context. `/sci` lets a *human* narrow it ahead of time; this lets the
 * *model* reach the rest on demand, so narrowing the index no longer means
 * making skills unreachable.
 *
 * Two rules shape the ranking, both from principle rather than taste:
 *
 * 1. Recall beats precision. `sci_find` does not have to pick the right skill,
 *    only get it into a short list with its full description attached (3 hits
 *    on a prompt's first search, then 5; `/sci find` lists 8). The calling
 *    model — even a small one — discriminates well among a few labelled
 *    options and badly among the whole catalogue in a system prompt.
 * 2. Never a confident wrong answer. A query that fails the no-match rule
 *    (`passesNoMatchRule` in bm25f.ts) gets nothing at all. Handing a
 *    plausible-but-wrong skill to someone designing an experiment is worse
 *    than handing them nothing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASES } from "./aliases";
import { type Bm25fIndex, buildIndex, passesNoMatchRule, rankAll } from "./bm25f";
import { parseFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One skill as `sci_find` reports it. `name` is the directory name. */
export interface SkillEntry {
  /** Directory name — the canonical identity everywhere (pi's filter patterns
   * match on the parent directory, not on frontmatter `name`). */
  readonly name: string;
  readonly description: string;
  /** Absolute path to SKILL.md, for the model to `read`. */
  readonly path: string;
  /** Absolute skill directory — SKILL.md's own relative references resolve here. */
  readonly dir: string;
}

export interface SearchHit {
  readonly entry: SkillEntry;
  readonly score: number;
}

// ---------------------------------------------------------------------------
// Locating our own skills/ directory
// ---------------------------------------------------------------------------

/**
 * Resolve the installed package's `skills/` directory.
 *
 * Pi loads extensions through jiti (`createJiti` in
 * `dist/core/extensions/loader.js`), which rewrites `import.meta.url` to the
 * module's own path — verified against pi's bundled jiti 2.7.0 for both
 * `jiti.import` (the loader's call) and native ESM fallthrough.
 *
 * @returns the absolute path, or `undefined` when it cannot be established —
 * which must disable the feature rather than produce paths that do not exist.
 */
export const resolveSkillsDir = (): string | undefined => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "skills");
    return looksLikeSkillsDir(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
};

/** A directory only counts if it actually holds skills, not just if it exists. */
const looksLikeSkillsDir = (path: string): boolean => {
  try {
    if (!statSync(path).isDirectory()) return false;
    return readdirSync(path).some((entry) => {
      try {
        return statSync(join(path, entry, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * Read every skill's name and description from disk.
 *
 * Measured at ~18ms for the catalogue, so this is called lazily on first use and
 * cached for the session: an installed package's `skills/` cannot change while
 * pi is running, so there is nothing to invalidate.
 *
 * Only the head of each file is read. Descriptions are capped at 1024 chars by
 * the spec and frontmatter sits at the top, so pulling whole SKILL.md bodies
 * (some are tens of KB) would be pure waste.
 */
export const loadCatalog = (skillsDir: string): SkillEntry[] => {
  const entries: SkillEntry[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(skillsDir).sort();
  } catch {
    return entries;
  }

  for (const name of dirs) {
    const dir = join(skillsDir, name);
    const path = join(dir, "SKILL.md");
    let head: string;
    try {
      if (!statSync(path).isFile()) continue;
      head = readHead(path);
    } catch {
      continue; // not a skill directory, or unreadable — skip it silently
    }

    const fields = parseFrontmatter(head);
    const description = fields?.description?.trim();
    // A skill with no description is one pi itself refuses to load, so there is
    // no sense offering it.
    if (!description) continue;

    entries.push({ name, description, path, dir });
  }

  return entries;
};

/** Frontmatter lives at the top; 8KB covers the longest in the collection. */
const HEAD_BYTES = 8192;

const readHead = (path: string): string => {
  const buffer = readFileSync(path);
  return buffer.subarray(0, HEAD_BYTES).toString("utf8");
};

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

/**
 * Words carrying no discriminating signal in this corpus. Kept deliberately
 * short: every removal is a chance to delete the one term that mattered.
 * "analysis", "data" and "model" are NOT here — they discriminate poorly on
 * their own but usefully in combination.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "get", "give", "has", "have", "help", "how", "i", "in", "is",
  "it", "me", "my", "need", "of", "on", "or", "our", "please", "should", "so",
  "some", "that", "the", "their", "then", "there", "these", "this", "to", "use",
  "using", "want", "was", "we", "what", "when", "which", "will", "with", "would",
  "you", "your",
]);

const MIN_TERM_LENGTH = 2;

/** Lowercase, strip punctuation, drop stopwords and one-character noise. */
export const normalizeTerms = (query: string): string[] => {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9+-]+/)
    .map((word) => word.replace(/^[-+]+|[-+]+$/g, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of words) {
    if (word.length < MIN_TERM_LENGTH || STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  return terms;
};

/** `rna-seq` and `rnaseq` must match the same things, so compare both forms. */
const compact = (value: string): string => value.replace(/[-_\s]/g, "");

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Surface forms of a term worth matching: the term itself plus the naive
 * singular/plural pair, so "papers" finds "paper" and "cell" finds "cells".
 * Deliberately not a real stemmer — one dependency-free rule that covers the
 * overwhelming majority of this corpus without mangling terms like "analysis".
 */
const surfaceForms = (term: string): string[] => {
  const forms = new Set([term]);
  if (term.length > 3 && term.endsWith("s")) forms.add(term.slice(0, -1));
  else if (term.length > 2) forms.add(`${term}s`);
  return [...forms];
};

/**
 * Length floor for punctuation-insensitive trigger matching ("rnaseq" for the
 * "rna-seq" trigger). Below this, compacted substrings produce far more noise
 * than signal.
 */
const MIN_COMPACT_LENGTH = 5;

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/**
 * Whether a curated alias trigger phrase fires against a raw query.
 *
 * Matches as whole words, not raw substrings: "bam" must not fire on
 * "bamboo". Each word accepts its naive singular/plural pair
 * (`surfaceForms`), so "SNPs", "BAMs" and "plots" still reach the "snp", "bam"
 * and "plot" triggers, which have no other route: triggers shorter than
 * `MIN_COMPACT_LENGTH` never get the compacted fallback. Underscores count as
 * separators ("bam_file"), as they do in `normalizeTerms`. Built against the
 * RAW lowercased query, never `normalizeTerms`: trigger phrases like "tree of
 * life" and "dock a ligand" contain stopwords `normalizeTerms` strips, which
 * would break the match entirely. The compacted fallback still lets
 * punctuation-insensitive forms match ("rnaseq" for the "rna-seq" trigger).
 */
const matchesPhrase = (query: string, phrase: string): boolean => {
  const haystack = query.toLowerCase().replace(/_/g, " ");
  const words = phrase
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => `(?:${surfaceForms(word).map(escapeRegex).join("|")})`);
  const pattern = new RegExp(`\\b${words.join("[\\s-]+")}\\b`);
  if (pattern.test(haystack)) return true;

  const phraseCompact = compact(phrase.toLowerCase());
  if (phraseCompact.length < MIN_COMPACT_LENGTH) return false;
  return compact(haystack).includes(phraseCompact);
};

/**
 * The query's terms plus the terms of every alias rule it triggers.
 *
 * Rules trigger on phrases matched against the raw query as whole words, so
 * multi-word triggers ("survival analysis") require the words together, in
 * order, and single words still hit, but "book" can never fire "bam". A
 * rule's `skills` play no part here: BM25F gives aliases no skill boost.
 */
export const expandQuery = (query: string): string[] => {
  const extra: string[] = [];
  for (const alias of ALIASES) {
    if (!alias.match.some((phrase) => matchesPhrase(query, phrase))) continue;
    for (const term of alias.terms ?? []) extra.push(...normalizeTerms(term));
  }
  return [...new Set([...normalizeTerms(query), ...extra])];
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Hit count when the caller gives none (`/sci find`, the offline tools). */
export const DEFAULT_LIMIT = 8;
/** Ceiling for a caller-supplied count; catalog.ts clamps to this. */
export const MAX_LIMIT = 20;

/**
 * Hits `sci_find` shows the model: the first search after the message that
 * opens a prompt or run, then every later one. Chosen from the top-k rates in
 * testing/runs/2026-09-27-find-ranker.md.
 */
export const FIRST_SEARCH_LIMIT = 3;
export const LATER_SEARCH_LIMIT = 5;

/**
 * One BM25F index per catalogue array. It reads every SKILL.md body (about
 * 2 MB for the whole catalogue), so it is built on the first search, not at
 * load, and kept: an installed package cannot change while pi runs.
 */
const bm25fIndexes = new WeakMap<readonly SkillEntry[], Bm25fIndex>();

export const bm25fIndexFor = (catalog: readonly SkillEntry[]): Bm25fIndex => {
  let index = bm25fIndexes.get(catalog);
  if (index === undefined) {
    index = buildIndex(catalog);
    bm25fIndexes.set(catalog, index);
  }
  return index;
};

/** Every skill BM25F scores above 0 for the query, best first (no floor, no limit). */
export const rankBm25f = (catalog: readonly SkillEntry[], query: string): SearchHit[] =>
  rankAll(bm25fIndexFor(catalog), expandQuery(query));

/**
 * Rank the catalogue against a query with BM25F (bm25f.ts).
 *
 * OR-scored, not AND-matched: requiring every term to appear returns nothing
 * for ordinary phrasings ("variant calling" matches no single description).
 * A query equal to a skill name lists that skill first; otherwise nothing is
 * returned unless the no-match rule passes.
 */
export const search = (
  catalog: readonly SkillEntry[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): SearchHit[] => {
  const index = bm25fIndexFor(catalog);
  const terms = expandQuery(query);
  const hits = rankAll(index, terms);
  const wholeQuery = compact(query.toLowerCase());
  const exact =
    wholeQuery.length >= 3 ? catalog.find((entry) => compact(entry.name.toLowerCase()) === wholeQuery) : undefined;
  if (exact) {
    const rest = hits.filter((hit) => hit.entry !== exact);
    const score = hits.find((hit) => hit.entry === exact)?.score ?? 0;
    return [{ entry: exact, score }, ...rest].slice(0, Math.max(1, limit));
  }
  if (hits.length === 0 || !passesNoMatchRule(index, terms, hits[0].score)) return [];
  return hits.slice(0, Math.max(1, limit));
};

/**
 * Inert default export — see `frontmatter.ts` for why every module under
 * `extensions/` needs one.
 */
export default function noopExtension(): void {}
