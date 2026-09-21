/**
 * Filesystem paths the /sci extension reads and writes, and the one shared
 * output helper every user-facing message goes through.
 */

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { PACKAGE_NAME } from "./package-info";
import type { UiContext } from "./types";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * pi's own resolver: it honours $PI_CODING_AGENT_DIR (and the equivalent
 * variable in a rebranded distribution) before falling back to ~/<config>/agent.
 * Reconstructing the fallback here would point /sci at a settings.json that pi
 * is not reading.
 */
export const agentDir = (): string => getAgentDir();
export const settingsPath = (): string => join(agentDir(), "settings.json");
export const configPath = (): string => join(agentDir(), `${PACKAGE_NAME}.json`);
export const backupPath = (): string => `${settingsPath()}.${PACKAGE_NAME}.bak`;
export const projectSettingsPath = (cwd: string): string =>
  join(cwd, CONFIG_DIR_NAME, "settings.json");

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * ctx.ui.notify is a no-op when no UI is bound (`pi -p`, JSON and RPC-less
 * modes), which is exactly where the non-interactive subcommands are used. Every
 * user-facing string goes through here so those runs are never silent.
 */
export const report = (
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

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
