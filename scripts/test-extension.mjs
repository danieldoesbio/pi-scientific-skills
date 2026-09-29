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

  // pi lists a custom tool under "Available tools" only when it has a
  // promptSnippet. Without one, the 2026-09-23 live test's model saw sci_find
  // only in the tool schema, and 15 of 19 misses never called it.
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

console.log("\n-- sci_find hit count: 3 for the first search after a prompt, then 5 --");
{
  newAgentDir();
  const harness = makeHarness();
  const { tool, events } = register(harness);
  const headings = async (params) =>
    (await tool.execute("id", params)).content[0].text.split("\n").filter((line) => line.startsWith("## ")).length;
  const properties = Object.keys(tool.parameters?.properties ?? {});
  check("no limit parameter: the model cannot ask for a longer list", !properties.includes("limit"), properties.join(", "));
  check(
    "the description states the counts",
    /first search returns the best 3 matches and later searches the best 5/.test(tool.description),
  );
  check(
    "agent_start and turn_start are handled",
    typeof events.agent_start === "function" && typeof events.turn_start === "function",
  );

  const query = "single cell rna-seq clustering";
  await events.agent_start({ type: "agent_start" });
  await events.turn_start({ type: "turn_start", turnIndex: 0, timestamp: 0 });
  await tool.execute("id", { profile: "drug-discovery" });
  await tool.execute("id", {});
  await events.turn_start({ type: "turn_start", turnIndex: 1, timestamp: 0 });
  const first = await headings({ query });
  const parallel = await headings({ query: "protein structure prediction" });
  check(
    "the first turn that searches shows 3, parallel calls too; listings before it do not count",
    first === 3 && parallel === 3,
    `${first}, ${parallel}`,
  );
  await events.turn_start({ type: "turn_start", turnIndex: 2, timestamp: 0 });
  const later = await headings({ query });
  const stray = await headings({ query, limit: 20 });
  check("a later turn shows 5, and a stray limit argument is ignored", later === 5 && stray === 5, `${later}, ${stray}`);
  await events.agent_start({ type: "agent_start" });
  await events.turn_start({ type: "turn_start", turnIndex: 0, timestamp: 0 });
  check("a new prompt starts again at 3", (await headings({ query })) === 3);
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
  const prompt = buildSystemPrompt({
    selectedTools: ["read", "bash", "edit", "write", "sci_find"],
    toolSnippets: { sci_find: snippet },
    promptGuidelines: guidelines,
    cwd: tmpdir(),
    skills: [],
  });
  const section = (heading) => prompt.split(`${heading}:\n`)[1]?.split("\n\n")[0] ?? "";
  check(
    'listed under "Available tools"',
    section("Available tools").split("\n").includes(`- sci_find: ${snippet}`),
    section("Available tools"),
  );
  check(
    'its guideline is under "Guidelines"',
    guidelines.every((line) => section("Guidelines").split("\n").includes(`- ${line}`)),
    section("Guidelines"),
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
        /Run "\/sci search"/.test(notice),
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
    "minor pair (1.6.0→1.7.0): the search-mode news, not the snapshot they already saw",
    /updated to 1\.7\.0 \(from 1\.6\.0\)/.test(minorNotice) &&
      /Search mode/.test(minorNotice) &&
      /sci_find is now listed/.test(minorNotice) &&
      !/Upstream snapshot/.test(minorNotice),
    minorNotice,
  );

  const skippedNotice = upgradeNotice("1.5.0", "1.7.0");
  check(
    "skipped minor (1.5.0→1.7.0): also the snapshot news they missed",
    /Search mode/.test(skippedNotice) && /Upstream snapshot v2\.69\.0/.test(skippedNotice),
    skippedNotice,
  );
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
  check(
    "settings.json is byte-identical",
    readFileSync(paths.settings, "utf8") === settingsBefore,
  );

  const second = makeHarness({ mode: "tui" });
  await startup(register(second), second);
  check("notice is shown exactly once", second.notes.length === 0);
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
