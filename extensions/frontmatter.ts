/**
 * YAML frontmatter parsing for `SKILL.md` files.
 *
 * Shared on purpose: `scripts/validate.mjs` checks every skill on every
 * release, and `search.ts` parses the same files at runtime to build the
 * `sci_find` catalogue. Two parsers would drift unnoticed: validation would
 * pass on files the runtime read differently.
 *
 * The fence-finding step copies pi's `extractFrontmatter`
 * (`dist/utils/frontmatter.js`): strip a leading BOM, normalize `\r\n`/`\r`
 * to `\n`, require the text to start with `---`, then find the closing fence
 * with `indexOf("\n---", 3)`. This keeps a leading blank line, or a `---`
 * rule inside an unfenced body, from being misread as frontmatter.
 * `scripts/test-frontmatter.mjs` compares this file with pi's real parser,
 * field by field, over every skill plus synthetic edge cases.
 *
 * `validate.mjs` imports this file through Node's TypeScript type stripping
 * (>= 22.18), as it does `profiles.ts`.
 */

/** Frontmatter as flat top-level scalars. Nested mappings are present-but-empty. */
export type Frontmatter = Record<string, string>;

/**
 * Parse the scalar to the right of `key:`, once it is known not to be a
 * block-scalar indicator or empty.
 *
 * A quoted value is walked character by character to its matching closing
 * quote; anything after that quote (typically `# a comment`) is dropped.
 * `\"` unescapes inside double quotes and `''` inside single quotes. An
 * unterminated quote is read leniently: whatever was collected before the
 * end of the line is returned as-is.
 *
 * Escape support is narrower than full YAML (no `\n`, `\t` or `\uXXXX`)
 * because no double-quoted description in the shipped skills contains a
 * backslash. A skill that used one of those escapes would fail
 * `scripts/test-frontmatter.mjs`, which compares every skill with pi's parser.
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

/** Strip a leading BOM and normalize line endings, as pi does. */
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
 * lines follow) resolves to `""`, which is why this function exists:
 * `parseFrontmatter` explains what goes wrong without it.
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
 * It must resolve block scalars (`description: >` followed by indented lines).
 * A naive parser records the `>` indicator itself as the value, so a skill
 * with an empty block body would look as if it had a description and pass
 * validation, although pi refuses to load a skill without one.
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
