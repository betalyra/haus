import Haus.Parser

/-!
# The stream reader (spec §6)

A model of the stream readers of the bindings (TypeScript `StreamReader`,
Rust `StreamReader`, Roc `Stream`). They all work the same way:

1. A small **scanner** finds the commas that separate top-level values. It
   tracks only what decides that: bracket depth, strings, block strings and
   comments. Everything else is left to the parser.
2. Each piece of text before such a comma is **parsed** on its own, as a
   file with exactly one value. What is left at the end is parsed as a file
   with at most one value.

Text arrives in chunks, split anywhere. The scanner looks at most three
characters ahead (`"""`, `//`, `*/`, `\"`); when a chunk ends before it can
decide, it waits for the next one (`Step.wait`). `Haus.Stream.Chunks` proves
that this makes the result independent of the split, and
`Haus.Stream.Correct` that the result is exactly what `parse` gives for the
whole text.

Not modelled: the limit on one value's length (§7, it bounds memory and
only adds an error), strict mode (an error when the last value has no
comma), the decoding of UTF-8 bytes, and the exact error messages and
positions (errors are those of the parser on the piece).
-/

namespace Haus.Stream
open Haus Parser

/-! ## The scanner -/

inductive Mode
  | normal
  /-- In a basic string `"…"` or byte string `x"…"`. -/
  | string
  /-- In a block string `"""…"""`. -/
  | block
  /-- In a line comment. -/
  | line
  /-- In a block comment, nested `depth ≥ 1` levels. -/
  | comment (depth : Nat)
  deriving DecidableEq, Repr

structure St where
  mode : Mode := .normal
  /-- Open brackets: `{`, `[`, `(`. -/
  depth : Nat := 0
  deriving DecidableEq, Repr

/-- What the scanner does at the start of its input. -/
inductive Step
  /-- Wait for more input: it can't decide yet. -/
  | wait
  /-- The next `k + 1` characters belong to the current value; continue in state `s`. -/
  | adv (k : Nat) (s : St)
  /-- A comma separating top-level values. -/
  | cut
  /-- A closing bracket that closes nothing. -/
  | unbalanced
  deriving DecidableEq, Repr

/--
One step at the start of `c :: r`. `final` says no more input will come, so
the scanner never waits; otherwise it waits when it needs to see `n` more
characters than `r` has (`has n`).
-/
def step (final : Bool) (s : St) : Text → Step
  | [] => .wait
  | c :: r =>
    let has (n : Nat) : Bool := final || decide (n ≤ r.length)
    match s.mode with
    | .normal =>
      if c = '/' then
        if !has 1 then .wait
        else if r.head? = some '/' then .adv 1 { s with mode := .line }
        else if r.head? = some '*' then .adv 1 { s with mode := .comment 1 }
        else .adv 0 s
      else if c = '"' then
        if !has 2 then .wait
        else if r.take 2 = ['"', '"'] then .adv 2 { s with mode := .block }
        else .adv 0 { s with mode := .string }
      else if c = '{' ∨ c = '[' ∨ c = '(' then .adv 0 { s with depth := s.depth + 1 }
      else if c = '}' ∨ c = ']' ∨ c = ')' then
        if s.depth = 0 then .unbalanced else .adv 0 { s with depth := s.depth - 1 }
      else if c = ',' ∧ s.depth = 0 then .cut
      else .adv 0 s
    | .line => .adv 0 (if c = '\n' then { s with mode := .normal } else s)
    | .comment d =>
      if c = '/' ∨ c = '*' then
        if !has 1 then .wait
        else if c = '/' ∧ r.head? = some '*' then .adv 1 { s with mode := .comment (d + 1) }
        else if c = '*' ∧ r.head? = some '/' then
          .adv 1 { s with mode := if d ≤ 1 then .normal else .comment (d - 1) }
        else .adv 0 s
      else .adv 0 s
    | .string =>
      -- A line break can't be in a string: back to normal, the parser reports it.
      if c = '\\' then (if !has 1 then .wait else .adv 1 s)
      else if c = '"' ∨ c = '\n' then .adv 0 { s with mode := .normal }
      else .adv 0 s
    | .block =>
      if c = '\\' then (if !has 1 then .wait else .adv 1 s)
      else if c = '"' then
        if !has 2 then .wait
        else if r.take 2 = ['"', '"'] then .adv 2 { s with mode := .normal }
        else .adv 0 s
      else .adv 0 s

/-- Where scanning stopped. -/
inductive Res
  /-- At the end of the input, or waiting for more: the state, the current value's text, the unscanned rest. -/
  | ok (s : St) (cur buf : Text)
  /-- At a closing bracket that closes nothing; the current value's text up to it. -/
  | unbalanced (t : Text)
  deriving DecidableEq, Repr

