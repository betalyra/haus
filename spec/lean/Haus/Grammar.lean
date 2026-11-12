import Haus.Lexical
import Haus.Value

/-!
# The grammar (spec/grammar.ebnf), as a relation

`File L t vs` says: the text `t` is a haus file whose values are `vs`, within
the limits `L`. This is the specification. The reference parser
(`Haus.Parser`) computes it, and the bindings must agree with it.

Each rule follows a production of `grammar.ebnf`. Three points the EBNF
leaves implicit are stated here:

* **Line comments run to the end of the line.** `[ // x 1 ]` is not `[1]`:
  inside a file a line comment ends with its line feed; only the last one
  may end the file instead.
* **Block comments nest and end at the first `*/`.** Their body can't
  contain `*/` or `/*` except as a nested comment, and can't end with `/`
  (that `/` and the closing `*/` would open a nested comment).
* **A number or tag is never directly followed by `[A-Za-z0-9_.]`.** No
  rule needs this: nothing that may follow a value starts with one of those
  characters, so `007` or `1.` simply don't parse.

Every value carries a *depth budget* `n`: a record, an array or a payload
uses one level, so `Val L n t v` holds only if `t` nests at most `n` levels.
-/

namespace Haus.Grammar
open Haus

/-! ## Whitespace and comments -/

/-- `newline ::= #x0A | #x0D #x0A`. A carriage return on its own is not a line break. -/
inductive Newline : Text → Prop
  | lf : Newline ['\n']
  | crlf : Newline ['\r', '\n']

/-- `text_char`: no control character but tab, and no bidi control. -/
def TextChar (c : Char) : Prop := (c = '\t' ∨ isRawControl c = false) ∧ isBidi c = false

/-- The text of a line comment after `//`. It ends before the line break. -/
def LineBody (body : Text) : Prop := ∀ c ∈ body, TextChar c

mutual
  /-- `block_comment ::= "/*" ( block_comment | comment_char )* "*/"` -/
  inductive BlockComment : Text → Prop
    | mk (body : Text) : CommentBody body → BlockComment (['/', '*'] ++ body ++ ['*', '/'])

  /-- The body of a block comment, as characters and nested comments. -/
  inductive CommentBody : Text → Prop
    | nil : CommentBody []
    | char (c : Char) (rest : Text) :
        -- text, or a line break (a carriage return only before a line feed)
        (TextChar c ∨ c = '\n' ∨ (c = '\r' ∧ rest.head? = some '\n')) →
        -- `*/` would close the comment
        (c = '*' → rest.head? ≠ some '/') →
        -- `/*` would open a nested one; so would a final `/` with the closing `*/`
        (c = '/' → rest.head? ≠ some '*' ∧ rest ≠ []) →
        CommentBody rest → CommentBody (c :: rest)
    | nested (inner rest : Text) :
        BlockComment inner → CommentBody rest → CommentBody (inner ++ rest)
end

/-- `ws ::= ( [ \t] | newline | comment )*`, where every line comment ends with its line feed. -/
inductive WS : Text → Prop
  | nil : WS []
  | blank (c : Char) (rest : Text) : isBlank c = true → WS rest → WS (c :: rest)
  | newline (nl rest : Text) : Newline nl → WS rest → WS (nl ++ rest)
  | lineComment (body nl rest : Text) : LineBody body → Newline nl → WS rest → WS (['/', '/'] ++ body ++ nl ++ rest)
  | blockComment (c rest : Text) : BlockComment c → WS rest → WS (c ++ rest)

/-- Whitespace at the end of a file: the last line comment may end the file. -/
inductive WSEnd : Text → Prop
  | ws (w : Text) : WS w → WSEnd w
  | lineComment (w body : Text) : WS w → LineBody body → WSEnd (w ++ ['/', '/'] ++ body)

/-! ## Identifiers -/

/-- `ident ::= [a-z_] [A-Za-z0-9_]*` (record keys only) -/
def Ident (t : Text) : Prop :=
  ∃ c cs, t = c :: cs ∧ isLowerStart c = true ∧ ∀ x ∈ cs, isIdentChar x = true

/-- `tag ::= [A-Z] [A-Za-z0-9_]*` (variant tags only) -/
def Tag (t : Text) : Prop :=
  ∃ c cs, t = c :: cs ∧ isUpper c = true ∧ ∀ x ∈ cs, isIdentChar x = true

/-! ## Numbers -/

