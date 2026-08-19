// The README states exactly how many checks each suite runs. Prose numbers rot
// the moment a test is added — this session added five and the README still
// said 44 — and a rotted number is a promise the package quietly stopped
// keeping. So each suite verifies its own claim, failing in the suite whose
// count actually moved rather than in some distant linter.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

/**
 * @param {string} phrase Literal README wording following the number, e.g. "ranking checks".
 * @param {number} actual How many checks this run actually made.
 * @returns {string[]} Zero or one problem, ready to push into a suite's `failures`.
 */
export function documentedCount(phrase, actual) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = readFileSync(README, "utf8").match(new RegExp(`(\\d+) ${escaped}`));
  if (!match) {
    return [`README no longer says "N ${phrase}" — the count this suite guards has gone missing`];
  }
  const claimed = Number(match[1]);
  return claimed === actual ? [] : [`README claims ${claimed} ${phrase}; this run made ${actual}`];
}
