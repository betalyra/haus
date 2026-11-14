import Haus.Schema.Float
import Haus.Time.Check

/-!
# The reference decoder and encoder (spec §15)

`decode env t v` decodes the value `v` with the type `t`: a `Typed` value or
the first error, with its place (`$.items[2].price`). `encode` writes a
decoded value back. Both follow §15 rule by rule.

Decoding recurses on the value, so it always terminates: references and
secrets are unfolded first (`whnf`), and every other step goes into a part
of the value. A reference that comes up again before any input is consumed
is an error (§9.9), so even a schema that §14 rejects (`type A = B`,
`type B = A`) can't make it loop.
-/

namespace Haus.Schema
open Haus

/--
A decoded value. What a binding's host type would hold: integers as
integers, floats as floats, records with the fields the type lists.
-/
inductive Typed where
  | int (n : Int)
  | float (k : FloatType) (x : Flt)
  /-- A `Decimal`: its normalized literal, scale and exponent included. -/
  | decimal (literal : String)
  | str (s : String)
  | bytes (bs : List UInt8)
  | time (k : Time.TimeType) (s : String)
  /-- An `Any`: the value as parsed. -/
  | any (v : Value)
  /-- A `Secret`: a host type that hides what it holds. -/
  | secret (x : Typed)
  | arr (xs : List Typed)
  | map (fs : List (String × Typed))
  /-- The fields the type lists, in the order of the input. -/
  | record (fs : List (String × Typed))
  /-- A listed case of a variant, with its decoded arguments. -/
  | case (tag : String) (args : List Typed)
  /-- An unknown value: a tag an open variant doesn't list, with its arguments as parsed. -/
  | unknown (tag : String) (args : List Value)
  deriving Repr, Inhabited

/-- `x` inside `s` secrets. -/
def Typed.hide : Nat → Typed → Typed
  | 0, x => x
  | s + 1, x => .secret (hide s x)

/-! ## Encoding -/

/-- An integer's literal: `-` and its digits, so `-0` is written `0`. -/
def intLit (n : Int) : String := String.ofList (RoundTrip.intText (n < 0) n.natAbs)

def encodeFloat (k : FloatType) : Flt → Value
  | .nan => .variant "NaN" []
  | .inf false => .variant "Infinity" []
  | .inf true => .variant "NegInfinity" []
  | x => .num (spell k x)

mutual
/-- **Encoding** (§15): the value a decoded value is written as. It needs no type. -/
def encode : Typed → Value
  | .int n => .num (intLit n)
  | .float k x => encodeFloat k x
  | .decimal l => .num l
  | .str s => .str s
  | .bytes bs => .bytes bs
  | .time k s => .variant k.name [.str s]
  | .any v => v
  | .secret x => encode x
  | .arr xs => .arr (encodeList xs)
  | .map fs => .record (encodeFields fs)
  | .record fs => .record (encodeFields fs)
  | .case tag xs => .variant tag (encodeList xs)
  | .unknown tag vs => .variant tag vs

def encodeList : List Typed → List Value
  | [] => []
  | x :: xs => encode x :: encodeList xs

def encodeFields : List (String × Typed) → List (String × Value)
  | [] => []
  | (k, x) :: fs => (k, encode x) :: encodeFields fs
end

/-! ## Errors -/

/-- A step into a value: a record's field, an array's element, a variant's argument. -/
inductive Seg
  | key (k : String)
  | index (i : Nat)
  | arg (tag : String) (i : Nat)
  deriving Repr, DecidableEq

/-- An error: the place of the failing value, from the outside in, and why. -/
structure Error where
  path : List Seg
  reason : String
  deriving Repr

/-- The place as `$.items[2].price`; a variant's argument as `.Tag(0)`. -/
def Error.place (e : Error) : String :=
  e.path.foldl (fun s seg => s ++ match seg with
    | .key k => if Canonical.isIdent k then "." ++ k else "[" ++ String.ofList (Canonical.string k) ++ "]"
    | .index i => s!"[{i}]"
    | .arg tag i => s!".{tag}({i})") "$"

/-- An error from inside a part of the value. -/
def under {α : Type} (s : Seg) : Except Error α → Except Error α
  | .error e => .error { e with path := s :: e.path }
  | .ok x => .ok x

def fail {α : Type} (reason : String) : Except Error α := .error ⟨[], reason⟩

/-! ## Unfolding references -/

/-- `Secret`s around a type: how many, and the type inside. -/
def peel : Ty → Nat × Ty
  | .secret t => let p := peel t; (p.1 + 1, p.2)
  | t => (0, t)

/--
Follows references and secrets to a type that consumes input: the number of
secrets on the way, and that type. A `Secret` guards nothing (§9.9). Out of
fuel means some reference came up twice, since `Env.fuel` is one more than
the number of names.
-/
def whnf (env : Env) : Nat → Ty → Except String (Nat × Ty)
  | fuel, t =>
    match peel t with
    | (s, .ref n) =>
      match fuel with
      | 0 => .error s!"type {n} refers to itself without a record, array or variant in between"
      | fuel + 1 =>
        match env.lookup n with
        | some t => (whnf env fuel t).map fun (s', c) => (s + s', c)
        | none => .error s!"unknown type {n}"
    | r => .ok r

/-- The field of a record type with this key. -/
def fieldOf? (fields : List Field) (k : String) : Option Field := fields.find? (·.key == k)

/-- The case of a variant type with this tag: found by lookup, never by trying cases (§9.8). -/
def caseOf? (cases : List Case) (tag : String) : Option Case := cases.find? (·.tag == tag)

