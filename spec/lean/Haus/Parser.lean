import Haus.Lexical
import Haus.Value

/-!
# The reference parser

Computes `Haus.Grammar.File`: `parse L t = .ok vs` should hold exactly when
`File L t vs` does (not proven yet). Written for clarity, not speed.

A parser `P α` reads from the remaining input (its state) and returns an `α`
or an `Error`. Every function is total, so that it can be reasoned about:
the recursive ones take *fuel*, a bound on their recursion depth. Each level
of recursion reads at least one character for every three calls, so
`4 * (length + 1)` is always enough, and running out is a bug, not an
answer.
-/

namespace Haus.Parser
open Haus

structure Error where
  reason : String
  /-- Characters left in the input where the error is. -/
  remaining : Nat
  deriving Repr

/-- An error at the start of `t`, a suffix of the input. -/
def Error.at (reason : String) (t : Text) : Error := ⟨reason, t.length⟩

/-- Reads the remaining input; fails with an `Error`. -/
abbrev P := StateT Text (Except Error)

def fail {α : Type} (reason : String) : P α := do throw (.at reason (← get))
def failAt {α : Type} (reason : String) (t : Text) : P α := throw (.at reason t)

/-- Skips `n` characters. -/
def skip (n : Nat := 1) : P Unit := modify (·.drop n)

/-- The longest prefix whose characters satisfy `p`. -/
def takeWhile (p : Char → Bool) : P Text := do
  let t ← get
  set (t.dropWhile p)
  return t.takeWhile p

/-- `U+001B` -/
def codePoint (c : Char) : String :=
  let d := Nat.toDigits 16 c.toNat |>.map Char.toUpper
  "U+" ++ String.ofList (List.replicate (4 - d.length) '0' ++ d)

def describe : Text → String
  | [] => "end of input"
  | '\n' :: _ => "line break"
  | c :: _ => if isRawControl c || isBidi c then codePoint c else s!"'{c}'"

def expect (c : Char) (what : String) : P Unit := do
  match ← get with
  | d :: r => if c == d then set r else fail s!"{what}, found {describe (d :: r)}"
  | [] => fail s!"{what}, found end of input"

/-! ## Whitespace and comments -/

/-- After the `/*` at `start`, `d` levels deep: the input after the matching `*/`. -/
def blockComment (start : Text) : Nat → Text → Except Error Text
  | _, [] => .error (.at "unterminated block comment" start)
  | d, '/' :: '*' :: r => blockComment start (d + 1) r
  | d, '*' :: '/' :: r => if d ≤ 1 then .ok r else blockComment start (d - 1) r
  | d, c :: r =>
      if isBidi c then .error (.at "raw bidirectional control character in comment" (c :: r))
      else if isRawControl c && c != '\t' && c != '\n' && !(c == '\r' && r.head? == some '\n') then
        .error (.at "raw control character in comment" (c :: r))
      else blockComment start d r

def wsLoop : Nat → P Unit
  | 0 => fail "out of fuel"
  | n + 1 => do
    match ← get with
    | ' ' :: r | '\t' :: r | '\n' :: r | '\r' :: '\n' :: r => set r; wsLoop n
    | '\r' :: _ => fail "carriage return without a line feed"
    | '/' :: '/' :: r =>
        set r
        -- The comment ends before its line break; a lone CR is caught by the case above.
        let body ← takeWhile fun c => c != '\n' && c != '\r'
        -- Reported at the first offending character.
        match body.findIdx? fun c => isBidi c || (isRawControl c && c != '\t') with
        | some i =>
            let at_ := r.drop i
            if at_.head?.any isBidi then failAt "raw bidirectional control character in comment" at_
            else failAt "raw control character in comment" at_
        | none => wsLoop n
    | t@('/' :: '*' :: r) => set (← blockComment t 1 r); wsLoop n
    | '/' :: _ => fail "unexpected '/' (comments are // or /* */)"
    | _ => pure ()

