#!/usr/bin/env node
// Behavioural tests for the /sci extension.
//
// The load-bearing case is the UPGRADE PATH. This package writes into a file it
// does not own (~/.pi/agent/settings.json), so the promise is that an existing
// user's configuration is never touched by an upgrade they did not ask for.
// "settings.json is byte-identical before and after" is the only assertion that
// actually proves it, so that is what is asserted.
//
// The extension is loaded exactly as pi loads it (jiti + host aliases); see
// lib/load-extension.mjs. `getAgentDir()` reads PI_CODING_AGENT_DIR on every
// call, so each case runs against a throwaway directory in one process.
//
// Usage: node scripts/test-extension.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiDist, loadExtensionModule } from "./lib/load-extension.mjs";
import { createSuite } from "./lib/harness.mjs";

const { check, failures, finish } = createSuite("behavioural checks");
const EXTENSIONS_DIR = fileURLToPath(new URL("../extensions", import.meta.url));

// --- harness ---------------------------------------------------------------

const created = [];

/** Fresh agent dir for one case; returns paths and activates it via env. */
const newAgentDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "sci-test-"));
  created.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    settings: join(dir, "settings.json"),
    config: join(dir, "pi-scientific-skills.json"),
  };
};

/** Minimal ExtensionAPI/context doubles covering only what the extension uses. */
const makeHarness = ({ mode = "tui", selectAnswer, cwd, hasUI = true } = {}) => {
  const notes = [];
  const selects = [];
  const sent = [];
  let reloads = 0;

  const ui = {
    notify: (message) => notes.push(message),
    select: async (title, options) => {
      selects.push({ title, options });
      return typeof selectAnswer === "function" ? selectAnswer(options) : selectAnswer;
    },
    confirm: async () => false,
  };

  const ctx = {
    hasUI,
    mode,
    // Point at the throwaway dir, not the repo: a project-level
    // .pi/settings.json in cwd would make applyToSettings refuse.
    cwd: cwd ?? tmpdir(),
    ui,
    reload: async () => {
      reloads++;
    },
  };

  return {
    ctx,
    notes,
    selects,
    sent,
    reloadCount: () => reloads,
    sendUserMessage: sent,
    // What pi.getCommands() reports: the skills pi actually loaded under the
    // user's filter, as `skill:<name>` entries. Empty until a case sets it.
    commands: [],
  };
};

const extension = await loadExtensionModule("extensions/index.ts");
const { TOTAL_SKILL_COUNT } = await loadExtensionModule("extensions/profiles.ts");

// The sentence every 1.7.0 notice gives about where sci_find is listed: pi's
// default system prompt only. Written out here, not imported, so a change to the
// wording in index.ts shows up as a failing check.
const DEFAULT_PROMPT_LISTING =
  "In pi's default system prompt (not a custom SYSTEM.md or --system-prompt) sci_find is now listed, " +
  "with a guideline to use it for scientific, research and analysis work.";

/** Register the extension against doubles and hand back its hooks. */
const register = (harness) => {
  let commandHandler;
  let sessionStart;
  let inputHandler;
  let tool;
  const events = {};
  const pi = {
    registerCommand: (_name, options) => {
      commandHandler = options.handler;
    },
    registerTool: (definition) => {
      tool = definition;
    },
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
      if (event === "input") inputHandler = handler;
      events[event] = handler;
    },
    // Only ever called from inside the input handler; the extension must not
    // call it during registration, when a real pi would throw "not initialized".
    getCommands: () => harness.commands ?? [],
    // Records options too, not just text. Asserting only that "/sci search" was
    // queued is what let a silently-broken accept path pass: without
    // expandPromptTemplates the same string goes to the model as plain text.
    sendUserMessage: async (content, options) => {
      harness.sendUserMessage.push({ content, options: options ?? {} });
    },
  };
  extension.default(pi);
  return { commandHandler, sessionStart, inputHandler, tool, events };
};

const startup = async (hooks, harness) =>
  hooks.sessionStart({ reason: "startup" }, harness.ctx);

/** Collect stderr for the no-UI path, where notify is a documented no-op. */
const captureStderr = async (fn) => {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
};

// --- the tool --------------------------------------------------------------

console.log("-- sci_find tool --");
{
  newAgentDir();
  const harness = makeHarness();
  const { tool } = register(harness);

  check("tool is registered", tool !== undefined);
  check("named sci_find", tool?.name === "sci_find");
  check(
    "description tells the model the skills are not in the system prompt",
    /not.{0,20}listed in the system prompt/i.test(tool?.description ?? ""),
  );

  const result = await tool.execute("id", { query: "variant calling from a bam file" });
  const text = result.content[0].text;
  check("returns a loadable path", /Load with: read \S+SKILL\.md/.test(text), text.slice(0, 120));
  check("surfaces a plausible skill", /pysam|pathogen-variant-surveillance/.test(text));

  const empty = (await tool.execute("id", {})).content[0].text;
  check("no arguments lists profiles", /genomics-bioinformatics/.test(empty));

  const profile = (await tool.execute("id", { profile: "drug-discovery" })).content[0].text;
  check("profile listing works", /rdkit/.test(profile));

  const miss = (await tool.execute("id", { query: "book a flight to paris" })).content[0].text;
  check("honest about no match", /No skill matched/.test(miss), miss.slice(0, 80));

  // A skill profiles.ts holds out of every profile (UNASSIGNED) is still a
  // real hit — but the model should be told it is reaching for something no
  // curated profile ever surfaces.
  const heldOut = (await tool.execute("id", { query: "usfiscaldata" })).content[0].text;
  check(
    "a held-out skill's heading discloses it is not in any profile",
    /^## usfiscaldata — not in any profile: /m.test(heldOut),
    heldOut.slice(0, 160),
  );

  // pi lists a custom tool in the prompt's tools section ("Available tools"
  // before pi 0.87, <tools> since) only when it has a promptSnippet. Without
  // one, the 2026-09-23 live test's model saw sci_find only in the tool
  // schema, and 15 of 19 misses never called it.
  const snippet = tool?.promptSnippet ?? "";
  check(
    "has a one-line promptSnippet that scopes it to scientific, research and analysis work",
    snippet.length > 0 && !/\n/.test(snippet) && /scientific, research and analysis work/.test(snippet),
    snippet,
  );
  const guidelines = tool?.promptGuidelines ?? [];
  // pi appends guidelines flat to its own list, with no tool heading, so
  // "this tool" would name nothing.
  check(
    "every prompt guideline names sci_find",
    guidelines.length > 0 && guidelines.every((line) => line.includes("sci_find")),
    JSON.stringify(guidelines),
  );
}

