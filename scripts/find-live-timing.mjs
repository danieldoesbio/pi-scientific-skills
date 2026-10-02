#!/usr/bin/env node
// Server-side timing for a find-live-arms run (scripts/find-live-arms.sh):
// prefill, generation and queue wait per request, joined from the run's
// llama-server.log to its archived pi session files, and the time to read
// with the queue wait taken out.
//
// The queue wait: on a stop (reach or gate) the harness kills pi, but
// llama.cpp finishes the prefill of the cancelled request before it frees the
// slot (11–17 s on 2026-09-25). The next attempt's first request waits for
// it, inside its recorded time to read. It is not the model's work.
//
//   node scripts/find-live-timing.mjs <run-dir> [--jsonl <file>] [--verbose]
//
// Summary per arm on stdout; --jsonl writes one line per attempt and warm-up;
// join diagnostics on stderr. Exit 0, 1 on a runtime error, 2 on bad arguments.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEntries, readMessages, responses, skillReads } from "./lib/pi-session.mjs";
import { joinRequests, median, parseDriverLog, parseServerLog } from "./lib/server-log.mjs";

const BINS = [4096, 8192, 16384, 32768, Infinity];
const BIN_LABELS = ["<4k", "4k-8k", "8k-16k", "16k-32k", ">=32k"];

function parseArgs(argv) {
  const opts = { runDir: null, jsonl: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--jsonl") opts.jsonl = argv[++i];
    else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else if (!arg.startsWith("-") && opts.runDir === null) opts.runDir = resolve(arg);
    else usage(2, `unknown argument: ${arg}`);
  }
  if (opts.runDir === null) usage(2, "a run directory is required");
  if (opts.jsonl === undefined) usage(2, "--jsonl needs a file");
  for (const name of ["driver.log", "llama-server.log"]) {
    if (!existsSync(join(opts.runDir, name))) usage(2, `${name} not found in ${opts.runDir}`);
  }
  return opts;
}

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error("usage: node scripts/find-live-timing.mjs <run-dir> [--jsonl <file>] [--verbose]");
  process.exit(code);
}

const entriesOf = (dir, kind) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => (kind === "dir" ? entry.isDirectory() : entry.isFile()))
        .map((entry) => entry.name)
        .sort()
    : [];

/** Every archived session: archive/<arm>/chunk-NN/transcripts/<probe>/<label>.session.jsonl. */
function sessions(runDir) {
  const archive = join(runDir, "archive");
  return entriesOf(archive, "dir").flatMap((arm) =>
    entriesOf(join(archive, arm), "dir").flatMap((chunk) => {
      const transcripts = join(archive, arm, chunk, "transcripts");
      return entriesOf(transcripts, "dir").flatMap((probe) =>
        entriesOf(join(transcripts, probe), "file")
          .filter((file) => file.endsWith(".session.jsonl"))
          .map((file) => ({
            arm,
            chunk: Number(chunk.replace("chunk-", "")),
            probe,
            label: file.replace(".session.jsonl", ""),
            file: join(transcripts, probe, file),
          })),
      );
    }),
  );
}

