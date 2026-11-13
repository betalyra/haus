import Haus.Grammar
import Haus.Canonical
import Haus.RoundTrip.Strings
import Haus.RoundTrip.Numbers

/-!
# The canonical form parses back to the value

For every value the grammar derives, its canonical form is derived too, with
the value in canonical order (`Value.canon`): records sorted, nothing else
changed. By induction on the grammar's derivation, like the completeness
proof; the leaves (strings, keys, bytes, numbers) are lemmas of their own.
-/

namespace Haus.RoundTrip
open Haus Grammar Canonical Value

variable {L : Limits}

/-! ## More nesting is allowed -/

theorem succ_of_le {n m : Nat} (h : n + 1 ≤ m) : ∃ m', m = m' + 1 ∧ n ≤ m' := ⟨m - 1, by omega, by omega⟩

mutual
theorem _root_.Haus.Grammar.Val.mono {n : Nat} {t : Text} {v : Value} :
    Val L n t v → ∀ m, n ≤ m → Val L m t v
  | .number _ t h, m, _ => .number m t h
  | .string _ t s h, m, _ => .string m t s h
  | .blockString _ t s h, m, _ => .blockString m t s h
  | .bytes _ raw bs h hl, m, _ => .bytes m raw bs h hl
  | .array _ inner xs hi, m, hm => by
    obtain ⟨m', rfl, h'⟩ := succ_of_le hm; exact .array m' inner xs (hi.mono m' h')
  | .record _ t fs hr, m, hm => by
    obtain ⟨m', rfl, h'⟩ := succ_of_le hm; exact .record m' t fs (hr.mono m' h')
  | .tag _ t h, m, _ => .tag m t h
  | .payload _ t sp inner xs ht hsp hi hxs, m, hm => by
    obtain ⟨m', rfl, h'⟩ := succ_of_le hm; exact .payload m' t sp inner xs ht hsp (hi.mono m' h') hxs
  | .recordPayload _ t sp r fs ht hsp hr, m, hm => by
    obtain ⟨m', rfl, h'⟩ := succ_of_le hm; exact .recordPayload m' t sp r fs ht hsp (hr.mono m' h')

theorem _root_.Haus.Grammar.Items.mono {n : Nat} {t : Text} {xs : List Value} :
    Items L n t xs → ∀ m, n ≤ m → Items L m t xs
  | .empty _ w hw, m, _ => .empty m w hw
  | .some _ w t xs hw hi, m, hm => .some m w t xs hw (hi.mono m hm)

theorem _root_.Haus.Grammar.ItemsFrom.mono {n : Nat} {t : Text} {xs : List Value} :
    ItemsFrom L n t xs → ∀ m, n ≤ m → ItemsFrom L m t xs
  | .last _ v w x hv hw, m, hm => .last m v w x (hv.mono m hm) hw
  | .lastComma _ v w w' x hv hw hw', m, hm => .lastComma m v w w' x (hv.mono m hm) hw hw'
  | .cons _ v w w' t x xs hv hw hw' hi, m, hm => .cons m v w w' t x xs (hv.mono m hm) hw hw' (hi.mono m hm)

