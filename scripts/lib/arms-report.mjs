// The pre-registered analysis of a find-live-arms run
// (testing/runs/2026-09-25-night-arms.md, scripts/find-live-arms-report.mjs):
// the analysis set, and paired statistics for two arms graded on the same
// probes.

export const Z95 = 1.959963984540054;

/** Wilson score interval for x successes in n. */
export function wilson(x, n, z = Z95) {
  const p = x / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [centre - half, centre + half];
}

/**
 * 95% CI for p1 − p2 on paired binary data: Newcombe (1998) method 10, the
 * hybrid score interval without continuity correction. a = both succeed,
 * b = only the first, c = only the second, d = neither. φ is taken as 0 when
 * a margin is empty.
 */
export function newcombePaired(a, b, c, d, z = Z95) {
  const n = a + b + c + d;
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const [l1, u1] = wilson(a + b, n, z);
  const [l2, u2] = wilson(a + c, n, z);
  const margins = (a + b) * (c + d) * (a + c) * (b + d);
  const phi = margins === 0 ? 0 : (a * d - b * c) / Math.sqrt(margins);
  const below = Math.sqrt((p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2);
  const above = Math.sqrt((u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2);
  return [p1 - p2 - below, p1 - p2 + above];
}

/** McNemar's exact test, two-sided: a binomial test of b against b + c at 1/2. */
export function mcnemarExact(b, c) {
  const m = b + c;
  if (m === 0) return 1;
  let tail = 0;
  let term = 0.5 ** m;
  for (let k = 0; k <= Math.min(b, c); k++) {
    tail += term;
    term = (term * (m - k)) / (k + 1);
  }
  return Math.min(1, 2 * tail);
}

/** Pair counts {a, b, c, d} over `ids` for two predicates. */
export function pairCounts(ids, first, second) {
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  for (const id of ids) {
    const key = first(id) ? (second(id) ? "a" : "b") : second(id) ? "c" : "d";
    counts[key]++;
  }
  return counts;
}

export const HARNESS_ERRORS = new Set(["no-run", "supervisor-error"]);

/**
 * The analysis set. `order`: [{chunk, id}] from order.tsv; `rows`: one Map
 * (probe id → last results line) per arm. A chunk counts only when every
 * probe in it has a line in every arm. A probe with a harness error in any
 * arm then leaves the set in all arms.
 */
export function analysisSet(order, rows) {
  const chunks = [...new Set(order.map((entry) => entry.chunk))];
  const complete = chunks.filter((chunk) =>
    order.filter((entry) => entry.chunk === chunk).every((entry) => rows.every((arm) => arm.has(entry.id))),
  );
  const inComplete = order.filter((entry) => complete.includes(entry.chunk)).map((entry) => entry.id);
  const harnessErrors = inComplete.filter((id) => rows.some((arm) => HARNESS_ERRORS.has(arm.get(id).outcome)));
  return {
    complete,
    incomplete: chunks.filter((chunk) => !complete.includes(chunk)),
    ids: inComplete.filter((id) => !harnessErrors.includes(id)),
    harnessErrors,
  };
}

/** A seeded uniform generator on [0, 1) (mulberry32), so a bootstrap gives the same interval every run. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile 95% CI for p1 − p2 over paired binary data grouped in clusters
 * (for example two samples of one probe): resample whole clusters with
 * replacement and take the pooled mean of first − second over their pairs.
 * `clusters`: arrays of [first, second] booleans.
 */
export function clusterBootstrapDiff(clusters, { resamples = 10000, seed = 1 } = {}) {
  const random = seededRandom(seed);
  const sums = clusters.map((pairs) => [pairs.reduce((s, [x, y]) => s + Number(x) - Number(y), 0), pairs.length]);
  const means = [];
  for (let r = 0; r < resamples; r++) {
    let diff = 0;
    let n = 0;
    for (let k = 0; k < sums.length; k++) {
      const [s, m] = sums[Math.floor(random() * sums.length)];
      diff += s;
      n += m;
    }
    means.push(diff / n);
  }
  means.sort((p, q) => p - q);
  const at = (q) => means[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))];
  return [at(0.025), at(0.975)];
}
