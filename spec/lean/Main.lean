import Haus
import Lean.Data.Json

/-!
`haus-ref`: the reference parser on the command line.

    haus-ref FILE          print FILE's values in the test-suite JSON encoding
    haus-ref --suite DIR   run the conformance suite in DIR (valid/ and invalid/)
    haus-ref --batch DIR N for DIR/00000.haus … DIR/{N-1}.haus, one line each:
                           `ok <values>` or `err <line> <column> <reason>` (fuzz/)
    haus-ref --canonical FILE     the canonical form of each value in FILE, one per line (spec §12)
    haus-ref --canonical-batch DIR N  like --batch, printing `ok ["<canonical>", …]` (fuzz/)
    haus-ref --time TYPE TEXT     whether TEXT is a valid std/time TYPE (exit 0 or 1)
    haus-ref --time-batch FILE    for each line `TYPE HEX` of FILE (the text as hex-encoded
                                  UTF-8): `ok` or `no` (fuzz/)
    haus-ref --schema-suite DIR [TYPES]  run the schema suite in DIR (spec §15) with the
                                  resolved types in TYPES (default schema-suite.json,
                                  written by scripts/schema-types.ts)
    haus-ref --schema-batch TYPES FILE   for each line `SUITE TYPE HEX` of FILE (a value's haus
                                  text as hex-encoded UTF-8): `ok <canonical form of the
                                  encoded result>` or `err <place> <reason>` (fuzz/)
-/

open Haus Lean

/-- The test-suite encoding (test-suite/README.md). -/
partial def toJson : Value → Json
  | .num t => Json.mkObj [("num", Json.str t)]
  | .str s => Json.str s
  | .bytes bs => Json.mkObj [("bytes", Json.str (String.join (bs.map hex)))]
  | .arr xs => Json.arr (xs.map toJson).toArray
  | .record fs => Json.mkObj [("rec", Json.mkObj (fs.map fun (k, v) => (k, toJson v)))]
  | .variant t [] => Json.mkObj [("tag", Json.str t)]
  | .variant t xs => Json.mkObj [("tag", Json.str t), ("args", Json.arr (xs.map toJson).toArray)]
where
  hex (b : UInt8) : String :=
    let d := Nat.toDigits 16 b.toNat
    String.ofList (if d.length < 2 then '0' :: d else d)

/-- Line and column (1-based, in characters) of an error. -/
def position (input : Text) (e : Parser.Error) : Nat × Nat :=
  let before := input.take (input.length - e.remaining)
  let line := before.count '\n' + 1
  let column := (before.reverse.takeWhile (· != '\n')).length + 1
  (line, column)

/-- One result of `--batch`. -/
def batchLine (bytes : ByteArray) : String :=
  match String.fromUTF8? bytes with
  | none => "err 0 0 invalid UTF-8"
  | some s =>
      let t := s.toList
      match Parser.parse {} t with
      | .ok vs => s!"ok {(Json.arr (vs.map toJson).toArray).compress}"
      | .error e =>
          let (l, c) := position t e
          -- One line per case: line breaks in the reason (from a quoted key, say) as \n.
          s!"err {l} {c} {(e.reason.replace "\r" "\\r").replace "\n" "\\n"}"

/-- One result of `--canonical-batch`: the canonical form of each value, as JSON strings. -/
def canonicalLine (bytes : ByteArray) : String :=
  match String.fromUTF8? bytes with
  | none => "err 0 0 invalid UTF-8"
  | some s =>
      match Parser.parse {} s.toList with
      | .ok vs => s!"ok {(Json.arr (vs.map fun v => Json.str (String.ofList (Canonical.canonical v))).toArray).compress}"
      | .error _ => batchLine bytes

def runBatch (line : ByteArray → String) (dir : System.FilePath) (n : Nat) : IO UInt32 := do
  let out ← IO.getStdout
  for i in [0:n] do
    let name := String.ofList (List.replicate (5 - (toString i).length) '0') ++ toString i
    out.putStrLn (line (← IO.FS.readBinFile (dir / s!"{name}.haus")))
  return 0