/-- `( "_"? d )*`, where `d` is a digit of the radix. -/
inductive SepTail (p : Char → Bool) : Text → Prop
  | nil : SepTail p []
  | digit (c : Char) (rest : Text) : p c = true → SepTail p rest → SepTail p (c :: rest)
  | sep (c : Char) (rest : Text) : p c = true → SepTail p rest → SepTail p ('_' :: c :: rest)

/-- `d ( "_"? d )*` -/
def Digits (p : Char → Bool) (t : Text) : Prop := ∃ c rest, t = c :: rest ∧ p c = true ∧ SepTail p rest

/-- `int ::= "0" | [1-9] ( "_"? [0-9] )*` -/
inductive IntPart : Text → Prop
  | zero : IntPart ['0']
  | nonzero (c : Char) (rest : Text) : isDigit c = true → c ≠ '0' → SepTail isDigit rest → IntPart (c :: rest)

/-- `frac ::= "." digits` -/
def Frac (t : Text) : Prop := ∃ ds, t = '.' :: ds ∧ Digits isDigit ds

/-- `exp ::= [eE] [+-]? digits` -/
def Exp (t : Text) : Prop :=
  ∃ e s ds, t = e :: s ++ ds ∧ (e = 'e' ∨ e = 'E') ∧ (s = [] ∨ s = ['+'] ∨ s = ['-']) ∧ Digits isDigit ds

def Sign (s : Text) : Prop := s = [] ∨ s = ['-']

/-- `number ::= "-"? ( decimal | hex | binary )`, within the number limits (§3, §7). -/
inductive NumberLit (L : Limits) : Text → Prop
  | decimal (s i f e : Text) :
      Sign s → IntPart i → (f = [] ∨ Frac f) → (e = [] ∨ Exp e) →
      expMagnitude e ≤ L.maxExponent → (s ++ i ++ f ++ e).length ≤ L.maxNumberLength →
      NumberLit L (s ++ i ++ f ++ e)
  | hex (s ds : Text) :
      Sign s → Digits isHexDigit ds → (s ++ '0' :: 'x' :: ds).length ≤ L.maxNumberLength →
      NumberLit L (s ++ '0' :: 'x' :: ds)
  | binary (s ds : Text) :
      Sign s → Digits isBinDigit ds → (s ++ '0' :: 'b' :: ds).length ≤ L.maxNumberLength →
      NumberLit L (s ++ '0' :: 'b' :: ds)

/-! ## Strings -/

/-- `escape`, and the character it denotes. `\u{…}` must be a Unicode scalar value. -/
inductive Escape : Text → Char → Prop
  | quote : Escape ['\\', '"'] '"'
  | backslash : Escape ['\\', '\\'] '\\'
  | newline : Escape ['\\', 'n'] '\n'
  | cr : Escape ['\\', 'r'] '\r'
  | tab : Escape ['\\', 't'] '\t'
  | unicode (ds : Text) :
      1 ≤ ds.length → ds.length ≤ 6 → (∀ c ∈ ds, isHexDigit c = true) →
      isScalar (digitsValue 16 ds) = true →
      Escape (['\\', 'u', '{'] ++ ds ++ ['}']) (Char.ofNat (digitsValue 16 ds))

/-- `basic_char`: no quote, backslash, control character or bidi control. -/
def BasicChar (c : Char) : Prop := c ≠ '"' ∧ c ≠ '\\' ∧ isRawControl c = false ∧ isBidi c = false

/-- `block_char`: like `basic_char`, but quotes and tabs are allowed. -/
def BlockChar (c : Char) : Prop := c ≠ '\\' ∧ TextChar c

/-- Characters and escapes (`raw`), and the text they denote. -/
inductive Chars (ok : Char → Prop) : Text → Text → Prop
  | nil : Chars ok [] []
  | char (c : Char) (raw s : Text) : ok c → Chars ok raw s → Chars ok (c :: raw) (c :: s)
  | escape (e : Text) (c : Char) (raw s : Text) : Escape e c → Chars ok raw s → Chars ok (e ++ raw) (c :: s)

/-- `basic_string ::= '"' ( basic_char | escape )* '"'` -/
inductive BasicString (L : Limits) : Text → String → Prop
  | mk (raw s : Text) :
      Chars BasicChar raw s → s.length ≤ L.maxStringLength →
      BasicString L ('"' :: raw ++ ['"']) (String.ofList s)

