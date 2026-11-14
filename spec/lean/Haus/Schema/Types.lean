import Haus.Value
import Haus.Time.Spec

/-!
# Schema types (spec §13–§15)

A model of *resolved* types: what a schema file means once it is parsed,
its imports found, its spreads copied and its generic types applied to
their arguments. Named types stay names (`Ty.ref`), looked up in an
environment, which is how recursive types are written.

Attributes (§14) are not part of a type. A schema is its environment plus a
separate table of attributes for tools (`Schema`), and decoding only sees
the environment, so "attributes don't matter" (§15) holds by construction:
`Schema.decode_erase` is `rfl`.
-/

namespace Haus.Schema
open Haus

/-- The integer types: `Int` (any size), `Int8`…`Int64` and `UInt8`…`UInt64`. -/
inductive IntType
  | int
  | signed (bits : Nat)
  | unsigned (bits : Nat)
  deriving Repr, DecidableEq

/-- The values an integer type holds (§15): `Int` all, the others their range. -/
def IntType.inRange : IntType → Int → Bool
  | .int, _ => true
  | .signed b, n => -(2 ^ (b - 1) : Int) ≤ n && n < (2 ^ (b - 1) : Int)
  | .unsigned b, n => 0 ≤ n && n < (2 ^ b : Int)

def IntType.name : IntType → String
  | .int => "Int"
  | .signed b => s!"Int{b}"
  | .unsigned b => s!"UInt{b}"

/-- `Float32` and `Float64`. -/
inductive FloatType
  | f32
  | f64
  deriving Repr, DecidableEq

def FloatType.name : FloatType → String
  | .f32 => "Float32"
  | .f64 => "Float64"

mutual
/-- A resolved type. Generic types are already applied to their arguments. -/
inductive Ty where
  | string
  | bytes
  | int (k : IntType)
  | float (k : FloatType)
  | decimal
  /-- `Any`: any value, kept as parsed. -/
  | any
  /-- A std/time type: its own tag around a string (§13.2). -/
  | time (k : Time.TimeType)
  /-- `Secret a`: the same data as `a`, hidden on the host side. -/
  | secret (t : Ty)
  | array (t : Ty)
  | map (t : Ty)
  /-- `{ … }` or `closed { … }`. -/
  | record (closed : Bool) (fields : List Field)
  /-- `< … >` or `closed < … >`; `< >` has no cases. -/
  | variant (closed : Bool) (cases : List Case)
  /-- A named type, looked up in the environment. -/
  | ref (name : String)

/-- `key: T`, or `key?: T` when `optional`. -/
inductive Field where
  | mk (key : String) (optional : Bool) (ty : Ty)

/-- A case of a variant and the payload it takes. -/
inductive Case where
  /-- `Tag`: no payload. -/
  | bare (tag : String)
  /-- `Tag { … }`: one argument, a record. -/
  | record (tag : String) (closed : Bool) (fields : List Field)
  /-- `Tag T1 … Tn`: exactly n arguments. -/
  | positional (tag : String) (args : List Ty)
end

def Field.key : Field → String | .mk k _ _ => k
def Field.optional : Field → Bool | .mk _ o _ => o
def Field.ty : Field → Ty | .mk _ _ t => t

def Case.tag : Case → String
  | .bare t | .record t _ _ | .positional t _ => t

/-! The prelude's variants (`prelude.schema.haus`) are ordinary closed variants. -/

/-- `Bool = closed < False | True >` -/
def Ty.bool : Ty := .variant true [.bare "False", .bare "True"]
/-- `Maybe a = closed < None | Some a >` -/
def Ty.maybe (t : Ty) : Ty := .variant true [.bare "None", .positional "Some" [t]]
/-- `Result e a = closed < Err e | Ok a >` -/
def Ty.result (e a : Ty) : Ty := .variant true [.positional "Err" [e], .positional "Ok" [a]]

/-- A short name for error messages. It comes from the schema, never from data. -/
def Ty.name : Ty → String
  | .string => "String"
  | .bytes => "Bytes"
  | .int k => k.name
  | .float k => k.name
  | .decimal => "Decimal"
  | .any => "Any"
  | .time k => k.name
  | .secret _ => "Secret"
  | .array _ => "an array"
  | .map _ => "a Map"
  | .record _ _ => "a record"
  | .variant _ _ => "a variant"
  | .ref n => n

/-- The named types of a schema, generic ones applied to the arguments they are used with. -/
structure Env where
  defs : List (String × Ty)

def Env.lookup (env : Env) (n : String) : Option Ty := env.defs.lookup n

/--
How many references a decoder follows at one level of the input. Each name
can come up once there; a name coming up again is recursion that consumes no
input, which §14 rejects (§9.9).
-/
def Env.fuel (env : Env) : Nat := env.defs.length + 1

/-- Where an attribute is written: a type, or a field or tag in it (by name). -/
structure Attribute where
  type : String
  member : Option String
  name : String
  args : List Value

/--
A schema: its types, and its attributes (§14) in a table of their own. Tools
read the table; decoding and encoding only read `env`.
-/
structure Schema where
  env : Env
  attributes : List Attribute

/-- The schema without its attributes. -/
def Schema.erase (s : Schema) : Schema := { s with attributes := [] }

theorem Schema.erase_env (s : Schema) : s.erase.env = s.env := rfl

end Haus.Schema
