import Haus.Grammar
import Haus.Sound.Monad

/-!
# Soundness of numbers and strings

Each theorem says: when a lexer or parser succeeds, what it read is
derivable in the grammar (`Haus.Grammar`), with the value it returned.
-/

namespace Haus.Sound
open Haus Grammar Parser

/-! ## Numbers -/

theorem sepTail_spec (p : Char → Bool) (t : Text) :
    (sepTail p t).1 ++ (sepTail p t).2 = t ∧ SepTail p (sepTail p t).1 := by
  fun_induction sepTail p t <;> simp_all [SepTail.nil]
  · next ih => exact .sep _ _ ‹_› ih.2
  · next ih => exact .digit _ _ ‹_› ih.2

theorem digits_spec (p : Char → Bool) (t a b : Text) (h : digits p t = some (a, b)) :
    a ++ b = t ∧ Digits p a := by
  unfold digits at h
  split at h
  · rename_i c r
    split at h <;> simp at h
    obtain ⟨rfl, rfl⟩ := h
    have := sepTail_spec p r
    exact ⟨by simp [this.1], c, _, rfl, ‹_›, this.2⟩
  · simp at h

theorem digits_cons (p : Char → Bool) (c : Char) (r a b : Text) (h : digits p (c :: r) = some (a, b)) :
    p c = true ∧ a = c :: (sepTail p r).1 ∧ b = (sepTail p r).2 := by
  simp only [digits] at h
  split at h <;> simp_all

theorem lexInt_spec (t i r : Text) (h : lexInt t = some (i, r)) : i ++ r = t ∧ IntPart i := by
  cases t with
  | nil => simp [lexInt] at h
  | cons c rest =>
    by_cases hc : c = '0'
    · subst hc; simp [lexInt] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨rfl, .zero⟩
    · have h' : digits isDigit (c :: rest) = some (i, r) := by simpa [lexInt, hc] using h
      obtain ⟨hd, rfl, rfl⟩ := digits_cons _ _ _ _ _ h'
      have := sepTail_spec isDigit rest
      exact ⟨by simp [this.1], .nonzero _ _ hd hc this.2⟩

theorem lexFrac_spec (r : Text) :
    (lexFrac r).1 ++ (lexFrac r).2 = r ∧ ((lexFrac r).1 = [] ∨ Frac (lexFrac r).1) := by
  unfold lexFrac
  split
  · rename_i r'
    split
    · rename_i ds b h
      obtain ⟨h1, h2⟩ := digits_spec _ _ _ _ h
      exact ⟨by simp [h1], .inr ⟨ds, rfl, h2⟩⟩
    · simp
  · simp

theorem lexSign_spec (r : Text) :
    (lexSign r).1 ++ (lexSign r).2 = r ∧ ((lexSign r).1 = [] ∨ (lexSign r).1 = ['+'] ∨ (lexSign r).1 = ['-']) := by
  unfold lexSign; split <;> simp

