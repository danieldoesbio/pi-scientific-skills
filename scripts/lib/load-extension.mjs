// Load this package's extension the way pi loads it.
//
// Not a convenience wrapper: raw `node --experimental-strip-types` CANNOT load
// extensions/index.ts at all. Pi uses jiti (dist/core/extensions/loader.js),
// which resolves extensionless relative imports (`from "./profiles"`) and
// aliases the host packages an extension may import (`typebox`,
// `@earendil-works/pi-*`). A test that bypassed jiti would be testing a module
// graph that never runs in production.
//
// Pi is discovered on PATH rather than depended on: this package declares those
// as peerDependencies and has no node_modules of its own. Under `npm run` that
// PATH is not the user's shell PATH — see `shellPath()`.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

/**
 * PATH with the `node_modules/.bin` entries npm injects for ancestor
 * directories removed.
 *
 * `npm run` prepends `<dir>/node_modules/.bin` for the project directory AND
 * every ancestor up to `/`. A stray install in a parent directory (say a
 * `~/node_modules/@earendil-works/pi-coding-agent` left behind by an unrelated
 * `npm install` in `$HOME`) then shadows the `pi` the user actually runs from
 * their shell, and the suites silently test against the wrong version. Only
 * this package's own `node_modules/.bin` keeps its entry.
 */
function shellPath() {
  const ownBin = join(ROOT, "node_modules", ".bin");
  const injected = join("node_modules", ".bin");
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry === ownBin || !entry.endsWith(injected))
    .join(delimiter);
}

/** Absolute path to the installed pi's `dist/`, or undefined if pi isn't on PATH. */
export function findPiDist() {
  if (process.env.PI_DIST && existsSync(process.env.PI_DIST)) return process.env.PI_DIST;
  try {
    // `command -v` is a shell builtin, so invoke the shell directly rather
    // than via execFileSync's `shell` option (which concatenates unescaped).
    const bin = execFileSync("/bin/sh", ["-c", "command -v pi"], {
      encoding: "utf8",
      env: { ...process.env, PATH: shellPath() },
    }).trim();
    if (!bin) return undefined;
    return unbundledDist(dirname(realpathSync(bin)));
  } catch {
    return undefined;
  }
}

/**
 * Since pi 0.84.x the `pi` binary is `dist/bundle/cli.js`, a single-file build
 * with no `core/` beside it. The suites import `core/*.js` by path, so resolve
 * to the unbundled `dist/` one level up when that is where `core/` lives.
 */
function unbundledDist(dir) {
  const hasCore = (candidate) => existsSync(join(candidate, "core", "agent-session.js"));
  if (hasCore(dir)) return dir;
  const parent = dirname(dir);
  return hasCore(parent) ? parent : dir;
}

/**
 * Rebuild the alias map pi hands to jiti (`getAliases`, loader.js:64-112).
 * Only the entries an extension in this package can actually import are
 * reproduced; the rest would be dead weight in a test harness.
 */
function buildAliases(piDist) {
  const piRequire = createRequire(join(piDist, "cli.js"));
  const aliases = { "@earendil-works/pi-coding-agent": join(piDist, "index.js") };
  for (const specifier of ["typebox", "typebox/compile", "typebox/value"]) {
    try {
      aliases[specifier] = piRequire.resolve(specifier);
    } catch {
      /* older pi without that subpath — leave it unaliased */
    }
  }
  aliases["@sinclair/typebox"] = aliases.typebox;
  return aliases;
}

/**
 * @param {string} relativePath e.g. "extensions/index.ts"
 * @returns the module's exports, or throws with a message naming the cause.
 */
export async function loadExtensionModule(relativePath) {
  const piDist = findPiDist();
  if (!piDist) {
    throw new Error(
      "pi was not found on PATH and PI_DIST is unset — cannot load extensions the way pi does.",
    );
  }

  const piRequire = createRequire(join(piDist, "cli.js"));
  // `jiti/static` is the entrypoint pi's loader uses. It is exported under the
  // "import" condition only, so it cannot be `require`d and cannot be reached
  // by bare specifier from this file — locate the package through its own
  // exported package.json and import the file directly.
  const jitiRoot = dirname(piRequire.resolve("jiti/package.json"));
  const { createJiti } = await import(pathToFileURL(join(jitiRoot, "lib", "jiti-static.mjs")).href);

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: buildAliases(piDist),
  });

  return jiti.import(join(ROOT, relativePath), {});
}
