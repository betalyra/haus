import Haus.Stream.Scan
import Haus.Correct

/-!
# Streams: the reader is correct (plan phase F)

`read_correct`: the stream reader returns the values `vs` without an error
exactly when `parse` accepts the whole text with the values `vs`, however
the text is split into chunks. So everything proven about `parse` and the
grammar holds for streams too.

* **Valid text is read correctly** (`file_read`): the scanner cuts exactly at
  the commas between top-level values (`Haus.Stream.Scan`), and each piece
  is a valid file with one value.
* **What the reader accepts is valid** (`read_file`): the pieces are valid
  files with one value each, joined by commas, so the whole text is a valid
  file with their values. Two ways a piece could be valid on its own but not
  in the stream are ruled out with the scanner: a piece that ends in a line
  comment (the comma after it would be part of the comment) and a piece that
  ends with a comma of its own (the scanner would have cut there).
-/

namespace Haus.Stream
open Haus Grammar Complete Parser

/-- The state at the start, and after a top-level comma. -/
abbrev St₀ : St := ⟨.normal, 0⟩

theorem scan_nil (f : Bool) (s : St) (cur : Text) : scan f s cur [] = ([], .ok s cur []) := by
  rw [scan]

/-- A comma at the top level completes the current value. -/
theorem scan_comma (cur r : Text) : scan true St₀ cur (',' :: r) = (cur :: (scan true St₀ [] r).1, (scan true St₀ [] r).2) := by
  rw [scan]; simp [step]

/-- One chunk: the pieces of a single scan. -/
theorem split_single (t : Text) : split [t] = ⟨(scan true St₀ [] t).1, (scan true St₀ [] t).2⟩ := by
  have h := scan_append St₀ [] t true []
  simp only [List.append_nil] at h
  simp only [split, List.foldl_cons, List.foldl_nil, Reader.finish, push_push, List.append_nil]
  unfold Reader.close resume at *
  simp only [Reader.push, List.nil_append] at h ⊢
  rw [h]
  split <;> simp_all

theorem read_single (L : Limits) (t : Text) : read L [t] = decode L true (scan true St₀ [] t).1 (scan true St₀ [] t).2 := by
  simp only [read, split_single]

/-! ## Valid text is read correctly -/

theorem bom_thru {b : Text} (h : Bom b) (rest : Text) : Thru St₀ b St₀ rest := by
  rcases h with rfl | rfl
  · exact Thru.nil _ _
  · exact thru_quiet1 (by refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩ <;> decide) 0 rest

theorem wsEnd_noQuote {w : Text} (h : WSEnd w) : NoQuote w := by
  cases h with
  | ws w hw => simpa using ws_noQuote hw (r := []) (by simp [NoQuote])
  | lineComment w body hw _ =>
    have := ws_noQuote hw (r := '/' :: '/' :: body) (noQuote_cons (by decide) _)
    simpa using this

/-- Whitespace at the end leaves nothing to cut. -/
theorem wsEnd_scan {w : Text} (h : WSEnd w) (cur : Text) : ∃ s, scan true St₀ cur w = ([], .ok s (cur ++ w) []) := by
  rcases wsEnd_thru h 0 [] with h' | h'
  · have := h'.run cur; simp only [List.append_nil] at this; exact ⟨_, by rw [this, scan_nil]⟩
  · have := h'.run cur; simp only [List.append_nil] at this; exact ⟨_, by rw [this, scan_nil]⟩

/-- What comes before the first value of a piece: a byte order mark only in the first piece. -/
def Lead (first : Bool) (pre : Text) : Prop :=
  if first then ∃ b w, pre = b ++ w ∧ Bom b ∧ WS w else WS pre

theorem lead_thru {first : Bool} {pre : Text} (h : Lead first pre) (rest : Text) : Thru St₀ pre St₀ rest := by
  cases first with
  | false => simp only [Lead] at h; exact ws_thru h 0 rest
  | true =>
    simp only [Lead, ↓reduceIte] at h
    obtain ⟨b, w, rfl, hb, hw⟩ := h
    exact (bom_thru hb (w ++ rest)).trans (ws_thru hw 0 rest)

