// Read a pi session file (`--session <path>`) as the conversation it records.
//
// The session file, not the `--mode json` stream, is the source for
// multi-turn runs: each continuation appends to it, so it holds every turn
// exactly once, with tool calls and their results already paired by id.
import { existsSync, readFileSync } from "node:fs";

/**
 * A listing that names more skills than this is a dump of the catalogue, not a
 * search. sci_find's own ceiling (MAX_LIMIT) is the same number, so a bash
 * `find` and a sci_find call count on the same terms.
 */
export const MAX_NAMED = 20;

/** Every entry of a session file: messages, compactions, model changes. */
export function readEntries(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut short by a kill mid-write.
    }
  }
  return entries;
}

/**
 * The messages of a session file. Each carries `entryTime`, the time pi wrote
 * it (ms): for a tool result, about when the tool finished.
 */
export function readMessages(file) {
  return readEntries(file)
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => ({ ...entry.message, entryTime: Date.parse(entry.timestamp) }));
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");

/**
 * One entry per user message: what the user sent, what the assistant showed
 * (text parts only — thinking is not visible to a user), and the tool calls.
 * Each call carries `message`, the 0-based index of the assistant message
 * that made it, counted over the whole session: calls with the same index
 * were written together, before any of their results.
 */
export function responses(messages) {
  const out = [];
  const byId = new Map();
  let assistantMessages = 0;
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ prompt: textOf(message.content), at: message.entryTime, texts: [], calls: [] });
      continue;
    }
    const current = out.at(-1);
    if (!current) continue;
    if (message.role === "assistant") {
      const index = assistantMessages++;
      const text = textOf(message.content).trim();
      if (text) current.texts.push(text);
      for (const part of message.content ?? []) {
        if (part?.type !== "toolCall") continue;
        const call = { id: part.id, tool: part.name, args: part.arguments ?? {}, result: "", isError: false, message: index };
        current.calls.push(call);
        byId.set(part.id, call);
      }
    } else if (message.role === "toolResult") {
      const call = byId.get(message.toolCallId);
      if (!call) continue;
      call.result = textOf(message.content);
      call.isError = message.isError === true;
      call.resultAt = message.entryTime;
    }
  }
  return out;
}

