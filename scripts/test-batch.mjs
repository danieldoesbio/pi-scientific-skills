#!/usr/bin/env node
// Run a batch of skills for real in pi and capture transcripts for grading.
//
// Discovery testing (does pi offer the skill) is cheap and covers every skill —
// scripts/validate.mjs plus the tarball probe in DOCUMENTATION.md do that.
// This script covers the expensive half: does pi load the skill, and does a
// model follow SKILL.md. The bar is whether pi sees and loads the skill. An
// artifact is extra evidence when the skill produces one; it is not required.
//
// This script does NOT decide pass/fail. It produces transcripts; a human or a
// stronger model grades them. A model's own claim that it succeeded is not
// evidence — it is the thing being tested.
//
// Skills are run against the PACKED TARBALL extracted into a scratch dir, never
// against ./skills, for three reasons: it tests what actually ships, it dodges
// any /sci filter in ~/.pi/agent/settings.json that would silently hide skills,
// and skill scripts that write __pycache__ cannot break the vendored tree's
// byte-identity with upstream.
//
// Usage:
//   node scripts/test-batch.mjs --version 1.0.2 [options]
//
//   --version <v>     Package version under test. Also seeds selection, so the
//                     batch for a given version is reproducible. Required.
//   --size <n>        Batch size, default 6. The user's convention is 4-8.
//   --include <a,b>   Always test these (e.g. skills new in this release).
//                     They count toward --size.
//   --model <id>      Default deepseek/deepseek-v4-flash. Pin an exact id; the
//                     `~...-latest` aliases defeat reproducibility.
//   --timeout <s>     Per-skill wall clock, default 300.
//   --dry-run         Print the batch and exit without spending tokens.
//   --distill-only    Rebuild <skill>.summary.json from raw .jsonl already on
//                     disk. Use after a distiller change; does not spend tokens.
//
// Exit codes: 0 = all runs finished (any verdict), 1 = a run crashed, 2 = usage.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir, userInfo } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = join(root, "testing", "ledger.json");

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { size: 6, model: "deepseek/deepseek-v4-flash", timeout: 300, include: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--version") opts.version = next();
    else if (a === "--size") opts.size = Number(next());
    else if (a === "--model") opts.model = next();
    else if (a === "--timeout") opts.timeout = Number(next());
    else if (a === "--include") opts.include = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--distill-only") opts.distillOnly = true;
    else die(`unknown argument: ${a}`);
  }
  if (!opts.version) die("--version is required");
  if (!Number.isInteger(opts.size) || opts.size < 1) die("--size must be a positive integer");
  return opts;
}

