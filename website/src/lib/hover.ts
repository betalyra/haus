/**
 * Hover types for the haus examples: while the page is built, every key,
 * value and tag in a data example gets the type haus sees there (from its
 * schema, or inferred from the data), and every type name in a schema
 * example gets its definition. Shiki wraps them in elements with a
 * `data-hover` text; a small script (HoverTips.astro) shows it as a tooltip.
 * The same functions give the hovers of the VS Code extension.
 */
import type { DecorationItem, ShikiTransformer } from "shiki";
import { hoverAt, hoverContext, hoverText, parseSchemaFile, type HoverContext, type SchemaFile, type Value } from "../../../typescript/packages/haus/src/index.ts";

export interface HoverOptions {
  /** The schema the example is checked against: its text and the type of the whole file (default `Root`). */
  schema?: { text: string; type?: string };
}

/** A stretch of an example and the text its hover shows. */
export interface HoverSpan {
  start: number;
  end: number;
  text: string;
}

const span = (start: number, end: number, text: string): HoverSpan => ({ start, end, text });

/** The spans to decorate: record keys, variant tags and scalar values (never overlapping). */
function spans(v: Value, out: [number, number][]): void {
  if (v.start === undefined || v.end === undefined) return;
  switch (v.kind) {
    case "record":
      for (const [key, x] of v.fields) {
        const k = v.keySpans?.get(key);
        if (k) out.push([k[0], k[1]]);
        spans(x, out);
      }
      return;
    case "array":
      return v.items.forEach((x) => spans(x, out));
    case "variant":
      out.push([v.start, v.start + v.tag.length]);
      return v.args.forEach((x) => spans(x, out));
    default:
      out.push([v.start, v.end]);
  }
}

function dataSpans(code: string, options: HoverOptions): HoverSpan[] {
  let ctx: HoverContext;
  try {
    const schema = options.schema && { file: parseSchemaFile(options.schema.text), type: options.schema.type ?? "Root" };
    ctx = hoverContext(code, schema);
  } catch {
    return []; // a fragment that doesn't parse on its own: no hovers
  }
  const out: [number, number][] = [];
  ctx.values.forEach((v) => spans(v, out));
  return out
    .filter(([start, end]) => !code.slice(start, end).includes("\n"))
    .flatMap(([start, end]) => {
      const info = hoverAt(ctx, start, { width: 60 });
      return info ? [span(start, end, hoverText(info))] : [];
    });
}

function schemaSpans(code: string): HoverSpan[] {
  let file: SchemaFile;
  try {
    file = parseSchemaFile(code);
  } catch {
    return [];
  }
  // Type names outside comments that the file defines.
  const out: HoverSpan[] = [];
  const masked = code.replace(/\/\/.*$/gm, (c) => " ".repeat(c.length));
  for (const m of masked.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    const d = file.definition(m[0]);
    if (d) out.push(span(m.index, m.index + m[0].length, d.source));
  }
  return out;
}

/** The hovers of a haus example: types in data, definitions in a schema. Never crosses a line. */
export const hoverSpans = (kind: "data" | "schema", code: string, options: HoverOptions = {}): HoverSpan[] =>
  kind === "schema" ? schemaSpans(code) : dataSpans(code, options);

/** A Shiki transformer adding hover types to a haus example. */
export function hausHover(kind: "data" | "schema", options: HoverOptions = {}): ShikiTransformer {
  return {
    name: "haus-hover",
    preprocess(code, shikiOptions) {
      const decorations: DecorationItem[] = hoverSpans(kind, code, options).map(({ start, end, text }) => ({
        start,
        end,
        properties: { class: "hover-tip", "data-hover": text },
      }));
      shikiOptions.decorations = [...(shikiOptions.decorations ?? []), ...decorations];
    },
  };
}
