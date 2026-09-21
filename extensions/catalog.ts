/**
 * Token accounting, the skill catalogue, and `sci_find`'s search — the model-
 * facing half of progressive disclosure, plus the `/skill:<name>` rebuild for
 * a skill a resource filter removed from pi's own registry.
 */

import { readFile } from "node:fs/promises";
import {
  BASELINE_TOKEN_COST,
  PROFILES,
  TOGGLES,
  TOKENS_PER_SKILL,
  TOTAL_SKILL_COUNT,
  UNASSIGNED,
} from "./profiles";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  loadCatalog,
  resolveSkillsDir,
  search,
  type SearchHit,
  type SkillEntry,
} from "./search";
import { SKILL_COMMAND_PREFIX, TOOL_NAME } from "./types";

// ---------------------------------------------------------------------------
// Token accounting — the entire point of the feature, so keep it visible
// ---------------------------------------------------------------------------

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

export const describeCost = (skillCount: number): string => {
  const cost = skillCount * TOKENS_PER_SKILL;
  const saved = BASELINE_TOKEN_COST - cost;
  const savings = saved > 0 ? `, saves ~${formatTokens(saved)}` : "";
  return `${skillCount}/${TOTAL_SKILL_COUNT} skills, ~${formatTokens(cost)} tokens${savings}`;
};

/** Union of every toggled group's skills — profiles overlap heavily by design. */
export const skillsForSelection = (selected: ReadonlySet<string>): string[] => {
  const skills = new Set<string>();
  for (const toggle of TOGGLES) {
    if (!selected.has(toggle.id)) continue;
    for (const skill of toggle.skills) skills.add(skill);
  }
  return [...skills].sort();
};

// ---------------------------------------------------------------------------
// Skill catalogue — the other half of progressive disclosure
// ---------------------------------------------------------------------------

/**
 * Where the package's own skills live, or `undefined` if that could not be
 * established. Resolved once at load: if it fails there is nothing to retry,
 * and every caller has to handle absence anyway.
 */
export const SKILLS_DIR = resolveSkillsDir();

let catalogCache: SkillEntry[] | undefined;

/**
 * Every skill's name/description pair, read from disk on first use (~18ms)
 * and kept for the session. An installed package's `skills/` cannot change
 * while pi is running, so there is nothing to invalidate. Sessions that never
 * search pay nothing.
 */
export const catalog = (): SkillEntry[] => {
  if (!SKILLS_DIR) return [];
  if (catalogCache === undefined) catalogCache = loadCatalog(SKILLS_DIR);
  return catalogCache;
};

/**
 * Name → catalogue entry, from the same catalogue `sci_find` uses.
 *
 * A Map, never `join(SKILLS_DIR, name, "SKILL.md")`: `/skill:` names arrive
 * from user input, and a path join would turn `/skill:../../../../etc/passwd`
 * into an arbitrary file read whose contents land in the user turn. The
 * catalogue enumerates real directory entries, so there is nothing to escape.
 */
let skillIndexCache: Map<string, SkillEntry> | undefined;
export const skillIndex = (): ReadonlyMap<string, SkillEntry> => {
  if (skillIndexCache === undefined) {
    skillIndexCache = new Map(catalog().map((entry) => [entry.name, entry]));
  }
  return skillIndexCache;
};

// ---------------------------------------------------------------------------
// /skill:<name> for a filtered-out skill
// ---------------------------------------------------------------------------

type Stripper = (text: string) => string;

/**
 * pi's own frontmatter stripper, resolved lazily and optionally.
 *
 * Deliberately not a static named import. `peerDependencies` pins no floor
 * (`"*"`), so a pi build without this export is reachable, and a missing named
 * binding fails at module link and takes /sci and sci_find down with it. Lazy
 * and optional degrades to pi's existing behaviour instead of to a dead
 * extension. Exported from pi's `dist/index.js` (0.84.3: line 42). If anyone
 * converts this to a static import, `peerDependencies` needs a version floor.
 *
 * Not `./frontmatter`: that parser returns fields only, computes no body, and
 * its `m`-flag regex can match a mid-document `---` rule. Byte fidelity with
 * pi needs pi's stripper.
 */
let stripperCache: Stripper | null | undefined;
const getStripper = async (): Promise<Stripper | null> => {
  if (stripperCache !== undefined) return stripperCache;
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as { stripFrontmatter?: unknown };
    stripperCache =
      typeof mod.stripFrontmatter === "function" ? (mod.stripFrontmatter as Stripper) : null;
  } catch {
    stripperCache = null;
  }
  return stripperCache;
};

export interface SkillCommand {
  readonly name: string;
  readonly args: string;
}

/**
 * Split `/skill:name args` exactly as pi does (agent-session.js:959-961).
 *
 * The split is on the first literal space, not the first whitespace, so
 * `/skill:foo\nbar` yields the name "foo\nbar" and misses. Reproduced on
 * purpose: stock pi does the same for an *unfiltered* skill, and diverging here
 * would make a filtered skill behave differently from an active one. That quirk
 * belongs upstream. Whitespace-only args trim to "" and take the no-args
 * branch, so no stray "\n\n" is appended.
 */
