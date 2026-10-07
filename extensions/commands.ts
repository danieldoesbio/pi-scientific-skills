/**
 * `/sci`'s subcommands and its bare-menu dispatch: status, the profile picker,
 * search mode (and its alias `none`), find, and the all/reset bulk actions.
 */

import { catalog, describeCost, describeSearchMode, runToolSearch, SKILLS_DIR } from "./catalog";
import { report, settingsPath } from "./paths";
import { runPicker } from "./picker";
import { TOTAL_SKILL_COUNT } from "./profiles";
import {
  commitPlan,
  describeFailedRead,
  findPackageEntry,
  isOverridePattern,
  projectOverride,
  projectOverrideMessage,
  readConfig,
  readSettings,
} from "./settings";
import {
  COMMAND_NAME,
  SUBCOMMANDS,
  TOOL_NAME,
  usage,
  type CommandContext,
  type PackageLocation,
  type Subcommand,
  type UiContext,
} from "./types";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Characters minimatch reads as glob syntax. A pattern holding one cannot be
 * resolved to an exact count (globToRegExp expands only `*` and `?`), so a
 * count derived from it is marked approximate.
 */
const GLOB_CHARS = /[*?[\]{}]/;

/** A `*`/`?` glob pattern as a regex; every other character matches literally. */
const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
};

/**
 * The skill names a set of patterns selects: a plain name counts as itself, a
 * glob is expanded against the catalogue. Counting `patterns.length` instead
 * would count each glob as one skill: an include such as `scientific-*` would
 * understate the cost, and an exclusion such as `!scientific-*` would
 * overstate it.
 */
const matchedSkillNames = (patterns: readonly string[]): ReadonlySet<string> => {
  const names = catalog().map((entry) => entry.name);
  const matched = new Set<string>();
  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) {
      const re = globToRegExp(pattern);
      for (const name of names) if (re.test(name)) matched.add(name);
    } else {
      matched.add(pattern);
    }
  }
  return matched;
};

/** Describe a `skills` filter, expanding each glob to the skills it matches before counting. */
const describeSkillsFilter = (skills: readonly unknown[]): string => {
  if (skills.some((value) => typeof value !== "string")) {
    return 'packages entry has a malformed "skills" value';
  }
  const patterns = skills as readonly string[];
  // pi reads a literally empty array as "disable every resource of this type":
  // no skill in the prompt, which is search mode.
  if (patterns.length === 0) return `search mode: ${describeSearchMode()}`;

  const overrides = patterns.filter(isOverridePattern);
  const includes = patterns.filter((pattern) => !isOverridePattern(pattern));
  // "≈" marks a count derived from expanding at least one glob. pi resolves
  // patterns against the live directory, so the true count can shift between
  // this read and the next `pi install`/sync.
  const approx = (isGlob: boolean, text: string): string => (isGlob ? `≈${text}` : text);

  if (includes.length === 0) {
    // No plain includes: pi starts from every skill and subtracts, so this
    // means "all of them, minus whatever was switched off in `pi config`".
    // Counting the array's entries as the active skills would read a one-line
    // `pi config` exclusion as one skill's worth of tokens, two orders of
    // magnitude too low.
    const excludes = overrides
      .filter((pattern) => pattern.startsWith("!") || pattern.startsWith("-"))
      .map((pattern) => pattern.slice(1));
    const removed = matchedSkillNames(excludes).size;
    const active = Math.max(TOTAL_SKILL_COUNT - removed, 0);
    const isGlob = excludes.some((pattern) => GLOB_CHARS.test(pattern));
    return approx(isGlob, `${describeCost(active)} (all skills minus ${removed} disabled elsewhere)`);
  }

  const isGlob = includes.some((pattern) => GLOB_CHARS.test(pattern));
  const matched = matchedSkillNames(includes).size;
  const note =
    overrides.length > 0 ? ` (plus ${overrides.length} override(s) from \`pi config\`)` : "";
  return approx(isGlob, `${describeCost(matched)}${note}`);
};

/** Whether the user's packages entry carries a `skills` filter of any shape. */
export const hasSkillsFilter = (location: PackageLocation | undefined): boolean =>
  location !== undefined && typeof location.entry !== "string" && location.entry.skills !== undefined;

const describeCurrentEntry = (location: PackageLocation | undefined): string => {
  if (!location) return "not installed as a global package";
  const entry = location.entry;
  if (typeof entry === "string" || entry.skills === undefined) {
    return `all skills active (${describeCost(TOTAL_SKILL_COUNT)})`;
  }
  if (!Array.isArray(entry.skills)) return 'packages entry has a malformed "skills" value';
  return describeSkillsFilter(entry.skills);
};

