#!/usr/bin/env node
// Type-checks extensions/*.ts against pi's own shipped declarations.
//
// Node strips TypeScript syntax at load time (see lib/load-extension.mjs) but
// never checks types — a wrong argument count to `ctx.ui.select` loads and
// runs today, and only throws at the call site pi actually reaches. This runs
// real `tsc` against pi's `.d.ts` files instead of a hand-rolled stub, so the
// checked surface is what an installed pi actually exposes.
//
// TypeScript itself is not a dependency of this package (no lockfile, no
// node_modules — see the CI workflow's own comment on that). `npx --yes`
// downloads it into npm's cache on first run and reuses it after, which is
// why this is its own script and its own CI step rather than folded into
// `npm test`.
//
// Usage: node scripts/typecheck.mjs  (or: npm run typecheck)
// Exit codes: passes through tsc's own (0 = OK, 1 usually = type errors).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findPiDist } from "./lib/load-extension.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

const piDist = findPiDist();
if (!piDist) {
  console.error("FAIL: pi is not on PATH and PI_DIST is unset — nothing to type-check against.");
  process.exit(1);
}
// findPiDist() returns .../pi-coding-agent/dist; the declarations and the
// vendored typebox/@types live one level up, at the package root.
const piRoot = dirname(piDist);

/**
 * @param {string} piRoot pi's package root (one level above its `dist/`).
 * @param {string} rootDir this repo's root, for the absolute `include` glob.
 */
const buildTsconfig = (piRoot, rootDir) => ({
  compilerOptions: {
    noEmit: true,
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    // Load-bearing: without this, pi's vendored @anthropic-ai/sdk and
    // @google/genai declarations produce spurious TS2307s unrelated to
    // anything this package's extensions actually import.
    skipLibCheck: true,
    types: ["node"],
    // Pins @types/node to pi's own copy. A stray ~/node_modules/@types/node
    // must not be picked up instead — it would check against a different
    // Node version's globals than the one pi actually runs on.
    typeRoots: [join(piRoot, "node_modules", "@types")],
    baseUrl: ".",
    paths: {
      "@earendil-works/pi-coding-agent": [join(piRoot, "dist", "index.d.ts")],
      typebox: [join(piRoot, "node_modules", "typebox", "build", "index.d.mts")],
      "typebox/*": [join(piRoot, "node_modules", "typebox", "build", "*", "index.d.mts")],
    },
  },
  include: [join(rootDir, "extensions", "*.ts")],
});

const tmp = mkdtempSync(join(tmpdir(), "sci-typecheck-"));
try {
  const tsconfigPath = join(tmp, "tsconfig.json");
  writeFileSync(tsconfigPath, JSON.stringify(buildTsconfig(piRoot, ROOT), null, 2));

  execFileSync("npx", ["--yes", "-p", "typescript@5", "tsc", "-p", tsconfigPath], {
    stdio: "inherit",
  });
  console.log("PASS — extensions/*.ts type-check clean against pi's declarations");
} catch (error) {
  // execFileSync throws on a non-zero exit; tsc has already printed its own
  // errors to inherited stdio, so there is nothing useful to add here.
  process.exitCode = typeof error.status === "number" ? error.status : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
