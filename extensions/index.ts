/**
 * /sci — curate which of the 157 scientific skills pi loads.
 *
 * Every skill's name + description is injected into the system prompt at startup
 * and stays there for the whole session (~18k tokens for the full set). Small or
 * local models pay that twice: once in context budget, and again in selection
 * accuracy, because discriminating between 157 similar descriptions is hard.
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
import { Type } from "typebox";
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
  PROFILES,
  TOGGLES,
  TOKENS_PER_SKILL,
  TOTAL_SKILL_COUNT,
} from "./profiles";
import {
  DEFAULT_LIMIT,
  loadCatalog,
  resolveSkillsDir,
  search,
  type SearchHit,
  type SkillEntry,
} from "./search";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";

const COMMAND_NAME = "sci";
const CONFIG_VERSION = 1;
const TOOL_NAME = "sci_find";

/** The profile applied by `/sci search` — the everyday-work baseline. */
const DEFAULT_PROFILE_ID = "core";

const SUBCOMMANDS = ["status", "profiles", "search", "find", "all", "none", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural subsets of ExtensionContext / ExtensionCommandContext covering only
 * the documented members used here. Declared locally so this file depends on
 * behaviour pi documents rather than on type names it may not export.
 */
/** The slice of pi-tui's KeybindingsManager the picker needs. */
interface KeyMatcher {
  matches(data: string, keybinding: string): boolean;
}

/**
 * The slice of pi-tui's `Component` a focused custom view must provide.
 * `invalidate` is required by the real interface even though this component
 * caches nothing, so it is declared here and implemented as a no-op.
 */
interface TuiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

interface UiContext {
  readonly hasUI: boolean;
  /**
   * Pi's run mode: "tui" | "rpc" | "json" | "print". Distinct from `hasUI`,
   * which is true in RPC as well — so anything that blocks on a human must gate
   * on `mode === "tui"`, or a scripted client gets a dialog it cannot answer.
   */
  readonly mode?: string;
  readonly cwd: string;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(prompt: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    /**
     * Renders a focused custom component. Interactive mode only: RPC mode's
     * implementation returns undefined without rendering anything
     * (`dist/modes/rpc/rpc-mode.js:151`), and older pi builds may not define
     * the method at all. Callers must treat a missing method *and* an
     * undefined result as "unsupported" and fall back — which is why the
     * picker's own result type is always a non-undefined object.
     */
    custom?<T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: KeyMatcher,
        done: (result: T) => void,
      ) => TuiComponent,
      options?: { overlay?: boolean },
    ): Promise<T | undefined>;
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
  /**
   * Last package version whose changes this user was told about. Absent means
   * either a fresh install or an upgrade from a release predating the notice —
   * `onboardingSeen` distinguishes the two.
   */
  lastSeenVersion?: string;
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
// Skill catalogue — the other half of progressive disclosure
// ---------------------------------------------------------------------------

/**
 * Where the package's own skills live, or `undefined` if that could not be
 * established. Resolved once at load: if it fails there is nothing to retry,
 * and every caller has to handle absence anyway.
 */
const SKILLS_DIR = resolveSkillsDir();

let catalogCache: SkillEntry[] | undefined;

/**
 * The 157 name/description pairs, read from disk on first use (~18ms) and kept
 * for the session. An installed package's `skills/` cannot change while pi is
 * running, so there is nothing to invalidate. Sessions that never search pay
 * nothing.
 */
const catalog = (): SkillEntry[] => {
  if (!SKILLS_DIR) return [];
  if (catalogCache === undefined) catalogCache = loadCatalog(SKILLS_DIR);
  return catalogCache;
};

/**
 * Render hits for the model.
 *
 * Full descriptions, not truncated ones: the entire design bet is that a model
 * discriminates well between eight fully-labelled options. Trimming the
 * descriptions to save a few hundred transient tokens would defeat the point.
 */
const formatHits = (hits: readonly SearchHit[]): string =>
  hits
    .map(({ entry }) =>
      [
        `## ${entry.name}`,
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
  const known = new Map(catalog().map((entry) => [entry.name, entry]));
  const listed = profile.skills
    .map((name) => known.get(name))
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
interface ToolParams {
  query?: string;
  profile?: string;
  limit?: number;
}

/**
 * The single implementation behind both `sci_find` and `/sci find`, so the
 * model and the human can never be shown different answers to the same
 * question.
 */
const runToolSearch = (params: ToolParams): string => {
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

  const limit = Number.isFinite(params.limit) ? Number(params.limit) : DEFAULT_LIMIT;
  const hits = search(catalog(), query, limit);
  return hits.length === 0 ? noMatchText(query) : formatHits(hits);
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
 * counting its length reports "1/157 skills, ~113 tokens" for a one-line
 * `pi config` exclusion that in fact leaves 157 skills and ~18k tokens loaded —
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

  // Search reaches every skill regardless of the filter, so saying only "12 of
  // 157 active" would understate what the model can actually do.
  lines.push(
    SKILLS_DIR
      ? `${TOOL_NAME}: active — the model can find and load any of the ${TOTAL_SKILL_COUNT} skills on demand.`
      : `${TOOL_NAME}: unavailable — could not locate this package's skills/ directory.`,
  );

  // Worth stating plainly: pi does not error on an unknown /skill: command, it
  // forwards the literal text to the model, which looks like the skill loaded.
  const filtered =
    location !== undefined &&
    typeof location.entry !== "string" &&
    Array.isArray(location.entry.skills);
  if (filtered) {
    lines.push(
      `Note: /skill:<name> works only for active skills. For a filtered one pi passes the` +
        ` text through unchanged rather than reporting an error — use ${TOOL_NAME} instead.`,
    );
  }

  const overriding = await projectOverride(ctx.cwd);
  if (overriding) lines.push(`Note: ${projectOverrideMessage(overriding)}`);
  lines.push(usage());
  report(ctx, lines.join("\n"), "info");
};

// ---------------------------------------------------------------------------
// Fallback picker — repeated select(), used when ui.custom is unavailable
// ---------------------------------------------------------------------------

// No "A)"/"X)" prefixes: ctx.ui.select renders a plain SelectList driven by
// arrows + enter (pi-tui select-list.js), with no hotkey or type-to-filter
// binding. Numbering the rows advertised keys that do nothing.
const APPLY = "Apply and reload";
const SELECT_ALL = "Select all profiles";
const CLEAR = "Clear selection";
const CANCEL = "Cancel";

const toggleRows = (selected: ReadonlySet<string>): string[] =>
  TOGGLES.map((toggle) => {
    const mark = selected.has(toggle.id) ? "x" : " ";
    return `[${mark}] ${toggle.label} — ${toggle.skills.length} skills`;
  });

/**
 * Apply and Cancel lead, the rare bulk actions trail.
 *
 * SelectList caps its viewport at 12 rows, and this menu has more entries than
 * that, so anything at the bottom starts below the fold. Apply is the one row
 * every session must reach. It also lands under the cursor after each toggle,
 * because select() rebuilds the list each call with selectedIndex 0 — so the
 * common "tick a profile, apply" path is two keystrokes. The list wraps, so the
 * trailing bulk actions are still one Up press from the top.
 *
 * That cursor reset is why this is only the fallback now: it makes toggling two
 * adjacent profiles needlessly slow. See createProfileList.
 */
const pickerRows = (rows: readonly string[]): string[] => [
  APPLY,
  CANCEL,
  ...rows,
  SELECT_ALL,
  CLEAR,
];

const withToggled = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
};

// ---------------------------------------------------------------------------
// Profile picker — real multiselect via ctx.ui.custom
// ---------------------------------------------------------------------------

interface PickerResult {
  readonly action: "apply" | "cancel";
  readonly selected: readonly string[];
}

/** Rows visible at once, matching the cap ui.select applies to SelectList. */
const PICKER_VIEWPORT = 12;

const PICKER_HINT = "↑↓ move · space toggle · a all · n none · enter apply · esc cancel";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * A focused checkbox list that owns its cursor.
 *
 * The select()-driven picker this replaces had to reopen the dialog on every
 * toggle, and `ui.select` builds a fresh SelectList each call with
 * selectedIndex 0 and exposes no initial-index option
 * (`ExtensionUIDialogOptions` is only `signal`/`timeout`). So the cursor
 * snapped back to the top after each tick and selecting two adjacent profiles
 * meant navigating down twice. Holding the cursor across toggles requires
 * owning the component, which is what ui.custom is for.
 *
 * Cursor and checkbox state are mutable locals in this closure — a focused TUI
 * component is inherently stateful, and the state never escapes: `done` is
 * handed a fresh array.
 */
const createProfileList = (
  initial: ReadonlySet<string>,
  keybindings: KeyMatcher,
  done: (result: PickerResult) => void,
): TuiComponent => {
  const selected = new Set(initial);
  let cursor = 0;

  const toggleAt = (index: number): void => {
    const id = TOGGLES[index].id;
    if (!selected.delete(id)) selected.add(id);
  };

  return {
    invalidate(): void {
      // Nothing is cached between renders.
    },

    render(): string[] {
      const skills = skillsForSelection(selected);
      const lines = [`Scientific skills — ${describeCost(skills.length)}`, ""];

      // Keep the cursor centred where possible, exactly as SelectList does, so
      // scrolling feels identical to every other list in pi.
      const start = clamp(
        cursor - Math.floor(PICKER_VIEWPORT / 2),
        0,
        Math.max(0, TOGGLES.length - PICKER_VIEWPORT),
      );
      const end = Math.min(start + PICKER_VIEWPORT, TOGGLES.length);

      for (let i = start; i < end; i++) {
        const toggle = TOGGLES[i];
        const mark = selected.has(toggle.id) ? "x" : " ";
        const prefix = i === cursor ? "→ " : "  ";
        lines.push(`${prefix}[${mark}] ${toggle.label} — ${toggle.skills.length} skills`);
      }

      if (start > 0 || end < TOGGLES.length) {
        lines.push(`  (${cursor + 1}/${TOGGLES.length})`);
      }
      lines.push("", PICKER_HINT);
      return lines;
    },

    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.up")) {
        cursor = cursor === 0 ? TOGGLES.length - 1 : cursor - 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.down")) {
        cursor = cursor === TOGGLES.length - 1 ? 0 : cursor + 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        done({ action: "apply", selected: [...selected] });
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        done({ action: "cancel", selected: [] });
        return;
      }
      // Plain characters reach us untouched: SelectList ignores everything but
      // the four bindings above, so these letters collide with nothing.
      if (data === " ") {
        toggleAt(cursor);
        return;
      }
      if (data === "a" || data === "A") {
        for (const toggle of TOGGLES) selected.add(toggle.id);
        return;
      }
      if (data === "n" || data === "N") {
        selected.clear();
      }
    },
  };
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

  const chosen = await choose(ctx, saved);
  if (chosen === undefined) {
    report(ctx, "No changes made.", "info");
    return;
  }

  const skills = skillsForSelection(chosen);
  const summary =
    skills.length === 0
      ? "All scientific skills disabled."
      : `Active: ${describeCost(skills.length)}.`;
  await commitPlan(ctx, { kind: "filter", skills }, { kind: "set", ids: [...chosen] }, summary);
};