// --- pi's event order, for the sci_find stage tests --------------------------
//
// Core events go through pi's OWN AgentSession._emitExtensionEvent, so the
// extension gets the events, and the turnIndex, that pi would hand it. That
// method sets turnIndex back to 0 at every agent_start (agent-session.js:445
// in 0.84.3, :712 in 0.87.0) and adds 1 at turn_end (:467, :730). turn_end is
// done by hand here: 0.87's turn_end branch also dispatches a boundary event
// that this test has no session for. An event with no registered handler is
// dropped, as in pi's extension runner.
//
// The order of the core events was read from pi's source, then checked by
// driving pi's Agent with a scripted stream function (no model call) under
// both versions: it is the same in both. Line numbers below are 0.84.3 / 0.87.0.
// agent-loop.js is @earendil-works/pi-agent-core/dist/agent-loop.js.
const piRun = async (events) => {
  const { AgentSession } = await import(pathToFileURL(join(findPiDist(), "core", "agent-session.js")).href);
  const translate = AgentSession.prototype._emitExtensionEvent;
  const seen = [];
  const session = {
    _turnIndex: 0,
    _extensionRunner: {
      emit: async (event) => {
        seen.push(event);
        await events[event.type]?.(event);
      },
    },
  };
  const feed = (event) => translate.call(session, event);
  const message = (role) => feed({ type: "message_start", message: { role, content: [], timestamp: 0 } });
  const agentStart = () => feed({ type: "agent_start" });
  const turnStart = () => feed({ type: "turn_start" });
  const turnEnd = async () => {
    session._turnIndex += 1;
  };
  const agentEnd = () => feed({ type: "agent_end", messages: [] });
  return {
    seen,
    message,
    agentStart,
    turnStart,
    turnEnd,
    agentEnd,
    // agent.prompt(): runAgentLoop emits agent_start, turn_start, then a
    // message_start for each prompt message (agent-loop.js :49-52 / :50-53);
    // the assistant's message_start follows, and its tool calls run after it.
    prompt: async () => {
      await agentStart();
      await turnStart();
      await message("user");
      await message("assistant");
    },
    // The next turn after one that ran tools: toolResult message, turn_end,
    // then turn_start at the top of the inner loop (:89-91 / :113).
    nextTurn: async () => {
      await message("toolResult");
      await turnEnd();
      await turnStart();
      await message("assistant");
    },
    // A steering message. The loop polls the steering queue after each turn
    // (:160 / :186), emits turn_start (:90 / :113), then message_start for the
    // queued message BEFORE the assistant responds (:98 / :117). No
    // agent_start: the loop never restarted.
    steered: async () => {
      await message("toolResult");
      await turnEnd();
      await turnStart();
      await message("user");
      await message("assistant");
    },
    // A follow-up message. Only when a turn ends with no tool calls and the
    // loop would stop (:163-167 / :192-197); then the same events as a steer.
    followedUp: async () => {
      await turnEnd();
      await turnStart();
      await message("user");
      await message("assistant");
    },
    // agent.continue() with no queued message, as agent-session calls it after
    // an auto-retry, an overflow compaction, or queued messages
    // (agent-session.js:751-752 in 0.84.3; :1083-1094 in 0.87.0, which also
    // calls it after the before-settle boundary): runAgentLoopContinue emits
    // agent_start and turn_start and no message_start (agent-loop.js :67-68 /
    // :68-69). turnIndex is 0 again. When queued user messages wait, continue()
    // runs them as a prompt instead (agent.js :242-252 / :257-267), which is
    // prompt() above, message_start(user) included.
    continued: async () => {
      await agentStart();
      await turnStart();
      await message("assistant");
    },
    // pi.sendMessage with triggerTurn: true on an idle agent. sendCustomMessage
    // builds a role "custom" message and calls agent.prompt() with it
    // (agent-session.js :1071-1093 -> :747-750 in 0.84.3; :1481-1507 ->
    // :1078-1082 in 0.87.0). The events of prompt() with the custom message
    // where the user message would be, and no message_start(user).
    // convertToLlm sends it to the model as a user message (messages.js
    // :89-96, both versions).
    customPrompt: async () => {
      await agentStart();
      await turnStart();
      await message("custom");
      await message("assistant");
    },
    // The same run after the tool loadout changed since the last run. 0.87
    // puts a system message before the run's first non-system message
    // (agent-loop.js :219-244, called at :44 and :116); 0.84.3 has no such
    // message, so this is a 0.87-only shape.
    customPromptAfterToolChange: async () => {
      await agentStart();
      await turnStart();
      await message("system");
      await message("custom");
      await message("assistant");
    },
    // agent.continue() after a tool loadout change: the system message comes
    // before the assistant message, as above.
    continuedAfterToolChange: async () => {
      await agentStart();
      await turnStart();
      await message("system");
      await message("assistant");
    },
    // A prompt that carries custom messages: prompt() builds [user, nextTurn
    // messages, before_agent_start messages] (agent-session.js :871-901 /
    // :1294-1318), so the user message comes first.
    promptWithCustom: async () => {
      await agentStart();
      await turnStart();
      await message("user");
      await message("custom");
      await message("assistant");
    },
    // A custom steering message in a running agent (pi.sendMessage with
    // deliverAs "steer"): the same events as steered() with a custom message.
    customSteered: async () => {
      await message("toolResult");
      await turnEnd();
      await turnStart();
      await message("custom");
      await message("assistant");
    },
    // A message_start whose message has no role key.
    roleless: () => feed({ type: "message_start", message: { content: [], timestamp: 0 } }),
  };
};

console.log("\n-- sci_find hit count: 3 for the first search after a prompt, then 5 --");
{
  newAgentDir();
  const harness = makeHarness();
  const { tool, events } = register(harness);
  const pi = await piRun(events);
  const headings = async (params) =>
    (await tool.execute("id", params)).content[0].text.split("\n").filter((line) => line.startsWith("## ")).length;
  const properties = Object.keys(tool.parameters?.properties ?? {});
  check("no limit parameter: the model cannot ask for a longer list", !properties.includes("limit"), properties.join(", "));
  check(
    "the description states the counts",
    /first search returns the best 3 matches and later searches the best 5/.test(tool.description),
  );
  check(
    "agent_start, message_start and turn_start are handled",
    ["agent_start", "message_start", "turn_start"].every((name) => typeof events[name] === "function"),
  );

  const query = "single cell rna-seq clustering";
  await pi.prompt();
  await tool.execute("id", { profile: "drug-discovery" });
  await tool.execute("id", {});
  await pi.nextTurn();
  const first = await headings({ query });
  const parallel = await headings({ query: "protein structure prediction" });
  check(
    "the first turn that searches shows 3, parallel calls too; listings before it do not count",
    first === 3 && parallel === 3,
    `${first}, ${parallel}`,
  );
  await pi.nextTurn();
  const later = await headings({ query });
  const stray = await headings({ query, limit: 20 });
  check("a later turn shows 5, and a stray limit argument is ignored", later === 5 && stray === 5, `${later}, ${stray}`);
  await pi.agentEnd();
  await pi.prompt();
  check("a new prompt starts again at 3", (await headings({ query })) === 3);
}

