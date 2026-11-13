import Haus.Complete.Strings

/-!
# Completeness of values and files

Values, records, arrays and payloads call each other, so their completeness
is proven together, by induction on the grammar's derivation.

**What follows a value.** The lexical lemmas need to know what comes after
a number or a tag (`NoIdent`, and no `(` or `{` after the blanks behind a
bare tag), and `ws` needs to know what comes after whitespace (`WsFollow`).
`ValFollow` covers all of them: after optional blanks, a line break, a
comment, a comma, a closing bracket or the end. The grammar only puts a
value before whitespace followed by one of those (`ws_valFollow`).

**Fuel.** Each lemma assumes fuel above twice the length of the text it
reads (`2 * t.length < fuel`): every level of nesting costs a few units and
reads at least two characters (its brackets). The parser starts with
`4 * (length + 1)`, which is enough for every value in the file. Because
each lemma holds for *all* fuel above the bound, no separate monotonicity
lemma is needed.

**Names.** The lemmas about grammar rules are declared as
`Haus.Grammar.Val.complete` and so on (with `_root_`), so that a derivation
`hv : Val L n t v` can be used as `hv.complete`.
-/

namespace Haus.Complete
open Haus Grammar Parser Sound

/-! ## What may follow -/

/-- A stop character: one that ends a value, after optional blanks. -/
def StopChar (c : Char) : Prop :=
  c = '\n' ∨ c = '\r' ∨ c = '/' ∨ c = ',' ∨ c = ']' ∨ c = ')' ∨ c = '}'

/-- What may follow a value: after blanks, a line break, a comment, a comma, a closing bracket or the end. -/
def ValFollow (r : Text) : Prop := ∀ c, (r.dropWhile isBlank).head? = some c → StopChar c

theorem stopChar_not_ident {c : Char} (h : StopChar c) : isIdentChar c = false ∧ c ≠ '.' := by
  rcases h with rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

theorem valFollow_noIdent {r : Text} (h : ValFollow r) : NoIdent r := by
  intro c hc
  cases r with
  | nil => simp at hc
  | cons d r' =>
    simp at hc; subst hc
    cases hb : isBlank d
    · exact stopChar_not_ident (h d (by simp [List.dropWhile, hb]))
    · have := isBlank_iff.mp hb
      rcases this with rfl | rfl <;> decide

theorem valFollow_noPayload {r : Text} (h : ValFollow r) :
    ∀ c, (r.dropWhile isBlank).head? = some c → c ≠ '(' ∧ c ≠ '{' := by
  intro c hc
  rcases h c hc with rfl | rfl | rfl | rfl | rfl | rfl | rfl <;> decide

theorem dropWhile_blank_newline {nl : Text} (h : Newline nl) (r : Text) :
    (nl ++ r).dropWhile isBlank = nl ++ r := by
  cases h <;> simp [isBlank]

/-- Whitespace followed by a comment, a comma or a closing bracket, or the end. -/
theorem ws_valFollow {w : Text} (h : WS w) {y : Text}
    (hy : ∀ c, y.head? = some c → c = '/' ∨ c = ',' ∨ c = ']' ∨ c = ')' ∨ c = '}') : ValFollow (w ++ y) := by
  induction h with
  | nil =>
    intro c hc
    cases y with
    | nil => simp at hc
    | cons d y' =>
      rcases hy d rfl with rfl | rfl | rfl | rfl | rfl <;> simp [isBlank] at hc <;> subst hc <;>
        simp [StopChar]
  | blank c rest hc _ ih =>
    intro d hd
    apply ih d
    simpa [List.dropWhile, hc] using hd
  | newline nl rest hnl _ _ =>
    intro d hd
    rw [List.append_assoc, dropWhile_blank_newline hnl] at hd
    cases hnl <;> simp at hd <;> subst hd <;> simp [StopChar]
  | lineComment body nl rest _ _ _ _ =>
    intro d hd
    simp [isBlank] at hd; subst hd; simp [StopChar]
  | blockComment c rest hc _ _ =>
    intro d hd
    cases hc
    simp [isBlank] at hd; subst hd; simp [StopChar]

theorem wsEnd_valFollow {w : Text} (h : WSEnd w) : ValFollow w := by
  cases h with
  | ws w hw => simpa using ws_valFollow hw (y := []) (by simp)
  | lineComment w body hw _ =>
    simpa using ws_valFollow hw (y := '/' :: '/' :: body) (by simp)

/-! ## Where values and keys start -/

def ValStart (c : Char) : Prop :=
  c = '{' ∨ c = '[' ∨ c = '"' ∨ c = 'x' ∨ c = '-' ∨ isDigit c = true ∨ isUpper c = true

theorem valStart_wsFollow {c : Char} (h : ValStart c) (r : Text) : WsFollow (c :: r) := by
  intro d hd
  simp at hd; subst hd
  rcases h with rfl | rfl | rfl | rfl | rfl | h | h
  any_goals decide
  all_goals refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> rintro rfl <;> simp [isDigit, isUpper] at h

theorem valStart_not_close {c : Char} (h : ValStart c) : c ≠ ']' ∧ c ≠ ')' ∧ c ≠ '}' := by
  rcases h with rfl | rfl | rfl | rfl | rfl | h | h
  any_goals decide
  all_goals refine ⟨?_, ?_, ?_⟩ <;> rintro rfl <;> simp [isDigit, isUpper] at h

theorem tag_head {t : Text} (h : Tag t) : ∃ c t', t = c :: t' ∧ isUpper c = true := by
  obtain ⟨c, cs, rfl, hc, -⟩ := h
  exact ⟨c, cs, rfl, hc⟩

theorem numberLit_head {L : Limits} {t : Text} (h : NumberLit L t) : ∃ c t', t = c :: t' ∧ (c = '-' ∨ isDigit c = true) := by
  cases h with
  | decimal s i f e hs hi =>
    obtain ⟨c, i', rfl, hc⟩ := intPart_head hi
    rcases hs with rfl | rfl
    · exact ⟨c, _, rfl, .inr hc⟩
    · exact ⟨'-', _, rfl, .inl rfl⟩
  | hex s ds hs =>
    rcases hs with rfl | rfl
    · exact ⟨'0', _, rfl, .inr (by decide)⟩
    · exact ⟨'-', _, rfl, .inl rfl⟩
  | binary s ds hs =>
    rcases hs with rfl | rfl
    · exact ⟨'0', _, rfl, .inr (by decide)⟩
    · exact ⟨'-', _, rfl, .inl rfl⟩