export const parseSkillCommand = (text: string): SkillCommand | undefined => {
  if (!text.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
  const spaceIndex = text.indexOf(" ");
  const nameEnd = spaceIndex === -1 ? text.length : spaceIndex;
  return {
    name: text.slice(SKILL_COMMAND_PREFIX.length, nameEnd),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim(),
  };
};

/**
 * Rebuild the block pi would have built (agent-session.js:966-969) for a skill
 * its resource filter removed from the registry. Byte-identical by
 * construction: same stripper, same template, same trims.
 * `scripts/test-skill-expand.mjs` pins it against pi's own method across every
 * skill in the catalogue.
 *
 * `undefined` means "nothing better than pi's own behaviour", and the caller
 * must then let the text through untouched.
 */
export const expandFilteredSkill = async (command: SkillCommand): Promise<string | undefined> => {
  const entry = skillIndex().get(command.name);
  if (!entry) return undefined;
  const strip = await getStripper();
  if (!strip) return undefined;
  const body = strip(await readFile(entry.path, "utf8")).trim();
  const block =
    `<skill name="${entry.name}" location="${entry.path}">\n` +
    `References are relative to ${entry.dir}.\n\n${body}\n</skill>`;
  return command.args ? `${block}\n\n${command.args}` : block;
};

/** skill name → held-out reason, for the "not in any profile" caveat below. */
const unassignedReasons = new Map<string, string>(
  UNASSIGNED.map(({ skill, reason }) => [skill, reason]),
);

/** A two-initial abbreviation ("U.S.", "U.K.") ending right where it is tested. */
const endsWithAbbreviation = (prefix: string): boolean => /\b[A-Za-z]\.[A-Za-z]\.$/.test(prefix);

/**
 * Text up to and including the first sentence-ending period.
 *
 * A period ends the sentence only when followed by whitespace or the
 * string's end, AND is not the closing dot of a two-initial abbreviation.
 * usfiscaldata's reason opens with "U.S. Treasury Fiscal Data REST API" —
 * without both checks, the naive "first period" reading surfaces "U." or
 * "U.S." instead of the actual first sentence.
 */
const firstSentence = (text: string): string => {
  for (const match of text.matchAll(/\.(?=\s|$)/g)) {
    const end = match.index ?? -1;
    if (end < 0) continue;
    if (endsWithAbbreviation(text.slice(0, end + 1))) continue;
    return text.slice(0, end + 1);
  }
  return text;
};

/** " — not in any profile: <reason>", or "" for a skill some profile lists. */
const unassignedCaveat = (name: string): string => {
  const reason = unassignedReasons.get(name);
  return reason ? ` — not in any profile: ${firstSentence(reason)}` : "";
};

/**
 * Render hits for the model.
 *
 * Full descriptions, not truncated ones: the entire design bet is that a model
 * discriminates well between eight fully-labelled options. Trimming the
 * descriptions to save a few hundred transient tokens would defeat the point.
 *
 * A hit naming a skill `profiles.ts` held out of every profile gets a caveat
 * on its heading line — the model should know it is reaching for something no
 * curated profile ever surfaces. Harmless when called from `formatProfile`:
 * `validate.mjs` keeps PROFILES and UNASSIGNED disjoint, so a profile listing
 * never contains an unassigned skill and the caveat never fires there.
 */
const formatHits = (hits: readonly SearchHit[]): string =>
  hits
    .map(({ entry }) =>
      [
        `## ${entry.name}${unassignedCaveat(entry.name)}`,
        entry.description,
        `Load with: read ${entry.path}`,
        `References inside it are relative to ${entry.dir}`,
      ].join("\n"),
    )
    .join("\n\n");

/** Shown when nothing scores — with the taxonomy, so the model can browse. */
const noMatchText = (query: string): string =>
  [
    `No skill matched "${query}".`,
    "",
    `Browse instead by calling ${TOOL_NAME} with a profile name:`,
    PROFILES.map((profile) => `  ${profile.id} — ${profile.label}`).join("\n"),
  ].join("\n");

/** Profile listing: the same taxonomy humans get in the `/sci` picker. */
const formatProfile = (id: string): string | undefined => {
  const profile = PROFILES.find((entry) => entry.id === id.trim().toLowerCase());
  if (!profile) return undefined;
  const listed = profile.skills
    .map((name) => skillIndex().get(name))
    .filter((entry): entry is SkillEntry => entry !== undefined);
  return [`# ${profile.label}`, profile.description, "", formatHits(listed.map((entry) => ({ entry, score: 0 })))].join(
    "\n",
  );
};

/** No arguments: the toggle list, so an unsure model has somewhere to start. */
const formatProfileIndex = (): string =>
  [
    `${TOTAL_SKILL_COUNT} scientific skills are installed. Profiles:`,
    PROFILES.map((profile) => `  ${profile.id} — ${profile.label} (${profile.skills.length} skills)`).join("\n"),
    "",
    `Call ${TOOL_NAME} with a query to search, or with a profile id to list one.`,
  ].join("\n");

/** Arguments accepted by `sci_find`. All optional: no args lists the profiles. */
export interface ToolParams {
  query?: string;
  profile?: string;
  limit?: number;
}

/**
 * The single implementation behind both `sci_find` and `/sci find`, so the
 * model and the human can never be shown different answers to the same
 * question.
 */
export const runToolSearch = (params: ToolParams): string => {
  if (!SKILLS_DIR) {
    return `${TOOL_NAME} is unavailable: this package's skills/ directory could not be located.`;
  }

  const profile = params.profile?.trim();
  if (profile) {
    return formatProfile(profile) ?? `No profile "${profile}".\n\n${formatProfileIndex()}`;
  }

  const query = params.query?.trim() ?? "";
  if (query === "") return formatProfileIndex();

  // A bare profile id passed as the query is a natural thing for a model to
  // try, and answering it beats a pedantic "no match".
  const asProfile = formatProfile(query);
  if (asProfile) return asProfile;

  const limit = Number.isInteger(params.limit)
    ? Math.min(Math.max(params.limit as number, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const hits = search(catalog(), query, limit);
  return hits.length === 0 ? noMatchText(query) : formatHits(hits);
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
