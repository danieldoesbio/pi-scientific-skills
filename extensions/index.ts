/**
 * /sci — curate which of the 158 scientific skills pi loads.
 *
 * Every skill's name + description is injected into the system prompt at startup
 * and stays there for the whole session (~17k tokens for the full set). Small or
 * local models pay that twice: once in context budget, and again in selection
 * accuracy, because discriminating between 158 similar descriptions is hard.
 *
 * The fix is pi's own per-package resource filter in settings.json:
 *
 *   { "packages": [{ "source": "pi-scientific-skills", "skills": ["scanpy", ...] }] }
 *
 * That is deliberate: skills/ is byte-identical to upstream and is replaced
 * wholesale by the sync script, so nothing here may ever touch a SKILL.md. The
 * filter lives in the user's own settings, stays hand-editable, composes with
 * `pi config`, and survives every upstream sync.
 */

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  BASELINE_TOKEN_COST,
  TOGGLES,
  TOKENS_PER_SKILL,
  TOTAL_SKILL_COUNT,
} from "./profiles";

const PACKAGE_NAME = "pi-scientific-skills";
const COMMAND_NAME = "sci";
const CONFIG_VERSION = 1;

const SUBCOMMANDS = ["status", "profiles", "all", "none", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural subsets of ExtensionContext / ExtensionCommandContext covering only
 * the documented members used here. Declared locally so this file depends on
 * behaviour pi documents rather than on type names it may not export.
 */
interface UiContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(prompt: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
  };
}

interface CommandContext extends UiContext {
  reload(): Promise<void>;
}

/** A `packages` entry in object form. Unknown keys are preserved verbatim. */
interface PackageFilter {
  source?: string;
  skills?: string[];
  autoload?: boolean;
  [key: string]: unknown;
}

type PackageEntry = string | PackageFilter;

/** settings.json as read from disk: known keys plus everything we must not lose. */
interface SettingsDocument {
  packages?: unknown;
  [key: string]: unknown;
}

/** Our own state file. Profile ids, not expanded skills, so labels can evolve. */
interface ExtensionConfig {
  version?: number;
  onboardingSeen?: boolean;
  profiles?: string[];
  updatedAt?: string;
}

type SettingsRead =
  | { readonly kind: "ok"; readonly document: SettingsDocument; readonly raw: string }
  | { readonly kind: "missing" }
  // A read that failed for any reason other than "not there": permissions,
  // EISDIR, ELOOP, I/O. Kept distinct from `malformed` because telling someone
  // to "fix the JSON" in a file they cannot even open invites them to destroy it.
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "malformed"; readonly detail: string };

type FailedRead = Exclude<SettingsRead, { kind: "ok" }>;

interface PackageLocation {
  readonly index: number;
  readonly entry: PackageEntry;
  readonly source: string;
}

type ApplyPlan =
  | { readonly kind: "filter"; readonly skills: readonly string[] }
  | { readonly kind: "unfiltered" };

type ApplyResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * pi's own resolver: it honours $PI_CODING_AGENT_DIR (and the equivalent
 * variable in a rebranded distribution) before falling back to ~/<config>/agent.
 * Reconstructing the fallback here would point /sci at a settings.json that pi
 * is not reading.
 */
const agentDir = (): string => getAgentDir();
const settingsPath = (): string => join(agentDir(), "settings.json");
const configPath = (): string => join(agentDir(), `${PACKAGE_NAME}.json`);
const backupPath = (): string => `${settingsPath()}.${PACKAGE_NAME}.bak`;
const projectSettingsPath = (cwd: string): string =>
  join(cwd, CONFIG_DIR_NAME, "settings.json");

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * ctx.ui.notify is a no-op when no UI is bound (`pi -p`, JSON and RPC-less
 * modes), which is exactly where the non-interactive subcommands are used. Every
 * user-facing string goes through here so those runs are never silent.
 */
