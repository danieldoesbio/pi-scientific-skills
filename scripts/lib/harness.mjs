// Shared pass/fail counter for the test suites under scripts/.
//
// Five suites (test-extension.mjs, test-search.mjs, test-filter.mjs,
// test-skill-expand.mjs, test-frontmatter.mjs) each grew the same
// check-count-report-exit shape independently. This is that shape, factored
// out once each suite's own console-output quirks are accounted for:
//
//   - test-extension.mjs prints "ok" on every success. The other suites print
//     nothing on success (a summary line instead), so `check`'s ok-line is
//     optional via `{ quiet: true }`.
//   - test-skill-expand.mjs and test-frontmatter.mjs read the running total
//     mid-run ("483/483 identical") before `finish()` is ever called, so
//     `checks` is a live getter and `failures` is the real array — not copies
//     `finish()` assembles at the end.
//   - test-filter.mjs and test-search.mjs print their own bespoke per-check
//     lines ("→ 13 enabled", "ok #3  query → skill") that don't fit `check`'s
//     fixed format, so `record` counts and files a failure without printing
//     anything, leaving the call site free to log however it already does.
//
// Usage: node scripts/whatever.mjs  (or: npm test)
// Exit codes: 0 = OK, 1 = failures.
import { documentedCount } from "../doc-count.mjs";

/**
 * @param {string} phrase Literal README wording following the check count,
 *   e.g. "ranking checks" — passed straight through to `documentedCount`.
 */
export function createSuite(phrase) {
  const failures = [];
  let checks = 0;

  /**
   * @param {string} label
   * @param {boolean} condition
   * @param {string} [detail] Extra context, shown only on failure.
   * @param {{ quiet?: boolean }} [options] `quiet: true` suppresses the "ok" line.
   */
  const check = (label, condition, detail = "", { quiet = false } = {}) => {
    checks++;
    if (condition) {
      if (!quiet) console.log(`  ok      ${label}`);
    } else {
      failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
      console.log(`  FAIL    ${label}${detail ? `\n          ${detail}` : ""}`);
    }
  };

  /**
   * Count one check without printing anything — for a loop that reports its
   * own way. `message` is filed into `failures` only when `ok` is false.
   */
  const record = (ok, message) => {
    checks++;
    if (!ok) failures.push(message);
  };

  const finish = () => {
    failures.push(...documentedCount(phrase, checks));
    console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} problem(s)`);
    for (const failure of failures) console.log(`  [FAIL] ${failure}`);
    process.exit(failures.length > 0 ? 1 : 0);
  };

  return {
    check,
    record,
    failures,
    finish,
    get checks() {
      return checks;
    },
  };
}
