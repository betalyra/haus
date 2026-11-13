/-!
# Lexical helpers

Character classes, limits and small functions on literals, shared by the
grammar (`Haus.Grammar`, the specification) and the reference parser
(`Haus.Parser`).
-/

namespace Haus

/-- Source text, as Unicode scalar values (the input after UTF-8 decoding). -/
abbrev Text := List Char

/-- Resource limits (spec §7). Parsers MUST accept every input within the defaults. -/
structure Limits where
  /-- Nesting depth of records, arrays and payloads. -/
  maxDepth : Nat := 256
  /-- Characters in one number literal. -/
  maxNumberLength : Nat := 1000
  /-- Largest absolute exponent of a decimal literal. -/
  maxExponent : Nat := 6144
  /-- Characters in one decoded string, or between the quotes of a byte string. -/
  maxStringLength : Nat := 16 * 1024 * 1024
  deriving Repr, Inhabited

/-- Raw bidirectional controls, U+202A–U+202E and U+2066–U+2069 ("Trojan Source"). -/
def isBidi (c : Char) : Bool :=
  (0x202A ≤ c.toNat && c.toNat ≤ 0x202E) || (0x2066 ≤ c.toNat && c.toNat ≤ 0x2069)

/--
A raw control character: C0 (U+0000–U+001F, including tab and line breaks),
DEL (U+007F) or C1 (U+0080–U+009F). They can rewrite what a terminal displays
or truncate text, so they appear in raw text only as tab and line breaks, and
only where the grammar allows (§4).
-/
def isRawControl (c : Char) : Bool := c.toNat < 0x20 || (0x7F ≤ c.toNat && c.toNat ≤ 0x9F)

/-- A space or a tab. -/
def isBlank (c : Char) : Bool := c == ' ' || c == '\t'

def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'
def isBinDigit (c : Char) : Bool := c == '0' || c == '1'
def isHexDigit (c : Char) : Bool := isDigit c || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')
def isUpper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
/-- `[a-z_]`: the first character of a record key. -/
def isLowerStart (c : Char) : Bool := ('a' ≤ c && c ≤ 'z') || c == '_'
/-- `[A-Za-z0-9_]` -/
def isIdentChar (c : Char) : Bool := isUpper c || isLowerStart c || isDigit c

/-- The value of a hex digit (0 for other characters). -/
def hexValue (c : Char) : Nat :=
  if isDigit c then c.toNat - '0'.toNat
  else if 'a' ≤ c && c ≤ 'f' then c.toNat - 'a'.toNat + 10
  else if 'A' ≤ c && c ≤ 'F' then c.toNat - 'A'.toNat + 10
  else 0

/-- The value of a sequence of digits in a radix. -/
def digitsValue (radix : Nat) (ds : Text) : Nat :=
  ds.foldl (fun n c => n * radix + hexValue c) 0

/-- A Unicode scalar value: at most U+10FFFF and not a surrogate. -/
def isScalar (n : Nat) : Bool := n ≤ 0x10FFFF && !(0xD800 ≤ n && n ≤ 0xDFFF)

/-- The magnitude of an exponent part such as `e+1_0`, for the limit (§7). -/
def expMagnitude (e : Text) : Nat := digitsValue 10 (e.filter isDigit)

/-- Digits without leading zeros: `007` is `7`, `000` is `0`. -/
def stripZeros (ds : Text) : Text :=
  match ds.dropWhile (· == '0') with
  | [] => ['0']
  | z => z

/--
An exponent's digits and sign, as its value: `+05` is `5`, `-0` is `0`.
The marker `e` is written by the caller.
-/
def normalizeExponent (e : Text) : Text :=
  let (neg, ds) := match e with
    | '-' :: r => (true, r)
    | '+' :: r => (false, r)
    | r => (false, r)
  let ds := stripZeros ds
  if neg && ds != ['0'] then '-' :: ds else ds

/--
A number's literal after its sign: digit separators removed, the exponent
written `e` and its value, hex and binary converted to decimal integers.
-/
def normalizeBody (neg : Bool) (body : Text) : String :=
  let integer (n : Nat) := (if neg && n != 0 then "-" else "") ++ toString n
  match body.filter (· != '_') with
  | '0' :: 'x' :: ds => integer (digitsValue 16 ds)
  | '0' :: 'b' :: ds => integer (digitsValue 2 ds)
  | ds =>
    let mantissa := ds.takeWhile (fun c => c != 'e' && c != 'E')
    let exponent := match ds.dropWhile (fun c => c != 'e' && c != 'E') with
      | _ :: e => 'e' :: normalizeExponent e
      | [] => []
    String.ofList ((if neg then ['-'] else []) ++ mantissa ++ exponent)

/--
The normalized literal of a number (§2): digit separators removed, the
exponent written `e` and its value (`E+05` is `e5`), hex and binary
converted to decimal integers. `-0x0` is `0`; a decimal `-0` stays `-0`.
-/
def normalizeNumber : Text → String
  | '-' :: r => normalizeBody true r
  | r => normalizeBody false r

#guard normalizeNumber "1E+0_5".toList == "1e5"
#guard normalizeNumber "-2.50e-03".toList == "-2.50e-3"
#guard normalizeNumber "1e-0".toList == "1e0"
#guard normalizeNumber "1e000".toList == "1e0"
#guard normalizeNumber "1_000.0".toList == "1000.0"
#guard normalizeNumber "-0x0".toList == "0" && normalizeNumber "-0".toList == "-0"
#guard normalizeNumber "0xFF".toList == "255"

/--
The content of a block string ends at the first `"""` that isn't escaped:
true when `t` has none. A backslash escapes the character after it.
-/
def noTripleQuote : Text → Bool
  | '\\' :: _ :: rest => noTripleQuote rest
  | '"' :: '"' :: '"' :: _ => false
  | _ :: rest => noTripleQuote rest
  | [] => true

end Haus