theorem val_head {L : Limits} {n : Nat} {t : Text} {v : Value} (h : Val L n t v) :
    ∃ c t', t = c :: t' ∧ ValStart c := by
  cases h with
  | number _ _ hn =>
    obtain ⟨c, t', rfl, hc⟩ := numberLit_head hn
    rcases hc with rfl | hc
    · exact ⟨_, _, rfl, .inr (.inr (.inr (.inr (.inl rfl))))⟩
    · exact ⟨_, _, rfl, .inr (.inr (.inr (.inr (.inr (.inl hc)))))⟩
  | string _ _ _ hs => cases hs; exact ⟨_, _, rfl, .inr (.inr (.inl rfl))⟩
  | blockString _ _ _ hs => cases hs; exact ⟨_, _, rfl, .inr (.inr (.inl rfl))⟩
  | bytes => exact ⟨_, _, rfl, .inr (.inr (.inr (.inl rfl)))⟩
  | array => exact ⟨_, _, rfl, .inr (.inl rfl)⟩
  | record _ _ _ hr => cases hr; exact ⟨_, _, rfl, .inl rfl⟩
  | tag _ _ ht =>
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    exact ⟨_, _, rfl, .inr (.inr (.inr (.inr (.inr (.inr hc)))))⟩
  | payload _ _ _ _ _ ht =>
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    exact ⟨_, _, rfl, .inr (.inr (.inr (.inr (.inr (.inr hc)))))⟩
  | recordPayload _ _ _ _ _ ht =>
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    exact ⟨_, _, rfl, .inr (.inr (.inr (.inr (.inr (.inr hc)))))⟩

theorem val_wsFollow {L : Limits} {n : Nat} {t : Text} {v : Value} (h : Val L n t v) (r : Text) :
    WsFollow (t ++ r) := by
  obtain ⟨c, t', rfl, hc⟩ := val_head h
  exact valStart_wsFollow hc _

theorem key_head {L : Limits} {k : Text} {key : String} (h : Key L k key) :
    ∃ c k', k = c :: k' ∧ (isLowerStart c = true ∨ c = '"') := by
  cases h with
  | ident ht => obtain ⟨c, cs, rfl, hc, -⟩ := ht; exact ⟨c, cs, rfl, .inl hc⟩
  | quoted _ hs => cases hs; exact ⟨_, _, rfl, .inr rfl⟩

/-! ## Keys -/

theorem chars_basic_head {raw s : Text} (h : Chars BasicChar raw s) : ∀ c, raw.head? = some c → c ≠ '"' := by
  intro c hc
  cases h with
  | nil => simp at hc
  | char c' _ _ hc' => simp at hc; subst hc; exact hc'.1
  | escape e c' _ _ he => cases he <;> simp at hc <;> subst hc <;> decide

theorem key_complete {L : Limits} {k : Text} {key : String} (h : Key L k key) {x : Text}
    (hx : ∀ c, x.head? = some c → isIdentChar c = false ∧ c ≠ '"') : (Parser.key L).run (k ++ x) = .ok (key, x) := by
  cases h with
  | ident ht =>
    obtain ⟨c, cs, rfl, hc, hcs⟩ := ht
    have hci : isIdentChar c = true := by simp [isIdentChar, hc]
    obtain ⟨htw, hdw⟩ := takeWhile_append (p := isIdentChar) (ds := c :: cs)
      (by intro y hy; rcases List.mem_cons.mp hy with rfl | hy; exact hci; exact hcs y hy)
      (x := x) fun d hd => (hx d hd).1
    have hq : c ≠ '"' := by rintro rfl; simp [isLowerStart] at hc
    simp only [Parser.key, run_bind, run_get, List.cons_append]
    split
    · rename_i heq; exact absurd (List.cons.inj heq).1 hq
    · rename_i heq; exact absurd (List.cons.inj heq).1 hq
    · rename_i c' _ heq
      obtain ⟨rfl, -⟩ := List.cons.inj heq
      simp only [hc, ↓reduceIte, run_bind, run_takeWhile, run_pure]
      rw [← List.cons_append, htw, hdw]
    · rename_i heq; simp at heq
  | quoted _ hs =>
    have hb := basicString_complete hs x
    cases hs with
    | mk raw s hc hlen =>
      have hnt : ¬ ∃ y, raw ++ '"' :: x = '"' :: '"' :: y := by
        rintro ⟨y, hy⟩
        cases raw with
        | nil => simp at hy; exact (hx '"' (by simp [hy])).2 rfl
        | cons c raw' => simp at hy; exact chars_basic_head hc c (by simp) hy.1
      simp only [Parser.key, run_bind, run_get]
      simp only [List.cons_append, List.append_assoc] at hb ⊢
      split
      · rename_i y heq; simp at heq; exact absurd ⟨y, heq⟩ hnt
      · exact hb
      · rename_i c' _ h1 h2 heq; exact absurd (List.cons.inj heq).1.symm h2
      · rename_i heq; simp at heq

theorem expect_complete (c : Char) (what : String) (r : Text) : (expect c what).run (c :: r) = .ok ((), r) := by
  simp [expect]

/-! ## Which branch `value` takes -/

