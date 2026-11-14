/**
 * Everything the playground shows, computed from the two texts with the same
 * functions the parsers and the VS Code extension use.
 */
import {
  checkData,
  compileSchemaFile,
  contextOf,
  format,
  HausSyntaxError,
  inferSchema,
  parseDocument,
  parseSchemaFile,
  schemaDeclarations,
  toPlain,
  type CheckIssue,
  type HoverContext,
  type SchemaFile,
  type Value,
} from "../../../../typescript/packages/haus/src/index.ts";
import { plainDeclarations } from "../../../../typescript/packages/haus/src/plain.ts";
import * as h from "../../../../typescript/packages/haus/src/schema.ts";

export interface Problem {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "info";
  readonly message: string;
}

export interface Analysis {
  readonly dataProblems: Problem[];
  readonly schemaProblems: Problem[];
  /** For hovers and completion; absent while the data doesn't parse. */
  readonly hover?: HoverContext;
  readonly schema?: { readonly file: SchemaFile; readonly type: string };
  readonly outputs: {
    readonly inferred: string;
    readonly typescript: string;
    readonly json: string;
    readonly formatted: string;
  };
  /** One line on what happened: `3 values, checked against Root: 1 error`. */
  readonly summary: string;
}

export const syntaxProblem = (e: HausSyntaxError, text: string): Problem => ({
  from: Math.min(e.offset, text.length),
  to: Math.min(e.offset + 1, text.length),
  severity: "error",
  message: e.reason,
});

/** The type that describes the whole data file: Root, else the schema's last type without parameters. */
const rootType = (file: SchemaFile) =>
  file.definition("Root")?.name ?? [...file.definitions].reverse().find((d) => d.params.length === 0)?.name;

/** JSON for what a program gets: bigints, dates, maps and bytes written readably. */
const json = (x: unknown) =>
  JSON.stringify(
    x,
    (_, v: unknown) =>
      typeof v === "bigint" ? `${v}n`
      : v instanceof Map ? Object.fromEntries(v)
      : v instanceof Uint8Array ? `x"${[...v].map((b) => b.toString(16).padStart(2, "0")).join("")}"`
      : v,
    2,
  );

/** Split `text` at `sep` where it is not inside brackets or a string. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if ("{[(<".includes(c)) depth++;
    else if ("}])>".includes(c)) depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(last, i));
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

const WIDTH = 76;

/** A TypeScript type, broken over lines where it is too long: one union member or field per line. */
function prettyType(type: string, indent: string, room: number): string {
  // Objects with more than one field always get a line per field; anything else only when too long.
  const isObject = type.startsWith("{ ") && type.endsWith(" }");
  if (type.length <= room && !(isObject && splitTop(type.slice(2, -2), "; ").length > 1)) return type;
  const members = splitTop(type, " | ");
  if (members.length > 1) return members.map((m) => `\n${indent}  | ${prettyType(m, indent + "    ", WIDTH - indent.length - 4)}`).join("");
  if (isObject) {
    const fields = splitTop(type.slice(2, -2), "; ");
    return `{\n${fields.map((f) => {
      const colon = splitTop(f, ": ");
      const head = colon[0]!;
      const rest = colon.slice(1).join(": ");
      return `${indent}  ${head}: ${prettyType(rest, indent + "  ", room - head.length - 4)};`;
    }).join("\n")}\n${indent}}`;
  }
  return type;
}

/**
 * Generated declarations, made readable: doc comments dropped (the
 * playground shows the schema next to it) and long types broken over lines.
 */
