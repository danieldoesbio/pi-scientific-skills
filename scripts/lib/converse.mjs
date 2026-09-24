// One supervised probe: up to N fresh attempts, each a conversation of up to M
// responses with a blind persona (supervisor.mjs) playing the user.
//
// The grade is mechanical. The model reaches the target when a sci_find
// result lists it, a bash command's output points at it, or it reads a file
// inside it (pi-session.mjs `reaches`). An attempt that has not reached the
// target by its last response is wiped and the probe starts again from
// nothing: a new session, a new workspace, a new agent dir.
//
//   reached in attempt 1 → success, 2 → partial-success, 3 → functional,
//   never → fail.
//
// A response is stopped the moment the target is reached (`stoppedEarly`):
// nothing after that point changes the grade.
//
// A response that runs past --timeout ends its attempt, and that attempt
// counts. The limit is a budget per response, not a loop detector: a slow
// local model can spend it on real work (reading files, writing code). Each
// attempt records `timedOut`, and the summary counts the grades a timeout
// touched, so a too-short limit shows up instead of hiding.
import { readMessages, reaches, readSkills, responses } from "./pi-session.mjs";
import { SupervisorError } from "./supervisor.mjs";

export const GRADES = ["success", "partial-success", "functional"];

/** Words that steer the model toward searching without naming a skill. */
const NUDGES = /\b(search|look(?:ing)? (?:it )?up|docs|documentation|skills?|plugins?|is there a (?:tool|package|library))\b/i;

/**
 * Persona replies worth a human look: a skill name the assistant never said,
 * or a nudge toward search. A flag is for review, not a verdict.
 */
function personaFlags(reply, seenText, catalogue) {
  const flags = [];
  const lower = reply.toLowerCase();
  const seen = seenText.toLowerCase();
  for (const name of catalogue) {
    for (const form of new Set([name, name.replaceAll("-", " ")])) {
      const pattern = new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (pattern.test(lower) && !pattern.test(seen)) flags.push(`names ${name}`);
    }
  }
  const nudge = reply.match(NUDGES)?.[0];
  if (nudge) flags.push(`nudge "${nudge}"`);
  return [...new Set(flags)];
}

/**
 * @param {object} probe  {id, task, target, want}
 * @param {object} ctx
 * @param {(probeId: string, label: string) => {sessionFile: string, finish: () => void}} ctx.startAttempt
 * @param {(run: object, message: string, response: number, stopWhen: () => boolean) => Promise<{answered: boolean, timedOut: boolean, stoppedEarly?: boolean, detail?: string}>} ctx.respond
 *   `stopWhen` returns true once the target is reached; respond may stop the model then.
 * @param {{next: Function}} ctx.persona
 * @param {Set<string>} ctx.catalogue  Every installed skill name.
 * @param {{attempts: number, responses: number}} ctx.limits
 * @param {(line: string) => void} ctx.log
 */
export async function runSupervisedProbe(probe, ctx) {
  const attempts = [];
  while (attempts.length < ctx.limits.attempts) {
    const label = `a${attempts.length + 1}`;
    const run = ctx.startAttempt(probe.id, label);
    let result;
    try {
      result = await runAttempt(probe, run, ctx);
    } finally {
      run.finish();
    }
    if (result.fatal) return { outcome: result.fatal, detail: result.detail, attempts: [...attempts, result.attempt] };

    const attempt = { ...result.attempt, label, timedOut: result.attempt.endedBy === "timeout" };
    attempts.push(attempt);
    ctx.log(
      `${label}: ${attempt.endedBy} after ${attempt.responses} response(s), ${attempt.elapsedSeconds}s` +
        (attempt.target ? ` — reached ${probe.target} by ${attempt.target.by} in response ${attempt.target.response}` : "") +
        (attempt.stoppedEarly ? " (stopped on reach)" : ""),
    );
    if (attempt.target) break;
  }

  const reachedIndex = attempts.findIndex((attempt) => attempt.target);
  const reached = reachedIndex >= 0 ? attempts[reachedIndex] : null;
  return {
    outcome: "graded",
    grade: reached ? GRADES[reachedIndex] : "fail",
    reachedAttempt: reached ? reachedIndex + 1 : null,
    reachedResponse: reached?.target.response ?? null,
    reachedBy: reached?.target.by ?? null,
    ...wantGrade(attempts),
    attempts,
  };
}