/-- Decode UTF-8 and parse. -/
def parseBytes (bytes : ByteArray) : Except String (List Value) :=
  match String.fromUTF8? bytes with
  | none => .error "invalid UTF-8"
  | some s =>
      let t := s.toList
      match Parser.parse {} t with
      | .ok vs => .ok vs
      | .error e => let (l, c) := position t e; .error s!"{e.reason} at {l}:{c}"

def runSuite (dir : System.FilePath) : IO UInt32 := do
  let mut failures : Array String := #[]
  let mut count := 0
  for entry in (← (dir / "valid").readDir).qsort (·.fileName < ·.fileName) do
    let some name := entry.fileName.dropSuffix? ".haus" | continue
    count := count + 1
    let expected ← IO.FS.readFile (dir / "valid" / s!"{name}.json")
    match parseBytes (← IO.FS.readBinFile entry.path), Json.parse expected with
    | .ok vs, .ok json =>
        let got := (Json.arr (vs.map toJson).toArray).compress
        if got != json.compress then failures := failures.push s!"valid/{name}: got {got}"
        -- The canonical form of each value, one per line (spec §12).
        let file := dir / "valid" / s!"{name}.canonical"
        if ← file.pathExists then
          let canonical := String.join (vs.map fun v => String.ofList (Canonical.canonical v) ++ "\n")
          if canonical != (← IO.FS.readFile file) then
            failures := failures.push s!"valid/{name}.canonical: got {canonical}"
    | .error e, _ => failures := failures.push s!"valid/{name}: rejected: {e}"
    | _, .error e => failures := failures.push s!"valid/{name}.json: {e}"
  for entry in (← (dir / "invalid").readDir).qsort (·.fileName < ·.fileName) do
    let some name := entry.fileName.dropSuffix? ".haus" | continue
    count := count + 1
    if let .ok vs := parseBytes (← IO.FS.readBinFile entry.path) then
      failures := failures.push s!"invalid/{name}: accepted: {(Json.arr (vs.map toJson).toArray).compress}"
  for f in failures do IO.println f
  IO.println s!"{count - failures.size}/{count} passed"
  return if failures.isEmpty then 0 else 1

def timeType? (name : String) : Option Time.TimeType :=
  Time.TimeType.all.find? (·.name == name)

/-- The bytes of hex text. -/
def unhex (hex : String) : ByteArray :=
  let digit (c : Char) : Nat := if c.isDigit then c.toNat - '0'.toNat else c.toNat - 'a'.toNat + 10
  let cs := hex.toList.toArray
  ⟨(Array.range (cs.size / 2)).map fun i => UInt8.ofNat (digit cs[2 * i]! * 16 + digit cs[2 * i + 1]!)⟩

/-- One line of `--time-batch`: `TYPE HEX`. -/
def timeLine (line : String) : String :=
  match line.splitOn " " with
  | [ty, hex] =>
      match timeType? ty, String.fromUTF8? (unhex hex) with
      | some t, some text => if Time.check t text.toList then "ok" else "no"
      | none, _ => s!"err unknown type {ty}"
      | _, none => "err invalid UTF-8"
  | _ => "err bad line"

def runTimeBatch (file : System.FilePath) : IO UInt32 := do
  let out ← IO.getStdout
  for line in (← IO.FS.lines file) do
    if !line.isEmpty then out.putStrLn (timeLine line)
  return 0

/-! ## Schema decoding (spec §15) -/

