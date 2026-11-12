/**
 * Standard Schema (https://standardschema.dev), the common interface of Zod,
 * Valibot, ArkType, Effect Schema and others. haus works with it both ways:
 *
 *   parseWith(UserZod, text)        haus text → the plain JS view → any Standard Schema
 *   h.User["~standard"].validate()  haus schemas (schema.ts) are Standard Schemas too
 *
 * The interface types are copied below, as the Standard Schema spec
 * recommends, so haus needs no dependency for them.
 */
import { HausSyntaxError } from "./errors.js"
import { parsePlain } from "./plain.js"

/** The Standard Schema interface, version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }
  export interface PathSegment {
    readonly key: PropertyKey
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"]
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"]
}

/** Data that a Standard Schema rejected, with the schema's issues. */
export class HausValidationError extends Error {
  override readonly name = "HausValidationError"

  constructor(readonly issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super(issues.map((i) => (i.path?.length ? `${pathText(i.path)}: ${i.message}` : i.message)).join("; "))
  }
}

const pathText = (path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>) =>
  path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")

const settle = <A>(result: StandardSchemaV1.Result<A>): A => {
  if (result.issues) throw new HausValidationError(result.issues)
  return result.value
}

/**
 * Parse haus text and validate it with any Standard Schema (Zod, Valibot,
 * ArkType, Effect Schema, …). The schema sees the plain JS view of the data
 * (see plain.ts): strings, numbers, booleans, `null` for `None`, decimals as
 * exact strings, `{ _tag, … }` objects for variants; a stream of several
 * values is an array. Throws HausSyntaxError for bad syntax and
 * HausValidationError when the schema rejects the data. For schemas that
 * validate asynchronously, use `parseWithAsync`.
 */
export function parseWith<S extends StandardSchemaV1>(schema: S, text: string): StandardSchemaV1.InferOutput<S> {
  const result = schema["~standard"].validate(parsePlain(text))
  if (result instanceof Promise) throw new TypeError("this schema validates asynchronously: use parseWithAsync")
  return settle(result) as StandardSchemaV1.InferOutput<S>
}

/** `parseWith` for schemas that may validate asynchronously. */
export async function parseWithAsync<S extends StandardSchemaV1>(schema: S, text: string): Promise<StandardSchemaV1.InferOutput<S>> {
  return settle(await schema["~standard"].validate(parsePlain(text))) as StandardSchemaV1.InferOutput<S>
}

/** Turn a thrown haus error into Standard Schema issues (for `~standard.validate`). */
export const issuesOf = (e: unknown): StandardSchemaV1.FailureResult => {
  if (e instanceof HausSyntaxError) return { issues: [{ message: e.message }] }
  if (e instanceof Error && "reason" in e && "path" in e && Array.isArray(e.path)) {
    return { issues: [{ message: String(e.reason), path: e.path as (string | number)[] }] }
  }
  throw e
}
