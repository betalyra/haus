import Haus.Grammar

/-!
# A2, continued: a carriage return is always part of CRLF

`File.crlf`: in a valid haus file every carriage return is directly followed
by a line feed. A lone CR is a line break to some tools and not to others
(old Mac OS, terminals that return to the start of the line), so text after
it could be hidden or shown differently; the grammar has none (spec §4).

The proof goes through the grammar rule by rule, like `Haus.Props.Chars`:
`CrOk t` says every CR in `t` has its LF in `t`, and it is kept by joining
texts. CRs only come from line breaks (`\r\n`) and from comments, which
allow a CR only before an LF.
-/

namespace Haus.Grammar
open Haus

/-- Every carriage return is directly followed by a line feed. -/
def crOk : Text → Bool
  | [] => true
  | '\r' :: r => r.head? == some '\n' && crOk r
  | _ :: r => crOk r

/-- Every carriage return in `t` is directly followed by a line feed in `t`. -/
def CrOk (t : Text) : Prop := crOk t = true

instance : DecidablePred CrOk := fun t => inferInstanceAs (Decidable (crOk t = true))

namespace CrOk

theorem nil : CrOk [] := rfl

theorem cons {c : Char} {t : Text} (hc : c ≠ '\r') (ht : CrOk t) : CrOk (c :: t) := by
  unfold CrOk crOk; split
  · rename_i h; simp at h
  · rename_i h; simp at h; exact absurd h.1 hc
  · rename_i h; simp at h; obtain ⟨rfl, rfl⟩ := h; exact ht

theorem cr {t : Text} (hn : t.head? = some '\n') (ht : CrOk t) : CrOk ('\r' :: t) := by
  unfold CrOk at ht ⊢
  simp [crOk, hn, ht]

theorem append {a b : Text} (ha : CrOk a) (hb : CrOk b) : CrOk (a ++ b) := by
  induction a with
  | nil => exact hb
  | cons c a ih =>
    by_cases hc : c = '\r'
    · subst hc
      simp only [CrOk, crOk, Bool.and_eq_true, beq_iff_eq] at ha
      obtain ⟨hn, ha⟩ := ha
      cases a with
      | nil => simp at hn
      | cons d a => exact cr (by simpa using hn) (ih ha)
    · have : CrOk a := by
        unfold CrOk crOk at ha; split at ha
        · rename_i h; simp at h
        · rename_i h; simp at h; exact absurd h.1 hc
        · rename_i h; simp at h; obtain ⟨rfl, rfl⟩ := h; exact ha
      exact cons hc (ih this)

theorem of_all {t : Text} (h : ∀ c ∈ t, c ≠ '\r') : CrOk t := by
  induction t with
  | nil => exact nil
  | cons c t ih => exact cons (h c (by simp)) (ih fun x hx => h x (by simp [hx]))

/-- What `CrOk` says, for every position. -/
theorem spec {t : Text} (h : CrOk t) : ∀ pre post, t = pre ++ '\r' :: post → post.head? = some '\n' := by
  intro pre
  induction pre generalizing t with
  | nil =>
    intro post e; subst e
    simp only [CrOk, crOk, List.nil_append, Bool.and_eq_true, beq_iff_eq] at h
    exact h.1
  | cons c pre ih =>
    intro post e; subst e
    apply ih (t := pre ++ '\r' :: post) _ post rfl
    by_cases hc : c = '\r'
    · subst hc; simp only [CrOk, crOk, List.cons_append, Bool.and_eq_true] at h; exact h.2
    · unfold CrOk crOk at h; split at h
      · rename_i h'; simp at h'
      · rename_i h'; simp at h'; exact absurd h'.1 hc
      · rename_i h'; simp at h'; obtain ⟨rfl, rfl⟩ := h'; exact h

end CrOk

/-! ## Characters that aren't a carriage return -/