/--
One content line of a block string, without its line break, and its text:
the indent removed and escapes processed, or a blank line that is shorter
than the indent, which becomes empty.
-/
inductive BlockLine (indent : Text) : Text → Text → Prop
  | indented (raw s : Text) : Chars BlockChar raw s → BlockLine indent (indent ++ raw) s
  | blank (raw : Text) : (∀ c ∈ raw, isBlank c = true) → ¬ indent <+: raw → BlockLine indent raw []

/-- The content lines of a block string, each ending with a line break. -/
inductive BlockLines (indent : Text) : Text → List Text → Prop
  | nil : BlockLines indent [] []
  | line (raw nl rest s : Text) (ss : List Text) :
      BlockLine indent raw s → Newline nl → BlockLines indent rest ss →
      BlockLines indent (raw ++ nl ++ rest) (s :: ss)

/-- The text of a block string: its lines joined with `\n`. -/
def blockText (ss : List Text) : String := String.ofList (List.intercalate ['\n'] ss)

/--
`block_string ::= '"""' [ \t]* newline block_line* [ \t]* '"""'`. The blanks
before the closing quotes are the indent. The text before the closing quotes
has no unescaped `"""`: they are the first.
-/
inductive BlockString (L : Limits) : Text → String → Prop
  | mk (sp nl content indent : Text) (ss : List Text) :
      (∀ c ∈ sp, isBlank c = true) → Newline nl → (∀ c ∈ indent, isBlank c = true) →
      BlockLines indent content ss → noTripleQuote (content ++ indent) = true →
      (blockText ss).length ≤ L.maxStringLength →
      BlockString L (['"', '"', '"'] ++ sp ++ nl ++ content ++ indent ++ ['"', '"', '"']) (blockText ss)

/-! ## Byte strings -/

/-- The text between the quotes of `x"…"`: hex pairs, with blanks between pairs. -/
inductive ByteChars : Text → List UInt8 → Prop
  | nil : ByteChars [] []
  | blank (c : Char) (raw : Text) (bs : List UInt8) : isBlank c = true → ByteChars raw bs → ByteChars (c :: raw) bs
  | byte (h l : Char) (raw : Text) (bs : List UInt8) :
      isHexDigit h = true → isHexDigit l = true → ByteChars raw bs →
      ByteChars (h :: l :: raw) (UInt8.ofNat (hexValue h * 16 + hexValue l) :: bs)

/-! ## Values -/

/-- `key ::= ident | basic_string` -/
inductive Key (L : Limits) : Text → String → Prop
  | ident (t : Text) : Ident t → Key L t (String.ofList t)
  | quoted (t : Text) (s : String) : BasicString L t s → Key L t s

