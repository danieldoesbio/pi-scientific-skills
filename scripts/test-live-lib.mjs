#!/usr/bin/env node
// Checks for the live harness's grading helpers (scripts/lib/pi-session.mjs,
// scripts/lib/converse.mjs) on synthetic pi session files: the read endpoint,
// the timeout gate, the context measures, and how an attempt ends. Also the
// server log join (scripts/lib/server-log.mjs), the report's paired
// statistics and analysis set (scripts/lib/arms-report.mjs), and the
// choice-turn replay helpers (scripts/lib/replay.mjs). These fail silently in
// a live run — a wrong endpoint or gate still gives numbers — so they are
// checked here, with no model.
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisedProbe } from "./lib/converse.mjs";
import { gateTripped, isSeek, responses, sessionMeasures, skillReads } from "./lib/pi-session.mjs";
import { joinRequests, parseDriverLog, parseServerLog, stampMs } from "./lib/server-log.mjs";
import { Z95, analysisSet, clusterBootstrapDiff, mcnemarExact, newcombePaired, pairCounts, seededRandom, wilson } from "./lib/arms-report.mjs";
import { choiceTurn, classifyChoice, listedNames, parseHits, promptTokens, replayAnalysisSet, replayValidity, textOf, truncateAndReplace, verdictOf } from "./lib/replay.mjs";
import { pooledReport } from "./find-live-replay-pooled.mjs";
import { category, paired, panelReport } from "./find-panel-report.mjs";
import { firstFindFacts, firstPromptOf } from "./find-ab-report.mjs";

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
  const first = await attempt([[...step([["bash", { command: "ls" }]], [["a"]]), ...listing, ...reading]], { endpoint: "first-find", gateCalls: 10 });
  check(
    "first-find: the first sci_find ends the attempt as searched, with its query, and reaches nothing",
    first.endedBy === "searched" && first.queries[0] === "dataframe" && !first.target && first.firstSeekCall === 1,
  );
  const late = await attempt([[assistant([])], listing], { endpoint: "first-find", gateCalls: 10 });
  check("first-find: a search after a persona reply is recorded in response 2", late.endedBy === "searched" && late.firstFindResponse === 2);
  const pair = step([["sci_find", { query: "a" }], ["sci_find", { query: "b", limit: 3 }]], [["## dask\nd\nLoad with: read x"], ["## dask\nd\nLoad with: read x"]]);
  const follow = step([["sci_find", { query: "c" }]], [["## polars\nd\nLoad with: read x"]]);
  const both = await attempt([[...pair, ...follow]], { endpoint: "first-find", gateCalls: 10 });
  check(
    "first-find: firstFind holds the calls of the first sci_find message only, not a later one",
    both.firstFind?.calls.map((call) => call.query).join() === "a,b" && both.firstFind.calls[1].limit === 3 && both.queries.join() === "a,b,c",
    JSON.stringify(both.firstFind),
  );
  const never = await attempt([plain], { endpoint: "first-find", gateCalls: 10 });
  check("first-find: no search before the gate ends as gated", never.endedBy === "gated" && never.sciFindCalls === 0);
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

