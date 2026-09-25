// Parsers for a find-live-arms run's llama-server log and driver log, and the
// join of server requests to the pi session messages they produced
// (scripts/find-live-timing.mjs). llama.cpp stamps each line with the time
// since the server started, as minutes.seconds.ms.us; the driver log gives
// the wall-clock time of each start.

const STAMP = /^(\d+)\.(\d{2})\.(\d{3})\.(\d{3}) /;
const LAUNCH = /launch_slot_: .*\| task (\d+) \|/;
const CANCEL = /cancel task, id_task = (\d+)/;
const PROMPT = /\| task (\d+) \| prompt eval time = +([\d.]+) ms \/ +(\d+) tokens/;
const GENERATE = /\| task (\d+) \| +eval time = +([\d.]+) ms \/ +(\d+) tokens/;
const RELEASE = /\| task (\d+) \| stop processing: n_tokens = (\d+)/;
const FIELDS = [
  [CANCEL, (m, at) => ({ cancel: at })],
  [PROMPT, (m) => ({ promptMs: Number(m[2]), promptTokens: Number(m[3]) })],
  [GENERATE, (m) => ({ genMs: Number(m[2]), genTokens: Number(m[3]) })],
  [RELEASE, (m, at) => ({ release: at, context: Number(m[2]) })],
];

/** Milliseconds since the server started, or null for an unstamped line. */
export function stampMs(line) {
  const m = STAMP.exec(line);
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) + Number(m[4]) / 1000 : null;
}

/**
 * Requests per server run, in launch order. Times are ms since that run's
 * start. A stamp that goes back by more than 5 s starts a new run: the driver
 * restarted the server and appended to the same log.
 */
export function parseServerLog(text) {
  const runs = [];
  let tasks = null;
  let last = Infinity;
  for (const line of text.split("\n")) {
    const at = stampMs(line);
    if (at === null) continue;
    if (tasks === null || at + 5000 < last) runs.push((tasks = new Map()));
    last = at;
    const launch = LAUNCH.exec(line);
    if (launch) {
      tasks.set(launch[1], { task: Number(launch[1]), run: runs.length - 1, launch: at });
      continue;
    }
    for (const [pattern, fields] of FIELDS) {
      const m = pattern.exec(line);
      const request = m && tasks.get(m[1]);
      if (request) {
        tasks.set(m[1], { ...request, ...fields(m, at) });
        break;
      }
    }
  }
  return runs.map((run) => [...run.values()]);
}

/** Local wall-clock ms of a driver log line, or null. */
const driverTime = (line) => {
  const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] /.exec(line);
  return m ? new Date(`${m[1]}T${m[2]}`).getTime() : null;
};

/** Server start times, and one window per arm and chunk (START to END, or to an interrupt). */
export function parseDriverLog(text) {
  const starts = [];
  const windows = [];
  let open = null;
  for (const line of text.split("\n")) {
    const at = driverTime(line);
    if (at === null) continue;
    const body = line.slice(line.indexOf("] ") + 2);
    let m;
    if (body.startsWith("starting server")) starts.push(at);
    else if ((m = /^START chunk-(\d+) (\S+)/.exec(body))) windows.push((open = { chunk: Number(m[1]), arm: m[2], start: at, end: null }));
    else if (open && (/^END /.test(body) || body.startsWith("interrupted"))) {
      open.end = at;
      open = null;
    }
  }
  return { starts, windows };
}

export const median = (values) => {
  const x = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (x.length === 0) return null;
  const mid = Math.floor(x.length / 2);
  return x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2;
};

/** Greedy pairs: same token counts, release within `tolerance` ms of the message's write time. */
function pairUp(done, messages, offset, tolerance) {
  const used = new Set();
  const pairs = [];
  for (const request of done) {
    const at = offset + request.release;
    let best = null;
    for (const message of messages) {
      if (used.has(message) || message.input !== request.promptTokens || message.output !== request.genTokens) continue;
      const gap = Math.abs(message.end - at);
      if (gap <= tolerance && (!best || gap < best.gap)) best = { message, gap };
    }
    if (best) {
      used.add(best.message);
      pairs.push([request, best.message]);
    }
  }
  return pairs;
}

/**
 * Pairs each finished server request with the pi assistant message it
 * produced: pi's usage.input is the prompt tokens llama.cpp processed (the
 * uncached part) and usage.output the tokens it generated. The clock offset
 * of each server run starts at the driver's "starting server" time (whole
 * seconds) and is refit as the median gap between release and write time.
 * `messages`: {start, end, input, output} with start/end in epoch ms.
 */
export function joinRequests(runs, starts, messages) {
  const pairs = [];
  const offsets = runs.map((requests, index) => {
    const guess = starts[index];
    if (!Number.isFinite(guess)) return null;
    const done = requests.filter((r) => r.promptTokens != null && r.genTokens != null && r.release != null);
    const rough = pairUp(done, messages, guess, 30000);
    const offset = rough.length > 0 ? median(rough.map(([r, m]) => m.end - r.release)) : guess;
    for (const [request, message] of pairUp(done, messages, offset, 3000)) {
      pairs.push({ request, message, queueMs: offset + request.launch - message.start });
    }
    return offset;
  });
  return { pairs, offsets };
}
