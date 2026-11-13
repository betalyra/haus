import Haus.Stream

/-!
# Streams: the split doesn't matter (plan phase F)

`split_chunks`: however the text is split into chunks, the reader finds the
same pieces, so `read_chunks`: it returns the same values and the same error.
`pieces_prefix`: the pieces found after some of the chunks are a prefix of
the final ones, so a value is never taken back once it was returned.

The argument: the scanner only decides when it has seen enough of the input
(`step_stable`): a decision made on a chunk is the one it would make on the
whole text. Otherwise it waits, and decides once more input is there.
-/

namespace Haus.Stream
open Haus

/-! ## One step -/

/-- The scanner never waits at the end of the input. -/
theorem step_final_ne_wait (s : St) (c : Char) (r : Text) : step true s (c :: r) ≠ .wait := by
  cases hm : s.mode <;> simp only [step, hm, Bool.true_or, Bool.not_true, Bool.false_eq_true, ↓reduceIte] <;>
    (repeat' split) <;> simp

private theorem head?_append_of_le {r : Text} (h : 1 ≤ r.length) (e : Text) : (r ++ e).head? = r.head? := by
  cases r with
  | nil => simp at h
  | cons => rfl

/--
**A decision is final.** What the scanner decides on part of the input,
without waiting, it decides the same however the input continues.
-/
theorem step_stable {s : St} {c : Char} {r : Text} {x : Step} (h : step false s (c :: r) = x) (hx : x ≠ .wait)
    (f : Bool) (e : Text) : step f s (c :: (r ++ e)) = x := by
  subst h
  have hl : r.length ≤ (r ++ e).length := by simp
  by_cases h1 : 1 ≤ r.length <;> by_cases h2 : 2 ≤ r.length
  · have e1 := head?_append_of_le h1 e
    have e2 : (r ++ e).take 2 = r.take 2 := List.take_append_of_le_length h2
    have h1' : 1 ≤ (r ++ e).length := by omega
    have h2' : 2 ≤ (r ++ e).length := by omega
    cases hm : s.mode <;> simp only [step, hm, e1, e2, decide_eq_true h1, decide_eq_true h2, decide_eq_true h1',
      decide_eq_true h2', Bool.or_true, Bool.not_true, Bool.false_eq_true, ↓reduceIte]
  · have e1 := head?_append_of_le h1 e
    have h1' : 1 ≤ (r ++ e).length := by omega
    cases hm : s.mode <;> simp only [step, hm, e1, decide_eq_true h1, decide_eq_true h1', decide_eq_false h2,
      Bool.or_true, Bool.or_false, Bool.not_true, Bool.not_false, Bool.false_eq_true, ↓reduceIte] at hx ⊢ <;>
      by_cases hq : c = '"' <;> simp_all
  · omega
  · cases hm : s.mode <;> simp only [step, hm] at hx ⊢ <;>
      by_cases hs : c = '/' <;> by_cases hq : c = '"' <;> by_cases ha : c = '*' <;> by_cases hb : c = '\\' <;>
      simp_all

/-- A step taken without waiting stays within the input it saw. -/
theorem step_adv_le {s s' : St} {c : Char} {r : Text} {k : Nat} (h : step false s (c :: r) = .adv k s') :
    k ≤ r.length := by
  cases hm : s.mode <;> simp only [step, hm] at h <;>
    by_cases hs : c = '/' <;> by_cases hq : c = '"' <;> by_cases ha : c = '*' <;> by_cases hb : c = '\\' <;>
    simp_all <;> (repeat' split at h) <;> (try simp_all) <;> obtain ⟨rfl, -⟩ := h <;> (try omega) <;> (cases r <;> simp_all)

/-! ## Scanning -/

/-- Where `scan false` stopped, scanning continues on what comes after. -/
def resume (f : Bool) (x : List Text × Res) (e : Text) : List Text × Res :=
  match x.2 with
  | .ok s cur buf => let y := scan f s cur (buf ++ e); (x.1 ++ y.1, y.2)
  | .unbalanced _ => x

/--
**Scanning in parts.** Scanning `buf ++ e` gives what scanning `buf` without
waiting gave, continued on the rest.
-/
theorem scan_append (s : St) (cur buf : Text) (f : Bool) (e : Text) :
    scan f s cur (buf ++ e) = resume f (scan false s cur buf) e := by
  fun_induction scan false s cur buf with
  | case1 => simp [resume]
  | case2 => simp [resume]
  | case3 s cur c r k s' h ih =>
    have hk := step_adv_le h
    rw [List.cons_append, scan, step_stable h (by simp) f e]
    simp only [List.take_append_of_le_length hk, List.drop_append_of_le_length hk]
    exact ih
  | case4 s cur c r h ih =>
    rw [List.cons_append, scan, step_stable h (by simp) f e]
    simp only [ih, resume]
    split <;> simp_all
  | case5 s cur c r h =>
    rw [List.cons_append, scan, step_stable h (by simp) f e]
    simp [resume]

/-! ## Reading chunks -/

/-- Two chunks are read like one. -/
theorem push_push (rd : Reader) (a b : Text) : (rd.push a).push b = rd.push (a ++ b) := by
  rcases rd with ⟨pieces, _ | t⟩
  · simp only [Reader.push]
    rw [← List.append_assoc, scan_append _ _ _ false b, resume]
    split <;> simp_all
  · rfl

theorem finish_push_nil (rd : Reader) : (rd.push []).finish = rd.finish := by
  simp only [Reader.finish, push_push, List.append_nil]

theorem foldl_finish (cs : List Text) (rd : Reader) :
    (cs.foldl Reader.push rd).finish = (rd.push cs.flatten).finish := by
  induction cs generalizing rd with
  | nil => exact (finish_push_nil rd).symm
  | cons a cs ih => simp only [List.foldl_cons, ih, push_push, List.flatten_cons]

/-- **The split doesn't matter**: any chunks give the pieces of the whole text. -/
theorem split_chunks (cs : List Text) : split cs = split [cs.flatten] := by
  simp only [split, foldl_finish, List.foldl_cons, List.foldl_nil]

/-- **The split doesn't matter**: any chunks give the values and error of the whole text. -/
theorem read_chunks (L : Limits) (cs : List Text) : read L cs = read L [cs.flatten] := by
  unfold read; rw [split_chunks]

/-- Pieces are only ever added. -/
theorem push_pieces (rd : Reader) (a : Text) : rd.pieces <+: (rd.push a).pieces := by
  unfold Reader.push; split <;> simp

theorem finish_pieces (rd : Reader) : rd.pieces <+: rd.finish.pieces := by
  unfold Reader.finish Reader.close
  refine (push_pieces rd []).trans ?_
  split <;> simp

/--
**Values are never taken back**: the pieces found after the first chunks
are the first of the final pieces, so the values returned early are the
first values of the whole stream.
-/
theorem pieces_prefix (cs ds : List Text) : (cs.foldl Reader.push {}).pieces <+: (split (cs ++ ds)).pieces := by
  rw [split, List.foldl_append]
  refine List.IsPrefix.trans ?_ (finish_pieces _)
  generalize cs.foldl Reader.push {} = rd
  induction ds generalizing rd with
  | nil => exact List.prefix_refl _
  | cons d ds ih => exact (push_pieces rd d).trans (ih _)

end Haus.Stream
