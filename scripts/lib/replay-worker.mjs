// One replayed choice turn (see scripts/find-live-replay.mjs). Runs as a child
// process with its own HOME and agent dir, like one attempt of the live
// harness, so nothing from the real home reaches pi's system prompt.
//
//   node scripts/lib/replay-worker.mjs <job.json>
//
// The job names a session file cut after a sci_find result. The worker opens
// it with pi's SDK, continues the agent from that tool result and keeps the
// first assistant message. Tools never run: every tool's `execute` is a stub
// that throws, and the run is aborted at the first assistant message_end
// (with `proveStub`, at the first turn_end instead, so the tool results show
// the stub was called). Writes the result to `job.output`. Exit 0 when the
// result is written, 1 otherwise.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STUB_ERROR = "replay: tools do not run in a replay";

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function replay(job) {
  const pi = await import(pathToFileURL(join(job.piDist, "index.js")).href);
  const modelRuntime = await pi.ModelRuntime.create();
  const resolved = pi.resolveCliModel({ cliModel: job.model, modelRuntime });
  if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `model ${job.model} not found`);
  const { session } = await pi.createAgentSession({
    cwd: job.cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionManager: pi.SessionManager.open(job.sessionFile),
    model: resolved.model,
    thinkingLevel: job.thinking,
    modelRuntime,
  });
  const agent = session.agent;
  agent.state.tools = agent.state.tools.map((tool) => ({
    ...tool,
    execute: async () => {
      throw new Error(STUB_ERROR);
    },
  }));
  const toolsSignature = JSON.stringify(agent.state.tools.map((tool) => [tool.name, tool.description, tool.parameters]));

  let choice = null;
  let toolResults = null;
  const started = Date.now();
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant" && choice === null) {
      choice = { message: event.message, seconds: (Date.now() - started) / 1000 };
      if (!job.proveStub) agent.abort();
    }
    if (event.type === "turn_end" && job.proveStub && toolResults === null) {
      toolResults = (event.toolResults ?? []).map((result) => ({
        toolName: result.toolName,
        isError: result.isError,
        text: (result.content ?? []).map((part) => part.text ?? "").join(""),
      }));
      agent.abort();
    }
  });
  await agent.continue();
  await agent.waitForIdle();
  const result = {
    ok: choice !== null && choice.message.stopReason !== "error",
    stopReason: choice?.message.stopReason ?? null,
    errorMessage: choice?.message.errorMessage ?? agent.state.errorMessage ?? null,
    message: choice?.message ?? null,
    seconds: choice?.seconds ?? null,
    model: `${agent.state.model?.provider}/${agent.state.model?.id}`,
    thinkingLevel: agent.state.thinkingLevel,
    systemPromptHash: hash(agent.state.systemPrompt ?? ""),
    systemPromptChars: (agent.state.systemPrompt ?? "").length,
    toolsHash: hash(toolsSignature),
    toolResults,
  };
  session.dispose();
  return result;
}

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
try {
  writeFileSync(job.output, `${JSON.stringify(await replay(job))}\n`);
  process.exit(0);
} catch (error) {
  console.error(`replay-worker: ${error?.stack ?? error}`);
  writeFileSync(job.output, `${JSON.stringify({ ok: false, errorMessage: String(error?.message ?? error) })}\n`);
  process.exit(1);
}