/-- A field without `?` that the record doesn't have. -/
def missing? (fields : List Field) (fs : List (String × Value)) : Option String :=
  (fields.find? fun f => !f.optional && !fs.any (·.1 == f.key)).map (·.key)

/-- The error for a value a `Secret` doesn't accept: its type, nothing of the value. -/
def secretError (c : Ty) : Error := ⟨[], s!"not a valid {c.name} (in a Secret, so the value is not shown)"⟩

/--
The result inside `s` secrets. An error inside one names its place and the
type, never the value or any part of it (§15, "Secrets").
-/
def hidden (s : Nat) (c : Ty) (r : Except Error Typed) : Except Error Typed :=
  match s, r with
  | 0, r => r
  | _, .ok x => .ok (Typed.hide s x)
  | _, .error _ => .error (secretError c)

/-- The float a tag stands for: `NaN`, `Infinity`, `NegInfinity`. -/
def floatTag? : String → Option Flt
  | "NaN" => some .nan
  | "Infinity" => some (.inf false)
  | "NegInfinity" => some (.inf true)
  | _ => none

/--
A whole number by spelling (§15): digits with an optional `-`, no fraction,
no exponent. `-0` is 0. Normalized literals have no leading zeros.
-/
def wholeDigits (ds : Text) : Bool := ds != [] && ds.all isDigit && (ds.head? != some '0' || ds == ['0'])

def wholeLit : Text → Option Int
  | '-' :: ds => if wholeDigits ds then some (-(digitsValue 10 ds : Int)) else none
  | ds => if wholeDigits ds then some (digitsValue 10 ds : Int) else none

/-! ## Decoding -/

mutual
/-- **Decoding** (§15): the value `v` with the type `t`. -/
def decode (env : Env) (t : Ty) (v : Value) : Except Error Typed :=
  match whnf env env.fuel t with
  | .error r => fail r
  | .ok (s, c) => hidden s c <|
    match c, v with
    | .string, .str x => .ok (.str x)
    | .bytes, .bytes bs => .ok (.bytes bs)
    | .int k, .num a =>
      match wholeLit a.toList with
      | some n => if k.inRange n then .ok (.int n) else fail s!"out of range for {k.name}"
      | none => fail s!"expected {k.name}: a whole number, without a fraction or an exponent"
    | .float k, .num a =>
      match roundLit k a with
      | some x => .ok (.float k x)
      | none => fail s!"too large for {k.name}"
    | .float k, .variant tag [] =>
      match floatTag? tag with
      | some x => .ok (.float k x)
      | none => fail s!"expected {k.name}"
    | .decimal, .num a => .ok (.decimal a)
    | .any, v => .ok (.any v)
    | .time k, .variant tag [.str x] =>
      if tag == k.name && Time.check k x.toList then .ok (.time k x)
      else fail s!"expected {k.name}"
    | .array t, .arr xs => (decodeItems env t 0 xs).map .arr
    | .map t, .record fs => (decodeEntries env t fs).map .map
    | .record closed fields, .record fs =>
      match missing? fields fs with
      | some k => fail s!"missing field {k}"
      | none => (decodeFields env closed fields fs).map .record
    | .variant closed cases, .variant tag args =>
      match caseOf? cases tag, args with
      | some (.bare _), [] => .ok (.case tag [])
      | some (.record _ cl fields), [a] =>
        under (.arg tag 0) ((decode env (.record cl fields) a).map fun x => .case tag [x])
      | some (.positional _ ts), args =>
        if args.length = ts.length then (decodeArgs env tag 0 ts args).map (.case tag)
        else fail s!"{tag} takes {ts.length} arguments"
      | some (.bare _), _ => fail s!"{tag} takes no arguments"
      | some (.record _ _ _), _ => fail s!"{tag} takes one argument, a record"
      | none, args => if closed then fail s!"unknown tag {tag}" else .ok (.unknown tag args)
    | c, _ => fail s!"expected {c.name}"

def decodeItems (env : Env) (t : Ty) (i : Nat) : List Value → Except Error (List Typed)
  | [] => .ok []
  | x :: xs => do
    let y ← under (.index i) (decode env t x)
    let ys ← decodeItems env t (i + 1) xs
    return y :: ys

def decodeEntries (env : Env) (t : Ty) : List (String × Value) → Except Error (List (String × Typed))
  | [] => .ok []
  | (k, x) :: fs => do
    let y ← under (.key k) (decode env t x)
    let ys ← decodeEntries env t fs
    return (k, y) :: ys

/-- A record's fields: each one the type lists, decoded; the others ignored, or an error if closed. -/
def decodeFields (env : Env) (closed : Bool) (fields : List Field) :
    List (String × Value) → Except Error (List (String × Typed))
  | [] => .ok []
  | (k, x) :: fs =>
    match fieldOf? fields k with
    | some f => do
      let y ← under (.key k) (decode env f.ty x)
      let ys ← decodeFields env closed fields fs
      return (k, y) :: ys
    | none =>
      if closed then .error ⟨[.key k], "not a field of this closed record"⟩
      else decodeFields env closed fields fs

def decodeArgs (env : Env) (tag : String) (i : Nat) : List Ty → List Value → Except Error (List Typed)
  | t :: ts, x :: xs => do
    let y ← under (.arg tag i) (decode env t x)
    let ys ← decodeArgs env tag (i + 1) ts xs
    return y :: ys
  | _, _ => .ok []
end

/-- The schema's attributes are not read: decoding is the same without them (§15). -/
theorem Schema.decode_erase (s : Schema) : decode s.erase.env = decode s.env := rfl

end Haus.Schema