theorem valStart_ne_bom {c : Char} (h : ValStart c) : c ≠ '﻿' := by
  rcases h with rfl | rfl | rfl | rfl | rfl | h | h
  any_goals decide
  all_goals rintro rfl; revert h; decide

/-- A piece with one or more values is parsed to them. -/
theorem piece_ok {L : Limits} {first : Bool} {pre q : Text} {xs : List Value} (h : Lead first pre)
    (hq : FileItems L q xs) : parsePiece L first (pre ++ q) = .ok xs := by
  cases first with
  | false =>
    simp only [Lead] at h
    have hbom : (pre ++ q).head? ≠ some '﻿' := by
      cases pre with
      | nil =>
        obtain ⟨c, q', rfl, hc⟩ := fileItems_head hq
        simpa using valStart_ne_bom hc
      | cons c pre => simpa using ws_noBom h c (by simp)
    simp only [parsePiece, Bool.not_false, Bool.true_and, hbom, decide_false]
    exact parse_complete L _ xs (by simpa using File.values [] pre q xs (.inl rfl) h hq)
  | true =>
    simp only [Lead, ↓reduceIte] at h
    obtain ⟨b, w, rfl, hb, hw⟩ := h
    simp only [parsePiece, Bool.not_true, Bool.false_and, Bool.false_eq_true, ↓reduceIte]
    exact parse_complete L _ xs (by simpa using File.values b w q xs hb hw hq)

/-- Whitespace after the last comma is parsed to no values. -/
theorem piece_empty {L : Limits} {w : Text} (h : WSEnd w) : parsePiece L false w = .ok [] := by
  have hbom : w.head? ≠ some '﻿' := by
    cases hw : w.head? with
    | none => simp
    | some c => simpa using wsEnd_noBom h c hw
  simp only [parsePiece, Bool.not_false, Bool.true_and, hbom, decide_false]
  exact parse_complete L _ [] (by simpa using File.empty [] w (.inl rfl) h)

