/**
 * /sci — curate which of the catalogue's scientific skills pi loads.
 *
 * Every skill's name + description is injected into the system prompt at startup
 * and stays there for the whole session (roughly 14k tokens for the full set).
 * Small or local models pay that twice: once in context budget, and again in
 * selection accuracy, because discriminating between many similar
 * descriptions is hard.
 *
 * The fix is pi's own per-package resource filter in settings.json:
 *
 *   { "packages": [{ "source": "pi-scientific-skills", "skills": ["scanpy", ...] }] }
 *
 * That is deliberate: skills/ is byte-identical to upstream and is replaced
 * wholesale by the sync script, so nothing here may ever touch a SKILL.md. The
 * filter lives in the user's own settings, stays hand-editable, composes with
 * `pi config`, and survives every upstream sync.
 *
 * The implementation is split across `types.ts` (shared constants and types),
 * `paths.ts` (filesystem paths and user-facing output), `settings.ts`
 * (settings.json and this package's own config file), `catalog.ts` (token
 * accounting, the skill catalogue, and `sci_find`'s search), `picker.ts` (the
 * `/sci profiles` checkbox list), and `commands.ts` (`/sci`'s subcommands).
 * This file is the only one pi loads as more than a no-op: every sibling ends
 * in the same inert `export default function noopExtension(): void {}`,
 * because pi's extension loader runs every file under `extensions/` and a
 * second real registrar would collide with this one.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  describeCost,
  expandFilteredSkill,
  formatTokens,
  parseSkillCommand,
  runToolSearch,
  skillsForSelection,
  SKILLS_DIR,
  type ToolParams,
} from "./catalog";
import { dispatch, hasSkillsFilter } from "./commands";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import { describeError, report, settingsPath } from "./paths";
import { BASELINE_TOKEN_COST, TOGGLES, TOTAL_SKILL_COUNT } from "./profiles";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./search";
import { findPackageEntry, readConfig, readSettings, writeConfig } from "./settings";
import {
  COMMAND_NAME,
  DEFAULT_PROFILE_ID,
  SUBCOMMANDS,
  TOOL_NAME,
  type CommandContext,
  type UiContext,
} from "./types";

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

/**
 * "1.4.1" and "1.4.0" share a minor line. A patch release changes only the
 * extension or the docs, never the skills or anyone's settings, so it owes the
 * user one line, not a re-run of the last minor release's news.
 */
const sameMinorLine = (from: string | undefined, current: string): boolean =>
  from !== undefined && from.split(".").slice(0, 2).join(".") === current.split(".").slice(0, 2).join(".");

/**
 * -1 / 0 / 1, comparing dot-separated numeric segments left to right. A
 * shorter version is padded with zeros, so "1.5" equals "1.5.0".
 *
 * Exported alongside `upgradeNotice` so `scripts/test-extension.mjs` can test
 * all three notice paths as pure functions with fixed version pairs, rather
 * than depending on `PACKAGE_VERSION`'s own patch component being non-zero.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
};

/**
 * An older release running after a newer one was already seen — a rollback,
 * or a saved config carried onto a machine with an older install. Owed one
 * honest line, not the newer release's own feature notes.
 */
const downgradeNotice = (from: string): string =>
  `${PACKAGE_NAME}: running ${PACKAGE_VERSION} after ${from}; your selection is unchanged.`;

/**
 * `current` defaults to `PACKAGE_VERSION` for every real call site; it takes
 * an explicit value only in `scripts/test-extension.mjs`'s pure-function
 * tests, which check the patch and minor notice text against fixed pairs
 * (e.g. "1.5.3"→"1.5.4", "1.5.0"→"1.6.0") independent of whatever version
 * this release actually carries — the case that matters at `x.y.0`, where
 * there is no lower patch in the same minor line to derive through startup.
 */
