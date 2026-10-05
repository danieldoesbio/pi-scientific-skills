/**
 * /sci — curate which of the catalogue's scientific skills pi loads.
 *
 * Every skill's name + description is injected into the system prompt at startup
 * and stays there for the whole session (roughly 23k tokens for the full set).
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
  createSearchStage,
  expandFilteredSkill,
  formatTokens,
  parseSkillCommand,
  runToolSearch,
  SKILLS_DIR,
  type ToolParams,
} from "./catalog";
import { dispatch, hasSkillsFilter } from "./commands";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import { describeError, report, settingsPath } from "./paths";
import { BASELINE_TOKEN_COST, TOTAL_SKILL_COUNT } from "./profiles";
import { FIRST_SEARCH_LIMIT, LATER_SEARCH_LIMIT } from "./search";
import { findPackageEntry, readConfig, readSettings, writeConfig } from "./settings";
import {
  COMMAND_NAME,
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

// Declining keeps every skill loaded but not the tool set as it was: the tool is
// registered whatever the answer, so the row says it stays available. It does
// not say the prompt lists it: pi's default prompt does, a custom one (SYSTEM.md,
// --system-prompt) drops the tools section.
// scripts/test-tui-offer.py waits for "search mode:" and expects only the accept
// row to carry it.
const OFFER_ACCEPT = `Yes — search mode: ${TOOL_NAME} finds skills as needed (recommended)`;
const OFFER_DECLINE = `No — keep all ${TOTAL_SKILL_COUNT} loaded (${TOOL_NAME} stays available)`;

const offerTitle = (): string =>
  `${PACKAGE_NAME}: all ${TOTAL_SKILL_COUNT} skills are loaded, costing ` +
  `~${formatTokens(BASELINE_TOKEN_COST)} tokens of context every session. ` +
  `Switch to search mode instead? No skills stay in the prompt, and ${TOOL_NAME} ` +
  `finds any of the ${TOTAL_SKILL_COUNT} on demand.`;

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

/** The release that shipped upstream snapshot v2.69.0. */
const SNAPSHOT_RELEASE = "1.6.0";

/** The release whose search changes `searchNews` describes. */
const SEARCH_RELEASE = "1.7.0";

/** The release that shipped upstream snapshot v2.72.0. */
const SYNC_RELEASE = "1.8.0";

/**
 * What 1.8.0 changed. A profile selection is saved in settings.json as the
 * skill names it held when it was applied (`skillsForSelection`), so the new
 * skills reach a profile user only after the picker writes the filter again.
 * Search mode reads skills/ directly and finds them at once.
 */
const SYNC_NEWS = [
  `Upstream snapshot v2.72.0 (in ${SYNC_RELEASE}) adds 14 skills to the field profiles, among them`,
  `primer-design, mageck, flowkit, qiime2-amplicon, cellprofiler, relion and pybamm. A saved`,
  `profile picks them up when you open "/${COMMAND_NAME} profiles" and press Enter; search mode finds`,
  `them already. fictiv is not shipped: it can place paid orders that cannot be cancelled.`,
];

const SNAPSHOT_NEWS = [
  `Upstream snapshot v2.69.0 (commit 49c6e97, in ${SNAPSHOT_RELEASE}) adds one skill: alphagenome`,
  `(AlphaGenome Atlas variant-effect lookup and scoring, DeepMind; free`,
  `non-commercial API key). It also updates two skills: ontology-term-resolution`,
  `gains Bioregistry, Identifiers.org, ZOOMA and Ontobee companions, and`,
  `genomic-intelligence documents per-operation sync limits and an unreliable`,
  `splice-orientation check.`,
];

/**
 * Two facts both 1.7.0 news notices (`searchNews` and `filteredNotice`) give, in one place so `searchNews` and
 * `filteredNotice` cannot drift apart. The 1.6.0 clause on `/sci none` stays in
 * `searchNews`: someone who hand-filtered before ever running `/sci` never ran
 * `/sci none`.
 */
const DEFAULT_PROMPT_NEWS =
  `In pi's default system prompt (not a custom SYSTEM.md or --system-prompt) ${TOOL_NAME} ` +
  `is now listed, with a guideline to use it for scientific, research and analysis work.`;
const EMPTY_FILTER_MEANING = `now means search mode, not off; ${TOOL_NAME} stays on.`;

/**
 * What 1.7.0 changed, written once for every 1.6.0 state: Core accepted, the
 * offer declined, `/sci none`, Core plus a `pi config` override. It says what
 * the commands and an empty filter mean now, never what the reader chose, so
 * each line is true for someone who did nothing. `scripts/test-extension.mjs`
 * checks it against three 1.6.0 states (Core accepted; offer declined, which leaves
 * only the install entry; `/sci none`) and one with a `pi config` override added.
 *
 * - Search: a new ranker and hit counts for everyone, and no `limit` argument.
 *   `PI_SCI_FIND_RANKER=current` brings back the old order, not the old count.
 * - The listing and guideline are in pi's default system prompt only. pi builds
 *   a custom one (SYSTEM.md, `--system-prompt`) without the tools section or
 *   the guidelines (system-prompt.js, `if (customPrompt)`).
 * - An empty `skills` filter is search mode now. 1.6.0's `/sci none` wrote one
 *   to mean off; the tool stays on, and their settings are not touched.
 * - `/sci search` writes an empty filter, where 1.6.0 wrote Core, and names the
 *   `pi config` overrides that drops. The way back to Core is the picker.
 * - `"extensions": []` on the package's object entry stops pi loading the
 *   extension: no tool, no `/sci`. Checked against pi's own resolver in 0.84.3,
 *   0.87.0 and 1.0.0; the `skills` filter then works as the user wrote it.
 */