console.log("\n-- sci_find: the 3-then-5 stage follows the message that opens a prompt --");
{
  const queries = ["single cell rna-seq clustering", "protein structure prediction", "variant calling from a bam file"];
  const fresh = async () => {
    newAgentDir();
    const { tool, events } = register(makeHarness());
    const pi = await piRun(events);
    const hits = async (query = queries[0]) =>
      (await tool.execute("id", { query })).content[0].text.split("\n").filter((line) => line.startsWith("## ")).length;
    return { events, pi, hits };
  };

  // The premises, from pi's own code: turnIndex starts again at 0 at
  // agent.continue(), and a user message reaches extensions as message_start.
  {
    const { pi } = await fresh();
    await pi.prompt();
    await pi.nextTurn();
    await pi.nextTurn();
    await pi.agentEnd();
    await pi.continued();
    const indexes = pi.seen.filter((event) => event.type === "turn_start").map((event) => event.turnIndex);
    check("pi numbers a run's turns 0, 1, 2 and starts again at 0 at agent.continue()", indexes.join() === "0,1,2,0", indexes.join());
    const users = pi.seen.filter((event) => event.type === "message_start" && event.message.role === "user");
    check("pi sends extensions one message_start(user) for the prompt and none for continue()", users.length === 1, `${users.length}`);
  }

  // A single prompt, as in 'pi -p' and the 1.7.0 A/B: 3, then 5, for every
  // later turn.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const turn0 = await hits();
    await pi.nextTurn();
    const turn1 = await hits();
    await pi.nextTurn();
    const turn2 = await hits();
    check("one prompt: turn 0 shows 3, turn 1 shows 5, turn 2 shows 5", turn0 === 3 && turn1 === 5 && turn2 === 5, `${turn0}, ${turn1}, ${turn2}`);
  }

  // Parallel calls in the first searching turn: all 3; the next turn 5.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const parallel = await Promise.all(queries.map((query) => hits(query)));
    await pi.nextTurn();
    const next = await hits();
    check("parallel calls in the first searching turn all show 3; the next turn shows 5", parallel.every((n) => n === 3) && next === 5, `${parallel.join()}, ${next}`);
  }

  // A steering message reaches the model as turn_start then message_start, with
  // no agent_start, so a reset on agent_start never saw it.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    await pi.steered();
    const afterSteer = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "a steer message starts a new first search: 3, then 5",
      first === 3 && second === 5 && afterSteer === 3 && afterThat === 5,
      `${first}, ${second}, ${afterSteer}, ${afterThat}`,
    );
  }

  // A follow-up arrives after a turn with no tool calls; same events as a steer.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.followedUp();
    const afterFollowUp = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "a follow-up message starts a new first search: 3, then 5",
      first === 3 && afterFollowUp === 3 && afterThat === 5,
      `${first}, ${afterFollowUp}, ${afterThat}`,
    );
  }

  // agent.continue() is not a new prompt. The retry starts at turnIndex 0, the
  // index of the turn that already searched first, so the stage must not go by
  // turnIndex either: a search there is a later search.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.turnEnd();
    await pi.agentEnd();
    await pi.continued();
    const afterRetry = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "continue() after an auto-retry does not reset: a search at turnIndex 0 again shows 5",
      first === 3 && afterRetry === 5 && afterThat === 5,
      `${first}, ${afterRetry}, ${afterThat}`,
    );
  }

  // A retry before any search: the first search is still to come and shows 3.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await pi.turnEnd();
    await pi.agentEnd();
    await pi.continued();
    const first = await hits();
    await pi.nextTurn();
    const later = await hits();
    check("continue() before the first search: that search shows 3, the next turn 5", first === 3 && later === 5, `${first}, ${later}`);
  }

  // A second prompt in the same session.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const one = await hits();
    await pi.nextTurn();
    const two = await hits();
    await pi.agentEnd();
    await pi.prompt();
    const three = await hits();
    await pi.nextTurn();
    const four = await hits();
    check(
      "a second prompt in the same session starts at 3 again",
      one === 3 && two === 5 && three === 3 && four === 5,
      `${one}, ${two}, ${three}, ${four}`,
    );
  }

  // A run that an extension starts (pi.sendMessage with triggerTurn: true)
  // opens with a custom message and no user message. The model reads it as a
  // new prompt, so the first search in it shows 3 again. Without this rule the
  // stage stayed at 5 for every such run until a real user message came.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    await pi.agentEnd();
    await pi.customPrompt();
    const afterCustom = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    await pi.agentEnd();
    await pi.customPrompt();
    const secondCustomRun = await hits();
    check(
      "a run that opens with a custom message starts a new first search: 3, then 5, and again for the next such run",
      first === 3 && second === 5 && afterCustom === 3 && afterThat === 5 && secondCustomRun === 3,
      `${first}, ${second}, ${afterCustom}, ${afterThat}, ${secondCustomRun}`,
    );
  }

  // A custom message in the middle of a run is not a new prompt: a custom
  // steer, or a context message that pi adds between turns.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    await pi.customSteered();
    const afterCustom = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "a custom message in the middle of a run does not reset: 3, 5, then 5 and 5",
      first === 3 && second === 5 && afterCustom === 5 && afterThat === 5,
      `${first}, ${second}, ${afterCustom}, ${afterThat}`,
    );
  }

  // continue() opens a run with no message, and the assistant's message_start
  // is the first one. That message must use up the run-opening state, or a
  // custom message later in the run would count as the one that opened it.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.agentEnd();
    await pi.continued();
    const afterRetry = await hits();
    await pi.customSteered();
    const afterCustom = await hits();
    check(
      "continue() does not reset, and a custom message later in that run does not either",
      first === 3 && afterRetry === 5 && afterCustom === 5,
      `${first}, ${afterRetry}, ${afterCustom}`,
    );
  }

  // continue() after a run that a custom message opened.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.agentEnd();
    await pi.customPrompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.agentEnd();
    await pi.continued();
    const afterRetry = await hits();
    check(
      "continue() after a custom-started run does not reset: 3, then 5",
      first === 3 && afterRetry === 5,
      `${first}, ${afterRetry}`,
    );
  }

  // A user steer still resets inside a run that a custom message opened.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.agentEnd();
    await pi.customPrompt();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    await pi.steered();
    const afterSteer = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "a user steer in a custom-started run starts a new first search: 3, 5, 3, 5",
      first === 3 && second === 5 && afterSteer === 3 && afterThat === 5,
      `${first}, ${second}, ${afterSteer}, ${afterThat}`,
    );
  }

  // The prompt carries custom messages after the user message. The user
  // message resets; the custom message behind it is mid-run, so the first
  // search stays 3 and the next turn 5.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.nextTurn();
    await hits();
    await pi.agentEnd();
    await pi.promptWithCustom();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    check(
      "a custom message behind the user message at the start of a run does not change the count: 3, then 5",
      first === 3 && second === 5,
      `${first}, ${second}`,
    );
  }

  // 0.87 puts a system message ahead of the run's first message when the tool
  // loadout changed. It is pi's own bookkeeping, not a message the model reads
  // as a prompt, so it must not hide the custom message behind it.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.nextTurn();
    await hits();
    await pi.agentEnd();
    await pi.customPromptAfterToolChange();
    const first = await hits();
    await pi.nextTurn();
    const second = await hits();
    check(
      "a system message ahead of the opening custom message does not hide it: 3, then 5",
      first === 3 && second === 5,
      `${first}, ${second}`,
    );
  }
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.agentEnd();
    await pi.continuedAfterToolChange();
    const afterRetry = await hits();
    check(
      "a system message ahead of the assistant in continue() does not reset: 3, then 5",
      first === 3 && afterRetry === 5,
      `${first}, ${afterRetry}`,
    );
  }

  // A message_start that has no role, or no message, is not an error in the
  // extension: pi's own handlers read event.message.role on an AgentMessage,
  // but an untyped extension or a future message type could break that.
  {
    const { events, pi, hits } = await fresh();
    await pi.prompt();
    const first = await hits();
    await pi.nextTurn();
    await pi.agentEnd();
    await pi.agentStart();
    await pi.turnStart();
    let thrown;
    try {
      await pi.roleless();
      await events.message_start({ type: "message_start" });
    } catch (error) {
      thrown = error;
    }
    check("a message_start with no role, or no message, does not throw", thrown === undefined, String(thrown));
    // The role-less message used up the run-opening state, so the custom
    // message behind it is mid-run and does not reset; a user steer still does.
    await pi.message("custom");
    await pi.message("assistant");
    const afterCustom = await hits();
    await pi.steered();
    const afterSteer = await hits();
    await pi.nextTurn();
    const afterThat = await hits();
    check(
      "after a role-less message the stage is not stuck: a custom message does not reset, a user steer does",
      first === 3 && afterCustom === 5 && afterSteer === 3 && afterThat === 5,
      `${first}, ${afterCustom}, ${afterSteer}, ${afterThat}`,
    );
  }

  // A user message always resets. A custom message resets only when it opens a
  // run. A system message (0.87 declares tool changes with one, before the
  // first message of a run: agent-loop.js :219-244), an assistant and a
  // toolResult message_start do not reset; the assistant's comes every turn.
  {
    const { pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.nextTurn();
    await pi.message("system");
    await pi.message("custom");
    await pi.message("assistant");
    await pi.message("toolResult");
    check("system, custom, assistant and toolResult messages do not reset", (await hits()) === 5);
  }

  // pi's input event fires when a message is typed, before pi queues it
  // (agent-session.js:816-846 in 0.84.3, :1230-1252 in 0.87.0), so a reset
  // there would hit the turn that is still running. The model has not seen the
  // message until message_start.
  {
    const { events, pi, hits } = await fresh();
    await pi.prompt();
    await hits();
    await pi.nextTurn();
    await events.input({ type: "input", text: "also do X", source: "interactive", streamingBehavior: "steer" });
    const whileQueued = await hits();
    await pi.steered();
    const delivered = await hits();
    check("a steer message that is only queued does not reset; delivery does", whileQueued === 5 && delivered === 3, `${whileQueued}, ${delivered}`);
  }
}

console.log("\n-- sci_find: a profile id sent as the query is a listing, not a search --");
{
  newAgentDir();
  const harness = makeHarness();
  const { tool, events } = register(harness);
  const pi = await piRun(events);
  const headings = async (params) =>
    (await tool.execute("id", params)).content[0].text.split("\n").filter((line) => line.startsWith("## ")).length;
  const query = "single cell rna-seq clustering";
  const startPrompt = () => pi.prompt();
  const turn = () => pi.nextTurn();

  // runToolSearch answers a bare profile id in `query` with the profile listing
  // (its asProfile path), so the stage must not count it as the first search.
  // Each variant is a listing in turn 0; the next turn's real search is the
  // first search and gets FIRST_SEARCH_LIMIT (3), not LATER_SEARCH_LIMIT (5).
  const variants = [
    ["query: a profile id", { query: "core" }],
    ["query: a hyphenated profile id", { query: "drug-discovery" }],
    ["query: a profile id, padded and upper case", { query: "  Core  " }],
    ["profile: a profile id (control)", { profile: "core" }],
  ];
  for (const [label, listing] of variants) {
    await startPrompt();
    const listed = (await tool.execute("id", listing)).content[0].text;
    await turn();
    const first = await headings({ query });
    check(`${label}: is a listing, and the next turn's real search shows 3`, /^# /.test(listed) && first === 3, `${first}`);
    await turn();
    check(`${label}: the turn after that shows 5`, (await headings({ query })) === 5);
  }

  // A query that merely contains a profile id is a real search: it takes the
  // first slot, so a search in a later turn shows 5.
  await startPrompt();
  const contains = await headings({ query: "core genome analysis" });
  await turn();
  const later = await headings({ query });
  check("a query that contains a profile id word is a search and takes the first slot", contains === 3 && later === 5, `${contains}, ${later}`);
}

console.log("\n-- sci_find compact format (PI_SCI_FIND_FORMAT=compact) --");
{
  newAgentDir();
  // The format belongs to runToolSearch, which the replay tooling also calls
  // with a recorded count; the tool's own count (3, then 5) is checked above.
  const { runToolSearch } = await loadExtensionModule("extensions/catalog.ts");
  const run = async (params, format) => {
    if (format) process.env.PI_SCI_FIND_FORMAT = format;
    else delete process.env.PI_SCI_FIND_FORMAT;
    try {
      return runToolSearch(params);
    } finally {
      delete process.env.PI_SCI_FIND_FORMAT;
    }
  };
  const blocks = (text) => text.split("\n\n").filter((block) => block.startsWith("## "));
  const withReferences = (text) => blocks(text).filter((block) => /\nReferences inside it are relative to /.test(block));
  const query = { query: "statistical analysis and plotting of experimental data" };

  const full = await run(query);
  check("default format: 8 hits, every one full", blocks(full).length === 8 && withReferences(full).length === 8, full.slice(0, 200));
  check("default format: no alternates line", !full.includes("More matches"));

  const compact = await run(query, "compact");
  const [first, second, ...alternates] = blocks(compact);
  check("compact: 6 hits by default", blocks(compact).length === 6, compact.slice(0, 200));
  check("compact: the top 2 are byte-identical to the default format", compact.startsWith(`${blocks(full)[0]}\n\n${blocks(full)[1]}\n\n`));
  check("compact: one alternates line, after the top 2", compact.split("More matches").length === 2 && compact.indexOf("More matches") > compact.indexOf(second));
  check(
    "compact: alternates carry a heading, one sentence and a load line",
    alternates.length === 4 && alternates.every((block) => block.split("\n").length === 3 && /\nLoad with: read \S+SKILL\.md$/.test(block)),
    alternates.join("\n\n"),
  );
  check(
    "compact: an alternate's text is the start of its full description",
    alternates.every((block) => {
      const [heading, sentence] = block.split("\n");
      const same = blocks(full).find((b) => b.split("\n")[0] === heading);
      return same === undefined || (same.split("\n")[1].startsWith(sentence) && sentence.endsWith("."));
    }),
  );
  check(
    "compact: an explicit limit keeps 2 full and shortens the rest",
    await run({ ...query, limit: 10 }, "compact").then((text) => blocks(text).length === 10 && withReferences(text).length === 2),
  );
  const narrow = await run({ query: "usfiscaldata" }, "compact");
  check(
    "compact: 2 hits or fewer render as the default format",
    blocks(narrow).length <= 2 && narrow === (await run({ query: "usfiscaldata" })),
    narrow.slice(0, 160),
  );
  check(
    "compact: a profile listing is unchanged",
    (await run({ profile: "drug-discovery" }, "compact")) === (await run({ profile: "drug-discovery" })),
  );
  check("the flag is unset after these checks", process.env.PI_SCI_FIND_FORMAT === undefined);
}

console.log("\n-- sci_find in pi's real system prompt --");
{
  // Not the snippet as this file sees it, but as pi renders it: pi's own
  // normalizer (agent-session.js) and buildSystemPrompt (system-prompt.js).
  // A pi release that renames either fails here, loudly, not silently.
  const piDist = findPiDist();
  const { buildSystemPrompt } = await import(pathToFileURL(join(piDist, "core", "system-prompt.js")).href);
  const { AgentSession } = await import(pathToFileURL(join(piDist, "core", "agent-session.js")).href);
  const normalizeSnippet = AgentSession.prototype._normalizePromptSnippet;
  const normalizeGuidelines = AgentSession.prototype._normalizePromptGuidelines;

  newAgentDir();
  const { tool } = register(makeHarness());
  const snippet = normalizeSnippet.call(null, tool.promptSnippet);
  const guidelines = normalizeGuidelines.call(null, tool.promptGuidelines);
  // pi 0.84-0.86 reads guidelines from `promptGuidelines` and ignores
  // `toolGuidelines`. pi 0.87 reads them per tool from `toolGuidelines` (its
  // own agent-session passes only that) and de-duplicates the two lists.
  const prompt = buildSystemPrompt({
    selectedTools: ["read", "bash", "edit", "write", "sci_find"],
    toolSnippets: { sci_find: snippet },
    toolGuidelines: { sci_find: guidelines },
    promptGuidelines: guidelines,
    cwd: tmpdir(),
    skills: [],
  });
  // The lines of one prompt section, from either layout. pi 0.84-0.86:
  // "Available tools:\n<list>\n\n..." and "Guidelines:\n<list>\n\n...".
  // pi 0.87: "<tools>\n<list>\n\n...\n</tools>" and "<rules>\n<list>\n</rules>".
  // undefined, never [], when neither layout has it: a pi that renames the
  // section again then fails every check below, not passes them vacuously.
  const sectionLines = ({ heading, tag }) => {
    const tagged = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1];
    const body = tagged ?? (prompt.includes(`${heading}:\n`) ? prompt.split(`${heading}:\n`)[1] : undefined);
    return body?.split("\n\n")[0].split("\n");
  };
  const tools = sectionLines({ heading: "Available tools", tag: "tools" });
  const rules = sectionLines({ heading: "Guidelines", tag: "rules" });
  const notFound = `section not found in either layout; the prompt starts:\n${prompt.slice(0, 400)}`;
  check(
    "sci_find is listed in the prompt's tools section",
    tools !== undefined && snippet !== undefined && tools.includes(`- sci_find: ${snippet}`),
    tools?.join("\n") ?? notFound,
  );
  check(
    "its guidelines are in the prompt's guidelines section",
    rules !== undefined && guidelines.length > 0 && guidelines.every((line) => rules.includes(`- ${line}`)),
    rules?.join("\n") ?? notFound,
  );
}

