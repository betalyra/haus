import Haus.Grammar
import Haus.Parser
import Haus.Sound.Monad

/-!
# Completeness of the lexical parts

The reverse of `Haus.Sound.Lexical`: each grammar rule, followed by input
that can't continue it, is read exactly by its lexer.
-/

namespace Haus.Complete
open Haus Grammar Parser Sound

/-- What may follow a number or a tag: not `[A-Za-z0-9_.]`, which would continue it. -/
def NoIdent (r : Text) : Prop := ∀ c, r.head? = some c → isIdentChar c = false ∧ c ≠ '.'

/-! ## Numbers -/

theorem sepTail_complete {p : Char → Bool} (hp : p '_' = false) {a : Text} (h : SepTail p a)
    (x : Text) (hx : ∀ c, x.head? = some c → p c = false ∧ c ≠ '_') : sepTail p (a ++ x) = (a, x) := by
  induction h with
  | nil =>
    cases x with
    | nil => simp [sepTail]
    | cons c r =>
      obtain ⟨hpc, hc⟩ := hx c rfl
      unfold sepTail
      split
      · rename_i heq; simp at heq; exact absurd heq.1 hc
      · rename_i c' r' heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; simp [hpc]
      · simp at *
  | digit c rest hc _ ih =>
    have hc_ : c ≠ '_' := by rintro rfl; simp [hp] at hc
    unfold sepTail
    split
    · rename_i heq; simp at heq; exact absurd heq.1 hc_
    · rename_i c' r' heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; simp [hc, ih]
    · simp at *
  | sep c rest hc _ ih => simp [sepTail, hc, ih]

theorem digits_complete {p : Char → Bool} (hp : p '_' = false) {t : Text} (h : Digits p t)
    (x : Text) (hx : ∀ c, x.head? = some c → p c = false ∧ c ≠ '_') : digits p (t ++ x) = some (t, x) := by
  obtain ⟨c, rest, rfl, hc, hs⟩ := h
  simp [digits, hc, sepTail_complete hp hs x hx]

theorem isDigit_underscore : isDigit '_' = false := by decide
theorem isHexDigit_underscore : isHexDigit '_' = false := by decide
theorem isBinDigit_underscore : isBinDigit '_' = false := by decide

theorem isDigit_ident {c : Char} (h : isDigit c = true) : isIdentChar c = true := by
  simp [isIdentChar, h]

