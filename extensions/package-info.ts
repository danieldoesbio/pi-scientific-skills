/**
 * The package's own identity, as the extension needs it at runtime.
 *
 * These duplicate `package.json`. That is deliberate: the extension is loaded
 * by jiti from wherever pi installed it, and reading `../package.json` at
 * startup would make the upgrade notice — a promise that any change is stated
 * on first load — depend on a file read that can fail. A constant cannot fail.
 *
 * The cost of a constant is drift, so `scripts/validate.mjs` hard-fails when
 * either value disagrees with `package.json`. Bump both together, or the
 * release does not build.
 */

export const PACKAGE_NAME = "pi-scientific-skills";

/**
 * Compared against a user's stored `lastSeenVersion` to decide whether they are
 * owed an upgrade notice, so it must change on every release that changes
 * behaviour — including patch releases.
 */
export const PACKAGE_VERSION = "1.1.0";

/**
 * Inert default export. Everything under `extensions/` is reachable by pi's
 * extension loader, which expects a factory; a module without one is an error
 * in pi's log even though nothing imports it as an extension.
 */
export default function noopExtension(): void {}