// --- /sci search -----------------------------------------------------------

console.log("\n-- /sci search --");
{
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["!autoskill"] }] }, null, 2),
  );
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("search", harness.ctx);

  const written = JSON.parse(readFileSync(paths.settings, "utf8"));
  const entry = written.packages.find((p) => p.source === "pi-scientific-skills");
  check(
    "writes an empty skills filter: no skill in the system prompt",
    Array.isArray(entry?.skills) && entry.skills.length === 0,
    JSON.stringify(entry?.skills),
  );
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  check("saves no profile", Array.isArray(config.profiles) && config.profiles.length === 0, JSON.stringify(config));
  check(
    "says sci_find still reaches every skill",
    /Search mode/.test(harness.notes.at(-1) ?? "") && /sci_find finds all/.test(harness.notes.at(-1) ?? ""),
    harness.notes.at(-1),
  );
  check("reloads so it takes effect now", harness.reloadCount() === 1);
}

// --- /sci all / none / reset, and the bare menu -----------------------------

/** A settings entry with one plain include and one hand-written override. */
const withOverride = () =>
  JSON.stringify(
    { packages: [{ source: "pi-scientific-skills", skills: ["scanpy", "!pysam"] }] },
    null,
    2,
  );

const packageEntry = (written) =>
  written.packages.find((p) => (typeof p === "string" ? p : p.source) === "pi-scientific-skills");

console.log("\n-- /sci all --");
{
  const paths = newAgentDir();
  writeFileSync(paths.settings, withOverride());
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("all", harness.ctx);

  const entry = packageEntry(JSON.parse(readFileSync(paths.settings, "utf8")));
  check(
    "hand-written overrides survive /sci all",
    Array.isArray(entry?.skills) && entry.skills.includes("!pysam"),
    JSON.stringify(entry),
  );
  check("the plain include is gone — nothing stays filtered", !entry.skills.includes("scanpy"));
  check("reloads so it takes effect now", harness.reloadCount() === 1);
}

console.log("\n-- /sci none --");
{
  const paths = newAgentDir();
  writeFileSync(paths.settings, withOverride());
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("none", harness.ctx);

  const entry = packageEntry(JSON.parse(readFileSync(paths.settings, "utf8")));
  check(
    "unlike /sci all, /sci none cannot carry hand-written overrides",
    Array.isArray(entry?.skills) && entry.skills.length === 0,
    JSON.stringify(entry?.skills),
  );
  check(
    "is an alias of /sci search, not an \"off\" switch",
    /Search mode/.test(harness.notes.at(-1) ?? ""),
    harness.notes.at(-1),
  );
  check("reloads so it takes effect now", harness.reloadCount() === 1);
}

// Search mode writes `skills: []`, which cannot carry `pi config` overrides
// (an overrides-only array means "everything, minus those"). 1.6.0's search
// wrote the Core list and kept them, so a Core user who had turned a skill off
// in `pi config` lost that choice on upgrade, with nothing on screen to say so.
// The write is unchanged; the report now names what it dropped.
console.log("\n-- /sci search names the pi config overrides it drops --");
{
  const { describeSearchMode } = await loadExtensionModule("extensions/catalog.ts");
  const { PROFILES } = await loadExtensionModule("extensions/profiles.ts");
  const searchSummary = `Search mode: ${describeSearchMode()}.`;
  const reAdd = "Re-add them with pi config if you want them back.";
  // The filter 1.6.0's search wrote: the Core profile's skills, sorted.
  const core = [...PROFILES.find((profile) => profile.id === "core").skills].sort();
  const seed = (skills) => JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills }] }, null, 2);
  const SEARCH_ONLY_ROW = "Search only (no skills in the prompt)";

  /** One case: seed settings.json, run `invoke`, hand back what the user saw and what was written. */
  const run = async (skills, invoke, { selectAnswer } = {}) => {
    const paths = newAgentDir();
    writeFileSync(paths.settings, seed(skills));
    const harness = makeHarness(selectAnswer === undefined ? {} : { mode: "tui", selectAnswer });
    const hooks = register(harness);
    await invoke(hooks, harness);
    return {
      harness,
      message: harness.notes.at(-1),
      written: readFileSync(paths.settings, "utf8"),
      config: existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : undefined,
    };
  };

  /** The shared assertions: what the message says, and that the write is the same as ever. */
  const expectDropped = (label, result, expected) => {
    check(`${label}: message is the search summary plus the dropped overrides`, result.message === expected, result.message);
    check(
      `${label}: settings.json is the seed with skills [] and nothing else changed`,
      result.written === seed([]) && JSON.parse(result.written).packages[0].skills.length === 0,
      result.written,
    );
    check(
      `${label}: saves no profile`,
      Array.isArray(result.config?.profiles) && result.config.profiles.length === 0,
      JSON.stringify(result.config),
    );
    check(`${label}: reloads so it takes effect now`, result.harness.reloadCount() === 1);
  };

  const search = (hooks, harness) => hooks.commandHandler("search", harness.ctx);

  {
    const skills = [...core, "!polars"];
    const result = await run(skills, search);
    expectDropped(
      "1.6.0 Core filter plus !polars",
      result,
      `${searchSummary} Dropped pi config overrides: !polars. ${reAdd} Reloading…`,
    );
  }
  {
    const skills = [...core, "+extra", "-other"];
    const result = await run(skills, search);
    expectDropped(
      "1.6.0 Core filter plus +extra and -other",
      result,
      `${searchSummary} Dropped pi config overrides: +extra, -other. ${reAdd} Reloading…`,
    );
  }
  {
    // An entry holding only overrides is "all skills, minus those" (what /sci all leaves behind).
    const skills = ["!polars", "-matplotlib"];
    const result = await run(skills, search);
    expectDropped(
      "overrides-only filter",
      result,
      `${searchSummary} Dropped pi config overrides: !polars, -matplotlib. ${reAdd} Reloading…`,
    );
  }
  {
    const skills = [...core, "!polars"];
    const result = await run(skills, (hooks, harness) => hooks.commandHandler("none", harness.ctx));
    expectDropped(
      "/sci none",
      result,
      `${searchSummary} Dropped pi config overrides: !polars. ${reAdd} Reloading…`,
    );
  }
  {
    const skills = [...core, "!polars"];
    const result = await run(skills, (hooks, harness) => hooks.commandHandler("", harness.ctx), {
      selectAnswer: () => SEARCH_ONLY_ROW,
    });
    expectDropped(
      `main menu "Search only"`,
      result,
      `${searchSummary} Dropped pi config overrides: !polars. ${reAdd} Reloading…`,
    );
  }
  {
    // The picker with nothing ticked writes the same empty filter, so it names them too.
    // Overrides-only seed: a plain include would first raise its "replace the filter?" confirm.
    const skills = ["!polars"];
    const answers = ["Choose profiles…", "Clear selection", "Apply and reload"];
    let asked = 0;
    const result = await run(skills, (hooks, harness) => hooks.commandHandler("", harness.ctx), {
      selectAnswer: () => answers[asked++],
    });
    expectDropped(
      "picker with no profile ticked",
      result,
      `No profile chosen. ${searchSummary} Dropped pi config overrides: !polars. ${reAdd} Reloading…`,
    );
  }
  {
    // No overrides: the message is exactly what it was before this change.
    const result = await run(core, search);
    expectDropped("1.6.0 Core filter, no overrides", result, `${searchSummary} Reloading…`);
  }
  {
    // Already in search mode: nothing to drop, nothing changes, nothing to say.
    const result = await run([], search);
    check(
      "already in search mode: message is unchanged",
      result.message === `${searchSummary} (already applied)`,
      result.message,
    );
    check("already in search mode: does not reload", result.harness.reloadCount() === 0);
  }
}

