// The simulated user for a multi-turn live probe.
//
// A real scientist answers a clarifying question; a single-turn test scores
// that question as a failure. This persona answers instead, through the
// `claude` CLI. It is BLIND: it sees the task and the assistant's visible text,
// never the target skill, the tool calls, or sci_find's output, so it cannot
// steer the model toward the answer the test is scoring.
import { spawn } from "node:child_process";

export class SupervisorError extends Error {}

const SYSTEM_PROMPT = `You play a scientist talking to an AI assistant in a terminal. You sent the first message. Your goal is to get that request done.

After each assistant response, decide your next move:
- The assistant asked you a question: answer it briefly with plausible, specific details a scientist in your position would have.
- The assistant asked permission to start, or offered to do the work you asked for: say yes.
- The assistant asked for files, data, credentials, accounts or hardware you do not have here: say they are not available in this environment, and ask it to proceed with the method or an example.
- The assistant proposes an action with real-world side effects (submitting jobs to a service, logging in, spending money, sending messages, controlling lab hardware): decline, and ask for the plan or code instead.
- The assistant gave only a vague or generic outline: ask the natural next question that moves your request forward.
- The assistant answered your request: end the conversation.

Rules:
- Never name any software, library, package, database, service or file format that the assistant has not named first.
- Never suggest how the assistant should find information: do not say search, look up, check the docs, or ask whether a tool or package exists.
- Keep a reply to one or two sentences.

Output only one line of compact JSON, nothing else:
{"action":"reply","message":"<your reply>"} or {"action":"end","reason":"<a few words>"}`;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[…${text.length - max} characters cut]` : text);

/** The conversation as the persona sees it: visible text only, no tool traffic. */
function render(task, exchanges) {
  const lines = ["Your first message:", task, ""];
  for (const [index, exchange] of exchanges.entries()) {
    lines.push(`Assistant response ${index + 1}:`, clip(exchange.assistant || "(no text)", 6000), "");
    if (exchange.reply !== undefined) lines.push("You replied:", exchange.reply, "");
  }
  lines.push("Decide your next move. Output only the JSON line.");
  return lines.join("\n");
}

/**
 * `claude -p` with no settings, no MCP servers and no tools: a bare model call.
 * Shared with the probe judge (probe-check.mjs), which brings its own prompt.
 */
export function callClaude({ model, effort, cwd, timeoutMs, systemPrompt }, prompt) {
  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--tools", "",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
  ];
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectCall(new SupervisorError(`claude did not start: ${error.message}`));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        rejectCall(new SupervisorError(`claude exit ${status}: ${(stderr || stdout).trim().slice(0, 300)}`));
        return;
      }
      // --output-format json prints the whole event list; the answer is the `result` event.
      const result = Array.isArray(parsed) ? parsed.find((event) => event.type === "result") : parsed;
      if (!result || result.is_error) {
        rejectCall(new SupervisorError(`claude error: ${String(result?.result ?? "no result event").slice(0, 300)}`));
        return;
      }
      resolveCall(String(result.result ?? ""));
    });
    child.stdin.end(prompt);
  });
}

/** Parse and validate the persona's JSON line. Throws on anything else. */
export function parseDecision(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new SupervisorError(`no JSON in persona output: ${text.slice(0, 200)}`);
  const decision = JSON.parse(json);
  if (decision.action === "reply" && typeof decision.message === "string" && decision.message.trim()) {
    return { action: "reply", message: decision.message.trim().slice(0, 1000) };
  }
  if (decision.action === "end") return { action: "end", reason: String(decision.reason ?? "").slice(0, 200) };
  throw new SupervisorError(`persona output is not a valid decision: ${json.slice(0, 200)}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Run `call` until it succeeds, waiting `delays[i]` before retry i. The last failure throws as a SupervisorError. */
export async function retrying(delays, call) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw lastError instanceof SupervisorError ? lastError : new SupervisorError(String(lastError));
}

/**
 * @param {{ model: string, effort?: string, cwd: string, timeoutMs?: number, delays?: number[] }} options
 *   `cwd` must be outside the repo, so no project settings or CLAUDE.md apply.
 *   `delays` are the waits before each retry. Subscription auth rate-limits in
 *   bursts, and one failing probe can make a dozen calls: backing off keeps a
 *   burst from turning a run of probes into supervisor errors.
 */
export function createPersona({ model, effort = "low", cwd, timeoutMs = 120_000, delays = [15_000, 60_000, 180_000] }) {
  const options = { model, effort, cwd, timeoutMs, systemPrompt: SYSTEM_PROMPT };
  return {
    async next(task, exchanges) {
      const prompt = render(task, exchanges);
      return retrying(delays, async () => parseDecision(await callClaude(options, prompt)));
    },
  };
}