console.log("-- paired statistics and analysis set (find-live-arms-report) --");
{
  const near = (x, y, tolerance = 5e-4) => Math.abs(x - y) < tolerance;
  // Closed form: the Wilson lower bound for n of n is n / (n + z²).
  const allTen = 10 / (10 + Z95 * Z95);
  check("Wilson: 10 of 10 has lower bound n / (n + z²) and upper bound 1", near(wilson(10, 10)[0], allTen, 1e-12) && near(wilson(10, 10)[1], 1, 1e-12));
  const [low, high] = newcombePaired(10, 0, 0, 0);
  check("Newcombe: no discordant pairs at 10 of 10 gives ±(1 − the Wilson lower bound)", near(low, -(1 - allTen), 1e-12) && near(high, 1 - allTen, 1e-12));
  // Hand-computed on 2026-09-26: p1 − l1 = 0.04917, u2 − p2 = 0.07535, φ = 0.19214, δ = 0.08168.
  const [handLow] = newcombePaired(69, 20, 0, 1);
  check("Newcombe: a 69, b 20, c 0, d 1 gives the hand-computed lower bound 0.1405", near(handLow, 0.1405), String(handLow));
  const forward = newcombePaired(40, 7, 3, 10);
  const backward = newcombePaired(40, 3, 7, 10);
  check("Newcombe: swapping the arms negates the interval", near(forward[0], -backward[1], 1e-12) && near(forward[1], -backward[0], 1e-12));
  check("McNemar exact: 20:0 gives 2 × 0.5^20, 2:0 gives 0.5, 5:5 and 0:0 give 1", near(mcnemarExact(20, 0), 2 * 0.5 ** 20, 1e-15) && mcnemarExact(2, 0) === 0.5 && mcnemarExact(5, 5) === 1 && mcnemarExact(0, 0) === 1);
  check("McNemar exact: 9:1 gives 2 × 11 / 1024", near(mcnemarExact(9, 1), 22 / 1024, 1e-15) && mcnemarExact(1, 9) === mcnemarExact(9, 1));
  const counts = pairCounts(["p", "q", "r", "s"], (id) => "pq".includes(id), (id) => "pr".includes(id));
  check("pair counts: both, first only, second only, neither", counts.a === 1 && counts.b === 1 && counts.c === 1 && counts.d === 1, JSON.stringify(counts));

  const order = ["1\ta", "1\tb", "2\tc", "2\td", "3\te"].map((line) => ({ chunk: Number(line[0]), id: line.slice(2) }));
  const graded = (ids, extra = {}) => new Map(ids.map((id) => [id, { id, outcome: "graded", ...(extra[id] ?? {}) }]));
  const set = analysisSet(order, [graded(["a", "b", "c", "d", "e"]), graded(["a", "b", "c", "e"], { b: { outcome: "no-run" } })]);
  check("analysis set: a chunk missing a line in any arm is left out, even when its other probes are paired", set.complete.join() === "1,3" && set.incomplete.join() === "2" && !set.ids.includes("c"), JSON.stringify(set));
  check("analysis set: a harness error in any arm drops the probe from all arms", set.harnessErrors.join() === "b" && set.ids.join() === "a,e", JSON.stringify(set));
}

