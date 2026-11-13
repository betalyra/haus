import Haus.Lexical

/-!
# Facts about lists of characters

Small lemmas the proofs share: what `takeWhile` and `dropWhile` return, and
the blank characters.
-/

namespace Haus

theorem mem_takeWhile {p : Char → Bool} {l : Text} {x : Char} (h : x ∈ l.takeWhile p) : p x = true := by
  induction l with
  | nil => simp at h
  | cons y ys ih =>
    simp only [List.takeWhile] at h
    split at h
    · rcases List.mem_cons.mp h with rfl | h
      · assumption
      · exact ih h
    · simp at h

/-- What `dropWhile` stops at fails the predicate. -/
theorem head_dropWhile {p : Char → Bool} {l : Text} {c : Char} (h : (l.dropWhile p).head? = some c) :
    p c = false := by
  induction l with
  | nil => simp at h
  | cons x xs ih =>
    simp only [List.dropWhile] at h
    split at h
    · exact ih h
    · simp at h; subst h; simp_all

/-- `takeWhile` reads exactly `ds` when what follows doesn't satisfy the predicate. -/
theorem takeWhile_append {p : Char → Bool} {ds : Text} (hds : ∀ c ∈ ds, p c = true) {x : Text}
    (hx : ∀ c, x.head? = some c → p c = false) : (ds ++ x).takeWhile p = ds ∧ (ds ++ x).dropWhile p = x := by
  induction ds with
  | nil =>
    cases x with
    | nil => simp
    | cons c r => simp [hx c rfl]
  | cons c ds ih =>
    obtain ⟨h1, h2⟩ := ih fun y hy => hds y (by simp [hy])
    simp [hds c (by simp), h1, h2]

theorem isBlank_iff {c : Char} : isBlank c = true ↔ c = ' ' ∨ c = '\t' := by
  simp [isBlank]

end Haus
