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
  type SkillProfile,
} from "./profiles";
import {
  DEFAULT_LIMIT,
  FIRST_SEARCH_LIMIT,
  LATER_SEARCH_LIMIT,
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

/**
 * An empty `skills` filter is search mode, not "off": no skill is in the
 * system prompt, and `sci_find` still reaches every one. Callers add the
 * "Search mode:" prefix in the case their sentence needs.
 */
export const describeSearchMode = (): string =>
  `no skills in the system prompt (${describeCost(0)}); ${TOOL_NAME} finds all ${TOTAL_SKILL_COUNT} on demand`;

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

/** The first sentence of the reason a skill is held out of every profile, if it is. */
const heldOutReason = (name: string): string | undefined => {
  const reason = unassignedReasons.get(name);
  return reason ? firstSentence(reason) : undefined;
};

/** " — not in any profile: <reason>", or "" for a skill some profile lists. */
const unassignedCaveat = (name: string): string => {
  const reason = heldOutReason(name);
  return reason ? ` — not in any profile: ${reason}` : "";
};

/**
 * How query hits are rendered. "full" (the default): every hit with its full
 * description. "compact" (experimental, `PI_SCI_FIND_FORMAT=compact`): the
 * first COMPACT_FULL_HITS hits in full, the rest with the first sentence only.
 */
export type HitFormat = "full" | "compact";

export const COMPACT_FULL_HITS = 2;
/**
 * Hit count in compact mode for a caller that passes none, which is `/sci find`.
 * The top 6 held the target in 152 of 158 searches
 * (testing/runs/2026-09-27-find-compact-replay.md). The `sci_find` tool never
 * reaches this: its search stage always passes 3 or 5.
 */
export const COMPACT_DEFAULT_LIMIT = 6;

export const findFormat = (): HitFormat => (process.env.PI_SCI_FIND_FORMAT === "compact" ? "compact" : "full");

/** Heading line; a skill `profiles.ts` holds out of every profile says so. */
const hitHeading = (entry: SkillEntry): string => `## ${entry.name}${unassignedCaveat(entry.name)}`;

const fullHit = (entry: SkillEntry): string =>
  [
    hitHeading(entry),
    entry.description,
    `Load with: read ${entry.path}`,
    `References inside it are relative to ${entry.dir}`,
  ].join("\n");

const shortHit = (entry: SkillEntry): string =>
  [hitHeading(entry), firstSentence(entry.description), `Load with: read ${entry.path}`].join("\n");

export const COMPACT_ALTERNATES_LINE =
  "More matches, with the first sentence of each description only. Paths inside a SKILL.md are relative to its folder.";

/**
 * Render hits for the model.
 *
 * "full" rests on the design bet that a model discriminates well among a few
 * fully-labelled options. The 2026-09-25 run, with 8 hits per search (before
 * 3-then-5), measured the cost: reading a median 6,816-character result (6,804
 * in the replay of the same searches) took about 17 of the 25 seconds between
 * the search and the read, while the target was the first hit in 78% of
 * searches and in the top two in 87%. "compact" keeps full labels for the top
 * two only. Both replays of the recorded choices are done: the first was
 * inconclusive and the two pooled were non-inferior
 * (testing/runs/2026-09-27-find-compact-replay.md and
 * testing/runs/2026-09-27-find-compact-replay-2.md). It stays experimental and
 * off by decision: the shorter list, 3 hits then 5, took its place as the way
 * to cut result tokens.
 *
 * A hit naming a skill `profiles.ts` held out of every profile gets a caveat
 * on its heading line — the model should know it is reaching for something no
 * curated profile ever surfaces. Harmless when called from `formatProfile`:
 * `validate.mjs` keeps PROFILES and UNASSIGNED disjoint, so a profile listing
 * never contains an unassigned skill and the caveat never fires there.
 */
export const formatHits = (hits: readonly SearchHit[], format: HitFormat = "full"): string => {
  if (format === "full" || hits.length <= COMPACT_FULL_HITS) {
    return hits.map(({ entry }) => fullHit(entry)).join("\n\n");
  }
  return [
    ...hits.slice(0, COMPACT_FULL_HITS).map(({ entry }) => fullHit(entry)),
    COMPACT_ALTERNATES_LINE,
    ...hits.slice(COMPACT_FULL_HITS).map(({ entry }) => shortHit(entry)),
  ].join("\n\n");
};

/** Shown when nothing scores — with the taxonomy, so the model can browse. */
const noMatchText = (query: string): string =>
  [
    `No skill matched "${query}".`,
    "",
    `Browse instead by calling ${TOOL_NAME} with a profile name:`,
    PROFILES.map((profile) => `  ${profile.id} — ${profile.label}`).join("\n"),
  ].join("\n");

/**
 * The profile that `text` names, if any. This is the one test for "this text
 * is a profile id": `runFind` lists the profile it finds, and the search
 * stage does not count a query it finds as a search. Keeping a single test
 * keeps the two from drifting apart.
 */
const profileNamed = (text: string): SkillProfile | undefined => {
  const id = text.trim().toLowerCase();
  return PROFILES.find((profile) => profile.id === id);
};

/** A profile's skills that are in the catalogue, in the profile's own order. */
const profileEntries = (profile: SkillProfile): SkillEntry[] =>
  profile.skills
    .map((name) => skillIndex().get(name))
    .filter((entry): entry is SkillEntry => entry !== undefined);

/** Profile listing: the same taxonomy humans get in the `/sci` picker. */
const formatProfile = (profile: SkillProfile): string =>
  [
    `# ${profile.label}`,
    profile.description,
    "",
    formatHits(profileEntries(profile).map((entry) => ({ entry, score: 0 }))),
  ].join("\n");

/** No arguments: the toggle list, so an unsure model has somewhere to start. */
const formatProfileIndex = (): string =>
  [
    `${TOTAL_SKILL_COUNT} scientific skills are installed. Profiles:`,
    PROFILES.map((profile) => `  ${profile.id} — ${profile.label} (${profile.skills.length} skills)`).join("\n"),
    "",
    `Call ${TOOL_NAME} with a query to search, or with a profile id to list one.`,
  ].join("\n");

/**
 * A search request. `query` and `profile` are `sci_find`'s arguments; all
 * optional, and no args lists the profiles. `limit` is the caller's hit count
 * (the tool's search stage, or a replayed call), not a model argument.
 */
export interface ToolParams {
  query?: string;
  profile?: string;
  limit?: number;
}

/**
 * What a `sci_find` call returned, for programmatic callers. pi 1.0 hands this
 * to codemode scripts (`tools.sci_find(...)`) in place of the text; the model
 * itself only ever sees the text. `index.ts` declares the same shape as the
 * tool's `outputSchema`.
 *
 * Every field is always present, with `null` for "not given", so a script
 * never has to tell a missing field from an empty one. Type aliases, not
 * interfaces: pi's `JsonValue` is an index-signature type, and an interface is
 * not assignable to one.
 */
export const FIND_KINDS = ["search", "no-match", "profile", "profile-index", "unknown-profile", "unavailable"] as const;
export type FindKind = (typeof FIND_KINDS)[number];

export type FoundSkill = {
  name: string;
  description: string;
  /** Absolute path to SKILL.md: what `read` takes. */
  path: string;
  /** The skill's folder: relative paths inside SKILL.md resolve against it. */
  dir: string;
  /** First sentence of why `profiles.ts` holds the skill out of every profile, or null. */
  notInAnyProfile: string | null;
};

export type ListedProfile = { id: string; label: string; skillCount: number };

export type FindStructured = {
  kind: FindKind;
  query: string | null;
  profile: string | null;
  /** Search hits in rank order, or the listed profile's skills. */
  skills: FoundSkill[];
  /** The profile taxonomy, on the kinds that offer it for browsing. */
  profiles: ListedProfile[];
};

export interface FindResult {
  /** What the model reads. */
  readonly text: string;
  readonly structured: FindStructured;
  /** The call could not do what it was asked: an unknown profile, or no catalogue. */
  readonly isError: boolean;
}

const foundSkill = (entry: SkillEntry): FoundSkill => ({
  name: entry.name,
  description: entry.description,
  path: entry.path,
  dir: entry.dir,
  notInAnyProfile: heldOutReason(entry.name) ?? null,
});

const listedProfiles = (): ListedProfile[] =>
  PROFILES.map((profile) => ({ id: profile.id, label: profile.label, skillCount: profile.skills.length }));

/**
 * The one implementation behind both `sci_find` and `/sci find`: the same
 * ranker and the same rendering. The hit count differs on purpose. The tool
 * passes 3 (a prompt's first search) or 5 (later ones) through `limit`, and
 * `/sci find` passes none and gets DEFAULT_LIMIT, the top 8 (6 under the
 * experimental compact format). `format` applies to query hits only; profile
 * listings stay full. `structured` always carries full descriptions: a script
 * chooses what to show.
 */
export const runFind = (params: ToolParams, format: HitFormat = findFormat()): FindResult => {
  const query = params.query?.trim() ?? "";
  const requestedProfile = params.profile?.trim() ?? "";
  const result = (
    kind: FindKind,
    text: string,
    extra: { profile?: string; skills?: SkillEntry[]; profiles?: boolean } = {},
  ): FindResult => ({
    text,
    isError: kind === "unknown-profile" || kind === "unavailable",
    structured: {
      kind,
      query: query === "" ? null : query,
      profile: extra.profile ?? (requestedProfile === "" ? null : requestedProfile),
      skills: (extra.skills ?? []).map(foundSkill),
      profiles: extra.profiles ? listedProfiles() : [],
    },
  });

  if (!SKILLS_DIR) {
    return result(
      "unavailable",
      `${TOOL_NAME} is unavailable: this package's skills/ directory could not be located.`,
    );
  }

  if (requestedProfile) {
    const named = profileNamed(requestedProfile);
    if (!named) {
      return result("unknown-profile", `No profile "${requestedProfile}".\n\n${formatProfileIndex()}`, {
        profiles: true,
      });
    }
    return result("profile", formatProfile(named), { profile: named.id, skills: profileEntries(named) });
  }

  if (query === "") return result("profile-index", formatProfileIndex(), { profiles: true });

  // A bare profile id passed as the query is a natural thing for a model to
  // try, and answering it beats a pedantic "no match".
  const asProfile = profileNamed(query);
  if (asProfile) {
    return result("profile", formatProfile(asProfile), { profile: asProfile.id, skills: profileEntries(asProfile) });
  }

  const limit = Number.isInteger(params.limit)
    ? Math.min(Math.max(params.limit as number, 1), MAX_LIMIT)
    : format === "compact"
      ? COMPACT_DEFAULT_LIMIT
      : DEFAULT_LIMIT;
  const hits = search(catalog(), query, limit);
  if (hits.length === 0) return result("no-match", noMatchText(query), { profiles: true });
  return result("search", formatHits(hits, format), { skills: hits.map(({ entry }) => entry) });
};

/** `runFind`'s text alone: what `/sci find` reports and the replay tooling compares. */
export const runToolSearch = (params: ToolParams, format: HitFormat = findFormat()): string =>
  runFind(params, format).text;

/**
 * How many hits `sci_find` shows the model. Every call in the first turn that
 * searches after a prompt gets FIRST_SEARCH_LIMIT (parallel calls in that turn
 * included); every later turn gets LATER_SEARCH_LIMIT. Profile listings (a
 * profile id in `profile`, or as the whole `query`) and empty calls are not
 * searches and do not use up the first turn.
 *
 * index.ts feeds the stage two pi events, `agent_start` and `message_start`
 * (with the message's role). Two kinds of message start a new first search:
 * - A role "user" message always does: the prompt, and each steer and
 *   follow-up message. `message_start` fires when a message enters the model's
 *   context, before the assistant's reply and so before its first tool call.
 * - A role "custom" message does when it opens an agent run. An extension that
 *   calls `pi.sendMessage` with `triggerTurn: true` on an idle agent starts a
 *   run with no user message, and `convertToLlm` hands the custom message to
 *   the model as a user message. `agentStart` sets a flag and the first
 *   `message_start` that is not a system message clears it, so only a message
 *   at the head of a run counts. A custom message later in a run (a steer, or a
 *   context message pi adds between turns) does not reset.
 *
 * A system message never resets and does not clear the flag. In pi 0.87 a
 * run whose tool loadout changed opens with a system message ahead of its
 * first message; it records the tool change and is not a prompt.
 *
 * Two cases still count wrong, and are left as they are:
 * - A custom steer queued during an auto-retry backoff reaches the model
 *   mid-prompt but opens a new run, so it resets: a prompt with that steer
 *   shows 3, 3, 5 where the base case shows 3, 5, 5.
 * - In pi 0.87 a custom entry from `agent_before_settle` gives no
 *   `message_start`, so the stage stays at 5 for it.
 *
 * `agent_start` alone does not reset, because pi emits it again for an
 * `agent.continue()` after an auto-retry or a compaction. With no message
 * queued, that run opens with no new message (its first `message_start` is the
 * assistant's) and is not a new prompt. `agent_start` is not emitted at all
 * for a steer or follow-up message that arrives inside a running agent loop.
 * `input` is not used: it fires when the user types, before pi queues the
 * message, so it can reset a turn that is still running.
 *
 * `turnStart` counts turns itself. pi's own `turnIndex` starts again at 0 at
 * every `agent_start`, so after a retry it would name the first searching turn
 * a second time.
 */
export interface SearchStage {
  agentStart: () => void;
  messageStart: (role: unknown) => void;
  turnStart: () => void;
  limitFor: (params: ToolParams) => number | undefined;
}

export const createSearchStage = (): SearchStage => {
  let turn = 0;
  let firstSearchTurn: number | undefined;
  let runOpening = false;
  return {
    agentStart: () => {
      runOpening = true;
    },
    messageStart: (role) => {
      const opensRun = runOpening;
      if (role !== "system") runOpening = false;
      if (role === "user" || (opensRun && role === "custom")) firstSearchTurn = undefined;
    },
    turnStart: () => {
      turn += 1;
    },
    limitFor: (params) => {
      const query = params.query?.trim();
      if (params.profile?.trim() || !query || profileNamed(query)) return undefined;
      firstSearchTurn ??= turn;
      return turn === firstSearchTurn ? FIRST_SEARCH_LIMIT : LATER_SEARCH_LIMIT;
    },
  };
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