/-- A type in the JSON form of `scripts/schema-types.ts`. -/
partial def tyOfJson (j : Json) : Except String Schema.Ty := do
  if let .ok (name : String) := j.getObjValAs? String "builtin" then
    return ← builtin name
  if let .ok (name : String) := j.getObjValAs? String "time" then
    let some k := Time.TimeType.all.find? (·.name == name) | throw s!"unknown std/time type {name}"
    return .time k
  if let .ok (name : String) := j.getObjValAs? String "ref" then return .ref name
  if let .ok t := j.getObjVal? "array" then return .array (← tyOfJson t)
  if let .ok t := j.getObjVal? "map" then return .map (← tyOfJson t)
  if let .ok t := j.getObjVal? "maybe" then return .maybe (← tyOfJson t)
  if let .ok t := j.getObjVal? "secret" then return .secret (← tyOfJson t)
  if let .ok r := j.getObjVal? "record" then
    let (closed, fields) ← record r
    return .record closed fields
  if let .ok v := j.getObjVal? "variant" then
    let closed ← v.getObjValAs? Bool "closed"
    let cases ← (← v.getObjValAs? (Array Json) "cases").toList.mapM fun c => do
      let tag ← c.getObjValAs? String "tag"
      let p : Json ← c.getObjVal? "payload"
      if p == Json.str "none" then return Schema.Case.bare tag
      if let .ok r := p.getObjVal? "record" then
        let (cl, fields) ← record r
        return .record tag cl fields
      return .positional tag (← (← p.getObjValAs? (Array Json) "positional").toList.mapM tyOfJson)
    return .variant closed cases
  throw s!"not a type: {j.compress}"
where
  builtin : String → Except String Schema.Ty
    | "String" => pure .string | "Bytes" => pure .bytes | "Bool" => pure .bool
    | "Int" => pure (.int .int) | "Decimal" => pure .decimal | "Any" => pure .any
    | "Float32" => pure (.float .f32) | "Float64" => pure (.float .f64)
    | "Int8" => pure (.int (.signed 8)) | "Int16" => pure (.int (.signed 16))
    | "Int32" => pure (.int (.signed 32)) | "Int64" => pure (.int (.signed 64))
    | "UInt8" => pure (.int (.unsigned 8)) | "UInt16" => pure (.int (.unsigned 16))
    | "UInt32" => pure (.int (.unsigned 32)) | "UInt64" => pure (.int (.unsigned 64))
    | name => throw s!"unknown built-in type {name}"
  record (r : Json) : Except String (Bool × List Schema.Field) := do
    let fields ← (← r.getObjValAs? (Array Json) "fields").toList.mapM fun f => do
      return Schema.Field.mk (← f.getObjValAs? String "key") (← f.getObjValAs? Bool "optional") (← tyOfJson (← f.getObjVal? "type"))
    return (← r.getObjValAs? Bool "closed", fields)

/-- Each suite of a TYPES file: its environment, or why its schema file was rejected. -/
def readSuites (file : System.FilePath) : IO (List (String × Except String Schema.Env)) := do
  let json ← IO.ofExcept (Json.parse (← IO.FS.readFile file))
  let suites ← IO.ofExcept (json.getObjValAs? (Array Json) "suites")
  suites.toList.mapM fun s => do
    let name ← IO.ofExcept (s.getObjValAs? String "name")
    if let .ok e := s.getObjValAs? String "error" then return (name, .error e)
    let defs ← IO.ofExcept (s.getObjValAs? (Array Json) "defs")
    let defs ← IO.ofExcept <| defs.toList.mapM fun d => do
      let #[k, t] ← d.getArr? | throw s!"not a definition: {d.compress}"
      return ((← k.getStr?), ← tyOfJson t)
    return (name, .ok ⟨defs⟩)

/-- Decode with a named type, then encode: the canonical form of the result (spec §12). -/
def decodeCanonical (env : Schema.Env) (type : String) (v : Value) : Except Schema.Error String :=
  (Schema.decode env (.ref type) v).map fun x => String.ofList (Canonical.canonical (Schema.encode x))

/-- A case of `NAME.cases.haus`: `Ok { type, input, output? }` or `Err { type, input }`. -/
def schemaCase : Value → Option (Bool × String × Value × Value)
  | .variant tag [.record fs] => do
    let ok ← if tag == "Ok" then some true else if tag == "Err" then some false else none
    let .str type ← fs.lookup "type" | none
    let input ← fs.lookup "input"
    return (ok, type, input, (fs.lookup "output").getD input)
  | _ => none

