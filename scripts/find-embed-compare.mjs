#!/usr/bin/env node
// Offline comparison of sci_find's BM25F ranker with an embedding model, and
// with two hybrids of the two. It answers whether embeddings would rank this
// catalogue better, and at what cost, before anything ships.
//
// The model runs behind a local HTTP endpoint you already have, so nothing is
// installed here: Ollama (`--api ollama`, POST /api/embed) or any
// OpenAI-compatible server (`--api openai`, POST /v1/embeddings). For
// llama.cpp, start `llama-server -m <model.gguf> --embeddings -ub 2048 -b 2048`:
// its default batch of 512 tokens rejects the longer skill texts of --doc body.
//
//   ollama pull embeddinggemma
//   node scripts/find-embed-compare.mjs [-o report.md] [--json results.json]
//
// What it can and cannot tell you. The built-in query sets (the golden queries
// and the sets in scripts/lib/rank-bench.mjs) are BM25F's own development
// data: its settings, its no-match rule and the golden "want" lists were all
// fitted to them, so BM25F's rows there are in-sample and favour it. A fair
// comparison needs queries BM25F was not tuned on: --heldout (the locked
// held-out set) or --positives (your own, written blind). Likewise the
// threshold of each embedding arm is chosen on the 12 built-in negatives, so
// only --negatives measures how often it wrongly answers.
//
// Options:
//   --endpoint <url>    Default http://localhost:11434 (Ollama's port).
//   --api <ollama|openai>  Default ollama.
//   --model <name>      Default embeddinggemma.
//   --prompts <embeddinggemma|none>  EmbeddingGemma was trained with task
//                       prompts ("task: search result | query: ..." for queries,
//                       "title: ... | text: ..." for documents). Default
//                       embeddinggemma when the model name contains
//                       "embeddinggemma", none otherwise. Pass none if your
//                       server already adds them.
//   --doc <description|body>  What a skill's vector is built from. Default
//                       description (name and description). body adds the start
//                       of SKILL.md's body, up to --body-chars (default 6000;
//                       EmbeddingGemma reads at most 2048 tokens, and Ollama is
//                       asked to fail rather than truncate).
//   --heldout <dir>     The locked held-out set (the directory
//                       find-rank-heldout.mjs reads). Scored as held-out sets,
//                       by count only; no query text is printed.
//   --positives <file>  Queries a skill should answer, written without looking
//                       at the rankers: JSON lines {"query": ..., "want": [...]}
//                       or tab-separated "query<TAB>skill[,skill...]".
//   --negatives <file>  Queries no skill should answer, one per line or a JSON
//                       array of strings, written without looking at the skill
//                       list. Reported at the chosen thresholds as held out.
//   --batch <n>         Texts per request when embedding skills. Default 16.
//   --timeout <s>       Seconds to wait for one request. Default 120.
//   --cache <dir>       Vectors are cached by model and text, so a rerun only
//                       sends new texts. Default: a directory under the OS
//                       temp dir. A probe text is embedded on every run and the
//                       cache is dropped when its vector changes, so a model
//                       swapped behind the same name is not mixed in.
//                       --no-cache turns the cache off.
//   --fake              A deterministic hashed bag of words instead of a model,
//                       to check the plumbing with no server. Its numbers mean
//                       nothing.
//   -o, --output <file> The report (Markdown) instead of stdout.
//   --json <file>       Every metric as JSON, for a run record.
//
// Arms. A hit list is up to 8 skills; top-k counts a query as a miss when its
// list is empty.
//   bm25f        sci_find's own search(): ranker, exact-name rule, no-match rule.
//   embed@t      Skills by cosine similarity, listed only when the best cosine
//                is at least t. Embeddings always have a nearest neighbour, so t
//                is the only way this arm can say "nothing fits".
//   fallback@t   bm25f's hits; when bm25f returns nothing, embed@t's. It can
//                differ from bm25f only on queries bm25f leaves empty.
//   rrf@t        Reciprocal rank fusion (k = 60) of BM25F's full ranking and the
//                cosine ranking. Nothing is listed when bm25f's no-match rule
//                fails and the best cosine is below t.
// Each arm's t is the lowest that keeps the built-in negatives at least as
// silent as bm25f keeps them. The report also sweeps t, for embed@t the trade
// between finding targets and staying silent.
//
// Exit 0, 1 on a runtime error, 2 on bad arguments or input files.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHeldOut } from "./find-rank-heldout.mjs";
import { NEGATIVES, QUERIES } from "./lib/golden-queries.mjs";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { loadSets } from "./lib/rank-bench.mjs";

