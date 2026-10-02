// Is a failed probe a test of search at all?
//
// A probe asks whether the model finds a skill it needs. When the persona
// ended an attempt satisfied before any wanted skill reached the model, the
// model may not have needed one: then that miss says nothing about search —
// whether the probe ends as a fail or is reached in a later attempt — and the
// probe goes back for a rewrite instead of counting against the model.
//
// The persona cannot tell the two apart — it is blind and accepts a plausible
// answer — so a judge that sees the target does. For each such attempt it
// answers two questions:
//   (a) did the first request go unserved, when the target could have served
//       it here? This catches drift the model caused.
//   (b) would the target have materially improved the answer the model gave?
// A yes must name the concrete gap the target fills; an unnamed benefit is a
// no. The probe is `invalid` only when every judged attempt is no on both.
// The raw grade stays on the line; the summary leaves invalid probes out of
// the grades and lists them for rewrite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hitNames, readMessages, readSkills, responses } from "./pi-session.mjs";
import { callClaude, retrying, SupervisorError } from "./supervisor.mjs";

const SYSTEM_PROMPT = `You audit one test of an AI coding assistant. The assistant has a library of installed "skills": documentation packages it can search for and read. The test gives it a scientist's request and checks whether it finds one skill, the target. The request never names the target.

In the conversation below, the target never reached the assistant, and a simulated scientist ended the conversation satisfied. Decide which it is: the test is invalid (the assistant could answer the request well without the target), or the assistant missed a skill it needed.

Setting: the assistant ran in an empty sandbox with no network. There are no files except the ones it wrote. The simulated scientist cannot see the skills and accepts any plausible answer, so the scientist's satisfaction is not evidence of quality. When the scientist mentions a file, recording or dataset that does not exist, the scientist says it is not available and asks for a method or an example.

Answer two questions:
(a) original: did the scientist's first request go unserved (the conversation moved to a different or smaller request, or the final answer does not do what was first asked), while the target, as its SKILL.md describes it, could have served that first request in this setting? Being on topic is not enough.
(b) improves: would using the target have materially improved the final answer the assistant gave? Materially means more correct, more complete, or able to do something the answer cannot. An answer that already does what the target would do is not improved by it.

For a yes, name in "missing" the concrete thing that the answer lacks and the target provides. A SKILL.md is written to promote its skill, so a general benefit ("more robust", "best practices", "better structured") does not count. If you cannot name a concrete gap, answer no.

Output only one line of compact JSON, nothing else:
{"original":true|false,"improves":true|false,"missing":"<the concrete gap, or empty>","reason":"<one sentence>"}`;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[…${text.length - max} characters cut]` : text);

/**
 * Attempts that make a probe suspect, whatever its final grade: the persona
 * was satisfied and no skill in `want` had reached the model. An attempt that
 * reached an accepted skill is not one — the model did use the library.
 */
export function candidateAttempts(result) {
  if (result.outcome !== "graded") return [];
  return result.attempts.filter((attempt) => attempt.endedBy === "persona-end" && !attempt.want);
}

/** One tool call as a line: sci_find with its query and top hits, a skill read by name, the rest by tool name. */
function describeCall(call) {
  if (call.tool === "sci_find") {
    const query = call.args?.query ?? (call.args?.profile ? `profile:${call.args.profile}` : "");
    return `sci_find "${query}" → ${hitNames(call.result).slice(0, 5).join(", ") || "no hits"}`;
  }
  return call.tool;
}

/**
 * An attempt as its session file records it: each user message, the
 * assistant's visible text, and a summary of its tool use. Null when the
 * session file is missing or empty.
 */
export function conversationText(sessionFile) {
  const turns = responses(readMessages(sessionFile));
  if (turns.length === 0) return null;
  const lines = [];
  for (const [index, turn] of turns.entries()) {
    const counts = new Map();
    for (const line of turn.calls.map(describeCall)) counts.set(line, (counts.get(line) ?? 0) + 1);
    const read = readSkills([turn]);
    lines.push(
      `Scientist, message ${index + 1}:`,
      turn.prompt,
      "",
      `Assistant tool use: ${[...counts].map(([line, n]) => (n > 1 ? `${line} ×${n}` : line)).join("; ") || "none"}`,
      ...(read.length > 0 ? [`Skills it read: ${read.join(", ")}`] : []),
      `Assistant, response ${index + 1}:`,
      clip(turn.texts.join("\n\n") || "(no text)", 6000),
      "",
    );
  }
  return lines.join("\n");
}

/** Parse the judge's JSON line. A yes with no named gap counts as a no. */
export function parseVerdict(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new SupervisorError(`no JSON in judge output: ${text.slice(0, 200)}`);
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SupervisorError(`judge output is not JSON: ${json.slice(0, 200)}`);
  }
  if (typeof raw.original !== "boolean" || typeof raw.improves !== "boolean") {
    throw new SupervisorError(`judge output lacks original/improves: ${json.slice(0, 200)}`);
  }
  const missing = String(raw.missing ?? "").trim().slice(0, 500);
  return {
    original: raw.original,
    improves: raw.improves,
    missing,
    needed: (raw.original || raw.improves) && missing !== "",
    reason: String(raw.reason ?? "").trim().slice(0, 500),
  };
}

/**
 * @param {{ model: string, effort?: string, cwd: string, timeoutMs?: number, delays?: number[] }} options
 *   `cwd` must be outside the repo, so no project settings or CLAUDE.md apply.
 */
export function createJudge({ model, effort = "high", cwd, timeoutMs = 300_000, delays = [15_000, 60_000] }) {
  const options = { model, effort, cwd, timeoutMs, systemPrompt: SYSTEM_PROMPT };
  return {
    model,
    async need({ target, skillText, task, conversation }) {
      const prompt = [
        `Target skill: ${target}`,
        "<SKILL.md>",
        clip(skillText, 20000),
        "</SKILL.md>",
        "",
        "The scientist's first request:",
        task,
        "",
        "The conversation (visible text; tool use summarized):",
        conversation,
        "Output only the JSON line.",
      ].join("\n");
      return retrying(delays, async () => parseVerdict(await callClaude(options, prompt)));
    },
  };
}

/**
 * The check for one graded result, or undefined when no attempt qualifies.
 * Reads `<transcriptsDir>/<id>/<label>.session.jsonl`, the copy the live test
 * keeps of every attempt, so it runs the same during a run and afterwards.
 * A judge failure returns `error` and leaves the grade as it is.
 */
export async function checkProbe(probe, result, { judge, transcriptsDir, skillsDir }) {
  const candidates = candidateAttempts(result);
  if (candidates.length === 0) return undefined;
  const verdicts = [];
  try {
    const skillText = readFileSync(join(skillsDir, probe.target, "SKILL.md"), "utf8");
    for (const attempt of candidates) {
      const conversation = conversationText(join(transcriptsDir, probe.id, `${attempt.label}.session.jsonl`));
      if (!conversation) throw new SupervisorError(`no session recorded for ${attempt.label}`);
      const verdict = await judge.need({ target: probe.target, skillText, task: probe.task, conversation });
      verdicts.push({ label: attempt.label, ...verdict });
    }
  } catch (error) {
    if (!(error instanceof SupervisorError) && error?.code !== "ENOENT") throw error;
    return { judge: judge.model, verdicts, error: error.message };
  }
  return { judge: judge.model, verdicts, invalid: verdicts.every((verdict) => !verdict.needed) };
}
