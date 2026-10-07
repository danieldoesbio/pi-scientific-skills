/**
 * /sci: curate which of the catalogue's scientific skills pi loads.
 *
 * pi puts every skill's name and description in the system prompt at startup,
 * and they stay there for the whole session (`BASELINE_TOKEN_COST`, about 25k
 * tokens for the full set). Small or local models pay twice: in context
 * budget, and in selection accuracy, because telling many similar descriptions
 * apart is hard.
 *
 * /sci uses pi's own per-package resource filter in settings.json:
 *
 *   { "packages": [{ "source": "pi-scientific-skills", "skills": ["scanpy", ...] }] }
 *
 * skills/ is byte-identical to upstream and the sync script replaces it
 * wholesale, so nothing here may touch a SKILL.md. The filter lives in the
 * user's own settings, stays hand-editable, composes with `pi config`, and
 * survives every upstream sync.
 *
 * This is the only file pi loads as more than a no-op. pi's extension loader
 * runs every file under `extensions/`, and a second real registrar would
 * collide with this one, so every sibling ends in the same inert
 * `export default function noopExtension(): void {}`. DOCUMENTATION.md's
 * "Structure" section says what each sibling holds.
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
import { findPackageEntry, isOverridePattern, readConfig, readSettings, writeConfig } from "./settings";
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
 * Two audiences, two obligations (DOCUMENTATION.md, "Startup messaging").
 *
 * A new user is offered the cheap default and never silently given it: this
 * package writes to someone else's settings.json, and only in answer to a
 * question they were asked.
 *
 * An existing user is told once when a release changes anything, and is never
 * prompted or written to because of an upgrade they did not ask for. Their
 * working setup is theirs.
 */

/** How long the first-run question waits before giving up and doing nothing. */
const OFFER_TIMEOUT_MS = 20_000;

// Declining keeps every skill loaded, but the tool set still changes: the tool
// is registered whatever the answer, so the decline row says it stays
// available. That row does not say the prompt lists the tool: pi's default
// prompt does, but a custom one (SYSTEM.md, --system-prompt) drops the tools
// section. scripts/test-tui-offer.py waits for "search mode:" and expects only
// the accept row to carry it.
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
 * user one line and does not repeat the minor release's news.
 */
const sameMinorLine = (from: string | undefined, current: string): boolean =>
  from !== undefined && from.split(".").slice(0, 2).join(".") === current.split(".").slice(0, 2).join(".");

/**
 * -1 / 0 / 1, comparing dot-separated numeric segments left to right. A
 * shorter version is padded with zeros, so "1.5" equals "1.5.0".
 *
 * Exported with `upgradeNotice` so `scripts/test-extension.mjs` can test all
 * three notice paths as pure functions on fixed version pairs, whatever
 * `PACKAGE_VERSION`'s own patch component is.
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
 * An older release running after a newer one was seen: a rollback, or a saved
 * config carried to a machine with an older install. It gets one line, without
 * the newer release's feature notes.
 */
const downgradeNotice = (from: string): string =>
  `${PACKAGE_NAME}: running ${PACKAGE_VERSION} after ${from}; your selection is unchanged.`;

/**
 * Two facts that both the upgrade notice (`searchNews`) and `filteredNotice`
 * give, defined once so they cannot drift apart. The 1.6.0 clause on
 * `/sci none` stays in `searchNews`: someone who hand-filtered before ever
 * running `/sci` never ran `/sci none`.
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
 * checks it against each of those states.
 *
 * - Search: a new ranker and hit counts for everyone, and no `limit` argument.
 * - The listing and guideline appear only in pi's default system prompt. pi
 *   builds a custom one (SYSTEM.md, `--system-prompt`) without the tools
 *   section or the guidelines.
 * - An empty `skills` filter now means search mode. 1.6.0's `/sci none` wrote
 *   one to mean off; the tool stays on, and their settings are not touched.
 * - `/sci search` writes an empty filter (1.6.0 wrote Core) and names the
 *   `pi config` overrides that drops. The way back to Core is the picker.
 * - `"extensions": []` on the package's object entry stops pi loading the
 *   extension: no tool, no `/sci`, and the `skills` filter works as written.
 */
const searchNews = (): string[] => [
  `${TOOL_NAME} ranks with BM25F and shows ${FIRST_SEARCH_LIMIT} hits on a prompt's first search, then`,
  `${LATER_SEARCH_LIMIT}; its "limit" argument is gone.`,
  DEFAULT_PROMPT_NEWS,
  `An empty "skills" filter (1.6.0's "/${COMMAND_NAME} none") ${EMPTY_FILTER_MEANING}`,
  `"/${COMMAND_NAME} search" no longer loads Core and names any pi config`,
  `overrides it drops. To load Core: "/${COMMAND_NAME} profiles", tick Core, press Enter.`,
  `Turn ${TOOL_NAME} and /${COMMAND_NAME} off with "extensions": [] on the package's object entry`,
  `in settings.json.`,
];

