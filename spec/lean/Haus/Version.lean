import Haus.Canonical
import Haus.Schema.Decode

/-!
# Versions (spec §10)

From 1.0 on, haus only grows: a later version may make invalid text valid,
but never makes valid text invalid, never changes what valid text means,
what an existing schema accepts or decodes to, or the canonical form of a
value. `Extends old new` states that for two versions, each given by what
it fixes: its files, its canonical form, its built-in types and its schema
files.

Defined here, with reflexivity and transitivity; each release proves
`Extends previous release` when it is made.
-/

namespace Haus
open Schema

/--
What a version of haus fixes. A decoder is written as the value its encoder
writes for what it decoded (`none`: not accepted), so that versions with
different host types can be compared.
-/
structure Version where
  /-- Its files (§1–§8): the values of a text, or `none` when the text isn't a file. -/
  parse : Text → Option (List Value)
  /-- Its canonical form (§12). -/
  canonical : Value → Text
  /-- Its built-in types (§13.1, §13.2), by name. -/
  builtin : String → Option (Value → Option Value)
  /-- Its schema files (§14, §15): a schema's types, by name; `none` when the schema is rejected. -/
  schema : Text → Option (String → Option (Value → Option Value))

/-- The values a version can write: those its files hold. -/
def Version.Expresses (V : Version) (v : Value) : Prop := ∃ t vs, V.parse t = some vs ∧ v ∈ vs

/-- Two decoders agree on what `V` can express. -/
def Version.SameOn (V : Version) (d d' : Value → Option Value) : Prop := ∀ v, V.Expresses v → d' v = d v

/-- Two schemas have the same types, decoding alike on what `V` can express. -/
def Version.SameTypes (V : Version) (types types' : String → Option (Value → Option Value)) : Prop :=
  ∀ name d, types name = some d → ∃ d', types' name = some d' ∧ V.SameOn d d'

/--
**`new` extends `old`** (§10): every text `old` accepts, `new` accepts with
the same values; on what `old` can express, the canonical form is the same,
and every built-in type and every type of a schema `old` accepts accepts
the same values and decodes them alike.
-/
structure Extends (old new : Version) : Prop where
  parse : ∀ t vs, old.parse t = some vs → new.parse t = some vs
  canonical : ∀ v, old.Expresses v → new.canonical v = old.canonical v
  builtin : ∀ name d, old.builtin name = some d → ∃ d', new.builtin name = some d' ∧ old.SameOn d d'
  schema : ∀ s types, old.schema s = some types → ∃ types', new.schema s = some types' ∧ old.SameTypes types types'

namespace Extends

/-- What the old version can express, the new one can. -/
theorem expresses {old new : Version} (h : Extends old new) {v : Value} (hv : old.Expresses v) :
    new.Expresses v := by
  obtain ⟨t, vs, hp, hm⟩ := hv
  exact ⟨t, vs, h.parse t vs hp, hm⟩

theorem refl (V : Version) : Extends V V where
  parse _ _ h := h
  canonical _ _ := rfl
  builtin _ d h := ⟨d, h, fun _ _ => rfl⟩
  schema _ types h := ⟨types, h, fun _ d hd => ⟨d, hd, fun _ _ => rfl⟩⟩

theorem trans {a b c : Version} (hab : Extends a b) (hbc : Extends b c) : Extends a c where
  parse t vs h := hbc.parse t vs (hab.parse t vs h)
  canonical v hv := (hbc.canonical v (hab.expresses hv)).trans (hab.canonical v hv)
  builtin name d h := by
    obtain ⟨d', h', s1⟩ := hab.builtin name d h
    obtain ⟨d'', h'', s2⟩ := hbc.builtin name d' h'
    exact ⟨d'', h'', fun v hv => (s2 v (hab.expresses hv)).trans (s1 v hv)⟩
  schema s types h := by
    obtain ⟨types', h', s1⟩ := hab.schema s types h
    obtain ⟨types'', h'', s2⟩ := hbc.schema s types' h'
    refine ⟨types'', h'', fun name d hd => ?_⟩
    obtain ⟨d', hd', e1⟩ := s1 name d hd
    obtain ⟨d'', hd'', e2⟩ := s2 name d' hd'
    exact ⟨d'', hd'', fun v hv => (e2 v (hab.expresses hv)).trans (e1 v hv)⟩

end Extends

/-! ## This version -/

/-- The built-in types without parameters (§13): the prelude's and std/time's. -/
def builtinTy : String → Option Ty
  | "String" => some .string | "Bytes" => some .bytes | "Bool" => some .bool
  | "Int" => some (.int .int) | "Decimal" => some .decimal | "Any" => some .any
  | "Float32" => some (.float .f32) | "Float64" => some (.float .f64)
  | "Int8" => some (.int (.signed 8)) | "Int16" => some (.int (.signed 16))
  | "Int32" => some (.int (.signed 32)) | "Int64" => some (.int (.signed 64))
  | "UInt8" => some (.int (.unsigned 8)) | "UInt16" => some (.int (.unsigned 16))
  | "UInt32" => some (.int (.unsigned 32)) | "UInt64" => some (.int (.unsigned 64))
  | name => (Time.TimeType.all.find? (·.name == name)).map .time

/-- Decoding with a type, written as the value the encoder writes. -/
def decoder (env : Env) (t : Ty) (v : Value) : Option Value := (decode env t v).toOption.map encode

/--
The version this model describes. Schema files are parsed outside Lean
(the TypeScript binding's resolver, `scripts/schema-types.ts`), so the
resolver is a parameter: a schema text's types, or `none` when it is
rejected.
-/
def current (resolve : Text → Option Env) : Version where
  parse t := (Parser.parse {} t).toOption
  canonical := Canonical.canonical
  builtin name := (builtinTy name).map (decoder ⟨[]⟩)
  schema s := (resolve s).map fun env name => (env.lookup name).map fun _ => decoder env (.ref name)

/-- The current version extends itself; each release proves it extends the one before. -/
theorem current_extends_self (resolve : Text → Option Env) : Extends (current resolve) (current resolve) :=
  .refl _

end Haus
