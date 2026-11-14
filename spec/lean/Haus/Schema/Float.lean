import Haus.Schema.Types
import Haus.RoundTrip.Numbers

/-!
# Floats (spec §15)

`Float64` and `Float32` decode a number by rounding its exact decimal value
to the nearest IEEE 754 binary64 or binary32 value, ties to even, and write a
float in one spelling: the fewest digits that round back to it.

Both are computed exactly, with natural numbers: a decimal `M · 10^E` is the
fraction `a / b`, and every comparison is a comparison of products. There
is no floating-point arithmetic here, so nothing is rounded twice.

`roundLit` reads a literal, `spell` writes a float. That spelling rounds
back to the same float (`FloatLaw`) is proven in `Haus.Schema.FloatLaw`
(`floatLaw`), and tested below and in the schema suite.
-/

namespace Haus.Schema
open Haus

/-- A binary floating-point format: finite values are `m · 2^q` with `m < 2^prec`. -/
structure Format where
  /-- Bits of the significand, the implicit leading one included. -/
  prec : Nat
  /-- The exponent of the smallest subnormal. -/
  emin : Int
  /-- The largest exponent of a finite value. -/
  emax : Int

/-- binary64: 53 bits, values up to `(2^53 - 1) · 2^971`, down to `2^-1074`. -/
def binary64 : Format := ⟨53, -1074, 971⟩
/-- binary32: 24 bits, values up to `(2^24 - 1) · 2^104`, down to `2^-149`. -/
def binary32 : Format := ⟨24, -149, 104⟩

def FloatType.format : FloatType → Format
  | .f32 => binary32
  | .f64 => binary64

/--
A float. Finite ones are `(-1)^neg · m · 2^q`, normalized: `2^(prec-1) ≤ m`,
or `q = emin` (zero and the subnormals).
-/
inductive Flt
  | nan
  | inf (neg : Bool)
  | fin (neg : Bool) (m : Nat) (q : Int)
  deriving Repr, DecidableEq

/-! ## Decimal literals -/

/--
A normalized number literal (§2) as sign, digits and exponent:
`-1.50e3` is `(true, 150, 1)`, the value `-150 · 10^1`. Hex and binary
literals are already decimal integers after normalizing.
-/
def decimal? (t : Text) : Option (Bool × Nat × Int) :=
  let (neg, t) := match t with
    | '-' :: r => (true, r)
    | r => (false, r)
  let int := t.takeWhile isDigit
  let t := t.dropWhile isDigit
  let (frac, t) := match t with
    | '.' :: r => (r.takeWhile isDigit, r.dropWhile isDigit)
    | r => ([], r)
  let exp? : Option Int := match t with
    | [] => some 0
    | 'e' :: '-' :: ds => if ds ≠ [] && ds.all isDigit then some (-(digitsValue 10 ds : Int)) else none
    | 'e' :: ds => if ds ≠ [] && ds.all isDigit then some (digitsValue 10 ds) else none
    | _ => none
  if int.isEmpty then none else
  exp?.map fun e => (neg, digitsValue 10 (int ++ frac), e - frac.length)

/-- `M · 10^E` as a fraction `a / b`. -/
def fraction (m : Nat) (e : Int) : Nat × Nat :=
  if 0 ≤ e then (m * 10 ^ e.toNat, 1) else (m, 10 ^ (-e).toNat)

/-! ## Rounding -/

/-- `a / b ≥ 2^e` -/
def geTwoPow (a b : Nat) (e : Int) : Bool :=
  if 0 ≤ e then a ≥ b * 2 ^ e.toNat else a * 2 ^ (-e).toNat ≥ b

/-- `a / b` rounded to an integer, ties to even. -/
def roundDiv (a b : Nat) : Nat :=
  let m := a / b
  let r := a % b
  if 2 * r > b || (2 * r == b && m % 2 == 1) then m + 1 else m

/--
The significand and exponent nearest to `a / b` (`b > 0`), ties to even;
`none` when it would round to an infinity. The binary exponent is
`L = ⌊log₂ (a / b)⌋`: the difference of the bit lengths is `L` or `L + 1`.
-/
def roundMag (F : Format) (a b : Nat) : Option (Nat × Int) :=
  if a = 0 then some (0, F.emin) else
  let t : Int := (a.log2 : Int) - b.log2
  let L := if geTwoPow a b t then t else t - 1
  let q := max (L - (F.prec - 1 : Nat)) F.emin
  let m := if 0 ≤ q then roundDiv a (b * 2 ^ q.toNat) else roundDiv (a * 2 ^ (-q).toNat) b
  -- Rounding up can carry into the next binade.
  let (m, q) := if m = 2 ^ F.prec then (2 ^ (F.prec - 1), q + 1) else (m, q)
  if q > F.emax then none else some (m, q)