console.log("\n-- /sci reset --");
{
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["scanpy", "pysam"] }] }, null, 2),
  );
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, onboardingSeen: true, profiles: ["single-cell-omics"] }, null, 2),
  );
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("reset", harness.ctx);

  const entry = packageEntry(JSON.parse(readFileSync(paths.settings, "utf8")));
  check(
    "the package entry's filter is removed — no plain includes, nothing to keep it as an object",
    typeof entry === "string" || entry.skills === undefined,
    JSON.stringify(entry),
  );
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  check("the saved profile selection is forgotten", config.profiles === undefined, JSON.stringify(config));
  check("reloads so it takes effect now", harness.reloadCount() === 1);
}

// Unnumbered rows, reproduced from index.ts's MAIN_MENU — not exported, since
// nothing outside the module needs to name them until PR 5 splits ui.ts out.
const MENU_ENABLE_ALL = `Enable all ${TOTAL_SKILL_COUNT} skills`;
const MENU_ROWS = [
  ["Show status", { writes: false }],
  [MENU_ENABLE_ALL, { writes: true }],
  ["Search only (no skills in the prompt)", { writes: true }],
  ["Reset (forget profiles, enable all)", { writes: true }],
  ["Cancel", { writes: false }],
];

console.log("\n-- bare /sci menu --");
for (const [row, { writes }] of MENU_ROWS) {
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["scanpy"] }] }, null, 2),
  );
  const harness = makeHarness({ mode: "tui", selectAnswer: () => row });
  const hooks = register(harness);

  await hooks.commandHandler("", harness.ctx);

  check(`"${row}" reloads exactly when it changes something`, harness.reloadCount() === (writes ? 1 : 0));
}

console.log("\n-- bare /sci menu → Choose profiles… --");
{
  const paths = newAgentDir();
  let asked = 0;
  // First select() answers the main menu; the second is runPicker's own
  // fallback loop (no ctx.ui.custom in this harness) — undefined cancels it.
  const harness = makeHarness({
    mode: "tui",
    selectAnswer: () => (asked++ === 0 ? "Choose profiles…" : undefined),
  });
  const hooks = register(harness);

  await hooks.commandHandler("", harness.ctx);

  check("the row hands off into the picker, not straight to a plan", harness.selects.length === 2);
  check("cancelling the picker changes nothing", harness.reloadCount() === 0 && !existsSync(paths.settings));
}

// --- first run: new user ---------------------------------------------------

console.log("\n-- first run (new user, TUI) --");
{
  const paths = newAgentDir();
  const harness = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
  const hooks = register(harness);

  await startup(hooks, harness);

  check("asks rather than assuming", harness.selects.length === 1);
  check(
    "offer states the cost and names search mode",
    new RegExp(String(TOTAL_SKILL_COUNT)).test(harness.selects[0]?.title ?? "") &&
      /search mode/.test(harness.selects[0]?.title ?? ""),
    harness.selects[0]?.title,
  );
  // Declining keeps every skill loaded but not the prompt as it was: sci_find's
  // snippet and guideline are added whatever the answer (in pi's default prompt;
  // a custom one drops both), so the row says the tool stays available.
  const [acceptRow, declineRow] = harness.selects[0]?.options ?? [];
  check(
    "the decline row says sci_find stays available, not that the prompt lists it",
    /^No\b/.test(declineRow ?? "") &&
      /\(sci_find stays available\)/.test(declineRow ?? "") &&
      !/listed in the prompt/.test(declineRow ?? ""),
    declineRow,
  );
  // scripts/test-tui-offer.py waits for "search mode:" and expects only the
  // accept row to carry it; the rows also keep their order (accept first).
  check(
    'only the accept row carries "search mode:"',
    /^Yes\b/.test(acceptRow ?? "") &&
      (acceptRow ?? "").includes("search mode:") &&
      !(declineRow ?? "").includes("search mode:") &&
      !(harness.selects[0]?.title ?? "").includes("search mode:"),
    JSON.stringify(harness.selects[0]),
  );
  const queued = harness.sendUserMessage[0];
  check("accepting queues the command", queued?.content === "/sci search", JSON.stringify(queued));
  // pi dispatches an extension command only when this flag is set; it defaults
  // to false. Without it the user says yes and nothing is written.
  check(
    "queues it as a command, not as text for the model",
    queued?.options?.expandPromptTemplates === true,
    JSON.stringify(queued?.options),
  );
  check("did not write settings.json itself", !existsSync(paths.settings));

  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  check("records the version so it asks only once", config.lastSeenVersion !== undefined);

  // Second startup must be silent.
  const second = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
  const hooks2 = register(second);
  await startup(hooks2, second);
  check("does not ask twice", second.selects.length === 0);
}

console.log("\n-- first run (new user declines) --");
{
  const paths = newAgentDir();
  const harness = makeHarness({ mode: "tui", selectAnswer: undefined }); // esc / timeout
  const hooks = register(harness);

  await startup(hooks, harness);

  check("silence changes nothing", harness.sendUserMessage.length === 0);
  check("still writes no settings", !existsSync(paths.settings));
}

console.log("\n-- first run (non-TUI) --");
{
  newAgentDir();
  const harness = makeHarness({ mode: "rpc", selectAnswer: (options) => options[0] });
  const hooks = register(harness);

  await startup(hooks, harness);

  check("never prompts a scripted client", harness.selects.length === 0);
  check("still informs", harness.notes.length === 1);
  check("takes no action", harness.sendUserMessage.length === 0);
}

// --- upgrade path ----------------------------------------------------------

console.log("\n-- upgrade (existing user) --");
{
  const paths = newAgentDir();
  const settingsBefore = JSON.stringify(
    { packages: [{ source: "pi-scientific-skills", skills: ["scanpy", "pysam"] }] },
    null,
    2,
  );
  writeFileSync(paths.settings, settingsBefore);
  // A 1.0.2-era config: has state, no lastSeenVersion.
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, onboardingSeen: true, profiles: ["single-cell-omics"] }, null, 2),
  );

  const harness = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
  const hooks = register(harness);
  await startup(hooks, harness);

  check("is told, not asked", harness.selects.length === 0 && harness.notes.length === 1);
  const notice = harness.notes[0] ?? "";
  check("says the selection is unchanged", /unchanged/i.test(notice), notice);
  check("names what is new", /sci_find/.test(notice));
  check(
    "settings.json is byte-identical",
    readFileSync(paths.settings, "utf8") === settingsBefore,
    "an upgrade must never rewrite a user's settings",
  );
  check("no action taken on their behalf", harness.sendUserMessage.length === 0);

  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  check("preserves their saved profiles", config.profiles?.includes("single-cell-omics"));

  const second = makeHarness({ mode: "tui" });
  const hooks2 = register(second);
  await startup(hooks2, second);
  check("notice is shown exactly once", second.notes.length === 0);
}

