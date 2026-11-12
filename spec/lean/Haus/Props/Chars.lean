import Haus.Grammar

/-!
# A1 and A2: what characters a valid file can contain

Every character of a valid haus file is *safe*:

* **A1.** It is not a raw bidi control (U+202A–U+202E, U+2066–U+2069), so text
  can't display in a different order from what it is ("Trojan Source").
* **A2.** If it is a control character (C0, DEL, C1), it is a tab, a line feed
  or a carriage return, so a file can't rewrite what a terminal shows (ESC,
  CSI) or truncate text (NUL).

Text that needs such characters writes them as escapes (`\u{202E}`, `\u{1B}`).
The proof goes through the grammar rule by rule.
-/

namespace Haus.Grammar
open Haus

/-- A character that may appear raw in a valid file. -/
def Safe (c : Char) : Prop :=
  isBidi c = false ∧ (isRawControl c = true → c = '\t' ∨ c = '\n' ∨ c = '\r')

instance : DecidablePred Safe := fun c =>
  inferInstanceAs (Decidable (isBidi c = false ∧ (isRawControl c = true → c = '\t' ∨ c = '\n' ∨ c = '\r')))

/-- Every character of `t` is safe. -/
def SafeText (t : Text) : Prop := ∀ c ∈ t, Safe c

instance : DecidablePred SafeText := fun t => inferInstanceAs (Decidable (∀ c ∈ t, Safe c))

namespace SafeText

theorem nil : SafeText [] := by simp [SafeText]

theorem cons {c : Char} {t : Text} (hc : Safe c) (ht : SafeText t) : SafeText (c :: t) := by
  intro x hx
  rcases List.mem_cons.mp hx with rfl | hx
  · exact hc
  · exact ht x hx

theorem append {a b : Text} (ha : SafeText a) (hb : SafeText b) : SafeText (a ++ b) := by
  intro x hx
  rcases List.mem_append.mp hx with hx | hx
  · exact ha x hx
  · exact hb x hx

theorem of_all {p : Char → Bool} {t : Text} (hp : ∀ c, p c = true → Safe c)
    (h : ∀ c ∈ t, p c = true) : SafeText t :=
  fun c hc => hp c (h c hc)

end SafeText

theorem le_toNat {c d : Char} : c ≤ d ↔ c.toNat ≤ d.toNat := .rfl

/-- Printable ASCII is safe. -/
theorem safe_of_printable {c : Char} (h1 : 0x20 ≤ c.toNat) (h2 : c.toNat < 0x7F) : Safe c := by
  refine ⟨?_, fun h => ?_⟩
  · simp only [isBidi]
    have : ¬ (0x202A ≤ c.toNat) := by omega
    have : ¬ (0x2066 ≤ c.toNat) := by omega
    simp [*]
  · simp only [isRawControl, Bool.or_eq_true, decide_eq_true_eq, Bool.and_eq_true] at h
    omega

theorem safe_digit {c : Char} (h : isDigit c = true) : Safe c := by
  simp only [isDigit, Bool.and_eq_true, decide_eq_true_eq, le_toNat] at h
  simp at h
  exact safe_of_printable (by omega) (by omega)

theorem safe_hex {c : Char} (h : isHexDigit c = true) : Safe c := by
  simp only [isHexDigit, isDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, le_toNat] at h
  simp at h
  exact safe_of_printable (by omega) (by omega)

theorem safe_bin {c : Char} (h : isBinDigit c = true) : Safe c := by
  simp [isBinDigit] at h
  rcases h with rfl | rfl <;> decide

theorem safe_ident {c : Char} (h : isIdentChar c = true) : Safe c := by
  simp only [isIdentChar, isUpper, isLowerStart, isDigit, Bool.or_eq_true, Bool.and_eq_true,
    decide_eq_true_eq, le_toNat, beq_iff_eq] at h
  rcases h with (h | h) | h
  · simp at h; exact safe_of_printable (by omega) (by omega)
  · rcases h with h | rfl
    · simp at h; exact safe_of_printable (by omega) (by omega)
    · decide
  · simp at h; exact safe_of_printable (by omega) (by omega)

