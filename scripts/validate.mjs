#!/usr/bin/env node
// Validate all skills against pi's Agent Skills rules (docs/skills.md), and
// validate extensions/ against what is actually on disk and in package.json.
//
// Warnings are acceptable (pi loads leniently); a MISSING description is a hard
// failure because pi refuses to load such skills. A profiles.ts that disagrees
// with skills/ is also a hard failure: sync-upstream.sh replaces skills/
// wholesale, and nothing else notices when a release adds, removes or renames a
// skill — leaving /sci quoting stale token counts and stranding new skills in no
// profile, silently, for every user who has applied one.
//
// Requires Node >= 22.18 (native TypeScript type stripping) to read the .ts
// modules under extensions/. Deliberately does NOT require pi: this is the
// pre-publish gate and must run anywhere, unlike the test suites. It will use
// python3 + tiktoken for the token-estimate check if both happen to be on
// PATH, but never requires either — see checkTokenEstimate's fallback.
//
// Usage: node scripts/validate.mjs  (or: npm run validate)
// Exit codes: 0 = OK, 1 = hard failure, 2 = usage error.
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");

// The parser is shared with `search.ts`, which reads the same frontmatter at
// runtime to build the sci_find catalogue. Two copies would drift, and the
// drift would be invisible: validation would pass on files the runtime read
// differently. Importing it here also exercises it against every real
// SKILL.md file on every release, including the block-scalar cases it exists
// for.
const { parseFrontmatter } = await import(
  pathToFileURL(join(root, "extensions", "frontmatter.ts")).href
).catch((error) => {
  console.error(`FAIL: cannot import extensions/frontmatter.ts (${error?.message ?? error}).`);
  console.error("Node >= 22.18 is required to strip TypeScript types.");
  process.exit(1);
});

function collectSkills(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!statSync(p).isDirectory()) continue;
    const skillMd = join(p, "SKILL.md");
    try {
      statSync(skillMd);
      out.push({ name: entry, path: skillMd });
    } catch {
      /* not a skill dir */
    }
  }
  return out;
}

const nameRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const problems = { hard: [], warn: [] };
let count = 0;
/**
 * The system-prompt index, as `"<name>: <description>"` per skill — the exact
 * corpus shape `sci_find` builds at runtime (`search.ts`'s `loadCatalog`) and
 * the one the token estimate is calibrated against. Skills with no
 * description are absent here too: pi never prompts them, so they cost
 * nothing to count.
 */
const corpus = [];
/** Skills pi would hide from the prompt but still serve to `/skill:` (informational). */
let modelInvocationDisabled = 0;

for (const skill of collectSkills(skillsDir)) {
  count++;
  const text = readFileSync(skill.path, "utf8");
  const fm = parseFrontmatter(text);

  if (!fm) {
    problems.hard.push(`${skill.name}: no YAML frontmatter`);
    continue;
  }

  // Per pi's rules only a missing description is fatal; every name violation —
  // including absence — is a warning, and pi still loads the skill.
  if (!fm.name) {
    problems.warn.push(`${skill.name}: missing 'name'`);
  } else if (fm.name.length > 64 || !nameRe.test(fm.name)) {
    problems.warn.push(
      `${skill.name}: name '${fm.name}' violates pi rules (≤64 chars, [a-z0-9-], no leading/trailing/consecutive hyphens)`,
    );
  }

  if (!fm.description) {
    problems.hard.push(`${skill.name}: missing 'description' (pi will not load it)`);
  } else if (fm.description.length > 1024) {
    problems.warn.push(`${skill.name}: description ${fm.description.length} chars > 1024 (warning only)`);
  }

  if (fm.description) corpus.push(`${fm.name ?? skill.name}: ${fm.description}`);

  // Three invariants the /skill: input hook depends on. All content-dependent,
  // and sync-upstream.sh replaces content wholesale, so a release is exactly
  // when they would break — silently, unless checked here.
  //
  // The hook keys on the directory name (search.ts), while pi names a skill
  // `frontmatter.name || basename(dirname(filePath))`. If they disagree, the
  // hook emits a different name= attribute than pi would for the same skill.
  if (fm.name && fm.name !== skill.name) {
    problems.hard.push(
      `${skill.name}: frontmatter name '${fm.name}' differs from its directory — ` +
        `/skill:${skill.name} would be wrapped under a name pi never uses`,
    );
  }
  // pi's parser for the wrapped block is a non-greedy match on these tags, so
  // a body containing either would end the block early and dump the raw file.
  if (/<\/skill>|<skill /.test(text)) {
    problems.hard.push(`${skill.name}: body contains a <skill> tag, which would truncate its /skill: block`);
  }
  if (/^disable-model-invocation:\s*true/m.test(text)) modelInvocationDisabled++;
}