/**
 * A new upstream snapshot. Both notices state `upstream` and `adds`; `more`
 * is for the upgrade notice only.
 */
interface Snapshot {
  readonly upstream: string;
  readonly commit?: string;
  /** Completes "Upstream snapshot <upstream> (<commit, >in <release>) adds ...". */
  readonly adds: string;
  /** Other changes in the snapshot, as whole sentences. */
  readonly more: readonly string[];
}

/**
 * One release's news. A release that ships a new upstream snapshot sets
 * `snapshot`, which both notices read. `news`, and a snapshot's `more`, are
 * for the upgrade notice only.
 */
interface ReleaseNews {
  readonly release: string;
  readonly snapshot?: Snapshot;
  readonly news?: () => string[];
}

/**
 * Every release with news, newest first. A sync adds an entry here:
 * `scripts/test-extension.mjs` fails until the newest snapshot is the
 * `upstreamVersion` in package.json.
 */
const RELEASES: readonly ReleaseNews[] = [
  {
    release: "1.8.0",
    snapshot: {
      upstream: "v2.72.0",
      adds:
        "14 skills to the field profiles, among them primer-design, mageck, flowkit, " +
        "qiime2-amplicon, cellprofiler, relion and pybamm",
      more: ["fictiv is not shipped: it can place paid orders that cannot be cancelled."],
    },
  },
  { release: "1.7.0", news: searchNews },
  {
    release: "1.6.0",
    snapshot: {
      upstream: "v2.69.0",
      commit: "49c6e97",
      adds:
        "one skill: alphagenome (AlphaGenome Atlas variant-effect lookup and scoring, " +
        "DeepMind; free non-commercial API key)",
      more: [
        "It also updates two skills: ontology-term-resolution gains Bioregistry, " +
          "Identifiers.org, ZOOMA and Ontobee companions, and genomic-intelligence " +
          "documents per-operation sync limits and an unreliable splice-orientation check.",
      ],
    },
  },
];

/**
 * How a profile user picks up a snapshot's new skills. A profile is saved in
 * settings.json as the skill names it held when applied (`skillsForSelection`),
 * so new skills reach it only when the picker writes the filter again. Search
 * mode reads skills/ directly.
 */
const PROFILE_ADVICE =
  `A saved profile picks up new skills when you open "/${COMMAND_NAME} profiles" and ` +
  `press Enter; search mode finds them already.`;

/**
 * What a filter written by hand does with new skills, by its shape. pi starts
 * from every skill when a filter has no plain names (`applyPatterns` in its
 * package manager), so a filter of overrides alone, which is what `pi config`
 * writes when someone unticks a skill, loads new skills already. Plain names
 * list exactly what loads. An empty array is search mode.
 */
const filterAdvice = (skills: unknown): string => {
  if (Array.isArray(skills) && skills.length === 0) {
    return `In search mode ${TOOL_NAME} finds new skills already.`;
  }
  if (Array.isArray(skills) && skills.every((pattern) => typeof pattern === "string" && isOverridePattern(pattern))) {
    return `Your filter only lists exceptions, so new skills load already.`;
  }
  return `Your filter does not include new skills until you add them.`;
};

/**
 * The news owed to someone coming from `from` (undefined: unknown, so all of
 * it) to `current`, newest release first. `advice`, when given, follows the
 * newest snapshot's first sentence, once. `full: false` gives only what each
 * snapshot adds.
 */
const owedNews = (
  from: string | undefined,
  current: string,
  advice: string | undefined,
  full: boolean,
): string[] => {
  let advised = advice === undefined;
  return RELEASES.filter(
    ({ release }) =>
      compareVersions(current, release) >= 0 && (from === undefined || compareVersions(from, release) < 0),
  ).flatMap(({ release, snapshot, news }) => {
    const lines: string[] = [];
    if (snapshot) {
      const where = snapshot.commit ? `commit ${snapshot.commit}, in ${release}` : `in ${release}`;
      lines.push(`Upstream snapshot ${snapshot.upstream} (${where}) adds ${snapshot.adds}.`);
      if (!advised && advice !== undefined) lines.push(advice);
      advised = true;
      if (full) lines.push(...snapshot.more);
    }
    if (full && news) lines.push(...news());
    return lines;
  });
};