/-- `ws`: blanks, line breaks and comments. -/
def ws : P Unit := do wsLoop ((← get).length + 1)

/-! ## Numbers

Lexing is pure: each function returns what it read and the rest. -/

/-- `( "_"? d )*`: the longest such prefix, and the rest. -/
def sepTail (p : Char → Bool) : Text → Text × Text
  | '_' :: c :: r =>
      if p c then let (a, b) := sepTail p r; ('_' :: c :: a, b) else ([], '_' :: c :: r)
  | c :: r => if p c then let (a, b) := sepTail p r; (c :: a, b) else ([], c :: r)
  | [] => ([], [])

/-- `d ( "_"? d )*` -/
def digits (p : Char → Bool) : Text → Option (Text × Text)
  | c :: r => if p c then let (a, b) := sepTail p r; some (c :: a, b) else none
  | [] => none

/-- `int ::= "0" | [1-9] ( "_"? [0-9] )*` -/
def lexInt : Text → Option (Text × Text)
  | '0' :: r => some (['0'], r)
  | t@(c :: _) => if c != '0' then digits isDigit t else none
  | [] => none

/-- `frac ::= "." digits`, or nothing. -/
def lexFrac : Text → Text × Text
  | '.' :: r => match digits isDigit r with
    | some (ds, b) => ('.' :: ds, b)
    | none => ([], '.' :: r)
  | r => ([], r)

/-- `[+-]?`, or nothing. -/
def lexSign : Text → Text × Text
  | '+' :: r => (['+'], r)
  | '-' :: r => (['-'], r)
  | r => ([], r)

/-- `exp ::= [eE] [+-]? digits`, or nothing. -/
def lexExp : Text → Text × Text
  | m :: r =>
      if m == 'e' || m == 'E' then
        match digits isDigit (lexSign r).2 with
        | some (ds, b) => (m :: (lexSign r).1 ++ ds, b)
        | none => ([], m :: r)
      else ([], m :: r)
  | [] => ([], [])

/-- A lexed number: the whole literal, its exponent part (empty for hex and binary), the rest. -/
structure Lexed where
  literal : Text
  exponent : Text
  rest : Text

/-- `int frac? exp?`, after the sign `s`. -/
def lexDecimal (s r : Text) : Option Lexed := do
  let (i, r) ← lexInt r
  let (f, r) := lexFrac r
  let (e, r) := lexExp r
  return ⟨s ++ i ++ f ++ e, e, r⟩

/-- Digits after a radix prefix such as `0x`, after the sign `s`. -/
def lexRadix (p : Char → Bool) (s pre r : Text) : Option Lexed :=
  (digits p r).map fun (ds, b) => ⟨s ++ pre ++ ds, [], b⟩

/-- `"-"?`: the sign and the rest. -/
def lexMinus : Text → Text × Text
  | '-' :: r => (['-'], r)
  | r => ([], r)

/-- `decimal | "0x" hex | "0b" binary`, after the sign `s`. -/
def lexUnsigned (s : Text) : Text → Option Lexed
  | '0' :: 'x' :: r => lexRadix isHexDigit s ['0', 'x'] r <|> lexDecimal s ('0' :: 'x' :: r)
  | '0' :: 'b' :: r => lexRadix isBinDigit s ['0', 'b'] r <|> lexDecimal s ('0' :: 'b' :: r)
  | r => lexDecimal s r

/-- `"-"? ( decimal | "0x" hex | "0b" binary )` -/
def lexNumber (t : Text) : Option Lexed := lexUnsigned (lexMinus t).1 (lexMinus t).2

def number (L : Limits) : P Value := do
  let some n := lexNumber (← get) | fail "invalid number"
  -- A number must not run into a following identifier or `.`: `007`, `1.`, `1_`.
  if n.rest.head?.any (fun c => isIdentChar c || c == '.') then fail "invalid number"
  if n.literal.length > L.maxNumberLength then fail s!"number literal longer than {L.maxNumberLength} characters"
  if expMagnitude n.exponent > L.maxExponent then fail s!"exponent larger than {L.maxExponent}"
  set n.rest
  return .num (normalizeNumber n.literal)