// ---------------------------------------------------------------------------
// extensions/profiles.ts vs. skills/ on disk
// ---------------------------------------------------------------------------

const profilesPath = join(root, "extensions", "profiles.ts");

async function loadProfiles() {
  try {
    return await import(pathToFileURL(profilesPath).href);
  } catch (error) {
    problems.hard.push(
      `extensions/profiles.ts could not be imported (${error?.message ?? error}). ` +
        `Node >= 22.18 is required to strip TypeScript types.`,
    );
    return null;
  }
}

function validateProfiles(mod, onDisk) {
  const skillDirs = new Set(onDisk);

  if (mod.TOTAL_SKILL_COUNT !== onDisk.length) {
    problems.hard.push(
      `profiles.ts TOTAL_SKILL_COUNT is ${mod.TOTAL_SKILL_COUNT} but skills/ holds ` +
        `${onDisk.length} skills — every /sci token figure is wrong until this is updated`,
    );
  }

  const assigned = new Set();
  for (const profile of mod.PROFILES) {
    const seen = new Set();
    for (const skill of profile.skills) {
      if (seen.has(skill)) problems.hard.push(`profile '${profile.id}' lists '${skill}' twice`);
      seen.add(skill);
      if (!skillDirs.has(skill)) {
        problems.hard.push(`profile '${profile.id}' lists '${skill}', which has no skills/${skill}/SKILL.md`);
      }
      assigned.add(skill);
    }
  }

  for (const { skill } of mod.UNASSIGNED) {
    if (!skillDirs.has(skill)) {
      problems.hard.push(`UNASSIGNED lists '${skill}', which has no skills/${skill}/SKILL.md`);
    }
    if (assigned.has(skill)) {
      problems.hard.push(`'${skill}' is in both a profile and UNASSIGNED — pick one`);
    }
    assigned.add(skill);
  }

  for (const skill of mod.STANDALONE_SKILL_IDS) {
    if (!skillDirs.has(skill)) {
      problems.hard.push(`STANDALONE_SKILL_IDS lists '${skill}', which has no skills/${skill}/SKILL.md`);
    }
  }

  // Toggle ids are persisted in the user's config, so a collision would make a
  // saved selection mean two different things.
  const ids = mod.TOGGLES.map((toggle) => toggle.id);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) problems.hard.push(`duplicate toggle id '${id}'`);

  const orphans = onDisk.filter((skill) => !assigned.has(skill));
  for (const skill of orphans) {
    problems.hard.push(
      `skills/${skill} is in no profile and no UNASSIGNED entry — /sci users would never see it`,
    );
  }

  console.log(
    `Validated profiles.ts: ${mod.PROFILES.length} profiles, ${assigned.size}/${onDisk.length} skills accounted for`,
  );
}

// ---------------------------------------------------------------------------
// extensions/package-info.ts vs. package.json
// ---------------------------------------------------------------------------

/**
 * The extension keeps its own name and version as constants so the upgrade
 * notice cannot fail on a file read. The price is drift, and drift here is
 * silent in the worst way: a stale PACKAGE_VERSION suppresses the "what
 * changed" notice for every user, which is the one promise a release makes.
 */
async function validatePackageInfo() {
  let info;
  try {
    info = await import(pathToFileURL(join(root, "extensions", "package-info.ts")).href);
  } catch (error) {
    problems.hard.push(`extensions/package-info.ts could not be imported (${error?.message ?? error})`);
    return;
  }

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  if (info.PACKAGE_VERSION !== manifest.version) {
    problems.hard.push(
      `package-info.ts PACKAGE_VERSION is "${info.PACKAGE_VERSION}" but package.json says ` +
        `"${manifest.version}" — existing users would get no upgrade notice for this release`,
    );
  }
  if (info.PACKAGE_NAME !== manifest.name) {
    problems.hard.push(
      `package-info.ts PACKAGE_NAME is "${info.PACKAGE_NAME}" but package.json says "${manifest.name}" — ` +
        `/sci looks the package up in settings.json by this name and would find nothing`,
    );
  }

  if (!/^[0-9a-f]{40}$/.test(manifest.upstreamCommit ?? "")) {
    problems.hard.push(
      `package.json "upstreamCommit" is "${manifest.upstreamCommit}", not a 40-hex-char commit SHA — ` +
        `re-run \`npm run sync:upstream\``,
    );
  }
}