const showStatus = async (ctx: UiContext): Promise<void> => {
  const settings = await readSettings(settingsPath());
  if (settings.kind !== "ok") {
    report(ctx, describeFailedRead(settingsPath(), settings), "warning");
    return;
  }

  const location = findPackageEntry(settings.document.packages);
  const config = await readConfig();
  const chosen = config.profiles;
  const profileLine =
    chosen === undefined
      ? "No profiles chosen yet."
      : chosen.length === 0
        ? "Saved profiles: none selected."
        : `Saved profiles: ${chosen.join(", ")}`;

  const lines = [describeCurrentEntry(location), profileLine];

  // Search reaches every skill whatever the filter, so the active count alone
  // would understate what the model can do.
  lines.push(
    SKILLS_DIR
      ? `${TOOL_NAME}: active — the model can find and load any of the ${TOTAL_SKILL_COUNT} skills on demand.`
      : `${TOOL_NAME}: unavailable — could not locate this package's skills/ directory.`,
  );

  // The input hook rebuilds /skill:<name> for a filtered-out skill typed at the
  // prompt. The paths it cannot see (other packages; on pi 0.84 and 0.85,
  // queued messages too) are listed under "Residual limits" in
  // DOCUMENTATION.md. Status leaves them out: it answers "what can I do now",
  // and the answer is "type the name".
  if (hasSkillsFilter(location)) {
    lines.push(
      `/skill:<name>: typed at the prompt, loads any of this package's ${TOTAL_SKILL_COUNT}` +
        ` skills, filtered or not. Filtered-out names have no autocomplete, so take the` +
        ` name from /${COMMAND_NAME} find.`,
    );
  }

  const overriding = await projectOverride(ctx.cwd);
  if (overriding) lines.push(`Note: ${projectOverrideMessage(overriding)}`);
  lines.push(usage());
  report(ctx, lines.join("\n"), "info");
};

// Unnumbered, like the fallback picker's rows in picker.ts: nothing here is a hotkey.
const MAIN_MENU = [
  "Choose profiles…",
  "Show status",
  `Enable all ${TOTAL_SKILL_COUNT} skills`,
  "Search only (no skills in the prompt)",
  "Reset (forget profiles, enable all)",
  "Cancel",
] as const;

const enableAll = (ctx: CommandContext): Promise<void> =>
  commitPlan(
    ctx,
    { kind: "unfiltered" },
    { kind: "keep" },
    `All skills active (${describeCost(TOTAL_SKILL_COUNT)}). Saved profiles kept.`,
  );

const resetAll = (ctx: CommandContext): Promise<void> =>
  commitPlan(
    ctx,
    { kind: "unfiltered" },
    { kind: "forget" },
    "Reset: saved profiles forgotten, all skills active.",
  );

/**
 * Keep every skill out of the system prompt and let `sci_find` reach them.
 *
 * This is the recommended shape. In the 2026-09-23 live test, a 27B local
 * model with no skill in its prompt reached the target through `sci_find`
 * within three attempts for 156 of 157 valid probes (testing/report.md).
 * Profiles, `pi config` and `/skill:<name>` still put a skill in front of the
 * model directly.
 *
 * `/sci none` is an alias. An empty filter means search mode; it does not
 * switch the skills off, because `sci_find` still reaches them.
 */
const enableSearchMode = (ctx: CommandContext): Promise<void> =>
  commitPlan(
    ctx,
    { kind: "filter", skills: [] },
    { kind: "set", ids: [] },
    `Search mode: ${describeSearchMode()}.`,
  );

/**
 * Human-facing search, and the fallback for models too weak to tool-call.
 * Same ranker as `sci_find`. It passes no hit count, so it lists more hits than
 * the model is shown (see runToolSearch).
 */
const runFind = (ctx: UiContext, query: string): void => {
  report(ctx, runToolSearch({ query }), SKILLS_DIR ? "info" : "warning");
};

const showMainMenu = async (ctx: CommandContext): Promise<void> => {
  if (!ctx.hasUI) return showStatus(ctx);
  const choice = await ctx.ui.select("Scientific skills", [...MAIN_MENU]);
  switch (choice) {
    case MAIN_MENU[0]:
      return runPicker(ctx);
    case MAIN_MENU[1]:
      return showStatus(ctx);
    case MAIN_MENU[2]:
      return enableAll(ctx);
    case MAIN_MENU[3]:
      return enableSearchMode(ctx);
    case MAIN_MENU[4]:
      return resetAll(ctx);
    default:
      return;
  }
};

const isSubcommand = (value: string): value is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(value);

export const dispatch = async (args: string, ctx: CommandContext): Promise<void> => {
  const trimmed = args.trim();
  if (trimmed === "") return showMainMenu(ctx);

  // Lowercase only the verb; the `find` query goes on as typed. The search
  // normalises case itself, and a no-match reply quotes the query back.
  const separator = trimmed.search(/\s/);
  const verb = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();

  if (!isSubcommand(verb)) {
    report(ctx, `Unknown subcommand "${verb}". ${usage()}`, "warning");
    return;
  }

  switch (verb) {
    case "status":
      return showStatus(ctx);
    case "profiles":
      return runPicker(ctx);
    case "search":
      return enableSearchMode(ctx);
    case "find":
      return runFind(ctx, rest);
    case "all":
      return enableAll(ctx);
    case "none":
      return enableSearchMode(ctx);
    case "reset":
      return resetAll(ctx);
  }
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
