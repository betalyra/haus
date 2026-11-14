import Haus.Schema.Decode

/-!
# What each type accepts (spec §15), as rules

`Dec env t v x` says: the type `t` accepts the value `v`, which decodes to
`x`. One rule per row of §15's tables; `decode` computes exactly these
rules (`Haus.Schema.decode_iff`).

`Agree env t v w` says: `w` is the value `v`, except where §15 lets decoding
drop or normalize something: fields an open record ignores, the spelling of
a float, and `-0` decoded as an integer. Encoding a decoded value gives such
a `w` (`Haus.Schema.encode_agree`).
-/

namespace Haus.Schema
open Haus

mutual
/-- `t` accepts `v`, decoded as `x`: through references and secrets to a type that consumes input. -/
inductive Dec (env : Env) : Ty → Value → Typed → Prop
  | intro {t s c v x} : whnf env env.fuel t = .ok (s, c) → Core env c v x → Dec env t v (x.hide s)

/-- The rules of the types that consume input. -/
inductive Core (env : Env) : Ty → Value → Typed → Prop
  | string (s : String) : Core env .string (.str s) (.str s)
  | bytes (bs : List UInt8) : Core env .bytes (.bytes bs) (.bytes bs)
  /-- A whole number, by spelling, within the type's range. -/
  | int {k a n} : wholeLit a.toList = some n → k.inRange n = true → Core env (.int k) (.num a) (.int n)
  /-- Any number, rounded to the format; not one that rounds to an infinity. -/
  | float {k a x} : roundLit k a = some x → Core env (.float k) (.num a) (.float k x)
  /-- `NaN`, `Infinity`, `NegInfinity` without a payload. -/
  | floatTag {k tag x} : floatTag? tag = some x → Core env (.float k) (.variant tag []) (.float k x)
  | decimal (a : String) : Core env .decimal (.num a) (.decimal a)
  | any (v : Value) : Core env .any v (.any v)
  /-- The type's own tag around a string the std/time profile accepts. -/
  | time {k s} : Time.check k s.toList = true → Core env (.time k) (.variant k.name [.str s]) (.time k s)
  | array {t xs ys} : Items env t xs ys → Core env (.array t) (.arr xs) (.arr ys)
  | map {t fs ys} : Entries env t fs ys → Core env (.map t) (.record fs) (.map ys)
  /-- Every field without `?` present; the fields decoded as `Fields` says. -/
  | record {closed fields fs ys} : missing? fields fs = none → Fields env closed fields fs ys →
      Core env (.record closed fields) (.record fs) (.record ys)
  | bare {closed cases tag tag'} : caseOf? cases tag = some (.bare tag') →
      Core env (.variant closed cases) (.variant tag []) (.case tag [])
  /-- `Tag { … }`: one argument, which the record type accepts. -/
  | recordCase {closed cases tag tag' cl fields a y} : caseOf? cases tag = some (.record tag' cl fields) →
      Dec env (.record cl fields) a y → Core env (.variant closed cases) (.variant tag [a]) (.case tag [y])
  /-- `Tag T1 … Tn`: exactly n arguments. -/
  | positional {closed cases tag tag' ts xs ys} : caseOf? cases tag = some (.positional tag' ts) →
      Args env ts xs ys → Core env (.variant closed cases) (.variant tag xs) (.case tag ys)
  /-- A tag an open variant doesn't list: an unknown value, kept as parsed. -/
  | unknown {cases tag args} : caseOf? cases tag = none →
      Core env (.variant false cases) (.variant tag args) (.unknown tag args)

inductive Items (env : Env) : Ty → List Value → List Typed → Prop
  | nil {t} : Items env t [] []
  | cons {t x xs y ys} : Dec env t x y → Items env t xs ys → Items env t (x :: xs) (y :: ys)

inductive Entries (env : Env) : Ty → List (String × Value) → List (String × Typed) → Prop
  | nil {t} : Entries env t [] []
  | cons {t k x fs y ys} : Dec env t x y → Entries env t fs ys → Entries env t ((k, x) :: fs) ((k, y) :: ys)

