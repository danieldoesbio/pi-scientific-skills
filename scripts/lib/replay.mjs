// The choice-turn replay (testing/runs/2026-09-27-find-compact-replay.md):
// pure helpers over pi session files. scripts/find-live-replay.mjs runs the
// replay; scripts/lib/replay-worker.mjs runs one turn.
//
// The choice turn is the model response that follows the first sci_find
// call of an attempt: the moment the model picks a skill from the results.

const LOAD = "Load with: read ";
const REFERENCES = "References inside it are relative to ";

/**
 * A recorded sci_find result. `hits` for a list of query hits in the full
 * format ({name, path, dir} in rank order), `other` for a profile listing,
 * the profile index or a no-match, `malformed` for a hit list this parser
 * cannot read.
 */
export function parseHits(text) {
  if (!text.startsWith("## ")) return { kind: "other" };
  const hits = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const name = /^## (\S+)/.exec(lines[0])?.[1];
    const load = lines[2]?.startsWith(LOAD) ? lines[2].slice(LOAD.length) : null;
    const dir = lines[3]?.startsWith(REFERENCES) ? lines[3].slice(REFERENCES.length) : null;
    if (lines.length !== 4 || !name || !load || !dir) return { kind: "malformed" };
    hits.push({ name, path: load, dir });
  }
  return { kind: "hits", hits };
}

