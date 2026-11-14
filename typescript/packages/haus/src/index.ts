import { HausSyntaxError } from "./errors.js"
import { DEFAULT_LIMITS, Parser, type Limits } from "./parser.js"
import type { Value } from "./value.js"

export { HausSyntaxError } from "./errors.js"
export { DEFAULT_LIMITS, MAX_DEPTH, type Limits } from "./parser.js"
export { parseStream, StreamReader, type ChunkSource, type StreamOptions } from "./stream.js"
export * from "./value.js"
export { format, quote, stringify, type FormatOptions } from "./format.js"
export { canonical, compare, compareCodePoints, equals, hash, hashAll, Hasher } from "./canonical.js"
export { floatText, floatValue, specialFloat, toFloat, toFloat32, toFloat64, type FloatType } from "./float.js"
export { infer, inferSchema, printShape, recursiveNames, RecordShape, resolve, Shape, VariantShape, type Inference, type PrintOptions } from "./infer.js"

/** Parse a complete text into its sequence of top-level values. */
export function parseAll(text: string, limits: Partial<Limits> = {}): Value[] {
  return new Parser(text, undefined, { ...DEFAULT_LIMITS, ...limits }).parseSequence()
}

/**
 * Like `parseAll`, but every value carries `start`/`end` offsets and records
 * carry `keySpans`. Slower; meant for editors and language servers.
 */
export function parseWithLocations(text: string, limits: Partial<Limits> = {}): Value[] {
  return new Parser(text, undefined, { ...DEFAULT_LIMITS, ...limits }, true).parseSequence()
}

/** Values with locations plus the [start, end) span of every comment (for editors). */
export function parseDocument(text: string, limits: Partial<Limits> = {}): { values: Value[]; comments: [number, number][] } {
  const parser = new Parser(text, undefined, { ...DEFAULT_LIMITS, ...limits }, true)
  const values = parser.parseSequence()
  return { values, comments: parser.comments }
}

/** Parse a complete text that must contain exactly one value. */
export function parse(text: string, limits: Partial<Limits> = {}): Value {
  const values = parseAll(text, limits)
  if (values.length !== 1) {
    throw new HausSyntaxError(`expected exactly one value, found ${values.length}`, 0, 1, 1)
  }
  return values[0]!
}
export {
  ATTRIBUTES, BUILTINS, deprecation, HausSchemaFileError, Instance, instanceOf, parseSchemaFile, STD_MODULES, withoutAttributes,
  type Attribute, type Builtin, type Case, type Definition, type Field, type ModuleResolver, type ParseSchemaOptions, type Payload, type RecordType,
  type ResolvedModule, type SchemaFile, type SchemaWarning, type SchemaWarningKind, type StdType, type Type, type VariantType,
} from "./schema-file.js"
export { Secret } from "./secret.js"
export { checkStdTime, isStdTimeType, STD_TIME_TYPES, type StdTimeType } from "./std-time.js"
export { checkData, describeType, schemaReference, type CheckIssue, type CheckOptions, type SchemaReference } from "./check.js"
export { contextOf, describeValue, hoverAt, hoverContext, hoverMarkdown, hoverText, TAG_NOTES, type HoverContext, type HoverInfo } from "./hover.js"
export { completeAt, type Completion } from "./complete.js"
export { HausValidationError, parseWith, parseWithAsync, type StandardSchemaV1 } from "./standard.js"
export { parsePlain, toPlain } from "./plain.js"
export { compileSchemaFile, fromSchemaFile, schemaDeclarations, definitionDoc, deprecatedDoc, type CompiledSchemaFile, type DeclarationOptions } from "./schema-compile.js"