/--
Scans `t` in state `s`, where `cur` is the current value's text so far: the
texts of the values completed by a top-level comma, and where it stopped.
-/
def scan (final : Bool) (s : St) (cur : Text) : Text → List Text × Res
  | [] => ([], .ok s cur [])
  | c :: r =>
    match step final s (c :: r) with
    | .wait => ([], .ok s cur (c :: r))
    | .adv k s' => scan final s' (cur ++ c :: r.take k) (r.drop k)
    | .cut => (cur :: (scan final s [] r).1, (scan final s [] r).2)
    | .unbalanced => ([], .unbalanced (cur ++ [c]))
termination_by t => t.length
decreasing_by all_goals (simp only [List.length_cons, List.length_drop]; omega)

/-! ## Reading chunks -/

/-- The reader: the texts of the values completed so far, and the scanner. -/
structure Reader where
  pieces : List Text := []
  res : Res := .ok {} [] []
  deriving DecidableEq, Repr

/-- Receives a chunk. After an unbalanced bracket the reader takes nothing more. -/
def Reader.push (rd : Reader) (chunk : Text) : Reader :=
  match rd.res with
  | .unbalanced _ => rd
  | .ok s cur buf => let x := scan false s cur (buf ++ chunk); ⟨rd.pieces ++ x.1, x.2⟩

/-- Scans what is left without waiting. -/
def Reader.close (rd : Reader) : Reader :=
  match rd.res with
  | .unbalanced _ => rd
  | .ok s cur buf => ⟨rd.pieces ++ (scan true s cur buf).1, (scan true s cur buf).2⟩

/-- The input has ended. -/
def Reader.finish (rd : Reader) : Reader := (rd.push []).close

/-- Splits the text arriving as `chunks` into the texts of its top-level values. -/
def split (chunks : List Text) : Reader := (chunks.foldl Reader.push {}).finish

/-! ## Parsing the pieces -/

/--
Parses one piece. The first may start with a byte order mark (`parse` skips
it); a later one may not, since one is only allowed at the start of the
stream.
-/
def parsePiece (L : Limits) (first : Bool) (t : Text) : Except Error (List Value) :=
  if !first && t.head? = some '﻿' then .error (.at "byte order mark after the start of the stream" t)
  else parse L t

/-- The values of the pieces, in order, until the first error. -/
def decode (L : Limits) : Bool → List Text → Res → List Value × Option Error
  | first, p :: ps, res =>
    match parsePiece L first p with
    | .ok [v] => let x := decode L false ps res; (v :: x.1, x.2)
    | .ok _ => ([], some (.at "expected a value before ','" p))
    | .error e => ([], some e)
  | first, [], .ok _ cur buf =>
    match parsePiece L first (cur ++ buf) with
    | .ok vs => (vs, none)
    | .error e => ([], some e)
  | first, [], .unbalanced t =>
    match parsePiece L first t with
    | .error e => ([], some e)
    | .ok _ => ([], some (.at "unbalanced closing bracket" t))

/--
**The stream reader**: the values of the text arriving as `chunks`, and the
error that ended it, if any. The values come in order as their commas
arrive; after an error the stream ends.
-/
def read (L : Limits) (chunks : List Text) : List Value × Option Error :=
  let rd := split chunks
  decode L true rd.pieces rd.res

/-! ## Examples -/

private def readOf (chunks : List String) : List String × Bool :=
  let (vs, e) := read {} (chunks.map String.toList)
  (vs.map fun v => toString (repr v), e.isSome)

private def piecesOf (chunks : List String) : List String :=
  (split (chunks.map String.toList)).pieces.map String.ofList

-- Top-level commas only: not inside brackets, strings or comments.
#guard piecesOf ["{ a: 1, b: \"x,y\" }, [1, 2], // c,\n 3, /* , */ 4,"] ==
  ["{ a: 1, b: \"x,y\" }", " [1, 2]", " // c,\n 3", " /* , */ 4"]
-- Split anywhere, even inside `"""`, `//`, `*/` and escapes: the same pieces.
#guard piecesOf ["\"\"", "\"\n a,\\", "\"\"\"\n \"\"\", 1 /", "/ x,\n, 2 *", "/ 3"] ==
  piecesOf ["\"\"\"\n a,\\\"\"\"\n \"\"\", 1 // x,\n, 2 */ 3"]
#guard readOf ["1, 2", "0, [3,", " 4], 5"] == readOf ["1, 20, [3, 4], 5"]
#guard (readOf ["1, 20, [3, 4], 5,"]).1.length == 4 && !(readOf ["1, 20, [3, 4], 5,"]).2
-- Errors: a value missing between commas, a byte order mark after a comma, a stray bracket.
#guard (readOf ["1,, 2"]).2 && (readOf ["1,﻿2"]).2 && (readOf ["1, 2]"]).2
-- The values before an error are still read.
#guard (readOf ["1, 2, ]"]).1.length == 2
-- A byte order mark at the start is skipped, however the chunks fall.
#guard readOf ["", "﻿", "1, 2"] == readOf ["1, 2"]

end Haus.Stream