/**
 * Returns the chosen profile ids, or undefined if the user cancelled.
 *
 * Prefers the custom multiselect and falls back to the select() loop when
 * ui.custom is absent (older pi) or returns undefined (RPC mode), so the
 * command still works everywhere it used to.
 */
const choose = async (
  ctx: CommandContext,
  saved: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> => {
  // Safe to call detached: pi binds this as an arrow property on the UI context
  // (`interactive-mode.js:1695`), so it carries its own `this`.
  const custom = ctx.ui.custom;
  if (custom) {
    const result = await custom<PickerResult>((_tui, _theme, keybindings, done) =>
      createProfileList(saved, keybindings, done),
    );
    if (result !== undefined) {
      return result.action === "apply" ? new Set(result.selected) : undefined;
    }
  }
  return chooseViaSelect(ctx, saved);
};

/** Fallback picker: one select() dialog per toggle. The cursor resets each time. */
const chooseViaSelect = async (
  ctx: CommandContext,
  saved: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> => {
  let selected: ReadonlySet<string> = saved;

  for (;;) {
    const skills = skillsForSelection(selected);
    const prompt = `Scientific skills — ${describeCost(skills.length)}`;
    const rows = toggleRows(selected);
    const choice = await ctx.ui.select(prompt, pickerRows(rows));

    if (choice === undefined || choice === CANCEL) return undefined;
    if (choice === SELECT_ALL) {
      selected = new Set(TOGGLES.map((toggle) => toggle.id));
      continue;
    }
    if (choice === CLEAR) {
      selected = new Set();
      continue;
    }
    if (choice === APPLY) return selected;

    const index = rows.indexOf(choice);
    if (index >= 0) selected = withToggled(selected, TOGGLES[index].id);
  }
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

const dispatch = async (args: string, ctx: CommandContext): Promise<void> => {
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

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

/**
 * Two audiences, two obligations.
 *
 * A *new* user should be offered the cheap default rather than silently given
 * it: this package writes to someone else's settings.json, and it does that
 * only in answer to a question they were actually asked.
 *
 * An *existing* user must be told, once, when a release changes anything — and
 * must never be prompted or written to on the strength of an upgrade they did
 * not ask for. Their working setup is theirs.
 */

/** How long the first-run question waits before giving up and doing nothing. */
const OFFER_TIMEOUT_MS = 20_000;

const OFFER_ACCEPT = `Yes — load Core + ${TOOL_NAME} (recommended)`;
const OFFER_DECLINE = `No — keep all ${TOTAL_SKILL_COUNT} loaded`;

const offerTitle = (): string => {
  const core = TOGGLES.find((toggle) => toggle.id === DEFAULT_PROFILE_ID);
  const coreCost = core ? describeCost(skillsForSelection(new Set([DEFAULT_PROFILE_ID])).length) : "";
  return (
    `${PACKAGE_NAME}: all ${TOTAL_SKILL_COUNT} skills are loaded, costing ` +
    `~${formatTokens(BASELINE_TOKEN_COST)} tokens of context every session. ` +
    `Load just Core (${coreCost}) instead? ${TOOL_NAME} still reaches all ${TOTAL_SKILL_COUNT} on demand.`
  );
};

const upgradeNotice = (from: string | undefined): string =>
  [
    `${PACKAGE_NAME} updated to ${PACKAGE_VERSION}${from ? ` (from ${from})` : ""}.`,
    `Your current selection is unchanged.`,
    `New: ${TOOL_NAME} lets the model search all ${TOTAL_SKILL_COUNT} skills on demand,`,
    `so you can load fewer without losing access to any.`,
    `Run "/${COMMAND_NAME} search" to trim the always-loaded set to Core, or`,
    `"/${COMMAND_NAME} status" to see where you stand.`,
  ].join(" ");

/**
 * For someone who hand-filtered the package before ever running `/sci`.
 *
 * They have already answered the question the first-run offer asks, so they are
 * not offered anything. But they are still owed the news, and for them it is
 * more than a feature note: `${TOOL_NAME}` reaches the skills their filter
 * excludes. A filter was never a boundary — the model could always `read` any
 * SKILL.md — but shipping a tool that makes that routine without saying so
 * would be changing what they chose out from under them.
 */
const filteredNotice = (): string =>
  [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}: your "skills" filter is unchanged and`,
    `/${COMMAND_NAME} has not touched it.`,
    `New: ${TOOL_NAME} lets the model search all ${TOTAL_SKILL_COUNT} installed skills`,
    `on demand — including the ones your filter leaves out of the system prompt.`,
    `Run "/${COMMAND_NAME} status" to see where you stand.`,
  ].join(" ");

/**
 * Decide which of the two messages this user is owed, if either.
 *
 * Everything here is best-effort: a failure to read or write our own config
 * must never break someone's session over a notice.
 */
const handleStartup = async (pi: ExtensionAPI, ctx: UiContext): Promise<void> => {
  try {
    const config = await readConfig();

    // Anyone with prior state is an existing user, including someone who saw
    // the old hint and did nothing — inaction was their answer, so tell them
    // what changed rather than asking again.
    const isExistingUser = config.onboardingSeen === true || config.profiles !== undefined;

    if (isExistingUser) {
      if (config.lastSeenVersion === PACKAGE_VERSION) return;
      report(ctx, upgradeNotice(config.lastSeenVersion), "info");
      await writeConfig({ ...config, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    const settings = await readSettings(settingsPath());
    const location =
      settings.kind === "ok" ? findPackageEntry(settings.document.packages) : undefined;
    // Someone who already hand-filtered the package has answered this question.
    const alreadyFiltered =
      location !== undefined && typeof location.entry !== "string" && location.entry.skills !== undefined;

    if (alreadyFiltered) {
      report(ctx, filteredNotice(), "info");
      await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    // Only the TUI can answer a dialog. `hasUI` is true in RPC too, so gating
    // on it would hand a scripted client a prompt with nobody to respond.
    //
    // Verified in pi 0.84.2 rather than assumed: `bindExtensions` sets the mode
    // (agent-session.js:1746) and applies it to the runner (:1805) *before*
    // emitting session_start (:1761), so `ctx.mode` is populated here and not
    // still at its "print" default. interactive-mode.js passes "tui",
    // rpc-mode.js passes "rpc".
    if (ctx.mode !== "tui") {
      // `report`, not `ui.notify`: notify is a no-op with no UI bound, so a
      // `pi -p` user would be "informed" into the void and then marked as told.
      report(ctx, `${offerTitle()} Run "/${COMMAND_NAME} search" to switch.`, "info");
      await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    const choice = await ctx.ui.select(offerTitle(), [OFFER_ACCEPT, OFFER_DECLINE], {
      timeout: OFFER_TIMEOUT_MS,
    });

    // Record the answer before acting: whatever happens next, this question is
    // asked exactly once. Timeout and escape both land here as `undefined` and
    // are treated as "no" — silence never changes anyone's configuration.
    await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });

    if (choice !== OFFER_ACCEPT) return;

    // session_start's context has no `reload()`, so hand the work to the
    // command, which does — pi's documented pattern for exactly this.
    await pi.sendUserMessage(`/${COMMAND_NAME} search`, { deliverAs: "followUp" });
  } catch {
    // Startup must never fail because of a message.
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

  // The model-facing half of progressive disclosure. Registered unconditionally
  // when the catalogue is locatable: ~150 tokens of tool definition against a
  // ~18k index is not a trade worth a configuration flag, and a user running
  // the full set still benefits from being able to look a skill up by need
  // rather than by name.
  if (SKILLS_DIR) {
    pi.registerTool({
      name: TOOL_NAME,
      label: "Find scientific skill",
      description:
        `Search ${TOTAL_SKILL_COUNT} installed scientific skills (biology, genomics, ` +
        `chemistry, drug discovery, clinical research, imaging, physics, statistics, ML, ` +
        `scientific writing) and get the path to load one. Most of these skills are NOT ` +
        `listed in the system prompt, so this is the only way to discover them. Call it ` +
        `with a natural-language description of the task ("variant calling from a bam ` +
        `file", "fit a survival model"). Omit all arguments to list the profiles, or pass ` +
        `a profile id to list its skills. Returns skill names, full descriptions, and the ` +
        `SKILL.md path to read.`,
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "What you are trying to do, in natural language." }),
        ),
        profile: Type.Optional(
          Type.String({ description: "Profile id to list instead of searching." }),
        ),
        limit: Type.Optional(
          Type.Number({ description: `Maximum results (default ${DEFAULT_LIMIT}).` }),
        ),
      }),
      async execute(_toolCallId: string, params: ToolParams) {
        const text = runToolSearch(params);
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });
  }

  pi.on("session_start", async (event, ctx) => {
    // Only a genuine cold start; reload/new/resume/fork would re-nag.
    //
    // Deliberately NOT gated on ctx.hasUI. A `pi -p` user is still a user owed
    // the news, and handleStartup reports through `report()`, which falls back
    // to stderr precisely so those runs are not silent. Gating here would mark
    // them as told without telling them.
    if (event.reason !== "startup") return;
    await handleStartup(pi, ctx);
  });
}