/-! ## Strings -/

/-- At a backslash: the character it escapes. -/
def escape : P Char := do
  match ← get with
  | '\\' :: '"' :: r => set r; return '"'
  | '\\' :: '\\' :: r => set r; return '\\'
  | '\\' :: 'n' :: r => set r; return '\n'
  | '\\' :: 'r' :: r => set r; return '\r'
  | '\\' :: 't' :: r => set r; return '\t'
  | t@('\\' :: 'u' :: '{' :: r) =>
      let ds := r.takeWhile isHexDigit
      let v := digitsValue 16 ds
      match r.dropWhile isHexDigit with
      | '}' :: r'' =>
          if ds.length < 1 || ds.length > 6 then failAt "invalid unicode escape: expected \\u{1-6 hex digits}" t
          else if !isScalar v then failAt s!"\\u\{{String.ofList ds}} is not a Unicode scalar value" t
          else set r''; return Char.ofNat v
      | _ => failAt "invalid unicode escape: expected \\u{1-6 hex digits}" t
  | _ => fail "invalid escape"

/--
Characters allowed by `ok`, and escapes, until `stop` holds for the rest: their
text. Running out of input is reported at `start`, the opening quote.
-/
def chars (what : String) (start : Text) (ok : Char → Bool) (stop : Text → Bool) : Nat → Text → P Text
  | 0, _ => fail "out of fuel"
  | n + 1, acc => do
    let t ← get
    if stop t then return acc.reverse
    match t with
    | [] => failAt s!"unterminated {what}" start
    | '\\' :: _ => chars what start ok stop n ((← escape) :: acc)
    | c :: r =>
        if isBidi c then fail "raw bidirectional control character (write it as an escape)"
        else if ok c then set r; chars what start ok stop n (c :: acc)
        else fail s!"{describe t} is not allowed in a {what}"

/-- `basic_char`, apart from the backslash and bidi controls (checked by `chars`). -/
def basicChar (c : Char) : Bool := c != '"' && !isRawControl c
/-- `block_char`, apart from the backslash and bidi controls. -/
def blockChar (c : Char) : Bool := c == '\t' || !isRawControl c

def checkLength (L : Limits) (s : Text) (start : Text) : P String :=
  if s.length > L.maxStringLength then failAt s!"string longer than {L.maxStringLength} characters" start
  else return String.ofList s

def basicString (L : Limits) : P String := do
  let start ← get
  skip
  let s ← chars "string" start basicChar (·.head? == some '"') (start.length + 1) []
  skip
  checkLength L s start

/-- Splits at the first unescaped `"""`: the content before it and the rest after it. -/
def findClose : Text → Option (Text × Text)
  | '\\' :: c :: r => (findClose r).map fun (a, b) => ('\\' :: c :: a, b)
  | '"' :: '"' :: '"' :: r => some ([], r)
  | c :: r => (findClose r).map fun (a, b) => (c :: a, b)
  | [] => none

/-- Splits at line feeds. -/
def splitLines : Text → List Text
  | [] => [[]]
  | '\n' :: r => [] :: splitLines r
  | c :: r => match splitLines r with
    | l :: ls => (c :: l) :: ls
    | [] => [[c]]

/-- One content line of a block string: the indent removed and escapes processed. -/
def blockLine (indent line : Text) : Except Error Text :=
  -- A carriage return is only allowed as part of CRLF.
  let line := if line.getLast? == some '\r' then line.dropLast else line
  if indent <+: line then
    let raw := line.drop indent.length
    (chars "block string" raw blockChar List.isEmpty (raw.length + 1) []).run' raw
  else if line.all isBlank then .ok []
  else .error (.at "line is indented less than the closing \"\"\"" line)

