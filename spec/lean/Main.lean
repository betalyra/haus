import Haus
import Lean.Data.Json

/-!
`haus-ref`: the reference parser on the command line.

    haus-ref FILE          print FILE's values in the test-suite JSON encoding
    haus-ref --suite DIR   run the conformance suite in DIR (valid/ and invalid/)
    haus-ref --batch DIR N for DIR/00000.haus … DIR/{N-1}.haus, one line each:
                           `ok <values>` or `err <line> <column> <reason>` (fuzz/)
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

def runBatch (dir : System.FilePath) (n : Nat) : IO UInt32 := do
  let out ← IO.getStdout
  for i in [0:n] do
    let name := String.ofList (List.replicate (5 - (toString i).length) '0') ++ toString i
    out.putStrLn (batchLine (← IO.FS.readBinFile (dir / s!"{name}.haus")))
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

def main : List String → IO UInt32
  | ["--suite", dir] => runSuite dir
  | ["--batch", dir, n] => runBatch dir n.toNat!
  | [file] => do
      match parseBytes (← IO.FS.readBinFile file) with
      | .ok vs => IO.println (Json.arr (vs.map toJson).toArray).compress; return 0
      | .error e => IO.eprintln s!"error: {e}"; return 1
  | _ => do IO.eprintln "usage: haus-ref FILE | haus-ref --suite DIR | haus-ref --batch DIR N"; return 2