theorem _root_.Haus.Grammar.Record.mono {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → ∀ m, n ≤ m → Record L m t fs
  | .mk _ inner fs hf hnd, m, hm => .mk m inner fs (hf.mono m hm) hnd

theorem _root_.Haus.Grammar.Fields.mono {n : Nat} {t : Text} {fs : List (String × Value)} :
    Fields L n t fs → ∀ m, n ≤ m → Fields L m t fs
  | .empty _ w hw, m, _ => .empty m w hw
  | .some _ w t fs hw hf, m, hm => .some m w t fs hw (hf.mono m hm)

theorem _root_.Haus.Grammar.FieldsFrom.mono {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ m, n ≤ m → FieldsFrom L m t fs
  | .last _ f w x hf hw, m, hm => .last m f w x (hf.mono m hm) hw
  | .lastComma _ f w w' x hf hw hw', m, hm => .lastComma m f w w' x (hf.mono m hm) hw hw'
  | .cons _ f w w' t x xs hf hw hw' hi, m, hm => .cons m f w w' t x xs (hf.mono m hm) hw hw' (hi.mono m hm)

theorem _root_.Haus.Grammar.Field.mono {n : Nat} {t : Text} {f : String × Value} :
    Field L n t f → ∀ m, n ≤ m → Field L m t f
  | .mk _ k w w' v key x hk hw hw' hv, m, hm => .mk m k w w' v key x hk hw hw' (hv.mono m hm)
end

/-! ## Building the canonical text from its parts -/

theorem canonList_eq : ∀ xs : List Value, canonList xs = xs.map canon
  | [] => by simp [canonList]
  | x :: xs => by simp [canonList, canonList_eq xs]

theorem canonFields_eq : ∀ fs : List (String × Value), canonFields fs = fs.map fun kv => (kv.1, kv.2.canon)
  | [] => by simp [canonFields]
  | (k, v) :: fs => by simp [canonFields, canonFields_eq fs]

/-- Values written one after another, separated by `,`: the inside of `[…]` and `(…)`. -/
theorem itemsFrom_of {n : Nat} : ∀ (x : Value) (xs : List Value), (∀ y ∈ x :: xs, Val L n (write y) y) →
    ItemsFrom L n (writeList (x :: xs)) (x :: xs)
  | x, [], h => by simpa [writeList] using ItemsFrom.last n (write x) [] x (h x (by simp)) .nil
  | x, y :: ys, h => by
    have := ItemsFrom.cons n (write x) [] [] _ x (y :: ys) (h x (by simp)) .nil .nil
      (itemsFrom_of y ys fun z hz => h z (by simp_all))
    simpa [writeList] using this

theorem items_of {n : Nat} : ∀ xs : List Value, (∀ y ∈ xs, Val L n (write y) y) → Items L n (writeList xs) xs
  | [], _ => by simpa [writeList] using Items.empty n [] .nil
  | x :: xs, h => by simpa using Items.some n [] _ _ .nil (itemsFrom_of x xs h)

/-- Each field `key:value`, by its parts. -/
def FieldOk (L : Limits) (n : Nat) (kv : String × Value) : Prop :=
  Key L (Canonical.key kv.1) kv.1 ∧ Val L n (write kv.2) kv.2

theorem fieldsFrom_of {n : Nat} : ∀ (f : String × Value) (fs : List (String × Value)),
    (∀ g ∈ f :: fs, FieldOk L n g) → FieldsFrom L n (writeFields (f :: fs)) (f :: fs)
  | (k, v), [], h => by
    obtain ⟨hk, hv⟩ := h (k, v) (by simp)
    simpa [writeFields] using FieldsFrom.last n _ [] (k, v) (Field.mk n _ [] [] _ k v hk .nil .nil hv) .nil
  | (k, v), g :: gs, h => by
    obtain ⟨hk, hv⟩ := h (k, v) (by simp)
    have := FieldsFrom.cons n _ [] [] _ (k, v) (g :: gs) (Field.mk n _ [] [] _ k v hk .nil .nil hv) .nil .nil
      (fieldsFrom_of g gs fun z hz => h z (by simp_all))
    simpa [writeFields] using this

theorem fields_of {n : Nat} : ∀ fs : List (String × Value), (∀ g ∈ fs, FieldOk L n g) →
    Fields L n (writeFields fs) fs
  | [], _ => by simpa [writeFields] using Fields.empty n [] .nil
  | f :: fs, h => by simpa using Fields.some n [] _ _ .nil (fieldsFrom_of f fs h)

/-- Sorting the fields keeps them unique and keeps every field. -/
theorem record_of {n : Nat} (fs : List (String × Value)) (hnd : (fs.map Prod.fst).Nodup)
    (h : ∀ g ∈ fs, FieldOk L n (g.1, g.2.canon)) :
    Record L n ('{' :: writeFields ((canonFields fs).mergeSort fun a b => a.1 ≤ b.1) ++ ['}'])
      ((canonFields fs).mergeSort fun a b => a.1 ≤ b.1) := by
  have hp := List.mergeSort_perm (canonFields fs) (fun a b => decide (a.1 ≤ b.1))
  refine .mk n _ _ (fields_of _ fun g hg => ?_) ?_
  · obtain ⟨g', hg', rfl⟩ : ∃ g' ∈ fs, (g'.1, g'.2.canon) = g := by
      have := hp.mem_iff.mp hg
      rw [canonFields_eq] at this
      simpa using this
    exact h g' hg'
  · rw [(hp.map Prod.fst).nodup_iff, canonFields_eq, List.map_map]
    have : (Prod.fst ∘ fun kv : String × Value => (kv.1, kv.2.canon)) = Prod.fst := rfl
    rwa [this]

/-! ## The induction -/

/-- A record value is derived only as a record. -/
theorem val_record {n : Nat} {t : Text} {fs : List (String × Value)} (h : Val L n t (.record fs)) :
    ∃ m, n = m + 1 ∧ Record L m t fs := by
  cases h with
  | record m _ _ hr => exact ⟨m, rfl, hr⟩

theorem blank_nil : ∀ c ∈ ([] : Text), isBlank c = true := by simp

/-- The fields of a record in canonical order. -/
abbrev sorted (fs : List (String × Value)) : List (String × Value) :=
  (canonFields fs).mergeSort fun a b => a.1 ≤ b.1

theorem canon_record (fs : List (String × Value)) : (Value.record fs).canon = .record (sorted fs) := by
  simp [canon]

/-- One argument that isn't a record: `Tag(…)`. -/
theorem write_single (t : String) {x : Value} (hx : ∀ fs, x ≠ .record fs) :
    write (.variant t [x]) = t.toList ++ '(' :: write x ++ [')'] := by
  cases x <;> first | rfl | exact absurd rfl (hx _)

theorem canon_ne_record {x : Value} (hx : ∀ fs, x ≠ .record fs) : ∀ fs, x.canon ≠ .record fs := by
  cases x <;> simp_all [canon]

mutual
theorem _root_.Haus.Grammar.Val.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {v : Value} :
    Val L n t v → Val L n (write v.canon) v.canon
  | .number _ t hn => by simpa [canon, write] using number_canonical hL hn n
  | .string _ t s hs => by
    cases hs with
    | mk raw s' _ hl => simpa [canon, write] using string_canonical (L := L) (String.ofList s') (by simpa using hl) n
  | .blockString _ t s hs => by
    cases hs with
    | mk _ _ _ _ ss _ _ _ _ _ hl => simpa [canon, write] using string_canonical (L := L) (blockText ss) hl n
  | .bytes _ raw bs hb hl => by simpa [canon, write] using bytes_canonical hb hl n
  | .array m inner xs hi => by
    have := Val.array m _ _ (items_of (xs.map canon) fun y hy => by
      obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hy
      exact (hi.roundTrip hL) x hx)
    simpa [canon, write, canonList_eq] using this
  | .record m t fs hr => by
    rw [canon_record]; exact .record m _ _ (hr.roundTrip hL)
  | .tag _ t ht => by
    simpa [canon, canonList, write] using Val.tag n t ht
  | .payload m t sp inner xs ht hsp hi hxs => by
    have hall : ∀ x ∈ xs, Val L m (write x.canon) x.canon := (hi.roundTrip hL)
    -- `Tag(…)` with the arguments in canonical form
    have general := Val.payload m t [] _ _ ht blank_nil (items_of (xs.map canon) fun y hy => by
      obtain ⟨x, hx, rfl⟩ := List.mem_map.mp hy; exact hall x hx) (by simpa using hxs)
    rcases xs with _ | ⟨x, _ | ⟨y, ys⟩⟩
    · exact absurd rfl hxs
    · by_cases hx : ∃ fs, x = .record fs
      · -- `Tag({…})` is written `Tag{…}`, one level less deep
        obtain ⟨fs, rfl⟩ := hx
        have hv := hall (.record fs) (by simp)
        rw [canon_record] at hv
        obtain ⟨k, rfl, hr⟩ := val_record hv
        have := Val.recordPayload (k + 1) t [] _ _ ht blank_nil (hr.mono (k + 1) (by omega))
        simpa [canon, canonList, canon_record, write] using this
      · have hx' : ∀ fs, x ≠ .record fs := fun fs h => hx ⟨fs, h⟩
        rw [show (Value.variant (String.ofList t) [x]).canon = .variant (String.ofList t) [x.canon] by
          simp [canon, canonList], write_single _ (canon_ne_record hx')]
        simpa [writeList] using general
    · simpa [canon, canonList_eq, write, writeList] using general
  | .recordPayload m t sp r fs ht hsp hr => by
    have := Val.recordPayload m t [] _ _ ht blank_nil (hr.roundTrip hL)
    simpa [canon, canonList, canon_record, write] using this

theorem _root_.Haus.Grammar.Items.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {xs : List Value} :
    Items L n t xs → ∀ x ∈ xs, Val L n (write x.canon) x.canon
  | .empty _ _ _ => by simp
  | .some _ _ _ _ _ hi => (hi.roundTrip hL)

theorem _root_.Haus.Grammar.ItemsFrom.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {xs : List Value} :
    ItemsFrom L n t xs → ∀ x ∈ xs, Val L n (write x.canon) x.canon
  | .last _ _ _ _ hv _ => List.forall_mem_singleton.mpr (hv.roundTrip hL)
  | .lastComma _ _ _ _ _ hv _ _ => List.forall_mem_singleton.mpr (hv.roundTrip hL)
  | .cons _ _ _ _ _ _ _ hv _ _ hi => List.forall_mem_cons.mpr ⟨hv.roundTrip hL, (hi.roundTrip hL)⟩

theorem _root_.Haus.Grammar.Record.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → Record L n ('{' :: writeFields (sorted fs) ++ ['}']) (sorted fs)
  | .mk _ _ fs hf hnd => record_of fs hnd (hf.roundTrip hL)

theorem _root_.Haus.Grammar.Fields.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {fs : List (String × Value)} :
    Fields L n t fs → ∀ g ∈ fs, FieldOk L n (g.1, g.2.canon)
  | .empty _ _ _ => by simp
  | .some _ _ _ _ _ hf => (hf.roundTrip hL)

theorem _root_.Haus.Grammar.FieldsFrom.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ g ∈ fs, FieldOk L n (g.1, g.2.canon)
  | .last _ _ _ _ hf _ => List.forall_mem_singleton.mpr (hf.roundTrip hL)
  | .lastComma _ _ _ _ _ hf _ _ => List.forall_mem_singleton.mpr (hf.roundTrip hL)
  | .cons _ _ _ _ _ _ _ hf _ _ hi => List.forall_mem_cons.mpr ⟨hf.roundTrip hL, (hi.roundTrip hL)⟩

theorem _root_.Haus.Grammar.Field.roundTrip (hL : numberLimit ≤ L.maxNumberLength) {n : Nat} {t : Text} {f : String × Value} :
    Field L n t f → FieldOk L n (f.1, f.2.canon)
  | .mk _ _ _ _ _ _ _ hk _ _ hv => ⟨key_canonical hk, (hv.roundTrip hL)⟩
end

end Haus.RoundTrip
