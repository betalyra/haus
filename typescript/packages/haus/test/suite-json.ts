import type { Value } from "../src/index.js"

/** Encode a value in the conformance suite's JSON form (see test-suite/README.md). */
export function suiteJson(v: Value): unknown {
  switch (v.kind) {
    case "string":
      return v.value
    case "number":
      return { num: v.text }
    case "bytes":
      return { bytes: Buffer.from(v.bytes).toString("hex") }
    case "array":
      return v.items.map(suiteJson)
    case "record":
      return { rec: Object.fromEntries([...v.fields].map(([k, x]) => [k, suiteJson(x)])) }
    case "variant":
      return v.args.length ? { tag: v.tag, args: v.args.map(suiteJson) } : { tag: v.tag }
  }
}