theorem ne_cr {p : Char → Bool} (hp : p '\r' = false) {c : Char} (h : p c = true) : c ≠ '\r' := by
  rintro rfl; rw [hp] at h; cases h

theorem TextChar.ne_cr {c : Char} (h : TextChar c) : c ≠ '\r' := by
  rintro rfl; obtain ⟨h1 | h1, -⟩ := h <;> revert h1 <;> decide

theorem blanks_crOk {t : Text} (h : ∀ c ∈ t, isBlank c = true) : CrOk t :=
  CrOk.of_all fun c hc => ne_cr (by decide) (h c hc)

/-! ## Each grammar rule -/

theorem SepTail.crOk {p : Char → Bool} (hp : p '\r' = false) {t : Text} (h : SepTail p t) : CrOk t := by
  induction h with
  | nil => exact .nil
  | digit c _ hc _ ih => exact .cons (ne_cr hp hc) ih
  | sep c _ hc _ ih => exact .cons (by decide) (.cons (ne_cr hp hc) ih)

theorem Digits.crOk {p : Char → Bool} (hp : p '\r' = false) {t : Text} (h : Digits p t) : CrOk t := by
  obtain ⟨c, r, rfl, hc, hr⟩ := h
  exact .cons (ne_cr hp hc) (hr.crOk hp)

theorem NumberLit.crOk {L : Limits} {t : Text} (h : NumberLit L t) : CrOk t := by
  have sign : ∀ {s : Text}, Sign s → CrOk s := by intro s hs; rcases hs with rfl | rfl <;> decide
  cases h with
  | decimal s i f e hs hi hf he =>
    refine .append (.append (.append (sign hs) ?_) ?_) ?_
    · cases hi with
      | zero => decide
      | nonzero c r hc _ hr => exact .cons (ne_cr (by decide) hc) (hr.crOk (by decide))
    · rcases hf with rfl | ⟨ds, rfl, hds⟩
      · exact .nil
      · exact .cons (by decide) (hds.crOk (by decide))
    · rcases he with rfl | ⟨m, sg, ds, rfl, hm, hsg, hds⟩
      · exact .nil
      · refine .cons (by rcases hm with rfl | rfl <;> decide) (.append ?_ (hds.crOk (by decide)))
        rcases hsg with rfl | rfl | rfl <;> decide
  | hex s ds hs hd => exact .append (sign hs) (.cons (by decide) (.cons (by decide) (hd.crOk (by decide))))
  | binary s ds hs hd => exact .append (sign hs) (.cons (by decide) (.cons (by decide) (hd.crOk (by decide))))

theorem Escape.crOk {e : Text} {c : Char} (h : Escape e c) : CrOk e := by
  cases h with
  | unicode ds _ _ hds _ =>
    exact .append (.append (by decide) (CrOk.of_all fun c hc => ne_cr (by decide) (hds c hc))) (by decide)
  | _ => decide

theorem Chars.crOk {ok : Char → Prop} (hok : ∀ c, ok c → c ≠ '\r') {raw s : Text} (h : Chars ok raw s) :
    CrOk raw := by
  induction h with
  | nil => exact .nil
  | char c _ _ hc _ ih => exact .cons (hok c hc) ih
  | escape _ _ _ _ he _ ih => exact .append he.crOk ih

theorem BasicString.crOk {L : Limits} {t : Text} {s : String} (h : BasicString L t s) : CrOk t := by
  cases h with
  | mk raw _ hc _ =>
    exact .cons (by decide) (.append (hc.crOk fun c h => by rintro rfl; exact absurd h.2.2.1 (by decide)) (by decide))

theorem Newline.crOk {t : Text} (h : Newline t) : CrOk t := by
  cases h <;> decide

theorem BlockLine.crOk {indent raw s : Text} (hi : ∀ c ∈ indent, isBlank c = true) (h : BlockLine indent raw s) :
    CrOk raw := by
  cases h with
  | indented raw' _ hc => exact .append (blanks_crOk hi) (hc.crOk fun _ h => h.2.ne_cr)
  | blank _ hb _ => exact blanks_crOk hb