/**
 * The notice for an existing user who last saw `from` (undefined when
 * unknown, and then all the news is owed). Within one minor line it says only
 * that this is a patch release; otherwise it gives the news of every release
 * after `from`.
 *
 * `current` is `PACKAGE_VERSION` at every real call site. Only
 * `scripts/test-extension.mjs`'s pure-function tests pass it, to check the
 * text on fixed version pairs (e.g. "1.5.3" to "1.5.4", "1.6.0" to "1.7.0")
 * whatever version this release carries. That matters at `x.y.0`, which has
 * no lower patch in its own minor line to reach through startup.
 */
export const upgradeNotice = (from: string | undefined, current: string = PACKAGE_VERSION): string => {
  const head = [
    `${PACKAGE_NAME} updated to ${current}${from ? ` (from ${from})` : ""}.`,
    `Your current selection is unchanged.`,
  ];
  if (sameMinorLine(from, current)) {
    return [...head, `Patch release: no change to the skills, and your settings are untouched.`].join(" ");
  }
  // Someone skipping releases hears every one they missed.
  return [
    ...head,
    ...owedNews(from, current, PROFILE_ADVICE, true),
    `"/${COMMAND_NAME} status" shows where you stand.`,
  ].join(" ");
};

/**
 * The notice for someone who hand-filtered the package before ever running
 * `/sci`.
 *
 * They have already answered the first-run offer's question, so they are
 * offered nothing. They are still owed the news, and part of it changes what
 * their filter means in practice: `sci_find` reaches the skills their filter
 * excludes. A filter was never a boundary (the model could always `read` any
 * SKILL.md), but shipping a tool that makes that routine without saying so
 * would change what they chose out from under them.
 *
 * Their last version is unknown, so every snapshot in RELEASES is owed, as
 * what it adds, then once what their filter does with new skills
 * (`filterAdvice`). It also gives the two facts the upgrade notice gives: where
 * the listing is (and is not), and what an empty filter means now. A
 * hand-written `skills: []` meant "off" before 1.7.0.
 */