const LIST = 8;
const TOP_K = [1, 3, 5, 8];
const RRF_K = 60;
/** Thresholds the choice is made on, and the coarser ones the sweep table shows. */
const FINE = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
const SHOWN = new Set(Array.from({ length: 19 }, (_, i) => (5 * (i + 1)) / 100));
const PROBE_TEXT = "probe: is this the same model as last time";

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error(
    "usage: node scripts/find-embed-compare.mjs [--endpoint <url>] [--api ollama|openai] [--model <name>]\n" +
      "  [--prompts embeddinggemma|none] [--doc description|body] [--body-chars <n>] [--heldout <dir>]\n" +
      "  [--positives <file>] [--negatives <file>] [--batch <n>] [--timeout <s>] [--cache <dir> | --no-cache]\n" +
      "  [--fake] [-o <file>] [--json <file>]",
  );
  process.exit(code);
}

/** Queries no skill should answer: one per line, or a JSON array of strings. */
export const parseNegatives = (text) => {
  const trimmed = text.trim();
  const list = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!Array.isArray(list) || list.length === 0 || !list.every((q) => typeof q === "string" && q.trim())) {
    throw new Error("expected one query per line or a JSON array of strings");
  }
  return list.map((query) => ({ query }));
};

/** Queries a skill should answer: JSON lines {query, want} or "query<TAB>skill[,skill]". */
export const parsePositives = (text) => {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      if (line.startsWith("{")) {
        const row = JSON.parse(line);
        const want = typeof row.want === "string" ? [row.want] : row.want;
        if (typeof row.query !== "string" || !Array.isArray(want) || want.length === 0) throw new Error(`line ${i + 1}: needs "query" and "want"`);
        return { query: row.query, want };
      }
      const [query, skills] = line.split("\t");
      if (!query || !skills) throw new Error(`line ${i + 1}: expected "query<TAB>skill[,skill]"`);
      return { query, want: skills.split(",").map((s) => s.trim()).filter(Boolean) };
    });
  if (rows.length === 0) throw new Error("no queries");
  return rows;
};

export function parseArgs(argv) {
  const opts = {
    endpoint: "http://localhost:11434",
    api: "ollama",
    model: "embeddinggemma",
    prompts: undefined,
    doc: "description",
    bodyChars: 6000,
    heldout: null,
    positives: null,
    negatives: null,
    batch: 16,
    timeout: 120,
    cache: join(tmpdir(), "sci-find-embed-cache"),
    fake: false,
    output: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? usage(2, `${arg} needs a value`);
    if (arg === "--endpoint") opts.endpoint = next().replace(/\/+$/, "");
    else if (arg === "--api") opts.api = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--prompts") opts.prompts = next();
    else if (arg === "--doc") opts.doc = next();
    else if (arg === "--body-chars") opts.bodyChars = Number(next());
    else if (arg === "--heldout") opts.heldout = next();
    else if (arg === "--positives") opts.positives = next();
    else if (arg === "--negatives") opts.negatives = next();
    else if (arg === "--batch") opts.batch = Number(next());
    else if (arg === "--timeout") opts.timeout = Number(next());
    else if (arg === "--cache") opts.cache = next();
    else if (arg === "--no-cache") opts.cache = null;
    else if (arg === "--fake") opts.fake = true;
    else if (arg === "--output" || arg === "-o") opts.output = next();
    else if (arg === "--json") opts.json = next();
    else if (arg === "--help" || arg === "-h") usage(0);
    else usage(2, `unknown argument: ${arg}`);
  }
  opts.prompts ??= /embeddinggemma/i.test(opts.model) ? "embeddinggemma" : "none";
  if (!["ollama", "openai"].includes(opts.api)) usage(2, "--api must be ollama or openai");
  if (!["embeddinggemma", "none"].includes(opts.prompts)) usage(2, "--prompts must be embeddinggemma or none");
  if (!["description", "body"].includes(opts.doc)) usage(2, "--doc must be description or body");
  for (const [key, flag] of [["bodyChars", "--body-chars"], ["batch", "--batch"], ["timeout", "--timeout"]]) {
    if (!Number.isInteger(opts[key]) || opts[key] < 1) usage(2, `${flag} must be a positive integer`);
  }
  if (opts.heldout && !existsSync(join(opts.heldout, "leaks.json"))) usage(2, `${opts.heldout} is not a held-out directory (no leaks.json)`);
  for (const [key, parse] of [["positives", parsePositives], ["negatives", parseNegatives]]) {
    if (!opts[key]) continue;
    if (!existsSync(opts[key])) usage(2, `no file at ${opts[key]}`);
    try {
      opts[`${key}Rows`] = parse(readFileSync(opts[key], "utf8"));
    } catch (error) {
      usage(2, `${opts[key]}: ${error.message}`);
    }
  }
  return opts;
}