console.log("\n-- upgrade (patch release, same minor line) --");
{
  const paths = newAgentDir();
  const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const [major, minor, patch] = PACKAGE_VERSION.split(".").map(Number);

  if (patch > 0) {
    // A same-minor neighbour one patch earlier is a genuine patch-release
    // upgrade — exercised through the real startup path.
    const prior = `${major}.${minor}.${patch - 1}`;
    writeFileSync(
      paths.config,
      JSON.stringify({ version: 1, onboardingSeen: true, lastSeenVersion: prior }, null, 2),
    );

    const harness = makeHarness({ mode: "tui" });
    const hooks = register(harness);
    await startup(hooks, harness);

    const notice = harness.notes[0] ?? "";
    check(
      "a patch bump gets the one-line notice, not the last minor release's news",
      harness.notes.length === 1 &&
        /updated to/.test(notice) &&
        /Patch release/.test(notice) &&
        !/Upstream snapshot/.test(notice),
      notice,
    );
    const config = JSON.parse(readFileSync(paths.config, "utf8"));
    check("and records the version", config.lastSeenVersion === PACKAGE_VERSION);
  } else {
    // x.y.0 has no lower patch within its own minor line to derive — "one
    // patch back" would land one patch AHEAD instead, a same-minor downgrade,
    // and that path is already covered by the dedicated downgrade test below.
    // Exercise the minor path through startup instead: a same-major neighbour
    // one minor earlier is a genuine upgrade, and must print the release's
    // news, not the patch line. The news itself, and the patch path, stay
    // covered as pure functions with fixed pairs in the section right after
    // this one.
    const prior = `${major}.${minor - 1}.0`;
    writeFileSync(
      paths.config,
      JSON.stringify({ version: 1, onboardingSeen: true, lastSeenVersion: prior }, null, 2),
    );

    const harness = makeHarness({ mode: "tui" });
    const hooks = register(harness);
    await startup(hooks, harness);

    const notice = harness.notes[0] ?? "";
    check(
      "at patch 0, a minor bump gets the release news through the real startup path",
      harness.notes.length === 1 &&
        /updated to/.test(notice) &&
        !/Patch release/.test(notice) &&
        /"\/sci status"/.test(notice),
      notice,
    );
    const config = JSON.parse(readFileSync(paths.config, "utf8"));
    check("and records the version", config.lastSeenVersion === PACKAGE_VERSION);
  }
}

console.log("\n-- upgradeNotice / compareVersions: pure functions, fixed version pairs --");
{
  // Fixed pairs, independent of whatever PACKAGE_VERSION this release actually
  // carries — this is what keeps all three notice paths (patch, minor,
  // downgrade) tested at any version, including an x.y.0 release with no
  // lower patch of its own to exercise through startup.
  const { compareVersions, upgradeNotice } = extension;

  check("compareVersions: patch pair orders as an upgrade", compareVersions("1.5.3", "1.5.4") < 0);
  check("compareVersions: minor pair orders as an upgrade", compareVersions("1.5.0", "1.6.0") < 0);
  check("compareVersions: downgrade pair orders as a downgrade", compareVersions("1.6.1", "1.6.0") > 0);

  const patchNotice = upgradeNotice("1.5.3", "1.5.4");
  check(
    "patch pair (1.5.3→1.5.4): one-line notice, not the full snapshot",
    /updated to 1\.5\.4 \(from 1\.5\.3\)/.test(patchNotice) &&
      /Patch release/.test(patchNotice) &&
      !/Upstream snapshot/.test(patchNotice),
    patchNotice,
  );

  const minorNotice = upgradeNotice("1.6.0", "1.7.0");
  check(
    "minor pair (1.6.0→1.7.0): the search news, not the snapshot they already saw",
    /updated to 1\.7\.0 \(from 1\.6\.0\)/.test(minorNotice) &&
      /BM25F/.test(minorNotice) &&
      /search mode/i.test(minorNotice) &&
      /now listed/.test(minorNotice) &&
      !/Upstream snapshot/.test(minorNotice),
    minorNotice,
  );
  // About nine lines of 90 characters, head included. A longer notice is one
  // nobody reads to the end, and then it has told them nothing.
  check(
    "minor pair: short enough to read once",
    minorNotice.length <= 9 * 90,
    `${minorNotice.length} characters`,
  );

  const skippedNotice = upgradeNotice("1.5.0", "1.7.0");
  check(
    "skipped minor (1.5.0→1.7.0): also the snapshot news they missed",
    /BM25F/.test(skippedNotice) && /Upstream snapshot v2\.69\.0/.test(skippedNotice),
    skippedNotice,
  );
}

console.log("\n-- upgrade from each real 1.6.0 state --");
{
  // The four states a 1.6.0 user can be in, as 1.6.0's own code wrote them:
  // `git archive main` at 1.6.0, loaded through pi's jiti, driven through the
  // first-run offer and `/sci search` / `/sci none`. The literals below
  // serialize to the same bytes (compared once, `updatedAt` aside). Settings
  // built by hand would test what this file believes 1.6.0 wrote.
  const { FIRST_SEARCH_LIMIT, LATER_SEARCH_LIMIT } = await loadExtensionModule("extensions/search.ts");
  const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const file = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const SOURCE = "npm:pi-scientific-skills";
  const CORE = [
    "citation-management",
    "experimental-design",
    "exploratory-data-analysis",
    "matplotlib",
    "paper-lookup",
    "polars",
    "scientific-critical-thinking",
    "scientific-visualization",
    "scientific-writing",
    "statistical-analysis",
  ];

  // One notice for every 1.6.0 state, so it must read true to each. These are
  // the phrases that hold for all four: what search does now, where sci_find is
  // listed, how to undo it, and no assumption about what the reader did.
  const forEveryone = [
    ["BM25F ranking", /BM25F/],
    [
      `${FIRST_SEARCH_LIMIT} hits then ${LATER_SEARCH_LIMIT}`,
      new RegExp(`${FIRST_SEARCH_LIMIT} hits.*then ${LATER_SEARCH_LIMIT}\\b`),
    ],
    ['the "limit" argument is gone', /"limit" argument is gone/],
    [
      "PI_SCI_FIND_RANKER=current restores the ranking order only",
      /PI_SCI_FIND_RANKER=current restores the old ranking order only\./,
    ],
    [
      "listed in pi's default system prompt only",
      /In pi's default system prompt \(not a custom SYSTEM\.md or --system-prompt\)/,
    ],
    ["a guideline for scientific work", /scientific, research and analysis work/],
    ["a way to turn the tool off", /"extensions": \[\]/],
    ['"/sci status"', /"\/sci status"/],
    ["does not say it replaces loading Core", (text) => !/instead of loading Core/.test(text)],
    [
      "does not address a choice the reader may not have made",
      (text) => !/\byou (chose|declined|accepted|ran)\b/i.test(text),
    ],
  ];
  const holds = (notice, phrases) =>
    phrases
      .filter(([, test]) => !(typeof test === "function" ? test(notice) : test.test(notice)))
      .map(([what]) => what);

  // What applies to one state on top of that.
  const coreBack = [
    ['"/sci search" no longer loads Core', /"\/sci search" no longer loads Core/],
    ["the way back to Core", /"\/sci profiles", tick Core, press Enter\./],
  ];
  const emptyFilter = [
    ['an empty "skills" filter means search mode, not off', /empty "skills" filter.*search mode, not off/],
  ];
  const namedOverrides = [
    ["/sci search names the pi config overrides it drops", /names any pi config overrides it drops/],
    ["the way back to Core", /"\/sci profiles", tick Core, press Enter\./],
  ];

  const seen160 = { onboardingSeen: true, lastSeenVersion: "1.6.0", version: 1 };
  const STATES = [
    {
      label: "accepted the offer (Core)",
      settings: file({ packages: [{ source: SOURCE, skills: CORE }] }),
      config: file({ ...seen160, updatedAt: "2026-09-30T20:08:53.591Z", profiles: ["core"] }),
      profiles: ["core"],
      phrases: coreBack,
    },
    {
      label: "declined the offer (all skills, no filter)",
      settings: file({ packages: [SOURCE] }),
      config: file({ ...seen160, updatedAt: "2026-09-30T20:08:53.592Z" }),
      profiles: undefined,
      phrases: [],
    },
    {
      label: "ran /sci none (skills: [] meant off)",
      settings: file({ packages: [{ source: SOURCE, skills: [] }] }),
      config: file({ ...seen160, updatedAt: "2026-09-30T20:08:53.593Z", profiles: [] }),
      profiles: [],
      phrases: emptyFilter,
    },
    {
      label: "Core plus a pi config override (!polars)",
      settings: file({ packages: [{ source: SOURCE, skills: [...CORE, "!polars"] }] }),
      config: file({ ...seen160, updatedAt: "2026-09-30T20:08:53.595Z", profiles: ["core"] }),
      profiles: ["core"],
      phrases: namedOverrides,
    },
  ];
  const [CORE_STATE, DECLINED_STATE, NONE_STATE, OVERRIDE_STATE] = STATES;

  for (const state of STATES) {
    const paths = newAgentDir();
    writeFileSync(paths.settings, state.settings);
    writeFileSync(paths.config, state.config);
    const harness = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
    await startup(register(harness), harness);
    const notice = harness.notes[0] ?? "";

    check(
      `${state.label}: told once, never asked, nothing done for them`,
      harness.notes.length === 1 &&
        harness.selects.length === 0 &&
        harness.sendUserMessage.length === 0 &&
        harness.reloadCount() === 0,
      JSON.stringify({ notes: harness.notes.length, selects: harness.selects.length }),
    );
    check(
      `${state.label}: settings.json is byte-identical`,
      readFileSync(paths.settings, "utf8") === state.settings,
      "an upgrade must never rewrite a user's settings",
    );
    const config = JSON.parse(readFileSync(paths.config, "utf8"));
    check(
      `${state.label}: records the version and keeps their saved profiles`,
      config.lastSeenVersion === PACKAGE_VERSION && JSON.stringify(config.profiles) === JSON.stringify(state.profiles),
      JSON.stringify(config),
    );
    const missing = holds(notice, forEveryone);
    check(
      `${state.label}: the notice gives the news that holds for every state`,
      missing.length === 0,
      `missing: ${missing.join("; ")}\n${notice}`,
    );
    for (const phrase of state.phrases) {
      check(`${state.label}: the notice gives ${phrase[0]}`, holds(notice, [phrase]).length === 0, notice);
    }
  }

  // The notice makes claims about commands. Run them.
  {
    // (b) The way back to Core: /sci search, then /sci profiles, tick Core, press Enter.
    // This harness has no ui.custom, so it drives the select() fallback, where
    // Enter on the row under the cursor ("Apply and reload") applies.
    const paths = newAgentDir();
    writeFileSync(paths.settings, CORE_STATE.settings);
    writeFileSync(paths.config, CORE_STATE.config);
    const search = makeHarness();
    await register(search).commandHandler("search", search.ctx);
    check(
      "accepted the offer: /sci search now writes an empty filter, not Core",
      JSON.stringify(JSON.parse(readFileSync(paths.settings, "utf8")).packages[0].skills) === "[]",
      readFileSync(paths.settings, "utf8"),
    );
    const tickCore = (options) => {
      const row = options.find((option) => /^\[.\] Core — /.test(option));
      return row?.startsWith("[ ]") ? row : "Apply and reload";
    };
    const back = makeHarness({ mode: "tui", selectAnswer: tickCore });
    await register(back).commandHandler("profiles", back.ctx);
    check(
      "accepted the offer: /sci profiles, tick Core, press Enter restores 1.6.0's Core settings byte for byte",
      readFileSync(paths.settings, "utf8") === CORE_STATE.settings,
      readFileSync(paths.settings, "utf8"),
    );
    check("and reloads so it takes effect", back.reloadCount() === 1);
  }
  {
    // (c) Declined: nothing in their settings; the tool is on and the status says so.
    const paths = newAgentDir();
    writeFileSync(paths.settings, DECLINED_STATE.settings);
    writeFileSync(paths.config, DECLINED_STATE.config);
    const harness = makeHarness();
    await register(harness).commandHandler("status", harness.ctx);
    check(
      "declined the offer: status still shows every skill loaded, with sci_find active",
      /all skills active/.test(harness.notes.at(-1) ?? "") && /sci_find: active/.test(harness.notes.at(-1) ?? ""),
      harness.notes.at(-1),
    );
  }
  {
    // (d) skills: [] is search mode now, and sci_find stays on.
    const paths = newAgentDir();
    writeFileSync(paths.settings, NONE_STATE.settings);
    writeFileSync(paths.config, NONE_STATE.config);
    const harness = makeHarness();
    await register(harness).commandHandler("status", harness.ctx);
    check(
      "ran /sci none: status reads the empty filter as search mode, with sci_find active",
      /search mode/.test(harness.notes.at(-1) ?? "") && /sci_find: active/.test(harness.notes.at(-1) ?? ""),
      harness.notes.at(-1),
    );
  }
  {
    // (e) /sci search names the override it drops.
    const paths = newAgentDir();
    writeFileSync(paths.settings, OVERRIDE_STATE.settings);
    writeFileSync(paths.config, OVERRIDE_STATE.config);
    const harness = makeHarness();
    await register(harness).commandHandler("search", harness.ctx);
    check(
      "Core plus !polars: /sci search names the dropped override",
      /Dropped pi config overrides: !polars\./.test(harness.notes.at(-1) ?? ""),
      harness.notes.at(-1),
    );
    check(
      "and writes the empty filter",
      JSON.stringify(JSON.parse(readFileSync(paths.settings, "utf8")).packages[0].skills) === "[]",
    );
  }
}