theorem BlockLines.crOk {indent t : Text} {ss : List Text} (hi : ∀ c ∈ indent, isBlank c = true)
    (h : BlockLines indent t ss) : CrOk t := by
  induction h with
  | nil => exact .nil
  | line _ _ _ _ _ hl hn _ ih => exact .append (.append (hl.crOk hi) hn.crOk) ih

theorem BlockString.crOk {L : Limits} {t : Text} {s : String} (h : BlockString L t s) : CrOk t := by
  cases h with
  | mk sp nl content indent ss hsp hnl hi hl _ _ =>
    exact .append (.append (.append (.append (.append (by decide) (blanks_crOk hsp)) hnl.crOk)
      (hl.crOk hi)) (blanks_crOk hi)) (by decide)

theorem ByteChars.crOk {t : Text} {bs : List UInt8} (h : ByteChars t bs) : CrOk t := by
  induction h with
  | nil => exact .nil
  | blank c _ _ hc _ ih => exact .cons (ne_cr (by decide) hc) ih
  | byte h l _ _ hh hl _ ih => exact .cons (ne_cr (by decide) hh) (.cons (ne_cr (by decide) hl) ih)

theorem Ident.crOk {t : Text} (h : Ident t) : CrOk t := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  exact .cons (ne_cr (by decide) hc) (CrOk.of_all fun x hx => ne_cr (by decide) (hcs x hx))

theorem Tag.crOk {t : Text} (h : Tag t) : CrOk t := by
  obtain ⟨c, cs, rfl, hc, hcs⟩ := h
  exact .cons (ne_cr (by decide) hc) (CrOk.of_all fun x hx => ne_cr (by decide) (hcs x hx))

theorem Key.crOk {L : Limits} {t : Text} {k : String} (h : Key L t k) : CrOk t := by
  cases h with
  | ident hi => exact hi.crOk
  | quoted _ hs => exact hs.crOk

/-! ## Whitespace and comments -/

mutual
theorem BlockComment.crOk {t : Text} : BlockComment t → CrOk t
  | .mk _ hb => .append (.append (by decide) hb.crOk) (by decide)

/-- In a comment, a CR may only stand before an LF. -/
theorem CommentBody.crOk {t : Text} : CommentBody t → CrOk t
  | .nil => .nil
  | .char c rest hc _ _ hr => by
    rcases hc with hc | rfl | ⟨rfl, hn⟩
    · exact .cons hc.ne_cr hr.crOk
    · exact .cons (by decide) hr.crOk
    · exact .cr hn hr.crOk
  | .nested _ _ hc hr => .append hc.crOk hr.crOk
end

theorem LineBody.crOk {t : Text} (h : LineBody t) : CrOk t := CrOk.of_all fun c hc => (h c hc).ne_cr

theorem WS.crOk {t : Text} (h : WS t) : CrOk t := by
  induction h with
  | nil => exact .nil
  | blank c _ hc _ ih => exact .cons (ne_cr (by decide) hc) ih
  | newline _ _ hn _ ih => exact .append hn.crOk ih
  | lineComment _ _ _ hb hn _ ih => exact .append (.append (.append (by decide) hb.crOk) hn.crOk) ih
  | blockComment _ _ hc _ ih => exact .append hc.crOk ih

theorem WSEnd.crOk {t : Text} (h : WSEnd t) : CrOk t := by
  cases h with
  | ws _ hw => exact hw.crOk
  | lineComment _ _ hw hb => exact .append (.append hw.crOk (by decide)) hb.crOk

/-! ## Values and files -/