theorem fileItems_read {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) :
    ∀ first pre, Lead first pre →
      decode L first (scan true St₀ pre t).1 (scan true St₀ pre t).2 = (xs, none) := by
  induction h with
  | last v w x hv hw =>
    intro first pre hl
    have h1 := (hv.thru 0 w (wsEnd_noQuote hw)).run pre
    obtain ⟨s, h2⟩ := wsEnd_scan hw (pre ++ v)
    rw [h1, h2]
    simp only [decode, List.append_nil, List.append_assoc]
    rw [piece_ok hl (.last v w x hv hw)]
  | lastComma v w w' x hv hw hw' =>
    intro first pre hl
    have h1 := (hv.thru 0 (w ++ ',' :: w') (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).run pre
    have h2 := (ws_thru hw 0 (',' :: w')).run (pre ++ v)
    obtain ⟨s, h3⟩ := wsEnd_scan hw' []
    simp only [List.append_assoc] at h1 h2 ⊢
    rw [h1, h2, scan_comma, h3]
    simp only [decode, List.nil_append, List.append_nil]
    rw [piece_ok hl (.last v w x hv (.ws w hw)), piece_empty hw']
  | cons v w w' t x xs hv hw hw' _ ih =>
    intro first pre hl
    have h1 := (hv.thru 0 (w ++ ',' :: (w' ++ t)) (ws_noQuote hw (noQuote_cons (c := ',') (by decide) _))).run pre
    have h2 := (ws_thru hw 0 (',' :: (w' ++ t))).run (pre ++ v)
    have h3 := (ws_thru hw' 0 t).run []
    simp only [List.append_assoc, List.cons_append, List.nil_append] at h1 h2 h3 ⊢
    rw [h1, h2, scan_comma, h3]
    simp only [decode]
    rw [piece_ok hl (.last v w x hv (.ws w hw))]
    simp only [ih false w' hw']

/-- **Valid text is read correctly**: the reader returns the values of a valid file, and no error. -/
theorem file_read {L : Limits} {t : Text} {vs : List Value} (h : File L t vs) : read L [t] = (vs, none) := by
  rw [read_single]
  cases h with
  | empty b w hb hw =>
    have h1 := (bom_thru hb w).run []
    obtain ⟨s, h2⟩ := wsEnd_scan hw b
    simp only [List.nil_append] at h1
    rw [h1, h2]
    simp only [decode, List.append_nil, parsePiece, Bool.not_true, Bool.false_and, Bool.false_eq_true, ↓reduceIte]
    rw [parse_complete L _ [] (.empty b w hb hw)]
  | values b w q xs hb hw hq =>
    have h1 := ((bom_thru hb (w ++ q)).trans (ws_thru hw 0 q)).run []
    simp only [List.nil_append, List.append_assoc] at h1 ⊢
    rw [h1]
    have := fileItems_read hq true (b ++ w) (by simp only [Lead, ↓reduceIte]; exact ⟨b, w, rfl, hb, hw⟩)
    simpa using this

/-! ## What the reader accepts is valid -/

/-- Pieces joined by commas, then the rest. -/
def glue : List Text → Text → Text
  | [], r => r
  | p :: ps, r => p ++ ',' :: glue ps r

theorem step_cut {f : Bool} {s : St} {x : Char} {r : Text} (h : step f s (x :: r) = .cut) : x = ',' ∧ s = St₀ := by
  rcases s with ⟨m, d⟩
  cases m <;> simp only [step] at h <;> (repeat' split at h) <;> simp_all

/-- The text is the pieces, joined by commas, and the rest. -/
theorem scan_glue {f : Bool} {s : St} {c t : Text} :
    ∀ {ps s' cur buf}, scan f s c t = (ps, .ok s' cur buf) → c ++ t = glue ps (cur ++ buf) := by
  fun_induction scan f s c t with
  | case1 s c => intro ps s' cur buf h; simp at h; obtain ⟨rfl, -, rfl, rfl⟩ := h; simp [glue]
  | case2 s c x r _ => intro ps s' cur buf h; simp at h; obtain ⟨rfl, -, rfl, rfl⟩ := h; simp [glue]
  | case3 s c x r k s'' _ ih =>
    intro ps s' cur buf h
    have := ih h
    rw [← this]; simp
  | case4 s c x r hcut ih =>
    intro ps s' cur buf h
    obtain ⟨rfl, -⟩ := step_cut hcut
    simp only [Prod.mk.injEq] at h
    obtain ⟨rfl, h2⟩ := h
    have := ih (Prod.ext rfl h2)
    simp only [glue, List.nil_append] at this ⊢
    rw [← this]
  | case5 s c x r _ => intro ps s' cur buf h; simp at h

/-- The first piece is the text up to a comma, after what was scanned already. -/
theorem scan_cut_shape {f : Bool} {s : St} {c t : Text} :
    ∀ {p ps res}, scan f s c t = (p :: ps, res) →
      ∃ u t', t = u ++ ',' :: t' ∧ p = c ++ u ∧ scan f St₀ [] t' = (ps, res) := by
  fun_induction scan f s c t with
  | case1 => intro p ps res h; simp at h
  | case2 => intro p ps res h; simp at h
  | case3 s c x r k s'' _ ih =>
    intro p ps res h
    obtain ⟨u, t', ht, rfl, h'⟩ := ih h
    refine ⟨x :: r.take k ++ u, t', ?_, by simp, h'⟩
    calc x :: r = x :: (r.take k ++ r.drop k) := by rw [List.take_append_drop]
      _ = _ := by rw [ht]; simp
  | case4 s c x r hcut ih =>
    intro p ps res h
    obtain ⟨rfl, rfl⟩ := step_cut hcut
    simp only [Prod.mk.injEq, List.cons.injEq] at h
    obtain ⟨⟨rfl, rfl⟩, rfl⟩ := h
    exact ⟨[], r, rfl, by simp, rfl⟩
  | case5 => intro p ps res h; simp at h

theorem decode_nil {L : Limits} {first : Bool} {res : Res} {vs : List Value} (h : decode L first [] res = (vs, none)) :
    ∃ s cur buf, res = .ok s cur buf ∧ parsePiece L first (cur ++ buf) = .ok vs := by
  cases res with
  | ok s cur buf =>
    simp only [decode] at h
    split at h
    · rename_i vs' heq
      simp only [Prod.mk.injEq] at h
      obtain ⟨rfl, -⟩ := h
      exact ⟨s, cur, buf, rfl, heq⟩
    · simp at h
  | unbalanced t =>
    simp only [decode] at h
    split at h <;> simp at h

theorem decode_cons {L : Limits} {first : Bool} {p : Text} {ps : List Text} {res : Res} {vs : List Value}
    (h : decode L first (p :: ps) res = (vs, none)) :
    ∃ v vs', parsePiece L first p = .ok [v] ∧ decode L false ps res = (vs', none) ∧ vs = v :: vs' := by
  simp only [decode] at h
  split at h
  · rename_i v hv
    simp only [Prod.mk.injEq] at h
    exact ⟨v, _, hv, Prod.ext rfl h.2, h.1.symm⟩
  · simp at h
  · simp at h

theorem parsePiece_file {L : Limits} {first : Bool} {t : Text} {vs : List Value} (h : parsePiece L first t = .ok vs) :
    File L t vs ∧ (first = false → t.head? ≠ some '﻿') := by
  unfold parsePiece at h
  split at h
  · simp at h
  · rename_i hb
    refine ⟨(parse_correct L t vs).mp h, fun hf => ?_⟩
    subst hf; simpa using hb

theorem fileItems_ne_nil {L : Limits} {t : Text} {xs : List Value} (h : FileItems L t xs) : xs ≠ [] := by
  cases h <;> simp

theorem file_bom_nil {b w : Text} {rest : Text} (hb : Bom b) (h : (b ++ w ++ rest).head? ≠ some '﻿') :
    b = [] := by
  rcases hb with rfl | rfl
  · rfl
  · simp at h

/-- A piece with one value, a comma, and a valid rest: one valid file. -/
theorem file_glue {L : Limits} {b w v wE t' : Text} {x : Value} {vs : List Value} (hb : Bom b) (hw : WS w)
    (hv : Val L L.maxDepth v x) (hwE : WS wE) (ht : File L t' vs) (hbom : t'.head? ≠ some '﻿') :
    File L (b ++ w ++ (v ++ wE) ++ ',' :: t') (x :: vs) := by
  cases ht with
  | empty b' w' hb' hw' =>
    obtain rfl := file_bom_nil (rest := []) hb' (by simpa using hbom)
    simpa using File.values b w _ [x] hb hw (.lastComma v wE w' x hv hwE hw')
  | values b' w' q _ hb' hw' hq =>
    obtain rfl := file_bom_nil hb' hbom
    simpa using File.values b w _ (x :: vs) hb hw (.cons v wE w' q x vs hv hwE hw' hq)

theorem length_ne {u v : Text} (h : u = u ++ v) (hv : v ≠ []) : False := by
  have := congrArg List.length h
  simp only [List.length_append, Nat.left_eq_add, List.length_eq_zero_iff] at this
  exact hv this

/-- **What the reader accepts is valid**: the text is a valid file with the values read. -/
theorem read_file {L : Limits} : ∀ (ps : List Text) (t : Text) (first : Bool) (res : Res) (vs : List Value),
    scan true St₀ [] t = (ps, res) → decode L first ps res = (vs, none) →
    File L t vs ∧ (first = false → t.head? ≠ some '﻿')
  | [], t, first, res, vs, hs, hd => by
    obtain ⟨s, cur, buf, rfl, hp⟩ := decode_nil hd
    have := scan_glue hs
    simp only [List.nil_append, glue] at this
    subst this
    exact parsePiece_file hp
  | p :: ps, t, first, res, vs, hs, hd => by
    obtain ⟨u, t', rfl, rfl, hs'⟩ := scan_cut_shape hs
    obtain ⟨v, vs', hp, hd', rfl⟩ := decode_cons hd
    obtain ⟨ih, ihb⟩ := read_file ps t' false res vs' hs' hd'
    try simp only [List.nil_append] at hp hs
    obtain ⟨hu, hub⟩ := parsePiece_file hp
    have ht'b := ihb rfl
    cases hu with
    | values b w q xs hb hw hq =>
      cases hq with
      | last v' wE x hv hwE =>
        cases hwE with
        | ws wE hws =>
          refine ⟨by simpa using file_glue hb hw hv hws ih ht'b, fun hf => ?_⟩
          obtain ⟨c, q', hq', -⟩ := val_head hv
          have := hub hf
          rw [hq'] at this ⊢
          simpa using this
        | lineComment w0 body hw0 hbody =>
          -- The comma after the piece would be in the line comment: the scanner can't have cut there.
          exfalso
          have hth : Thru St₀ (b ++ w ++ (v' ++ (w0 ++ ['/', '/'] ++ body)) ++ [',']) ⟨.line, 0⟩ t' := by
            have hl := thru_line (t := [',']) (by simp) 0 t'
            refine ((bom_thru hb (w ++ (v' ++ (w0 ++ '/' :: '/' :: (body ++ ',' :: t'))))).seq
              ((ws_thru hw 0 (v' ++ (w0 ++ '/' :: '/' :: (body ++ ',' :: t')))).seq
              ((hv.thru 0 (w0 ++ '/' :: '/' :: (body ++ ',' :: t'))
                (ws_noQuote hw0 (noQuote_cons (c := '/') (by decide) _))).seq
              ((ws_thru hw0 0 ('/' :: '/' :: (body ++ ',' :: t'))).seq
              ((thru_slashes 0 (body ++ ',' :: t')).seq
              ((thru_line (lineBody_no_lf hbody) 0 (',' :: t')).seq hl)))))).conv
          have := hth.run []
          simp only [List.nil_append, List.append_assoc, List.cons_append] at this hs
          rw [this] at hs
          obtain ⟨u2, -, -, hu2, -⟩ := scan_cut_shape hs
          simp at hu2
      | lastComma v' w1 w2 x hv hw1 hw2 =>
        -- The piece has a comma of its own: the scanner would have cut there.
        exfalso
        have hth : Thru St₀ (b ++ w ++ (v' ++ w1)) St₀ (',' :: (w2 ++ ',' :: t')) :=
          ((bom_thru hb (w ++ (v' ++ (w1 ++ ',' :: (w2 ++ ',' :: t'))))).seq
            ((ws_thru hw 0 (v' ++ (w1 ++ ',' :: (w2 ++ ',' :: t')))).seq
            ((hv.thru 0 (w1 ++ ',' :: (w2 ++ ',' :: t'))
              (ws_noQuote hw1 (noQuote_cons (c := ',') (by decide) _))).seq
            (ws_thru hw1 0 (',' :: (w2 ++ ',' :: t')))))).conv
        have := hth.run []
        simp only [List.nil_append, List.append_assoc, List.cons_append] at this hs
        rw [this, scan_comma] at hs
        simp only [Prod.mk.injEq, List.cons.injEq] at hs
        have := hs.1.1; simp at this
      | cons v' w1 w2 q' x xs hv hw1 hw2 hq' => exact absurd rfl (fileItems_ne_nil hq')

/-! ## The reader is correct -/

/--
**The stream reader is correct.** Read in any chunks, a text gives the
values `vs` and no error exactly when `parse` accepts the whole text with
the values `vs`.
-/
theorem read_correct (L : Limits) (cs : List Text) (vs : List Value) :
    read L cs = (vs, none) ↔ parse L cs.flatten = .ok vs := by
  rw [read_chunks, parse_correct]
  constructor
  · intro h
    rw [read_single] at h
    exact (read_file _ _ true _ vs (Prod.ext rfl rfl) h).1
  · exact file_read

/-- When `parse` rejects a text, the stream reader reports an error, however the text is split. -/
theorem read_error (L : Limits) (cs : List Text) (e : Error) (h : parse L cs.flatten = .error e) :
    (read L cs).2.isSome := by
  cases hr : read L cs with
  | mk vs err =>
    cases err with
    | some => rfl
    | none => have := (read_correct L cs vs).mp hr; rw [h] at this; cases this

end Haus.Stream