/** Assistant messages with usage: one per finished request pi made. */
const assistantMessages = (session) =>
  readEntries(session.file)
    .filter((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage)
    .map((entry) => ({
      session,
      start: entry.message.timestamp,
      end: Date.parse(entry.timestamp),
      input: entry.message.usage.input,
      output: entry.message.usage.output,
      cacheRead: entry.message.usage.cacheRead ?? 0,
    }));

/** The last results line per arm and probe (a --resume re-run replaces a no-run). */
function results(runDir) {
  const out = new Map();
  for (const file of entriesOf(runDir, "file")) {
    const arm = /^results-(.+?)\.jsonl$/.exec(file)?.[1];
    if (!arm || arm.endsWith(".warmup")) continue;
    for (const line of readFileSync(join(runDir, file), "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      out.set(`${arm}/${row.id}`, row);
    }
  }
  return out;
}

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
const tenth = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** Timing for one session, from its joined requests and its results line. */
function timingOf(session, pairs, messageCount, row) {
  const own = pairs.filter((pair) => pair.message.session === session).sort((a, b) => a.message.start - b.message.start);
  const attempt = row?.attempts?.find((entry) => entry.label === session.label);
  const turns = responses(readMessages(session.file));
  const base = turns[0]?.at;
  const hit = attempt?.endpointSeconds != null ? skillReads(turns, [row.target]).find((h) => h.skill === row.target) : null;
  const queueBefore = hit ? sum(own.filter((pair) => pair.message.start < hit.at).map((pair) => pair.queueMs)) : null;
  return {
    arm: session.arm,
    chunk: session.chunk,
    probe: session.probe,
    label: session.label,
    endedBy: attempt?.endedBy ?? null,
    requests: messageCount,
    joined: own.length,
    prefillSeconds: tenth(sum(own.map((pair) => pair.request.promptMs)) / 1000),
    prefillTokens: sum(own.map((pair) => pair.request.promptTokens)),
    cachedTokens: sum(own.map((pair) => pair.message.cacheRead)),
    generationSeconds: tenth(sum(own.map((pair) => pair.request.genMs)) / 1000),
    generationTokens: sum(own.map((pair) => pair.request.genTokens)),
    queueSeconds: tenth(sum(own.map((pair) => pair.queueMs)) / 1000),
    firstQueueSeconds: own.length > 0 ? tenth(own[0].queueMs / 1000) : null,
    firstAfterStop: own.length > 0 ? own[0].request.afterCancel : null,
    firstPrefillSeconds: own.length > 0 ? tenth(own[0].request.promptMs / 1000) : null,
    firstPrefillTokens: own.length > 0 ? own[0].request.promptTokens : null,
    endpointSeconds: attempt?.endpointSeconds ?? null,
    endpointSecondsExact: hit ? tenth((hit.at - base) / 1000) : null,
    endpointSecondsNet: hit ? tenth((hit.at - base - queueBefore) / 1000) : null,
  };
}

/**
 * Finished and cancelled requests per arm, placed by the driver's START/END
 * windows. The first request in a window is the invocation's warm-up.
 */
function requestsByArm(runs, offsets, windows) {
  const byWindow = new Map();
  runs.forEach((requests, run) => {
    if (offsets[run] == null) return;
    for (const request of requests) {
      const at = offsets[run] + request.launch;
      const window = windows.find((w) => at >= w.start - 1000 && (w.end === null || at <= w.end + 1000));
      if (window) byWindow.set(window, [...(byWindow.get(window) ?? []), request]);
    }
  });
  const byArm = new Map();
  for (const [window, requests] of byWindow) {
    const tagged = requests.map((request, index) => ({ ...request, warmup: index === 0 }));
    byArm.set(window.arm, [...(byArm.get(window.arm) ?? []), ...tagged]);
  }
  return byArm;
}

const pad = (text, width) => String(text).padEnd(width);
const rate = (tokens, ms) => (ms > 0 ? Math.round(tokens / (ms / 1000)) : "-");

function printSummary(arms, timings, byArm) {
  console.log("Warm-ups: prefill s / tokens processed / tokens cached / queue s, by chunk");
  for (const arm of arms) {
    const warm = timings.filter((t) => t.arm === arm && t.probe === "_warmup").sort((a, b) => a.chunk - b.chunk);
    console.log(`  ${pad(arm, 5)} ${warm.map((t) => `c${t.chunk} ${t.prefillSeconds}/${t.prefillTokens}/${t.cachedTokens}/${t.firstQueueSeconds}`).join("  ")}`);
  }
  console.log("\nAttempts (medians; time to read on attempts that read the target)");
  console.log(`  ${pad("arm", 5)} ${pad("timed", 6)} ${pad("queue 1st", 10)} ${pad("read: raw -> net", 17)} ${pad("prefill s", 10)} generation s`);
  for (const arm of arms) {
    const own = timings.filter((t) => t.arm === arm && t.probe !== "_warmup");
    const read = own.filter((t) => t.endpointSecondsNet != null);
    console.log(
      `  ${pad(arm, 5)} ${pad(own.length, 6)} ${pad(tenth(median(own.map((t) => t.firstQueueSeconds))), 10)} ` +
        `${pad(`${tenth(median(read.map((t) => t.endpointSecondsExact)))} -> ${tenth(median(read.map((t) => t.endpointSecondsNet)))}`, 17)} ` +
        `${pad(tenth(median(own.map((t) => t.prefillSeconds))), 10)} ${tenth(median(own.map((t) => t.generationSeconds)))}`,
    );
  }
  console.log("\nFirst request of an attempt, prefill tok/s pooled (n): after a stop | not after a stop");
  for (const arm of arms) {
    const firsts = timings.filter((t) => t.arm === arm && t.probe !== "_warmup" && t.firstPrefillSeconds > 0);
    const pooled = (list) => (list.length ? `${rate(sum(list.map((t) => t.firstPrefillTokens)), sum(list.map((t) => t.firstPrefillSeconds * 1000)))} (${list.length})` : "-");
    console.log(`  ${pad(arm, 5)} ${pooled(firsts.filter((t) => t.firstAfterStop))} | ${pooled(firsts.filter((t) => !t.firstAfterStop))}`);
  }
  console.log("\nServer speed by prompt size, finished requests that are not a warm-up and not right after a stop:");
  console.log("prefill tok/s | generation tok/s (n), pooled");
  console.log(`  ${pad("arm", 5)} ${BIN_LABELS.map((label) => pad(label, 16)).join("")}`);
  for (const arm of arms) {
    const done = (byArm.get(arm) ?? []).filter(
      (r) => r.promptMs != null && r.genMs != null && r.context != null && !r.warmup && !r.afterCancel,
    );
    const cells = BINS.map((top, index) => {
      const bin = done.filter((r) => r.context - r.genTokens < top && r.context - r.genTokens >= (BINS[index - 1] ?? 0));
      if (bin.length === 0) return pad("-", 16);
      const prefill = rate(sum(bin.map((r) => r.promptTokens)), sum(bin.map((r) => r.promptMs)));
      const generation = rate(sum(bin.map((r) => r.genTokens)), sum(bin.map((r) => r.genMs)));
      return pad(`${prefill} | ${generation} (${bin.length})`, 16);
    });
    console.log(`  ${pad(arm, 5)} ${cells.join("")}`);
  }
  // llama.cpp logs the cancel late (at a batch boundary), so this undercounts
  // the wait a stop causes; that wait is the "queue 1st" column above.
  console.log("\nCancelled requests (one per stop): busy from the logged cancel to release, s");
  for (const arm of arms) {
    const tails = (byArm.get(arm) ?? []).filter((r) => r.cancel != null && r.release != null).map((r) => (r.release - r.cancel) / 1000);
    console.log(`  ${pad(arm, 5)} n ${pad(tails.length, 4)} median ${tenth(median(tails))}  max ${tails.length ? tenth(Math.max(...tails)) : "-"}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { starts, windows } = parseDriverLog(readFileSync(join(opts.runDir, "driver.log"), "utf8"));
  const runs = parseServerLog(readFileSync(join(opts.runDir, "llama-server.log"), "utf8"));
  const all = sessions(opts.runDir);
  const messages = all.flatMap(assistantMessages);
  const { pairs, offsets } = joinRequests(runs, starts, messages);
  const rows = results(opts.runDir);
  const timings = all.map((session) =>
    timingOf(session, pairs, messages.filter((m) => m.session === session).length, rows.get(`${session.arm}/${session.probe}`)),
  );
  const arms = [...new Set(windows.map((w) => w.arm))];
  printSummary(arms, timings, requestsByArm(runs, offsets, windows));

  const finished = runs.flat().filter((r) => r.promptMs != null && r.genMs != null && r.release != null);
  const timed = new Set(all.map((s) => `${s.arm}/${s.probe}`));
  const untimed = [...rows.keys()].filter((key) => !timed.has(key));
  console.error(
    `\njoin: ${pairs.length} of ${finished.length} finished requests paired with a session message; ` +
      `${messages.length - pairs.length} session message(s) unpaired; ` +
      `clock offset vs driver start: ${offsets.map((o, i) => (o == null ? "-" : `${tenth((o - starts[i]) / 1000)} s`)).join(", ")}`,
  );
  if (untimed.length > 0) console.error(`no session file (not archived), not timed: ${untimed.join(", ")}`);
  const drift = timings.filter((t) => t.endpointSeconds != null && Math.abs(t.endpointSeconds - t.endpointSecondsExact) > 0.5);
  if (drift.length > 0) console.error(`WARNING: time to read recomputed differs from the results line: ${drift.map((t) => `${t.arm}/${t.probe}`).join(", ")}`);
  if (opts.verbose) {
    for (const t of timings.filter((t) => t.joined < t.requests)) console.error(`  unpaired: ${t.arm}/${t.probe}/${t.label} ${t.joined} of ${t.requests}`);
  }
  if (opts.jsonl) writeFileSync(opts.jsonl, timings.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