theorem value_number (L : Limits) (f n : Nat) {c : Char} (hc : c = '-' ∨ isDigit c = true) (t : Text) :
    (value L (f + 1) n).run (c :: t) = (number L).run (c :: t) := by
  simp only [value, run_bind, run_get]
  split
  all_goals rename_i heq; simp only [List.cons.injEq, reduceCtorEq] at heq
  all_goals obtain ⟨rfl, rfl⟩ := heq
  any_goals (exfalso; rcases hc with h | h <;> simp [isDigit] at h)
  have hc' : (c == '-' || isDigit c) = true := by rcases hc with rfl | h <;> simp [*]
  simp [hc']

theorem value_upper (L : Limits) (f n : Nat) {c : Char} (hc : isUpper c = true) (t : Text) :
    (value L (f + 1) n).run (c :: t) = (variant L f n).run (c :: t) := by
  simp only [value, run_bind, run_get]
  split
  all_goals rename_i heq; simp only [List.cons.injEq, reduceCtorEq] at heq
  all_goals obtain ⟨rfl, rfl⟩ := heq
  any_goals (exfalso; revert hc; decide)
  have h1 : c ≠ '-' := by rintro rfl; simp [isUpper] at hc
  have h2 : isDigit c = false := by
    simp [isUpper, isDigit] at hc ⊢
    intro _
    exact Char.not_le.mp fun h => absurd (Char.le_trans hc.1 h) (by decide)
  simp [h1, h2, hc]

theorem value_record {L : Limits} {f n : Nat} {t r : Text} {fs : List (String × Value)}
    (h : (record L f n).run ('{' :: t) = .ok (fs, r)) : (value L (f + 1) n).run ('{' :: t) = .ok (.record fs, r) := by
  simp [value, h]

theorem value_array {L : Limits} {f n : Nat} {t r : Text} {xs : List Value}
    (h : (items L f n ']').run ('[' :: t) = .ok (xs, r)) : (value L (f + 1) n).run ('[' :: t) = .ok (.arr xs, r) := by
  simp [value, h]

theorem value_block {L : Limits} {f n : Nat} {t r : Text} {s : String}
    (h : (blockString L).run ('"' :: '"' :: '"' :: t) = .ok (s, r)) :
    (value L (f + 1) n).run ('"' :: '"' :: '"' :: t) = .ok (.str s, r) := by
  simp [value, h]

theorem value_string {L : Limits} {f n : Nat} {t r : Text} {s : String} (ht : ¬ ∃ y, t = '"' :: '"' :: y)
    (h : (basicString L).run ('"' :: t) = .ok (s, r)) : (value L (f + 1) n).run ('"' :: t) = .ok (.str s, r) := by
  simp only [value, run_bind, run_get]
  split
  all_goals rename_i heq; simp at heq
  · exact absurd ⟨_, heq⟩ ht
  · subst heq; simp [h]
  · rename_i h' _; exact absurd heq.1.symm h'

theorem value_bytes {L : Limits} {f n : Nat} {t r : Text} {v : Value}
    (h : (bytes L).run ('x' :: '"' :: t) = .ok (v, r)) : (value L (f + 1) n).run ('x' :: '"' :: t) = .ok (v, r) := by
  simp [value, h]

/-! ## Variants -/

theorem tag_takeWhile_complete {t : Text} (h : Tag t) {x : Text} (hx : ∀ c, x.head? = some c → isIdentChar c = false) :
    (t ++ x).takeWhile isIdentChar = t ∧ (t ++ x).dropWhile isIdentChar = x := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  refine takeWhile_append ?_ hx
  intro y hy
  rcases List.mem_cons.mp hy with rfl | hy
  · simp [isIdentChar, hc]
  · exact hcs y hy

theorem variant_tag {L : Limits} {t : Text} (h : Tag t) {r : Text} (hr : ValFollow r) (f n : Nat) :
    (variant L (f + 1) n).run (t ++ r) = .ok (.variant (String.ofList t) [], r) := by
  obtain ⟨htw, hdw⟩ := tag_takeWhile_complete h fun c hc => (valFollow_noIdent hr c hc).1
  have hp := valFollow_noPayload hr
  simp only [variant, run_bind, run_takeWhile, run_get, htw, hdw]
  split
  · rename_i heq; exact absurd rfl (hp '(' (by rw [heq]; rfl)).1
  · rename_i heq; exact absurd rfl (hp '{' (by rw [heq]; rfl)).2
  · simp

theorem variant_payload {L : Limits} {t sp inner r : Text} {xs : List Value} {f n : Nat} (h : Tag t)
    (hsp : ∀ c ∈ sp, isBlank c = true) (hxs : xs ≠ [])
    (hi : (items L f (n + 1) ')').run ('(' :: inner ++ ')' :: r) = .ok (xs, r)) :
    (variant L (f + 1) (n + 1)).run (t ++ sp ++ '(' :: inner ++ ')' :: r) = .ok (.variant (String.ofList t) xs, r) := by
  have hnb : ∀ c, (sp ++ '(' :: inner ++ ')' :: r).head? = some c → isIdentChar c = false := by
    intro c hc
    cases sp with
    | nil => simp at hc; subst hc; decide
    | cons d sp' =>
      simp at hc; subst hc
      have := hsp d (by simp)
      have := isBlank_iff.mp this
      rcases this with rfl | rfl <;> decide
  obtain ⟨htw, hdw⟩ := tag_takeWhile_complete h hnb
  obtain ⟨hsw, hsd⟩ := takeWhile_append hsp (x := '(' :: inner ++ ')' :: r) (by simp; decide)
  simp only [List.append_assoc, List.cons_append] at htw hdw hsw hsd hi ⊢
  simp [variant, htw, hdw, hsd, hi, hxs]

theorem variant_record {L : Limits} {t sp rt r : Text} {fs : List (String × Value)} {f n : Nat} (h : Tag t)
    (hsp : ∀ c ∈ sp, isBlank c = true) (hrt : ∃ rt', rt = '{' :: rt')
    (hr : (record L f (n + 1)).run (rt ++ r) = .ok (fs, r)) :
    (variant L (f + 1) (n + 1)).run (t ++ sp ++ rt ++ r) = .ok (.variant (String.ofList t) [.record fs], r) := by
  obtain ⟨rt', rfl⟩ := hrt
  have hnb : ∀ c, (sp ++ '{' :: rt' ++ r).head? = some c → isIdentChar c = false := by
    intro c hc
    cases sp with
    | nil => simp at hc; subst hc; decide
    | cons d sp' =>
      simp at hc; subst hc
      have := hsp d (by simp)
      have := isBlank_iff.mp this
      rcases this with rfl | rfl <;> decide
  obtain ⟨htw, hdw⟩ := tag_takeWhile_complete h hnb
  obtain ⟨hsw, hsd⟩ := takeWhile_append hsp (x := '{' :: rt' ++ r) (by simp; decide)
  simp only [List.append_assoc, List.cons_append] at htw hdw hsw hsd hr ⊢
  simp [variant, htw, hdw, hsd, hr]

/-! ## One iteration of the item and field loops -/

theorem itemsLoop_close (L : Limits) (g n : Nat) (close : Char) (start r : Text) (acc' : List Value) :
    (itemsLoop L (g + 1) n close start acc').run (close :: r) = .ok (acc'.reverse, r) := by
  simp [itemsLoop]

theorem itemsLoop_comma {L : Limits} {g n : Nat} {close : Char} {start : Text} {acc : List Value}
    {c : Char} {t s1 s2 s3 : Text} {x : Value} (hc : c ≠ close)
    (hv : (value L g n).run (c :: t) = .ok (x, s1)) (hw : ws.run s1 = .ok ((), ',' :: s2))
    (hw' : ws.run s2 = .ok ((), s3)) :
    (itemsLoop L (g + 1) n close start acc).run (c :: t) = (itemsLoop L g n close start (x :: acc)).run s3 := by
  simp [itemsLoop, hc, hv, hw, hw']

theorem itemsLoop_last {L : Limits} {g n : Nat} {close : Char} {start : Text} {acc : List Value}
    {c : Char} {t s1 r : Text} {x : Value} (hc : c ≠ close) (hclose : close ≠ ',')
    (hv : (value L g n).run (c :: t) = .ok (x, s1)) (hw : ws.run s1 = .ok ((), close :: r)) :
    (itemsLoop L (g + 1) n close start acc).run (c :: t) = .ok ((x :: acc).reverse, r) := by
  have hc' : (c == close) = false := by simp [hc]
  simp only [itemsLoop, run_bind, run_get, hc', Bool.false_eq_true, ↓reduceIte, hv, hw]
  split <;> simp_all

theorem fields_close (L : Limits) (g n : Nat) (start r : Text) (acc : List (String × Value)) :
    (fields L (g + 1) n start acc).run ('}' :: r) = .ok (acc.reverse, r) := by
  simp [fields]

theorem fields_comma {L : Limits} {g n : Nat} {start : Text} {acc : List (String × Value)}
    {c : Char} {t s1 s2 s3 s4 s5 s6 : Text} {k : String} {x : Value} (hc : c ≠ '}')
    (hk : (Parser.key L).run (c :: t) = .ok (k, s1)) (hw1 : ws.run s1 = .ok ((), ':' :: s2))
    (hw2 : ws.run s2 = .ok ((), s3)) (hv : (value L g n).run s3 = .ok (x, s4))
    (hdup : acc.any (·.1 == k) = false)
    (hw3 : ws.run s4 = .ok ((), ',' :: s5)) (hw4 : ws.run s5 = .ok ((), s6)) :
    (fields L (g + 1) n start acc).run (c :: t) = (fields L g n start ((k, x) :: acc)).run s6 := by
  simp only [fields, run_bind, run_get]
  split
  · rename_i heq; exact absurd (List.cons.inj heq).1 hc
  · rename_i heq; simp at heq
  · simp [hk, hw1, hw2, hv, hdup, hw3, hw4, expect]

theorem fields_last {L : Limits} {g n : Nat} {start : Text} {acc : List (String × Value)}
    {c : Char} {t s1 s2 s3 s4 r : Text} {k : String} {x : Value} (hc : c ≠ '}')
    (hk : (Parser.key L).run (c :: t) = .ok (k, s1)) (hw1 : ws.run s1 = .ok ((), ':' :: s2))
    (hw2 : ws.run s2 = .ok ((), s3)) (hv : (value L g n).run s3 = .ok (x, s4))
    (hdup : acc.any (·.1 == k) = false) (hw3 : ws.run s4 = .ok ((), '}' :: r)) :
    (fields L (g + 1) n start acc).run (c :: t) = .ok (((k, x) :: acc).reverse, r) := by
  simp only [fields, run_bind, run_get]
  split
  · rename_i heq; exact absurd (List.cons.inj heq).1 hc
  · rename_i heq; simp at heq
  · simp [hk, hw1, hw2, hv, hdup, hw3, expect]

/-! ## Assembling arrays and records -/

theorem items_run {L : Limits} {f n : Nat} {close o : Char} {inner x r : Text} {xs : List Value}
    (hw : ws.run (inner ++ close :: r) = .ok ((), x ++ close :: r))
    (hl : (itemsLoop L f n close (o :: inner ++ close :: r) []).run (x ++ close :: r) = .ok (xs, r)) :
    (items L (f + 1) (n + 1) close).run (o :: inner ++ close :: r) = .ok (xs, r) := by
  simp only [List.cons_append] at hl ⊢
  simp [items, hw, hl]

theorem record_run {L : Limits} {f n : Nat} {inner x r : Text} {fs : List (String × Value)}
    (hw : ws.run (inner ++ '}' :: r) = .ok ((), x ++ '}' :: r))
    (hl : (fields L f n ('{' :: inner ++ '}' :: r) []).run (x ++ '}' :: r) = .ok (fs, r)) :
    (record L (f + 1) (n + 1)).run ('{' :: inner ++ '}' :: r) = .ok (fs, r) := by
  simp only [List.cons_append] at hl ⊢
  simp [record, hw, hl]

theorem record_head {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} (h : Record L n t fs) :
    ∃ t', t = '{' :: t' := by
  cases h; exact ⟨_, rfl⟩

theorem itemsFrom_head {L : Limits} {n : Nat} {t : Text} {xs : List Value} (h : ItemsFrom L n t xs) :
    ∃ c t', t = c :: t' ∧ ValStart c := by
  cases h with
  | last _ _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩
  | lastComma _ _ _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩
  | cons _ _ _ _ _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩

theorem field_head {L : Limits} {n : Nat} {t : Text} {kv : String × Value} (h : Field L n t kv) :
    ∃ c t', t = c :: t' ∧ (isLowerStart c = true ∨ c = '"') := by
  cases h with
  | mk _ _ _ _ _ _ _ hk => obtain ⟨c, k', rfl, hc⟩ := key_head hk; exact ⟨c, _, rfl, hc⟩

theorem fieldsFrom_head {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} (h : FieldsFrom L n t fs) :
    ∃ c t', t = c :: t' ∧ (isLowerStart c = true ∨ c = '"') := by
  cases h with
  | last _ _ _ _ hf => obtain ⟨c, t', rfl, hc⟩ := field_head hf; exact ⟨c, _, rfl, hc⟩
  | lastComma _ _ _ _ _ hf => obtain ⟨c, t', rfl, hc⟩ := field_head hf; exact ⟨c, _, rfl, hc⟩
  | cons _ _ _ _ _ _ _ hf => obtain ⟨c, t', rfl, hc⟩ := field_head hf; exact ⟨c, _, rfl, hc⟩

theorem keyStart_wsFollow {c : Char} (h : isLowerStart c = true ∨ c = '"') (r : Text) : WsFollow (c :: r) := by
  intro d hd
  simp at hd; subst hd
  rcases h with h | rfl
  · refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> rintro rfl <;> simp [isLowerStart] at h
  · decide

theorem keyStart_not_close {c : Char} (h : isLowerStart c = true ∨ c = '"') : c ≠ '}' := by
  rcases h with h | rfl
  · rintro rfl; simp [isLowerStart] at h
  · decide

theorem ws_head {w : Text} (h : WS w) : ∀ c, w.head? = some c → c = ' ' ∨ c = '\t' ∨ c = '\n' ∨ c = '\r' ∨ c = '/' := by
  intro c hc
  cases h with
  | nil => simp at hc
  | blank d rest hd _ =>
    simp at hc; subst hc
    have := isBlank_iff.mp hd
    rcases this with h | h <;> simp [h]
  | newline nl rest hnl => cases hnl <;> simp at hc <;> subst hc <;> simp
  | lineComment => simp at hc; subst hc; simp
  | blockComment c' rest hc' => cases hc'; simp at hc; subst hc; simp

/-- After a key: whitespace and a colon. Neither continues an identifier or opens a block string. -/
theorem key_follow {w : Text} (h : WS w) (r : Text) :
    ∀ c, (w ++ ':' :: r).head? = some c → isIdentChar c = false ∧ c ≠ '"' := by
  intro c hc
  cases hw : w with
  | nil => rw [hw] at hc; simp at hc; subst hc; decide
  | cons d w' =>
    rw [hw] at hc; simp at hc; subst hc
    rcases ws_head h d (by simp [hw]) with rfl | rfl | rfl | rfl | rfl <;> decide

theorem nodup_any {acc : List (String × Value)} {kv : String × Value} {rest : List (String × Value)}
    (h : ((acc.reverse ++ kv :: rest).map Prod.fst).Nodup) : acc.any (·.1 == kv.1) = false := by
  simp only [List.map_append, List.map_cons, List.nodup_append, List.nodup_cons] at h
  obtain ⟨-, -, h⟩ := h
  rw [List.any_eq_false]
  intro y hy hk
  simp only [beq_iff_eq] at hk
  exact h y.1 (by simp; exact ⟨y.2, hy⟩) kv.1 (by simp) hk

/-! ## Values, by induction on the grammar's derivation -/

theorem wsFollow_close {c : Char} (h : c = ']' ∨ c = ')' ∨ c = '}' ∨ c = ',' ∨ c = ':') (r : Text) :
    WsFollow (c :: r) := by
  intro d hd; simp at hd; subst hd
  rcases h with rfl | rfl | rfl | rfl | rfl <;> decide

mutual
theorem _root_.Haus.Grammar.Val.complete {L : Limits} {n : Nat} {t : Text} {v : Value} : Val L n t v →
    ∀ r fuel, ValFollow r → 2 * t.length < fuel → (value L fuel n).run (t ++ r) = .ok (v, r)
  | .number _ _ hn, r, fuel, hr, hf => by
    obtain ⟨c, t', rfl, hc⟩ := numberLit_head hn
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    rw [List.cons_append, value_number L f _ hc, ← List.cons_append, number_complete hn r (valFollow_noIdent hr)]
  | .string _ _ _ hs, r, fuel, hr, hf => by
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    have hb := basicString_complete hs r
    cases hs with
    | mk raw s hc hlen =>
      have hnt : ¬ ∃ y, raw ++ '"' :: r = '"' :: '"' :: y := by
        rintro ⟨y, hy⟩
        cases raw with
        | nil =>
          simp at hy
          have := valFollow_noIdent hr
          have h1 := hr '"'
          cases r with
          | nil => simp at hy
          | cons d r' =>
            simp at hy; obtain ⟨rfl, -⟩ := hy
            exact absurd (h1 (by simp [List.dropWhile, isBlank])) (by simp [StopChar])
        | cons c raw' => simp at hy; exact chars_basic_head hc c (by simp) hy.1
      simp only [List.cons_append, List.append_assoc] at hb ⊢
      exact value_string hnt hb
  | .blockString _ _ _ hs, r, fuel, hr, hf => by
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    have hb := blockString_complete hs r
    cases hs
    simp only [List.cons_append, List.append_assoc, List.nil_append] at hb ⊢
    exact value_block hb
  | .bytes _ raw bs hb hlen, r, fuel, hr, hf => by
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    have := bytes_complete hb hlen r
    simp only [List.cons_append, List.append_assoc, List.nil_append] at this ⊢
    exact value_bytes this
  | .array _ inner xs hi, r, fuel, hr, hf => by
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 3 := ⟨fuel - 3, by simp at hf; omega⟩
    obtain ⟨x, hx, hw, hl⟩ := hi.complete ']' r (.inl rfl)
    have := items_run (o := '[') hw (hl (f + 1) _ (by simp at hf; omega))
    simp only [List.cons_append, List.append_assoc] at this ⊢
    exact value_array this
  | .record _ t fs hrec, r, fuel, hr, hf => by
    obtain ⟨t', rfl⟩ := record_head hrec
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by omega⟩
    have := hrec.complete r f (by simp at hf ⊢; omega)
    simp only [List.cons_append] at this ⊢
    exact value_record this
  | .tag _ t ht, r, fuel, hr, hf => by
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 2 := ⟨fuel - 2, by simp at hf; omega⟩
    rw [List.cons_append, value_upper L (f + 1) _ hc, ← List.cons_append]
    exact variant_tag ht hr f _
  | .payload _ t sp inner xs ht hsp hi hxs, r, fuel, hr, hf => by
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 4 := ⟨fuel - 4, by simp at hf; omega⟩
    obtain ⟨x, hx, hw, hl⟩ := hi.complete ')' r (.inr rfl)
    have hitems := items_run (o := '(') hw (hl (f + 1) _ (by simp at hf; omega))
    have := variant_payload (f := f + 2) ht hsp hxs hitems
    simp only [List.cons_append, List.append_assoc] at this ⊢
    rw [value_upper L (f + 3) _ hc]
    exact this
  | .recordPayload _ t sp rt fs ht hsp hrec, r, fuel, hr, hf => by
    obtain ⟨c, t', rfl, hc⟩ := tag_head ht
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 2 := ⟨fuel - 2, by simp at hf; omega⟩
    have hrr := hrec.complete r f (by simp at hf ⊢; omega)
    have := variant_record (f := f) ht hsp (record_head hrec) hrr
    simp only [List.cons_append, List.append_assoc] at this ⊢
    rw [value_upper L (f + 1) _ hc]
    exact this

theorem _root_.Haus.Grammar.Items.complete {L : Limits} {n : Nat} {inner : Text} {xs : List Value} :
    Items L n inner xs → ∀ close r, (close = ']' ∨ close = ')') →
    ∃ x, x.length ≤ inner.length ∧ ws.run (inner ++ close :: r) = .ok ((), x ++ close :: r) ∧
      ∀ fuel start, 2 * (x.length + 1) < fuel →
        (itemsLoop L fuel n close start []).run (x ++ close :: r) = .ok (xs, r)
  | .empty _ w hw, close, r, hc => by
    refine ⟨[], by simp, ws_complete hw (wsFollow_close (c := close) (by rcases hc with h | h <;> simp [h]) r), ?_⟩
    intro fuel start hf
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    simpa using itemsLoop_close L g _ close start r []
  | .some _ w t xs hw hif, close, r, hc => by
    obtain ⟨c, t', rfl, hcs⟩ := itemsFrom_head hif
    refine ⟨c :: t', by simp, ?_, ?_⟩
    · rw [List.append_assoc]; exact ws_complete hw (valStart_wsFollow hcs _)
    · intro fuel start hf
      simpa using hif.complete close r fuel start [] hc hf

theorem _root_.Haus.Grammar.ItemsFrom.complete {L : Limits} {n : Nat} {t : Text} {xs : List Value} :
    ItemsFrom L n t xs → ∀ close r fuel start acc, (close = ']' ∨ close = ')') → 2 * (t.length + 1) < fuel →
      (itemsLoop L fuel n close start acc).run (t ++ close :: r) = .ok (acc.reverse ++ xs, r)
  | .last _ v w x hv hw, close, r, fuel, start, acc, hc, hf => by
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    have hval := hv.complete (w ++ close :: r) g
      (ws_valFollow hw (y := close :: r) (by intro d hd; simp at hd; subst hd; rcases hc with rfl | rfl <;> simp))
      (by simp at hf ⊢; omega)
    have hws := ws_complete hw (wsFollow_close (c := close) (by rcases hc with h | h <;> simp [h]) r)
    have hne := (valStart_not_close hcs)
    simp only [List.cons_append] at hval
    have := itemsLoop_last (start := start) (acc := acc)
      (by rcases hc with rfl | rfl; exact hne.1; exact hne.2.1) (by rcases hc with rfl | rfl <;> decide) hval hws
    simp only [List.cons_append, List.append_assoc] at this ⊢
    simpa using this
  | .lastComma _ v w w' x hv hw hw', close, r, fuel, start, acc, hc, hf => by
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 + 1 := ⟨fuel - 2, by simp at hf; omega⟩
    have hval := hv.complete (w ++ (',' :: (w' ++ close :: r))) (g + 1)
      (ws_valFollow hw (y := ',' :: (w' ++ close :: r)) (by intro d hd; simp at hd; subst hd; simp))
      (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: (w' ++ close :: r)) (wsFollow_close (c := ',') (by simp) _)
    have hws' := ws_complete hw' (wsFollow_close (c := close) (by rcases hc with h | h <;> simp [h]) r)
    have hne := (valStart_not_close hcs)
    simp only [List.cons_append] at hval
    have := itemsLoop_comma (start := start) (acc := acc) (close := close)
      (by rcases hc with rfl | rfl; exact hne.1; exact hne.2.1) hval hws hws'
    simp only [List.cons_append, List.append_assoc] at this ⊢
    rw [this, itemsLoop_close]
    simp
  | .cons _ v w w' t x xs hv hw hw' hif, close, r, fuel, start, acc, hc, hf => by
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨c2, t', rfl, hcs2⟩ := itemsFrom_head hif
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    have hval := hv.complete (w ++ (',' :: (w' ++ (c2 :: (t' ++ close :: r))))) g
      (ws_valFollow hw (y := ',' :: (w' ++ (c2 :: (t' ++ close :: r)))) (by intro d hd; simp at hd; subst hd; simp))
      (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: (w' ++ (c2 :: (t' ++ close :: r)))) (wsFollow_close (c := ',') (by simp) _)
    have hws' := ws_complete hw' (r := c2 :: (t' ++ close :: r)) (valStart_wsFollow hcs2 _)
    have hne := (valStart_not_close hcs)
    simp only [List.cons_append] at hval
    have := itemsLoop_comma (start := start) (acc := acc) (close := close)
      (by rcases hc with rfl | rfl; exact hne.1; exact hne.2.1) hval hws hws'
    have ih := hif.complete close r g start (x :: acc) hc (by simp at hf ⊢; omega)
    simp only [List.cons_append, List.append_assoc] at this ih ⊢
    rw [this, ih]
    simp

theorem _root_.Haus.Grammar.Record.complete {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → ∀ r fuel, 2 * t.length ≤ fuel → (record L fuel (n + 1)).run (t ++ r) = .ok (fs, r)
  | .mk _ inner fs hfields hnd, r, fuel, hf => by
    obtain ⟨x, hx, hw, hl⟩ := hfields.complete r hnd
    obtain ⟨f, rfl⟩ : ∃ f, fuel = f + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    have := record_run hw (hl f _ (by simp at hf; omega))
    simp only [List.cons_append, List.append_assoc] at this ⊢
    exact this

theorem _root_.Haus.Grammar.Fields.complete {L : Limits} {n : Nat} {inner : Text} {fs : List (String × Value)} :
    Fields L n inner fs → ∀ r, (fs.map Prod.fst).Nodup →
    ∃ x, x.length ≤ inner.length ∧ ws.run (inner ++ '}' :: r) = .ok ((), x ++ '}' :: r) ∧
      ∀ fuel start, 2 * (x.length + 1) < fuel → (fields L fuel n start []).run (x ++ '}' :: r) = .ok (fs, r)
  | .empty _ w hw, r, _ => by
    refine ⟨[], by simp, ws_complete hw (wsFollow_close (c := '}') (by simp) r), ?_⟩
    intro fuel start hf
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    simpa using fields_close L g _ start r []
  | .some _ w t fs hw hff, r, hnd => by
    obtain ⟨c, t', rfl, hcs⟩ := fieldsFrom_head hff
    refine ⟨c :: t', by simp, ?_, ?_⟩
    · rw [List.append_assoc]; exact ws_complete hw (keyStart_wsFollow hcs _)
    · intro fuel start hf
      simpa using hff.complete r fuel start [] (by simpa using hnd) hf

theorem _root_.Haus.Grammar.FieldsFrom.complete {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ r fuel start acc, ((acc.reverse ++ fs).map Prod.fst).Nodup →
      2 * (t.length + 1) < fuel →
      (fields L fuel n start acc).run (t ++ '}' :: r) = .ok (acc.reverse ++ fs, r)
  | .last _ f w kv hfield hw, r, fuel, start, acc, hnd, hf => by
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    obtain ⟨c, rest, s1, s2, s3, heq, hc, hk, hw1, hw2, hv⟩ := hfield.complete (w ++ '}' :: r) g
      (ws_valFollow hw (y := '}' :: r) (by intro d hd; simp at hd; subst hd; simp)) (by simp at hf ⊢; omega)
    have hws := ws_complete hw (wsFollow_close (c := '}') (by simp) r)
    have := fields_last (start := start) (acc := acc) hc hk hw1 hw2 hv (nodup_any hnd) hws
    rw [List.append_assoc, heq, this]
    simp
  | .lastComma _ f w w' kv hfield hw hw', r, fuel, start, acc, hnd, hf => by
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 + 1 := ⟨fuel - 2, by simp at hf; omega⟩
    obtain ⟨c, rest, s1, s2, s3, heq, hc, hk, hw1, hw2, hv⟩ :=
      hfield.complete (w ++ (',' :: (w' ++ '}' :: r))) (g + 1)
        (ws_valFollow hw (y := ',' :: (w' ++ '}' :: r)) (by intro d hd; simp at hd; subst hd; simp))
        (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: (w' ++ '}' :: r)) (wsFollow_close (c := ',') (by simp) _)
    have hws' := ws_complete hw' (wsFollow_close (c := '}') (by simp) r)
    have := fields_comma (start := start) (acc := acc) hc hk hw1 hw2 hv (nodup_any (rest := []) (by simpa using hnd))
      hws hws'
    simp only [List.cons_append, List.append_assoc] at heq this ⊢
    rw [heq, this, fields_close]
    simp
  | .cons _ f w w' t kv fs hfield hw hw' hff, r, fuel, start, acc, hnd, hf => by
    obtain ⟨c2, t', rfl, hcs2⟩ := fieldsFrom_head hff
    obtain ⟨g, rfl⟩ : ∃ g, fuel = g + 1 := ⟨fuel - 1, by omega⟩
    obtain ⟨c, rest, s1, s2, s3, heq, hc, hk, hw1, hw2, hv⟩ :=
      hfield.complete (w ++ (',' :: (w' ++ (c2 :: (t' ++ '}' :: r))))) g
        (ws_valFollow hw (y := ',' :: (w' ++ (c2 :: (t' ++ '}' :: r))))
          (by intro d hd; simp at hd; subst hd; simp)) (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: (w' ++ (c2 :: (t' ++ '}' :: r)))) (wsFollow_close (c := ',') (by simp) _)
    have hws' := ws_complete hw' (r := c2 :: (t' ++ '}' :: r)) (keyStart_wsFollow hcs2 _)
    have := fields_comma (start := start) (acc := acc) hc hk hw1 hw2 hv (nodup_any hnd) hws hws'
    have ih := hff.complete r g start (kv :: acc) (by simpa using hnd) (by simp at hf ⊢; omega)
    simp only [List.cons_append, List.append_assoc] at heq this ih ⊢
    rw [heq, this, ih]
    simp

theorem _root_.Haus.Grammar.Field.complete {L : Limits} {n : Nat} {f : Text} {kv : String × Value} :
    Field L n f kv → ∀ y fuel, ValFollow y → 2 * f.length < fuel →
      ∃ c rest s1 s2 s3, f ++ y = c :: rest ∧ c ≠ '}' ∧ (Parser.key L).run (c :: rest) = .ok (kv.1, s1) ∧
        ws.run s1 = .ok ((), ':' :: s2) ∧ ws.run s2 = .ok ((), s3) ∧ (value L fuel n).run s3 = .ok (kv.2, y)
  | .mk _ k w w' v key x hk hw hw' hv, y, fuel, hy, hf => by
    obtain ⟨c, k', rfl, hcs⟩ := key_head hk
    have hkey := key_complete hk (key_follow hw (w' ++ (v ++ y)))
    have hws := ws_complete hw (r := ':' :: (w' ++ (v ++ y))) (wsFollow_close (c := ':') (by simp) _)
    have hws' := ws_complete hw' (r := v ++ y) (val_wsFollow hv y)
    have hval := hv.complete y fuel hy (by simp at hf ⊢; omega)
    refine ⟨c, k' ++ (w ++ (':' :: (w' ++ (v ++ y)))), w ++ (':' :: (w' ++ (v ++ y))), w' ++ (v ++ y), v ++ y,
      by simp, keyStart_not_close hcs, ?_, hws, hws', hval⟩
    simpa using hkey
end

/-! ## Files -/

theorem fileItems_head {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) :
    ∃ c t', t = c :: t' ∧ ValStart c := by
  cases h with
  | last _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩
  | lastComma _ _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩
  | cons _ _ _ _ _ _ hv => obtain ⟨c, t', rfl, hc⟩ := val_head hv; exact ⟨c, _, rfl, hc⟩

theorem fileLoop_nil (L : Limits) (fuel n : Nat) (acc : List Value) :
    (fileLoop L fuel (n + 1) acc).run [] = .ok (acc.reverse, []) := by
  simp [fileLoop]

theorem _root_.Haus.Grammar.FileItems.complete {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) :
    ∀ fuel n acc, 2 * t.length < fuel → t.length < n → (fileLoop L fuel n acc).run t = .ok (acc.reverse ++ xs, []) := by
  induction h with
  | last v w x hv hw =>
    intro fuel n acc hf hn
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨m, rfl⟩ : ∃ m, n = m + 1 := ⟨n - 1, by simp at hn; omega⟩
    have hval := hv.complete w fuel (wsEnd_valFollow hw) (by simp at hf ⊢; omega)
    simp only [List.cons_append] at hval ⊢
    simp [fileLoop, hval, wsEnd_complete hw]
  | lastComma v w w' x hv hw hw' =>
    intro fuel n acc hf hn
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨m, rfl⟩ : ∃ m, n = m + 1 + 1 := ⟨n - 2, by simp at hn; omega⟩
    have hval := hv.complete (w ++ (',' :: w')) fuel
      (ws_valFollow hw (y := ',' :: w') (by intro d hd; simp at hd; subst hd; simp)) (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: w') (wsFollow_close (c := ',') (by simp) _)
    simp only [List.cons_append, List.append_assoc] at hval ⊢
    simp [fileLoop, hval, hws, wsEnd_complete hw']
  | cons v w w' t x xs hv hw hw' hfi ih =>
    intro fuel n acc hf hn
    obtain ⟨c, v', rfl, hcs⟩ := val_head hv
    obtain ⟨c2, t', rfl, hcs2⟩ := fileItems_head hfi
    obtain ⟨m, rfl⟩ : ∃ m, n = m + 1 := ⟨n - 1, by simp at hn; omega⟩
    have hval := hv.complete (w ++ (',' :: (w' ++ c2 :: t'))) fuel
      (ws_valFollow hw (y := ',' :: (w' ++ c2 :: t')) (by intro d hd; simp at hd; subst hd; simp))
      (by simp at hf ⊢; omega)
    have hws := ws_complete hw (r := ',' :: (w' ++ c2 :: t')) (wsFollow_close (c := ',') (by simp) _)
    have hws' := ws_complete hw' (r := c2 :: t') (valStart_wsFollow hcs2 _)
    have ih' := ih fuel m (x :: acc) (by simp at hf ⊢; omega) (by simp at hn ⊢; omega)
    simp only [List.cons_append, List.append_assoc] at hval ih' ⊢
    simp [fileLoop, hval, hws, hws', ih']

/-- Whitespace or a value doesn't start with a byte order mark. -/
theorem stripBom {b x : Text} (hb : Bom b) (hx : ∀ c, x.head? = some c → c ≠ '﻿') :
    (match b ++ x with
      | '﻿' :: r => r
      | r => r) = x := by
  rcases hb with rfl | rfl
  · cases x with
    | nil => rfl
    | cons c r =>
      have := hx c rfl
      simp only [List.nil_append]
      split
      · rename_i heq; exact absurd (List.cons.inj heq).1 this
      · rfl
  · rfl

theorem ws_noBom {w : Text} (h : WS w) : ∀ c, w.head? = some c → c ≠ '﻿' := by
  intro c hc
  rcases ws_head h c hc with rfl | rfl | rfl | rfl | rfl <;> decide

theorem wsEnd_noBom {w : Text} (h : WSEnd w) : ∀ c, w.head? = some c → c ≠ '﻿' := by
  cases h with
  | ws w hw => exact ws_noBom hw
  | lineComment w body hw _ =>
    intro c hc
    cases w with
    | nil => simp at hc; subst hc; decide
    | cons d w' => exact ws_noBom hw c (by simpa using hc)

theorem valStart_noBom {c : Char} (h : ValStart c) : c ≠ '﻿' := by
  rcases h with rfl | rfl | rfl | rfl | rfl | h | h
  any_goals decide
  all_goals rintro rfl; simp [isDigit, isUpper] at h

theorem parse_eq (L : Limits) (input t : Text) (h : (match input with
      | '﻿' :: r => r
      | r => r) = t) :
    Parser.parse L input = (do ws; fileLoop L (4 * (t.length + 1)) (4 * (t.length + 1)) []).run' t := by
  subst h
  rfl

/-- **Completeness.** Every file the grammar accepts, the reference parser accepts, with the same values. -/
theorem parse_complete (L : Limits) (input : Text) (vs : List Value) (h : File L input vs) :
    Parser.parse L input = .ok vs := by
  cases h with
  | empty b w hb hw =>
    rw [parse_eq L _ w (stripBom hb (wsEnd_noBom hw)), run'_eq, run_bind, wsEnd_complete hw]
    rw [show 4 * (w.length + 1) = (4 * w.length + 3) + 1 by omega]
    simp only [fileLoop_nil]
    rfl
  | values b w t xs hb hw hfi =>
    obtain ⟨c, t', rfl, hcs⟩ := fileItems_head hfi
    have hnb : ∀ d, (w ++ c :: t').head? = some d → d ≠ '﻿' := by
      intro d hd
      cases w with
      | nil => simp at hd; subst hd; exact valStart_noBom hcs
      | cons e w' => exact ws_noBom hw d (by simpa using hd)
    rw [List.append_assoc, parse_eq L _ _ (stripBom hb hnb)]
    have hws := ws_complete hw (valStart_wsFollow hcs t')
    have hfl := hfi.complete (4 * ((w ++ c :: t').length + 1)) (4 * ((w ++ c :: t').length + 1)) []
      (by simp; omega) (by simp; omega)
    rw [run'_eq, run_bind, hws]
    simp only [hfl]
    rfl
