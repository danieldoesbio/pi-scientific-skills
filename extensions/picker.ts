/**
 * The `/sci profiles` picker: a fallback `select()` loop for older pi builds
 * or RPC mode, and the real focused checkbox list for everything else.
 */

import { describeCost, skillsForSelection } from "./catalog";
import { TOGGLES } from "./profiles";
import { commitPlan, findPackageEntry, isOverridePattern, readConfig, readSettings } from "./settings";
import { report, settingsPath } from "./paths";
import {
  COMMAND_NAME,
  usage,
  type CommandContext,
  type KeyMatcher,
  type TuiComponent,
  type UiContext,
} from "./types";

// ---------------------------------------------------------------------------
// Fallback picker — repeated select(), used when ui.custom is unavailable
// ---------------------------------------------------------------------------

// No "A)"/"X)" prefixes: ctx.ui.select renders a plain SelectList driven by
// arrows + enter (pi-tui select-list.js), with no hotkey or type-to-filter
// binding. Numbering the rows advertised keys that do nothing.
const APPLY = "Apply and reload";
const SELECT_ALL = "Select all profiles";
const CLEAR = "Clear selection";
const CANCEL = "Cancel";

const toggleRows = (selected: ReadonlySet<string>): string[] =>
  TOGGLES.map((toggle) => {
    const mark = selected.has(toggle.id) ? "x" : " ";
    return `[${mark}] ${toggle.label} — ${toggle.skills.length} skills`;
  });

/**
 * Apply and Cancel lead, the rare bulk actions trail.
 *
 * SelectList caps its viewport at 12 rows, and this menu has more entries than
 * that, so anything at the bottom starts below the fold. Apply is the one row
 * every session must reach. It also lands under the cursor after each toggle,
 * because select() rebuilds the list each call with selectedIndex 0 — so the
 * common "tick a profile, apply" path is two keystrokes. The list wraps, so the
 * trailing bulk actions are still one Up press from the top.
 *
 * That cursor reset is why this is only the fallback now: it makes toggling two
 * adjacent profiles needlessly slow. See createProfileList.
 */
const pickerRows = (rows: readonly string[]): string[] => [
  APPLY,
  CANCEL,
  ...rows,
  SELECT_ALL,
  CLEAR,
];

const withToggled = (selected: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
};

// ---------------------------------------------------------------------------
// Profile picker — real multiselect via ctx.ui.custom
// ---------------------------------------------------------------------------

interface PickerResult {
  readonly action: "apply" | "cancel";
  readonly selected: readonly string[];
}

/** Rows visible at once, matching the cap ui.select applies to SelectList. */
const PICKER_VIEWPORT = 12;

const PICKER_HINT = "↑↓ move · space toggle · a all · n none · enter apply · esc cancel";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * A focused checkbox list that owns its cursor.
 *
 * The select()-driven picker this replaces had to reopen the dialog on every
 * toggle, and `ui.select` builds a fresh SelectList each call with
 * selectedIndex 0 and exposes no initial-index option
 * (`ExtensionUIDialogOptions` is only `signal`/`timeout`). So the cursor
 * snapped back to the top after each tick and selecting two adjacent profiles
 * meant navigating down twice. Holding the cursor across toggles requires
 * owning the component, which is what ui.custom is for.
 *
 * Cursor and checkbox state are mutable locals in this closure — a focused TUI
 * component is inherently stateful, and the state never escapes: `done` is
 * handed a fresh array.
 */
const createProfileList = (
  initial: ReadonlySet<string>,
  keybindings: KeyMatcher,
  done: (result: PickerResult) => void,
): TuiComponent => {
  const selected = new Set(initial);
  let cursor = 0;

  const toggleAt = (index: number): void => {
    const id = TOGGLES[index].id;
    if (!selected.delete(id)) selected.add(id);
  };

  return {
    invalidate(): void {
      // Nothing is cached between renders.
    },

    render(): string[] {
      const skills = skillsForSelection(selected);
      const lines = [`Scientific skills — ${describeCost(skills.length)}`, ""];

      // Keep the cursor centred where possible, exactly as SelectList does, so
      // scrolling feels identical to every other list in pi.
      const start = clamp(
        cursor - Math.floor(PICKER_VIEWPORT / 2),
        0,
        Math.max(0, TOGGLES.length - PICKER_VIEWPORT),
      );
      const end = Math.min(start + PICKER_VIEWPORT, TOGGLES.length);

      for (let i = start; i < end; i++) {
        const toggle = TOGGLES[i];
        const mark = selected.has(toggle.id) ? "x" : " ";
        const prefix = i === cursor ? "→ " : "  ";
        lines.push(`${prefix}[${mark}] ${toggle.label} — ${toggle.skills.length} skills`);
      }

      if (start > 0 || end < TOGGLES.length) {
        lines.push(`  (${cursor + 1}/${TOGGLES.length})`);
      }
      lines.push("", PICKER_HINT);
      return lines;
    },

    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.up")) {
        cursor = cursor === 0 ? TOGGLES.length - 1 : cursor - 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.down")) {
        cursor = cursor === TOGGLES.length - 1 ? 0 : cursor + 1;
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        done({ action: "apply", selected: [...selected] });
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        done({ action: "cancel", selected: [] });
        return;
      }
      // Plain characters reach us untouched: SelectList ignores everything but
      // the four bindings above, so these letters collide with nothing.
      if (data === " ") {
        toggleAt(cursor);
        return;
      }
      if (data === "a" || data === "A") {
        for (const toggle of TOGGLES) selected.add(toggle.id);
        return;
      }
      if (data === "n" || data === "N") {
        selected.clear();
      }
    },
  };
};