const report = (
  ctx: UiContext,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  process.stderr.write(`${message}\n`);
};

// ---------------------------------------------------------------------------
// Token accounting — the entire point of the feature, so keep it visible
// ---------------------------------------------------------------------------

const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

const describeCost = (skillCount: number): string => {
  const cost = skillCount * TOKENS_PER_SKILL;
  const saved = BASELINE_TOKEN_COST - cost;
  const savings = saved > 0 ? `, saves ~${formatTokens(saved)}` : "";
  return `${skillCount}/${TOTAL_SKILL_COUNT} skills, ~${formatTokens(cost)} tokens${savings}`;
};

/** Union of every toggled group's skills — profiles overlap heavily by design. */
const skillsForSelection = (selected: ReadonlySet<string>): string[] => {
  const skills = new Set<string>();
  for (const toggle of TOGGLES) {
    if (!selected.has(toggle.id)) continue;
    for (const skill of toggle.skills) skills.add(skill);
  }
  return [...skills].sort();
};

// ---------------------------------------------------------------------------
// Atomic, non-destructive file writes
// ---------------------------------------------------------------------------

/** Temp file in the same directory + rename, so a crash cannot truncate config. */
const writeFileAtomic = async (
  path: string,
  contents: string,
  mode?: number,
): Promise<void> => {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, contents, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

/**
 * The file pi actually writes. rename(2) replaces a symlink rather than its
 * target, so writing atomically to the link path would sever a dotfiles-managed
 * settings.json (stow/chezmoi/yadm) from the repo it lives in — while pi's own
 * writer, plain writeFileSync, follows the link. Resolve first, write there.
 */
const resolveWriteTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * COPYFILE_EXCL keeps the very first backup — the pristine, pre-/sci config.
 * Deliberately kept next to the *logical* settings path rather than the resolved
 * one: that is where every message here tells the user to look, and it keeps the
 * backup out of a dotfiles repo the resolved file may live in.
 */
const ensureBackup = async (): Promise<void> => {
  try {
    await copyFile(settingsPath(), backupPath(), fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
};

/** Match the file's existing indentation so diffs stay reviewable. */
const detectIndent = (raw: string): string | number => {
  const match = raw.match(/\n([ \t]+)"/);
  return match?.[1] ?? 2;
};

const serializeSettings = (document: SettingsDocument, raw: string): string => {
  const text = JSON.stringify(document, null, detectIndent(raw));
  return raw.endsWith("\n") ? `${text}\n` : text;
};

// ---------------------------------------------------------------------------
// Locking — share pi's lock, do not race it
// ---------------------------------------------------------------------------

const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;
/** proper-lockfile's default staleness window. */
const LOCK_STALE_MS = 10_000;

/**
 * pi serialises every settings.json mutation behind proper-lockfile, which takes
 * its lock by `mkdir(`${file}.lock`)` — so creating that directory ourselves is
 * protocol-compatible without adding a dependency. Without it, a concurrent
 * `pi install` or `pi config` read-modify-write silently discards either our
 * filter or their change.
 *
 * pi locks the *unresolved* path (`realpath: false`), so we must lock that same
 * path even though we write to the resolved one.
 */
const acquireSettingsLock = async (path: string): Promise<() => Promise<void>> => {
  const lock = `${path}.lock`;
  const release = async (): Promise<void> => {
    await rm(lock, { recursive: true, force: true });
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await mkdir(lock);
      return release;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;

      // proper-lockfile refreshes the lock's mtime while it is held, so an old
      // one is debris from a crashed process. It steals such locks; so do we,
      // otherwise a single crash would wedge /sci permanently.
      const age = await stat(lock)
        .then((stats) => Date.now() - stats.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }

      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error(`${path} is locked by another pi process`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
};

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

const readSettings = async (path: string): Promise<SettingsRead> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", detail: describeError(error) };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "malformed", detail: "top level is not a JSON object" };
    }
    return { kind: "ok", document: parsed as SettingsDocument, raw };
  } catch (error) {
    // JSONC comments land here too. Rewriting would silently delete them, so we
    // refuse rather than "fixing" a file we cannot faithfully reproduce.
    return { kind: "malformed", detail: describeError(error) };
  }
};

const describeFailedRead = (path: string, read: FailedRead): string => {
  switch (read.kind) {
    case "missing":
      return `${path} does not exist.`;
    case "unreadable":
      return `${path} cannot be read (${read.detail}). Check its permissions and ownership.`;
    case "malformed":
      return `${path} is not valid JSON (${read.detail}). Comments are not supported.`;
  }
};

/**
 * The spec with any `@ref` removed — under both rules that could apply, because
 * a source is one kind or the other and we cannot always tell which.
 *
 * pi splits a git ref at the *first* `@` in the path portion, so a ref may
 * contain slashes (`…/repo@feature/trim`). A local path, by contrast, may hold a
 * legitimate `@` in a directory name (`~/dev/@work/pkg`), where only a trailing
 * `@version` is a ref. The spec itself is always kept as a candidate too.
 */
const withoutRef = (spec: string): string[] => {
  const candidates = [spec];

  const firstSlash = spec.indexOf("/");
  const inPath = spec.indexOf("@", firstSlash < 0 ? 0 : firstSlash);
  if (inPath > 0) candidates.push(spec.slice(0, inPath));

  const trailing = spec.lastIndexOf("@");
  const separator = Math.max(
    spec.lastIndexOf("/"),
    spec.lastIndexOf("\\"),
    spec.lastIndexOf(":"),
  );
  if (trailing > 0 && trailing > separator) candidates.push(spec.slice(0, trailing));

  return candidates;
};

/**
 * Names a `packages` source could be known by. pi's identity differs per source
 * type — npm name, normalised git host+path, resolved local path — but in every
 * form the last path segment is the package name, once the parts pi itself
 * strips are gone. Notably a trailing `.git`, which pi removes in
 * `buildGitSource` and which every GitHub clone URL carries: leaving it on makes
 * /sci report itself as not installed for anyone who installed from a clone URL.
 *
 * Schemes and `user@host` prefixes need no special handling because splitting on
 * `/` discards them; only a bare `npm:`/`git:` prefix has no separator.
 */
const packageIdentities = (source: string): string[] => {
  const cleaned = source
    .trim()
    .replace(/^(npm|git):(?!\/\/)/, "")
    .replace(/[?#].*$/, "");

  const identities = new Set<string>();
  for (const candidate of withoutRef(cleaned)) {
    const segments = candidate.split(/[/\\]/).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last !== undefined) identities.add(last.replace(/\.git$/, ""));
  }
  return [...identities];
};

const sourceNamesPackage = (source: string): boolean =>
  packageIdentities(source).includes(PACKAGE_NAME);

const entrySource = (entry: PackageEntry): string | undefined => {
  if (typeof entry === "string") return entry;
  return typeof entry.source === "string" ? entry.source : undefined;
};

const findPackageEntry = (packages: unknown): PackageLocation | undefined => {
  if (!Array.isArray(packages)) return undefined;
  for (const [index, entry] of packages.entries()) {
    const source = entrySource(entry as PackageEntry);
    if (source === undefined || !sourceNamesPackage(source)) continue;
    return { index, entry: entry as PackageEntry, source };
  }
  return undefined;
};

/** `!exclude`, `+force-include`, `-force-exclude` — pi's override syntaxes. */
const isOverridePattern = (pattern: string): boolean => /^[!+-]/.test(pattern);

/** Override patterns already in the entry — `pi config` writes exactly these. */
const keptOverrides = (entry: PackageEntry): string[] =>
  typeof entry !== "string" && Array.isArray(entry.skills)
    ? entry.skills.filter(
        (pattern): pattern is string =>
          typeof pattern === "string" && isOverridePattern(pattern),
      )
    : [];

/**
 * Set only `skills`. `extensions` is never written, so /sci can never filter out
 * the extension that provides /sci — the one unrecoverable mistake here.
 *
 * Per-skill choices made in `pi config` live in this same array as `+`/`-`/`!`
 * patterns, so they are carried across rather than clobbered.
 */
const applyPlanToEntry = (entry: PackageEntry, source: string, plan: ApplyPlan): PackageEntry => {
  const base: PackageFilter = typeof entry === "string" ? { source: entry } : entry;
  const kept = keptOverrides(entry);

  if (plan.kind === "filter") {
    // An array holding nothing but overrides means "everything, minus those" to
    // pi — applyPatterns starts from all paths when there are no plain includes.
    // Carrying them into an empty filter would invert "disable all" into "enable
    // all", so only a literally empty array can express "none".
    const skills = plan.skills.length === 0 ? [] : [...plan.skills, ...kept];
    return { ...base, source, skills };
  }

  const { skills: _dropped, ...rest } = base;
  // "All skills" still means "all except what the user turned off elsewhere".
  if (kept.length > 0) return { ...rest, source, skills: kept };
  // Collapse back to the string form only when nothing else was configured;
  // otherwise the user's other filters (prompts, themes) must survive.
  const onlySource = Object.keys(rest).length === 1 && typeof rest.source === "string";
  return onlySource ? source : rest;
};

/** Rebuilds the document; `packages` keeps its original position on overwrite. */
const withPlanApplied = (
  document: SettingsDocument,
  location: PackageLocation,
  plan: ApplyPlan,
): SettingsDocument => {
  const packages = document.packages as readonly PackageEntry[];
  const next = packages.map((entry, index) =>
    index === location.index ? applyPlanToEntry(location.entry, location.source, plan) : entry,
  );
  return { ...document, packages: next };
};

const NOT_INSTALLED_MESSAGE =
  `"${PACKAGE_NAME}" is not listed under "packages" in ${settingsPath()}, so ` +
  `/sci has nothing to configure. If you are running it with \`pi -e .\` or from a ` +
  `project-local .pi/settings.json, edit that entry by hand — /sci only manages the ` +
  `global install (\`pi install npm:${PACKAGE_NAME}\`).`;

const refuse = (read: FailedRead): ApplyResult => ({
  ok: false,
  message:
    read.kind === "missing"
      ? `${describeFailedRead(settingsPath(), read)} ${NOT_INSTALLED_MESSAGE}`
      : `Refusing to write: ${describeFailedRead(settingsPath(), read)} Fix it, or edit ` +
        `the "${PACKAGE_NAME}" packages entry by hand.`,
});

/**
 * The project settings file, when it lists this package and would win.
 *
 * pi dedupes packages by identity and the project entry beats the global one,
 * unless it sets `autoload: false` — which makes it a delta over the global
 * entry, leaving the global entry live and worth editing.
 */
const projectOverride = async (cwd: string): Promise<string | undefined> => {
  const path = projectSettingsPath(cwd);
  const read = await readSettings(path);
  if (read.kind !== "ok") return undefined;

  const location = findPackageEntry(read.document.packages);
  if (!location) return undefined;

  const entry = location.entry;
  if (typeof entry !== "string" && entry.autoload === false) return undefined;
  return path;
};

const projectOverrideMessage = (path: string): string =>
  `${path} also lists "${PACKAGE_NAME}", and a project entry overrides the global ` +
  `one, so editing ${settingsPath()} would change nothing. Edit the "skills" array ` +
  `in ${path} instead, or set "autoload": false there to make it a delta over the ` +
  `global entry.`;

const applyToSettings = async (plan: ApplyPlan, cwd: string): Promise<ApplyResult> => {
  const overriding = await projectOverride(cwd);
  if (overriding) return { ok: false, message: projectOverrideMessage(overriding) };

  // Cheap pre-flight so a missing/unreadable file is diagnosed without creating
  // a lock directory beside a file that may not even be there.
  const probe = await readSettings(settingsPath());
  if (probe.kind !== "ok") return refuse(probe);

  let release: () => Promise<void>;
  try {
    release = await acquireSettingsLock(settingsPath());
  } catch (error) {
    return {
      ok: false,
      message:
        `Could not lock ${settingsPath()} (${describeError(error)}). Another pi ` +
        `process may be writing settings — try again in a moment.`,
    };
  }

  try {
    // Re-read inside the lock: the pre-flight read raced anything else running.
    const settings = await readSettings(settingsPath());
    if (settings.kind !== "ok") return refuse(settings);

    const location = findPackageEntry(settings.document.packages);
    if (!location) return { ok: false, message: NOT_INSTALLED_MESSAGE };

    const next = withPlanApplied(settings.document, location, plan);
    const serialized = serializeSettings(next, settings.raw);
    if (serialized === settings.raw) return { ok: true, changed: false };

    await ensureBackup();
    const target = await resolveWriteTarget(settingsPath());
    const mode = (await stat(target)).mode & 0o777;
    await writeFileAtomic(target, serialized, mode);
    return { ok: true, changed: true };
  } finally {
    await release();
  }
};

// ---------------------------------------------------------------------------
// Extension config (profile ids live here, never in pi's settings.json)
// ---------------------------------------------------------------------------

const readConfig = async (): Promise<ExtensionConfig> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ExtensionConfig;
  } catch {
    // Missing or corrupt: this file is ours alone, so starting over is safe.
    return {};
  }
};

const writeConfig = async (config: ExtensionConfig): Promise<void> => {
  await mkdir(agentDir(), { recursive: true });
  const next: ExtensionConfig = {
    ...config,
    version: CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const usage = (): string =>
  `/${COMMAND_NAME} [${SUBCOMMANDS.join(" | ")}] — run bare for the menu.`;

/**
 * What happens to the saved profile ids. `keep` matters for /sci all: turning
 * everything back on temporarily must not destroy a curated selection, which is
 * the difference between /sci all and /sci reset.
 */
type ProfileUpdate =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly ids: string[] }
  | { readonly kind: "forget" };

const nextProfiles = (
  config: ExtensionConfig,
  update: ProfileUpdate,
): string[] | undefined => {
  if (update.kind === "set") return update.ids;
  if (update.kind === "forget") return undefined;
  return config.profiles;
};

/** Applies a plan, records the selection, then reloads so it takes effect now. */
const commitPlan = async (
  ctx: CommandContext,
  plan: ApplyPlan,
  update: ProfileUpdate,
  summary: string,
): Promise<void> => {
  const result = await applyToSettings(plan, ctx.cwd);
  if (!result.ok) {
    report(ctx, result.message, "error");
    return;
  }

  const config = await readConfig();
  // `profiles: undefined` is dropped by JSON.stringify, which is how "forget" works.
  await writeConfig({
    ...config,
    profiles: nextProfiles(config, update),
    onboardingSeen: true,
  });
  report(
    ctx,
    result.changed ? `${summary} Reloading…` : `${summary} (already applied)`,
    "info",
  );
  if (!result.changed) return;

  // Reload is terminal for this handler: everything after it runs on the old
  // extension instance, so do all reporting first and return immediately.
  await ctx.reload();
  return;
};

/** Anything minimatch would expand — a pattern we cannot resolve to a count. */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Describe a `skills` filter honestly. The array holds *patterns*, not names, so
 * counting its length reports "1/158 skills, ~108 tokens" for a one-line
 * `pi config` exclusion that in fact leaves 157 skills and ~17k tokens loaded —
 * wrong by two orders of magnitude, in the reassuring direction.
 */
const describeSkillsFilter = (skills: readonly unknown[]): string => {
  if (skills.some((value) => typeof value !== "string")) {
    return 'packages entry has a malformed "skills" value';
  }
  const patterns = skills as readonly string[];
  // pi treats a literally empty array as "disable every resource of this type".
  if (patterns.length === 0) return describeCost(0);

  const overrides = patterns.filter(isOverridePattern);
  const includes = patterns.filter((pattern) => !isOverridePattern(pattern));

  if (includes.some((pattern) => GLOB_CHARS.test(pattern))) {
    return (
      `custom filter in settings.json (${patterns.length} pattern(s)) — ` +
      `/${COMMAND_NAME} profiles will replace it`
    );
  }

  if (includes.length === 0) {
    // No plain includes: pi starts from every skill and subtracts, so this is
    // "all of them, minus whatever was switched off in `pi config`".
    const removed = overrides.filter(
      (pattern) => pattern.startsWith("!") || pattern.startsWith("-"),
    ).length;
    const active = Math.max(TOTAL_SKILL_COUNT - removed, 0);
    return `${describeCost(active)} (all skills minus ${removed} disabled elsewhere)`;
  }

  const note =
    overrides.length > 0 ? ` (plus ${overrides.length} override(s) from \`pi config\`)` : "";
  return `${describeCost(includes.length)}${note}`;
};

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
  const overriding = await projectOverride(ctx.cwd);
  if (overriding) lines.push(`Note: ${projectOverrideMessage(overriding)}`);
  lines.push(usage());
  report(ctx, lines.join("\n"), "info");
};

// ---------------------------------------------------------------------------
// Profile picker — ctx.ui has no multiselect, so toggle via repeated select()
// ---------------------------------------------------------------------------

const APPLY = "A) Apply";
const SELECT_ALL = "S) Select all";
const CLEAR = "C) Clear selection";
const CANCEL = "X) Cancel";

const toggleRows = (selected: ReadonlySet<string>): string[] =>
  TOGGLES.map((toggle, index) => {
    const mark = selected.has(toggle.id) ? "x" : " ";
    return `${index + 1}) [${mark}] ${toggle.label} — ${toggle.skills.length} skills`;
  });

const withToggled = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
};

const sameSkills = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((value, index) => value === sortedB[index]);
};

