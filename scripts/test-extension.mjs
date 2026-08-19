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
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionModule } from "./lib/load-extension.mjs";

const failures = [];
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ok      ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL    ${label}${detail ? `\n          ${detail}` : ""}`);
  }
};

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

  return { ctx, notes, selects, sent, reloadCount: () => reloads, sendUserMessage: sent };
};

const extension = await loadExtensionModule("extensions/index.ts");

/** Register the extension against doubles and hand back its hooks. */
const register = (harness) => {
  let commandHandler;
  let sessionStart;
  let tool;
  const pi = {
    registerCommand: (_name, options) => {
      commandHandler = options.handler;
    },
    registerTool: (definition) => {
      tool = definition;
    },
    on: (event, handler) => {
      if (event === "session_start") sessionStart = handler;
    },
    sendUserMessage: async (content) => {
      harness.sendUserMessage.push(content);
    },
  };
  extension.default(pi);
  return { commandHandler, sessionStart, tool };
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
  check("writes a skills filter", Array.isArray(entry?.skills));
  check("applies the Core profile", entry.skills.includes("statistical-analysis"));
  check("does not load everything", entry.skills.length < 30, `got ${entry?.skills?.length}`);
  check("preserves hand-written overrides", entry.skills.includes("!autoskill"));
  check("reloads so it takes effect now", harness.reloadCount() === 1);
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
    "offer states both costs",
    /157/.test(harness.selects[0]?.title ?? "") && /Core/.test(harness.selects[0]?.title ?? ""),
  );
  check("accepting queues the command", harness.sendUserMessage.includes("/sci search"));
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

  check("falls back to stderr rather than going silent", /157/.test(stderr), stderr.slice(0, 80));
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

// --- cleanup ---------------------------------------------------------------

for (const dir of created) rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
for (const failure of failures) console.log(`  [FAIL] ${failure}`);
process.exit(failures.length > 0 ? 1 : 0);
