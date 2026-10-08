#!/usr/bin/env node
// Offline comparison of sci_find's BM25F ranker with an embedding model, and
// with two hybrids of the two, on the fixed query sets and on queries that must
// find nothing. It answers whether embeddings would rank this catalogue better,
// and at what cost, before anything ships.
//
// The model runs behind a local HTTP endpoint you already have, so nothing is
// installed here: Ollama (`--api ollama`, POST /api/embed) or any
// OpenAI-compatible server (`--api openai`, POST /v1/embeddings), such as
// llama.cpp's `llama-server --embeddings` or LM Studio.
//
//   ollama pull embeddinggemma
//   node scripts/find-embed-compare.mjs --model embeddinggemma [-o report.md] [--json results.json]
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
//                       of SKILL.md's body, up to --body-chars (default 6000).
//   --negatives <file>  Extra queries that must find nothing, one per line or a
//                       JSON array of strings, reported as their own set. Write
//                       them without looking at the skill list: the 12 built-in
//                       negatives were written with the ranker in view.
//   --batch <n>         Texts per request when embedding skills. Default 16.
//   --cache <dir>       Vectors are cached here by model and text, so a rerun
//                       only times new texts. Default: a directory under the OS
//                       temp dir. --no-cache turns it off.
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
//   fallback@t   bm25f's hits; when bm25f returns nothing, embed@t's.
//   rrf@t        Reciprocal rank fusion (k = 60) of BM25F's full ranking and the
//                cosine ranking. Nothing is listed when bm25f's no-match rule
//                fails and the best cosine is below t.
// Each @t arm is reported over a sweep of t, so the trade between finding the
// target and staying silent on negatives is visible, not chosen in advance.
//
// Exit 0, 1 on a runtime error, 2 on bad arguments.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NEGATIVES, QUERIES } from "./lib/golden-queries.mjs";
import { loadExtensionModule } from "./lib/load-extension.mjs";
import { loadSets } from "./lib/rank-bench.mjs";

const LIST = 8;
const TOP_K = [1, 3, 5, 8];
const RRF_K = 60;
const THRESHOLDS = Array.from({ length: 19 }, (_, i) => Number((0.05 * (i + 1)).toFixed(2)));

function usage(code, error) {
  if (error) console.error(`error: ${error}`);
  console.error(
    "usage: node scripts/find-embed-compare.mjs [--endpoint <url>] [--api ollama|openai] [--model <name>]\n" +
      "  [--prompts embeddinggemma|none] [--doc description|body] [--body-chars <n>] [--negatives <file>]\n" +
      "  [--batch <n>] [--cache <dir> | --no-cache] [--fake] [-o <file>] [--json <file>]",
  );
  process.exit(code);
}

export function parseArgs(argv) {
  const opts = {
    endpoint: "http://localhost:11434",
    api: "ollama",
    model: "embeddinggemma",
    prompts: undefined,
    doc: "description",
    bodyChars: 6000,
    negatives: null,
    batch: 16,
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
    else if (arg === "--negatives") opts.negatives = next();
    else if (arg === "--batch") opts.batch = Number(next());
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
  for (const key of ["bodyChars", "batch"]) {
    if (!Number.isInteger(opts[key]) || opts[key] < 1) usage(2, `--${key === "bodyChars" ? "body-chars" : key} must be a positive integer`);
  }
  if (opts.negatives && !existsSync(opts.negatives)) usage(2, `no file at ${opts.negatives}`);
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
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vector.map((x) => x / norm);
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
  return normalize(vector);
};

/** One request for a batch of texts; returns unit vectors in input order. */
export async function requestEmbeddings(opts, texts) {
  if (opts.fake) return texts.map(fakeEmbed);
  const url = opts.api === "ollama" ? `${opts.endpoint}/api/embed` : `${opts.endpoint}/v1/embeddings`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, input: texts }),
    });
  } catch (error) {
    throw new Error(`no embedding server at ${url} (${error.cause?.code ?? error.message}); start it, or pass --fake to check the plumbing`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  const vectors =
    opts.api === "ollama"
      ? body.embeddings
      : [...(body.data ?? [])].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`${url} returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${texts.length} texts`);
  }
  return vectors.map(normalize);
}

/**
 * Embeds texts through the cache. Texts already cached cost nothing and are
 * left out of the timings, so `timings` holds only real requests.
 */
