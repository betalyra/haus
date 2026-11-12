import Haus.Lexical

/-!
# The data model (spec §1) and equality (§2)
-/

namespace Haus

/-- A haus value. -/
inductive Value where
  /-- A number, as its normalized literal (§2): `19.90`, `-1e10`, `255`. -/
  | num (literal : String)
  /-- A sequence of Unicode scalar values. -/
  | str (s : String)
  | bytes (bs : List UInt8)
  | arr (items : List Value)
  /-- Fields in source order. Keys are unique (the grammar rejects duplicates). -/
  | record (fields : List (String × Value))
  /-- A tag and zero or more arguments. `Tag { … }` is `variant "Tag" [record …]`. -/
  | variant (tag : String) (args : List Value)
  deriving Repr, Inhabited, BEq

namespace Value

mutual
/-- Records with their fields sorted by key (by code point). Nothing else changes. -/
def canon : Value → Value
  | .arr xs => .arr (canonList xs)
  | .record fs => .record ((canonFields fs).mergeSort fun a b => a.1 ≤ b.1)
  | .variant t xs => .variant t (canonList xs)
  | v => v

def canonList : List Value → List Value
  | [] => []
  | x :: xs => canon x :: canonList xs

def canonFields : List (String × Value) → List (String × Value)
  | [] => []
  | (k, v) :: fs => (k, canon v) :: canonFields fs
end

/--
Equality (§2): the same kind, and numbers with equal normalized literals,
identical strings and bytes, arrays pairwise equal, records with the same
keys and equal values in any order, variants with the same tag and equal
arguments. Numbers are already normalized when parsed, so `1_000` = `1000`
and `0xFF` = `255`, while `1.0` ≠ `1`.
-/
def Equiv (a b : Value) : Prop := a.canon = b.canon

/-- `Equiv`, computed. -/
def equiv (a b : Value) : Bool := a.canon == b.canon

#guard equiv (.record [("a", .num "1"), ("b", .num "2")]) (.record [("b", .num "2"), ("a", .num "1")])
#guard !equiv (.num "1.0") (.num "1")
#guard !equiv (.arr [.num "1", .num "2"]) (.arr [.num "2", .num "1"])

end Value
end Haus