// Deterministic PRNG so a version string always yields the same batch. Selection
// must be auditable: "we tested these 6" should be re-derivable months later.
function seedFrom(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readLedger() {
  if (!existsSync(ledgerPath)) return { schemaVersion: 1, runs: [] };
  return JSON.parse(readFileSync(ledgerPath, "utf8"));
}

function description(skillDir) {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return "";
  const text = readFileSync(p, "utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!fm) return "";
  // Flat scalar or block scalar; good enough to seed a probe prompt.
  const flat = fm[1].match(/^description:[ \t]*(?![|>])(.+)$/m);
  if (flat) return flat[1].replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  const block = fm[1].match(/^description:[ \t]*[|>][-+]?[ \t]*\r?\n((?:[ \t]+.*\r?\n?)+)/m);
  return block ? block[1].replace(/\s+/g, " ").trim() : "";
}

// Build the extracted tarball once per batch and reuse it for every skill.
function stageTarball(scratch) {
  const stage = join(scratch, "stage");
  mkdirSync(stage, { recursive: true });
  // stderr piped, not inherited: `npm pack` writes a per-file notice for all
  // ~1,840 files and buries the batch progress.
  const packed = execFileSync("npm", ["pack", "--pack-destination", stage], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .pop()
    .trim();
  execFileSync("tar", ["xzf", join(stage, packed), "-C", stage]);
  const pkg = join(stage, "package");
  if (!existsSync(join(pkg, "skills"))) die("packed tarball has no skills/ — check package.json files[]", 1);
  return pkg;
}

// The probe asks the model to load the skill and follow SKILL.md. It must not
// fake results, and it must not create accounts or download large weight files.
// Stopping at a documented login/download step is a successful demonstration.
function probeFor(name, desc) {
  return [
    `Use the \`${name}\` skill. Load it, follow SKILL.md, and take ONE small step that shows pi offered it and you followed it.`,
    desc ? `For context, the skill describes itself as: ${desc}` : "",
    "",
    "Rules:",
    "- Work only inside the current working directory. Do not touch anything outside it.",
    "- Follow the skill's own instructions. Do not improvise an approach it does not describe.",
    "- Keep it to a few steps. You are showing the skill loaded, not doing a full project.",
    "- Do not create accounts, request Hub access, log into third-party services, or",
    "  download model weights / large datasets. If SKILL.md's next step needs any of those,",
    "  stop there. Print `VERDICT: DONE` and say you loaded the skill and followed it up to that step.",
    "- Check for a missing local package with ONE targeted command (`pip show X`, `which X`).",
    "  Never scan the filesystem — no `find /`, no `locate`, no walking outside this directory.",
    "- Do NOT fake results or simulate output.",
    "- When finished, print `VERDICT: DONE` followed by one sentence naming what you did.",
  ]
    .filter(Boolean)
    .join("\n");
}

// pi emits a cumulative message_update per token, so a raw transcript runs to
// several MB of the same message repeated. Worse, tool results embed absolute
// paths and the operating user's name (`ls -la` output alone leaks both), and
// this repo is public and has been PII-scanned clean. So the raw .jsonl stays
// local and gitignored; what gets committed is this distilled, scrubbed record:
// the tool calls in order, truncated results, and the final text.
function distill(rawText, home, user) {
  // macOS resolves tmpdir() under /private; transcripts mix both spellings.
  const tmp = tmpdir();
  const privateTmp = tmp.startsWith("/var/") ? `/private${tmp}` : tmp;
  const scrub = (s) =>
    String(s)
      .split(home).join("$HOME")
      .split(`/Users/${user}`).join("$HOME")
      .split(privateTmp).join("$TMPDIR")
      .split(tmp).join("$TMPDIR")
      .split(user).join("$USER")
      // The splits above match this run's tmpdir exactly. A model that types a
      // *near-miss* path — one character off, or left over from another run —
      // walks straight through them, which is how a per-user /var/folders hash
      // reached a committed transcript: the model guessed a path, the `ls`
      // failed, and the wrong string was never a scrub target. Transcripts
      // record what the model typed, so match the shape, not the string.
      .replace(/(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/[A-Z]\//g, () => "$TMPDIR/")
      // Second pass, because a model also writes bare roots: `find /var/folders/<bucket> …`.
      // Order matters — the specific rule above must run first or this would
      // swallow the `/T/` that makes the full form a real tmpdir path.
      .replace(/(?:\/private)?\/var\/folders(?:\/[^/\s"']+)*/g, () => "$TMPDIR");
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);

  const calls = [];
  let finalText = "";
  let usage = null;

  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "tool_execution_start") {
      calls.push({ id: e.toolCallId, tool: e.toolName, args: clip(scrub(JSON.stringify(e.args ?? {})), 400) });
    } else if (e.type === "tool_execution_end") {
      const text = (e.result?.content ?? [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
      // Match on toolCallId, never on tool name. pi runs calls concurrently, so
      // results arrive out of order and name-matching silently staples one
      // command's output onto a different command — which reads as evidence for
      // something that never happened.
      const target = calls.find((c) => c.id === e.toolCallId);
      if (target) {
        target.isError = Boolean(e.isError);
        target.result = clip(scrub(text), 600);
      }
      // No name-matching fallback. A missing id is better left unpaired than
      // stapled onto the wrong call.
    } else if (e.type === "message_end") {
      const m = e.message ?? {};
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const t = m.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
        if (t.trim()) finalText = t;
      }
      if (m.usage) usage = m.usage;
    }
  }
  return {
    // toolCallId is pairing-only; it is not evidence and does not ship.
    toolCalls: calls.map(({ id: _id, ...rest }) => rest),
    finalText: clip(scrub(finalText), 4000),
    usage,
  };
}

const opts = parseArgs(process.argv.slice(2));

// Regenerate summaries from raw transcripts already on disk. Needed whenever the
// distiller changes, and after a batch that ran under an older version of it —
// re-running the batch itself would cost the model calls again.
if (opts.distillOnly) {
  const dir = join(root, "testing", "transcripts", opts.version);
  if (!existsSync(dir)) die(`no transcripts at ${dir}`);
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const skill = f.replace(/\.jsonl$/, "");
    const raw = readFileSync(join(dir, f), "utf8");
    const prev = existsSync(join(dir, `${skill}.summary.json`))
      ? JSON.parse(readFileSync(join(dir, `${skill}.summary.json`), "utf8"))
      : {};
    writeFileSync(
      join(dir, `${skill}.summary.json`),
      `${JSON.stringify(
        {
          skill,
          packageVersion: opts.version,
          model: prev.model ?? opts.model,
          elapsedSeconds: prev.elapsedSeconds ?? null,
          outcome: prev.outcome ?? "unknown (re-distilled)",
          ...distill(raw, homedir(), userInfo().username),
        },
        null,
        2,
      )}\n`,
    );
    n++;
  }
  console.log(`re-distilled ${n} transcript(s) in ${dir}`);
  process.exit(0);
}

const skillsDir = join(root, "skills");
const allSkills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
  .map((d) => d.name)
  .sort();

const ledger = readLedger();
// TIMEOUT is a fact about the run, not about the skill, so those skills stay in
// the pool and can be drawn again. Only a conclusive verdict removes one.
const tested = new Set(ledger.runs.filter((r) => r.verdict !== "TIMEOUT").map((r) => r.skill));
const inconclusive = ledger.runs.filter((r) => r.verdict === "TIMEOUT" && !tested.has(r.skill)).map((r) => r.skill);

for (const name of opts.include) {
  if (!allSkills.includes(name)) die(`--include names a skill that is not in skills/: ${name}`);
}

// Deterministic first (this release's new skills), then random fill from the
// never-tested pool so coverage accumulates instead of resampling.
const batch = [...opts.include];
const pool = allSkills.filter((s) => !tested.has(s) && !batch.includes(s));
const rand = mulberry32(seedFrom(opts.version));
while (batch.length < opts.size && pool.length > 0) {
  batch.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
}

const untestedTotal = allSkills.filter((s) => !tested.has(s)).length;
console.log(`skills: ${allSkills.length} | conclusively tested: ${tested.size} | not yet: ${untestedTotal}`);
if (inconclusive.length) console.log(`back in the pool after an inconclusive run: ${inconclusive.join(", ")}`);
console.log(`batch (seed "${opts.version}", model ${opts.model}):`);
for (const s of batch) console.log(`  ${opts.include.includes(s) ? "*" : " "} ${s}`);
if (opts.include.length) console.log("  (* = explicitly included, not sampled)");
if (opts.dryRun) process.exit(0);

const scratch = join(tmpdir(), `pi-skill-test-${opts.version}`);
mkdirSync(scratch, { recursive: true });
const pkg = stageTarball(scratch);
const outDir = join(root, "testing", "transcripts", opts.version);
mkdirSync(outDir, { recursive: true });

let crashed = 0;
for (const [i, name] of batch.entries()) {
  const sandbox = join(scratch, "runs", name);
  // Wipe leftover state. Scratch is keyed only on version, so a re-run of the
  // same skill otherwise resumes the previous sandbox — the arbor re-run at
  // 1.0.2 continued a killed first attempt rather than starting clean.
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const probe = probeFor(name, description(join(skillsDir, name)));
  process.stderr.write(`[${i + 1}/${batch.length}] ${name} ... `);
  const started = Date.now();

  // stdout goes straight to a file descriptor rather than through a pipe. pi's
  // --mode json emits a CUMULATIVE message_update per token, so a long run
  // produces tens of MB; buffering it means any maxBuffer is a silent kill
  // switch. The first arbor run died exactly this way — SIGTERM at 67 MB, which
  // reads as a skill failure and is not one.
  const transcript = join(outDir, `${name}.jsonl`);
  const fd = openSync(transcript, "w");
  let res;
  try {
    // -ne / -ns keep the run isolated: no other extensions, no ambient skill
    // discovery, so the ONLY skill in play is the one under test. Tools stay
    // enabled — pi exposes skills as a tool, so --no-tools would hide it
    // entirely and every run would report a false zero.
    res = spawnSync(
      "pi",
      [
        "-ne", "-ns",
        "--skill", join(pkg, "skills", name),
        "--no-session",
        "--mode", "json",
        "--model", opts.model,
        "-p", probe,
      ],
      { cwd: sandbox, encoding: "utf8", timeout: opts.timeout * 1000, stdio: ["ignore", fd, "pipe"] },
    );
  } finally {
    closeSync(fd);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const raw = readFileSync(transcript, "utf8");
  if (res.stderr) writeFileSync(join(outDir, `${name}.stderr.txt`), res.stderr);

  const timedOut = res.error?.code === "ETIMEDOUT";
  const distilled = distill(raw, homedir(), userInfo().username);
  writeFileSync(
    join(outDir, `${name}.summary.json`),
    `${JSON.stringify(
      {
        skill: name,
        packageVersion: opts.version,
        model: opts.model,
        elapsedSeconds: Number(elapsed),
        outcome: timedOut ? "TIMEOUT" : res.status === 0 ? "completed" : `pi exit ${res.status}`,
        ...distilled,
      },
      null,
      2,
    )}\n`,
  );

  if (timedOut) {
    console.error(`TIMEOUT after ${opts.timeout}s`);
    crashed++;
  } else if (res.status !== 0) {
    console.error(`pi exited ${res.status} (${elapsed}s) — see ${name}.stderr.txt`);
    crashed++;
  } else {
    // Read the claim from the distilled FINAL TEXT only. Matching against the
    // raw stream instead catches the probe prompt echoed back in the transcript,
    // so every run reports "BLOCKED <one-line reason>" — the template, not an
    // answer. A grader who trusted that would record fiction.
    const claim = distilled.finalText.match(/VERDICT: (DONE|BLOCKED)[^\n]*/);
    console.error(`${elapsed}s | ${distilled.toolCalls.length} tool calls | model claims: ${claim ? claim[0] : "no verdict line"}`);
  }
  console.error(`      sandbox: ${sandbox}`);
}

console.log(`\ntranscripts: ${outDir}`);
console.log("Next: grade each transcript, then add a run entry per skill to testing/ledger.json.");
console.log("Grade from the transcript, not from the model's VERDICT line — that line is a claim.");
process.exit(crashed > 0 ? 1 : 0);