// --- text the model sees ------------------------------------------------------

/** The query as the model sees it. */
export const queryText = (query, prompts) => (prompts === "embeddinggemma" ? `task: search result | query: ${query}` : query);

/** A skill as the model sees it: its name as the title, its description, and optionally the start of its body. */
export const docText = (entry, body, prompts) => {
  const text = body ? `${entry.description}\n\n${body}` : entry.description;
  return prompts === "embeddinggemma" ? `title: ${entry.name} | text: ${text}` : `${entry.name}: ${text}`;
};

// --- vectors ------------------------------------------------------------------

const normalize = (vector) => {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
};

/**
 * Why a vector cannot be used (llama-server writes NaN and Inf as null), or ""
 * when it can: a non-empty array of finite numbers, of the expected dimension
 * when one is given, and not all zeros.
 */
export const vectorProblem = (vector, dimension) => {
  if (!Array.isArray(vector) || vector.length === 0) return "is not a non-empty array";
  if (!vector.every((x) => typeof x === "number" && Number.isFinite(x))) return "holds a value that is not a finite number";
  if (dimension !== undefined && vector.length !== dimension) return `has ${vector.length} dimensions, not ${dimension}`;
  if (!vector.some((x) => x !== 0)) return "is all zeros";
  return "";
};

/** Dot product of two unit vectors: their cosine. */
export const cosine = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/** A deterministic stand-in for a model: lowercase words hashed into 512 buckets. */
export const fakeEmbed = (text) => {
  const vector = new Array(512).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
    const hash = createHash("sha1").update(word).digest();
    vector[hash.readUInt16BE(0) % 512] += 1;
  }
  vector[511] += 1e-6; // never all zeros
  return normalize(vector);
};

/** One request for a batch of texts; returns unit vectors in input order. */
export async function requestEmbeddings(opts, texts) {
  if (opts.fake) return texts.map(fakeEmbed);
  const url = opts.api === "ollama" ? `${opts.endpoint}/api/embed` : `${opts.endpoint}/v1/embeddings`;
  // Ollama truncates an overlong input by default. Failing is better than
  // scoring a skill on a text the report misdescribes.
  const body = opts.api === "ollama" ? { model: opts.model, input: texts, truncate: false } : { model: opts.model, input: texts };
  const seconds = opts.timeout ?? 120;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000 * seconds),
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error(`${url} did not answer within ${seconds} s (--timeout)`);
    throw new Error(`no embedding server at ${url} (${error.cause?.code ?? error.message}); start it, or pass --fake to check the plumbing`);
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    const hint = /physical batch|too large|n_ubatch/i.test(text) ? " (llama-server: restart it with -ub 2048 -b 2048)" : "";
    throw new Error(`${url} answered ${response.status}: ${text}${hint}`);
  }
  const json = await response.json();
  const vectors =
    opts.api === "ollama"
      ? json.embeddings
      : [...(json.data ?? [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`${url} returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${texts.length} texts`);
  }
  vectors.forEach((vector, i) => {
    const problem = vectorProblem(vector, vectors[0]?.length);
    if (problem) throw new Error(`${url}: the vector for input ${i} ${problem}`);
  });
  return vectors.map(normalize);
}

/**
 * Embeds texts through the cache. Texts already cached cost nothing and are
 * left out of the timings, so `timings` holds only real requests. The probe
 * is sent on every run: its time is the run's first request, and a change in
 * its vector means a different model, which drops the cache.
 */
