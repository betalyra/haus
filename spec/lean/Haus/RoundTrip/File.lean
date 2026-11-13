import Haus.RoundTrip.Values
import Haus.Correct

/-!
# The canonical form: round trip and uniqueness (spec §12)

* **E.** For every value a valid file contains, its canonical form is a
  valid file with exactly that value, in canonical order. So parsing it gives
  the value back: no string, key or number can break out of its syntax.
* **H.** Two such values have the same canonical form exactly when they are
  equal (§2). So `hash` is well defined: equal values hash the same, and
  different values have different canonical forms.
-/

namespace Haus.RoundTrip
open Haus Grammar Canonical Value

variable {L : Limits}

/-- Every value of a file is derived by the grammar, at the file's depth. -/
theorem File.vals {t : Text} {vs : List Value} (h : File L t vs) : ∀ v ∈ vs, ∃ s, Val L L.maxDepth s v := by
  have items : ∀ {t vs}, FileItems L t vs → ∀ v ∈ vs, ∃ s, Val L L.maxDepth s v := by
    intro t vs h
    induction h with
    | last _ _ _ hv _ => exact List.forall_mem_singleton.mpr ⟨_, hv⟩
    | lastComma _ _ _ _ hv _ _ => exact List.forall_mem_singleton.mpr ⟨_, hv⟩
    | cons _ _ _ _ _ _ hv _ _ _ ih => exact List.forall_mem_cons.mpr ⟨⟨_, hv⟩, ih⟩
  cases h with
  | empty => simp
  | values _ _ _ _ _ _ hi => exact items hi

/-- The canonical form of a value is a file with that value alone. -/
theorem file_canonical (hL : numberLimit ≤ L.maxNumberLength) {s : Text} {v : Value} (h : Val L L.maxDepth s v) : File L (canonical v) [v.canon] := by
  have := File.values [] [] _ _ (.inl rfl) .nil (FileItems.last _ [] _ (h.roundTrip hL) (.ws [] .nil))
  simpa [canonical] using this

/-- **E.** Parsing the canonical form of a parsed value gives it back, in canonical order. -/
theorem parse_canonical (hL : numberLimit ≤ L.maxNumberLength) {input : Text} {vs : List Value} (h : Parser.parse L input = .ok vs) {v : Value}
    (hv : v ∈ vs) : Parser.parse L (canonical v) = .ok [v.canon] := by
  obtain ⟨s, hs⟩ := File.vals ((parse_correct L input vs).mp h) v hv
  exact (parse_correct L _ _).mpr (file_canonical hL hs)

/-- Equal values (§2) have the same canonical form: for any values. -/
theorem canonical_of_equiv {a b : Value} (h : Equiv a b) : canonical a = canonical b := by
  simp only [canonical, Equiv] at *; rw [h]

/--
**H.** Two parsed values have the same canonical form exactly when they are
equal (§2), so equal values hash the same and different values don't share
a canonical form.
-/
theorem canonical_eq_iff (hL : numberLimit ≤ L.maxNumberLength) {input₁ input₂ : Text} {as bs : List Value}
    (h₁ : Parser.parse L input₁ = .ok as) (h₂ : Parser.parse L input₂ = .ok bs)
    {a b : Value} (ha : a ∈ as) (hb : b ∈ bs) : canonical a = canonical b ↔ Equiv a b := by
  refine ⟨fun h => ?_, canonical_of_equiv⟩
  have pa := parse_canonical hL h₁ ha
  have pb := parse_canonical hL h₂ hb
  rw [h, pb] at pa
  simpa [Equiv] using (Except.ok.inj pa).symm

end Haus.RoundTrip
