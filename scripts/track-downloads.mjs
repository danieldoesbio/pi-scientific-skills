#!/usr/bin/env node
// Append npm daily download counts to metrics/downloads.json.
//
// Why keep a local copy of a public API's numbers: npm's range endpoint serves
// at most 18 months, counts for the last day or two keep moving as CDN logs
// settle, and there is no way to ask it "what did you say last week". An
// on-device ledger makes the series durable and makes revisions visible.
//
// Read the numbers with care. npm counts tarball fetches, so mirrors, CI caches
// and registry scrapers all land in the same bucket as people. A publish-day
// spike is almost always automated traffic, not adoption.
//
// Usage:
//   node scripts/track-downloads.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
//
// Default range is the last 60 days. Re-running is safe: days are merged by
// date, and a changed count is recorded as a revision rather than overwritten
// silently. The last 2 days are always refetched, since they are still settling.
//
// Exit codes: 0 = OK, 1 = fetch failed, 2 = usage error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
const outPath = join(root, "metrics", "downloads.json");

function die(msg, code = 2) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

const opts = { dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i] ?? die(`${a} needs a value`);
  if (a === "--from") opts.from = next();
  else if (a === "--to") opts.to = next();
  else if (a === "--dry-run") opts.dryRun = true;
  else die(`unknown argument: ${a}`);
}

const today = new Date();
const to = opts.to ?? ymd(today);
const from = opts.from ?? ymd(new Date(today.getTime() - 60 * 86400000));
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) die("dates must be YYYY-MM-DD");

const url = `https://api.npmjs.org/downloads/range/${from}:${to}/${pkgName}`;
const res = await fetch(url);
if (!res.ok) die(`npm returned ${res.status} for ${url}`, 1);
const body = await res.json();
if (!Array.isArray(body.downloads)) die(`unexpected response shape from ${url}`, 1);

// Publish dates make the series readable: without them a spike is just a spike.
// Both 1.0.0 and 1.0.1 landed on 2026-08-06, the same day as the 242 peak.
let releases = {};
const meta = await fetch(`https://registry.npmjs.org/${pkgName}`);
if (meta.ok) {
  const time = (await meta.json()).time ?? {};
  releases = Object.fromEntries(
    Object.entries(time)
      .filter(([v]) => v !== "created" && v !== "modified")
      .map(([v, iso]) => [v, iso.slice(0, 10)]),
  );
} else {
  console.error(`warning: could not fetch publish dates (${meta.status}); series will lack release markers`);
}

const ledger = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {
      schemaVersion: 1,
      package: pkgName,
      source: "https://api.npmjs.org/downloads/range/{from}:{to}/{package}",
      caveat:
        "npm counts tarball fetches, not installs by people. Mirrors, CI caches and registry " +
        "scrapers are included and cannot be separated out. Treat publish-day spikes as automated " +
        "traffic. The most recent 1-2 days are provisional and routinely revised upward.",
      days: {},
      revisions: [],
    };

const fetchedAt = ymd(today);
let added = 0;
const revisions = [];

for (const { day, downloads } of body.downloads) {
  const prev = ledger.days[day];
  if (prev === undefined) {
    ledger.days[day] = downloads;
    added++;
  } else if (prev !== downloads) {
    // Keep both numbers. A silently-corrected series is worse than no series:
    // it hides that the recent tail is provisional.
    revisions.push({ day, from: prev, to: downloads, seenAt: fetchedAt });
    ledger.days[day] = downloads;
  }
}

ledger.lastFetched = fetchedAt;
if (Object.keys(releases).length) ledger.releases = releases;
ledger.revisions.push(...revisions);
ledger.days = Object.fromEntries(Object.entries(ledger.days).sort(([a], [b]) => a.localeCompare(b)));

const values = Object.values(ledger.days);
const total = values.reduce((a, b) => a + b, 0);
const nonZeroDays = values.filter((v) => v > 0).length;
const peak = Object.entries(ledger.days).reduce((best, e) => (e[1] > best[1] ? e : best), ["", 0]);
const last7 = Object.entries(ledger.days).slice(-7);

console.log(`${pkgName}: ${total} downloads across ${values.length} recorded days (${nonZeroDays} non-zero)`);
console.log(`peak: ${peak[1]} on ${peak[0]}`);
console.log(`last 7 recorded days: ${last7.map(([d, n]) => `${d.slice(5)}=${n}`).join(" ")}`);
if (added) console.log(`added ${added} new day(s)`);
for (const r of revisions) console.log(`revised ${r.day}: ${r.from} -> ${r.to}`);
if (!added && !revisions.length) console.log("no change");

if (opts.dryRun) {
  console.log("(--dry-run: nothing written)");
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`wrote ${outPath}`);