/**
 * The picker seeds its checkboxes from our own config file, so a filter written
 * by hand — or a selection made before /sci existed — would render as "nothing
 * selected" and be replaced on Apply without a word. Ask first.
 *
 * Override patterns are excluded from the comparison because applyPlanToEntry
 * preserves them; only plain include patterns are at risk.
 */
const confirmReplacingUnknownFilter = async (
  ctx: UiContext,
  saved: ReadonlySet<string>,
): Promise<boolean> => {
  const settings = await readSettings(settingsPath());
  if (settings.kind !== "ok") return true; // applyToSettings reports this properly

  const location = findPackageEntry(settings.document.packages);
  if (!location) return true;

  const entry = location.entry;
  if (typeof entry === "string" || !Array.isArray(entry.skills)) return true;

  const includes = entry.skills.filter(
    (pattern): pattern is string =>
      typeof pattern === "string" && !isOverridePattern(pattern),
  );
  if (includes.length === 0) return true;
  if (sameSkills(includes, skillsForSelection(saved))) return true;

  return ctx.ui.confirm(
    "Replace the existing filter?",
    `${settingsPath()} lists ${includes.length} skill pattern(s) that /${COMMAND_NAME} ` +
      `did not write. Applying a profile replaces that list (\`pi config\` overrides ` +
      `are kept). Continue?`,
  );
};