/** The same grade on the looser test: any skill in `want`, not only the target. */
function wantGrade(attempts) {
  const index = attempts.findIndex((attempt) => attempt.want);
  return {
    wantGrade: index >= 0 ? GRADES[index] : "fail",
    wantSkill: index >= 0 ? attempts[index].want.skill : null,
  };
}

async function runAttempt(probe, run, ctx) {
  const started = Date.now();
  const exchanges = [];
  const persona = [];
  let message = probe.task;
  let endedBy = "max-responses";
  let turns = [];
  let found = [];
  let response = 0;
  let stoppedEarly = false;
  // The same test the grade uses, so a stop never disagrees with it.
  const targetReached = () =>
    reaches(responses(readMessages(run.sessionFile)), probe.want, ctx.catalogue).some(
      (entry) => entry.skill === probe.target,
    );
  const summary = () => {
    const finds = turns.flatMap((turn, index) =>
      turn.calls.filter((call) => call.tool === "sci_find").map((call) => ({ call, response: index + 1 })),
    );
    return {
      responses: response,
      endedBy,
      stoppedEarly,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      target: found.find((entry) => entry.skill === probe.target) ?? null,
      want: found[0] ?? null,
      reaches: found,
      sciFindCalls: finds.length,
      firstFindResponse: finds[0]?.response ?? null,
      queries: finds.map(({ call }) => call.args?.query ?? (call.args?.profile ? `profile:${call.args.profile}` : "")),
      readSkills: readSkills(turns),
      tools: [...new Set(turns.flatMap((turn) => turn.calls.map((call) => call.tool)))],
      persona,
    };
  };

  while (response < ctx.limits.responses) {
    response++;
    const turn = await ctx.respond(run, message, response, targetReached);
    stoppedEarly = turn.stoppedEarly === true;
    turns = responses(readMessages(run.sessionFile));
    found = reaches(turns, probe.want, ctx.catalogue);
    if (!turn.answered && !turn.timedOut) {
      return { fatal: "no-run", detail: turn.detail, attempt: summary() };
    }
    if (found.some((entry) => entry.skill === probe.target)) {
      endedBy = "reached";
      break;
    }
    if (turn.timedOut) {
      endedBy = "timeout";
      break;
    }
    if (response === ctx.limits.responses) break;

    exchanges.push({ assistant: (turns.at(-1)?.texts ?? []).join("\n\n") });
    let decision;
    try {
      decision = await ctx.persona.next(probe.task, exchanges);
    } catch (error) {
      if (!(error instanceof SupervisorError)) throw error;
      return { fatal: "supervisor-error", detail: error.message, attempt: summary() };
    }
    if (decision.action === "end") {
      persona.push({ end: decision.reason });
      endedBy = "persona-end";
      break;
    }
    const seen = [probe.task, ...exchanges.map((exchange) => exchange.assistant)].join("\n");
    persona.push({ reply: decision.message, flags: personaFlags(decision.message, seen, ctx.catalogue) });
    exchanges.at(-1).reply = decision.message;
    message = decision.message;
  }
  return { attempt: summary() };
}

/**
 * Does a model that does not search at once ever recover? Two views: the
 * response in which the target reached the model (for the attempt that
 * reached it), and every attempt split by when it first called sci_find —
 * response 1, later, or never — with how many of each reached the target.
 * A late first search that still reaches is recovery inside a conversation;
 * a grade below success is recovery by a fresh attempt.
 */
