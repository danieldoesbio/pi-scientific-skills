/**
 * `/sci`'s subcommands and its bare-menu dispatch: status, the profile picker,
 * search mode, find, and the all/none/reset bulk actions.
 */

import { catalog, describeCost, runToolSearch, skillsForSelection, SKILLS_DIR } from "./catalog";
import { report, settingsPath } from "./paths";
import { runPicker } from "./picker";
import { TOGGLES, TOTAL_SKILL_COUNT } from "./profiles";
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
  DEFAULT_PROFILE_ID,
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

/** Anything minimatch would expand — a pattern we cannot resolve to a count. */
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
 * How many real catalogue skills a set of patterns actually names — a plain
 * name counts as itself, a glob is expanded against the catalogue. Counting
 * `patterns.length` instead (what this replaces) reports one skill's worth of
 * tokens for a one-line `pi config` exclusion that in fact leaves every skill
 * but one loaded, wrong by two orders of magnitude in the reassuring direction.
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

/** Describe a `skills` filter honestly, expanding any glob pattern first. */
const describeSkillsFilter = (skills: readonly unknown[]): string => {
  if (skills.some((value) => typeof value !== "string")) {
    return 'packages entry has a malformed "skills" value';
  }
  const patterns = skills as readonly string[];
  // pi treats a literally empty array as "disable every resource of this type".
  if (patterns.length === 0) return describeCost(0);

  const overrides = patterns.filter(isOverridePattern);
  const includes = patterns.filter((pattern) => !isOverridePattern(pattern));
  // "≈" marks every count below derived from expanding at least one glob:
  // pi resolves patterns against a live directory, so the true count can
  // still shift between this read and the next `pi install`/sync.
  const approx = (isGlob: boolean, text: string): string => (isGlob ? `≈${text}` : text);

  if (includes.length === 0) {
    // No plain includes: pi starts from every skill and subtracts, so this is
    // "all of them, minus whatever was switched off in `pi config`".
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

  // Search reaches every skill regardless of the filter, so reporting only the
  // active count would understate what the model can actually do.
  lines.push(
    SKILLS_DIR
      ? `${TOOL_NAME}: active — the model can find and load any of the ${TOTAL_SKILL_COUNT} skills on demand.`
      : `${TOOL_NAME}: unavailable — could not locate this package's skills/ directory.`,
  );

  // The input hook rebuilds /skill:<name> for a filtered-out skill typed at the
  // prompt. The paths it cannot see (compaction queue, RPC steer, other
  // packages) are listed under "Residual limits" in DOCUMENTATION.md, not here:
  // status answers "what can I do now", and the answer is "type the name".
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

// Unnumbered for the same reason as the picker rows: nothing here is a hotkey.
const MAIN_MENU = [
  "Choose profiles…",
  "Show status",
  `Enable all ${TOTAL_SKILL_COUNT} skills`,
  "Disable all skills",
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

const disableAll = (ctx: CommandContext): Promise<void> =>
  commitPlan(
    ctx,
    { kind: "filter", skills: [] },
    { kind: "set", ids: [] },
    "All scientific skills disabled (~0 tokens).",
  );

const resetAll = (ctx: CommandContext): Promise<void> =>
  commitPlan(
    ctx,
    { kind: "unfiltered" },
    { kind: "forget" },
    "Reset: saved profiles forgotten, all skills active.",
  );

/**
 * Trim the always-loaded index to Core and lean on `sci_find` for the rest.
 *
 * This is the recommended shape: the everyday statistics/EDA/figures/writing
 * skills stay in the system prompt where the model will simply use them, and
 * the remaining 147 stay reachable through search instead of being invisible.
 */
const enableSearchMode = async (ctx: CommandContext): Promise<void> => {
  const core = TOGGLES.find((toggle) => toggle.id === DEFAULT_PROFILE_ID);
  if (!core) {
    report(ctx, `Internal error: no "${DEFAULT_PROFILE_ID}" profile.`, "error");
    return;
  }
  const skills = skillsForSelection(new Set([DEFAULT_PROFILE_ID]));
  await commitPlan(
    ctx,
    { kind: "filter", skills },
    { kind: "set", ids: [DEFAULT_PROFILE_ID] },
    `Search mode: ${core.label} loaded (${describeCost(skills.length)}); ` +
      `${TOOL_NAME} reaches all ${TOTAL_SKILL_COUNT}.`,
  );
};

/** Human-facing search — also the fallback for models too weak to tool-call. */
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
      return disableAll(ctx);
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

  // `find` carries a free-text query, so split the verb off rather than
  // lowercasing the whole line — queries are case- and content-sensitive.
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
      return disableAll(ctx);
    case "reset":
      return resetAll(ctx);
  }
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
