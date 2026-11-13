import Haus.Complete.Whitespace
import Haus.Sound.BlockString

/-!
# Completeness of byte strings and block strings

A block string is found by its closing `"""` (`findClose`), split into lines
at line feeds, and decoded line by line. The proof follows the same steps
backwards. One condition is not obvious: `findClose` pairs a backslash with
the next character, and treats `"` as a possible start of `"""`. So the
content before the closing quotes must not end with `\` or `"`; it doesn't,
because it ends with a line break or the indent (`blockLines_last`).
-/

namespace Haus.Complete
open Haus Grammar Parser Sound

/-! ## Byte strings -/

theorem byteChars_complete {raw : Text} {bs : List UInt8} (h : ByteChars raw bs) (r : Text) :
    byteChars (raw ++ '"' :: r) = .ok (bs, r) := by
  induction h with
  | nil => simp [byteChars]
  | blank c raw bs hc _ ih =>
    have hq : c ≠ '"' := by rintro rfl; simp [isBlank] at hc
    rw [List.cons_append, byteChars.eq_def]
    split
    · rename_i heq; exact absurd (List.cons.inj heq).1 hq
    · rename_i heq; obtain ⟨rfl, rfl⟩ := List.cons.inj heq; simp [hc, ih]
    · rename_i heq; simp at heq
  | byte h l raw bs hh hl _ ih =>
    have hq : h ≠ '"' := by rintro rfl; simp [isHexDigit, isDigit] at hh
    have hb : isBlank h = false := by
      cases hc : isBlank h
      · rfl
      · have := isBlank_iff.mp hc
        rcases this with rfl | rfl <;> simp [isHexDigit, isDigit] at hh
    rw [List.cons_append, byteChars.eq_def]
    split
    · rename_i heq; exact absurd (List.cons.inj heq).1 hq
    · rename_i heq; obtain ⟨rfl, rfl⟩ := List.cons.inj heq; simp [hb, hh, hl, ih, Except.map]
    · rename_i heq; simp at heq

theorem bytes_complete {L : Limits} {raw : Text} {bs : List UInt8} (h : ByteChars raw bs)
    (hlen : raw.length ≤ L.maxStringLength) (r : Text) :
    (bytes L).run (['x', '"'] ++ raw ++ ['"'] ++ r) = .ok (.bytes bs, r) := by
  have hb := byteChars_complete h r
  have e : (raw.length + (r.length + 1) + 1 + 1 - r.length - 3) = raw.length := by omega
  simp only [List.append_assoc, List.cons_append, List.nil_append] at hb ⊢
  simp [bytes, hb, e, Nat.not_lt.mpr hlen]

/-! ## Block strings: the closing quotes -/

theorem findClose_cons {c : Char} {a : Text} (h1 : c ≠ '\\') (h2 : ¬ (c = '"' ∧ a.take 2 = ['"', '"'])) :
    findClose (c :: a) = (findClose a).map fun p => (c :: p.1, p.2) := by
  match a with
  | [] => simp [findClose]
  | [x] =>
    rw [findClose]
    · simp_all
    all_goals intros; simp_all
  | x :: y :: z =>
    rw [findClose]
    · simp_all
    all_goals simp_all

/--
`findClose` stops at the first unescaped `"""`. The text before it must not
end with a backslash or a quote, which would pair with the closing quotes.
-/
theorem findClose_complete (x : Text) (hq : noTripleQuote x = true)
    (hl : ∀ c, x.getLast? = some c → c ≠ '\\' ∧ c ≠ '"') (r : Text) :
    findClose (x ++ ['"', '"', '"'] ++ r) = some (x, r) := by
  fun_induction noTripleQuote x with
  | case1 c rest ih =>
    have ih' := ih hq (by
      intro d hd
      apply hl d
      cases rest with
      | nil => simp at hd
      | cons => simpa [List.getLast?_cons] using hd)
    simp only [List.cons_append, List.append_assoc, List.nil_append] at ih' ⊢
    simp [findClose, ih']
  | case2 => simp at hq
  | case3 c rest hesc htri ih =>
    have hrest : rest ≠ [] → ∀ d, rest.getLast? = some d → d ≠ '\\' ∧ d ≠ '"' := by
      intro hne d hd; apply hl d
      cases rest with
      | nil => exact absurd rfl hne
      | cons => simpa [List.getLast?_cons] using hd
    have ih' := ih (by simpa [noTripleQuote] using hq) (by
      intro d hd
      cases rest with
      | nil => simp at hd
      | cons => exact hrest (by simp) d hd)
    have hc : c ≠ '\\' := by
      rintro rfl
      cases rest with
      | nil => exact (hl '\\' (by simp)).1 rfl
      | cons y z => exact hesc y z rfl rfl
    have htri' : ¬ (c = '"' ∧ (rest ++ ['"', '"', '"'] ++ r).take 2 = ['"', '"']) := by
      rintro ⟨rfl, ht⟩
      match rest, ht with
      | [], _ => exact (hl '"' (by simp)).2 rfl
      | [y], ht =>
        simp at ht; subst ht
        exact (hl '"' (by simp)).2 rfl
      | y :: z :: w, ht =>
        simp at ht; obtain ⟨rfl, rfl⟩ := ht
        exact htri w rfl rfl
    simp only [List.cons_append, List.append_assoc, List.nil_append] at ih' htri' ⊢
    rw [findClose_cons hc htri', ih']
    rfl
  | case4 => simp [findClose]

