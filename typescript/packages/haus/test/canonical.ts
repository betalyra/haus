import type { Value } from "../src/index.js"

/** Encode a value in the conformance suite's JSON form (see test-suite/README.md). */
export function canonical(v: Value): unknown {
  switch (v.kind) {
    case "string":
      return v.value
    case "number":
      return { num: v.text }
    case "array":
      return v.items.map(canonical)
    case "record":
      return { rec: Object.fromEntries([...v.fields].map(([k, x]) => [k, canonical(x)])) }
    case "variant":
      return v.args.length ? { tag: v.tag, args: v.args.map(canonical) } : { tag: v.tag }
  }
}