function createEmbedder(opts) {
  const cacheFile = opts.cache && !opts.fake
    ? join(opts.cache, `${createHash("sha256").update(`${opts.api}\u0000${opts.endpoint}\u0000${opts.model}`).digest("hex").slice(0, 16)}.json`)
    : null;
  const cache = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const key = (text) => createHash("sha256").update(text).digest("hex");
  const timings = { documents: [], queries: [] };
  let dirty = false;
  return {
    timings,
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
      return texts.map((text) => cache[key(text)]);
    },
    save() {
      if (!cacheFile || !dirty) return;
      mkdirSync(opts.cache, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
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

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

// --- report ---------------------------------------------------------------------

const pct = (x) => (x === null || x === undefined ? "  n/a" : (100 * x).toFixed(1).padStart(5));
const ms = (x) => (x === null ? "n/a" : x < 10 ? x.toFixed(2) : x.toFixed(0));

function report(results) {
  const { config, positives, negatives, sweep, timing } = results;
  const lines = [];
  lines.push(`# sci_find: BM25F against ${config.fake ? "a FAKE embedder (plumbing check only)" : `${config.model} (${config.api} at ${config.endpoint})`}`);
  lines.push("");
  lines.push(`Skills: ${config.skills}. Skill text: ${config.doc}${config.doc === "body" ? ` (first ${config.bodyChars} chars of the body)` : ""}. Prompts: ${config.prompts}. Lists: up to ${LIST} hits.`);
  lines.push("");
  lines.push("## Positive sets at each arm's best balanced threshold");
  lines.push("");
  const silence = Object.entries(results.bm25fSilence).map(([name, silent]) => `${name} ${pct(silent).trim()}%`).join(", ");
  lines.push(`Threshold per arm: the one with the highest mean top-3 over the positive sets among those that keep every negative set at least as silent as bm25f does (${silence}). "none" means no threshold managed that.`);
  lines.push("");
  lines.push(`| set | n | arm | t | ${TOP_K.map((k) => `top${k}`).join(" | ")} | nohit |`);
  lines.push(`|---|---|---|---|${TOP_K.map(() => "---").join("|")}|---|`);
  for (const [set, byArm] of Object.entries(positives)) {
    for (const [arm, row] of Object.entries(byArm)) {
      lines.push(`| ${set} | ${row.n} | ${arm} | ${row.t ?? "-"} | ${TOP_K.map((k) => pct(row[`top${k}`])).join(" | ")} | ${pct(row.nohit)} |`);
    }
  }
  lines.push("");
  lines.push("## Negatives: share that correctly find nothing");
  lines.push("");
  lines.push(`| set | n | ${Object.keys(Object.values(negatives)[0] ?? {}).join(" | ")} |`);
  lines.push(`|---|---|${Object.keys(Object.values(negatives)[0] ?? {}).map(() => "---").join("|")}|`);
  for (const [set, byArm] of Object.entries(negatives)) {
    const arms = Object.values(byArm);
    lines.push(`| ${set} | ${arms[0]?.n ?? 0} | ${arms.map((row) => `${pct(row.silent)}${row.t !== undefined ? ` (t ${row.t ?? "none"})` : ""}`).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Threshold sweep");
  lines.push("");
  lines.push("Mean top-3 over the positive sets, and the silent share on each negative set, for each threshold t.");
  lines.push("");
  const negativeSets = Object.keys(negatives);
  lines.push(`| arm | t | mean top3 | ${negativeSets.map((s) => `silent: ${s}`).join(" | ")} |`);
  lines.push(`|---|---|---|${negativeSets.map(() => "---").join("|")}|`);
  for (const row of sweep) {
    lines.push(`| ${row.arm} | ${row.t} | ${pct(row.meanTop3)} | ${negativeSets.map((s) => pct(row.silent[s])).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Cost");
  lines.push("");
  lines.push(`- BM25F: index ${ms(timing.bm25fIndexMs)} ms once; per query p50 ${ms(timing.bm25fQuery.p50)} ms, p95 ${ms(timing.bm25fQuery.p95)} ms.`);
  if (timing.queryCount === 0 && timing.documentRequests === 0) {
    lines.push("- Embeddings: every vector came from the cache, so nothing was timed. Rerun with --no-cache for timings.");
  } else {
    lines.push(`- Embedding the skills: ${timing.documentRequests} requests, ${ms(timing.documentMs)} ms in all (${timing.documentTexts} texts; cached texts are not counted).`);
    lines.push(`- Embedding a query: p50 ${ms(timing.query.p50)} ms, p95 ${ms(timing.query.p95)} ms, over ${timing.queryCount} uncached queries.`);
    lines.push(`- The run's first request: ${ms(timing.firstRequestMs)} ms. If the server had unloaded the model, this includes loading it, which a session would pay once.`);
  }
  if (config.fake) {
    lines.push("");
    lines.push("**This run used --fake. The numbers check the plumbing and say nothing about embeddings.**");
  }
  return `${lines.join("\n")}\n`;
}

// --- main -----------------------------------------------------------------------

const readNegativesFile = (path) => {
  const text = readFileSync(path, "utf8").trim();
  const list = text.startsWith("[") ? JSON.parse(text) : text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!list.every((q) => typeof q === "string")) throw new Error(`${path}: expected one query per line or a JSON array of strings`);
  return list;
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const search = await loadExtensionModule("extensions/search.ts");
  const bm25f = await loadExtensionModule("extensions/bm25f.ts");
  const catalog = search.loadCatalog(search.resolveSkillsDir());

  // BM25F first: its index build is one of the costs being compared.
  let started = performance.now();
  search.bm25fIndexFor(catalog);
  const bm25fIndexMs = performance.now() - started;

  // Positive sets: the golden queries (any of several skills counts) and the
  // fixed sets in scripts/lib/rank-bench.mjs (one target each).
  const positiveSets = {
    golden: QUERIES.map(([query, want]) => ({ query, want })),
    ...Object.fromEntries(Object.entries(loadSets()).map(([name, rows]) => [name, rows.map((row) => ({ query: row.query, want: [row.target] }))])),
  };
  const negativeSets = { builtin: NEGATIVES.map((query) => ({ query })) };
  if (opts.negatives) negativeSets.yours = readNegativesFile(opts.negatives).map((query) => ({ query }));

  const embedder = createEmbedder(opts);
  const skillTexts = catalog.map((entry) =>
    docText(entry, opts.doc === "body" ? bm25f.readBody(entry).trim().slice(0, opts.bodyChars) : "", opts.prompts),
  );
  console.error(`embedding ${catalog.length} skills…`);
  const skillVectors = await embedder.embed(skillTexts, "documents", opts.batch);
  const skills = catalog.map((entry, i) => ({ name: entry.name, vector: skillVectors[i] }));

  const allRows = [...Object.values(positiveSets), ...Object.values(negativeSets)].flat();
  const queries = [...new Set(allRows.map((row) => row.query))];
  console.error(`embedding ${queries.length} queries one at a time…`);
  const queryVectors = new Map();
  for (const query of queries) {
    const [vector] = await embedder.embed([queryText(query, opts.prompts)], "queries", 1);
    queryVectors.set(query, vector);
  }
  embedder.save();

  const bm25fTimes = [];
  const listsByQuery = new Map();
  for (const query of queries) {
    started = performance.now();
    const hits = search.search(catalog, query, LIST).map((hit) => hit.entry.name);
    bm25fTimes.push(performance.now() - started);
    const ranking = search.rankBm25f(catalog, query).map((hit) => hit.entry.name);
    listsByQuery.set(query, armLists({ bm25fHits: hits, bm25fRanking: ranking, embedding: cosineRanking(queryVectors.get(query), skills) }));
  }
  const listOf = (arm, t) => (row) => listsByQuery.get(row.query)[arm](t);

  // The sweep: every thresholded arm at every t.
  const thresholded = ["embed", "fallback", "rrf"];
  const sweep = [];
  for (const arm of thresholded) {
    for (const t of THRESHOLDS) {
      const top3s = Object.values(positiveSets).map((rows) => scorePositives(rows, listOf(arm, t)).top3);
      sweep.push({
        arm,
        t,
        meanTop3: top3s.reduce((a, b) => a + b, 0) / top3s.length,
        silent: Object.fromEntries(Object.entries(negativeSets).map(([name, rows]) => [name, scoreNegatives(rows, listOf(arm, t)).silent])),
      });
    }
  }

  // Each thresholded arm's best threshold among those that keep every negative
  // set at least as silent as bm25f keeps it. With only the 12 built-in
  // negatives this is a coarse guard; a file of your own is the real test.
  const bm25fSilence = Object.fromEntries(
    Object.entries(negativeSets).map(([name, rows]) => [name, scoreNegatives(rows, listOf("bm25f")).silent]),
  );
  const chosen = Object.fromEntries(
    thresholded.map((arm) => {
      const eligible = sweep.filter(
        (row) => row.arm === arm && Object.entries(bm25fSilence).every(([name, silent]) => row.silent[name] >= silent),
      );
      const best = eligible.sort((a, b) => b.meanTop3 - a.meanTop3 || a.t - b.t)[0];
      return [arm, best?.t ?? null];
    }),
  );

  const positives = {};
  for (const [set, rows] of Object.entries(positiveSets)) {
    positives[set] = { bm25f: scorePositives(rows, listOf("bm25f")) };
    for (const arm of thresholded) {
      const t = chosen[arm];
      positives[set][arm] = t === null ? { n: rows.length, t: "none" } : { ...scorePositives(rows, listOf(arm, t)), t };
    }
  }
  const negatives = {};
  for (const [set, rows] of Object.entries(negativeSets)) {
    negatives[set] = { bm25f: scoreNegatives(rows, listOf("bm25f")) };
    for (const arm of thresholded) {
      const t = chosen[arm];
      negatives[set][arm] = t === null ? { n: rows.length, silent: null, t: null } : { ...scoreNegatives(rows, listOf(arm, t)), t };
    }
  }

  const queryTimes = embedder.timings.queries.map((entry) => entry.ms);
  const results = {
    config: { ...opts, skills: catalog.length },
    bm25fSilence,
    chosenThresholds: chosen,
    positives,
    negatives,
    sweep,
    timing: {
      bm25fIndexMs,
      bm25fQuery: { p50: percentile(bm25fTimes, 50), p95: percentile(bm25fTimes, 95) },
      documentRequests: embedder.timings.documents.length,
      documentTexts: embedder.timings.documents.reduce((sum, entry) => sum + entry.texts, 0),
      documentMs: embedder.timings.documents.reduce((sum, entry) => sum + entry.ms, 0),
      queryCount: queryTimes.length,
      firstRequestMs: (embedder.timings.documents[0] ?? embedder.timings.queries[0])?.ms ?? null,
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
