/**
 * The package's own identity, as the extension needs it at runtime.
 *
 * These duplicate `package.json` on purpose. pi loads the extension with jiti
 * from wherever it installed the package, and reading `../package.json` at
 * startup would make the upgrade notice (a promise that any change is stated
 * on first load) depend on a file read that can fail. A constant cannot fail.
 *
 * The cost is drift, so `scripts/validate.mjs` (the first step of `npm test`)
 * hard-fails when either value disagrees with `package.json`. Bump both
 * together.
 */

export const PACKAGE_NAME = "pi-scientific-skills";

/**
 * Compared against a user's stored `lastSeenVersion` to decide whether they are
 * owed an upgrade notice, so it must change on every release that changes
 * behaviour, patch releases included.
 */
export const PACKAGE_VERSION = "1.8.0";

/**
 * Inert default export. Everything under `extensions/` is reachable by pi's
 * extension loader, which expects a factory; a module without one is an error
 * in pi's log, even though nothing imports it as an extension.
 */
export default function noopExtension(): void {}