theorem safe_blank {c : Char} (h : isBlank c = true) : Safe c := by
  simp [isBlank] at h
  rcases h with rfl | rfl <;> decide

theorem TextChar.safe {c : Char} (h : TextChar c) : Safe c := by
  obtain ⟨h1 | h1, h2⟩ := h
  · subst h1; decide
  · exact ⟨h2, fun h => by simp_all⟩

/-! ## Each grammar rule -/

theorem SepTail.safe {p : Char → Bool} (hp : ∀ c, p c = true → Safe c) {t : Text}
    (h : SepTail p t) : SafeText t := by
  induction h with
  | nil => exact .nil
  | digit c _ hc _ ih => exact .cons (hp c hc) ih
  | sep c _ hc _ ih => exact .cons (by decide) (.cons (hp c hc) ih)

theorem Digits.safe {p : Char → Bool} (hp : ∀ c, p c = true → Safe c) {t : Text}
    (h : Digits p t) : SafeText t := by
  obtain ⟨c, r, rfl, hc, hr⟩ := h
  exact .cons (hp c hc) (hr.safe hp)

theorem Sign.safe {s : Text} (h : Sign s) : SafeText s := by
  rcases h with rfl | rfl <;> decide

theorem NumberLit.safe {L : Limits} {t : Text} (h : NumberLit L t) : SafeText t := by
  cases h with
  | decimal s i f e hs hi hf he =>
    refine .append (.append (.append hs.safe ?_) ?_) ?_
    · cases hi with
      | zero => decide
      | nonzero c r hc _ hr => exact .cons (safe_digit hc) (hr.safe fun _ => safe_digit)
    · rcases hf with rfl | ⟨ds, rfl, hds⟩
      · exact .nil
      · exact .cons (by decide) (hds.safe fun _ => safe_digit)
    · rcases he with rfl | ⟨m, sg, ds, rfl, hm, hsg, hds⟩
      · exact .nil
      · refine .cons (by rcases hm with rfl | rfl <;> decide) (.append ?_ (hds.safe fun _ => safe_digit))
        rcases hsg with rfl | rfl | rfl <;> decide
  | hex s ds hs hd => exact .append hs.safe (.cons (by decide) (.cons (by decide) (hd.safe fun _ => safe_hex)))
  | binary s ds hs hd => exact .append hs.safe (.cons (by decide) (.cons (by decide) (hd.safe fun _ => safe_bin)))

theorem Escape.safe {e : Text} {c : Char} (h : Escape e c) : SafeText e := by
  cases h with
  | unicode ds _ _ hds _ =>
    exact .append (.append (by decide) (SafeText.of_all (fun _ => safe_hex) hds)) (by decide)
  | _ => decide

theorem Chars.safe {ok : Char → Prop} (hok : ∀ c, ok c → Safe c) {raw s : Text}
    (h : Chars ok raw s) : SafeText raw := by
  induction h with
  | nil => exact .nil
  | char c _ _ hc _ ih => exact .cons (hok c hc) ih
  | escape _ _ _ _ he _ ih => exact .append he.safe ih

theorem BasicString.safe {L : Limits} {t : Text} {s : String} (h : BasicString L t s) : SafeText t := by
  cases h with
  | mk raw _ hc _ => exact .cons (by decide) (.append (hc.safe fun _ h => ⟨h.2.2.2, fun h' => absurd h' (by simp [h.2.2.1])⟩) (by decide))

theorem Newline.safe {t : Text} (h : Newline t) : SafeText t := by
  cases h <;> decide

theorem blanks_safe {t : Text} (h : ∀ c ∈ t, isBlank c = true) : SafeText t :=
  SafeText.of_all (fun _ => safe_blank) h