/-- The float nearest to `±a / b`. -/
def roundRat (F : Format) (neg : Bool) (a b : Nat) : Option Flt :=
  (roundMag F a b).map fun (m, q) => .fin neg m q

/-- **Decoding a float** (§15): a literal rounded to the format; `none` when too large. -/
def roundLit (k : FloatType) (lit : String) : Option Flt :=
  (decimal? lit.toList).bind fun (neg, m, e) =>
    let (a, b) := fraction m e
    roundRat k.format neg a b

/-! ## Spelling -/

/-- A finite float as a fraction `a / b`. -/
def Flt.fraction : Flt → Nat × Nat
  | .fin _ m q => if 0 ≤ q then (m * 2 ^ q.toNat, 1) else (m, 2 ^ (-q).toNat)
  | _ => (0, 1)

/-- `a / b ≥ 10^e` -/
def geTenPow (a b : Nat) (e : Int) : Bool :=
  if 0 ≤ e then a ≥ b * 10 ^ e.toNat else a * 10 ^ (-e).toNat ≥ b

/-- The `n` with `10^(n-1) ≤ a / b < 10^n`, for `a, b > 0`: from the lengths of `a` and `b`. -/
def decimalExponent (a b : Nat) : Int :=
  let n : Int := (Nat.toDigits 10 a).length - (Nat.toDigits 10 b).length
  if geTenPow a b n then n + 1 else n

/-- Does the decimal `d · 10^e` round to `x`? -/
def roundsTo (F : Format) (x : Flt) (neg : Bool) (d : Nat) (e : Int) : Bool :=
  let (a, b) := fraction d e
  roundRat F neg a b == some x

/--
The `k`-digit spellings around `x = a / b` (with `10^(n-1) ≤ x < 10^n`): the
digits `d` of `d · 10^(n-k)` that round back to `x`, the closer one if both
do, the even one if they are equally close.
-/
def digitsAt (F : Format) (x : Flt) (neg : Bool) (a b : Nat) (n : Int) (k : Nat) : Option Nat :=
  let (num, den) := if 0 ≤ n - k then (a, b * 10 ^ (n - k).toNat) else (a * 10 ^ (k - n).toNat, b)
  let lo := num / den
  let r := num % den
  let okLo := roundsTo F x neg lo (n - k)
  let okHi := r ≠ 0 && roundsTo F x neg (lo + 1) (n - k)
  if okLo && okHi then
    if 2 * r < den || (2 * r == den && lo % 2 == 0) then some lo else some (lo + 1)
  else if okLo then some lo
  else if okHi then some (lo + 1)
  else none

/--
The fewest digits, trying `k`, `k + 1`, …: the digits `d` of `d · 10^(n-k)`, and `k`.
`d` can be `10^k` (`9.7` rounds up to `10`), one digit more than `k`.
-/
def shortest (F : Format) (x : Flt) (neg : Bool) (a b : Nat) (n : Int) : Nat → Nat → Option (Nat × Nat)
  | 0, _ => none
  | fuel + 1, k => ((digitsAt F x neg a b n k).map (·, k)).or (shortest F x neg a b n fuel (k + 1))

/-- Digits without trailing zeros (`10` is `1`: the value `0.1 · 10^n` is `0.10 · 10^n`). -/
def stripTrailing (ds : Text) : Text := (ds.reverse.dropWhile (· == '0')).reverse

/-- `0.d₁…dₖ · 10^n` laid out as JavaScript's `Number.prototype.toString` does, without `+`. -/
def layout (ds : Text) (n : Int) : Text :=
  let k : Int := ds.length
  if k ≤ n && n ≤ 21 then ds ++ List.replicate (n - k).toNat '0'
  else if 0 < n && n ≤ 21 then ds.take n.toNat ++ '.' :: ds.drop n.toNat
  else if -6 < n && n ≤ 0 then '0' :: '.' :: List.replicate (-n).toNat '0' ++ ds
  else
    let e := n - 1
    ds.take 1 ++ (if ds.length > 1 then '.' :: ds.drop 1 else []) ++
      'e' :: RoundTrip.intText (e < 0) e.natAbs

/--
**Writing a finite float** (§15): the fewest decimal digits that round back to
it, laid out like JavaScript. Every binary64 or binary32 value has an exact
decimal expansion of at most 1100 digits, so the search ends.
-/
def spell (k : FloatType) (x : Flt) : String :=
  match x with
  | .fin neg m _ =>
    let sign := if neg then "-" else ""
    if m = 0 then sign ++ "0" else
    let (a, b) := x.fraction
    let n := decimalExponent a b
    match shortest k.format x neg a b n 1100 1 with
    | some (d, k) =>
      let ds := Nat.toDigits 10 d
      sign ++ String.ofList (layout (stripTrailing ds) (n - k + ds.length))
    | none => sign ++ "0"
  | _ => "0"