/** Skill names in a sci_find hit list of either format, in rank order (its `## ` headings). */
export const listedNames = (text) =>
  text
    .split("\n\n")
    .map((block) => /^## (\S+)/.exec(block)?.[1])
    .filter(Boolean);

/** The text of a tool result or message: its text parts, joined. */
export const textOf = (message) =>
  (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

const toolCallsOf = (message) => (message?.content ?? []).filter((part) => part.type === "toolCall");

/**
 * The first sci_find turn of a session. `entries`: the session file's lines,
 * parsed. Returns null when no response called sci_find. Otherwise:
 * `call` (the assistant entry), `results` (its tool-result entries), `cut`
 * (the index in `entries` of the last of them), `choice` (the recorded next
 * assistant entry, or null) and `argsById` (tool-call id → arguments).
 */
export function choiceTurn(entries) {
  const isMessage = (entry, role) => entry.type === "message" && entry.message?.role === role;
  const start = entries.findIndex(
    (entry) => isMessage(entry, "assistant") && toolCallsOf(entry.message).some((call) => call.name === "sci_find"),
  );
  if (start < 0) return null;
  const results = [];
  let cut = start;
  for (let i = start + 1; i < entries.length; i++) {
    if (isMessage(entries[i], "toolResult")) {
      results.push(entries[i]);
      cut = i;
    } else if (entries[i].type === "message") break;
  }
  const choice = entries.slice(cut + 1).find((entry) => isMessage(entry, "assistant")) ?? null;
  const argsById = new Map(toolCallsOf(entries[start].message).map((call) => [call.id, call.arguments ?? {}]));
  return { call: entries[start], results, cut, choice, argsById };
}

/**
 * The session up to and including entry `cut`, with the text of the tool
 * results named in `replacements` (entry id → new text) swapped. The input is
 * not changed.
 */
export function truncateAndReplace(entries, cut, replacements) {
  return entries.slice(0, cut + 1).map((entry) =>
    replacements.has(entry.id)
      ? { ...entry, message: { ...entry.message, content: [{ type: "text", text: replacements.get(entry.id) }] } }
      : entry,
  );
}

/** Skill names a tool call reads: a `read` of …/<name>/SKILL.md, or a bash command naming <name>/SKILL.md. */
export function skillsRead(call) {
  const args = call.arguments ?? {};
  if (call.name === "read") {
    const name = /\/([^/\s]+)\/SKILL\.md$/.exec(String(args.path ?? ""))?.[1];
    return name ? [name] : [];
  }
  if (call.name === "bash") {
    return [...String(args.command ?? "").matchAll(/([A-Za-z0-9_.-]+)\/SKILL\.md/g)].map((match) => match[1]);
  }
  return [];
}

/**
 * What a choice turn did. `target`: it reads the target's SKILL.md (alone or
 * with others). `other-skill`: it reads only other skills. `search`: it calls
 * sci_find again and reads nothing. `other-call`: other tool calls only.
 * `no-call`: no tool call.
 */
export function classifyChoice(message, target) {
  const calls = toolCallsOf(message);
  const reads = [...new Set(calls.flatMap(skillsRead))];
  const outcome = reads.includes(target)
    ? "target"
    : reads.length > 0
      ? "other-skill"
      : calls.some((call) => call.name === "sci_find")
        ? "search"
        : calls.length > 0
          ? "other-call"
          : "no-call";
  return { outcome, reads, calls: calls.map((call) => call.name) };
}

/** Prompt tokens of one request as pi records them: processed + cached. */
export const promptTokens = (usage) => (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);

/**
 * The analysis set of a replay (scripts/find-live-replay-report.mjs) from the
 * lines of results.jsonl; the last line per probe and variant wins, so a
 * --resume re-run replaces an error. `treatment` is the variant compared with
 * `full` ("compact" or "bm25f"). A probe is in `ids` when both variants
 * are `ok`, the full replay has prompt-token parity with the recorded
 * request, and both variants saw the same system prompt and tools. The
 * system prompt holds the recorded working directory, so its hash is
 * compared within a probe, never across probes.
 */
export function replayAnalysisSet(lines, treatment = "compact") {
  const last = new Map(lines.map((line) => [`${line.probe}/${line.variant}`, line]));
  const set = { ids: [], pairs: new Map(), excluded: [], errors: [], parityFailures: [], hashMismatches: [] };
  for (const line of last.values()) {
    if (line.variant !== null) continue;
    (line.status === "error" ? set.errors : set.excluded).push(`${line.probe}: ${line.reason}`);
  }
  for (const probe of [...new Set(lines.filter((line) => line.variant !== null).map((line) => line.probe))]) {
    const full = last.get(`${probe}/full`);
    const other = last.get(`${probe}/${treatment}`);
    if (full?.status !== "ok" || other?.status !== "ok") set.errors.push(`${probe}: ${full?.reason ?? other?.reason ?? "a variant did not run"}`);
    else if (full.parity !== true) set.parityFailures.push(probe);
    else if (full.systemPromptHash !== other.systemPromptHash || full.toolsHash !== other.toolsHash) set.hashMismatches.push(probe);
    else {
      set.ids.push(probe);
      set.pairs.set(probe, { full, [treatment]: other });
    }
  }
  return set;
}

/** Fixed before the first replay (testing/runs/2026-09-27-find-compact-replay.md). */
export const REPLAY_RULES = { margin: -0.05, validitySlack: 5, maxPromptFailures: 5 };

/** Above the margin, non-inferior; wholly below 0, inferior; otherwise inconclusive. */
export const verdictOf = (low, high, margin) => (low > margin ? "non-inferior" : high < 0 ? "inferior" : "inconclusive");

/**
 * The two validity rules of a replay on its analysis set: the full replay reads
 * the target at least as often as the recorded run minus the slack, and parity
 * failures plus hash mismatches stay within the limit.
 */
export function replayValidity(set, rules = REPLAY_RULES) {
  const recordedHits = set.ids.filter((id) => set.pairs.get(id).full.recorded.outcome === "target").length;
  const fullHits = set.ids.filter((id) => set.pairs.get(id).full.outcome === "target").length;
  const promptFailures = set.parityFailures.length + set.hashMismatches.length;
  const rule1 = fullHits >= recordedHits - rules.validitySlack;
  const rule2 = promptFailures <= rules.maxPromptFailures;
  return { recordedHits, fullHits, promptFailures, rule1, rule2, faithful: rule1 && rule2 };
}