/-! ## Block strings: lines -/

theorem splitLines_cons {c : Char} (hc : c ≠ '\n') (r : Text) :
    splitLines (c :: r) = match splitLines r with
      | l :: ls => (c :: l) :: ls
      | [] => [[c]] := by
  rw [splitLines]
  all_goals first | rfl | (intro h; exact absurd h hc)

theorem splitLines_single {a : Text} (ha : '\n' ∉ a) : splitLines a = [a] := by
  induction a with
  | nil => rfl
  | cons c r ih =>
    have hc : c ≠ '\n' := by rintro rfl; simp at ha
    rw [splitLines_cons hc, ih (by simp_all)]

theorem splitLines_line {a : Text} (ha : '\n' ∉ a) (b : Text) : splitLines (a ++ '\n' :: b) = a :: splitLines b := by
  induction a with
  | nil => rfl
  | cons c r ih =>
    have hc : c ≠ '\n' := by rintro rfl; simp at ha
    rw [List.cons_append, splitLines_cons hc, ih (by simp_all)]

theorem escape_no_break {e : Text} {c : Char} (h : Escape e c) : ∀ x ∈ e, x ≠ '\n' ∧ x ≠ '\r' := by
  cases h with
  | unicode ds _ _ hhex _ =>
    intro x hx
    simp only [List.mem_append, List.mem_cons, List.mem_nil_iff, or_false] at hx
    rcases hx with ((rfl | rfl | rfl) | hx) | rfl
    all_goals first | decide | skip
    have := hhex x hx
    constructor <;> rintro rfl <;> simp [isHexDigit, isDigit] at this
  | _ => decide

theorem chars_no_break {raw s : Text} (h : Chars BlockChar raw s) : ∀ x ∈ raw, x ≠ '\n' ∧ x ≠ '\r' := by
  induction h with
  | nil => simp
  | char c raw s hc _ ih =>
    intro x hx
    rcases List.mem_cons.mp hx with rfl | hx
    · obtain ⟨-, h1 | h1, -⟩ := hc
      · subst h1; decide
      · constructor <;> rintro rfl <;> simp [isRawControl] at h1
    · exact ih x hx
  | escape e c raw s he _ ih =>
    intro x hx
    rcases List.mem_append.mp hx with hx | hx
    · exact escape_no_break he x hx
    · exact ih x hx

theorem blank_no_break {x : Char} (h : isBlank x = true) : x ≠ '\n' ∧ x ≠ '\r' := by
  constructor <;> rintro rfl <;> simp [isBlank] at h

theorem blockLine_no_break {indent raw s : Text} (h : BlockLine indent raw s) (hi : ∀ c ∈ indent, isBlank c = true) :
    ∀ x ∈ raw, x ≠ '\n' ∧ x ≠ '\r' := by
  cases h with
  | indented raw s hc =>
    intro x hx
    rcases List.mem_append.mp hx with hx | hx
    · exact blank_no_break (hi x hx)
    · exact chars_no_break hc x hx
  | blank raw hb _ => exact fun x hx => blank_no_break (hb x hx)

theorem blockChar_ok (c : Char) (h : BlockChar c) : blockChar c = true ∧ isBidi c = false ∧ c ≠ '\\' := by
  obtain ⟨hb, h1, hbi⟩ := h
  refine ⟨?_, hbi, hb⟩
  rcases h1 with rfl | h1
  · decide
  · simp [blockChar, h1]