const searchNews = (): string[] => [
  `${TOOL_NAME} ranks with BM25F and shows ${FIRST_SEARCH_LIMIT} hits on a prompt's first search, then`,
  `${LATER_SEARCH_LIMIT}; its "limit" argument is gone. PI_SCI_FIND_RANKER=current restores the old`,
  `ranking order only.`,
  DEFAULT_PROMPT_NEWS,
  `An empty "skills" filter (1.6.0's "/${COMMAND_NAME} none") ${EMPTY_FILTER_MEANING}`,
  `"/${COMMAND_NAME} search" no longer loads Core and names any pi config`,
  `overrides it drops. To load Core: "/${COMMAND_NAME} profiles", tick Core, press Enter.`,
  `Turn ${TOOL_NAME} and /${COMMAND_NAME} off with "extensions": [] on the package's object entry`,
  `in settings.json.`,
];

/**
 * `current` defaults to `PACKAGE_VERSION` for every real call site; it takes
 * an explicit value only in `scripts/test-extension.mjs`'s pure-function
 * tests, which check the patch and minor notice text against fixed pairs
 * (e.g. "1.5.3"→"1.5.4", "1.6.0"→"1.7.0") independent of whatever version
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
  // Each release's news is owed to anyone who comes from before it, up to the
  // release now running: someone skipping releases hears every one they missed.
  const owed = (release: string): boolean =>
    compareVersions(current, release) >= 0 && (from === undefined || compareVersions(from, release) < 0);
  return [
    ...head,
    ...(owed(SYNC_RELEASE) ? SYNC_NEWS : []),
    ...(owed(SEARCH_RELEASE) ? searchNews() : []),
    ...(owed(SNAPSHOT_RELEASE) ? SNAPSHOT_NEWS : []),
    `"/${COMMAND_NAME} status" shows where you stand.`,
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
 *
 * It also gives the two facts both 1.7.0 news notices give, from the constants above:
 * where the listing is (and is not), and what an empty filter means now. A
 * `skills: []` written by hand meant "off" before 1.7.0.
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
    `${TOOL_NAME} searches all ${TOTAL_SKILL_COUNT} installed skills on demand,`,
    `including any your filter leaves out of the system prompt.`,
    DEFAULT_PROMPT_NEWS,
    `An empty "skills" filter ${EMPTY_FILTER_MEANING}`,
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
  // when the catalogue is locatable: a tool definition of about 200 tokens,
  // plus a one-line snippet and one guideline, against a ~23k index is not a
  // trade worth a configuration flag, and a user running the full set still
  // benefits from being able to look a skill up by need rather than by name.
  //
  // pi lists a custom tool in the tools section of its default system prompt
  // only when it has a promptSnippet (system-prompt.js filters on it). Without
  // one the model sees sci_find only in the tool schema. In the 2026-09-23 live
  // test, 15 of 19 misses on valid probes were attempts that never called it.
  // Guidelines go into pi's own list with no tool heading, so each one names
  // the tool. A custom system prompt drops the tools section and the guidelines;
  // see `searchNews`.
  if (SKILLS_DIR) {
    // A user message (the prompt, a steer or a follow-up) starts a new first
    // search, and so does a custom message that opens an agent run
    // (pi.sendMessage with triggerTurn); see createSearchStage. agent_start
    // alone does not: pi emits it again for continue().
    const searchStage = createSearchStage();
    pi.on("agent_start", async () => searchStage.agentStart());
    pi.on("message_start", async (event) => searchStage.messageStart(event.message?.role));
    pi.on("turn_start", async () => searchStage.turnStart());
    pi.registerTool({
      name: TOOL_NAME,
      label: "Find scientific skill",
      promptSnippet:
        `Search the ${TOTAL_SKILL_COUNT} installed skills for scientific, research and ` +
        `analysis work, and get the SKILL.md path to read`,
      promptGuidelines: [
        `Use ${TOOL_NAME} before you write code, install a package or set up a service for ` +
          `scientific, research or analysis work: a skill may already cover it. Then read the ` +
          `SKILL.md it returns.`,
      ],
      description:
        `Search ${TOTAL_SKILL_COUNT} installed skills for scientific, research and analysis ` +
        `work (biology, genomics, chemistry, drug discovery, clinical research, imaging, ` +
        `physics, statistics, ML, scientific writing) and get the path to load one. Skills ` +
        `cover analysis methods, code and data work, databases, lab and cloud tools and ` +
        `services, and writing. ` +
        `Most of these skills are NOT listed in the system prompt, so this is the only ` +
        `way to discover them. Call it with a natural-language description of the task ` +
        `("variant calling from a bam file", "fit a survival model"). Omit all arguments ` +
        `to list the profiles, or pass a profile id to list its skills. Returns skill ` +
        `names, full descriptions, and the SKILL.md path to read. The first search ` +
        `returns the best ${FIRST_SEARCH_LIMIT} matches and later searches the best ` +
        `${LATER_SEARCH_LIMIT}; if none fits, search again with other words.`,
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({ description: "What you are trying to do, in natural language." }),
        ),
        profile: Type.Optional(
          Type.String({ description: "Profile id to list instead of searching." }),
        ),
      }),
      async execute(_toolCallId: string, params: ToolParams) {
        // No `limit` argument: in the 2026-09-27 panel the models set one in
        // 578 of 1,341 calls, mostly 10 to 20, which undoes a short list. A
        // stray `limit` from a model is ignored.
        const text = runToolSearch({
          query: params.query,
          profile: params.profile,
          limit: searchStage.limitFor(params),
        });
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
        // proxy. pi's examples/extensions/input-transform.ts branches on the same
        // field (so did docs/extensions.md up to pi 0.87).
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