function createEmbedder(opts) {
  const cacheFile =
    opts.cache && !opts.fake
      ? join(opts.cache, `${createHash("sha256").update(`${opts.api}\u0000${opts.endpoint}\u0000${opts.model}`).digest("hex").slice(0, 16)}.json`)
      : null;
  let cache = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const key = (text) => createHash("sha256").update(text).digest("hex");
  const timings = { probe: null, documents: [], queries: [] };
  let dimension;
  let dirty = false;
  let cacheDropped = false;
  return {
    timings,
    get cacheDropped() {
      return cacheDropped;
    },
    get cacheFile() {
      return cacheFile;
    },
    async probe() {
      const started = performance.now();
      const [vector] = await requestEmbeddings(opts, [PROBE_TEXT]);
      timings.probe = performance.now() - started;
      dimension = vector.length;
      const cached = cache[key(PROBE_TEXT)];
      if (cached && (cached.length !== vector.length || cosine(cached, vector) < 0.9999)) {
        cache = {};
        cacheDropped = true;
        if (cacheFile) rmSync(cacheFile, { force: true });
      }
      cache[key(PROBE_TEXT)] = vector;
      dirty = true;
    },
    async embed(texts, kind, batch) {
      const missing = [...new Set(texts.filter((text) => !cache[key(text)]))];
      for (let i = 0; i < missing.length; i += batch) {
        const chunk = missing.slice(i, i + batch);
        const started = performance.now();
        const vectors = await requestEmbeddings(opts, chunk);
        timings[kind].push({ ms: performance.now() - started, texts: chunk.length });
        chunk.forEach((text, j) => (cache[key(text)] = vectors[j]));
        dirty = true;
      }
      return texts.map((text) => {
        const vector = cache[key(text)];
        const problem = vectorProblem(vector, dimension);
        if (problem) throw new Error(`a cached vector ${problem}; rerun with --no-cache or delete ${cacheFile}`);
        return vector;
      });
    },
    save() {
      if (!cacheFile || !dirty) return;
      mkdirSync(opts.cache, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
      dirty = false;
    },
  };
}

// --- arms -----------------------------------------------------------------------

/** Skill names by cosine, best first, and the best cosine. */
export const cosineRanking = (queryVector, skills) => {
  const scored = skills.map((skill) => ({ name: skill.name, score: cosine(queryVector, skill.vector) }));
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { names: scored.map((s) => s.name), top: scored[0]?.score ?? -1 };
};

/** Reciprocal rank fusion of ranked name lists. */
export const rrf = (lists, k = RRF_K) => {
  const scores = new Map();
  for (const list of lists) list.forEach((name, i) => scores.set(name, (scores.get(name) ?? 0) + 1 / (k + i + 1)));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
};

/**
 * Every arm's hit list for one query, as functions of the threshold where the
 * arm has one. `bm25fHits` is search()'s result (empty when its no-match rule
 * fails); `bm25fRanking` is BM25F's full ranking with no rule applied.
 */
export const armLists = ({ bm25fHits, bm25fRanking, embedding }) => ({
  bm25f: () => bm25fHits.slice(0, LIST),
  embed: (t) => (embedding.top >= t ? embedding.names.slice(0, LIST) : []),
  fallback: (t) => (bm25fHits.length > 0 ? bm25fHits.slice(0, LIST) : embedding.top >= t ? embedding.names.slice(0, LIST) : []),
  rrf: (t) => (bm25fHits.length === 0 && embedding.top < t ? [] : rrf([bm25fRanking, embedding.names]).slice(0, LIST)),
});

// --- metrics --------------------------------------------------------------------

/** The 1-based rank of the first wanted skill in a list, 0 when none is listed. */
const rankOf = (list, want) => list.findIndex((name) => want.includes(name)) + 1;

/** top-k shares and the no-hit share for one set under one arm (and threshold). */
export const scorePositives = (rows, listOf) => {
  const ranks = rows.map((row) => rankOf(listOf(row), row.want));
  const lists = rows.map(listOf);
  const share = (n) => n / Math.max(1, rows.length);
  return {
    n: rows.length,
    ...Object.fromEntries(TOP_K.map((k) => [`top${k}`, share(ranks.filter((r) => r >= 1 && r <= k).length)])),
    nohit: share(lists.filter((list) => list.length === 0).length),
  };
};

/** The share of must-find-nothing queries that do find nothing. */
export const scoreNegatives = (rows, listOf) => ({
  n: rows.length,
  silent: rows.filter((row) => listOf(row).length === 0).length / Math.max(1, rows.length),
});

/**
 * The lowest threshold at which `silentAt(t)` reaches `baseline`, or null.
 * Silence only rises with t and finding targets only falls, so the lowest
 * such t is the one that costs the fewest targets.
 */
export const chooseThreshold = (thresholds, silentAt, baseline) => thresholds.find((t) => silentAt(t) >= baseline) ?? null;

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// --- report ---------------------------------------------------------------------

const pct = (x) => (x === null || x === undefined ? "  n/a" : (100 * x).toFixed(1).padStart(5));
const ms = (x) => (x === null || x === undefined ? "n/a" : x < 10 ? x.toFixed(2) : x.toFixed(0));

function report(results) {
  const { config, positives, negatives, sweep, timing, deciding, bm25fSilentOnDev } = results;
  const lines = [];
  const out = (line = "") => lines.push(line);
  out(`# sci_find: BM25F against ${config.fake ? "a FAKE embedder (plumbing check only)" : `${config.model} (${config.api} at ${config.endpoint})`}`);
  out();
  out(`Skills: ${config.skills}. Skill text: ${config.doc}${config.doc === "body" ? ` (first ${config.bodyChars} characters of the body)` : ""}. Prompts: ${config.prompts}. Lists: up to ${LIST} hits.`);
  out();
  out("**Read with care.** Sets marked *dev* are BM25F's development data: its settings, its no-match rule and the golden want lists were fitted to them, so BM25F's rows there are in-sample and favour it. Sets marked *held out* were not used to tune anything here. The thresholds below were chosen on the built-in negatives, so only held-out negatives measure wrong answers.");
  out();
  out(`On the dev positive sets bm25f returns nothing for ${bm25fSilentOnDev} quer${bm25fSilentOnDev === 1 ? "y" : "ies"}, and fallback can differ from bm25f only there.`);
  out();
  out("## Thresholds");
  out();
  for (const [arm, t] of Object.entries(results.chosenThresholds)) {
    out(`- ${arm}: ${t === null ? "none keeps the built-in negatives as silent as bm25f" : `t = ${t}`}`);
  }
  if (deciding) {
    out(`- embed's t is set by the built-in negative with the highest top cosine: "${deciding.query}" (top skill ${deciding.skill}, cosine ${deciding.cosine.toFixed(3)}). One query decides it, so compare with a file of your own negatives.`);
  }
  out();
  out("## Positive sets");
  out();
  out(`| set | kind | n | arm | t | ${TOP_K.map((k) => `top${k}`).join(" | ")} | nohit |`);
  out(`|---|---|---|---|---|${TOP_K.map(() => "---").join("|")}|---|`);
  for (const [set, { kind, arms }] of Object.entries(positives)) {
    for (const [arm, row] of Object.entries(arms)) {
      out(`| ${set} | ${kind} | ${row.n} | ${arm} | ${row.t ?? "-"} | ${TOP_K.map((k) => pct(row[`top${k}`])).join(" | ")} | ${pct(row.nohit)} |`);
    }
  }
  out();
  out("## Negatives: share that correctly find nothing");
  out();
  const arms = ["bm25f", ...Object.keys(results.chosenThresholds)];
  out(`| set | kind | n | ${arms.join(" | ")} |`);
  out(`|---|---|---|${arms.map(() => "---").join("|")}|`);
  for (const [set, { kind, arms: byArm }] of Object.entries(negatives)) {
    out(`| ${set} | ${kind} | ${byArm.bm25f.n} | ${arms.map((arm) => pct(byArm[arm].silent)).join(" | ")} |`);
  }
  out();
  out("## Threshold sweep for embed");
  out();
  out("Mean top-3 over the positive sets of each kind, and the silent share on each negative set, as t rises. fallback and rrf are not swept: fallback's positives equal bm25f's wherever bm25f lists something, and rrf's positives do not depend on t.");
  out();
  const negativeSets = Object.keys(negatives);
  const kinds = [...new Set(Object.values(positives).map((p) => p.kind))];
  out(`| t | ${kinds.map((k) => `mean top3, ${k}`).join(" | ")} | ${negativeSets.map((s) => `silent: ${s}`).join(" | ")} |`);
  out(`|---|${kinds.map(() => "---").join("|")}|${negativeSets.map(() => "---").join("|")}|`);
  for (const row of sweep) {
    out(`| ${row.t} | ${kinds.map((k) => pct(row.meanTop3[k])).join(" | ")} | ${negativeSets.map((s) => pct(row.silent[s])).join(" | ")} |`);
  }
  out();
  out("## Cost");
  out();
  out(`- BM25F: index ${ms(timing.bm25fIndexMs)} ms once; per query p50 ${ms(timing.bm25fQuery.p50)} ms, p95 ${ms(timing.bm25fQuery.p95)} ms.`);
  out(`- The run's first request, one short text: ${ms(timing.probeMs)} ms. If the server had the model unloaded, this includes loading it. Ollama unloads a model after about 5 minutes idle by default, so a session that searches rarely pays this again.`);
  if (timing.documentRequests > 0) {
    out(`- Embedding the skills: ${timing.documentRequests} requests, ${ms(timing.documentMs)} ms in all, for ${timing.documentTexts} texts not already cached.`);
  }
  if (timing.queryCount > 0) {
    out(`- Embedding a query, one request each: p50 ${ms(timing.query.p50)} ms, p95 ${ms(timing.query.p95)} ms, over ${timing.queryCount} queries not already cached.`);
  } else {
    out("- Every query vector came from the cache, so query time was not measured. Rerun with --no-cache to time it.");
  }
  if (results.cacheDropped) out("- The probe's vector changed since the cache was written, so the cache was dropped: the model behind this name is not the one cached.");
  if (config.fake) {
    out();
    out("**This run used --fake. The numbers check the plumbing and say nothing about embeddings.**");
  }
  return `${lines.join("\n")}\n`;
}

// --- main -----------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const bm25f = await loadExtensionModule("extensions/bm25f.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());
  const known = new Set(catalog.map((entry) => entry.name));

  // BM25F first: its index build is one of the costs being compared.
  let started = performance.now();
  search.bm25fIndexFor(catalog);
  const bm25fIndexMs = performance.now() - started;

  const positiveSets = {
    golden: { kind: "dev", rows: QUERIES.map(([query, want]) => ({ query, want })) },
    ...Object.fromEntries(
      Object.entries(loadSets()).map(([name, rows]) => [name, { kind: "dev", rows: rows.map((row) => ({ query: row.query, want: [row.target] })) }]),
    ),
  };
  if (opts.heldout) {
    const cells = loadHeldOut(opts.heldout);
    for (const style of [...new Set(cells.map((cell) => cell.style))]) {
      positiveSets[`heldout-${style}`] = {
        kind: "held out",
        rows: cells.filter((cell) => cell.style === style).map((cell) => ({ query: cell.query, want: [cell.target] })),
      };
    }
  }
  if (opts.positivesRows) {
    const unknown = [...new Set(opts.positivesRows.flatMap((row) => row.want).filter((name) => !known.has(name)))];
    if (unknown.length) throw new Error(`${opts.positives} names skills that are not in skills/: ${unknown.join(", ")}`);
    positiveSets.yours = { kind: "held out", rows: opts.positivesRows };
  }
  const negativeSets = { builtin: { kind: "dev", rows: NEGATIVES.map((query) => ({ query })) } };
  if (opts.negativesRows) negativeSets.yours = { kind: "held out", rows: opts.negativesRows };

  const embedder = createEmbedder(opts);
  const allRows = [...Object.values(positiveSets), ...Object.values(negativeSets)].flatMap((set) => set.rows);
  const queries = [...new Set(allRows.map((row) => row.query))];
  const queryVectors = new Map();
  let skillVectors;
  try {
    await embedder.probe();
    const skillTexts = catalog.map((entry) =>
      docText(entry, opts.doc === "body" ? bm25f.readBody(entry).trim().slice(0, opts.bodyChars) : "", opts.prompts),
    );
    console.error(`embedding ${catalog.length} skills…`);
    skillVectors = await embedder.embed(skillTexts, "documents", opts.batch);
    embedder.save();
    console.error(`embedding ${queries.length} queries one at a time…`);
    for (const [i, query] of queries.entries()) {
      const [vector] = await embedder.embed([queryText(query, opts.prompts)], "queries", 1);
      queryVectors.set(query, vector);
      if (i % 100 === 99) embedder.save();
    }
  } finally {
    // Keep what was embedded, so a run that fails midway resumes from there.
    embedder.save();
  }
  const skills = catalog.map((entry, i) => ({ name: entry.name, vector: skillVectors[i] }));

  const bm25fTimes = [];
  const listsByQuery = new Map();
  const embeddings = new Map();
  for (const query of queries) {
    started = performance.now();
    const hits = search.search(catalog, query, LIST).map((hit) => hit.entry.name);
    bm25fTimes.push(performance.now() - started);
    const ranking = search.rankBm25f(catalog, query).map((hit) => hit.entry.name);
    const embedding = cosineRanking(queryVectors.get(query), skills);
    embeddings.set(query, embedding);
    listsByQuery.set(query, armLists({ bm25fHits: hits, bm25fRanking: ranking, embedding }));
  }
  const listOf = (arm, t) => (row) => listsByQuery.get(row.query)[arm](t);

  // Thresholds are chosen on the built-in negatives only, so a file of your
  // own negatives stays a test of them.
  const builtin = negativeSets.builtin.rows;
  const baseline = scoreNegatives(builtin, listOf("bm25f")).silent;
  const thresholded = ["embed", "fallback", "rrf"];
  const chosen = Object.fromEntries(
    thresholded.map((arm) => [arm, chooseThreshold(FINE, (t) => scoreNegatives(builtin, listOf(arm, t)).silent, baseline)]),
  );
  const loudest = builtin.map((row) => ({ query: row.query, ...embeddings.get(row.query) })).sort((a, b) => b.top - a.top)[0];
  const deciding = loudest ? { query: loudest.query, skill: loudest.names[0], cosine: loudest.top } : null;

  const devRows = Object.values(positiveSets).filter((set) => set.kind === "dev").flatMap((set) => set.rows);
  const bm25fSilentOnDev = new Set(devRows.filter((row) => listOf("bm25f")(row).length === 0).map((row) => row.query)).size;

  const kinds = [...new Set(Object.values(positiveSets).map((set) => set.kind))];
  const sweep = FINE.filter((t) => SHOWN.has(t)).map((t) => {
    const meanTop3 = {};
    for (const kind of kinds) {
      const top3s = Object.values(positiveSets).filter((set) => set.kind === kind).map((set) => scorePositives(set.rows, listOf("embed", t)).top3);
      meanTop3[kind] = top3s.reduce((a, b) => a + b, 0) / top3s.length;
    }
    const silent = Object.fromEntries(Object.entries(negativeSets).map(([name, set]) => [name, scoreNegatives(set.rows, listOf("embed", t)).silent]));
    return { t, meanTop3, silent };
  });

  const scoreArms = (set, score) => {
    const arms = { bm25f: score(set.rows, listOf("bm25f")) };
    for (const arm of thresholded) {
      const t = chosen[arm];
      arms[arm] = t === null ? { n: set.rows.length, t: "none" } : { ...score(set.rows, listOf(arm, t)), t };
    }
    return { kind: set.kind, arms };
  };
  const positives = Object.fromEntries(Object.entries(positiveSets).map(([name, set]) => [name, scoreArms(set, scorePositives)]));
  const negatives = Object.fromEntries(Object.entries(negativeSets).map(([name, set]) => [name, scoreArms(set, scoreNegatives)]));

  const queryTimes = embedder.timings.queries.map((entry) => entry.ms);
  const results = {
    config: { ...opts, positivesRows: undefined, negativesRows: undefined, skills: catalog.length },
    chosenThresholds: chosen,
    deciding,
    bm25fSilentOnDev,
    positives,
    negatives,
    sweep,
    cacheDropped: embedder.cacheDropped,
    timing: {
      bm25fIndexMs,
      bm25fQuery: { p50: percentile(bm25fTimes, 50), p95: percentile(bm25fTimes, 95) },
      probeMs: embedder.timings.probe,
      documentRequests: embedder.timings.documents.length,
      documentTexts: embedder.timings.documents.reduce((sum, entry) => sum + entry.texts, 0),
      documentMs: embedder.timings.documents.reduce((sum, entry) => sum + entry.ms, 0),
      queryCount: queryTimes.length,
      query: { p50: percentile(queryTimes, 50), p95: percentile(queryTimes, 95) },
    },
  };

  const text = report(results);
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
  if (opts.json) writeFileSync(opts.json, `${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