console.log("\n-- downgrade (older release running after a newer one was seen) --");
{
  const paths = newAgentDir();
  const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  // Unambiguous in either direction pi's version ever moves: no real release
  // will reach 99.0.0, so this is a downgrade regardless of the running
  // version's own major/minor/patch digits.
  const newerSeen = "99.0.0";
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, onboardingSeen: true, lastSeenVersion: newerSeen }, null, 2),
  );

  const harness = makeHarness({ mode: "tui" });
  const hooks = register(harness);
  await startup(hooks, harness);

  check("is told, not asked", harness.selects.length === 0 && harness.notes.length === 1);
  const notice = harness.notes[0] ?? "";
  check(
    "the one-liner names both versions, not the newer release's feature notes",
    notice === `pi-scientific-skills: running ${PACKAGE_VERSION} after ${newerSeen}; your selection is unchanged.`,
    notice,
  );
  check("no action taken on their behalf", harness.sendUserMessage.length === 0);

  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  check(
    "does not overwrite the newer version already seen — or the real upgrade notice would fire again next time",
    config.lastSeenVersion === newerSeen,
    JSON.stringify(config),
  );

  // A second startup while still downgraded must say it again, not go silent —
  // unlike an upgrade, nothing was recorded to make it a one-time notice.
  const second = makeHarness({ mode: "tui" });
  await startup(register(second), second);
  check("says it again next time, since nothing was recorded", second.notes.length === 1);
}

console.log("\n-- first run (already hand-filtered) --");
{
  // No extension config, but a `pi config`-written filter already in place.
  // They have answered the offer's question, so they are told, not asked — and
  // what they are told is the part that matters to them specifically: sci_find
  // reaches past the filter they set.
  const paths = newAgentDir();
  const settingsBefore = JSON.stringify(
    { packages: [{ source: "pi-scientific-skills", skills: ["pysam", "scanpy"] }] },
    null,
    2,
  );
  writeFileSync(paths.settings, settingsBefore);

  const harness = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
  const hooks = register(harness);
  await startup(hooks, harness);

  check("does not re-ask someone who already chose", harness.selects.length === 0);
  check("still tells them something changed", harness.notes.length === 1);
  check(
    "discloses that the tool reaches past their filter",
    /sci_find/.test(harness.notes[0] ?? "") && /filter/.test(harness.notes[0] ?? ""),
    harness.notes[0],
  );
  // The listing is in pi's default system prompt only. The notice says so in the
  // words the upgrade notice uses, so a hand-filtered user is not told that a
  // custom prompt lists the tool.
  check(
    "names the custom-prompt limit, in the upgrade notice's own words",
    (harness.notes[0] ?? "").includes(DEFAULT_PROMPT_LISTING) &&
      extension.upgradeNotice("1.6.0", "1.7.0").includes(DEFAULT_PROMPT_LISTING),
    harness.notes[0],
  );
  check(
    "settings.json is byte-identical",
    readFileSync(paths.settings, "utf8") === settingsBefore,
  );

  const second = makeHarness({ mode: "tui" });
  await startup(register(second), second);
  check("notice is shown exactly once", second.notes.length === 0);
}

console.log("\n-- first run (hand-filtered with an empty filter) --");
{
  // `skills: []` meant "off" before 1.7.0 and means search mode now. Someone who
  // wrote one by hand, before ever running /sci, is owed both facts: what the
  // empty filter means now, and where the listing is (and is not).
  const paths = newAgentDir();
  const settingsBefore = JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: [] }] }, null, 2);
  writeFileSync(paths.settings, settingsBefore);

  const harness = makeHarness({ mode: "tui", selectAnswer: (options) => options[0] });
  await startup(register(harness), harness);
  const notice = harness.notes[0] ?? "";

  check("does not re-ask someone who already chose", harness.selects.length === 0);
  check("tells them once", harness.notes.length === 1);
  check(
    "says an empty filter means search mode, not off, and sci_find stays on",
    /An empty "skills" filter now means search mode, not off; sci_find stays on\./.test(notice),
    notice,
  );
  check(
    "names the custom-prompt limit, in the upgrade notice's own words",
    notice.includes(DEFAULT_PROMPT_LISTING),
    notice,
  );
  check("leaves their filter unchanged and says so", /your "skills" filter is unchanged/.test(notice), notice);
  check("settings.json is byte-identical", readFileSync(paths.settings, "utf8") === settingsBefore);
  check("takes no action on their behalf", harness.sendUserMessage.length === 0 && harness.reloadCount() === 0);
}

console.log("\n-- first run (print mode, no UI bound) --");
{
  // ui.notify is a no-op with no UI bound. Informing into the void and then
  // recording "told" would silently cost this user their one notice.
  newAgentDir();
  const harness = makeHarness({ mode: "print", hasUI: false });
  const hooks = register(harness);

  const stderr = await captureStderr(() => startup(hooks, harness));

  check(
    "falls back to stderr rather than going silent",
    new RegExp(String(TOTAL_SKILL_COUNT)).test(stderr),
    stderr.slice(0, 80),
  );
  check("never prompts", harness.selects.length === 0);
}

console.log("\n-- /sci find --");
{
  newAgentDir();
  const harness = makeHarness();
  const hooks = register(harness);

  // Goes through dispatch(), which must split the verb from the free-text rest.
  await hooks.commandHandler("find variant calling from a bam file", harness.ctx);

  const output = harness.notes.join("\n");
  check("splits the verb from the query", /pysam|pathogen-variant-surveillance/.test(output), output.slice(0, 120));
  check("gives a human the same path a model gets", /SKILL\.md/.test(output));
  check("changes nothing", harness.reloadCount() === 0);
}