mutual
theorem Val.crOk {L : Limits} {n : Nat} {t : Text} {v : Value} : Val L n t v → CrOk t
  | .number _ _ h => h.crOk
  | .string _ _ _ h => h.crOk
  | .blockString _ _ _ h => h.crOk
  | .bytes _ _ _ h _ => .append (.append (by decide) h.crOk) (by decide)
  | .array _ _ _ h => .cons (by decide) (.append h.crOk (by decide))
  | .record _ _ _ h => h.crOk
  | .tag _ _ h => h.crOk
  | .payload _ _ _ _ _ ht hsp hi _ =>
      .append (.append (.append ht.crOk (blanks_crOk hsp)) (.cons (by decide) hi.crOk)) (by decide)
  | .recordPayload _ _ _ _ _ ht hsp hr => .append (.append ht.crOk (blanks_crOk hsp)) hr.crOk

theorem Items.crOk {L : Limits} {n : Nat} {t : Text} {xs : List Value} : Items L n t xs → CrOk t
  | .empty _ _ hw => hw.crOk
  | .some _ _ _ _ hw hi => .append hw.crOk hi.crOk

theorem ItemsFrom.crOk {L : Limits} {n : Nat} {t : Text} {xs : List Value} : ItemsFrom L n t xs → CrOk t
  | .last _ _ _ _ hv hw => .append hv.crOk hw.crOk
  | .lastComma _ _ _ _ _ hv hw hw' => .append (.append hv.crOk hw.crOk) (.cons (by decide) hw'.crOk)
  | .cons _ _ _ _ _ _ _ hv hw hw' hi =>
      .append (.append (.append hv.crOk hw.crOk) (.cons (by decide) hw'.crOk)) hi.crOk

theorem Record.crOk {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} : Record L n t fs → CrOk t
  | .mk _ _ _ hf _ => .cons (by decide) (.append hf.crOk (by decide))

theorem Fields.crOk {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} : Fields L n t fs → CrOk t
  | .empty _ _ hw => hw.crOk
  | .some _ _ _ _ hw hf => .append hw.crOk hf.crOk

theorem FieldsFrom.crOk {L : Limits} {n : Nat} {t : Text} {fs : List (String × Value)} :
    FieldsFrom L n t fs → CrOk t
  | .last _ _ _ _ hf hw => .append hf.crOk hw.crOk
  | .lastComma _ _ _ _ _ hf hw hw' => .append (.append hf.crOk hw.crOk) (.cons (by decide) hw'.crOk)
  | .cons _ _ _ _ _ _ _ hf hw hw' hi =>
      .append (.append (.append hf.crOk hw.crOk) (.cons (by decide) hw'.crOk)) hi.crOk

theorem Field.crOk {L : Limits} {n : Nat} {t : Text} {f : String × Value} : Field L n t f → CrOk t
  | .mk _ _ _ _ _ _ _ hk hw hw' hv =>
      .append (.append (.append hk.crOk hw.crOk) (.cons (by decide) hw'.crOk)) hv.crOk
end

theorem FileItems.crOk {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) : CrOk t := by
  induction h with
  | last _ _ _ hv hw => exact .append hv.crOk hw.crOk
  | lastComma _ _ _ _ hv hw hw' => exact .append (.append hv.crOk hw.crOk) (.cons (by decide) hw'.crOk)
  | cons _ _ _ _ _ _ hv hw hw' _ ih =>
    exact .append (.append (.append hv.crOk hw.crOk) (.cons (by decide) hw'.crOk)) ih

/-- **A2.** In a valid haus file every carriage return is directly followed by a line feed. -/
theorem File.crlf {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) :
    ∀ pre post, t = pre ++ '\r' :: post → post.head? = some '\n' := by
  have bom : ∀ {b : Text}, Bom b → CrOk b := by intro b hb; rcases hb with rfl | rfl <;> decide
  apply CrOk.spec
  cases h with
  | empty _ _ hb hw => exact .append (bom hb) hw.crOk
  | values _ _ _ _ hb hw hi => exact .append (.append (bom hb) hw.crOk) hi.crOk

end Haus.Grammar