theorem BlockLine.safe {indent raw s : Text} (hi : ∀ c ∈ indent, isBlank c = true)
    (h : BlockLine indent raw s) : SafeText raw := by
  cases h with
  | indented raw' _ hc => exact .append (blanks_safe hi) (hc.safe fun _ h => h.2.safe)
  | blank _ hb _ => exact blanks_safe hb

theorem BlockLines.safe {indent t : Text} {ss : List Text} (hi : ∀ c ∈ indent, isBlank c = true)
    (h : BlockLines indent t ss) : SafeText t := by
  induction h with
  | nil => exact .nil
  | line _ _ _ _ _ hl hn _ ih => exact .append (.append (hl.safe hi) hn.safe) ih

theorem BlockString.safe {L : Limits} {t : Text} {s : String} (h : BlockString L t s) : SafeText t := by
  cases h with
  | mk sp nl content indent ss hsp hnl hi hl _ _ =>
    exact .append (.append (.append (.append (.append (by decide) (blanks_safe hsp)) hnl.safe)
      (hl.safe hi)) (blanks_safe hi)) (by decide)

theorem ByteChars.safe {t : Text} {bs : List UInt8} (h : ByteChars t bs) : SafeText t := by
  induction h with
  | nil => exact .nil
  | blank c _ _ hc _ ih => exact .cons (safe_blank hc) ih
  | byte h l _ _ hh hl _ ih => exact .cons (safe_hex hh) (.cons (safe_hex hl) ih)

theorem Ident.safe {t : Text} (h : Ident t) : SafeText t := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  refine .cons (safe_ident ?_) (SafeText.of_all (fun _ => safe_ident) hcs)
  simp [isIdentChar, hc]

theorem Tag.safe {t : Text} (h : Tag t) : SafeText t := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  refine .cons (safe_ident ?_) (SafeText.of_all (fun _ => safe_ident) hcs)
  simp [isIdentChar, hc]

theorem Key.safe {L : Limits} {t : Text} {k : String} (h : Key L t k) : SafeText t := by
  cases h with
  | ident hi => exact hi.safe
  | quoted _ hs => exact hs.safe

/-! ## Whitespace and comments -/

theorem commentChar_safe {c : Char} {rest : Text}
    (h : TextChar c ∨ c = '\n' ∨ (c = '\r' ∧ rest.head? = some '\n')) : Safe c := by
  rcases h with h | rfl | ⟨rfl, -⟩
  · exact h.safe
  · decide
  · decide

mutual
theorem BlockComment.safe {t : Text} : BlockComment t → SafeText t
  | .mk _ hb => .append (.append (by decide) hb.safe) (by decide)

theorem CommentBody.safe {t : Text} : CommentBody t → SafeText t
  | .nil => .nil
  | .char _ _ hc _ _ hr => .cons (commentChar_safe hc) hr.safe
  | .nested _ _ hc hr => .append hc.safe hr.safe
end

theorem LineBody.safe {t : Text} (h : LineBody t) : SafeText t := fun c hc => (h c hc).safe

theorem WS.safe {t : Text} (h : WS t) : SafeText t := by
  induction h with
  | nil => exact .nil
  | blank c _ hc _ ih => exact .cons (safe_blank hc) ih
  | newline _ _ hn _ ih => exact .append hn.safe ih
  | lineComment _ _ _ hb hn _ ih => exact .append (.append (.append (by decide) hb.safe) hn.safe) ih
  | blockComment _ _ hc _ ih => exact .append hc.safe ih

theorem WSEnd.safe {t : Text} (h : WSEnd t) : SafeText t := by
  cases h with
  | ws _ hw => exact hw.safe
  | lineComment _ _ hw hb => exact .append (.append hw.safe (by decide)) hb.safe

/-! ## Values and files -/

