#!/usr/bin/env node
// Does pi itself honour sci_find's pi 1.0 tool fields?
//
// extensions/index.ts gives sci_find three fields pi added in 0.99:
// `annotations`, `outputSchema` with `structuredContent`, and `isError` on a
// failed call. On 0.87 they must be inert. The behavioural suite
// (test-extension.mjs) registers the extension against doubles, so it cannot
// see what pi does with them. This runs a real AgentSession from the installed
// pi's own SDK, with pi-ai's scripted faux provider as the model: no network,
// no key, no tokens. The faux model makes three calls in one turn: sci_find
// with a profile that does not exist, then (pi 0.99+ only) a codemode script
// that calls `tools.sci_find` and returns what the script received.
//
// Every check runs on every pi, with the expectation its version calls for, so
// the count README.md quotes is the same on both CI rows.
//
// Usage: node scripts/test-pi-runtime.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findPiDist } from "./lib/load-extension.mjs";
import { createSuite } from "./lib/harness.mjs";

const piDist = findPiDist();
if (!piDist) {
  console.error("FAIL: pi is not on PATH and PI_DIST is unset — there is no real session to run.");
  process.exit(1);
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { check, finish } = createSuite("real-session checks of sci_find's pi 1.0 tool fields");

// Isolated like the live harness: nothing from the real agent dir (settings,
// packages, auth) reaches the session.
const scratch = mkdtempSync(join(tmpdir(), "sci-runtime-"));
const agentDir = join(scratch, "agent");
const cwd = join(scratch, "cwd");
for (const dir of [agentDir, cwd]) mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;

const pi = await import(pathToFileURL(join(piDist, "index.js")).href);
// pi-ai is pi's own dependency: nested under pi in a global install, or
// hoisted beside it.
const piRoot = dirname(piDist);
const aiEntry = [
  join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
  join(dirname(piRoot), "pi-ai", "dist", "index.js"),
].find((path) => existsSync(path));
if (!aiEntry) {
  console.error(`FAIL: pi-ai not found next to ${piRoot} — no faux provider to drive the session.`);
  process.exit(1);
}
const ai = await import(pathToFileURL(aiEntry).href);

// Codemode is a built-in extension from pi 0.99. The CLI loads it; an SDK
// session adds it through `extensionFactories`.
const hasCodemode = typeof pi.createCodemodeExtension === "function";

const SCRIPT =
  'const found = await tools.sci_find({ query: "variant calling from a bam file" });' +
  " return JSON.stringify({ type: typeof found, value: found });";

const toolEnds = [];
let session;
try {
  const faux = ai.fauxProvider();
  const modelRuntime = await pi.ModelRuntime.create({ agentDir });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: hasCodemode ? [pi.createCodemodeExtension()] : [],
    additionalExtensionPaths: [join(ROOT, "extensions")],
  });
  await resourceLoader.reload();
  ({ session } = await pi.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    modelRuntime,
    model: faux.getModel(),
    sessionManager: pi.SessionManager.inMemory(),
    tools: ["read", "sci_find", ...(hasCodemode ? ["codemode"] : [])],
  }));
  session.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    toolEnds.push({
      name: event.toolName,
      isError: event.isError,
      text: (event.result?.content ?? []).map((part) => part.text ?? "").join(""),
    });
  });
  faux.setResponses([
    ai.fauxAssistantMessage(
      [
        ai.fauxToolCall("sci_find", { profile: "no-such-profile" }),
        ...(hasCodemode ? [ai.fauxToolCall("codemode", { code: SCRIPT })] : []),
      ],
      { stopReason: "toolUse" },
    ),
    ai.fauxAssistantMessage("done"),
  ]);
  // The first-run offer has no UI to answer it here and goes to stderr.
  await session.prompt("find a skill for variant calling");
} catch (error) {
  console.error(`FAIL: the session did not run: ${error?.stack ?? error}`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const tools = session.getAllTools();
const sciFind = tools.find((tool) => tool.name === "sci_find");
// `exposure` is reported from 0.99 on: the same release that reads the fields.
const readsToolFields = sciFind !== undefined && "exposure" in sciFind;
console.log(`-- pi at ${piRoot}: ${readsToolFields ? "reads" : "predates"} the 0.99 tool fields --`);

check(
  "sci_find is registered and active in a real session",
  sciFind !== undefined && session.getActiveToolNames().includes("sci_find"),
  JSON.stringify(session.getActiveToolNames()),
);
check(
  "pi has codemode exactly when it reads the tool fields (both arrived in 0.99)",
  hasCodemode === readsToolFields,
  `codemode ${hasCodemode}, tool fields ${readsToolFields}`,
);

const unknown = toolEnds.find((end) => end.name === "sci_find" && /No profile "no-such-profile"/.test(end.text));
check(
  "an unknown profile still lists the real ones",
  unknown !== undefined && /genomics-bioinformatics/.test(unknown.text),
  JSON.stringify(toolEnds).slice(0, 300),
);
check(
  readsToolFields
    ? "an unknown profile is a failed call (isError)"
    : "an unknown profile is an ordinary result: this pi drops isError",
  unknown?.isError === readsToolFields,
  JSON.stringify(unknown),
);

const hints = sciFind?.annotations;
check(
  readsToolFields
    ? "pi reports sci_find as read-only and closed-world"
    : "this pi reports no annotations: the field is inert",
  readsToolFields
    ? hints?.readOnlyHint === true && hints?.openWorldHint === false && hints?.destructiveHint === false
    : hints === undefined,
  JSON.stringify(hints),
);

const description = session.agent.state.tools.find((tool) => tool.name === "sci_find")?.description ?? "";
check(
  readsToolFields
    ? "with codemode on, sci_find's description names the result fields scripts get"
    : "sci_find's description has no codemode note",
  readsToolFields
    ? /`tools\.sci_find\(args\)` resolves to `\{ kind, query, profile, skills, profiles \}`/.test(description)
    : !/Codemode:/.test(description),
  description.slice(-160),
);

// What the script returned: `{ type, value }` as JSON, after codemode's header.
const scriptEnd = toolEnds.find((end) => end.name === "codemode");
let received;
try {
  received = JSON.parse(scriptEnd?.text.slice(scriptEnd.text.indexOf("{")) ?? "");
} catch {
  received = undefined;
}
const skills = received?.value?.skills ?? [];
check(
  hasCodemode
    ? "a codemode script gets sci_find's result as an object, with SKILL.md paths, 3 hits on a first search"
    : "this pi has no codemode tool, so no script ran",
  hasCodemode
    ? received?.type === "object" &&
        received.value.kind === "search" &&
        skills.length === 3 &&
        skills.every((skill) => skill.path.endsWith("/SKILL.md") && skill.path.startsWith(skill.dir))
    : scriptEnd === undefined,
  scriptEnd?.text.slice(0, 300) ?? "no codemode call",
);

session.dispose();
rmSync(scratch, { recursive: true, force: true });
finish();
