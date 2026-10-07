/**
 * BM25F ranking for `sci_find`. It replaced an older word-match scorer in
 * 1.7.0; that scorer was removed after 1.8.0.
 *
 * Three fields per skill: its name, its description and its SKILL.md body.
 * A term's weight falls with the number of skills that use it (IDF), so a
 * word like "data" counts for little and a word like "neuropixels" for a lot.
 * The body lets a query reach a skill through words its description does not
 * use.
 *
 * The settings are fixed. They came from a 2-fold cross-validation on 425
 * recorded first `sci_find` queries (split by target skill) and were then
 * tested, unchanged, on paraphrased requests written blind to the skill
 * names, and once on a locked held-out set (testing/runs/2026-09-27-find-ranker.md).
 */

import { readFileSync } from "node:fs";
import type { SkillEntry } from "./search";

/** Field weights, length normalisation per field and term saturation. */
export const BM25F_SETTINGS = {
  nameWeight: 2,
  descriptionWeight: 1,
  bodyWeight: 0.2,
  descriptionB: 0.5,
  bodyB: 0.9,
  k1: 1.2,
} as const;

/**
 * Drops a final "s" from a word of 4 or more characters, unless it ends in
 * "ss" ("class" is kept). It is not a stemmer: "analysis" folds to "analysi",
 * the same way in documents and in queries, so the two still meet.
 */
const fold = (word: string): string => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/** Lowercase words, split on anything but ASCII letters, digits and "+". */
const splitWords = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);

/** The words of `text`, each with a plural "s" folded, and no joined pairs. */
const unigrams = (text: string): string[] => splitWords(text).map(fold);

/**
 * The words of `text` (see `unigrams`), plus every adjacent pair joined when
 * the pair has 5 or more characters. A document is tokenized whole, so its
 * "rna seq" and its "rna-seq" both give the token "rnaseq". A query is
 * tokenized one term at a time (see `rankAll`), so it gets a pair only from a
 * hyphen inside a term: "rna-seq" and "rnaseq" meet those documents through
 * "rnaseq", but the query "rna seq" is two terms and matches through "rna"
 * and "seq" alone.
 */
export const tokenize = (text: string): string[] => {
  const words = splitWords(text);
  const out = words.map(fold);
  for (let i = 0; i + 1 < words.length; i++) {
    const pair = words[i] + words[i + 1];
    if (pair.length >= 5) out.push(fold(pair));
  }
  return out;
};

const countTerms = (terms: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
};

interface IndexedSkill {
  readonly entry: SkillEntry;
  readonly name: ReadonlyMap<string, number>;
  readonly description: ReadonlyMap<string, number>;
  readonly body: ReadonlyMap<string, number>;
  readonly descriptionLength: number;
  readonly bodyLength: number;
}

export interface Bm25fIndex {
  readonly skills: readonly IndexedSkill[];
  readonly averageDescription: number;
  readonly averageBody: number;
  readonly documentFrequency: ReadonlyMap<string, number>;
}

/** The SKILL.md text below its frontmatter; an unreadable file gives no body. */
export const readBody = (entry: SkillEntry): string => {
  try {
    return readFileSync(entry.path, "utf8").replace(/^---[\s\S]*?\n---\n/, "");
  } catch {
    return "";
  }
};

export const buildIndex = (catalog: readonly SkillEntry[], bodyOf: (entry: SkillEntry) => string = readBody): Bm25fIndex => {
  const skills = catalog.map((entry): IndexedSkill => {
    const description = tokenize(entry.description);
    const body = tokenize(bodyOf(entry));
    return {
      entry,
      name: countTerms(tokenize(entry.name)),
      description: countTerms(description),
      body: countTerms(body),
      descriptionLength: description.length,
      bodyLength: body.length,
    };
  });
  const documentFrequency = new Map<string, number>();
  for (const skill of skills) {
    for (const term of new Set([...skill.name.keys(), ...skill.description.keys(), ...skill.body.keys()])) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const count = Math.max(1, skills.length);
  return {
    skills,
    averageDescription: skills.reduce((sum, skill) => sum + skill.descriptionLength, 0) / count || 1,
    averageBody: skills.reduce((sum, skill) => sum + skill.bodyLength, 0) / count || 1,
    documentFrequency,
  };
};

/**
 * Every skill with a score above 0 for `terms`, best first; ties break by
 * name. `terms` are raw query terms: each is tokenized here.
 */
export const rankAll = (index: Bm25fIndex, terms: readonly string[]): { entry: SkillEntry; score: number }[] => {
  const {
    nameWeight,
    descriptionWeight,
    bodyWeight,
    descriptionB,
    bodyB,
    k1,
  } = BM25F_SETTINGS;
  const queryTerms = [...new Set(terms.flatMap(tokenize))];
  const total = index.skills.length;
  const idf = (term: string): number => {
    const df = index.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  };
  const hits: { entry: SkillEntry; score: number }[] = [];
  for (const skill of index.skills) {
    let score = 0;
    for (const term of queryTerms) {
      const weighted =
        nameWeight * (skill.name.get(term) ?? 0) +
        (descriptionWeight * (skill.description.get(term) ?? 0)) /
          (1 - descriptionB + (descriptionB * skill.descriptionLength) / index.averageDescription) +
        (bodyWeight * (skill.body.get(term) ?? 0)) / (1 - bodyB + (bodyB * skill.bodyLength) / index.averageBody);
      if (weighted > 0) score += (idf(term) * weighted) / (k1 + weighted);
    }
    if (score > 0) hits.push({ entry: skill.entry, score });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return hits;
};

/**
 * The no-match rule. A query gets hits only when the best skill scores at
 * least `minTop`, or reaches `minShare` of the most the query could score
 * (every query term at full weight). The absolute floor handles long
 * queries; the share lets a short, exact query through ("genome",
 * "statistics"), whose best score is small because it has one term.
 * Chosen on development data to lose none of 1,069 queries whose target was
 * in the top 8, and to return nothing for every query in test-search.mjs's
 * negative list. The most a query could score counts single words only. A
 * joined pair of a hyphenated word scores only when the index holds it
 * ("massspec" is in no field). A pair that can never score must not hold a
 * short hyphenated query under the share.
 * minShare was 0.35 until the v2.72.0 sync, whose condensed descriptions
 * dropped "read alignment" to 0.30 while the highest negative ("bamboo
 * growth") sits at 0.27; 0.28 splits them (testing/runs/2026-10-05-v2.72.0-sync.md).
 */
export const NO_MATCH = { minTop: 2.5, minShare: 0.28 } as const;

export const passesNoMatchRule = (index: Bm25fIndex, terms: readonly string[], top: number): boolean => {
  if (top >= NO_MATCH.minTop) return true;
  const total = index.skills.length;
  const most = [...new Set(terms.flatMap(unigrams))].reduce((sum, term) => {
    const df = index.documentFrequency.get(term) ?? 0;
    return sum + Math.log(1 + (total - df + 0.5) / (df + 0.5));
  }, 0);
  return most > 0 && top / most >= NO_MATCH.minShare;
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