const sameSkills = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((value, index) => value === sortedB[index]);
};

/**
 * The picker seeds its checkboxes from our own config file, so a filter written
 * by hand — or a selection made before /sci existed — would render as "nothing
 * selected" and be replaced on Apply without a word. Ask first.
 *
 * Override patterns are excluded from the comparison because applyPlanToEntry
 * preserves them; only plain include patterns are at risk.
 */
const confirmReplacingUnknownFilter = async (
  ctx: UiContext,
  saved: ReadonlySet<string>,
): Promise<boolean> => {
  const settings = await readSettings(settingsPath());
  if (settings.kind !== "ok") return true; // applyToSettings reports this properly

  const location = findPackageEntry(settings.document.packages);
  if (!location) return true;

  const entry = location.entry;
  if (typeof entry === "string" || !Array.isArray(entry.skills)) return true;

  const includes = entry.skills.filter(
    (pattern): pattern is string =>
      typeof pattern === "string" && !isOverridePattern(pattern),
  );
  if (includes.length === 0) return true;
  if (sameSkills(includes, skillsForSelection(saved))) return true;

  return ctx.ui.confirm(
    "Replace the existing filter?",
    `${settingsPath()} lists ${includes.length} skill pattern(s) that /${COMMAND_NAME} ` +
      `did not write. Applying a profile replaces that list (\`pi config\` overrides ` +
      `are kept). Continue?`,
  );
};

export const runPicker = async (ctx: CommandContext): Promise<void> => {
  if (!ctx.hasUI) {
    report(ctx, `/${COMMAND_NAME} profiles needs an interactive UI. ${usage()}`, "warning");
    return;
  }

  const config = await readConfig();
  const saved: ReadonlySet<string> = new Set(config.profiles ?? []);
  if (!(await confirmReplacingUnknownFilter(ctx, saved))) {
    report(ctx, "No changes made.", "info");
    return;
  }

  const chosen = await choose(ctx, saved);
  if (chosen === undefined) {
    report(ctx, "No changes made.", "info");
    return;
  }

  const skills = skillsForSelection(chosen);
  const summary =
    skills.length === 0
      ? "All scientific skills disabled."
      : `Active: ${describeCost(skills.length)}.`;
  await commitPlan(ctx, { kind: "filter", skills }, { kind: "set", ids: [...chosen] }, summary);
};

/**
 * Returns the chosen profile ids, or undefined if the user cancelled.
 *
 * Prefers the custom multiselect and falls back to the select() loop when
 * ui.custom is absent (older pi) or returns undefined (RPC mode), so the
 * command still works everywhere it used to.
 */
const choose = async (
  ctx: CommandContext,
  saved: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> => {
  // Safe to call detached: pi binds this as an arrow property on the UI context
  // (`interactive-mode.js:1695`), so it carries its own `this`.
  const custom = ctx.ui.custom;
  if (custom) {
    const result = await custom<PickerResult>((_tui, _theme, keybindings, done) =>
      createProfileList(saved, keybindings, done),
    );
    if (result !== undefined) {
      return result.action === "apply" ? new Set(result.selected) : undefined;
    }
  }
  return chooseViaSelect(ctx, saved);
};

/** Fallback picker: one select() dialog per toggle. The cursor resets each time. */
const chooseViaSelect = async (
  ctx: CommandContext,
  saved: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> => {
  let selected: ReadonlySet<string> = saved;

  for (;;) {
    const skills = skillsForSelection(selected);
    const prompt = `Scientific skills — ${describeCost(skills.length)}`;
    const rows = toggleRows(selected);
    const choice = await ctx.ui.select(prompt, pickerRows(rows));

    if (choice === undefined || choice === CANCEL) return undefined;
    if (choice === SELECT_ALL) {
      selected = new Set(TOGGLES.map((toggle) => toggle.id));
      continue;
    }
    if (choice === CLEAR) {
      selected = new Set();
      continue;
    }
    if (choice === APPLY) return selected;

    const index = rows.indexOf(choice);
    if (index >= 0) selected = withToggled(selected, TOGGLES[index].id);
  }
};

/** Inert default export; see extensions/index.ts's header comment. */
export default function noopExtension(): void {}