const runPicker = async (ctx: CommandContext): Promise<void> => {
  if (!ctx.hasUI) {
    report(ctx, `/${COMMAND_NAME} profiles needs an interactive UI. ${usage()}`, "warning");
    return;
  }

  const config = await readConfig();
  const saved: ReadonlySet<string> = new Set(config.profiles ?? []);
  if (!(await confirmReplacingUnknownFilter(ctx, saved))) {
    report(ctx, "No changes made.", "info");
    return;
  }

  let selected: ReadonlySet<string> = saved;

  for (;;) {
    const skills = skillsForSelection(selected);
    const prompt = `Scientific skills — ${describeCost(skills.length)}`;
    const rows = toggleRows(selected);
    const choice = await ctx.ui.select(prompt, [...rows, APPLY, SELECT_ALL, CLEAR, CANCEL]);

    if (choice === undefined || choice === CANCEL) {
      report(ctx, "No changes made.", "info");
      return;
    }
    if (choice === SELECT_ALL) {
      selected = new Set(TOGGLES.map((toggle) => toggle.id));
      continue;
    }
    if (choice === CLEAR) {
      selected = new Set();
      continue;
    }
    if (choice === APPLY) {
      const summary =
        skills.length === 0
          ? "All scientific skills disabled."
          : `Active: ${describeCost(skills.length)}.`;
      await commitPlan(ctx, { kind: "filter", skills }, { kind: "set", ids: [...selected] }, summary);
      return;
    }

    const index = rows.indexOf(choice);
    if (index >= 0) selected = withToggled(selected, TOGGLES[index].id);
  }
};

