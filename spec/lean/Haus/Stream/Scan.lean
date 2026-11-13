import Haus.Stream.Chunks
import Haus.Complete.Values

/-!
# The scanner on valid text

`Thru s t s' rest`: scanning `t`, followed by `rest`, goes from state `s` to
`s'` without finding a top-level comma. For every part of the grammar, this
file shows where the scanner ends up:

* whitespace and comments, values, records and arrays start and end in the
  normal mode at the same depth;
* inside brackets the depth is at least one, so commas there don't cut;
* strings, block strings and comments are skipped as a whole, so the commas
  and brackets in them don't count.

The scanner looks ahead at most two characters. Inside a construct that is
always within the construct, except at an empty string `""` or `x""`, which
must not be followed by `"` (`NoQuote`). Nothing that may follow a value in
the grammar starts with `"`.
-/

namespace Haus.Stream
open Haus Grammar Complete Parser

/-- Scanning `t`, followed by `rest`, goes from state `s` to `s'` without finding a top-level comma. -/
structure Thru (s : St) (t : Text) (s' : St) (rest : Text) : Prop where
  run : ∀ cur, scan true s cur (t ++ rest) = scan true s' (cur ++ t) rest

theorem Thru.nil (s : St) (rest : Text) : Thru s [] s rest := ⟨by intro cur; simp⟩

theorem Thru.trans {s s₁ s₂ : St} {a b rest : Text} (h₁ : Thru s a s₁ (b ++ rest)) (h₂ : Thru s₁ b s₂ rest) :
    Thru s (a ++ b) s₂ rest := ⟨by intro cur; rw [List.append_assoc, h₁.run, h₂.run, List.append_assoc]⟩

/-- `a` then `b`, with the texts matched up by `simp`. -/
theorem Thru.seq {s s₁ s₂ : St} {a b m rest : Text} (h₁ : Thru s a s₁ m) (h₂ : Thru s₁ b s₂ rest)
    (hm : m = b ++ rest := by simp) : Thru s (a ++ b) s₂ rest := by
  subst hm; exact h₁.trans h₂

/-- The same text, written differently. -/
theorem Thru.conv {s s' : St} {t t' rest : Text} (h : Thru s t s' rest) (e : t = t' := by simp) : Thru s t' s' rest :=
  e ▸ h

theorem Thru.of_eq {s s' : St} {t t' rest : Text} (h : t = t') (h' : Thru s t s' rest) : Thru s t' s' rest :=
  h ▸ h'

/-- One step of the scanner. -/
theorem thru_step {s s' : St} {t rest : Text} {k : Nat} (hk : t.length = k + 1)
    (h : step true s (t ++ rest) = .adv k s') : Thru s t s' rest := by
  constructor; intro cur
  match t, hk with
  | c :: t', hk =>
    simp only [List.length_cons, Nat.add_right_cancel_iff] at hk
    simp only [List.cons_append] at h ⊢
    rw [scan, h]
    simp only [List.take_left' hk, List.drop_left' hk]

/-- A character followed by more text. -/
theorem Thru.cons {s s₁ s₂ : St} {c : Char} {t rest : Text} (h₁ : Thru s [c] s₁ (t ++ rest)) (h₂ : Thru s₁ t s₂ rest) :
    Thru s (c :: t) s₂ rest :=
  h₁.trans h₂

/-! ## Characters in the normal mode -/

/-- Characters the scanner passes over in the normal mode. -/
def Quiet (c : Char) : Prop :=
  c ≠ '/' ∧ c ≠ '"' ∧ c ≠ '{' ∧ c ≠ '[' ∧ c ≠ '(' ∧ c ≠ '}' ∧ c ≠ ']' ∧ c ≠ ')' ∧ c ≠ ','

theorem thru_quiet1 {c : Char} (hc : Quiet c) (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ [c] ⟨.normal, d⟩ rest := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7, h8, h9⟩ := hc
  exact thru_step (k := 0) rfl (by simp [step, h1, h2, h3, h4, h5, h6, h7, h8, h9])

theorem thru_quiet {t : Text} (h : ∀ c ∈ t, Quiet c) (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest := by
  induction t with
  | nil => exact Thru.nil _ _
  | cons c t ih =>
    exact (thru_quiet1 (h c (by simp)) d _).cons (ih (fun x hx => h x (by simp [hx])))

theorem identChar_quiet {c : Char} (h : isIdentChar c = true) : Quiet c := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> (rintro rfl; revert h; decide)

theorem blank_quiet {c : Char} (h : isBlank c = true) : Quiet c := by
  rcases isBlank_iff.mp h with rfl | rfl <;> refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide

theorem thru_open {c : Char} (hc : c = '{' ∨ c = '[' ∨ c = '(') (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ [c] ⟨.normal, d + 1⟩ rest := by
  refine thru_step (k := 0) rfl ?_
  rcases hc with rfl | rfl | rfl <;> simp [step]

theorem thru_close {c : Char} (hc : c = '}' ∨ c = ']' ∨ c = ')') (d : Nat) (rest : Text) :
    Thru ⟨.normal, d + 1⟩ [c] ⟨.normal, d⟩ rest := by
  refine thru_step (k := 0) rfl ?_
  rcases hc with rfl | rfl | rfl <;> simp [step]

/-- Inside brackets, a comma doesn't separate top-level values. -/
theorem thru_comma (d : Nat) (rest : Text) : Thru ⟨.normal, d + 1⟩ [','] ⟨.normal, d + 1⟩ rest :=
  thru_step (k := 0) rfl (by simp [step])

/-! ## Whitespace and comments -/

theorem thru_line {t : Text} (h : ∀ c ∈ t, c ≠ '\n') (d : Nat) (rest : Text) :
    Thru ⟨.line, d⟩ t ⟨.line, d⟩ rest := by
  induction t with
  | nil => exact Thru.nil _ _
  | cons c t ih =>
    have hc := h c (by simp)
    exact (thru_step (k := 0) rfl (by simp [step, hc])).cons (ih (fun x hx => h x (by simp [hx])))

theorem lineBody_no_lf {body : Text} (h : LineBody body) : ∀ c ∈ body, c ≠ '\n' := by
  intro c hc; rintro rfl
  have := (h _ hc).1
  rcases this with h1 | h1 <;> revert h1 <;> decide

/-- `//`: into the line mode. -/
theorem thru_slashes (d : Nat) (rest : Text) : Thru ⟨.normal, d⟩ ['/', '/'] ⟨.line, d⟩ rest :=
  thru_step (k := 1) rfl (by simp [step])

/-- A line break ends a line comment. -/
theorem thru_newline_line {nl : Text} (h : Newline nl) (d : Nat) (rest : Text) :
    Thru ⟨.line, d⟩ nl ⟨.normal, d⟩ rest := by
  cases h with
  | lf => exact thru_step (k := 0) rfl (by simp [step])
  | crlf =>
    exact (thru_step (s' := ⟨.line, d⟩) (k := 0) rfl (by simp [step])).cons (thru_step (k := 0) rfl (by simp [step]))

mutual
/-- A nested block comment inside a comment `k + 1` levels deep. -/
theorem _root_.Haus.Grammar.BlockComment.thru {c : Text} : BlockComment c →
    ∀ k d rest, Thru ⟨.comment (k + 1), d⟩ c ⟨.comment (k + 1), d⟩ rest
  | .mk body hb, k, d, rest => by
    have h₁ : Thru ⟨.comment (k + 1), d⟩ ['/', '*'] ⟨.comment (k + 2), d⟩ (body ++ ['*', '/'] ++ rest) :=
      thru_step (k := 1) rfl (by simp [step])
    have h₂ := hb.thru (k + 1) d (['*', '/'] ++ rest) (by simp)
    have h₃ : Thru ⟨.comment (k + 2), d⟩ ['*', '/'] ⟨.comment (k + 1), d⟩ rest :=
      thru_step (k := 1) rfl (by simp [step])
    exact (h₁.trans (h₂.trans h₃)).of_eq (by simp)

/-- A comment body, followed by `*`: the closing `*/`. -/
theorem _root_.Haus.Grammar.CommentBody.thru {body : Text} : CommentBody body →
    ∀ k d rest, rest.head? = some '*' → Thru ⟨.comment (k + 1), d⟩ body ⟨.comment (k + 1), d⟩ rest
  | .nil, _, _, _, _ => Thru.nil _ _
  | .char c rb _ hstar hslash hr, k, d, rest, hrest => by
    have ih := hr.thru k d rest hrest
    refine Thru.cons (thru_step (k := 0) rfl ?_) ih
    by_cases h1 : c = '/'
    · subst h1; simp [step]; exact ⟨(hslash rfl).1, fun h => absurd h (hslash rfl).2⟩
    · by_cases h2 : c = '*'
      · subst h2; simp [step]; exact ⟨hstar rfl, fun _ => by simp [hrest]⟩
      · simp [step, h1, h2]
  | .nested inner rb hi hr, k, d, rest, hrest => by
    exact (hi.thru k d (rb ++ rest)).trans (hr.thru k d rest hrest)
end

/-- A block comment in the normal mode. -/
theorem blockComment_thru {c : Text} (h : BlockComment c) (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ c ⟨.normal, d⟩ rest := by
  cases h with
  | mk body hb =>
    have h₁ : Thru ⟨.normal, d⟩ ['/', '*'] ⟨.comment 1, d⟩ (body ++ ['*', '/'] ++ rest) :=
      thru_step (k := 1) rfl (by simp [step])
    have h₂ := hb.thru 0 d (['*', '/'] ++ rest) (by simp)
    have h₃ : Thru ⟨.comment 1, d⟩ ['*', '/'] ⟨.normal, d⟩ rest :=
      thru_step (k := 1) rfl (by simp [step])
    exact (h₁.trans (h₂.trans h₃)).of_eq (by simp)

theorem ws_thru {w : Text} (h : WS w) (d : Nat) (rest : Text) : Thru ⟨.normal, d⟩ w ⟨.normal, d⟩ rest := by
  induction h with
  | nil => exact Thru.nil _ _
  | blank c r hc _ ih => exact (thru_quiet1 (blank_quiet hc) d _).cons ih
  | newline nl r hnl _ ih =>
    refine Thru.trans (thru_quiet (fun c hc => ?_) d _) ih
    cases hnl <;> simp at hc <;> rcases hc with rfl | rfl <;> refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide
  | lineComment body nl r hb hnl _ ih =>
    have := (thru_slashes d _).trans ((thru_line (lineBody_no_lf hb) d _).trans
      ((thru_newline_line hnl d _).trans ih))
    exact this.of_eq (by simp)
  | blockComment c r hc _ ih => exact (blockComment_thru hc d _).trans ih

/-- Whitespace at the end ends in the normal mode, or in a line comment. -/
theorem wsEnd_thru {w : Text} (h : WSEnd w) (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ w ⟨.normal, d⟩ rest ∨ Thru ⟨.normal, d⟩ w ⟨.line, d⟩ rest := by
  cases h with
  | ws w hw => exact .inl (ws_thru hw d rest)
  | lineComment w body hw hb =>
    exact .inr (((ws_thru hw d _).trans ((thru_slashes d _).trans (thru_line (lineBody_no_lf hb) d _))).of_eq
      (by simp))

/-! ## Strings -/

/-- Characters the scanner passes over in a string. -/
def StrQuiet (c : Char) : Prop := c ≠ '\\' ∧ c ≠ '"' ∧ c ≠ '\n'

theorem thru_strQuiet {t : Text} (h : ∀ c ∈ t, StrQuiet c) (m : Mode) (hm : m = .string) (d : Nat) (rest : Text) :
    Thru ⟨m, d⟩ t ⟨m, d⟩ rest := by
  subst hm
  induction t with
  | nil => exact Thru.nil _ _
  | cons c t ih =>
    obtain ⟨h1, h2, h3⟩ := h c (by simp)
    exact (thru_step (k := 0) rfl (by simp [step, h1, h2, h3])).cons (ih (fun x hx => h x (by simp [hx])))

theorem hexDigit_strQuiet {c : Char} (h : isHexDigit c = true) : StrQuiet c := by
  refine ⟨?_, ?_, ?_⟩ <;> (rintro rfl; revert h; decide)

theorem escape_shape {e : Text} {c : Char} (h : Escape e c) :
    ∃ x t, e = '\\' :: x :: t ∧ ∀ y ∈ t, StrQuiet y := by
  cases h with
  | quote => exact ⟨_, [], rfl, by simp⟩
  | backslash => exact ⟨_, [], rfl, by simp⟩
  | newline => exact ⟨_, [], rfl, by simp⟩
  | cr => exact ⟨_, [], rfl, by simp⟩
  | tab => exact ⟨_, [], rfl, by simp⟩
  | unicode ds _ _ hds _ =>
    refine ⟨'u', '{' :: ds ++ ['}'], by simp, ?_⟩
    intro y hy
    simp at hy
    rcases hy with rfl | hy | rfl
    · exact ⟨by decide, by decide, by decide⟩
    · exact hexDigit_strQuiet (hds y hy)
    · exact ⟨by decide, by decide, by decide⟩

theorem chars_thru {ok : Char → Prop} (hok : ∀ c, ok c → StrQuiet c) {raw s : Text} (h : Chars ok raw s)
    (d : Nat) (rest : Text) : Thru ⟨.string, d⟩ raw ⟨.string, d⟩ rest := by
  induction h with
  | nil => exact Thru.nil _ _
  | char c raw s hc _ ih => exact (thru_strQuiet (fun x hx => by rw [List.mem_singleton.mp hx]; exact hok _ hc) _ rfl d _).cons ih
  | escape e c raw s he _ ih =>
    obtain ⟨x, t, rfl, ht⟩ := escape_shape he
    have h₁ : Thru ⟨.string, d⟩ ['\\', x] ⟨.string, d⟩ (t ++ (raw ++ rest)) :=
      thru_step (k := 1) rfl (by simp [step])
    exact (h₁.seq ((thru_strQuiet ht _ rfl d (raw ++ rest)).seq ih)).conv

theorem basicChar_strQuiet (c : Char) (h : BasicChar c) : StrQuiet c := by
  obtain ⟨h1, h2, h3, -⟩ := h
  exact ⟨h2, h1, by rintro rfl; revert h3; decide⟩

/-- Text that doesn't start with `"`: what follows a value. -/
def NoQuote (r : Text) : Prop := r.head? ≠ some '"'

/-- An opening quote that doesn't start `"""`. -/
theorem thru_open_quote {r : Text} (hr : r.take 2 ≠ ['"', '"']) (d : Nat) :
    Thru ⟨.normal, d⟩ ['"'] ⟨.string, d⟩ r :=
  thru_step (k := 0) rfl (by simp [step, hr])

theorem thru_close_quote (d : Nat) (rest : Text) : Thru ⟨.string, d⟩ ['"'] ⟨.normal, d⟩ rest :=
  thru_step (k := 0) rfl (by simp [step])

/-- The text after an opening quote: its first character isn't a quote, or it is the closing one, not followed by another. -/
theorem take2_ne {raw rest : Text} (hraw : ∀ c, raw.head? = some c → c ≠ '"') (hr : NoQuote rest) :
    (raw ++ '"' :: rest).take 2 ≠ ['"', '"'] := by
  cases raw with
  | nil =>
    cases rest with
    | nil => simp
    | cons d r => simp only [NoQuote, List.head?_cons, ne_eq, Option.some.injEq] at hr; simp [hr]
  | cons c raw => have := hraw c (by simp); simp [this]

theorem basicString_thru {L : Limits} {t : Text} {s : String} (h : BasicString L t s) (d : Nat) {rest : Text}
    (hr : NoQuote rest) : Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest := by
  cases h with
  | mk raw s hc _ =>
    have h₁ := thru_open_quote (take2_ne (chars_basic_head hc) hr) d
    have h₂ := chars_thru basicChar_strQuiet hc d ('"' :: rest)
    exact (h₁.seq (h₂.seq (thru_close_quote d rest))).conv

/-! ## Block strings -/

/-- In a block string the scanner finds the closing quotes where `findClose` does. -/
theorem scan_block (y : Text) : ∀ {a b : Text}, findClose y = some (a, b) → ∀ d cur,
    scan true ⟨.block, d⟩ cur y = scan true ⟨.normal, d⟩ (cur ++ a ++ ['"', '"', '"']) b := by
  fun_induction findClose y with
  | case1 c r ih =>
    intro a b h d cur
    simp only [Option.map_eq_some_iff, Prod.mk.injEq, Prod.exists] at h
    obtain ⟨a', b', h', rfl, rfl⟩ := h
    rw [scan]; simp [step]; rw [ih h' d]; simp
  | case2 r =>
    intro a b h d cur
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    rw [scan]; simp [step]
  | case3 c r h1 h2 ih =>
    intro a b h d cur
    simp only [Option.map_eq_some_iff, Prod.mk.injEq, Prod.exists] at h
    obtain ⟨a', b', h', rfl, rfl⟩ := h
    have hc : c ≠ '\\' := by
      rintro rfl
      cases r with
      | nil => simp [findClose] at h'
      | cons x r => exact h1 x r rfl rfl
    have hq : ¬ (c = '"' ∧ r.take 2 = ['"', '"']) := by
      rintro ⟨rfl, ht⟩
      match r, ht with
      | x :: y :: z, ht => simp at ht; obtain ⟨rfl, rfl⟩ := ht; exact h2 z rfl rfl
    rw [scan]
    by_cases h3 : c = '"'
    · subst h3
      have : r.take 2 ≠ ['"', '"'] := fun h => hq ⟨rfl, h⟩
      simp [step, this]; rw [ih h' d]; simp
    · simp [step, hc, h3]; rw [ih h' d]; simp
  | case4 => intro a b h; simp at h

theorem findClose_prefix {pre : Text} (h : ∀ c ∈ pre, c ≠ '\\' ∧ c ≠ '"') (y : Text) :
    findClose (pre ++ y) = (findClose y).map fun p => (pre ++ p.1, p.2) := by
  induction pre with
  | nil => simp
  | cons c pre ih =>
    obtain ⟨h1, h2⟩ := h c (by simp)
    rw [List.cons_append, findClose_cons h1 (by simp [h2]), ih (fun x hx => h x (by simp [hx]))]
    simp [Option.map_map, Function.comp_def]

theorem blockString_thru {L : Limits} {t : Text} {s : String} (h : BlockString L t s) (d : Nat) (rest : Text) :
    Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest := by
  cases h with
  | mk sp nl content indent ss hsp hnl hi hl hq _ =>
    -- The closing quotes, found as in `blockBody_complete`.
    have hlast : ∀ c, (content ++ indent).getLast? = some c → c ≠ '\\' ∧ c ≠ '"' := by
      intro c hc
      rw [List.getLast?_append] at hc
      cases hil : indent.getLast? with
      | some d =>
        rw [hil] at hc; simp at hc; subst hc
        have := hi d (List.mem_of_getLast? hil)
        constructor <;> rintro rfl <;> simp [isBlank] at this
      | none =>
        rw [hil] at hc; simp at hc
        rcases blockLines_last hl with rfl | h
        · simp at hc
        · rw [h] at hc; simp at hc; subst hc; decide
    have hf := findClose_complete _ hq hlast rest
    have hpre : ∀ c ∈ sp ++ nl, c ≠ '\\' ∧ c ≠ '"' := by
      intro c hc
      simp only [List.mem_append] at hc
      rcases hc with hc | hc
      · have := isBlank_iff.mp (hsp c hc)
        rcases this with rfl | rfl <;> decide
      · cases hnl <;> simp at hc <;> rcases hc with rfl | rfl <;> decide
    have hf' := findClose_prefix hpre (content ++ indent ++ ['"', '"', '"'] ++ rest)
    rw [hf] at hf'
    simp only [Option.map_some] at hf'
    constructor; intro cur
    have hopen : step true ⟨.normal, d⟩ ('"' :: '"' :: '"' :: (sp ++ nl ++ content ++ indent ++ ['"', '"', '"'] ++ rest)) =
        .adv 2 ⟨.block, d⟩ := by simp [step]
    simp only [List.append_assoc, List.cons_append, List.nil_append] at hopen hf' ⊢
    rw [scan, hopen]
    simp only [List.take_add_one, List.take_zero, List.drop_succ_cons, List.drop_zero]
    simp only [Option.toList_some, List.nil_append, List.getElem?_cons_succ, List.getElem?_cons_zero,
      List.singleton_append]
    rw [scan_block _ hf' d]
    simp

/-! ## Byte strings -/

theorem byteChars_mem {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) :
    ∀ c ∈ raw, isBlank c = true ∨ isHexDigit c = true := by
  induction h with
  | nil => simp
  | blank c raw bs hc _ ih => intro x hx; simp at hx; rcases hx with rfl | hx; exact .inl hc; exact ih x hx
  | byte h l raw bs hh hl _ ih =>
    intro x hx; simp at hx
    rcases hx with rfl | rfl | hx
    · exact .inr hh
    · exact .inr hl
    · exact ih x hx

theorem byte_strQuiet {c : Char} (h : isBlank c = true ∨ isHexDigit c = true) : StrQuiet c := by
  rcases h with h | h
  · rcases isBlank_iff.mp h with rfl | rfl <;> exact ⟨by decide, by decide, by decide⟩
  · exact hexDigit_strQuiet h

theorem bytes_thru {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) (d : Nat) {rest : Text}
    (hr : NoQuote rest) : Thru ⟨.normal, d⟩ (['x', '"'] ++ raw ++ ['"']) ⟨.normal, d⟩ rest := by
  have hm := byteChars_mem h
  have hraw : ∀ c, raw.head? = some c → c ≠ '"' := by
    intro c hc; rintro rfl
    rcases hm '"' (List.mem_of_head? hc) with h | h <;> revert h <;> decide
  have h₀ := thru_quiet1 (c := 'x') (by refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide) d
    ('"' :: raw ++ '"' :: rest)
  have h₁ := thru_open_quote (take2_ne hraw hr) d
  have h₂ := thru_strQuiet (fun c hc => byte_strQuiet (hm c hc)) _ rfl d ('"' :: rest)
  exact (h₀.seq (h₁.seq (h₂.seq (thru_close_quote d rest)))).conv

/-! ## Numbers, tags and keys -/

theorem numChar_quiet {c : Char} (h : isIdentChar c = true ∨ c = '-' ∨ c = '+' ∨ c = '.') : Quiet c := by
  rcases h with h | rfl | rfl | rfl
  · exact identChar_quiet h
  all_goals refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide

theorem sepTail_ident {p : Char → Bool} (hp : ∀ c, p c = true → isIdentChar c = true) {t : Text}
    (h : SepTail p t) : ∀ c ∈ t, isIdentChar c = true := by
  induction h with
  | nil => simp
  | digit c r hc _ ih => intro x hx; simp at hx; rcases hx with rfl | hx; exact hp _ hc; exact ih x hx
  | sep c r hc _ ih =>
    intro x hx; simp at hx
    rcases hx with rfl | rfl | hx
    · decide
    · exact hp _ hc
    · exact ih x hx

theorem digits_ident {p : Char → Bool} (hp : ∀ c, p c = true → isIdentChar c = true) {t : Text}
    (h : Digits p t) : ∀ c ∈ t, isIdentChar c = true := by
  obtain ⟨c, r, rfl, hc, hr⟩ := h
  intro x hx; simp at hx
  rcases hx with rfl | hx
  · exact hp _ hc
  · exact sepTail_ident hp hr x hx

theorem number_quiet {L : Limits} {t : Text} (h : NumberLit L t) : ∀ c ∈ t, Quiet c := by
  have hd : ∀ c, isDigit c = true → isIdentChar c = true := fun _ => isDigit_ident
  intro c hc
  apply numChar_quiet
  have hsign : ∀ {s : Text}, Sign s → c ∈ s → c = '-' := by
    intro s hs hc; rcases hs with rfl | rfl <;> simp_all
  cases h with
  | decimal s i f e hs hi hf he =>
    simp only [List.mem_append] at hc
    rcases hc with ((hc | hc) | hc) | hc
    · exact .inr (.inl (hsign hs hc))
    · left
      cases hi with
      | zero => simp at hc; subst hc; decide
      | nonzero c' r hc' _ hr =>
        simp at hc; rcases hc with rfl | hc
        · exact isDigit_ident hc'
        · exact sepTail_ident hd hr c hc
    · rcases hf with rfl | ⟨ds, rfl, hds⟩
      · simp at hc
      · simp at hc; rcases hc with rfl | hc
        · exact .inr (.inr (.inr rfl))
        · exact .inl (digits_ident hd hds c hc)
    · rcases he with rfl | ⟨m, s', ds, rfl, hm, hs', hds⟩
      · simp at hc
      · simp at hc
        rcases hc with rfl | hc | hc
        · left; rcases hm with rfl | rfl <;> decide
        · rcases hs' with rfl | rfl | rfl <;> simp_all
        · exact .inl (digits_ident hd hds c hc)
  | hex s ds hs hds =>
    simp at hc
    rcases hc with hc | rfl | rfl | hc
    · exact .inr (.inl (hsign hs hc))
    · left; decide
    · left; decide
    · exact .inl (digits_ident (fun _ => isHexDigit_ident) hds c hc)
  | binary s ds hs hds =>
    simp at hc
    rcases hc with hc | rfl | rfl | hc
    · exact .inr (.inl (hsign hs hc))
    · left; decide
    · left; decide
    · exact .inl (digits_ident (fun _ => isBinDigit_ident) hds c hc)

theorem tag_quiet {t : Text} (h : Tag t) : ∀ c ∈ t, Quiet c := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  intro x hx; simp at hx
  rcases hx with rfl | hx
  · exact identChar_quiet (by simp [isIdentChar, hc])
  · exact identChar_quiet (hcs x hx)

theorem key_thru {L : Limits} {k : Text} {key : String} (h : Key L k key) (d : Nat) {rest : Text}
    (hr : NoQuote rest) : Thru ⟨.normal, d⟩ k ⟨.normal, d⟩ rest := by
  cases h with
  | ident ht =>
    obtain ⟨c, cs, rfl, hc, hcs⟩ := ht
    refine thru_quiet (fun x hx => ?_) d rest
    simp at hx
    rcases hx with rfl | hx
    · exact identChar_quiet (by simp [isIdentChar, hc])
    · exact identChar_quiet (hcs x hx)
  | quoted s hs => exact basicString_thru hs d hr

/-! ## Values -/

theorem ws_noQuote {w r : Text} (hw : WS w) (hr : NoQuote r) : NoQuote (w ++ r) := by
  cases w with
  | nil => simpa using hr
  | cons c w =>
    have := ws_head hw c (by simp)
    simp only [NoQuote, List.cons_append, List.head?_cons, ne_eq, Option.some.injEq]
    rintro rfl; rcases this with h | h | h | h | h <;> revert h <;> decide

theorem noQuote_cons {c : Char} (hc : c ≠ '"') (r : Text) : NoQuote (c :: r) := by
  simp [NoQuote, hc]

theorem blanks_quiet {sp : Text} (h : ∀ c ∈ sp, isBlank c = true) : ∀ c ∈ sp, Quiet c :=
  fun c hc => blank_quiet (h c hc)

mutual
theorem _root_.Haus.Grammar.Val.thru {L : Limits} {n : Nat} {t : Text} {x : Value} : Val L n t x →
    ∀ d rest, NoQuote rest → Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest
  | .number _ _ hn, d, rest, _ => thru_quiet (number_quiet hn) d rest
  | .string _ _ _ hs, d, _, hr => basicString_thru hs d hr
  | .blockString _ _ _ hs, d, rest, _ => blockString_thru hs d rest
  | .bytes _ _ _ hb _, d, _, hr => bytes_thru hb d hr
  | .array _ inner _ hi, d, rest, hr =>
    ((thru_open (c := '[') (by simp) d (inner ++ ']' :: rest)).seq
      ((hi.thru d (']' :: rest) (noQuote_cons (c := ']') (by decide) _)).seq (thru_close (c := ']') (by simp) d rest))).conv
  | .record _ _ _ hrec, d, rest, hr => hrec.thru d rest hr
  | .tag _ _ ht, d, rest, _ => thru_quiet (tag_quiet ht) d rest
  | .payload _ t sp inner _ ht hsp hi _, d, rest, hr =>
    ((thru_quiet (tag_quiet ht) d (sp ++ '(' :: inner ++ ')' :: rest)).seq
      ((thru_quiet (blanks_quiet hsp) d ('(' :: inner ++ ')' :: rest)).seq
      ((thru_open (c := '(') (by simp) d (inner ++ ')' :: rest)).seq
      ((hi.thru d (')' :: rest) (noQuote_cons (c := ')') (by decide) _)).seq (thru_close (c := ')') (by simp) d rest))))).conv
  | .recordPayload _ t sp r _ ht hsp hrec, d, rest, hr =>
    ((thru_quiet (tag_quiet ht) d (sp ++ r ++ rest)).seq
      ((thru_quiet (blanks_quiet hsp) d (r ++ rest)).seq (hrec.thru d rest hr))).conv

theorem _root_.Haus.Grammar.Items.thru {L : Limits} {n : Nat} {t : Text} {xs : List Value} : Items L n t xs →
    ∀ d rest, NoQuote rest → Thru ⟨.normal, d + 1⟩ t ⟨.normal, d + 1⟩ rest
  | .empty _ w hw, d, rest, _ => ws_thru hw (d + 1) rest
  | .some _ w t _ hw hif, d, rest, hr => (ws_thru hw (d + 1) (t ++ rest)).seq (hif.thru d rest hr)

theorem _root_.Haus.Grammar.ItemsFrom.thru {L : Limits} {n : Nat} {t : Text} {xs : List Value} : ItemsFrom L n t xs →
    ∀ d rest, NoQuote rest → Thru ⟨.normal, d + 1⟩ t ⟨.normal, d + 1⟩ rest
  | .last _ v w _ hv hw, d, rest, hr =>
    ((hv.thru (d + 1) (w ++ rest) (ws_noQuote hw hr)).seq (ws_thru hw (d + 1) rest)).conv
  | .lastComma _ v w w' _ hv hw hw', d, rest, hr =>
    ((hv.thru (d + 1) (w ++ ',' :: (w' ++ rest)) (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).seq
      ((ws_thru hw (d + 1) (',' :: (w' ++ rest))).seq ((thru_comma d (w' ++ rest)).seq (ws_thru hw' (d + 1) rest)))).conv
  | .cons _ v w w' t _ _ hv hw hw' hif, d, rest, hr =>
    ((hv.thru (d + 1) (w ++ ',' :: (w' ++ t ++ rest)) (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).seq
      ((ws_thru hw (d + 1) (',' :: (w' ++ t ++ rest))).seq ((thru_comma d (w' ++ t ++ rest)).seq
      ((ws_thru hw' (d + 1) (t ++ rest)).seq (hif.thru d rest hr))))).conv

theorem _root_.Haus.Grammar.Record.thru {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Record L n t fs → ∀ d rest, NoQuote rest → Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest
  | .mk _ inner _ hf _, d, rest, _ =>
    ((thru_open (c := '{') (by simp) d (inner ++ '}' :: rest)).seq
      ((hf.thru d ('}' :: rest) (noQuote_cons (c := '}') (by decide) _)).seq (thru_close (c := '}') (by simp) d rest))).conv

theorem _root_.Haus.Grammar.Fields.thru {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    Fields L n t fs → ∀ d rest, NoQuote rest → Thru ⟨.normal, d + 1⟩ t ⟨.normal, d + 1⟩ rest
  | .empty _ w hw, d, rest, _ => ws_thru hw (d + 1) rest
  | .some _ w t _ hw hff, d, rest, hr => (ws_thru hw (d + 1) (t ++ rest)).seq (hff.thru d rest hr)

theorem _root_.Haus.Grammar.FieldsFrom.thru {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → ∀ d rest, NoQuote rest → Thru ⟨.normal, d + 1⟩ t ⟨.normal, d + 1⟩ rest
  | .last _ f w _ hf hw, d, rest, hr =>
    ((hf.thru (d + 1) (w ++ rest) (ws_noQuote hw hr)).seq (ws_thru hw (d + 1) rest)).conv
  | .lastComma _ f w w' _ hf hw hw', d, rest, hr =>
    ((hf.thru (d + 1) (w ++ ',' :: (w' ++ rest)) (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).seq
      ((ws_thru hw (d + 1) (',' :: (w' ++ rest))).seq ((thru_comma d (w' ++ rest)).seq (ws_thru hw' (d + 1) rest)))).conv
  | .cons _ f w w' t _ _ hf hw hw' hff, d, rest, hr =>
    ((hf.thru (d + 1) (w ++ ',' :: (w' ++ t ++ rest)) (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).seq
      ((ws_thru hw (d + 1) (',' :: (w' ++ t ++ rest))).seq ((thru_comma d (w' ++ t ++ rest)).seq
      ((ws_thru hw' (d + 1) (t ++ rest)).seq (hff.thru d rest hr))))).conv

theorem _root_.Haus.Grammar.Field.thru {L : Limits} {n : Nat} {t : Text} {kv : String × Value} :
    Field L n t kv → ∀ d rest, NoQuote rest → Thru ⟨.normal, d⟩ t ⟨.normal, d⟩ rest
  | .mk _ k w w' v _ _ hk hw hw' hv, d, rest, hr =>
    ((key_thru hk d (rest := w ++ ':' :: (w' ++ v ++ rest)) (ws_noQuote hw (noQuote_cons (c := ':') (by decide) _))).seq
      ((ws_thru hw d (':' :: (w' ++ v ++ rest))).seq
      ((thru_quiet1 (c := ':') (by refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide) d (w' ++ v ++ rest)).seq
      ((ws_thru hw' d (v ++ rest)).seq (hv.thru d rest hr))))).conv
end

end Haus.Stream
