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

export function readMessages(file) {
  if (!existsSync(file)) return [];
  const messages = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) messages.push(entry.message);
    } catch {
      // A line cut short by a kill mid-write.
    }
  }
  return messages;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");

/**
 * One entry per user message: what the user sent, what the assistant showed
 * (text parts only — thinking is not visible to a user), and the tool calls.
 */
export function responses(messages) {
  const out = [];
  const byId = new Map();
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ prompt: textOf(message.content), texts: [], calls: [] });
      continue;
    }
    const current = out.at(-1);
    if (!current) continue;
    if (message.role === "assistant") {
      const text = textOf(message.content).trim();
      if (text) current.texts.push(text);
      for (const part of message.content ?? []) {
        if (part?.type !== "toolCall") continue;
        const call = { id: part.id, tool: part.name, args: part.arguments ?? {}, result: "", isError: false };
        current.calls.push(call);
        byId.set(part.id, call);
      }
    } else if (message.role === "toolResult") {
      const call = byId.get(message.toolCallId);
      if (!call) continue;
      call.result = textOf(message.content);
      call.isError = message.isError === true;
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
        const entry = { skill, by, response: index + 1 };
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
