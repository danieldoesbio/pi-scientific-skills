/**
 * The catalogue and ranking behind `sci_find`.
 *
 * Why this exists: pi keeps every skill's name + description in the system
 * prompt for the whole session and defers only the bodies. Across 157 skills
 * that index is ~17k tokens — over half a 32k context. `/sci` lets a *human*
 * narrow it ahead of time; this lets the *model* reach the rest on demand, so
 * narrowing the index no longer means making skills unreachable.
 *
 * Two rules shape the ranking, both from principle rather than taste:
 *
 * 1. Recall beats precision. `sci_find` does not have to pick the right skill,
 *    only get it into a list of eight with its full description attached. The
 *    calling model — even a small one — discriminates well between eight
 *    labelled options and badly between 157 in a system prompt.
 * 2. Never a confident wrong answer. Below `MIN_SCORE` nothing is returned at
 *    all. Handing a plausible-but-wrong skill to someone designing an
 *    experiment is worse than handing them nothing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASES } from "./aliases";
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
 * Measured at ~18ms for 157 skills, so this is called lazily on first use and
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
 * Whole-word matching, not raw substring.
 *
 * Substring matching silently equates "book" with "notebook" — which is exactly
 * the confident-wrong-answer failure this tool must not have. Word boundaries
 * treat hyphens as separators, so "rna-seq" still matches the "seq" token.
 */
const matchesWord = (haystack: string, term: string): boolean =>
  new RegExp(`\\b(?:${surfaceForms(term).map(escapeRegex).join("|")})\\b`).test(haystack);

/**
 * Length floor for punctuation-insensitive matching ("rnaseq" ↔ "rna-seq").
 * Below this, compacted substrings produce far more noise than signal.
 */
const MIN_COMPACT_LENGTH = 5;

const matchesCompact = (haystackCompact: string, term: string): boolean => {
  const termCompact = compact(term);
  if (termCompact.length < MIN_COMPACT_LENGTH) return false;
  return haystackCompact.includes(termCompact);
};

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

interface Expansion {
  readonly terms: string[];
  readonly boosted: ReadonlySet<string>;
}

/**
 * Apply the curated alias rules to a raw query.
 *
 * Rules trigger on phrases matched against the whole normalized query string,
 * so multi-word triggers ("survival analysis") work and single words still hit.
 */
export const expandQuery = (query: string): Expansion => {
  const typed = normalizeTerms(query);
  const haystack = ` ${compact(query.toLowerCase())} `;
  const extra: string[] = [];
  const boosted = new Set<string>();

  for (const alias of ALIASES) {
    const hit = alias.match.some((phrase) => haystack.includes(compact(phrase.toLowerCase())));
    if (!hit) continue;
    for (const term of alias.terms ?? []) extra.push(...normalizeTerms(term));
    for (const skill of alias.skills ?? []) boosted.add(skill);
  }

  const terms = [...new Set([...typed, ...extra])];
  return { terms, boosted };
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;
/** An alias naming a skill outright is strong evidence, but not proof. */
const ALIAS_BOOST = 4;
/** The whole query appearing verbatim in a name is as good as it gets. */
const EXACT_NAME_BONUS = 10;

/**
 * Anything scoring below this is withheld entirely.
 *
 * One weak description hit (score 1) is noise — with 157 skills and common
 * words like "data", something always scores 1. Two points means either a name
 * hit or two independent description hits, which is the floor for saying
 * anything at all.
 */
const MIN_SCORE = 2;

export const DEFAULT_LIMIT = 8;

/**
 * Rank the catalogue against a query.
 *
 * OR-scored, not AND-matched: requiring every term to appear returns nothing
 * for ordinary phrasings ("variant calling" matches no single description).
 */
export const search = (
  catalog: readonly SkillEntry[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): SearchHit[] => {
  const { terms, boosted } = expandQuery(query);
  if (terms.length === 0 && boosted.size === 0) return [];

  const wholeQuery = compact(query.toLowerCase());
  const hits: SearchHit[] = [];

  for (const entry of catalog) {
    const name = entry.name.toLowerCase();
    const nameCompact = compact(name);
    const description = entry.description.toLowerCase();
    const descriptionCompact = compact(description);

    let score = 0;

    for (const term of terms) {
      // Name hits are the strongest signal available: a skill directory is
      // named for exactly what it does, with none of a description's filler.
      if (matchesWord(name, term) || matchesCompact(nameCompact, term)) {
        score += NAME_WEIGHT;
      } else if (matchesWord(description, term) || matchesCompact(descriptionCompact, term)) {
        score += DESCRIPTION_WEIGHT;
      }
    }

    if (boosted.has(entry.name)) score += ALIAS_BOOST;
    if (wholeQuery.length >= 3 && nameCompact === wholeQuery) score += EXACT_NAME_BONUS;

    if (score >= MIN_SCORE) hits.push({ entry, score });
  }

  // Ties break by name so results are deterministic across runs — a flapping
  // order would make the ranking tests meaningless.
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return hits.slice(0, Math.max(1, limit));
};

/**
 * Inert default export — see `frontmatter.ts` for why every module under
 * `extensions/` needs one.
 */
export default function noopExtension(): void {}