mutual
  /-- `value ::= record | array | variant | string | bytes | number`, within `n` levels. -/
  inductive Val (L : Limits) : Nat → Text → Value → Prop
    | number (n : Nat) (t : Text) : NumberLit L t → Val L n t (.num (normalizeNumber t))
    | string (n : Nat) (t : Text) (s : String) : BasicString L t s → Val L n t (.str s)
    | blockString (n : Nat) (t : Text) (s : String) : BlockString L t s → Val L n t (.str s)
    | bytes (n : Nat) (raw : Text) (bs : List UInt8) :
        ByteChars raw bs → raw.length ≤ L.maxStringLength →
        Val L n (['x', '"'] ++ raw ++ ['"']) (.bytes bs)
    | array (n : Nat) (inner : Text) (xs : List Value) :
        Items L n inner xs → Val L (n + 1) ('[' :: inner ++ [']']) (.arr xs)
    | record (n : Nat) (t : Text) (fs : List (String × Value)) :
        Record L n t fs → Val L (n + 1) t (.record fs)
    /-- `Tag` -/
    | tag (n : Nat) (t : Text) : Tag t → Val L n t (.variant (String.ofList t) [])
    /-- `Tag(a, b)`: the payload starts on the tag's line. `Tag()` is not allowed. -/
    | payload (n : Nat) (t sp inner : Text) (xs : List Value) :
        Tag t → (∀ c ∈ sp, isBlank c = true) → Items L n inner xs → xs ≠ [] →
        Val L (n + 1) (t ++ sp ++ '(' :: inner ++ [')']) (.variant (String.ofList t) xs)
    /-- `Tag { … }`: the same value as `Tag({ … })`, but one level. -/
    | recordPayload (n : Nat) (t sp r : Text) (fs : List (String × Value)) :
        Tag t → (∀ c ∈ sp, isBlank c = true) → Record L n r fs →
        Val L (n + 1) (t ++ sp ++ r) (.variant (String.ofList t) [.record fs])

  /-- `ws ( value ws ( "," ws value ws )* ( "," ws )? )?`: the inside of `[…]` and `(…)`. -/
  inductive Items (L : Limits) : Nat → Text → List Value → Prop
    | empty (n : Nat) (w : Text) : WS w → Items L n w []
    | some (n : Nat) (w t : Text) (xs : List Value) : WS w → ItemsFrom L n t xs → Items L n (w ++ t) xs

  /-- `value ws ( "," ws value ws )* ( "," ws )?` -/
  inductive ItemsFrom (L : Limits) : Nat → Text → List Value → Prop
    | last (n : Nat) (v w : Text) (x : Value) : Val L n v x → WS w → ItemsFrom L n (v ++ w) [x]
    | lastComma (n : Nat) (v w w' : Text) (x : Value) :
        Val L n v x → WS w → WS w' → ItemsFrom L n (v ++ w ++ ',' :: w') [x]
    | cons (n : Nat) (v w w' t : Text) (x : Value) (xs : List Value) :
        Val L n v x → WS w → WS w' → ItemsFrom L n t xs → ItemsFrom L n (v ++ w ++ ',' :: w' ++ t) (x :: xs)

  /-- `record ::= "{" ws ( field ws ( "," ws field ws )* ( "," ws )? )? "}"`, without duplicate keys. -/
  inductive Record (L : Limits) : Nat → Text → List (String × Value) → Prop
    | mk (n : Nat) (inner : Text) (fs : List (String × Value)) :
        Fields L n inner fs → (fs.map Prod.fst).Nodup → Record L n ('{' :: inner ++ ['}']) fs

  inductive Fields (L : Limits) : Nat → Text → List (String × Value) → Prop
    | empty (n : Nat) (w : Text) : WS w → Fields L n w []
    | some (n : Nat) (w t : Text) (fs : List (String × Value)) : WS w → FieldsFrom L n t fs → Fields L n (w ++ t) fs

  inductive FieldsFrom (L : Limits) : Nat → Text → List (String × Value) → Prop
    | last (n : Nat) (f w : Text) (x : String × Value) : Field L n f x → WS w → FieldsFrom L n (f ++ w) [x]
    | lastComma (n : Nat) (f w w' : Text) (x : String × Value) :
        Field L n f x → WS w → WS w' → FieldsFrom L n (f ++ w ++ ',' :: w') [x]
    | cons (n : Nat) (f w w' t : Text) (x : String × Value) (xs : List (String × Value)) :
        Field L n f x → WS w → WS w' → FieldsFrom L n t xs → FieldsFrom L n (f ++ w ++ ',' :: w' ++ t) (x :: xs)

  /-- `field ::= key ws ":" ws value` -/
  inductive Field (L : Limits) : Nat → Text → String × Value → Prop
    | mk (n : Nat) (k w w' v : Text) (key : String) (x : Value) :
        Key L k key → WS w → WS w' → Val L n v x → Field L n (k ++ w ++ ':' :: w' ++ v) (key, x)
end

/-! ## Files -/

/-- The values of a file after leading whitespace: like `ItemsFrom`, ending with `WSEnd`. -/
inductive FileItems (L : Limits) : Text → List Value → Prop
  | last (v w : Text) (x : Value) : Val L L.maxDepth v x → WSEnd w → FileItems L (v ++ w) [x]
  | lastComma (v w w' : Text) (x : Value) :
      Val L L.maxDepth v x → WS w → WSEnd w' → FileItems L (v ++ w ++ ',' :: w') [x]
  | cons (v w w' t : Text) (x : Value) (xs : List Value) :
      Val L L.maxDepth v x → WS w → WS w' → FileItems L t xs → FileItems L (v ++ w ++ ',' :: w' ++ t) (x :: xs)

/-- An optional byte order mark. -/
def Bom (b : Text) : Prop := b = [] ∨ b = ['\uFEFF']

/--
`file ::= ws ( value ws ( "," ws value ws )* ( "," ws )? )?`: `File L t vs`
says the text `t` is a haus file with the values `vs`, within the limits `L`.
-/
inductive File (L : Limits) : Text → List Value → Prop
  | empty (b w : Text) : Bom b → WSEnd w → File L (b ++ w) []
  | values (b w t : Text) (xs : List Value) : Bom b → WS w → FileItems L t xs → File L (b ++ w ++ t) xs

end Haus.Grammar