/-- After the opening line of the block string at `start`: the content up to and including the closing quotes. -/
def blockBody (L : Limits) (start : Text) : P String := do
  let some (content, rest) := findClose (← get) | failAt "unterminated block string" start
  let lines := splitLines content
  let indent := lines.getLast?.getD []
  if !indent.all isBlank then failAt "closing \"\"\" must be on its own line" start
  -- Errors inside the content are reported at the start of the block string.
  let decoded ← match (lines.dropLast).mapM (blockLine indent) with
    | .ok ds => pure ds
    | .error e => failAt e.reason start
  set rest
  checkLength L (List.intercalate ['\n'] decoded) start

def blockString (L : Limits) : P String := do
  let start ← get
  skip 3
  let _ ← takeWhile isBlank
  match ← get with
  | '\r' :: '\n' :: r | '\n' :: r => set r
  | _ => fail "opening \"\"\" must be followed by a line break"
  blockBody L start

/-! ## Byte strings -/

/-- The text between the quotes of `x"…"`: hex pairs and blanks until `"`. -/
def byteChars : Text → Except Error (List UInt8 × Text)
  | '"' :: r => .ok ([], r)
  | t@(c :: r) =>
      if isBlank c then byteChars r
      else if !isHexDigit c then .error (.at s!"{describe t} in byte string (expected hex digits)" t)
      else match r with
        | l :: r' =>
            if isHexDigit l then
              (byteChars r').map fun (bs, rest) => (UInt8.ofNat (hexValue c * 16 + hexValue l) :: bs, rest)
            else .error (.at "a byte needs two hex digits" t)
        | [] => .error (.at "unterminated byte string" [])
  | [] => .error (.at "unterminated byte string" [])

def bytes (L : Limits) : P Value := do
  let start ← get
  -- An unterminated byte string is reported at its start, like a string.
  let (bs, rest) ← match byteChars (start.drop 2) with
    | .ok r => pure r
    | .error e => if e.reason == "unterminated byte string" then failAt e.reason start else throw e
  if start.length - rest.length - 3 > L.maxStringLength then
    failAt s!"byte string longer than {L.maxStringLength} characters" start
  set rest
  return .bytes bs

/-! ## Values -/

def key (L : Limits) : P String := do
  match ← get with
  | '"' :: '"' :: '"' :: _ => fail "block strings can't be record keys"
  | '"' :: _ => basicString L
  | c :: _ =>
      if isLowerStart c then return String.ofList (← takeWhile isIdentChar)
      else if isUpper c then fail "record keys must start with a lowercase letter or '_'; quote it"
      else fail s!"expected a record key, found '{c}'"
  | [] => fail "expected a record key, found end of input"

/-- The error for a lowercase word where a value should be. -/
def identifierError (word : String) : String :=
  let hint :=
    if word == "true" || word == "false" then " (booleans are the variants True / False)"
    else if word == "null" then " (use the variant None)"
    else ""
  s!"unexpected identifier '{word}': lowercase identifiers can only be record keys{hint}"

mutual
  /-- A value, within `budget` levels of nesting. -/
  def value (L : Limits) : Nat → Nat → P Value
    | 0, _ => fail "out of fuel"
    | fuel + 1, budget => do
      match ← get with
      | '{' :: _ => return .record (← record L fuel budget)
      | '[' :: _ => return .arr (← items L fuel budget ']')
      | '"' :: '"' :: '"' :: _ => return .str (← blockString L)
      | '"' :: _ => return .str (← basicString L)
      | 'x' :: '"' :: _ => bytes L
      | t@(c :: _) =>
          if c == '-' || isDigit c then number L
          else if isUpper c then variant L fuel budget
          else if isLowerStart c then fail (identifierError (String.ofList (t.takeWhile isIdentChar)))
          else fail s!"expected a value, found {describe t}"
      | [] => fail "expected a value, found end of input"

  /-- `Tag`, `Tag(…)` or `Tag { … }`. A payload starts on the tag's line. -/
  def variant (L : Limits) : Nat → Nat → P Value
    | 0, _ => fail "out of fuel"
    | fuel + 1, budget => do
      let name := String.ofList (← takeWhile isIdentChar)
      let afterTag ← get
      let _ ← takeWhile isBlank
      match ← get with
      | t@('(' :: _) =>
          let xs ← items L fuel budget ')'
          if xs.isEmpty then failAt s!"empty payload: write '{name}' without parentheses" t
          return .variant name xs
      | '{' :: _ => return .variant name [.record (← record L fuel budget)]
      | _ => set afterTag; return .variant name []

  /-- `{ … }`: one level. -/
  def record (L : Limits) : Nat → Nat → P (List (String × Value))
    | 0, _ => fail "out of fuel"
    | _, 0 => fail s!"nesting deeper than {L.maxDepth} levels"
    | fuel + 1, budget + 1 => do
      let start ← get
      skip
      ws
      fields L fuel budget start []

  def fields (L : Limits) : Nat → Nat → Text → List (String × Value) → P (List (String × Value))
    | 0, _, _, _ => fail "out of fuel"
    | fuel + 1, budget, start, acc => do
      match ← get with
      | '}' :: r => set r; return acc.reverse
      | [] => failAt "unclosed '{'" start
      | t =>
          let k ← key L
          ws
          expect ':' s!"expected ':' after key '{k}'"
          ws
          let v ← value L fuel budget
          if acc.any (·.1 == k) then failAt s!"duplicate key '{k}'" t
          ws
          match ← get with
          | ',' :: r => set r; ws; fields L fuel budget start ((k, v) :: acc)
          | '}' :: r => set r; return ((k, v) :: acc).reverse
          | [] => failAt "unclosed '{'" start
          | r => fail s!"expected ',' or '}}', found {describe r}"

  /-- `[ … ]` or `( … )`: one level. -/
  def items (L : Limits) : Nat → Nat → Char → P (List Value)
    | 0, _, _ => fail "out of fuel"
    | _, 0, _ => fail s!"nesting deeper than {L.maxDepth} levels"
    | fuel + 1, budget + 1, close => do
      let start ← get
      skip
      ws
      itemsLoop L fuel budget close start []

  def itemsLoop (L : Limits) : Nat → Nat → Char → Text → List Value → P (List Value)
    | 0, _, _, _, _ => fail "out of fuel"
    | fuel + 1, budget, close, start, acc => do
      match ← get with
      | c :: r =>
          if c == close then set r; return acc.reverse
          let v ← value L fuel budget
          ws
          match ← get with
          | ',' :: r => set r; ws; itemsLoop L fuel budget close start (v :: acc)
          | c :: r =>
              if c == close then set r; return (v :: acc).reverse
              else fail s!"expected ',' or '{close}', found {describe (c :: r)}"
          | [] => failAt s!"unclosed bracket" start
      | [] => failAt s!"unclosed bracket" start
end

/-! ## Files -/

def fileLoop (L : Limits) (fuel : Nat) : Nat → List Value → P (List Value)
  | 0, _ => fail "out of fuel"
  | n + 1, acc => do
    if (← get).isEmpty then return acc.reverse
    let v ← value L fuel L.maxDepth
    ws
    match ← get with
    | [] => return (v :: acc).reverse
    | ',' :: r => set r; ws; fileLoop L fuel n (v :: acc)
    | r => fail s!"expected ',' between top-level values, found {describe r}"

/-- A file: its values, or the first error. A leading byte order mark is skipped. -/
def parse (L : Limits) (input : Text) : Except Error (List Value) :=
  let t := match input with
    | '\uFEFF' :: r => r
    | r => r
  let fuel := 4 * (t.length + 1)
  (do ws; fileLoop L fuel fuel []).run' t

end Haus.Parser