export const upgradeNotice = (from: string | undefined, current: string = PACKAGE_VERSION): string => {
  const head = [
    `${PACKAGE_NAME} updated to ${current}${from ? ` (from ${from})` : ""}.`,
    `Your current selection is unchanged.`,
  ];
  if (sameMinorLine(from, current)) {
    return [...head, `Patch release: no change to the skills, and your settings are untouched.`].join(" ");
  }
  return [
    ...head,
    `Upstream snapshot v2.69.0 (commit 49c6e97) adds one skill: alphagenome`,
    `(AlphaGenome Atlas variant-effect lookup and scoring, DeepMind; free`,
    `non-commercial API key). It also updates two skills: ontology-term-resolution`,
    `gains Bioregistry, Identifiers.org, ZOOMA and Ontobee companions, and`,
    `genomic-intelligence documents per-operation sync limits and an unreliable`,
    `splice-orientation check.`,
    `${TOOL_NAME} searches all ${TOTAL_SKILL_COUNT} skills on demand.`,
    `Run "/${COMMAND_NAME} search" to trim the always-loaded set to Core, or`,
    `"/${COMMAND_NAME} status" to see where you stand.`,
  ].join(" ");
};

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
    `Upstream snapshot v2.69.0 (commit 49c6e97) adds one skill, alphagenome`,
    `(AlphaGenome Atlas variant-effect lookup and scoring, DeepMind; free`,
    `non-commercial API key), which your filter does not include until you add`,
    `it. It also updates ontology-term-resolution (Bioregistry, Identifiers.org,`,
    `ZOOMA and Ontobee companions) and genomic-intelligence (per-operation sync`,
    `limits; the splice-orientation check is documented as unreliable).`,
    `${TOOL_NAME} searches all ${TOTAL_SKILL_COUNT} installed skills on demand —`,
    `including any your filter leaves out of the system prompt.`,
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

      if (
        config.lastSeenVersion !== undefined &&
        compareVersions(config.lastSeenVersion, PACKAGE_VERSION) > 0
      ) {
        report(ctx, downgradeNotice(config.lastSeenVersion), "info");
        // Deliberately NOT recorded: lastSeenVersion stays at the newer
        // version this user already saw notes for. Overwriting it with the
        // older one now running would make the real upgrade notice fire
        // again — a second time — the next time they reinstall the newer
        // release they have already been told about.
        return;
      }

      report(ctx, upgradeNotice(config.lastSeenVersion), "info");
      await writeConfig({ ...config, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    const settings = await readSettings(settingsPath());
    const location =
      settings.kind === "ok" ? findPackageEntry(settings.document.packages) : undefined;
    // Someone who already hand-filtered the package has answered this question.
    const alreadyFiltered = hasSkillsFilter(location);

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

    // session_start's context has no `reload()` (runner.js:579 emits with the
    // plain createContext(); only the *command* context gets one, :567), so hand
    // the work to the command, which does.
    //
    // `expandPromptTemplates: true` is load-bearing, not decoration.
    // sendUserMessage defaults it to FALSE (agent-session.js:1133 in pi
    // 0.84.3) — unlike prompt(), which defaults it to true (:796) — and
    // extension-command dispatch is gated on it (:802). Without the flag the literal text
    // "/sci search" is sent to the model as a user message: the user answers
    // yes, no filter is written, and a turn is burned telling the model
    // nothing. With it, _tryExecuteExtensionCommand runs the command and
    // returns before any LLM call.
    await pi.sendUserMessage(`/${COMMAND_NAME} search`, {
      deliverAs: "followUp",
      expandPromptTemplates: true,
    });
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
  // ~14k index is not a trade worth a configuration flag, and a user running
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
          Type.Integer({
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `Maximum results (default ${DEFAULT_LIMIT}). Capped at ${MAX_LIMIT}.`,
          }),
        ),
      }),
      async execute(_toolCallId: string, params: ToolParams) {
        const text = runToolSearch(params);
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });
  }

  // pi does not error on an unknown /skill:<name>; it forwards the literal text
  // to the model as prose (agent-session.js:963-964 in 0.84.3), so a
  // filtered-out skill looks like it loaded. The input event fires before pi's
  // own expansion (:816-826, then :830), so this hands back the block pi would
  // have built. The transform starts with "<", so neither _expandSkillCommand
  // (:957) nor expandPromptTemplate touches it afterwards. A stopgap until pi
  // reports the miss itself — DOCUMENTATION.md lists what it does not cover.
  if (SKILLS_DIR) {
    pi.on("input", async (event) => {
      const passThrough = { action: "continue" as const };
      try {
        // sendUserMessage defaults expandPromptTemplates to false
        // (agent-session.js:1133): pi's intent there is *not* to expand, and
        // the event does not carry that flag, so source is the only readable
        // proxy. pi's docs/extensions.md branches on the same field.
        if (event.source === "extension") return passThrough;

        const command = parseSkillCommand(event.text);
        if (!command) return passThrough;

        // Skills pi can still resolve stay pi's job. getCommands maps
        // getSkills().skills unfiltered (agent-session.js:1927-1932), the exact
        // array _expandSkillCommand searches. It also stops this hook shadowing
        // a same-named skill from another package, whose filePath/baseDir
        // would differ and silently break every relative reference in the body.
        const loaded = pi
          .getCommands()
          .some((c) => c.source === "skill" && c.name === `skill:${command.name}`);
        if (loaded) return passThrough;

        const text = await expandFilteredSkill(command);
        return text === undefined ? passThrough : { action: "transform" as const, text };
      } catch {
        // emitInput catches a throw, reports it, and passes the text through
        // unchanged (runner.js:952-958): the user would get a red banner *and*
        // the original bug. Let pi behave as it does today instead.
        return passThrough;
      }
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
