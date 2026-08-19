/**
 * YAML frontmatter parsing for `SKILL.md` files.
 *
 * Shared deliberately: `scripts/validate.mjs` checks all 157 skills on every
 * release, and `search.ts` parses the same files at runtime to build the
 * `sci_find` catalogue. Two parsers would drift, and the drift would be
 * invisible — validation would pass on files the runtime read differently.
 *
 * `validate.mjs` imports this through Node's TypeScript type stripping
 * (>= 22.18), the same mechanism it already uses for `profiles.ts`.
 */

/** Frontmatter as flat top-level scalars. Nested mappings are present-but-empty. */
export type Frontmatter = Record<string, string>;

/** Strip one layer of matching surrounding quotes, if present. */
export const unquote = (value: string): string => {
  const matched = value.match(/^(['"])([\s\S]*)\1$/);
  return matched ? matched[2] : value;
};

/**
 * Line-based parser for the top-level scalars this collection uses.
 *
 * It must resolve block scalars (`description: >` followed by indented lines),
 * because a naive parser records the `>` indicator itself as the value — which
 * makes a skill with an EMPTY block body look like it has a description and
 * slip past validation, even though pi would refuse to load it.
 *
 * Only top-level scalars are resolved. Nested mappings (`metadata:`) are
 * recorded as present-but-empty and skipped.
 *
 * @returns the parsed fields, or `null` when there is no frontmatter block.
 */
export const parseFrontmatter = (text: string): Frontmatter | null => {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!block) return null;

  const fields: Frontmatter = {};
  const lines = block[1].split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    index++;

    const pair = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!pair) continue; // continuation of a construct we skipped, or blank
    const [, key, rawRest] = pair;
    const rest = rawRest.trim();

    // Block scalar: `>`, `|`, plus optional chomping/indent indicators (>-, |2+).
    const scalar = rest.match(/^([|>])([+-]?\d*|\d*[+-]?)$/);
    if (scalar) {
      const folded = scalar[1] === ">";
      const body: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim() !== "" && !/^[ \t]/.test(next)) break; // dedent ends block
        body.push(next.trim());
        index++;
      }
      while (body.length && body[body.length - 1] === "") body.pop(); // chomp
      fields[key] = folded
        ? body.join(" ").replace(/\s+/g, " ").trim()
        : body.join("\n").trim();
      continue;
    }

    if (rest === "") {
      // Either an empty scalar or the start of a nested mapping/sequence.
      // Consume any indented block so its inner keys aren't read as top-level.
      while (index < lines.length && (lines[index].trim() === "" || /^[ \t]/.test(lines[index]))) {
        index++;
      }
      fields[key] = "";
      continue;
    }

    fields[key] = unquote(rest);
  }

  return fields;
};

/**
 * Inert default export. Pi discovers extensions as `extensions/*.ts` as well as
 * `extensions/*\/index.ts`, so this data module may be loaded as an extension in
 * its own right. Registering nothing keeps that harmless instead of erroring on
 * a missing default export.
 */
export default function noopExtension(): void {}
