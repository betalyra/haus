import Haus.RoundTrip.File
import Haus.Stream.Correct

/-!
# Hashing files and streams (spec §12, `hashAll`)

`hashAll` hashes a list of values as `canonicalAll`: their canonical forms
joined by `,`. These theorems show that this text identifies the list:

* **parse_canonicalAll:** it is a valid file and parses back to the values,
  in canonical order.
* **canonicalAll_eq_iff:** two parsed lists have the same text exactly when
  they have the same length and equal values (§2) in the same order.
* **canonical_eq_canonicalAll_iff:** a value's canonical form (`hash`) is the
  text of a list only for a list of one equal value, so `hash v = hashAll [v]`
  and no other list collides with a single value.
* **hashing while reading:** writing `,` and each value's canonical form as a
  stream reader gives the values builds `canonicalAll` (`hashText_eq`). The text
  for the values read so far is a prefix of the text for the whole stream
  (`canonicalAll_prefix`), and reading a stream in chunks gives the text of
  the whole file (`read_canonicalAll`).

As for `hash`, this is about the text that is hashed, not SHA-256 itself.
-/

namespace Haus.RoundTrip
open Haus Grammar Canonical Value

variable {L : Limits}

/-- The canonical forms of derived values, joined by `,`, are the items of a file. -/
theorem fileItems_canonicalAll (hL : numberLimit ≤ L.maxNumberLength) :
    ∀ (vs : List Value), vs ≠ [] → (∀ v ∈ vs, ∃ s, Val L L.maxDepth s v) →
      FileItems L (canonicalAll vs) (vs.map canon)
  | [], hne, _ => absurd rfl hne
  | [v], _, h => by
    obtain ⟨s, hs⟩ := h v (by simp)
    simpa [canonicalAll, writeList] using FileItems.last _ [] _ (hs.roundTrip hL) (.ws [] .nil)
  | v :: w :: ws, _, h => by
    obtain ⟨s, hs⟩ := h v (by simp)
    have rest := fileItems_canonicalAll hL (w :: ws) (by simp) (fun x hx => h x (by simp_all))
    simpa [canonicalAll, writeList] using
      FileItems.cons _ [] [] _ _ _ (hs.roundTrip hL) .nil .nil rest

/-- The text of derived values is a file with exactly those values, in canonical order. -/
theorem file_canonicalAll (hL : numberLimit ≤ L.maxNumberLength) {vs : List Value}
    (h : ∀ v ∈ vs, ∃ s, Val L L.maxDepth s v) : File L (canonicalAll vs) (vs.map canon) := by
  cases vs with
  | nil => simpa [canonicalAll, writeList] using File.empty (L := L) [] [] (.inl rfl) (.ws [] .nil)
  | cons v vs => simpa using File.values [] [] _ _ (.inl rfl) .nil (fileItems_canonicalAll hL (v :: vs) (by simp) h)

/-- **Parsing the text of a parsed file gives its values back,** in canonical order. -/
theorem parse_canonicalAll (hL : numberLimit ≤ L.maxNumberLength) {input : Text} {vs : List Value}
    (h : Parser.parse L input = .ok vs) : Parser.parse L (canonicalAll vs) = .ok (vs.map canon) :=
  (parse_correct L _ _).mpr (file_canonicalAll hL (File.vals ((parse_correct L input vs).mp h)))

/-- Two lists of values of the same length, equal (§2) pairwise. -/
inductive AllEquiv : List Value → List Value → Prop
  | nil : AllEquiv [] []
  | cons {a b : Value} {as bs : List Value} : Equiv a b → AllEquiv as bs → AllEquiv (a :: as) (b :: bs)

/-- Lists have the same canonical values exactly when they are equal pairwise. -/
theorem map_canon_eq_iff : ∀ {as bs : List Value}, as.map canon = bs.map canon ↔ AllEquiv as bs
  | [], [] => by simp [AllEquiv.nil]
  | [], _ :: _ => by simp; intro h; cases h
  | _ :: _, [] => by simp; intro h; cases h
  | a :: as, b :: bs => by
    simp only [List.map_cons, List.cons.injEq, map_canon_eq_iff (as := as) (bs := bs)]
    constructor
    · rintro ⟨h, hs⟩; exact .cons h hs
    · rintro (_ | ⟨h, hs⟩); exact ⟨h, hs⟩

/--
**Two parsed files have the same text exactly when they have the same length
and equal values (§2) in the same order,** so `hashAll` is well defined and
tells different lists apart.
-/
theorem canonicalAll_eq_iff (hL : numberLimit ≤ L.maxNumberLength) {input₁ input₂ : Text} {as bs : List Value}
    (h₁ : Parser.parse L input₁ = .ok as) (h₂ : Parser.parse L input₂ = .ok bs) :
    canonicalAll as = canonicalAll bs ↔ AllEquiv as bs := by
  rw [← map_canon_eq_iff]
  refine ⟨fun h => ?_, fun h => by simp [canonicalAll, h]⟩
  have pa := parse_canonicalAll hL h₁
  rw [h, parse_canonicalAll hL h₂] at pa
  exact (Except.ok.inj pa).symm

