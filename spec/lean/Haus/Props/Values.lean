import Haus.Grammar

/-!
# A3, A4 and A5: what values a valid file can contain

* **A3.** Every record, at any depth, has unique keys. JSON leaves duplicates
  undefined, and parsers that pick different ones have caused real exploits.
* **A4.** Every value is within the limits (spec §7): nesting depth, number
  literals, string and byte string lengths. A parser that computes the
  grammar can't hand an application more than the limits allow.
* **A5.** Every string is valid Unicode, with no lone surrogates.
-/

namespace Haus
open Grammar

/-- Every record in the value, at any depth, has unique keys. -/
inductive UniqueKeys : Value → Prop
  | num (s : String) : UniqueKeys (.num s)
  | str (s : String) : UniqueKeys (.str s)
  | bytes (bs : List UInt8) : UniqueKeys (.bytes bs)
  | arr (xs : List Value) : (∀ x ∈ xs, UniqueKeys x) → UniqueKeys (.arr xs)
  | record (fs : List (String × Value)) :
      (fs.map Prod.fst).Nodup → (∀ kv ∈ fs, UniqueKeys kv.2) → UniqueKeys (.record fs)
  | variant (t : String) (xs : List Value) : (∀ x ∈ xs, UniqueKeys x) → UniqueKeys (.variant t xs)

/--
The value is within the limits `L`, nested at most `n` levels. Records, arrays
and payloads are one level each; `Tag { … }` is one level, like in the grammar.
Numbers were written within the number limits.
-/
inductive Bounded (L : Limits) : Nat → Value → Prop
  | num (n : Nat) (lit : Text) : NumberLit L lit → Bounded L n (.num (normalizeNumber lit))
  | str (n : Nat) (s : String) : s.length ≤ L.maxStringLength → Bounded L n (.str s)
  | bytes (n : Nat) (bs : List UInt8) : bs.length ≤ L.maxStringLength → Bounded L n (.bytes bs)
  | tag (n : Nat) (t : String) : Bounded L n (.variant t [])
  | arr (n : Nat) (xs : List Value) : (∀ x ∈ xs, Bounded L n x) → Bounded L (n + 1) (.arr xs)
  | record (n : Nat) (fs : List (String × Value)) :
      (∀ kv ∈ fs, Bounded L n kv.2) → Bounded L (n + 1) (.record fs)
  | variant (n : Nat) (t : String) (xs : List Value) :
      (∀ x ∈ xs, Bounded L n x) → Bounded L (n + 1) (.variant t xs)
  | tagRecord (n : Nat) (t : String) (fs : List (String × Value)) :
      (∀ kv ∈ fs, Bounded L n kv.2) → Bounded L (n + 1) (.variant t [.record fs])

namespace Grammar

theorem all_nil {α : Type} {P : α → Prop} : ∀ y ∈ ([] : List α), P y := by simp

theorem all_singleton {α : Type} {P : α → Prop} {x : α} (h : P x) : ∀ y ∈ [x], P y := by simpa

theorem all_cons {α : Type} {P : α → Prop} {x : α} {xs : List α} (h : P x) (hs : ∀ y ∈ xs, P y) :
    ∀ y ∈ x :: xs, P y :=
  List.forall_mem_cons.mpr ⟨h, hs⟩

/-! ## A3 -/

mutual
theorem Val.uniqueKeys {L : Limits} {n : Nat} {t : Text} {v : Value} : Val L n t v → UniqueKeys v
  | .number .. => .num _
  | .string .. => .str _
  | .blockString .. => .str _
  | .bytes .. => .bytes _
  | .array _ _ _ hi => .arr _ hi.uniqueKeys
  | .record _ _ _ hr => hr.uniqueKeys
  | .tag .. => .variant _ _ all_nil
  | .payload _ _ _ _ _ _ _ hi _ => .variant _ _ hi.uniqueKeys
  | .recordPayload _ _ _ _ _ _ _ hr => .variant _ _ (all_singleton hr.uniqueKeys)