theorem lexExp_spec (r : Text) :
    (lexExp r).1 ++ (lexExp r).2 = r ∧ ((lexExp r).1 = [] ∨ Exp (lexExp r).1) := by
  unfold lexExp
  split
  · rename_i m r'
    split
    · rename_i hm
      split
      · rename_i ds b h
        obtain ⟨h1, h2⟩ := digits_spec _ _ _ _ h
        have hs := lexSign_spec r'
        refine ⟨?_, .inr ⟨m, (lexSign r').1, ds, rfl, ?_, hs.2, h2⟩⟩
        · simp [h1, hs.1]
        · simpa using hm
      · simp
    · simp
  · simp

/-- What `lexNumber` reads has the shape of a number literal, limits aside. -/
def NumberShape (lit e : Text) : Prop :=
  (∃ s i f, Sign s ∧ IntPart i ∧ (f = [] ∨ Frac f) ∧ (e = [] ∨ Exp e) ∧ lit = s ++ i ++ f ++ e) ∨
  (∃ s ds, Sign s ∧ Digits isHexDigit ds ∧ lit = s ++ '0' :: 'x' :: ds ∧ e = []) ∨
  (∃ s ds, Sign s ∧ Digits isBinDigit ds ∧ lit = s ++ '0' :: 'b' :: ds ∧ e = [])

theorem lexDecimal_spec (s r : Text) (n : Lexed) (hs : Sign s) (h : lexDecimal s r = some n) :
    n.literal ++ n.rest = s ++ r ∧ NumberShape n.literal n.exponent := by
  simp only [lexDecimal, bind, Option.bind] at h
  split at h
  · simp at h
  · rename_i ir hi
    simp only [pure, Option.some.injEq] at h
    subst h
    obtain ⟨h1, h2⟩ := lexInt_spec _ _ _ hi
    have hf := lexFrac_spec ir.2
    have he := lexExp_spec (lexFrac ir.2).2
    refine ⟨?_, .inl ⟨s, ir.1, (lexFrac ir.2).1, hs, h2, hf.2, he.2, rfl⟩⟩
    simp [he.1, hf.1, ← h1]

theorem lexRadix_spec (p : Char → Bool) (s pre r : Text) (n : Lexed) (h : lexRadix p s pre r = some n) :
    n.literal ++ n.rest = s ++ pre ++ r ∧ ∃ ds, Digits p ds ∧ n.literal = s ++ pre ++ ds ∧ n.exponent = [] := by
  simp only [lexRadix, Option.map] at h
  split at h
  · rename_i x hd
    simp only [Option.some.injEq] at h
    subst h
    obtain ⟨h1, h2⟩ := digits_spec _ _ _ _ hd
    exact ⟨by simp [← h1], x.1, h2, rfl, rfl⟩
  · simp at h

theorem lexMinus_spec (t : Text) : (lexMinus t).1 ++ (lexMinus t).2 = t ∧ Sign (lexMinus t).1 := by
  unfold lexMinus; split <;> simp [Sign]

theorem lexUnsigned_spec (s r : Text) (n : Lexed) (hs : Sign s) (h : lexUnsigned s r = some n) :
    n.literal ++ n.rest = s ++ r ∧ NumberShape n.literal n.exponent := by
  unfold lexUnsigned at h
  split at h
  · simp only [Option.orElse_eq_orElse, Option.orElse_eq_or, Option.or_eq_some_iff] at h
    rcases h with h | ⟨-, h⟩
    · obtain ⟨h1, ds, h2, h3, h4⟩ := lexRadix_spec _ _ _ _ _ h
      exact ⟨by simpa using h1, .inr (.inl ⟨s, ds, hs, h2, by simpa using h3, h4⟩)⟩
    · exact lexDecimal_spec _ _ _ hs h
  · simp only [Option.orElse_eq_orElse, Option.orElse_eq_or, Option.or_eq_some_iff] at h
    rcases h with h | ⟨-, h⟩
    · obtain ⟨h1, ds, h2, h3, h4⟩ := lexRadix_spec _ _ _ _ _ h
      exact ⟨by simpa using h1, .inr (.inr ⟨s, ds, hs, h2, by simpa using h3, h4⟩)⟩
    · exact lexDecimal_spec _ _ _ hs h
  · exact lexDecimal_spec _ _ _ hs h

theorem lexNumber_spec (t : Text) (n : Lexed) (h : lexNumber t = some n) :
    n.literal ++ n.rest = t ∧ NumberShape n.literal n.exponent := by
  have hm := lexMinus_spec t
  have := lexUnsigned_spec _ _ _ hm.2 h
  exact ⟨this.1.trans hm.1, this.2⟩

theorem number_sound (L : Limits) (t rest : Text) (v : Value) (h : (number L).run t = .ok (v, rest)) :
    ∃ lit, t = lit ++ rest ∧ NumberLit L lit ∧ v = .num (normalizeNumber lit) := by
  simp only [number, run_bind, run_get] at h
  rcases hn : lexNumber t with _ | n
  · simp [hn] at h
  · simp only [hn] at h
    obtain ⟨h1, h2⟩ := lexNumber_spec t n hn
    by_cases c1 : (n.rest.head?.any fun c => isIdentChar c || c == '.') = true <;>
    by_cases c2 : n.literal.length > L.maxNumberLength <;>
    by_cases c3 : expMagnitude n.exponent > L.maxExponent <;>
    simp [c1, c2, c3] at h
    obtain ⟨rfl, rfl⟩ := h
    refine ⟨n.literal, h1.symm, ?_, rfl⟩
    rcases h2 with ⟨s, i, f, hs, hi, hf, he, hlit⟩ | ⟨s, ds, hs, hd, hlit, -⟩ | ⟨s, ds, hs, hd, hlit, -⟩
    · rw [hlit] at c2 ⊢; exact .decimal s i f _ hs hi hf he (by omega) (by omega)
    · rw [hlit] at c2 ⊢; exact .hex s ds hs hd (by omega)
    · rw [hlit] at c2 ⊢; exact .binary s ds hs hd (by omega)

/-! ## Strings -/

theorem escape_sound (t r : Text) (c : Char) (h : escape.run t = .ok (c, r)) :
    ∃ e, t = e ++ r ∧ Escape e c := by
  simp only [escape, run_bind, run_get] at h
  split at h <;> simp at h
  · obtain ⟨rfl, rfl⟩ := h; exact ⟨_, rfl, .quote⟩
  · obtain ⟨rfl, rfl⟩ := h; exact ⟨_, rfl, .backslash⟩
  · obtain ⟨rfl, rfl⟩ := h; exact ⟨_, rfl, .newline⟩
  · obtain ⟨rfl, rfl⟩ := h; exact ⟨_, rfl, .cr⟩
  · obtain ⟨rfl, rfl⟩ := h; exact ⟨_, rfl, .tab⟩
  · rename_i r0
    have hsplit := List.takeWhile_append_dropWhile (p := isHexDigit) (l := r0)
    have hhex : ∀ x ∈ r0.takeWhile isHexDigit, isHexDigit x = true := fun x hx => mem_takeWhile hx
    split at h
    · rename_i r'' hclose
      by_cases c1 : r0.takeWhile isHexDigit = [] ∨ 6 < (r0.takeWhile isHexDigit).length <;>
      by_cases c2 : isScalar (digitsValue 16 (r0.takeWhile isHexDigit)) = false <;>
      simp [c1, c2] at h
      obtain ⟨rfl, rfl⟩ := h
      refine ⟨['\\', 'u', '{'] ++ r0.takeWhile isHexDigit ++ ['}'], ?_, ?_⟩
      · conv => lhs; rw [← hsplit, hclose]
        simp
      · simp only [not_or] at c1
        exact .unicode _ (by have := c1.1; cases h : r0.takeWhile isHexDigit <;> simp_all) (by omega) hhex
          (by simpa using c2)
    · simp at h

theorem Chars.mono {P Q : Char → Prop} (hPQ : ∀ c, P c → Q c) {raw s : Text} (h : Chars P raw s) :
    Chars Q raw s := by
  induction h with
  | nil => exact .nil
  | char c raw s hc _ ih => exact .char c raw s (hPQ c hc) ih
  | escape e c raw s he _ ih => exact .escape e c raw s he ih

/-- `chars` reads characters allowed by `ok` (but no backslash or bidi control) and escapes. -/
theorem chars_sound (what : String) (start : Text) (ok : Char → Bool) (stop : Text → Bool) :
    ∀ (n : Nat) (acc t s r : Text), (chars what start ok stop n acc).run t = .ok (s, r) →
    ∃ raw s', t = raw ++ r ∧ s = acc.reverse ++ s' ∧ stop r = true ∧
      Chars (fun c => ok c = true ∧ c ≠ '\\' ∧ isBidi c = false) raw s' := by
  intro n
  induction n with
  | zero => intro acc t s r h; simp [chars] at h
  | succ n ih =>
    intro acc t s r h
    simp only [chars, run_bind, run_get] at h
    by_cases hs : stop t = true
    · simp [hs] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨[], [], rfl, by simp, hs, .nil⟩
    · simp only [hs, Bool.false_eq_true, ↓reduceIte] at h
      split at h
      · simp at h
      · -- an escape
        rename_i rest
        simp only [run_bind] at h
        split at h
        · simp at h
        · rename_i v hv
          obtain ⟨raw, s', h1, h2, h3, h4⟩ := ih _ _ _ _ h
          obtain ⟨e, he1, he2⟩ := escape_sound _ _ _ hv
          refine ⟨e ++ raw, v.1 :: s', by simp [he1, h1], by simp [h2], h3, .escape _ _ _ _ he2 h4⟩
      · rename_i c rest hne
        by_cases hb : isBidi c = true <;> by_cases hok : ok c = true <;> simp [hb, hok] at h
        obtain ⟨raw, s', h1, h2, h3, h4⟩ := ih _ _ _ _ h
        have hc : c ≠ '\\' := by rintro rfl; simp_all
        exact ⟨c :: raw, c :: s', by simp [h1], by simp [h2], h3, .char _ _ _ ⟨hok, hc, by simpa using hb⟩ h4⟩

theorem basicString_sound (L : Limits) (t0 r : Text) (str : String)
    (h : (basicString L).run ('"' :: t0) = .ok (str, r)) :
    ∃ raw, '"' :: t0 = raw ++ r ∧ BasicString L raw str := by
  simp only [basicString, checkLength, run_bind, run_get, run_skip, List.drop_succ_cons, List.drop_zero] at h
  split at h
  · simp at h
  · rename_i v hv
    obtain ⟨raw, s', h1, h2, h3, h4⟩ := chars_sound _ _ _ _ _ _ _ _ _ hv
    obtain ⟨r2, hr2⟩ : ∃ r2, v.2 = '"' :: r2 := by
      cases hv2 : v.2 with
      | nil => simp [hv2] at h3
      | cons c r2 => simp [hv2] at h3; exact ⟨r2, by rw [h3]⟩
    simp only [hr2, List.drop_succ_cons, List.drop_zero] at h
    by_cases hl : v.1.length > L.maxStringLength <;> simp [hl] at h
    obtain ⟨rfl, rfl⟩ := h
    refine ⟨'"' :: raw ++ ['"'], by simp [h1, hr2], ?_⟩
    simp only [List.reverse_nil, List.nil_append] at h2
    rw [h2] at hl ⊢
    refine .mk raw s' (Chars.mono ?_ h4) (by omega)
    intro c ⟨hok, hb, hbidi⟩
    simp [basicChar] at hok
    exact ⟨hok.1, hb, hok.2, hbidi⟩

end Haus.Sound