console.log("\n-- /sci status --");
{
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["scanpy"] }] }, null, 2),
  );
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("status", harness.ctx);
  const output = harness.notes.join("\n");

  check("says sci_find reaches everything", /sci_find: active/.test(output), output.slice(0, 200));
  // Under a filter, status says what /skill:<name> does. The paths pi still
  // owns are documented under "Residual limits" and must not leak back into
  // the one line every filtered user reads.
  check("says /skill:<name> loads filtered-out skills", /\/skill:<name>/.test(output), output.slice(0, 400));
  check(
    "and states what works, not where pi still fails",
    !/silently|still passes|steer/.test(output),
    output.slice(0, 400),
  );
  check("reports without writing", harness.reloadCount() === 0);
}

{
  // The line is about filtered-out skills, so an unfiltered user does not get it.
  const paths = newAgentDir();
  writeFileSync(paths.settings, JSON.stringify({ packages: ["pi-scientific-skills"] }, null, 2));
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("status", harness.ctx);
  const output = harness.notes.join("\n");

  check("no filter → no /skill: line", !/\/skill:<name>/.test(output), output.slice(0, 200));
}

{
  // An override-only glob that matches NOTHING real. Before the glob-aware
  // fix, `removed` counted the PATTERN ("1 disabled"); a glob is not a
  // skill, so the honest count is however many catalogue names it actually
  // matches — here, zero, since every real skill is spelled "genomic-…",
  // never "genomics-…".
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["!genomics-*"] }] }, null, 2),
  );
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("status", harness.ctx);
  const output = harness.notes.join("\n");

  check("a glob override is marked approximate", /≈\d+\/\d+ skills/.test(output), output.slice(0, 200));
  check(
    "a pattern matching no real skill removes zero, not one",
    /\(all skills minus 0 disabled elsewhere\)/.test(output),
    output.slice(0, 200),
  );
  check(
    `all ${TOTAL_SKILL_COUNT} skills stay active — the pattern named nothing real`,
    new RegExp(`≈${TOTAL_SKILL_COUNT}/${TOTAL_SKILL_COUNT} skills`).test(output),
    output.slice(0, 200),
  );
}

// --- /skill:<name> under a filter -------------------------------------------

console.log("\n-- /skill:<name> under a filter --");
{
  // scanpy is in the filter, so pi's registry holds it; pysam is filtered out,
  // so pi has no entry for it and would forward the literal text to the model.
  const paths = newAgentDir();
  writeFileSync(
    paths.settings,
    JSON.stringify({ packages: [{ source: "pi-scientific-skills", skills: ["scanpy"] }] }, null, 2),
  );
  const harness = makeHarness();
  harness.commands = [
    { name: "sci", source: "extension" },
    { name: "skill:scanpy", source: "skill" },
  ];
  const hooks = register(harness);
  // The input context is runner.createContext(): no reload() on it.
  const { reload: _reload, ...inputCtx } = harness.ctx;
  const send = (text, source = "interactive") =>
    hooks.inputHandler({ type: "input", text, images: undefined, source, streamingBehavior: undefined }, inputCtx);
  const passes = (result) => result?.action === "continue";
  const transformed = (result) => result?.action === "transform" && typeof result.text === "string";

  check("registers an input handler", typeof hooks.inputHandler === "function");
  check("a skill pi still has loaded stays pi's job", passes(await send("/skill:scanpy")));

  const plain = await send("/skill:pysam");
  check("a filtered-out skill is transformed", transformed(plain), JSON.stringify(plain));
  const text = plain?.text ?? "";
  check(
    "opens with pi's own wrapper, pointing at this package's file",
    /^<skill name="pysam" location="[^"]+\/skills\/pysam\/SKILL\.md">\nReferences are relative to [^\n]+\/skills\/pysam\.\n\n/.test(text),
    text.slice(0, 160),
  );
  check("closes the wrapper", text.endsWith("\n</skill>"));
  const body = text.slice(text.indexOf("\n\n") + 2);
  check("frontmatter is stripped, body is trimmed", !body.startsWith("---") && !body.startsWith("\n"), body.slice(0, 40));
  check("carries real skill content", /pysam/i.test(body) && body.length > 500, `${body.length} chars`);
  // Both of pi's own expanders bail on their first character, so a "<" start is
  // what proves there is no double expansion afterwards.
  check("does not start with / (neither downstream expander touches it)", !text.startsWith("/"));

  const withArgs = await send("/skill:pysam do the thing");
  check("args follow the block after a blank line", (withArgs?.text ?? "").endsWith("</skill>\n\ndo the thing"));
  const spaced = await send("/skill:pysam    lots   of   spaces");
  check(
    "internal spacing survives, leading spacing does not",
    (spaced?.text ?? "").endsWith("</skill>\n\nlots   of   spaces"),
    JSON.stringify((spaced?.text ?? "").slice(-30)),
  );
  const blankArgs = await send("/skill:pysam   ");
  check("whitespace-only args are the no-args form", blankArgs?.text === text);

  check("an unknown name passes through", passes(await send("/skill:not-a-real-skill")));
  // pi splits on the first space, not the first whitespace, so this misses on
  // stock pi for a loaded skill too. Pinned so nobody "fixes" it here and makes
  // a filtered skill behave differently from an active one.
  check("the multi-line form misses, exactly as pi's does", passes(await send("/skill:pysam\nrest")));

  for (const other of ["hello world", "/sci status", "/skill-ish", "x /skill:pysam", "/skill:", "/skill: "]) {
    check(`untouched: ${JSON.stringify(other)}`, passes(await send(other)));
  }

  // sendUserMessage defaults expandPromptTemplates to false: pi's intent there
  // is not to expand, and source is the only proxy the event carries.
  check("extension-injected input passes through", passes(await send("/skill:pysam", "extension")));

  // The lookup is a Map over real directory entries, never a path join. These
  // must pass through, and this check must fail loudly if anyone rewrites it.
  for (const escape of [
    "/skill:../../etc/passwd",
    "/skill:../../../../home/user/.ssh/id_rsa",
    "/skill:pysam/../../package.json",
    "/skill:/etc/passwd",
  ]) {
    check(`never resolves a path: ${escape}`, passes(await send(escape)));
  }

  check("reads, never writes", readFileSync(paths.settings, "utf8").includes('"scanpy"') && harness.reloadCount() === 0);
}

{
  // Unfiltered: pi has the skill, so the hook must stand down even though the
  // name is in this package's catalogue.
  newAgentDir();
  const harness = makeHarness();
  harness.commands = [{ name: "skill:pysam", source: "skill" }];
  const hooks = register(harness);
  const { reload: _reload, ...inputCtx } = harness.ctx;
  const result = await hooks.inputHandler(
    { type: "input", text: "/skill:pysam", images: undefined, source: "interactive", streamingBehavior: undefined },
    inputCtx,
  );
  check("no filter → every /skill: passes through", result?.action === "continue");
}

{
  // The hook never reads settings.json, so a broken one must not disable it —
  // and must not be written, either.
  const paths = newAgentDir();
  const broken = "{ this is not json";
  writeFileSync(paths.settings, broken);
  const harness = makeHarness();
  const hooks = register(harness);
  const { reload: _reload, ...inputCtx } = harness.ctx;
  let result;
  let threw = false;
  try {
    result = await hooks.inputHandler(
      { type: "input", text: "/skill:pysam", images: undefined, source: "interactive", streamingBehavior: undefined },
      inputCtx,
    );
  } catch {
    threw = true;
  }
  check("malformed settings.json: still transforms", !threw && result?.action === "transform");
  check("malformed settings.json: not written", readFileSync(paths.settings, "utf8") === broken);
}

// --- refusal ---------------------------------------------------------------

console.log("\n-- malformed settings --");
{
  const paths = newAgentDir();
  const broken = "{ this is not json";
  writeFileSync(paths.settings, broken);
  const harness = makeHarness();
  const hooks = register(harness);

  await hooks.commandHandler("search", harness.ctx);

  check("refuses rather than guessing", readFileSync(paths.settings, "utf8") === broken);
  check("explains why", harness.notes.some((note) => /settings/i.test(note)), harness.notes.join(" | "));
  check("does not reload", harness.reloadCount() === 0);
}

// --- sibling modules register nothing ---------------------------------------

// pi's extension loader runs every file under extensions/ (dist/core/extensions/
// loader.js: a glob over the directory), so exactly one of them may register a
// command, tool, or hook — a duplicate command is silently renamed ("sci:2") and
// a duplicate tool is silently dropped. Every file but index.ts must therefore be
// the inert `export default function noopExtension(): void {}`.
console.log("\n-- sibling modules register nothing --");
{
  const files = readdirSync(EXTENSIONS_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .sort();

  for (const file of files) {
    const mod = await loadExtensionModule(`extensions/${file}`);
    const calls = [];
    const proxy = new Proxy(
      {},
      {
        get(_target, key) {
          calls.push(String(key));
          return () => {};
        },
      },
    );
    await mod.default(proxy);
    check(
      `${file}: default export is a no-op and calls nothing on the ExtensionAPI`,
      typeof mod.default === "function" && calls.length === 0,
      calls.length > 0 ? `called: ${calls.join(", ")}` : `typeof default: ${typeof mod.default}`,
    );
  }
}

// --- cleanup ---------------------------------------------------------------

for (const dir of created) rmSync(dir, { recursive: true, force: true });

finish();
