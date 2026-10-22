/**
 * The catalogue and ranking behind `sci_find`.
 *
 * Why this exists: pi keeps every skill's name and description in the system
 * prompt for the whole session and defers only the bodies. Across the
 * catalogue that index is roughly 25k tokens (`BASELINE_TOKEN_COST` in
 * profiles.ts), most of a 32k context. `/sci` lets a *human* narrow it ahead
 * of time; `sci_find` lets the *model* reach the rest on demand, so a
 * narrowed index leaves no skill unreachable.
 *
 * Two rules shape the ranking:
 *
 * 1. Recall beats precision. `sci_find` only has to get the right skill into
 *    a short list with its full description attached (3 hits on a prompt's
 *    first search, then 5; `/sci find` lists 8). The calling model, even a
 *    small one, chooses well among a few labelled options and badly among the
 *    whole catalogue in a system prompt.
 * 2. Never a confident wrong answer. A query that fails the no-match rule
 *    (`passesNoMatchRule` in bm25f.ts) gets nothing. Handing a
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

/** One skill as `sci_find` reports it. */
export interface SkillEntry {
  /** Directory name, the canonical identity everywhere: pi's filter patterns
   * match the skill's directory and ignore frontmatter `name`. */
  readonly name: string;
  readonly description: string;
  /** Absolute path to SKILL.md, for the model to `read`. */
  readonly path: string;
  /** Absolute skill directory, where SKILL.md's relative references resolve. */
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
 * Pi loads extensions with jiti's `createJiti` (`loadExtensionModule` in
 * `dist/core/extensions/loader.js`), and jiti rewrites `import.meta.url` to
 * the module's own path. Verified against pi's bundled jiti 2.7.0 for both
 * `jiti.import` (the loader's call) and native ESM fallthrough.
 *
 * @returns the absolute path, or `undefined` when it cannot be established.
 * The feature must then be disabled: a guessed path would name files that do
 * not exist.
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

/** A directory counts only when at least one entry in it has a SKILL.md. */
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
 * `catalog()` in catalog.ts calls this once, on first use, and caches the
 * result for the session.
 *
 * Only the head of each file is read: frontmatter sits at the top and the
 * spec caps descriptions at 1024 chars, while some SKILL.md bodies are tens
 * of KB.
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
      continue; // not a skill directory, or unreadable: skip it silently
    }

    const fields = parseFrontmatter(head);
    const description = fields?.description?.trim();
    // pi refuses to load a skill with no description, so do not offer one.
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
 * Words that carry no signal in this corpus. The list stays short because
 * every stopword is a chance to delete the one term that mattered.
 * "analysis", "data" and "model" are left out on purpose: weak alone, useful
 * in combination.
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
 * Surface forms of a trigger word: the word plus its naive singular/plural
 * pair, so "papers" and "paper" match each other, as do "cell" and "cells".
 * It is not a stemmer: one dependency-free rule covers most of this corpus
 * without mangling words like "analysis".
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
 * than signal. At or above it the match is a substring test on the
 * compacted query, so a trigger can fire inside a longer word (the "poster"
 * trigger fires on "posterior").
 */
const MIN_COMPACT_LENGTH = 5;

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/**
 * Whether a curated alias trigger phrase fires against a raw query.
 *
 * Words match whole, so "bam" does not fire on "bamboo". Each word also
 * accepts its naive singular/plural pair (`surfaceForms`). That pair is the
 * only route from "SNPs", "BAMs" and "plots" to the "snp", "bam" and "plot"
 * triggers, because triggers shorter than `MIN_COMPACT_LENGTH` get no
 * compacted fallback. Underscores count as separators ("bam_file"), as they
 * do in `normalizeTerms`.
 *
 * The match runs on the raw lowercased query, never on `normalizeTerms`:
 * trigger phrases like "tree of life" and "dock a ligand" contain stopwords
 * `normalizeTerms` strips, so they could never match a normalized query. The
 * compacted fallback lets punctuation-insensitive forms match ("rnaseq" for
 * the "rna-seq" trigger).
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
 * Triggers match the raw query as whole words (`matchesPhrase`): a multi-word
 * trigger ("survival analysis") needs its words together and in order, a
 * single word still hits, and "book" can never fire "bam". A rule's `skills`
 * play no part in ranking (see `Alias.skills`).
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
 * Hits `sci_find` shows the model: FIRST_SEARCH_LIMIT on the first search
 * after the message that opens a prompt or run, LATER_SEARCH_LIMIT on every
 * later one (`createSearchStage` in catalog.ts tracks which). Chosen from the
 * top-k rates in testing/runs/2026-09-27-find-ranker.md.
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
 * Any query term can score a skill. Requiring every term would return nothing
 * for ordinary phrasings ("variant calling" matches no single description).
 * A query equal to a skill name (compared with `compact`) lists that skill
 * first, even when the no-match rule would fail. Otherwise nothing is
 * returned unless the rule passes.
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
 * Inert default export; see `frontmatter.ts` for why every module under
 * `extensions/` needs one.
 */
export default function noopExtension(): void {}