theorem isHexDigit_ident {c : Char} (h : isHexDigit c = true) : isIdentChar c = true := by
  simp only [isHexDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
  simp only [isIdentChar, isUpper, isLowerStart, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq,
    beq_iff_eq]
  rcases h with (h | h) | h
  · exact .inr h
  · exact .inl (.inr (.inl ⟨by exact Char.le_trans (by decide) h.1, by exact Char.le_trans h.2 (by decide)⟩))
  · exact .inl (.inl ⟨by exact Char.le_trans (by decide) h.1, by exact Char.le_trans h.2 (by decide)⟩)

theorem noIdent_digit {x : Text} (hx : NoIdent x) : ∀ c, x.head? = some c → isDigit c = false ∧ c ≠ '_' := by
  intro c hc
  have := (hx c hc).1
  refine ⟨?_, ?_⟩
  · cases h : isDigit c
    · rfl
    · simp [isDigit_ident h] at this
  · rintro rfl; simp [isIdentChar, isLowerStart] at this

theorem lexInt_complete {i : Text} (h : IntPart i) (x : Text)
    (hx : ∀ c, x.head? = some c → isDigit c = false ∧ c ≠ '_') : lexInt (i ++ x) = some (i, x) := by
  cases h with
  | zero => simp [lexInt]
  | nonzero c rest hd h0 hs =>
    have := digits_complete isDigit_underscore ⟨c, rest, rfl, hd, hs⟩ x hx
    unfold lexInt
    split
    · rename_i heq; simp at heq; exact absurd heq.1 h0
    · rename_i heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; simpa [h0] using this
    · simp at *

/-- After an exponent marker: digits and what follows, which can't be a sign. -/
theorem lexSign_digits {ds : Text} (h : Digits isDigit ds) (r : Text) : lexSign (ds ++ r) = ([], ds ++ r) := by
  obtain ⟨c, rest, rfl, hc, -⟩ := h
  unfold lexSign
  split
  · rename_i heq; simp at heq; rw [heq.1] at hc; simp [isDigit] at hc
  · rename_i heq; simp at heq; rw [heq.1] at hc; simp [isDigit] at hc
  · rfl

theorem lexExp_complete {e : Text} (h : e = [] ∨ Exp e) (r : Text) (hr : NoIdent r) : lexExp (e ++ r) = (e, r) := by
  rcases h with rfl | ⟨m, s, ds, rfl, hm, hs, hds⟩
  · cases r with
    | nil => simp [lexExp]
    | cons c r =>
      have := (hr c rfl).1
      have hm : (c == 'e' || c == 'E') = false := by
        cases hce : (c == 'e') <;> cases hcE : (c == 'E') <;> simp_all [isIdentChar, isLowerStart, isUpper]
      simp [lexExp, hm]
  · have hm' : (m == 'e' || m == 'E') = true := by rcases hm with rfl | rfl <;> decide
    have hsign : lexSign (s ++ ds ++ r) = (s, ds ++ r) := by
      rcases hs with rfl | rfl | rfl
      · simpa using lexSign_digits hds r
      · simp [lexSign]
      · simp [lexSign]
    have hd := digits_complete isDigit_underscore hds r (noIdent_digit hr)
    simp [lexExp, hm', List.append_assoc] at hsign ⊢
    simp [hsign, hd]

theorem lexFrac_complete {f : Text} (h : f = [] ∨ Frac f) (x : Text)
    (hx : ∀ c, x.head? = some c → isDigit c = false ∧ c ≠ '_' ∧ c ≠ '.') : lexFrac (f ++ x) = (f, x) := by
  rcases h with rfl | ⟨ds, rfl, hds⟩
  · cases x with
    | nil => simp [lexFrac]
    | cons c r =>
      have := (hx c rfl).2.2
      unfold lexFrac
      split
      · rename_i heq; simp at heq; exact absurd heq.1 this
      · simp
  · have := digits_complete isDigit_underscore hds x fun c hc => ⟨(hx c hc).1, (hx c hc).2.1⟩
    simp [lexFrac, this]

/-- What follows the integer part of a decimal: a fraction, an exponent, or the end of the number. -/
theorem decimal_follow {f e r : Text} (hf : f = [] ∨ Frac f) (he : e = [] ∨ Exp e) (hr : NoIdent r) :
    ∀ c, (f ++ e ++ r).head? = some c → isDigit c = false ∧ c ≠ '_' ∧ c ≠ 'x' ∧ c ≠ 'b' := by
  intro c hc
  rcases hf with rfl | ⟨ds, rfl, -⟩
  · rcases he with rfl | ⟨m, s, ds, rfl, hm, -, -⟩
    · have := (hr c (by simpa using hc)).1
      refine ⟨?_, ?_, ?_, ?_⟩
      · cases h : isDigit c
        · rfl
        · simp [isDigit_ident h] at this
      all_goals rintro rfl; simp [isIdentChar, isLowerStart] at this
    · simp at hc; subst hc; rcases hm with rfl | rfl <;> decide
  · simp at hc; subst hc; decide

theorem decimal_follow_frac {e r : Text} (he : e = [] ∨ Exp e) (hr : NoIdent r) :
    ∀ c, (e ++ r).head? = some c → isDigit c = false ∧ c ≠ '_' ∧ c ≠ '.' := by
  intro c hc
  rcases he with rfl | ⟨m, s, ds, rfl, hm, -, -⟩
  · refine ⟨(noIdent_digit hr c (by simpa using hc)).1, (noIdent_digit hr c (by simpa using hc)).2,
      (hr c (by simpa using hc)).2⟩
  · simp at hc; subst hc; rcases hm with rfl | rfl <;> decide

theorem lexDecimal_complete (s : Text) {i f e r : Text} (hi : IntPart i) (hf : f = [] ∨ Frac f)
    (he : e = [] ∨ Exp e) (hr : NoIdent r) :
    lexDecimal s (i ++ f ++ e ++ r) = some ⟨s ++ i ++ f ++ e, e, r⟩ := by
  have h1 := lexInt_complete hi (f ++ e ++ r) fun c hc => ⟨(decimal_follow hf he hr c hc).1, (decimal_follow hf he hr c hc).2.1⟩
  have h2 := lexFrac_complete hf (e ++ r) (decimal_follow_frac he hr)
  have h3 := lexExp_complete he r hr
  simp only [List.append_assoc] at h1 h2 ⊢
  simp [lexDecimal, h1, h2, h3, bind, Option.bind, pure]

theorem isBinDigit_ident {c : Char} (h : isBinDigit c = true) : isIdentChar c = true := by
  simp only [isBinDigit, Bool.or_eq_true, beq_iff_eq] at h
  rcases h with rfl | rfl <;> decide

theorem noIdent_radix {p : Char → Bool} (hp : ∀ c, p c = true → isIdentChar c = true) {x : Text} (hx : NoIdent x) :
    ∀ c, x.head? = some c → p c = false ∧ c ≠ '_' := by
  intro c hc
  have := (hx c hc).1
  refine ⟨?_, ?_⟩
  · cases h : p c
    · rfl
    · simp [hp c h] at this
  · rintro rfl; simp [isIdentChar, isLowerStart] at this

theorem lexMinus_digit {c : Char} (hc : isDigit c = true) (r : Text) : lexMinus (c :: r) = ([], c :: r) := by
  unfold lexMinus
  split
  · rename_i heq; simp at heq; rw [heq.1] at hc; simp [isDigit] at hc
  · rfl

theorem lexMinus_sign {s : Text} (hs : Sign s) (c : Char) (r : Text) (hc : isDigit c = true) :
    lexMinus (s ++ c :: r) = (s, c :: r) := by
  rcases hs with rfl | rfl
  · simpa using lexMinus_digit hc r
  · simp [lexMinus]

theorem intPart_head {i : Text} (h : IntPart i) : ∃ c r, i = c :: r ∧ isDigit c = true := by
  cases h with
  | zero => exact ⟨'0', [], rfl, by decide⟩
  | nonzero c rest hc _ _ => exact ⟨c, rest, rfl, hc⟩

theorem lexNumber_complete {L : Limits} {t : Text} (h : NumberLit L t) (r : Text) (hr : NoIdent r) :
    ∃ e, lexNumber (t ++ r) = some ⟨t, e, r⟩ ∧ expMagnitude e ≤ L.maxExponent ∧ t.length ≤ L.maxNumberLength := by
  cases h with
  | decimal s i f e hs hi hf he hexp hlen =>
    refine ⟨e, ?_, hexp, hlen⟩
    obtain ⟨c, i', rfl, hc⟩ := intPart_head hi
    have hm := lexMinus_sign hs c (i' ++ f ++ e ++ r) hc
    simp only [List.append_assoc, List.cons_append] at hm ⊢
    simp only [lexNumber, hm]
    have hd := lexDecimal_complete s hi hf he hr
    simp only [List.append_assoc, List.cons_append] at hd
    have hfol := decimal_follow hf he hr
    unfold lexUnsigned
    split
    · rename_i heq
      simp at heq; obtain ⟨rfl, heq⟩ := heq
      cases hi with
      | zero => have := (hfol 'x' (by simp only [List.nil_append] at heq; simp [List.append_assoc, heq])).2.2.1; exact absurd rfl this
      | nonzero _ _ _ h0 _ => exact absurd rfl h0
    · rename_i heq
      simp at heq; obtain ⟨rfl, heq⟩ := heq
      cases hi with
      | zero => have := (hfol 'b' (by simp only [List.nil_append] at heq; simp [List.append_assoc, heq])).2.2.2; exact absurd rfl this
      | nonzero _ _ _ h0 _ => exact absurd rfl h0
    · exact hd
  | hex s ds hs hds hlen =>
    refine ⟨[], ?_, by simp [expMagnitude, digitsValue], hlen⟩
    have hm := lexMinus_sign hs '0' ('x' :: ds ++ r) (by decide)
    have hd := digits_complete isHexDigit_underscore hds r (noIdent_radix (fun _ => isHexDigit_ident) hr)
    simp only [List.append_assoc, List.cons_append] at hm ⊢
    simp [lexNumber, hm, lexUnsigned, lexRadix, hd, HOrElse.hOrElse, OrElse.orElse, Option.orElse]
  | binary s ds hs hds hlen =>
    refine ⟨[], ?_, by simp [expMagnitude, digitsValue], hlen⟩
    have hm := lexMinus_sign hs '0' ('b' :: ds ++ r) (by decide)
    have hd := digits_complete isBinDigit_underscore hds r (noIdent_radix (fun _ => isBinDigit_ident) hr)
    simp only [List.append_assoc, List.cons_append] at hm ⊢
    simp [lexNumber, hm, lexUnsigned, lexRadix, hd, HOrElse.hOrElse, OrElse.orElse, Option.orElse]

theorem number_complete {L : Limits} {t : Text} (h : NumberLit L t) (r : Text) (hr : NoIdent r) :
    (number L).run (t ++ r) = .ok (.num (normalizeNumber t), r) := by
  obtain ⟨e, hl, hexp, hlen⟩ := lexNumber_complete h r hr
  have hrest : (r.head?.any fun c => isIdentChar c || c == '.') = false := by
    cases r with
    | nil => rfl
    | cons c r' => obtain ⟨h1, h2⟩ := hr c rfl; simp [h1, h2]
  simp [number, hl, hrest, Nat.not_lt.mpr hexp, Nat.not_lt.mpr hlen]

/-! ## Strings -/

theorem takeWhile_prefix {p : Char → Bool} {ds : Text} (hds : ∀ c ∈ ds, p c = true) {d : Char} (hd : p d = false)
    (r : Text) : (ds ++ d :: r).takeWhile p = ds ∧ (ds ++ d :: r).dropWhile p = d :: r := by
  induction ds with
  | nil => simp [hd]
  | cons c ds ih =>
    have hc := hds c (by simp)
    obtain ⟨h1, h2⟩ := ih fun x hx => hds x (by simp [hx])
    simp [hc, h1, h2]

theorem escape_complete {e : Text} {c : Char} (h : Escape e c) (r : Text) : escape.run (e ++ r) = .ok (c, r) := by
  cases h with
  | quote => rfl
  | backslash => rfl
  | newline => rfl
  | cr => rfl
  | tab => rfl
  | unicode ds h1 h6 hhex hs =>
    obtain ⟨ht, hd⟩ := takeWhile_prefix hhex (d := '}') (by decide) r
    have h1' : ¬ ds.length < 1 := by omega
    have h6' : ¬ ds.length > 6 := by omega
    have hne : ds ≠ [] := by rintro rfl; simp at h1
    simp only [List.append_assoc, List.cons_append, List.nil_append]
    simp [escape, ht, hd, hne, h6', hs]

/--
`chars` reads characters and escapes until `stop` holds: given text that
`Chars` describes, followed by text where `stop` holds, it returns the text.
-/
theorem chars_complete {ok : Char → Prop} {okb : Char → Bool} {stop : Text → Bool}
    (hok : ∀ c, ok c → okb c = true ∧ isBidi c = false ∧ c ≠ '\\')
    (hstop : ∀ c x, (c = '\\' ∨ ok c) → stop (c :: x) = false)
    (what : String) (start : Text) {raw s : Text} (h : Chars ok raw s) (r : Text) (hr : stop r = true) :
    ∀ fuel acc, raw.length < fuel → (chars what start okb stop fuel acc).run (raw ++ r) = .ok (acc.reverse ++ s, r) := by
  induction h with
  | nil =>
    intro fuel acc hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    simp [chars, hr]
  | char c raw s hc _ ih =>
    intro fuel acc hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    obtain ⟨hb, hbidi, hbs⟩ := hok c hc
    have hs := hstop c (raw ++ r) (.inr hc)
    have ih' := ih n (c :: acc) (by simp at hf; omega)
    simp only [List.cons_append]
    simp only [chars, run_bind, run_get, hs]
    simp [hbidi, hb, ih']
  | escape e c raw s he _ ih =>
    intro fuel acc hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    have hlen : 1 ≤ e.length := by cases he <;> simp
    have ih' := ih n (c :: acc) (by simp at hf; omega)
    obtain ⟨e', rfl⟩ : ∃ e', e = '\\' :: e' := by cases he <;> exact ⟨_, rfl⟩
    have hs := hstop '\\' (e' ++ raw ++ r) (.inl rfl)
    have hesc := escape_complete he (raw ++ r)
    simp only [List.cons_append, List.append_assoc] at hs hesc ⊢
    simp [chars, hs, hesc, ih']

theorem checkLength_ok {L : Limits} {s : Text} (h : s.length ≤ L.maxStringLength) (start r : Text) :
    (checkLength L s start).run r = .ok (String.ofList s, r) := by
  simp [checkLength, Nat.not_lt.mpr h]

theorem basicChar_ok (c : Char) (h : BasicChar c) : basicChar c = true ∧ isBidi c = false ∧ c ≠ '\\' := by
  obtain ⟨hq, hb, hc, hbi⟩ := h
  exact ⟨by simp [basicChar, hq, hc], hbi, hb⟩

theorem basicChar_stop (c : Char) (x : Text) (h : c = '\\' ∨ BasicChar c) :
    ((c :: x).head? == some '"') = false := by
  rcases h with rfl | ⟨hq, -⟩ <;> simp [*]

theorem basicString_complete {L : Limits} {t : Text} {s : String} (h : BasicString L t s) (r : Text) :
    (basicString L).run (t ++ r) = .ok (s, r) := by
  cases h with
  | mk raw s hc hlen =>
    have hch := chars_complete (stop := fun x => x.head? == some '"') basicChar_ok basicChar_stop "string"
      ('"' :: (raw ++ '"' :: r)) hc ('"' :: r) (by simp)
    simp only [List.cons_append, List.append_assoc]
    simp only [basicString, run_bind, run_get, run_skip, List.drop_succ_cons, List.drop_zero, List.nil_append]
    rw [hch _ [] (by simp; omega)]
    simp [checkLength_ok hlen]
