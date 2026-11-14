import Haus.Value
import Haus.Parser

/-!
# The canonical form (spec §12)

`canonical v` is the text of `v` in canonical form: `write` applied to
`v.canon`, which sorts every record's fields by code point. `write` itself
writes values as they are, so it is simple to reason about.

`hash v` (spec §12) is the SHA-256 digest of the UTF-8 bytes of
`canonical v`; the digest itself is not modelled here.
-/

namespace Haus.Canonical
open Haus

/-- A hex digit, lowercase: `0`–`9`, `a`–`f`. -/
def hexDigit (n : Nat) : Char := if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- A number in hex, lowercase, without leading zeros. -/
def hex (n : Nat) : Text := Nat.toDigits 16 n

/-- The default number limit (spec §7). -/
def numberLimit : Nat := ({} : Limits).maxNumberLength

/--
A number: its normalized literal, except an integer whose decimal form is
longer than the number limit, which is written in hex.
-/
def number (literal : String) : Text :=
  let t := literal.toList
  let (sign, ds) := match t with
    | '-' :: ds => (['-'], ds)
    | ds => ([], ds)
  if t.length > numberLimit && ds.all isDigit then sign ++ '0' :: 'x' :: hex (digitsValue 10 ds) else t

/-- One character of a string: escaped if it must be, otherwise itself. -/
def escape : Char → Text
  | '"' => ['\\', '"']
  | '\\' => ['\\', '\\']
  | '\n' => ['\\', 'n']
  | '\r' => ['\\', 'r']
  | '\t' => ['\\', 't']
  | c =>
    if isRawControl c || isBidi c then
      ['\\', 'u', '{'] ++ (Nat.toDigits 16 c.toNat).map Char.toUpper ++ ['}']
    else [c]

/-- `"…"` with the minimal escapes. -/
def string (s : String) : Text := '"' :: s.toList.flatMap escape ++ ['"']

/-- A key that can be written bare: `[a-z_][A-Za-z0-9_]*`. -/
def isIdent (k : String) : Bool :=
  match k.toList with
  | c :: cs => isLowerStart c && cs.all isIdentChar
  | [] => false

def key (k : String) : Text := if isIdent k then k.toList else string k

/-- `x"…"`: two lowercase hex digits per byte. -/
def bytes (bs : List UInt8) : Text :=
  'x' :: '"' :: bs.flatMap (fun b => [hexDigit (b.toNat / 16), hexDigit (b.toNat % 16)]) ++ ['"']

mutual
/-- A value as it is, in the canonical spelling. Fields are written in the order given. -/
def write : Value → Text
  | .num s => number s
  | .str s => string s
  | .bytes bs => bytes bs
  | .arr xs => '[' :: writeList xs ++ [']']
  | .record fs => '{' :: writeFields fs ++ ['}']
  | .variant t [] => t.toList
  | .variant t [.record fs] => t.toList ++ '{' :: writeFields fs ++ ['}']
  | .variant t (x :: xs) => t.toList ++ '(' :: writeList (x :: xs) ++ [')']

/-- Values separated by `,`. -/
def writeList : List Value → Text
  | [] => []
  | [x] => write x
  | x :: xs => write x ++ ',' :: writeList xs

/-- `key:value` fields separated by `,`. -/
def writeFields : List (String × Value) → Text
  | [] => []
  | [(k, v)] => key k ++ ':' :: write v
  | (k, v) :: fs => key k ++ ':' :: write v ++ ',' :: writeFields fs
end

/-- **The canonical form** of a value (spec §12). -/
def canonical (v : Value) : Text := write v.canon

/--
**The canonical form of a list of values** (spec §12, `hashAll`): their
canonical forms joined by `,`, with no trailing comma. A file or stream is
hashed as this text.
-/
def canonicalAll (vs : List Value) : Text := writeList (vs.map Value.canon)

/-- A list of one value is written like the value: `hashAll [v] = hash v`. -/
theorem canonicalAll_single (v : Value) : canonicalAll [v] = canonical v := rfl

/-! ## Examples -/

private def canonicalOf (src : String) : Option String :=
  match Parser.parse {} src.toList with
  | .ok [v] => some (String.ofList (canonical v))
  | _ => none

-- The example of spec §12.
#guard canonicalOf "Order { total: 19.90, id: 0xFF, \"x-y\": 1e+5, p: Point(1, 2) }" ==
  some "Order{id:255,p:Point(1,2),total:19.90,\"x-y\":1e5}"
-- Layout, comments, key order and spellings don't matter.
#guard canonicalOf "{ b: [1_000, 0b11], /* c */ a: Tag({ x: x\"0B 34\" }) }" ==
  canonicalOf "{a:Tag{x:x\"0b34\"},b:[1000,3]}"
#guard canonicalOf "{a:Tag{x:x\"0b34\"},b:[1000,3]}" == some "{a:Tag{x:x\"0b34\"},b:[1000,3]}"
-- Strings: minimal escapes, uppercase hex for the rest, block strings become "…".
#guard canonicalOf "\"tab\\tquote\\\" \\u{41} \\u{1b} \\u{202e} café\"" ==
  some "\"tab\\tquote\\\" A \\u{1B} \\u{202E} café\""
#guard canonicalOf "\"\"\"\n  two\n  lines\n  \"\"\"" == some "\"two\\nlines\""
-- Keys: bare when they can be, sorted by code point ("Z" before "a", "é" last).
#guard canonicalOf "{ \"é\": 1, a: 2, \"Z\": 3, \"x-y\": 4 }" == some "{\"Z\":3,a:2,\"x-y\":4,\"é\":1}"
-- Numbers keep their scale; a huge hex integer stays hex.
#guard canonicalOf "[1.0, 1, -0, -0x0, 1E+05]" == some "[1.0,1,-0,0,1e5]"
#guard canonicalOf ("0x" ++ String.ofList (List.replicate 900 'f')) ==
  some ("0x" ++ String.ofList (List.replicate 900 'f'))
-- Variants: bare, a single record payload as Tag{…}, otherwise Tag(…).
#guard canonicalOf "[None, Some(1), Circle({ r: 1 }), Pair({ a: 1 }, 2)]" ==
  some "[None,Some(1),Circle{r:1},Pair({a:1},2)]"

private def canonicalAllOf (src : String) : Option String :=
  match Parser.parse {} src.toList with
  | .ok vs => some (String.ofList (canonicalAll vs))
  | _ => none

-- A file or stream: canonical forms joined by `,`. `v` and `v,` are the same file.
#guard canonicalAllOf "1, \"a\", Order { id: 0xFF }," == some "1,\"a\",Order{id:255}"
#guard canonicalAllOf "{ b: 1, a: 2 }," == canonicalOf "{ b: 1, a: 2 }"
#guard canonicalAllOf "  // nothing\n" == some ""

end Haus.Canonical