console.log("-- choice-turn replay (find-live-replay) --");
{
  const hit = (name, description = `${name} does things. More text.`) =>
    [`## ${name}`, description, `Load with: read ${SKILLS}/${name}/SKILL.md`, `References inside it are relative to ${SKILLS}/${name}`].join("\n");
  const parsed = parseHits([hit("polars"), hit("dask")].join("\n\n"));
  check("parseHits: a full-format hit list gives names, paths and folders in rank order", parsed.kind === "hits" && parsed.hits.map((h) => h.name).join() === "polars,dask" && parsed.hits[1].path === `${SKILLS}/dask/SKILL.md` && parsed.hits[1].dir === `${SKILLS}/dask`, JSON.stringify(parsed));
  const caveat = parseHits(hit("pi-agent").replace("## pi-agent", "## pi-agent (not in any profile)"));
  check("parseHits: a heading with a caveat after the name still parses", caveat.kind === "hits" && caveat.hits[0].name === "pi-agent", JSON.stringify(caveat));
  check("parseHits: a profile listing or a no-match is `other`", parseHits("Profile core: 10 skills").kind === "other" && parseHits("No skills match").kind === "other");
  const threeLines = hit("dask").split("\n").slice(0, 3).join("\n");
  check("parseHits: a block without the 4 full-format lines is `malformed`", parseHits(`${hit("polars")}\n\n${threeLines}`).kind === "malformed" && parseHits(hit("polars", "one\ntwo")).kind === "malformed");

  const entries = [
    user("task"),
    ...step([["bash", { command: "ls" }]], [["files"]]),
    ...step([["sci_find", { query: "dataframes", limit: 4 }], ["sci_find", { query: "polars" }]], [[hit("polars")], [hit("dask")]]),
    user("steer"),
    ...step([["read", { path: `${SKILLS}/polars/SKILL.md` }]], [["body"]]),
  ].map((entry, index) => ({ ...entry, id: `e${index}` }));
  const turn = choiceTurn(entries);
  check("choiceTurn: the first sci_find response, both of its results, and the next assistant message", turn.call === entries[3] && turn.results.length === 2 && turn.cut === 5 && turn.choice === entries[7], JSON.stringify({ cut: turn?.cut, results: turn?.results.length }));
  check("choiceTurn: arguments by tool-call id; null when no response calls sci_find", [...turn.argsById.values()][0].limit === 4 && choiceTurn(entries.slice(0, 3)) === null);

  const before = JSON.stringify(entries);
  const cut = truncateAndReplace(entries, turn.cut, new Map([["e4", "short"]]));
  check("truncateAndReplace: keeps entries up to the cut and swaps only the named result text", cut.length === 6 && textOf(cut[4].message) === "short" && textOf(cut[5].message) === hit("dask") && cut[4].message.toolCallId === entries[4].message.toolCallId);
  check("truncateAndReplace: the input entries are not changed", JSON.stringify(entries) === before && textOf(entries[4].message) === hit("polars"));

  const choose = (...calls) => assistant(calls).message;
  const outcome = (message) => classifyChoice(message, "polars").outcome;
  check("classifyChoice: a read of the target's SKILL.md is `target`, also next to another read", outcome(choose(["read", { path: `${SKILLS}/polars/SKILL.md` }])) === "target" && outcome(choose(["read", { path: `${SKILLS}/dask/SKILL.md` }], ["read", { path: `${SKILLS}/polars/SKILL.md` }])) === "target");
  check("classifyChoice: a bash command that names <target>/SKILL.md is `target`", outcome(choose(["bash", { command: `cat ${SKILLS}/polars/SKILL.md | head` }])) === "target");
  check("classifyChoice: a read of another skill only is `other-skill`; a reference file is not a skill read", outcome(choose(["read", { path: `${SKILLS}/dask/SKILL.md` }])) === "other-skill" && outcome(choose(["read", { path: `${SKILLS}/polars/references/api.md` }])) === "other-call");
  check("classifyChoice: a new sci_find is `search`; no tool call is `no-call`", outcome(choose(["sci_find", { query: "x" }])) === "search" && outcome(choose()) === "no-call");
  check("promptTokens: input + cacheRead + cacheWrite", promptTokens({ input: 1721, output: 9, cacheRead: 2086, cacheWrite: 0 }) === 3807);
  check("listedNames: headings of either format in rank order", listedNames(`${hit("polars")}\n\nMore matches.\n\n## dask\nShort.\nLoad with: read x`).join() === "polars,dask");
  const facts = firstFindFacts(entries, "dask");
  check("find-ab firstFindFacts: hits and characters over all first results, target listed; no choice turn when the user speaks before the next answer", facts.hits === 2 && facts.chars === hit("polars").length + hit("dask").length && facts.targetListed && facts.choiceTokens === null, JSON.stringify(facts));
  check("find-ab firstFindFacts: a target not in the results is not listed; null without a sci_find", !firstFindFacts(entries, "pandas").targetListed && firstFindFacts(entries.slice(0, 3), "dask") === null);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const failed = () => assistant([], zero, { stopReason: "error", errorMessage: "429: rate-limited upstream" });
  const retried = [
    user("task"),
    failed(),
    ...step([["sci_find", { query: "dataframes" }]], [[hit("polars")]]),
    failed(),
    assistant([["read", { path: `${SKILLS}/polars/SKILL.md` }]], { input: 300, output: 10, cacheRead: 0, cacheWrite: 0 }),
  ];
  check("find-ab: a provider error (zero usage) before the first request or the choice turn is skipped", firstPromptOf(retried) === 100 && firstFindFacts(retried, "polars").choiceTokens === 300, JSON.stringify({ first: firstPromptOf(retried), choice: firstFindFacts(retried, "polars").choiceTokens }));
  const endedOnError = [...retried.slice(0, 5), user("steer"), retried[5]];
  check("find-ab: no choice turn when the response ends on an error and the user speaks next", firstFindFacts(endedOnError, "polars").choiceTokens === null);

  const row = (probe, variant, extra = {}) => ({ probe, variant, status: "ok", parity: variant === "full" ? true : null, systemPromptHash: `s-${probe}`, toolsHash: "t", ...extra });
  const set = replayAnalysisSet([
    row("a", "full"), row("a", "compact"),
    row("b", "full"), row("b", "compact", { status: "error", reason: "timeout" }), row("b", "compact"),
    row("c", "full", { parity: false }), row("c", "compact"),
    row("d", "full"), row("d", "compact", { systemPromptHash: "s-other" }),
    row("e", "full"), row("e", "compact", { status: "error", reason: "timeout" }),
    { probe: "f", variant: null, status: "excluded", reason: "no sci_find call" },
  ]);
  check("replay analysis set: system prompt hashes differ across probes, compared within a probe only", set.ids.join() === "a,b" && set.hashMismatches.join() === "d", JSON.stringify({ ids: set.ids, mismatch: set.hashMismatches }));
  check("replay analysis set: the last line wins; parity failures, errors and exclusions leave the set", set.parityFailures.join() === "c" && set.errors.join() === "e: timeout" && set.excluded.join() === "f: no sci_find call", JSON.stringify(set));
  const ranked = replayAnalysisSet([row("a", "full"), row("a", "bm25f"), row("a", "compact", { status: "error", reason: "x" }), row("b", "full"), row("b", "compact")], "bm25f");
  check("replay analysis set: the treatment variant is paired with full, other variants are ignored", ranked.ids.join() === "a" && ranked.pairs.get("a").bm25f?.variant === "bm25f" && ranked.errors.join() === "b: a variant did not run", JSON.stringify({ ids: ranked.ids, errors: ranked.errors }));

  check("verdictOf: above the margin, wholly below 0, otherwise", verdictOf(-0.04, 0.01, -0.05) === "non-inferior" && verdictOf(-0.08, -0.01, -0.05) === "inferior" && verdictOf(-0.06, 0.01, -0.05) === "inconclusive");
  const outcomes = (probe, full, compact, recorded = "target") => [
    row(probe, "full", { outcome: full, recorded: { outcome: recorded } }),
    row(probe, "compact", { outcome: compact }),
  ];
  const probes = (n, full, compact, recorded) => Array.from({ length: n }, (_, i) => outcomes(`p${i}`, full, compact, recorded)).flat();
  const valid = replayValidity(replayAnalysisSet([...probes(10, "target", "target"), ...probes(0)]));
  const slack = replayValidity(replayAnalysisSet([...outcomes("a", "search", "target"), ...outcomes("b", "search", "target"), ...Array.from({ length: 8 }, (_, i) => outcomes(`k${i}`, "target", "target")).flat()]), { margin: -0.05, validitySlack: 1, maxPromptFailures: 5 });
  check("replay validity: faithful at full = recorded; rule 1 fails when full falls more than the slack below recorded", valid.faithful && valid.fullHits === 10 && !slack.rule1 && slack.rule2 && !slack.faithful, JSON.stringify(slack));

  const first = seededRandom(7);
  const again = seededRandom(7);
  const draws = Array.from({ length: 5 }, () => first());
  check("seededRandom: the same seed gives the same draws, all in [0, 1)", draws.every((x) => x === again() && x >= 0 && x < 1));
  const same = clusterBootstrapDiff(Array.from({ length: 20 }, () => [[true, true], [false, false]]), { resamples: 200, seed: 3 });
  const half = clusterBootstrapDiff(Array.from({ length: 20 }, () => [[false, true], [true, true]]), { resamples: 200, seed: 3 });
  check("cluster bootstrap: no discordant pairs gives [0, 0]; identical clusters give their own mean", same[0] === 0 && same[1] === 0 && half[0] === -0.5 && half[1] === -0.5, JSON.stringify({ same, half }));
  const mixed = Array.from({ length: 30 }, (_, i) => [[i % 7 !== 0, true], [i % 5 !== 0, i % 11 !== 0]]);
  const swapped = mixed.map((pairs) => pairs.map(([x, y]) => [y, x]));
  const [low, high] = clusterBootstrapDiff(mixed, { resamples: 500, seed: 9 });
  const [swapLow, swapHigh] = clusterBootstrapDiff(swapped, { resamples: 500, seed: 9 });
  check("cluster bootstrap: swapping the arms negates the interval (same seed)", Math.abs(low + swapHigh) < 1e-12 && Math.abs(high + swapLow) < 1e-12 && low < high);

  const faithful = replayAnalysisSet([...probes(158, "target", "target")]);
  const small = replayAnalysisSet([...probes(20, "target", "target")]);
  const broken = replayAnalysisSet([...probes(20, "search", "target")]);
  check("pooled report: no comparison when either sample is not faithful", /not faithful: no comparison/i.test(pooledReport([faithful, broken])) && !/Pooled:/.test(pooledReport([faithful, broken])));
  check("pooled report: 158 probes with no discordant pair are non-inferior by both intervals", /Newcombe method 10: .*non-inferior/.test(pooledReport([faithful, faithful])) && /margin -5.0: non-inferior\n/.test(pooledReport([faithful, faithful])));
  check("pooled report: when the intervals disagree (20 probes: Newcombe wide, bootstrap [0, 0]) the verdict is inconclusive", /margin -5.0: inconclusive \(the two intervals disagree\)/.test(pooledReport([small, small])));

  const found = (id, calls, extra = {}) => ({ id, target: "t", task: "raw", outcome: "graded", attempts: [{ endedBy: "searched", firstFind: { message: 0, calls }, ...extra }] });
  const q = (query) => ({ query, profile: null, limit: null });
  check(
    "panel category: a profile-only first call with a later query is searched; gated, sought and harness errors apart",
    category(found("a", [{ query: null, profile: "core" }, q("x")])) === "searched" &&
      category(found("a", [{ query: null, profile: "core" }])) === "searched, no query" &&
      category({ outcome: "graded", attempts: [{ endedBy: "gated", firstSeekCall: null }] }) === "gated" &&
      category({ outcome: "graded", attempts: [{ endedBy: "max-responses", firstSeekCall: 2 }] }) === "sought without sci_find" &&
      category({ outcome: "no-run", attempts: [] }) === "harness-error",
  );
  const rank = (query, ranker) => (query === "both" || (query === "bm" && ranker === "bm25f") ? ["t"] : ["other"]);
  const attempts = [found("a", [q("bm")]), found("b", [q("both")]), found("c", [q("miss"), q("both")])].map((line) => ({ writer: "w", style: "plain", line, category: category(line) }));
  const panel = panelReport(attempts, rank, { skipGain: 0.03, minSearched: 1, minPlain: 1 });
  check(
    "panel report: the first query is primary, the union secondary; a plain-style gain of 3 points or more keeps 4b",
    /w +plain +current 1\/3 .*bm25f 2\/3 .*discordant 1:0/.test(panel) && /w +current 2\/3 .*bm25f 3\/3/.test(panel.split("Secondary")[1]) && /w 33\.3 pts → 4b stays in the plan/.test(panel),
    panel,
  );
  const sparse = panelReport([...attempts, { writer: "silent", style: "plain", line: { id: "a", outcome: "graded", attempts: [{ endedBy: "gated" }] }, category: "gated" }], rank);
  check(
    "panel report: a writer under the minimum counts toward no rule; with none counted the rules say no data and 4b stays",
    /counted: w no \(3\), silent no \(0\)/.test(sparse) && /pooled point estimate >= 0\): no data/.test(sparse) && /lower bounds > 0\): no data/.test(sparse) && /no data: 4b stays in the plan/.test(sparse),
    sparse,
  );
  const cluster = (target, bm25f, current) => ({ line: { target }, hit: { bm25f, current } });
  const once = [...Array.from({ length: 12 }, (_, i) => cluster(`t${i}`, true, true)), cluster("g1", true, false), cluster("g2", true, false), cluster("l1", false, true), cluster("m1", false, false)];
  const [one, four] = [once, [...once, ...once, ...once, ...once]].map((rows) => paired(rows, "hit", true));
  check(
    "panel pooled rows: a target repeated four times leaves the bootstrap by target unchanged; Newcombe narrows",
    one.bootstrap[0] === four.bootstrap[0] && one.bootstrap[1] === four.bootstrap[1] && four.newcombe[1] - four.newcombe[0] < one.newcombe[1] - one.newcombe[0],
    JSON.stringify({ one: [one.newcombe, one.bootstrap], four: [four.newcombe, four.bootstrap] }),
  );
}

console.log(`\n${problems === 0 ? "PASS" : "FAIL"} — ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
