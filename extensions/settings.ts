/**
 * Reading and writing pi's settings.json (the package's `skills` filter) and
 * this extension's own config file, plus `commitPlan` — the one function that
 * ties a filter change to a saved profile selection and a reload.
 *
 * `commitPlan` lives here rather than in `commands.ts` because both
 * `commands.ts` and `picker.ts` call it: putting it in either of those two
 * would make them import each other, which `tsc --strict` rejects as
 * use-before-define across the cycle. This is the lowest module both can
 * depend on instead.
 */

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
import { PACKAGE_NAME } from "./package-info";
import {
  agentDir,
  backupPath,
  configPath,
  describeError,
  errorCode,
  projectSettingsPath,
  report,
  settingsPath,
  sleep,
} from "./paths";
import { CONFIG_VERSION } from "./types";
import type {
  ApplyPlan,
  ApplyResult,
  CommandContext,
  ExtensionConfig,
  FailedRead,
  PackageEntry,
  PackageFilter,
  PackageLocation,
  SettingsDocument,
  SettingsRead,
} from "./types";

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

export const readSettings = async (path: string): Promise<SettingsRead> => {
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

export const describeFailedRead = (path: string, read: FailedRead): string => {
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

export const findPackageEntry = (packages: unknown): PackageLocation | undefined => {
  if (!Array.isArray(packages)) return undefined;
  for (const [index, entry] of packages.entries()) {
    const source = entrySource(entry as PackageEntry);
    if (source === undefined || !sourceNamesPackage(source)) continue;
    return { index, entry: entry as PackageEntry, source };
  }
  return undefined;
};

/** `!exclude`, `+force-include`, `-force-exclude` — pi's override syntaxes. */
export const isOverridePattern = (pattern: string): boolean => /^[!+-]/.test(pattern);

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
export const projectOverride = async (cwd: string): Promise<string | undefined> => {
  const path = projectSettingsPath(cwd);
  const read = await readSettings(path);
  if (read.kind !== "ok") return undefined;

  const location = findPackageEntry(read.document.packages);
  if (!location) return undefined;

  const entry = location.entry;
  if (typeof entry !== "string" && entry.autoload === false) return undefined;
  return path;
};

export const projectOverrideMessage = (path: string): string =>
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

export const readConfig = async (): Promise<ExtensionConfig> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ExtensionConfig;
  } catch {
    // Missing or corrupt: this file is ours alone, so starting over is safe.
    return {};
  }
};

export const writeConfig = async (config: ExtensionConfig): Promise<void> => {
  await mkdir(agentDir(), { recursive: true });
  const next: ExtensionConfig = {
    ...config,
    version: CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(configPath(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
};

// ---------------------------------------------------------------------------
// commitPlan — shared by commands.ts and picker.ts; see the file header.
// ---------------------------------------------------------------------------

/**
 * What happens to the saved profile ids. `keep` matters for /sci all: turning
 * everything back on temporarily must not destroy a curated selection, which is
 * the difference between /sci all and /sci reset.
 */
export type ProfileUpdate =
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
export const commitPlan = async (
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

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