const filteredNotice = (skills: unknown): string => {
  const snapshots = owedNews(undefined, PACKAGE_VERSION, undefined, false);
  return [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}: your "skills" filter is unchanged and`,
    `/${COMMAND_NAME} has not touched it.`,
    ...snapshots,
    ...(snapshots.length > 0 ? [filterAdvice(skills)] : []),
    `${TOOL_NAME} searches all ${TOTAL_SKILL_COUNT} installed skills on demand,`,
    `including any your filter leaves out of the system prompt.`,
    DEFAULT_PROMPT_NEWS,
    `An empty "skills" filter ${EMPTY_FILTER_MEANING}`,
    `Run "/${COMMAND_NAME} status" to see where you stand.`,
  ].join(" ");
};

/**
 * Decide what this user is owed at startup, if anything: the first-run offer
 * or one of the notices.
 *
 * Everything here is best-effort: a failure to read or write our own config
 * must never break someone's session over a notice.
 */
const handleStartup = async (pi: ExtensionAPI, ctx: UiContext): Promise<void> => {
  try {
    const config = await readConfig();

    // Anyone with prior state is an existing user, including someone who saw
    // the old hint and did nothing: inaction was their answer, so they are told
    // what changed and not asked again.
    const isExistingUser = config.onboardingSeen === true || config.profiles !== undefined;

    if (isExistingUser) {
      if (config.lastSeenVersion === PACKAGE_VERSION) return;

      if (
        config.lastSeenVersion !== undefined &&
        compareVersions(config.lastSeenVersion, PACKAGE_VERSION) > 0
      ) {
        report(ctx, downgradeNotice(config.lastSeenVersion), "info");
        // Not recorded: lastSeenVersion stays at the newer version whose notes
        // this user has seen. Overwriting it with the older one would fire that
        // upgrade notice a second time when they reinstall the newer release.
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
      const skills = location && typeof location.entry !== "string" ? location.entry.skills : undefined;
      report(ctx, filteredNotice(skills), "info");
      await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    // Only the TUI can answer a dialog. `hasUI` is true in RPC too, so gating
    // on it would hand a scripted client a prompt with nobody to respond.
    //
    // `ctx.mode` is already set here (its default is "print"): pi's
    // `AgentSession.bindExtensions` stores the mode and applies it to the
    // runner (`_applyExtensionBindings`) before it emits session_start.
    // interactive-mode.js passes "tui", rpc-mode.js passes "rpc".
    if (ctx.mode !== "tui") {
      // Through `report` because `ui.notify` is a no-op with no UI bound: a
      // `pi -p` user would be "informed" into the void and then marked as told.
      report(ctx, `${offerTitle()} Run "/${COMMAND_NAME} search" to switch.`, "info");
      await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });
      return;
    }

    const choice = await ctx.ui.select(offerTitle(), [OFFER_ACCEPT, OFFER_DECLINE], {
      timeout: OFFER_TIMEOUT_MS,
    });

    // Record the answer before acting, so the question is asked once whatever
    // happens next. Timeout and escape both arrive as `undefined` and count as
    // "no": silence never changes anyone's configuration.
    await writeConfig({ ...config, onboardingSeen: true, lastSeenVersion: PACKAGE_VERSION });

    if (choice !== OFFER_ACCEPT) return;

    // session_start's context has no `reload()`: pi's `ExtensionRunner.emit`
    // passes every handler the plain `createContext()`, and only
    // `ExtensionRunner.createCommandContext` adds `reload`. So the work goes to
    // the command, which has one.
    //
    // `expandPromptTemplates: true` is required. `AgentSession.sendUserMessage`
    // defaults it to false (`AgentSession.prompt` defaults it to true), and
    // `prompt` dispatches extension commands only when it is set. Without it
    // the literal text "/sci search" goes to the model as a user message: the
    // user answers yes, no filter is written, and a turn is spent telling the
    // model nothing. With it, `_tryExecuteExtensionCommand` runs the command
    // and returns before any LLM call.
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

  // The model-facing half of progressive disclosure. Registered whenever the
  // catalogue is locatable, with no configuration flag: a tool definition of
  // about 200 tokens, plus a one-line snippet and one guideline, is small
  // against a ~25k index, and a user running the full set still benefits from
  // looking a skill up by need rather than by name.
  //
  // pi lists a custom tool in the tools section of its default system prompt
  // only when it has a promptSnippet (system-prompt.js filters on it). Without
  // one the model sees sci_find only in the tool schema, and in the 2026-09-23
  // live test most misses on valid probes were attempts that never called it
  // (testing/runs/2026-09-23-bonsai2-27b.md). Guidelines go into pi's own list
  // with no tool heading, so each one names the tool. A custom system prompt
  // drops the tools section and the guidelines; see `searchNews`.
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
        // No `limit` argument: in the 2026-09-27 panel the models often set
        // one, mostly 10 to 20, which undoes a short list
        // (testing/runs/2026-09-27-find-ranker.md). A stray `limit` from a
        // model is ignored.
        const text = runToolSearch({
          query: params.query,
          profile: params.profile,
          limit: searchStage.limitFor(params),
        });
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    });
  }

  // pi does not error on an unknown /skill:<name>: pi's
  // `AgentSession._expandSkillCommand` returns the text unchanged, so it
  // reaches the model as prose and a filtered-out skill looks like it loaded.
  // `AgentSession.prompt` runs input handlers (`_runInputHandlers`) before its
  // own skill expansion, so this hook hands back the block pi would have built.
  // The block starts with "<", and `_expandSkillCommand` acts only on text
  // starting "/skill:", so neither it nor expandPromptTemplate touches the
  // block afterwards. A stopgap until pi reports the miss itself;
  // DOCUMENTATION.md's "`/skill:<name>` under a filter" section lists what it
  // does not cover.
  if (SKILLS_DIR) {
    pi.on("input", async (event) => {
      const passThrough = { action: "continue" as const };
      try {
        // `AgentSession.sendUserMessage` defaults expandPromptTemplates to
        // false, so pi means not to expand that text. The input event does not
        // carry the flag, which leaves `source` as the only readable proxy.
        // pi's examples/extensions/input-transform.ts branches on the same
        // field.
        if (event.source === "extension") return passThrough;

        const command = parseSkillCommand(event.text);
        if (!command) return passThrough;

        // Skills pi can still resolve stay pi's job. `getCommands` (in pi's
        // `AgentSession._bindExtensionCore`) maps `getSkills().skills`
        // unfiltered, the same array `_expandSkillCommand` searches. The check
        // also stops this hook shadowing a same-named skill from another
        // package, whose filePath/baseDir would differ and silently break every
        // relative reference in the body.
        const loaded = pi
          .getCommands()
          .some((c) => c.source === "skill" && c.name === `skill:${command.name}`);
        if (loaded) return passThrough;

        const text = await expandFilteredSkill(command);
        return text === undefined ? passThrough : { action: "transform" as const, text };
      } catch {
        // pi's `ExtensionRunner.emitInput` catches a throw, reports it, and
        // passes the text through unchanged: the user would get a red banner
        // and the original bug. Passing through quietly leaves pi behaving as
        // it would without this hook.
        return passThrough;
      }
    });
  }

  pi.on("session_start", async (event, ctx) => {
    // Only a cold start; on reload, new, resume or fork it would nag again.
    //
    // Not gated on ctx.hasUI. A `pi -p` user is still owed the news, and
    // handleStartup reports through `report()`, which falls back to stderr so
    // those runs are not silent. Gating here would skip them, and someone who
    // only runs `pi -p` would never be told.
    if (event.reason !== "startup") return;
    await handleStartup(pi, ctx);
  });
}