/-- A record's fields: the listed ones decoded, the others ignored, which only an open record does. -/
inductive Fields (env : Env) : Bool → List Field → List (String × Value) → List (String × Typed) → Prop
  | nil {closed fields} : Fields env closed fields [] []
  | keep {closed fields k x fs f y ys} : fieldOf? fields k = some f → Dec env f.ty x y →
      Fields env closed fields fs ys → Fields env closed fields ((k, x) :: fs) ((k, y) :: ys)
  | skip {fields k x fs ys} : fieldOf? fields k = none →
      Fields env false fields fs ys → Fields env false fields ((k, x) :: fs) ys

inductive Args (env : Env) : List Ty → List Value → List Typed → Prop
  | nil : Args env [] [] []
  | cons {t ts x xs y ys} : Dec env t x y → Args env ts xs ys → Args env (t :: ts) (x :: xs) (y :: ys)
end

mutual
/-- `w` is `v`, except at the places §15 lists under "Encoding". -/
inductive Agree (env : Env) : Ty → Value → Value → Prop
  | intro {t s c v w} : whnf env env.fuel t = .ok (s, c) → AgreeCore env c v w → Agree env t v w

inductive AgreeCore (env : Env) : Ty → Value → Value → Prop
  /-- The same value. -/
  | same (c : Ty) (v : Value) : AgreeCore env c v v
  /-- `-0` decoded as an integer, which is written `0`. -/
  | negZero (k : IntType) : AgreeCore env (.int k) (.num "-0") (.num "0")
  /-- The spelling of a float: another literal that rounds to the same float. -/
  | float {k a b x} : roundLit k a = some x → roundLit k b = some x →
      AgreeCore env (.float k) (.num a) (.num b)
  | array {t xs ys} : AgreeItems env t xs ys → AgreeCore env (.array t) (.arr xs) (.arr ys)
  | map {t fs gs} : AgreeEntries env t fs gs → AgreeCore env (.map t) (.record fs) (.record gs)
  | record {closed fields fs gs} : AgreeFields env closed fields fs gs →
      AgreeCore env (.record closed fields) (.record fs) (.record gs)
  | recordCase {closed cases tag tag' cl fields a b} : caseOf? cases tag = some (.record tag' cl fields) →
      Agree env (.record cl fields) a b → AgreeCore env (.variant closed cases) (.variant tag [a]) (.variant tag [b])
  | positional {closed cases tag tag' ts xs ys} : caseOf? cases tag = some (.positional tag' ts) →
      AgreeArgs env ts xs ys → AgreeCore env (.variant closed cases) (.variant tag xs) (.variant tag ys)

inductive AgreeItems (env : Env) : Ty → List Value → List Value → Prop
  | nil {t} : AgreeItems env t [] []
  | cons {t x xs y ys} : Agree env t x y → AgreeItems env t xs ys → AgreeItems env t (x :: xs) (y :: ys)

inductive AgreeEntries (env : Env) : Ty → List (String × Value) → List (String × Value) → Prop
  | nil {t} : AgreeEntries env t [] []
  | cons {t k x fs y gs} : Agree env t x y → AgreeEntries env t fs gs →
      AgreeEntries env t ((k, x) :: fs) ((k, y) :: gs)

/-- Fields in the same order; a field an open record doesn't list is dropped. -/
inductive AgreeFields (env : Env) : Bool → List Field → List (String × Value) → List (String × Value) → Prop
  | nil {closed fields} : AgreeFields env closed fields [] []
  | keep {closed fields k x fs f y gs} : fieldOf? fields k = some f → Agree env f.ty x y →
      AgreeFields env closed fields fs gs → AgreeFields env closed fields ((k, x) :: fs) ((k, y) :: gs)
  | drop {fields k x fs gs} : fieldOf? fields k = none →
      AgreeFields env false fields fs gs → AgreeFields env false fields ((k, x) :: fs) gs

inductive AgreeArgs (env : Env) : List Ty → List Value → List Value → Prop
  | nil : AgreeArgs env [] [] []
  | cons {t ts x xs y ys} : Agree env t x y → AgreeArgs env ts xs ys →
      AgreeArgs env (t :: ts) (x :: xs) (y :: ys)
end

end Haus.Schema