// ---------------------------------------------------------------------------
// LICENSE.md vs. package.json's recorded hash
// ---------------------------------------------------------------------------

/**
 * sync-upstream.sh copies LICENSE.md byte-identical from upstream and records
 * its sha256 in package.json. A hand-edit to either file — reformatting the
 * license, or a stale hash left over from before a re-sync — is exactly the
 * kind of drift nothing else here would notice.
 */
function validateLicenseSha256() {
  const licensePath = join(root, "LICENSE.md");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  let actual;
  try {
    actual = createHash("sha256").update(readFileSync(licensePath)).digest("hex");
  } catch (error) {
    problems.hard.push(`could not read ${licensePath} to check its recorded hash (${error?.message ?? error})`);
    return;
  }

  if (manifest.licenseSha256 !== actual) {
    problems.hard.push(
      `package.json "licenseSha256" is "${manifest.licenseSha256}" but LICENSE.md actually hashes to ` +
        `"${actual}" — re-run \`npm run sync:upstream\` or restore the recorded LICENSE.md`,
    );
  }
}

// ---------------------------------------------------------------------------
// Excluded skills must never reappear under skills/
// ---------------------------------------------------------------------------

/**
 * sync-upstream.sh strips these names after every sync, but that is the only
 * protection today — a manual `cp` from an upstream checkout bypasses it
 * entirely. See scripts/excluded-skills.txt for why they are excluded.
 */