export function prettyDeclarations(ts: string): string {
  return ts
    .replace(/\/\*\*[\s\S]*?\*\/\n/g, "")
    .split("\n")
    .map((line) => {
      const m = /^((?:export )?(?:declare const \S+: |type \S+ = ))(.*);$/.exec(line);
      if (!m) return line;
      const pretty = prettyType(m[2]!, "", WIDTH - m[1]!.length);
      return `${m[1]}${pretty.startsWith("\n") ? pretty.trimEnd().replace(/^ /, "") : pretty};`.replace(/= \n/, "=\n");
    })
    .join("\n")
    .replace(/;\n(?=export |declare |type )/g, ";\n\n")
    .replace(/^(import[^\n]*\n)(?!\n)/, "$1\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function analyze(data: string, schemaText: string): Analysis {
  const schemaProblems: Problem[] = [];
  let schema: Analysis["schema"];
  if (schemaText.trim()) {
    try {
      const file = parseSchemaFile(schemaText);
      const type = rootType(file);
      if (type) schema = { file, type };
      else schemaProblems.push({ from: 0, to: 0, severity: "error", message: "the schema needs a type without parameters to describe the data (type Root = …)" });
    } catch (e) {
      if (!(e instanceof HausSyntaxError)) throw e;
      schemaProblems.push(syntaxProblem(e, schemaText));
    }
  }

  let values: Value[];
  let comments: [number, number][];
  try {
    ({ values, comments } = parseDocument(data));
  } catch (e) {
    if (!(e instanceof HausSyntaxError)) throw e;
    const empty = "// fix the error to see this";
    return {
      dataProblems: [syntaxProblem(e, data)],
      schemaProblems,
      ...(schema ? { schema } : {}),
      outputs: { inferred: empty, typescript: empty, json: empty, formatted: empty },
      summary: `Syntax error at ${e.line}:${e.column}`,
    };
  }

  const issues: CheckIssue[] = schema ? checkData(schema.file, schema.type, values) : [];
  const dataProblems = issues.map((i): Problem => ({
    from: Math.min(i.start, data.length),
    to: Math.min(i.end, data.length),
    severity: i.severity === "error" ? "error" : "info",
    message: i.message,
  }));
  const errors = issues.filter((i) => i.severity === "error").length;

  // What a program gets: decoded with the schema when the data fits it, else the plain view.
  let program: unknown;
  try {
    const plain = toPlain(values);
    program = values.length === 1 ? plain[0] : plain;
  } catch (e) {
    program = `${(e as Error).message}`;
  }
  if (schema && errors === 0) {
    try {
      const { schemas, streams } = compileSchemaFile(schemaText);
      const root = schemas[schema.type]!;
      const decoded = values.map((v) => h.decode(root, v));
      program = streams.has(schema.type) ? decoded : decoded[0];
    } catch {
      // keep the plain view
    }
  }

  const what = values.length === 1 ? "1 value" : `${values.length} values (a stream)`;
  const checked = schema ? `, checked against ${schema.type}: ${errors === 0 ? "no errors" : plural(errors, "error")}` : "";
  return {
    dataProblems,
    schemaProblems,
    hover: contextOf(values, schema),
    ...(schema ? { schema } : {}),
    outputs: {
      inferred: inferSchema(values),
      // With a schema, two modules, as @haus-fmt/import generates them: the data file typed by
      // the schema's root type, and the schema file with its types and schemas.
      typescript: schema
        ? [
            "// data.haus",
            `import type { ${schema.type} } from "./data.schema.haus";`,
            "",
            `declare const data: ${schema.file.definition(schema.type)?.template.stream ? `ReadonlyArray<${schema.type}>` : schema.type};`,
            "",
            "export default data;",
            "",
            "",
            "// data.schema.haus",
            prettyDeclarations(schemaDeclarations(schema.file)),
          ].join("\n")
        : `// data.haus\n${prettyDeclarations(plainDeclarations(data, "data.haus"))}`,
      json: (() => {
        try {
          return json(program) ?? "undefined";
        } catch (e) {
          return `// ${(e as Error).message}`;
        }
      })(),
      formatted: format(values, { source: data, comments }),
    },
    summary: `${what}${checked}`,
  };
}
