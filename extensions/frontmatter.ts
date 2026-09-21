/**
 * YAML frontmatter parsing for `SKILL.md` files.
 *
 * Shared deliberately: `scripts/validate.mjs` checks every skill on every
 * release, and `search.ts` parses the same files at runtime to build the
 * `sci_find` catalogue. Two parsers would drift, and the drift would be
 * invisible — validation would pass on files the runtime read differently.
 *
 * The fence-finding step copies pi's own algorithm exactly (verified by
 * reading `dist/utils/frontmatter.js` in an installed pi): strip a leading
 * BOM, normalize `\r\n`/`\r` to `\n`, require the text to start with `---`,
 * then find the closing fence with `indexOf("\n---", 3)`. That is what keeps
 * a leading blank line, or a `---` rule inside an unfenced body, from being
 * misread as frontmatter. `scripts/test-frontmatter.mjs` checks this file
 * against pi's real parser, field by field, over every skill plus a set of
 * synthetic edge cases.
 *
 * `validate.mjs` imports this through Node's TypeScript type stripping
 * (>= 22.18), the same mechanism it already uses for `profiles.ts`.
 */

/** Frontmatter as flat top-level scalars. Nested mappings are present-but-empty. */
export type Frontmatter = Record<string, string>;

/**
 * Parse the scalar on the right of `key:`, once it is known not to be a
 * block-scalar indicator or empty.
 *
 * A quoted value is walked character by character to its matching closing
 * quote; anything after that quote (typically `# a comment`) is dropped.
 * `\"` unescapes inside double quotes, `''` unescapes inside single quotes.
 * An unterminated quote is read leniently: whatever was collected before
 * running off the end of the line is returned as-is.
 *
 * Escape support is deliberately narrower than full YAML — no `\n`, `\t`, or
 * `\uXXXX` — because no shipped skill description needs them (12
 * double-quoted descriptions in the corpus, none with a backslash).
 *
 * An unquoted value is cut at the first whitespace-then-`#` (a YAML comment
 * needs the leading whitespace) and trimmed.
 */
const parseScalar = (rest: string): string => {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    let value = "";
    let i = 1;
    while (i < rest.length) {
      const ch = rest[i];
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        value += rest[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && rest[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        return value; // closing quote found; drop any trailing comment
      }
      value += ch;
      i++;
    }
    return value; // unterminated quote: lenient, return what was collected
  }

  const commentAt = rest.search(/\s#/);
  return (commentAt === -1 ? rest : rest.slice(0, commentAt)).trim();
};

/** Strip a leading BOM and normalize line endings, exactly as pi does. */
const normalize = (text: string): string => {
  const stripped = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
};

/**
 * Consume a block scalar body (the indented lines after `>` or `|`),
 * returning its resolved value and the index of the first line after it.
 *
 * Folded (`>`) bodies join on spaces; literal (`|`) bodies join on newlines.
 * Trailing blank lines are chomped either way. An empty body (no indented
 * lines follow) resolves to `""` — the reason this exists at all, since a
 * naive parser would otherwise record the `>` indicator itself as the value.
 */
const consumeBlockScalar = (
  lines: string[],
  start: number,
  folded: boolean,
): { value: string; next: number } => {
  const body: string[] = [];
  let index = start;
  while (index < lines.length) {
    const next = lines[index];
    if (next.trim() !== "" && !/^[ \t]/.test(next)) break; // dedent ends block
    body.push(next.trim());
    index++;
  }
  while (body.length && body[body.length - 1] === "") body.pop(); // chomp
  const value = folded ? body.join(" ").replace(/\s+/g, " ").trim() : body.join("\n").trim();
  return { value, next: index };
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
  const normalized = normalize(text);
  if (!normalized.startsWith("---")) return null;

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const fields: Frontmatter = {};
  const lines = normalized.slice(4, endIndex).split("\n");
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
      const { value, next } = consumeBlockScalar(lines, index, scalar[1] === ">");
      fields[key] = value;
      index = next;
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

    fields[key] = parseScalar(rest);
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
