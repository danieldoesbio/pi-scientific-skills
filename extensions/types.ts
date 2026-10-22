/**
 * Shared constants and types for the /sci extension.
 *
 * Nothing here has behaviour. Many modules in `extensions/` import from this
 * one, so it imports nothing, which keeps the module graph acyclic.
 * `extensions/index.ts` is the only file that registers anything with pi.
 */

const COMMAND_NAME = "sci";
const CONFIG_VERSION = 1;
const TOOL_NAME = "sci_find";
/** pi's own prefix for forcing a skill (see pi's `AgentSession._expandSkillCommand`). */
const SKILL_COMMAND_PREFIX = "/skill:";

const SUBCOMMANDS = ["status", "profiles", "search", "find", "all", "none", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export {
  COMMAND_NAME,
  CONFIG_VERSION,
  TOOL_NAME,
  SKILL_COMMAND_PREFIX,
  SUBCOMMANDS,
};
export type { Subcommand };

/**
 * The usage hint, shown by `commands.ts` (in the `/sci status` report and the
 * unknown-subcommand warning) and by `picker.ts`'s `runPicker` (no interactive
 * UI). It lives here because `commands.ts` imports `picker.ts` for
 * `runPicker`; defining it in `commands.ts` would make `picker.ts` import it
 * back, a cycle.
 */
export const usage = (): string =>
  `/${COMMAND_NAME} [${SUBCOMMANDS.join(" | ")}], or /${COMMAND_NAME} alone for the menu.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural subsets of pi's ExtensionContext / ExtensionCommandContext with
 * only the documented members used here. Declared locally so this file relies
 * on documented behaviour, never on a type name pi might not export.
 */
/** The slice of pi-tui's KeybindingsManager the picker needs. */
export interface KeyMatcher {
  matches(data: string, keybinding: string): boolean;
}

/**
 * The slice of pi-tui's `Component` a focused custom view must provide.
 * The real interface requires `invalidate`, so it is declared here; the
 * picker caches nothing and implements it as a no-op.
 */
export interface TuiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface UiContext {
  readonly hasUI: boolean;
  /**
   * pi's run mode: "tui" | "rpc" | "json" | "print". `hasUI` is true in RPC
   * mode as well, so anything that blocks on a human must gate on
   * `mode === "tui"`, or a scripted client gets a dialog it cannot answer.
   */
  readonly mode?: string;
  readonly cwd: string;
  readonly ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    select(
      prompt: string,
      options: string[],
      dialogOptions?: { timeout?: number },
    ): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    /**
     * Renders a focused custom component. Interactive mode only: RPC mode's
     * `custom()` (from `createExtensionUIContext` in `runRpcMode`,
     * `dist/modes/rpc/rpc-mode.js`) returns undefined without rendering, and
     * older pi builds may not define the method at all. Callers must treat a
     * missing method and an undefined result as "unsupported" and fall back,
     * which is why the picker's own result type is always an object.
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

export interface CommandContext extends UiContext {
  reload(): Promise<void>;
}

/** A `packages` entry in object form. Unknown keys are preserved verbatim. */
export interface PackageFilter {
  source?: string;
  skills?: string[];
  autoload?: boolean;
  [key: string]: unknown;
}

export type PackageEntry = string | PackageFilter;

/** settings.json as read from disk: known keys plus everything we must not lose. */
export interface SettingsDocument {
  packages?: unknown;
  [key: string]: unknown;
}

/** Our own state file. Profile ids, not expanded skills, so labels can evolve. */
export interface ExtensionConfig {
  version?: number;
  onboardingSeen?: boolean;
  profiles?: string[];
  /**
   * Last package version whose changes this user was told about. Absent means
   * either a fresh install or an upgrade from a release that predates the
   * notice; `onboardingSeen` tells the two apart.
   */
  lastSeenVersion?: string;
  updatedAt?: string;
}

export type SettingsRead =
  | { readonly kind: "ok"; readonly document: SettingsDocument; readonly raw: string }
  | { readonly kind: "missing" }
  // A read that failed for any reason other than "not there": permissions,
  // EISDIR, ELOOP, I/O. Kept apart from `malformed` because telling someone to
  // "fix the JSON" in a file they cannot open invites them to destroy it.
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "malformed"; readonly detail: string };

export type FailedRead = Exclude<SettingsRead, { kind: "ok" }>;

export interface PackageLocation {
  readonly index: number;
  readonly entry: PackageEntry;
  readonly source: string;
}

export type ApplyPlan =
  | { readonly kind: "filter"; readonly skills: readonly string[] }
  | { readonly kind: "unfiltered" };

export type ApplyResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly message: string };

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