const MAIN_MENU = [
  "1) Choose profiles…",
  "2) Show status",
  `3) Enable all ${TOTAL_SKILL_COUNT} skills`,
  "4) Disable all skills",
  "5) Reset (forget profiles, enable all)",
  "6) Cancel",
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

const dispatch = async (args: string, ctx: CommandContext): Promise<void> => {
  const arg = args.trim().toLowerCase();
  if (arg === "") return showMainMenu(ctx);
  if (!isSubcommand(arg)) {
    report(ctx, `Unknown subcommand "${arg}". ${usage()}`, "warning");
    return;
  }

  switch (arg) {
    case "status":
      return showStatus(ctx);
    case "profiles":
      return runPicker(ctx);
    case "all":
      return enableAll(ctx);
    case "none":
      return disableAll(ctx);
    case "reset":
      return resetAll(ctx);
  }
};

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const ONBOARDING = [
  `${PACKAGE_NAME}: all ${TOTAL_SKILL_COUNT} skills are active, costing`,
  `~${formatTokens(BASELINE_TOKEN_COST)} tokens of context every session.`,
  `Run /${COMMAND_NAME} to pick just the profiles you need.`,
].join(" ");

/**
 * First-run hint. Deliberately a fire-and-forget notify rather than a dialog:
 * session_start handlers run before the user's first prompt, so a blocking
 * confirm()/select() would hold the session hostage on every fresh install —
 * including scripted and RPC clients that never expected a prompt. The persisted
 * `onboardingSeen` flag makes it strictly once, and a failure to read or write
 * that flag is swallowed so onboarding can never break startup.
 */
const maybeOnboard = async (ctx: UiContext): Promise<void> => {
  try {
    const config = await readConfig();
    if (config.onboardingSeen || config.profiles !== undefined) return;

    const settings = await readSettings(settingsPath());
    const location =
      settings.kind === "ok" ? findPackageEntry(settings.document.packages) : undefined;
    // Someone who already hand-filtered the package does not need the pitch.
    const alreadyFiltered =
      location !== undefined && typeof location.entry !== "string" && location.entry.skills !== undefined;

    if (!alreadyFiltered) ctx.ui.notify(ONBOARDING, "info");
    await writeConfig({ ...config, onboardingSeen: true });
  } catch {
    // Startup must never fail because of a hint.
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Manage which scientific skills are active (trims system-prompt context)",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
        value: name,
        label: name,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: CommandContext) => {
      try {
        await dispatch(args, ctx);
      } catch (error) {
        report(ctx, `/${COMMAND_NAME} failed: ${describeError(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // Only a genuine cold start; reload/new/resume/fork would re-nag.
    if (event.reason !== "startup" || !ctx.hasUI) return;
    await maybeOnboard(ctx);
  });
}