/--
The law the round trip needs: the spelling of a decoded float rounds back
to it. Proven as `floatLaw` (`Haus.Schema.FloatLaw`).
-/
def FloatLaw : Prop := ∀ (k : FloatType) (lit : String) (x : Flt),
  roundLit k lit = some x → roundLit k (spell k x) = some x

/-- A decoded float is finite. -/
theorem roundRat_fin {F : Format} {neg : Bool} {a b : Nat} {x : Flt} (h : roundRat F neg a b = some x) :
    ∃ n m q, x = .fin n m q := by
  obtain ⟨⟨m, q⟩, -, rfl⟩ := Option.map_eq_some_iff.mp h
  exact ⟨_, _, _, rfl⟩

theorem roundLit_fin {k : FloatType} {lit : String} {x : Flt} (h : roundLit k lit = some x) :
    ∃ n m q, x = .fin n m q := by
  unfold roundLit at h
  obtain ⟨⟨neg, m, e⟩, -, h⟩ := Option.bind_eq_some_iff.mp h
  exact roundRat_fin h

/-! ## Tests -/

/-- Decode with `k` and write again. -/
private def respell (k : FloatType) (lit : String) : Option String := (roundLit k lit).map (spell k)

/-- Respelled, and the spelling rounds back. -/
private def roundTrips (k : FloatType) (lit : String) : Bool :=
  match roundLit k lit with
  | some x => roundLit k (spell k x) == some x
  | none => true

-- The cases of test-suite/schema/numbers.cases.haus.
#guard respell .f64 "0.10" == some "0.1"
#guard respell .f64 "1e2" == some "100"
#guard respell .f64 "123000" == some "123000"
#guard respell .f64 "12.25" == some "12.25"
#guard respell .f64 "0.000001" == some "0.000001"
#guard respell .f64 "1e-7" == some "1e-7"
#guard respell .f64 "0.00000015" == some "1.5e-7"
#guard respell .f64 "1e20" == some "100000000000000000000"
#guard respell .f64 "1e21" == some "1e21"
#guard respell .f64 "1.5e300" == some "1.5e300"
#guard respell .f64 "0.30000000000000004" == some "0.30000000000000004"
#guard respell .f64 "0.1000000000000000055" == some "0.1"
#guard respell .f64 "5e-324" == some "5e-324"
#guard respell .f64 "3e-324" == some "5e-324"
#guard respell .f64 "2e-324" == some "0"
#guard respell .f64 "-1e-400" == some "-0"
#guard respell .f64 "-0.0" == some "-0"
#guard respell .f64 "1.7976931348623157e308" == some "1.7976931348623157e308"
#guard respell .f64 "1.7976931348623158e308" == some "1.7976931348623157e308"
#guard respell .f64 "1.7976931348623159e308" == none
#guard respell .f64 "1e400" == none
#guard respell .f64 "1690060720831323.25" == some "1690060720831323.2"
#guard respell .f32 "0.1" == some "0.1"
#guard respell .f32 "16777217" == some "16777216"
#guard respell .f32 "1.000000059604644775390625" == some "1"
#guard respell .f32 "1.00000005960464477539062500000001" == some "1.0000001"
#guard respell .f32 "3.40282356e38" == some "3.4028235e38"
#guard respell .f32 "3.4028236e38" == none
#guard respell .f32 "1e-46" == some "0"
#guard respell .f32 "1e21" == some "1e21"
#guard respell .f32 "2097152.25" == some "2097152.2"
#guard respell .f32 "2097152.75" == some "2097152.8"
-- More: JavaScript's own spellings, and the smallest and largest values.
#guard respell .f64 "123456789012345680000" == some "123456789012345680000"
#guard respell .f64 "1.2345678901234568e21" == some "1.2345678901234568e21"
#guard respell .f64 "2.2250738585072014e-308" == some "2.2250738585072014e-308"
#guard respell .f64 "2.225073858507201e-308" == some "2.225073858507201e-308"
#guard respell .f64 "9007199254740993" == some "9007199254740992"
#guard respell .f64 "-123.456e-10" == some "-1.23456e-8"
#guard respell .f32 "1.4e-45" == some "1e-45"
#guard respell .f32 "1.17549435e-38" == some "1.1754944e-38"
#guard respell .f32 "3.14159265358979" == some "3.1415927"
-- The law, on literals near the edges of both formats.
#guard ["0", "-0", "1", "0.1", "0.2", "0.3", "1e-7", "5e-324", "4.9e-324", "2.4703282292062328e-324",
  "2.2250738585072011e-308", "2.2250738585072012e-308", "1.7976931348623157e308", "9007199254740993",
  "123.456", "1e22", "1e23", "8.98846567431158e307", "3.4028235e38", "1.17549435e-38", "1e-45", "7e-46",
  "16777217", "0.333333333333333333333333", "6.02214076e23"].all fun lit =>
    roundTrips .f64 lit && roundTrips .f32 lit

end Haus.Schema