def runSchemaSuite (dir types : System.FilePath) : IO UInt32 := do
  let mut failures : Array String := #[]
  let mut skipped : Array String := #[]
  let mut count := 0
  for (name, env) in ← readSuites types do
    let cases ← match parseBytes (← IO.FS.readBinFile (dir / s!"{name}.cases.haus")) with
      | .ok vs => pure vs
      | .error e => throw (IO.userError s!"{name}.cases.haus: {e}")
    match env with
    | .error e => skipped := skipped.push s!"{name}: {cases.length} cases skipped, the schema file is rejected: {e}"
    | .ok env =>
      for c in cases do
        count := count + 1
        let shown := String.ofList (Canonical.canonical c)
        match schemaCase c with
        | none => failures := failures.push s!"{name}: not a case: {shown}"
        | some (true, type, input, output) =>
          match decodeCanonical env type input with
          | .ok got =>
            let want := String.ofList (Canonical.canonical output)
            if got != want then failures := failures.push s!"{name}: {shown}: got {got}"
          | .error e => failures := failures.push s!"{name}: {shown}: {e.place}: {e.reason}"
        | some (false, type, input, _) =>
          if let .ok got := decodeCanonical env type input then
            failures := failures.push s!"{name}: {shown}: accepted as {got}"
  for f in failures do IO.println f
  for s in skipped do IO.println s
  IO.println s!"{count - failures.size}/{count} passed"
  return if failures.isEmpty then 0 else 1

/-- One line of `--schema-batch`: `SUITE TYPE HEX`. -/
def schemaLine (suites : List (String × Except String Schema.Env)) (line : String) : String :=
  match line.splitOn " " with
  | [suite, type, hex] =>
    match suites.lookup suite, parseBytes (unhex hex) with
    | some (.ok env), .ok [v] =>
      match decodeCanonical env type v with
      | .ok got => s!"ok {got}"
      | .error e => s!"err {e.place} {(e.reason.replace "\r" "\\r").replace "\n" "\\n"}"
    | some (.ok _), _ => "err $ not a single value"
    | some (.error _), _ => "err $ schema rejected"
    | none, _ => s!"err $ unknown suite {suite}"
  | _ => "err $ bad line"

def runSchemaBatch (types file : System.FilePath) : IO UInt32 := do
  let suites ← readSuites types
  let out ← IO.getStdout
  for line in (← IO.FS.lines file) do
    if !line.isEmpty then out.putStrLn (schemaLine suites line)
  return 0

def main : List String → IO UInt32
  | ["--suite", dir] => runSuite dir
  | ["--batch", dir, n] => runBatch batchLine dir n.toNat!
  | ["--canonical-batch", dir, n] => runBatch canonicalLine dir n.toNat!
  | ["--canonical", file] => do
      match parseBytes (← IO.FS.readBinFile file) with
      | .ok vs => for v in vs do IO.println (String.ofList (Canonical.canonical v))
                  return 0
      | .error e => IO.eprintln s!"error: {e}"; return 1
  | ["--time", ty, text] =>
      match timeType? ty with
      | some t => do
          let ok := Time.check t text.toList
          IO.println (if ok then "ok" else "invalid"); return if ok then 0 else 1
      | none => do IO.eprintln s!"{ty} is not a std/time type"; return 2
  | ["--time-batch", file] => runTimeBatch file
  | ["--schema-suite", dir] => runSchemaSuite dir "schema-suite.json"
  | ["--schema-suite", dir, types] => runSchemaSuite dir types
  | ["--schema-batch", types, file] => runSchemaBatch types file
  | [file] => do
      match parseBytes (← IO.FS.readBinFile file) with
      | .ok vs => IO.println (Json.arr (vs.map toJson).toArray).compress; return 0
      | .error e => IO.eprintln s!"error: {e}"; return 1
  | _ => do IO.eprintln "usage: haus-ref FILE | --suite DIR | --batch DIR N | --canonical FILE | --canonical-batch DIR N | --time TYPE TEXT | --time-batch FILE | --schema-suite DIR [TYPES] | --schema-batch TYPES FILE"; return 2