/--
**A value's canonical form is the text of a list only for one equal value:**
`hash v = hashAll [v]`, and `hash` never collides with `hashAll` of any other list.
-/
theorem canonical_eq_canonicalAll_iff (hL : numberLimit ≤ L.maxNumberLength) {input₁ input₂ : Text}
    {as bs : List Value} (h₁ : Parser.parse L input₁ = .ok as) (h₂ : Parser.parse L input₂ = .ok bs)
    {a : Value} (ha : a ∈ as) : canonical a = canonicalAll bs ↔ ∃ b, bs = [b] ∧ Equiv a b := by
  have pa := parse_canonical hL h₁ ha
  constructor
  · intro h
    rw [h, parse_canonicalAll hL h₂] at pa
    have hm := Except.ok.inj pa
    cases bs with
    | nil => simp at hm
    | cons b bs =>
      cases bs with
      | nil => exact ⟨b, rfl, by simp at hm; exact hm.symm⟩
      | cons => simp at hm
  · rintro ⟨b, rfl, hab⟩
    rw [canonicalAll_single]
    exact canonical_of_equiv hab

/-! ## Hashing while reading -/

/-- Appending a value: a `,`, then its canonical form. -/
theorem canonicalAll_append (vs : List Value) (v : Value) (hne : vs ≠ []) :
    canonicalAll (vs ++ [v]) = canonicalAll vs ++ ',' :: canonical v := by
  induction vs with
  | nil => exact absurd rfl hne
  | cons x xs ih =>
    cases xs with
    | nil => rfl
    | cons y ys =>
      have := ih (by simp)
      simp only [canonicalAll, List.cons_append, List.map_cons, writeList] at this ⊢
      rw [this]; simp

/--
What a hasher fed one value at a time writes: the first value's canonical
form, then `,` and the canonical form of each further value.
-/
def hashText (vs : List Value) : Text :=
  vs.foldl (fun (acc : Option Text) v => some (match acc with
    | none => canonical v
    | some t => t ++ ',' :: canonical v)) none |>.getD []

/-- The fold, started with text already written. -/
theorem foldl_some (vs : List Value) (t : Text) :
    vs.foldl (fun (acc : Option Text) v => some (match acc with
      | none => canonical v
      | some t => t ++ ',' :: canonical v)) (some t) =
    some (vs.foldl (fun t v => t ++ ',' :: canonical v) t) := by
  induction vs generalizing t with
  | nil => rfl
  | cons v vs ih => exact ih _

/-- Feeding more values after the text of a non-empty list gives the text of both. -/
theorem foldl_comma (vs : List Value) : ∀ (pre : List Value), pre ≠ [] →
    vs.foldl (fun t v => t ++ ',' :: canonical v) (canonicalAll pre) = canonicalAll (pre ++ vs) := by
  induction vs with
  | nil => intro pre _; simp
  | cons v vs ih =>
    intro pre hne
    simp only [List.foldl_cons]
    rw [← canonicalAll_append _ _ hne, ih _ (by simp)]
    simp

/-- **Hashing value by value writes exactly `canonicalAll`.** -/
theorem hashText_eq (vs : List Value) : hashText vs = canonicalAll vs := by
  cases vs with
  | nil => rfl
  | cons x xs =>
    simp only [hashText, List.foldl_cons]
    rw [foldl_some, ← canonicalAll_single, foldl_comma _ _ (by simp)]
    rfl

/-- The text for the values read so far is a prefix of the text for the whole stream. -/
theorem canonicalAll_prefix (ws : List Value) : ∀ (vs : List Value), canonicalAll vs <+: canonicalAll (vs ++ ws) := by
  induction ws with
  | nil => intro vs; simp
  | cons w ws ih =>
    intro vs
    have step : canonicalAll vs <+: canonicalAll (vs ++ [w]) := by
      cases vs with
      | nil => simp [canonicalAll, writeList]
      | cons x xs => rw [canonicalAll_append _ _ (by simp)]; exact List.prefix_append _ _
    have := step.trans (ih (vs ++ [w]))
    simpa using this

/--
**Hashing while reading:** when a stream read in any chunks succeeds, hashing
its values one at a time hashes the text of the whole file, `canonicalAll` of
what the parser gives for the file in one piece.
-/
theorem read_canonicalAll (cs : List Text) (vs : List Value) (h : Haus.Stream.read L cs = (vs, none)) :
    Parser.parse L cs.flatten = .ok vs ∧ hashText vs = canonicalAll vs :=
  ⟨(Haus.Stream.read_correct L cs vs).mp h, hashText_eq vs⟩

end Haus.RoundTrip
