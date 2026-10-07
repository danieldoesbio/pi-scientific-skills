/**
 * The `/sci profiles` picker: a focused checkbox list, with a `select()` loop
 * as the fallback for older pi builds and RPC mode.
 */

import { describeCost, describeSearchMode, skillsForSelection } from "./catalog";
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
// Fallback picker: repeated select(), used when ui.custom is unavailable
// ---------------------------------------------------------------------------

// No "A)"/"X)" prefixes: in pi's TUI, ctx.ui.select renders
// ExtensionSelectorComponent, driven by arrows (or j/k) and enter, with no
// per-row hotkey or type-to-filter binding (an RPC client draws its own list).
// Numbered rows would advertise keys that do nothing.
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
 * Apply is the one row every session must reach. It also lands under the
 * cursor after each toggle, because select() rebuilds the list each call with
 * selectedIndex 0, so the common "tick a profile, apply" path is two
 * keystrokes. pi's TUI select() list does not wrap, so the trailing bulk actions
 * are a run of Down presses away; they are rarely needed.
 *
 * That cursor reset is why this is only the fallback: it makes toggling two
 * adjacent profiles slow. See createProfileList.
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
// Profile picker: a multiselect via ctx.ui.custom
// ---------------------------------------------------------------------------

interface PickerResult {
  readonly action: "apply" | "cancel";
  readonly selected: readonly string[];
}

/** Rows visible at once. This cap is our own: in pi's TUI, ui.select renders every row. */
const PICKER_VIEWPORT = 12;

const PICKER_HINT = "↑↓ move · space toggle · a all · n none · enter apply · esc cancel";

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * A focused checkbox list that owns its cursor.
 *
 * A select()-driven picker reopens the dialog on every toggle, and in pi's TUI
 * `ui.select` builds a fresh ExtensionSelectorComponent each call with
 * selectedIndex 0 and no initial-index option (`ExtensionUIDialogOptions` is
 * only `signal`/`timeout`). So the cursor snaps back to the top after each
 * tick, and selecting two adjacent profiles means navigating down twice.
 * Holding the cursor across toggles requires owning the component, which is
 * what ui.custom is for. See "Why the picker is a custom component" in
 * DOCUMENTATION.md.
 *
 * Cursor and checkbox state are mutable locals in this closure. A focused TUI
 * component is stateful by nature, and the state never escapes: `done` is
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

      // Keep the cursor centred where possible, as pi-tui's SelectList does,
      // so scrolling matches pi's other lists.
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
      // Plain characters reach us untouched, and pi-tui's SelectList binds only
      // the four actions above, so these letters collide with no list binding.
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
 * by hand, or a selection made before /sci existed, would render as "nothing
 * selected" and be replaced on Apply without a word. Ask first.
 *
 * Override patterns are left out of the comparison because applyPlanToEntry
 * carries them over (search mode drops them, and commitPlan names each one), so
 * only plain include patterns could vanish silently.
 */
const confirmReplacingUnknownFilter = async (
  ctx: UiContext,
  saved: ReadonlySet<string>,
): Promise<boolean> => {
  const settings = await readSettings(settingsPath());
  if (settings.kind !== "ok") return true; // applyToSettings reports this

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
      `did not write. Applying a profile replaces that list. \`pi config\` overrides stay, ` +
      `unless you choose no profile: search mode drops them and names each one. Continue?`,
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
      ? `No profile chosen. Search mode: ${describeSearchMode()}.`
      : `Active: ${describeCost(skills.length)}.`;
  await commitPlan(ctx, { kind: "filter", skills }, { kind: "set", ids: [...chosen] }, summary);
};

/**
 * Returns the chosen profile ids, or undefined if the user cancelled.
 *
 * Prefers the custom multiselect and falls back to the select() loop when
 * ui.custom is absent (older pi) or returns undefined (RPC mode), so the
 * command also works on older pi and in RPC mode.
 */
const choose = async (
  ctx: CommandContext,
  saved: ReadonlySet<string>,
): Promise<ReadonlySet<string> | undefined> => {
  // Safe to call detached: pi's InteractiveMode.createExtensionUIContext defines
  // `custom` as an arrow property, so it carries its own `this`.
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