function recoveryLines(graded) {
  const reachedAt = {};
  for (const line of graded) {
    if (line.reachedResponse) reachedAt[line.reachedResponse] = (reachedAt[line.reachedResponse] ?? 0) + 1;
  }
  const attempts = graded.flatMap((line) => line.attempts);
  const split = (label, group) => `${label} ${group.length} (reached ${group.filter((attempt) => attempt.target).length})`;
  return [
    `  reached in response: ${Object.entries(reachedAt).map(([response, n]) => `r${response} ${n}`).join(" | ") || "-"}`,
    "  attempts by first sci_find: " +
      [
        split("r1", attempts.filter((attempt) => attempt.firstFindResponse === 1)),
        split("later", attempts.filter((attempt) => attempt.firstFindResponse > 1)),
        split("never", attempts.filter((attempt) => attempt.firstFindResponse == null)),
      ].join(", "),
  ];
}

/**
 * Per-group totals over the last line recorded for each probe id — a probe
 * re-run after a harness error keeps only its latest result. A probe the
 * judge found invalid (probe-check.mjs) keeps its raw grade on the line but
 * is left out of the grades and the recovery lines, and is listed for rewrite.
 */
export function summarizeSupervised(lines, print = console.log) {
  const latest = [...new Map(lines.map((line) => [line.id, line])).values()];
  const row = (label, group) => {
    const allGraded = group.filter((line) => line.outcome === "graded");
    const graded = allGraded.filter((line) => !line.probeCheck?.invalid);
    const count = (key, value, list = graded) => list.filter((line) => line[key] === value).length;
    const tally = (key, list = graded) => [...GRADES, "fail"].map((grade) => `${grade} ${count(key, grade, list)}`).join(" | ");
    const by = ["sci_find", "bash", "read"].map((route) => `${route} ${count("reachedBy", route)}`).join(", ");
    const allAttempts = group.flatMap((line) => line.attempts ?? []);
    const ended = {};
    for (const attempt of allAttempts) ended[attempt.endedBy] = (ended[attempt.endedBy] ?? 0) + 1;
    const flagged = allAttempts.flatMap((attempt) => attempt.persona ?? []).filter((turn) => turn.flags?.length).length;
    const touched = graded.filter((line) => line.attempts.some((attempt) => attempt.timedOut)).length;
    return [
      `${label}: n=${group.length} graded=${graded.length}` +
        ` probe-invalid=${allGraded.length - graded.length}` +
        ` check-error=${allGraded.filter((line) => line.probeCheck?.error).length}` +
        ` no-run=${group.filter((line) => line.outcome === "no-run").length}` +
        ` supervisor-error=${group.filter((line) => line.outcome === "supervisor-error").length}`,
      `  target: ${tally("grade")}`,
      // The judge audits only probes with a satisfied attempt that missed, so
      // a probe that did not need its skill but was reached at once keeps its
      // success: the adjusted line alone reads high until rewritten probes
      // run. The raw line keeps both in view.
      `  target, raw (probe-invalid at its raw grade): ${tally("grade", allGraded)}`,
      `  target or accepted: ${tally("wantGrade")}`,
      `  reached by: ${by}`,
      `  attempts ended by: ${Object.entries(ended).map(([key, value]) => `${key} ${value}`).join(", ") || "-"}`,
      `  grades with a timed-out attempt: ${touched}`,
      `  persona replies flagged for review: ${flagged}`,
      ...recoveryLines(graded),
    ].join("\n");
  };
  print(`\n${row("Core", latest.filter((line) => line.core))}`);
  print(row("non-Core", latest.filter((line) => !line.core)));
  const invalid = latest.filter((line) => line.outcome === "graded" && line.probeCheck?.invalid);
  if (invalid.length > 0) {
    print("\nprobe-invalid — rewrite these probes:");
    for (const line of invalid) print(`  ${line.id} (${line.grade}): ${line.probeCheck.verdicts[0]?.reason ?? ""}`);
  }
}
