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
import { joinRequests, parseDriverLog, parseServerLog, stampMs } from "./lib/server-log.mjs";

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

console.log("-- server log join (find-live-timing) --");
{
  const timing = (task, kind, ms, tokens) =>
    `I slot print_timing: id  0 | task ${task} | ${kind === "prompt" ? "prompt eval time" : "       eval time"} = ${ms} ms / ${tokens} tokens (x)`;
  const log = [
    "0.00.100.000 I main: server is listening on http://127.0.0.1:8090",
    "0.10.000.000 I slot launch_slot_: id  0 | task 0 | processing task, is_child = 0",
    `0.19.000.000 ${timing(0, "prompt", "9000.00", 1000)}`,
    `0.20.000.000 ${timing(0, "eval", "1000.00", 20)}`,
    "0.20.000.000 I slot      release: id  0 | task 0 | stop processing: n_tokens = 1020, truncated = 0",
    "0.20.100.000 I slot launch_slot_: id  0 | task 5 | processing task, is_child = 0",
    "0.21.000.000 W srv          stop: cancel task, id_task = 5",
    "0.32.000.000 I slot      release: id  0 | task 5 | stop processing: n_tokens = 3000, truncated = 0",
    "0.32.000.000 I slot launch_slot_: id  0 | task 7 | processing task, is_child = 0",
    `0.36.000.000 ${timing(7, "prompt", "3500.00", 400)}`,
    `0.40.000.000 ${timing(7, "eval", "4000.00", 30)}`,
    "0.40.000.000 I slot      release: id  0 | task 7 | stop processing: n_tokens = 1430, truncated = 0",
    "61.05.000.000 I slot launch_slot_: id  0 | task 9 | processing task, is_child = 0",
    "0.01.000.000 I slot launch_slot_: id  0 | task 0 | processing task, is_child = 0",
  ].join("\n");
  check("a stamp past 60 minutes keeps counting minutes", stampMs("61.05.000.000 I x") === 3665000);
  const runs = parseServerLog(log);
  const cancelled = runs[0]?.find((r) => r.task === 5);
  const finished = runs[0]?.find((r) => r.task === 7);
  check("a stamp that goes back starts a new server run", runs.length === 2 && runs[0].length === 4 && runs[1].length === 1);
  check("a cancelled request keeps its cancel and release times", cancelled?.cancel === 21000 && cancelled?.release === 32000 && cancelled?.promptMs === undefined);
  check("a finished request has prompt, generation and context", finished?.promptTokens === 400 && finished?.genTokens === 30 && finished?.context === 1430);
  check("a request right after a cancelled one is marked", finished?.afterCancel === true && cancelled?.afterCancel === false);

  const t0 = Date.parse("2026-09-25T15:50:22Z");
  const message = (start, end, input, output) => ({ start: t0 + start, end: t0 + end, input, output });
  // pi writes each message 50 ms after the release; the driver's clock reads 1.5 s early.
  const first = message(10000, 20050, 1000, 20);
  const second = message(21000, 40050, 400, 30);
  const decoy = message(400000, 400050, 400, 30);
  const { pairs, offsets } = joinRequests(runs, [t0 - 1500], [first, second, decoy]);
  const queued = pairs.find((pair) => pair.message === second);
  check("requests pair with the messages whose tokens and time match", pairs.length === 2 && !pairs.some((pair) => pair.message === decoy));
  check("the clock offset is refit from the pairs", offsets[0] === t0 + 50, String(offsets[0] - t0));
  check("queue wait = server launch minus pi's request start", queued?.queueMs === 11050, String(queued?.queueMs));

  const driver = parseDriverLog(
    [
      "[2026-09-25 08:50:22] starting server: start.sh",
      "[2026-09-25 08:50:24] START chunk-01 v16 a,b",
      "[2026-09-25 08:56:21] END   chunk-01 v16 rc=0 lines=+10 5 min",
      "[2026-09-25 08:56:21] START chunk-01 v17 a,b",
      "[2026-09-25 09:00:00] interrupted",
    ].join("\n"),
  );
  check(
    "driver log: server starts and arm windows, an interrupt closes the open one",
    driver.starts.length === 1 && driver.windows.length === 2 && driver.windows[1].arm === "v17" && driver.windows[1].end !== null,
  );
}

console.log(`\n${problems === 0 ? "PASS" : "FAIL"} — ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