function validateExcludedSkills(onDisk) {
  const excludedPath = join(root, "scripts", "excluded-skills.txt");
  let excluded;
  try {
    excluded = readFileSync(excludedPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    problems.hard.push(`could not read ${excludedPath} (${error?.message ?? error})`);
    return;
  }

  const onDiskSet = new Set(onDisk);
  for (const skill of excluded) {
    if (onDiskSet.has(skill)) {
      problems.hard.push(
        `skills/${skill} exists but is listed in scripts/excluded-skills.txt — ` +
          `it must not be redistributed (see that file for why)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// extensions/aliases.ts vs. skills/ on disk
// ---------------------------------------------------------------------------

/**
 * An alias naming a skill that no longer exists is inert but harmful: the query
 * it was written for silently loses its best match, and nothing surfaces that.
 * sync-upstream.sh replaces skills/ wholesale, so this is exactly the kind of
 * breakage a release introduces without touching extensions/.
 */
async function validateAliases(onDisk) {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, "extensions", "aliases.ts")).href);
  } catch (error) {
    problems.hard.push(`extensions/aliases.ts could not be imported (${error?.message ?? error})`);
    return;
  }

  const skillDirs = new Set(onDisk);
  const triggers = new Set();
  const allowlist = new Set((mod.SHORT_TRIGGER_ALLOWLIST ?? []).map((entry) => entry.toLowerCase()));
  const shortTriggersUsed = new Set();
  let targets = 0;

  for (const alias of mod.ALIASES) {
    if (!alias.match?.length) {
      problems.hard.push(`an alias entry has no "match" phrases, so it can never fire`);
      continue;
    }
    for (const phrase of alias.match) {
      const key = phrase.toLowerCase();
      // Duplicate triggers double-count their boost, quietly distorting ranking.
      if (triggers.has(key)) problems.hard.push(`alias phrase "${phrase}" is listed twice`);
      triggers.add(key);

      // search.ts matches triggers as whole words, which makes a short trigger
      // safe — but only deliberately, via SHORT_TRIGGER_ALLOWLIST.
      const compacted = key.replace(/[^a-z0-9]/g, "");
      if (compacted.length < 5) {
        if (!allowlist.has(compacted)) {
          problems.hard.push(
            `alias phrase "${phrase}" compacts to "${compacted}" (< 5 chars) and is not in ` +
              `SHORT_TRIGGER_ALLOWLIST — a new short trigger must be added there deliberately`,
          );
        }
        shortTriggersUsed.add(compacted);
      }
    }
    if (!alias.terms?.length && !alias.skills?.length) {
      problems.hard.push(`alias "${alias.match[0]}" expands to nothing`);
    }
    for (const skill of alias.skills ?? []) {
      targets++;
      if (!skillDirs.has(skill)) {
        problems.hard.push(`alias "${alias.match[0]}" names '${skill}', which has no skills/${skill}/SKILL.md`);
      }
    }
  }

  for (const entry of allowlist) {
    if (!shortTriggersUsed.has(entry)) {
      problems.hard.push(`SHORT_TRIGGER_ALLOWLIST lists "${entry}", which no alias trigger uses`);
    }
  }

  console.log(`Validated aliases.ts: ${mod.ALIASES.length} rules, ${targets} skill targets`);
}

// ---------------------------------------------------------------------------
// README's own numbers vs. what is actually true
// ---------------------------------------------------------------------------

/**
 * README.md quotes the skill count and the run-record count in prose. Neither
 * is derived at render time, so each is exactly the kind of number that a
 * `skills/` sync or a new ledger run makes stale without anything else
 * noticing — same failure mode `doc-count.mjs` guards for the test suites,
 * applied to the two catalogue-level claims that live here instead.
 *
 * "37 skills have been run" is excluded from the general count (it is not a
 * claim about the catalogue size) and checked on its own, against
 * `testing/ledger.json`'s unique PASS skills.
 */
function validateReadmeCounts(onDiskCount) {
  const readmePath = join(root, "README.md");
  const readme = readFileSync(readmePath, "utf8");

  const catalogueMatches = [...readme.matchAll(/(\d+) skills\b(?! have been run)/g)];
  if (catalogueMatches.length === 0) {
    problems.hard.push(`README.md no longer says "N skills" anywhere — the catalogue-size claim has gone missing`);
  }
  for (const match of catalogueMatches) {
    const claimed = Number(match[1]);
    if (claimed !== onDiskCount) {
      problems.hard.push(
        `README.md claims "${claimed} skills" but skills/ holds ${onDiskCount} — ` +
          `re-run \`npm run sync:upstream\` notes or fix the prose`,
      );
    }
  }

  const ranMatch = readme.match(/(\d+) skills have been run/);
  if (!ranMatch) {
    problems.hard.push(`README.md no longer says "N skills have been run" — the run-record claim has gone missing`);
  } else {
    const ledgerPath = join(root, "testing", "ledger.json");
    let uniquePass;
    try {
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      uniquePass = new Set(
        ledger.runs.filter((run) => run.verdict === "PASS").map((run) => run.skill),
      ).size;
    } catch (error) {
      problems.hard.push(`could not read ${ledgerPath} to check the run-record claim (${error?.message ?? error})`);
      return;
    }
    const claimed = Number(ranMatch[1]);
    if (claimed !== uniquePass) {
      problems.hard.push(
        `README.md claims "${claimed} skills have been run" but testing/ledger.json has ` +
          `${uniquePass} unique PASS skills`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TOKENS_PER_SKILL ratchet
// ---------------------------------------------------------------------------

/**
 * Chars per token, measured 2026-09-19 over the real catalogue's corpus (161
 * skills then, 162 at the 2026-09-21 sync — a dated record, not a live
 * count), "<name>: <description>" each: 66,921 chars, 14,100 tokens under
 * tiktoken's cl100k_base (4.75 chars/token) and 13,987 under o200k_base (4.79
 * chars/token). Used only as a fallback, when python3 or tiktoken is
 * unavailable — see checkTokenEstimate.
 */
const CHARS_PER_TOKEN = 4.75;
/** Drift below this is noise in a hand-calibrated estimate; above it, /sci lies. */
const DRIFT_TOLERANCE = 0.1;

/**
 * Real tiktoken count via python3, or undefined if python3 is missing,
 * tiktoken is not importable, or it does not answer within TIKTOKEN_TIMEOUT_MS
 * (a first-run encoding download can block on a sandboxed network — this must
 * degrade to the fallback, never hang the validator).
 *
 * The corpus (~65KB) goes on stdin as JSON, never on argv — but as a
 * file-backed descriptor, not a `spawnSync({ input })` pipe: that corpus
 * exceeds the OS pipe buffer (64KB), and `spawnSync` writing it in chunks can
 * wedge against a child that has not yet reached `sys.stdin.read()`, hanging
 * both sides. A file has no buffer to fill, so the child gets EOF regardless
 * of when it starts reading.
 */
const TIKTOKEN_TIMEOUT_MS = 10_000;

function tiktokenTokenCount(corpus) {
  const script =
    "import json, sys\n" +
    "import tiktoken\n" +
    "corpus = json.load(sys.stdin)\n" +
    'enc = tiktoken.get_encoding("cl100k_base")\n' +
    "print(sum(len(enc.encode(s)) for s in corpus))\n";

  const dir = mkdtempSync(join(tmpdir(), "pi-scientific-skills-tokens-"));
  const corpusPath = join(dir, "corpus.json");
  writeFileSync(corpusPath, JSON.stringify(corpus));

  let result;
  try {
    const fd = openSync(corpusPath, "r");
    try {
      result = spawnSync("python3", ["-c", script], {
        stdio: [fd, "pipe", "pipe"],
        encoding: "utf8",
        timeout: TIKTOKEN_TIMEOUT_MS,
      });
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (!result || result.error || result.signal || result.status !== 0) return undefined;
  const tokens = Number((result.stdout ?? "").trim());
  return Number.isFinite(tokens) ? tokens : undefined;
}

/**
 * TOKENS_PER_SKILL has to stay a constant — the picker needs a cost for a
 * selection synchronously, before anything is on disk to measure. But upstream
 * rewrites descriptions, and every /sci figure is derived from this one
 * number, so a silent 30% drift would turn honest guidance into confident
 * nonsense. Warn rather than fail: the number is an estimate by construction.
 *
 * Prefers a real count from python3 + tiktoken (cl100k_base); falls back to
 * the hand-calibrated CHARS_PER_TOKEN ratio whenever tiktoken is not
 * importable (no python3, or python3 without the package) — the common case
 * on a machine that never installed it for this repo.
 */
function checkTokenEstimate(profiles, promptCorpus) {
  if (!profiles || promptCorpus.length === 0) return;

  const chars = promptCorpus.reduce((sum, entry) => sum + entry.length, 0);
  const tiktokenTokens = tiktokenTokenCount(promptCorpus);
  const mode = tiktokenTokens !== undefined ? "tiktoken cl100k_base" : "chars-per-token fallback";
  const measured =
    tiktokenTokens !== undefined
      ? tiktokenTokens / promptCorpus.length
      : chars / promptCorpus.length / CHARS_PER_TOKEN;

  const drift = Math.abs(measured - profiles.TOKENS_PER_SKILL) / profiles.TOKENS_PER_SKILL;
  const summary =
    `TOKENS_PER_SKILL is ${profiles.TOKENS_PER_SKILL}; skills/ now measures ${measured.toFixed(1)} ` +
    `via ${mode} (${(drift * 100).toFixed(1)}% drift)`;

  if (drift > DRIFT_TOLERANCE) {
    problems.warn.push(`${summary} — update it in profiles.ts, or every /sci figure is off by that much`);
  } else {
    console.log(`Validated token estimate: ${summary}`);
  }
}

const onDiskNames = collectSkills(skillsDir).map((skill) => skill.name);
const profiles = await loadProfiles();
if (profiles) validateProfiles(profiles, onDiskNames);
await validateAliases(onDiskNames);
await validatePackageInfo();
validateLicenseSha256();
validateExcludedSkills(onDiskNames);
checkTokenEstimate(profiles, corpus);
validateReadmeCounts(onDiskNames.length);

console.log(`Validated ${count} skills in ${skillsDir}`);
console.log(`  ${modelInvocationDisabled} declare disable-model-invocation (pi hides those from the prompt only)`);
for (const p of problems.warn) console.log(`  [warn] ${p}`);
for (const p of problems.hard) console.log(`  [FAIL] ${p}`);

console.log(
  `\n${count} skills, ${problems.warn.length} warning(s), ${problems.hard.length} hard issue(s)`,
);
process.exit(problems.hard.length > 0 ? 1 : 0);