/-- A content line, with or without the carriage return of a CRLF. -/
theorem blockLine_complete {indent raw s : Text} (h : BlockLine indent raw s) (hi : ∀ c ∈ indent, isBlank c = true)
    (cr : Text) (hcr : cr = [] ∨ cr = ['\r']) : blockLine indent (raw ++ cr) = .ok s := by
  have hnb := blockLine_no_break h hi
  have hlast : (raw ++ cr).getLast? = some '\r' ↔ cr = ['\r'] := by
    rcases hcr with rfl | rfl
    · simp only [List.append_nil, List.ne_cons_self, iff_false]
      intro hl
      obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hl
      exact (hnb '\r' (by simp)).2 rfl
    · simp
  have hline : (if (raw ++ cr).getLast? == some '\r' then (raw ++ cr).dropLast else raw ++ cr) = raw := by
    rcases hcr with rfl | rfl
    · simp only [List.append_nil] at hlast ⊢; simp [hlast]
    · simp
  unfold blockLine
  simp only [hline]
  cases h with
  | indented raw' s hc =>
    have hch := chars_complete (stop := List.isEmpty) blockChar_ok (fun c x _ => rfl) "block string" raw' hc []
      (by rfl) (raw'.length + 1) [] (by omega)
    simp only [List.append_nil] at hch
    simp [hch]
  | blank raw hb hpre =>
    simp [hpre, List.all_eq_true.mpr hb]

/-- The content lines and the indent after them: split into lines, and each line decoded. -/
theorem blockLines_complete {indent content : Text} {ss : List Text} (h : BlockLines indent content ss)
    (hi : ∀ c ∈ indent, isBlank c = true) (tail : Text) (ht : '\n' ∉ tail) :
    ∃ ls, splitLines (content ++ tail) = ls ++ [tail] ∧ ls.mapM (blockLine indent) = .ok ss := by
  induction h with
  | nil => exact ⟨[], by simpa using splitLines_single ht, rfl⟩
  | line raw nl rest s ss hl hnl _ ih =>
    obtain ⟨ls, hsplit, hm⟩ := ih
    have hnb := blockLine_no_break hl hi
    cases hnl with
    | lf =>
      refine ⟨raw :: ls, ?_, ?_⟩
      · rw [List.append_assoc, List.append_assoc, List.singleton_append,
          splitLines_line (fun h => (hnb '\n' h).1 rfl), hsplit]; rfl
      · have := blockLine_complete hl hi [] (.inl rfl)
        simp only [List.append_nil] at this
        simp [List.mapM_cons, hm, this]
    | crlf =>
      refine ⟨(raw ++ ['\r']) :: ls, ?_, ?_⟩
      · have hn : '\n' ∉ raw ++ ['\r'] := by
          simp only [List.mem_append, List.mem_singleton, not_or]
          exact ⟨fun h => (hnb '\n' h).1 rfl, by decide⟩
        have := splitLines_line hn (rest ++ tail)
        simp only [List.append_assoc, List.cons_append, List.nil_append] at this ⊢
        rw [this, hsplit]
      · simp [List.mapM_cons, hm, blockLine_complete hl hi ['\r'] (.inr rfl)]

theorem blockLines_last {indent content : Text} {ss : List Text} (h : BlockLines indent content ss) :
    content = [] ∨ content.getLast? = some '\n' := by
  induction h with
  | nil => exact .inl rfl
  | line raw nl rest s ss _ hnl _ ih =>
    right
    rcases ih with rfl | ih
    · cases hnl <;> simp
    · simp [List.getLast?_append, ih]

theorem blockBody_complete (L : Limits) (start : Text) {indent content : Text} {ss : List Text}
    (hl : BlockLines indent content ss) (hi : ∀ c ∈ indent, isBlank c = true)
    (hq : noTripleQuote (content ++ indent) = true) (hlen : (blockText ss).length ≤ L.maxStringLength) (r : Text) :
    (blockBody L start).run (content ++ indent ++ ['"', '"', '"'] ++ r) = .ok (blockText ss, r) := by
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
  have hf := findClose_complete _ hq hlast r
  obtain ⟨ls, hsplit, hm⟩ := blockLines_complete hl hi indent
    (fun h => by have := hi '\n' h; simp [isBlank] at this)
  have hall : indent.all isBlank = true := List.all_eq_true.mpr hi
  simp only [blockBody, run_bind, run_get, hf, hsplit, List.getLast?_concat, Option.getD_some, hall,
    Bool.not_true, Bool.false_eq_true, ↓reduceIte, List.dropLast_concat, hm, run_set]
  have hlen' : ¬ (List.intercalate ['\n'] ss).length > L.maxStringLength := by
    simp only [blockText, String.length_ofList] at hlen; omega
  simp only [run_pure, checkLength, hlen', ↓reduceIte]
  rfl

theorem blockString_complete {L : Limits} {t : Text} {s : String} (h : BlockString L t s) (r : Text) :
    (blockString L).run (t ++ r) = .ok (s, r) := by
  cases h with
  | mk sp nl content indent ss hsp hnl hi hl hq hlen =>
    have hb := blockBody_complete L (['"', '"', '"'] ++ sp ++ nl ++ content ++ indent ++ ['"', '"', '"'] ++ r)
      hl hi hq hlen r
    obtain ⟨ht, hd⟩ := takeWhile_append hsp (x := nl ++ content ++ indent ++ ['"', '"', '"'] ++ r)
      (by cases hnl <;> simp [isBlank])
    simp only [blockString, run_bind, run_get, run_skip, run_takeWhile]
    cases hnl <;> simp only [List.append_assoc, List.cons_append, List.nil_append] at ht hd hb ⊢ <;> simp [hd, hb]
