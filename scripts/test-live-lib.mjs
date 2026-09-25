#!/usr/bin/env node
// Checks for the live harness's grading helpers (scripts/lib/pi-session.mjs,
// scripts/lib/converse.mjs) on synthetic pi session files: the read endpoint,
// the timeout gate, the context measures, and how an attempt ends. These fail
// silently in a live run — a wrong endpoint or gate still gives numbers — so
// they are checked here, with no model.
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisedProbe } from "./lib/converse.mjs";
import { gateTripped, isSeek, responses, sessionMeasures, skillReads } from "./lib/pi-session.mjs";

let problems = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}    ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) problems++;
};

const SKILLS = "/pkg/pi-scientific-skills/skills";
let clock = Date.parse("2026-09-25T00:00:00Z");
let ids = 0;
const stamp = () => new Date((clock += 1000)).toISOString();

const user = (text) => ({ type: "message", timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (calls, usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, extra = {}) => ({
  type: "message",
  timestamp: stamp(),
  message: {
    role: "assistant",
    content: calls.map(([name, args]) => ({ type: "toolCall", id: `c${++ids}`, name, arguments: args })),
    usage,
    stopReason: calls.length ? "toolUse" : "stop",
    ...extra,
  },
});
/** An assistant message with its tool calls, then one result per call. */
const step = (calls, results, usage) => {
  const message = assistant(calls, usage);
  const out = [message];
  message.message.content.forEach((part, index) => {
    const [text, isError = false] = results[index] ?? [""];
    out.push({
      type: "message",
      timestamp: stamp(),
      message: { role: "toolResult", toolCallId: part.id, content: [{ type: "text", text }], isError },
    });
  });
  return out;
};
const turnsOf = (entries) =>
  responses(
    entries.filter((entry) => entry.type === "message").map((entry) => ({ ...entry.message, entryTime: Date.parse(entry.timestamp) })),
  );

console.log("-- read endpoint --");
{
  const entries = [
    user("task"),
    ...step([["read", { path: `${SKILLS}/polars-bio/SKILL.md` }]], [["---\nname: polars-bio\n---"]]),
    ...step([["read", { path: `${SKILLS}/polars/references/api.md` }]], [["api"]]),
    ...step([["read", { path: `${SKILLS}/polars/SKILL.md` }]], [["no such file", true]]),
    ...step([["bash", { command: `cat ${SKILLS}/polars/SKILL.md` }]], [["permission denied"]]),
  ];
  check("a sibling skill, a reference file, a failed read or a bash without the file do not count", skillReads(turnsOf(entries), ["polars"]).length === 0);
  const read = [...entries, ...step([["read", { path: `${SKILLS}/polars/SKILL.md` }]], [["---\nname: polars\n---"]])];
  const hits = skillReads(turnsOf(read), ["polars"]);
  check("a read of <skill>/SKILL.md counts", hits.length === 1 && hits[0].by === "read" && Number.isFinite(hits[0].at));
  const bash = [...entries, ...step([["bash", { command: `head -40 ${SKILLS}/polars/SKILL.md` }]], [["---\nname: polars\ndescription: x\n---"]])];
  check("a bash head of <skill>/SKILL.md with its name line counts", skillReads(turnsOf(bash), ["polars"])[0]?.by === "bash");
}

console.log("-- skill-seeking calls --");
{
  const call = (tool, args, result = "") => ({ tool, args, result });
  check("sci_find seeks", isSeek(call("sci_find", { query: "x" })));
  check("a read of a SKILL.md seeks", isSeek(call("read", { path: `${SKILLS}/dask/SKILL.md` })));
  check("bash listing a skills directory seeks", isSeek(call("bash", { command: "ls /pkg/skills/" })));
  check("bash output naming a skills path seeks", isSeek(call("bash", { command: "find / -name '*.md'" }, `${SKILLS}/dask/SKILL.md`)));
  check(
    "a PATH with a /skills-plugin/ directory does not seek",
    !isSeek(call("bash", { command: "env" }, "PATH=/Users/u/Library/Application Support/Claude/skills-plugin/abc/bin:/usr/bin")),
  );
  check("an ordinary read does not seek", !isSeek(call("read", { path: "/work/data.csv" })));
}

console.log("-- timeout gate --");
{
  const plain = (n) => [user("task"), ...Array.from({ length: n }, () => step([["bash", { command: "ls" }]], [["a.csv"]])).flat()];
  check("9 plain calls: not gated at 10", !gateTripped(turnsOf(plain(9)), 10));
  check("10 plain calls: gated at 10", gateTripped(turnsOf(plain(10)), 10));
  check("gate 0 is off", !gateTripped(turnsOf(plain(30)), 0));
  const late = [...plain(9), ...step([["sci_find", { query: "x" }]], [["## dask"]])];
  check("a seek as call 10 is in time", !gateTripped(turnsOf(late), 10));
  const multi = [...plain(6), user("persona reply"), ...plain(4).slice(1)];
  check("calls count across responses", gateTripped(turnsOf(multi), 10));
}

console.log("-- context measures --");
{
  const entries = [
    user("task"),
    ...step([["bash", { command: "ls" }]], [["x"]], { input: 900, output: 100, cacheRead: 1000, cacheWrite: 0 }),
    { type: "compaction", timestamp: stamp(), tokensBefore: 50000 },
    assistant([], { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, {
      stopReason: "error",
      errorMessage: "request (70000 tokens) exceeds the available context size (65536 tokens), try increasing it",
    }),
  ];
  const m = sessionMeasures(entries);
  check("first prompt = input + cacheRead + cacheWrite", m.firstPromptTokens === 1900, String(m.firstPromptTokens));
  check("peak context adds output", m.peakContext === 2000, String(m.peakContext));
  check("a compaction entry is counted with tokensBefore", m.compactions.length === 1 && m.compactions[0].tokensBefore === 50000);
  check("llama.cpp's overflow error is an overflow, and the session ended on it", m.overflows === 1 && m.endedOnOverflow);
  const recovered = sessionMeasures([...entries, assistant([])]);
  check("an overflow pi recovered from does not end the session", recovered.overflows === 1 && !recovered.endedOnOverflow);
}

console.log("-- attempts end by the right rule --");
{
  const dir = mkdtempSync(join(tmpdir(), "live-lib-"));
  const probe = { id: "polars", task: "task", target: "polars", want: ["polars"] };
  const catalogue = new Set(["polars", "polars-bio", "dask"]);
  /** A fake pi: each response appends the scripted entries to the session file. */
  const attempt = async (script, extra = {}) => {
    let n = 0;
    const file = join(dir, `s${++ids}.jsonl`);
    writeFileSync(file, "");
    const result = await runSupervisedProbe(probe, {
      startAttempt: () => ({ sessionFile: file, finish: () => {} }),
      respond: async (_run, message) => {
        const entries = [user(message), ...(script[n++] ?? [assistant([])])];
        for (const entry of entries) appendFileSync(file, `${JSON.stringify(entry)}\n`);
        return { answered: true, timedOut: false };
      },
      persona: { next: async () => ({ action: "reply", message: "go on" }) },
      catalogue,
      limits: { attempts: 1, responses: 3 },
      log: () => {},
      ...extra,
    });
    return result.attempts[0];
  };
  const listing = step([["sci_find", { query: "dataframe" }]], [["## polars\ndesc\nLoad with: read x"]]);
  const reading = step([["read", { path: `${SKILLS}/polars/SKILL.md` }]], [["---\nname: polars\n---"]]);

  const listed = await attempt([listing], { endpoint: "listed" });
  check("listed endpoint: a listing reaches", listed.endedBy === "reached" && listed.target?.by === "sci_find");
  const notRead = await attempt([listing, [assistant([])], [assistant([])]], { endpoint: "read" });
  check(
    "read endpoint: a listing alone does not reach, but is recorded",
    notRead.endedBy === "max-responses" && !notRead.target && notRead.listed?.by === "sci_find" && Number.isFinite(notRead.listedSeconds),
  );
  const read = await attempt([[...listing, ...reading]], { endpoint: "read" });
  check(
    "read endpoint: reading SKILL.md reaches, with its time",
    read.endedBy === "reached" && read.target?.by === "read" && read.endpointSeconds >= read.listedSeconds,
  );
  const plain = Array.from({ length: 10 }, () => step([["bash", { command: "ls" }]], [["a"]])).flat();
  const gated = await attempt([plain], { endpoint: "read", gateCalls: 10 });
  check("ten plain calls end the attempt as gated", gated.endedBy === "gated" && gated.toolCalls === 10 && gated.firstSeekCall === null);
  const overflow = await attempt(
    [[assistant([], undefined, { stopReason: "error", errorMessage: "exceeds the available context size" })]],
    { endpoint: "read", gateCalls: 10 },
  );
  check("a response that ends on an overflow ends the attempt as overflow", overflow.endedBy === "overflow");
  const dead = await runSupervisedProbe(probe, {
    startAttempt: () => {
      const file = join(dir, `s${++ids}.jsonl`);
      writeFileSync(file, [user("task"), assistant([], undefined, { stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED" })].map((e) => JSON.stringify(e)).join("\n") + "\n");
      return { sessionFile: file, finish: () => {} };
    },
    respond: async () => ({ answered: true, timedOut: false }),
    persona: { next: async () => ({ action: "reply", message: "go on" }) },
    catalogue,
    limits: { attempts: 1, responses: 3 },
    log: () => {},
    endpoint: "read",
  });
  check("a response that ends on another provider error is a harness error, not a grade", dead.outcome === "no-run" && /ECONNREFUSED/.test(dead.detail));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${problems === 0 ? "PASS" : "FAIL"} — ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