/** Skill names in one sci_find result, in rank order (formatHits' `## name` headings). */
export function hitNames(resultText) {
  return [...resultText.matchAll(/^## (\S+)/gm)].map((match) => match[1]);
}

/** Skill names a bash output points at: skill paths, or a SKILL.md frontmatter `name:` line. */
function bashNames(output, catalogue) {
  const names = new Set();
  for (const match of output.matchAll(/\/skills\/([a-z0-9][a-z0-9-]*)/g)) names.add(match[1]);
  for (const match of output.matchAll(/(?:^|[\s./'"])([a-z0-9][a-z0-9-]*)\/SKILL\.md/gm)) names.add(match[1]);
  for (const match of output.matchAll(/^name:\s*([a-z0-9][a-z0-9-]*)\s*$/gm)) names.add(match[1]);
  return [...names].filter((name) => catalogue.has(name));
}

/**
 * Every point where a skill in `want` reached the model, in order.
 *
 * Three routes count: a sci_find result that lists it, a bash command whose
 * output points at it, and a successful read of a file inside it. A result
 * naming more than MAX_NAMED skills is a catalogue dump and counts for none
 * of them — the model still gets credit if it then reads the right one.
 */
export function reaches(turns, want, catalogue) {
  const found = [];
  for (const [index, turn] of turns.entries()) {
    for (const call of turn.calls) {
      if (call.isError) continue;
      let names = [];
      let by = null;
      if (call.tool === "sci_find") {
        names = hitNames(call.result);
        by = "sci_find";
      } else if (call.tool === "bash") {
        names = bashNames(call.result, catalogue);
        by = "bash";
      } else if (call.tool === "read") {
        const path = String(call.args.path ?? call.args.filePath ?? "");
        const name = path.match(/\/skills\/([a-z0-9][a-z0-9-]*)\//)?.[1];
        names = name && catalogue.has(name) ? [name] : [];
        by = "read";
      }
      if (names.length === 0 || names.length > MAX_NAMED) continue;
      for (const skill of want.filter((name) => names.includes(name))) {
        const entry = { skill, by, response: index + 1, at: call.resultAt ?? null };
        if (by === "bash") entry.command = String(call.args.command ?? "").slice(0, 300);
        found.push(entry);
      }
    }
  }
  return found;
}

/** Names of skills whose SKILL.md the model read successfully. */
export function readSkills(turns) {
  const names = turns.flatMap((turn) =>
    turn.calls
      .filter((call) => call.tool === "read" && !call.isError)
      .map((call) => String(call.args.path ?? call.args.filePath ?? "").match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1])
      .filter(Boolean),
  );
  return [...new Set(names)];
}

const pathArg = (call) => String(call.args.path ?? call.args.filePath ?? "");

/**
 * Every point where the model read the SKILL.md of a skill in `want`, in order.
 *
 * The `read` endpoint: listing a skill is not using it. Two routes count: a
 * successful `read` of `<skills>/<name>/SKILL.md`, and a bash command that
 * names `<name>/SKILL.md` and whose output holds that file's `name: <name>`
 * frontmatter line (a `cat` or `head` of it).
 */
export function skillReads(turns, want) {
  const found = [];
  for (const [index, turn] of turns.entries()) {
    for (const call of turn.calls) {
      if (call.isError) continue;
      for (const skill of want) {
        const hit =
          call.tool === "read"
            ? pathArg(call).endsWith(`/skills/${skill}/SKILL.md`)
            : call.tool === "bash" &&
              String(call.args.command ?? "").includes(`${skill}/SKILL.md`) &&
              new RegExp(`^name:\\s*${skill}\\s*$`, "m").test(call.result);
        if (hit) found.push({ skill, by: call.tool, response: index + 1, at: call.resultAt ?? null });
      }
    }
  }
  return found;
}

/**
 * Does a tool call look for a skill? A sci_find call, or a read or bash call
 * that touches a SKILL.md or a skills directory (in its argument or, for bash,
 * its output). Broad on purpose: the gate below ends attempts that never do
 * this, and a false "seeking" only lets an attempt run on.
 */
export function isSeek(call) {
  if (call.tool === "sci_find") return true;
  // `/skills` as a whole path segment: PATH can hold a `/skills-plugin/` directory.
  const pattern = /SKILL\.md|\/skills(?:\/|\s|$)/m;
  if (call.tool === "read") return pattern.test(pathArg(call));
  if (call.tool === "bash") return pattern.test(String(call.args.command ?? "")) || pattern.test(call.result);
  return false;
}

/** Every tool call of an attempt, in order, across its responses. */
export const allCalls = (turns) => turns.flatMap((turn) => turn.calls);

/**
 * The timeout gate: true once the attempt has made `limit` tool calls and
 * none of the first `limit` looked for a skill (isSeek). On 2026-09-23 every
 * reaching attempt made its first seeking call by call 9 (0-based 8).
 */
export function gateTripped(turns, limit) {
  if (!limit) return false;
  const calls = allCalls(turns);
  return calls.length >= limit && !calls.slice(0, limit).some(isSeek);
}

/** llama.cpp's overflow error, and pi-ai's generic fallbacks (utils/overflow.js). */
const OVERFLOW = /exceeds the available context size|context[_ ]length[_ ]exceeded|exceeds the context window|too many tokens/i;

/**
 * Token and context measures of one attempt's session file.
 *
 * Prompt size of a request = usage input + cacheRead + cacheWrite; context at
 * its end adds output. pi writes a `compaction` entry when it compacts; a
 * provider overflow is an assistant message with stopReason "error" whose
 * error matches OVERFLOW (pi then compacts and retries once).
 */
export function sessionMeasures(entries) {
  const assistants = entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
    .map((entry) => entry.message);
  const prompt = (usage) => (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const errors = assistants.filter((message) => message.stopReason === "error");
  const overflows = errors.filter((message) => OVERFLOW.test(String(message.errorMessage ?? "")));
  return {
    requests: assistants.length,
    firstPromptTokens: assistants[0]?.usage ? prompt(assistants[0].usage) : null,
    peakContext: assistants.reduce((peak, message) => Math.max(peak, prompt(message.usage) + (message.usage?.output ?? 0)), 0) || null,
    outputTokens: assistants.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0),
    compactions: entries
      .filter((entry) => entry.type === "compaction")
      .map((entry) => ({ tokensBefore: entry.tokensBefore ?? null })),
    providerErrors: errors.map((message) => String(message.errorMessage ?? "").slice(0, 200)),
    overflows: overflows.length,
    endedOnOverflow: assistants.length > 0 && overflows.includes(assistants.at(-1)),
    // Any other provider error (the server died, a 500): a harness failure,
    // not the model's behaviour. None occurred in 185 sessions on 2026-09-23.
    endedOnProviderError:
      assistants.at(-1)?.stopReason === "error" && !overflows.includes(assistants.at(-1))
        ? String(assistants.at(-1).errorMessage ?? "unknown").slice(0, 200)
        : null,
  };
}