theorem Items.uniqueKeys {L : Limits} {n : Nat} {t : Text} {xs : List Value} :
    Items L n t xs → ∀ x ∈ xs, UniqueKeys x
  | .empty .. => all_nil
  | .some _ _ _ _ _ hi => hi.uniqueKeys

theorem ItemsFrom.uniqueKeys {L : Limits} {n : Nat} {t : Text} {xs : List Value} :
    ItemsFrom L n t xs → ∀ x ∈ xs, UniqueKeys x
  | .last _ _ _ _ hv _ => all_singleton hv.uniqueKeys
  | .lastComma _ _ _ _ _ hv _ _ => all_singleton hv.uniqueKeys
  | .cons _ _ _ _ _ _ _ hv _ _ hi => all_cons hv.uniqueKeys hi.uniqueKeys

theorem Record.uniqueKeys {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → UniqueKeys (.record fs)
  | .mk _ _ _ hf hn => .record _ hn hf.uniqueKeys

theorem Fields.uniqueKeys {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Fields L n t fs → ∀ kv ∈ fs, UniqueKeys kv.2
  | .empty .. => all_nil
  | .some _ _ _ _ _ hf => hf.uniqueKeys

theorem FieldsFrom.uniqueKeys {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ kv ∈ fs, UniqueKeys kv.2
  | .last _ _ _ _ hf _ => all_singleton hf.uniqueKeys
  | .lastComma _ _ _ _ _ hf _ _ => all_singleton hf.uniqueKeys
  | .cons _ _ _ _ _ _ _ hf _ _ hi => all_cons hf.uniqueKeys hi.uniqueKeys

theorem Field.uniqueKeys {L : Limits} {n : Nat} {t : Text} {f : String × Value} :
    Field L n t f → UniqueKeys f.2
  | .mk _ _ _ _ _ _ _ _ _ _ hv => hv.uniqueKeys
end

theorem FileItems.uniqueKeys {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) :
    ∀ x ∈ xs, UniqueKeys x := by
  induction h with
  | last _ _ _ hv _ => exact all_singleton hv.uniqueKeys
  | lastComma _ _ _ _ hv _ _ => exact all_singleton hv.uniqueKeys
  | cons _ _ _ _ _ _ hv _ _ _ ih => exact all_cons hv.uniqueKeys ih

/-- **A3.** Every record in a valid file, at any depth, has unique keys. -/
theorem File.uniqueKeys {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) :
    ∀ v ∈ vs, UniqueKeys v := by
  cases h with
  | empty => exact all_nil
  | values _ _ _ _ _ _ hi => exact hi.uniqueKeys

/-! ## A5 -/

/--
**A5.** Every character is a Unicode scalar value: at most U+10FFFF and not a
surrogate. So every string a parser returns is valid Unicode. This holds for
every `Char` in Lean, so for every string in every value; the grammar's job is
only to reject `\u{…}` escapes that aren't scalar values, which `Escape` does.
-/
theorem char_isScalar (c : Char) : isScalar c.toNat = true := by
  have e : c.toNat = c.val.toNat := rfl
  have := c.valid
  simp only [UInt32.isValidChar, Nat.isValidChar] at this
  simp only [isScalar]
  rw [e]
  rcases this with h | ⟨h1, h2⟩
  · simp only [show c.val.toNat ≤ 1114111 by omega, show ¬ 55296 ≤ c.val.toNat by omega,
      decide_true, decide_false, Bool.false_and, Bool.not_false, Bool.and_self]
  · simp only [show c.val.toNat ≤ 1114111 by omega, show ¬ c.val.toNat ≤ 57343 by omega,
      decide_true, decide_false, Bool.and_false, Bool.not_false, Bool.and_self]

/-! ## A4 -/

theorem ByteChars.length_le {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) : bs.length ≤ raw.length := by
  induction h with
  | nil => simp
  | blank _ _ _ _ _ ih => simp; omega
  | byte _ _ _ _ _ _ _ ih => simp; omega

theorem BasicString.length_le {L : Limits} {t : Text} {s : String} (h : BasicString L t s) :
    s.length ≤ L.maxStringLength := by
  cases h with
  | mk raw s hc hl => simpa [String.length_ofList] using hl

theorem BlockString.length_le {L : Limits} {t : Text} {s : String} (h : BlockString L t s) :
    s.length ≤ L.maxStringLength := by
  cases h with
  | mk _ _ _ _ _ _ _ _ _ _ hl => exact hl

mutual
theorem Val.bounded {L : Limits} {n : Nat} {t : Text} {v : Value} : Val L n t v → Bounded L n v
  | .number _ _ h => .num _ _ h
  | .string _ _ _ h => .str _ _ h.length_le
  | .blockString _ _ _ h => .str _ _ h.length_le
  | .bytes _ _ _ h hl => .bytes _ _ (Nat.le_trans h.length_le hl)
  | .array _ _ _ hi => .arr _ _ hi.bounded
  | .record _ _ _ hr => .record _ _ hr.bounded
  | .tag .. => .tag _ _
  | .payload _ _ _ _ _ _ _ hi _ => .variant _ _ _ hi.bounded
  | .recordPayload _ _ _ _ _ _ _ hr => .tagRecord _ _ _ hr.bounded

theorem Items.bounded {L : Limits} {n : Nat} {t : Text} {xs : List Value} :
    Items L n t xs → ∀ x ∈ xs, Bounded L n x
  | .empty .. => all_nil
  | .some _ _ _ _ _ hi => hi.bounded

theorem ItemsFrom.bounded {L : Limits} {n : Nat} {t : Text} {xs : List Value} :
    ItemsFrom L n t xs → ∀ x ∈ xs, Bounded L n x
  | .last _ _ _ _ hv _ => all_singleton hv.bounded
  | .lastComma _ _ _ _ _ hv _ _ => all_singleton hv.bounded
  | .cons _ _ _ _ _ _ _ hv _ _ hi => all_cons hv.bounded hi.bounded

theorem Record.bounded {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → ∀ kv ∈ fs, Bounded L n kv.2
  | .mk _ _ _ hf _ => hf.bounded

theorem Fields.bounded {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Fields L n t fs → ∀ kv ∈ fs, Bounded L n kv.2
  | .empty .. => all_nil
  | .some _ _ _ _ _ hf => hf.bounded

theorem FieldsFrom.bounded {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ kv ∈ fs, Bounded L n kv.2
  | .last _ _ _ _ hf _ => all_singleton hf.bounded
  | .lastComma _ _ _ _ _ hf _ _ => all_singleton hf.bounded
  | .cons _ _ _ _ _ _ _ hf _ _ hi => all_cons hf.bounded hi.bounded

theorem Field.bounded {L : Limits} {n : Nat} {t : Text} {f : String × Value} :
    Field L n t f → Bounded L n f.2
  | .mk _ _ _ _ _ _ _ _ _ _ hv => hv.bounded
end

theorem FileItems.bounded {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) :
    ∀ x ∈ xs, Bounded L L.maxDepth x := by
  induction h with
  | last _ _ _ hv _ => exact all_singleton hv.bounded
  | lastComma _ _ _ _ hv _ _ => exact all_singleton hv.bounded
  | cons _ _ _ _ _ _ hv _ _ _ ih => exact all_cons hv.bounded ih

/-- **A4.** Every value in a valid file is within the limits: at most `L.maxDepth`
levels deep, and every number, string and byte string within its limit. -/
theorem File.bounded {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) :
    ∀ v ∈ vs, Bounded L L.maxDepth v := by
  cases h with
  | empty => exact all_nil
  | values _ _ _ _ _ _ hi => exact hi.bounded

end Grammar
end Haus