mutual
theorem Val.safe {L : Limits} {n : Nat} {t : Text} {v : Value} : Val L n t v → SafeText t
  | .number _ _ h => h.safe
  | .string _ _ _ h => h.safe
  | .blockString _ _ _ h => h.safe
  | .bytes _ _ _ h _ => .append (.append (by decide) h.safe) (by decide)
  | .array _ _ _ h => .cons (by decide) (.append h.safe (by decide))
  | .record _ _ _ h => h.safe
  | .tag _ _ h => h.safe
  | .payload _ _ _ _ _ ht hsp hi _ =>
      .append (.append (.append ht.safe (blanks_safe hsp)) (.cons (by decide) hi.safe)) (by decide)
  | .recordPayload _ _ _ _ _ ht hsp hr => .append (.append ht.safe (blanks_safe hsp)) hr.safe

theorem Items.safe {L : Limits} {n : Nat} {t : Text} {xs : List Value} : Items L n t xs → SafeText t
  | .empty _ _ hw => hw.safe
  | .some _ _ _ _ hw hi => .append hw.safe hi.safe

theorem ItemsFrom.safe {L : Limits} {n : Nat} {t : Text} {xs : List Value} : ItemsFrom L n t xs → SafeText t
  | .last _ _ _ _ hv hw => .append hv.safe hw.safe
  | .lastComma _ _ _ _ _ hv hw hw' => .append (.append hv.safe hw.safe) (.cons (by decide) hw'.safe)
  | .cons _ _ _ _ _ _ _ hv hw hw' hi =>
      .append (.append (.append hv.safe hw.safe) (.cons (by decide) hw'.safe)) hi.safe

theorem Record.safe {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} : Record L n t fs → SafeText t
  | .mk _ _ _ hf _ => .cons (by decide) (.append hf.safe (by decide))

theorem Fields.safe {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} : Fields L n t fs → SafeText t
  | .empty _ _ hw => hw.safe
  | .some _ _ _ _ hw hf => .append hw.safe hf.safe

theorem FieldsFrom.safe {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → SafeText t
  | .last _ _ _ _ hf hw => .append hf.safe hw.safe
  | .lastComma _ _ _ _ _ hf hw hw' => .append (.append hf.safe hw.safe) (.cons (by decide) hw'.safe)
  | .cons _ _ _ _ _ _ _ hf hw hw' hi =>
      .append (.append (.append hf.safe hw.safe) (.cons (by decide) hw'.safe)) hi.safe

theorem Field.safe {L : Limits} {n : Nat} {t : Text} {f : String × Value} : Field L n t f → SafeText t
  | .mk _ _ _ _ _ _ _ hk hw hw' hv =>
      .append (.append (.append hk.safe hw.safe) (.cons (by decide) hw'.safe)) hv.safe
end

theorem FileItems.safe {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) : SafeText t := by
  induction h with
  | last _ _ _ hv hw => exact .append hv.safe hw.safe
  | lastComma _ _ _ _ hv hw hw' => exact .append (.append hv.safe hw.safe) (.cons (by decide) hw'.safe)
  | cons _ _ _ _ _ _ hv hw hw' _ ih =>
    exact .append (.append (.append hv.safe hw.safe) (.cons (by decide) hw'.safe)) ih

theorem Bom.safe {b : Text} (h : Bom b) : SafeText b := by
  rcases h with rfl | rfl <;> decide

/-- Every character of a valid file is safe. -/
theorem File.safe {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) : SafeText t := by
  cases h with
  | empty _ _ hb hw => exact .append hb.safe hw.safe
  | values _ _ _ _ hb hw hi => exact .append (.append hb.safe hw.safe) hi.safe

/-- **A1.** A valid haus file contains no raw bidi control character. -/
theorem File.noBidi {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) :
    ∀ c ∈ t, isBidi c = false :=
  fun c hc => (h.safe c hc).1

/-- **A2.** The only control characters in a valid haus file are tab, LF and CR. -/
theorem File.controls {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) :
    ∀ c ∈ t, isRawControl c = true → c = '\t' ∨ c = '\n' ∨ c = '\r' :=
  fun c hc => (h.safe c hc).2

end Haus.Grammar
