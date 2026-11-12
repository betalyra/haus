import Haus.Grammar
import Haus.Sound.Monad
import Haus.Sound.Lexical
import Haus.Sound.Whitespace
import Haus.Sound.Bytes
import Haus.Sound.BlockString

/-!
# Soundness of values and files

Values, records, arrays and payloads call each other, so their soundness is
proven together, by induction on the parser's fuel.
-/

namespace Haus.Sound
open Haus Grammar Parser

/-! ## Small pieces -/

/-- Whitespace followed by more input is `WS` (an unterminated line comment only ends the input). -/
theorem WsRead.ws {w r : Text} (h : WsRead w r) (hr : r ≠ []) : WS w := by
  rcases h with h | ⟨rfl, -⟩
  · exact h
  · exact absurd rfl hr

theorem expect_sound (c : Char) (what : String) (t r : Text) (h : (expect c what).run t = .ok ((), r)) :
    t = c :: r := by
  simp only [expect, run_bind, run_get] at h
  split at h
  · split at h
    · simp at h; subst h; rename_i d r' hcd; simp at hcd; subst hcd; rfl
    · simp at h
  · simp at h

theorem key_sound (L : Limits) (t r : Text) (k : String) (h : (key L).run t = .ok (k, r)) :
    ∃ x, t = x ++ r ∧ Key L x k := by
  simp only [key, run_bind, run_get] at h
  split at h
  · simp at h
  · rename_i t0 _
    obtain ⟨raw, heq, hb⟩ := basicString_sound L t0 r k h
    exact ⟨raw, heq, .quoted raw k hb⟩
  · rename_i c t0 _ _
    split at h
    · rename_i hc
      simp only [run_bind, run_takeWhile, run_pure, Except.ok.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      refine ⟨(c :: t0).takeWhile isIdentChar, by simp [List.takeWhile_append_dropWhile], .ident _ ?_⟩
      have hci : isIdentChar c = true := by simp [isIdentChar, hc]
      refine ⟨c, t0.takeWhile isIdentChar, by simp [hci], hc, ?_⟩
      intro x hx
      exact mem_takeWhile hx
    · split at h <;> simp at h
  · simp at h

/-- `ws`, followed by more input: what it skipped is `WS`. -/
theorem ws_ws {t r : Text} (h : ws.run t = .ok ((), r)) (hr : r ≠ []) : ∃ w, t = w ++ r ∧ WS w := by
  obtain ⟨w, heq, -, hw⟩ := ws_sound t r h
  exact ⟨w, heq, hw.ws hr⟩

theorem nodup_reverse {α : Type} {l : List α} (h : l.Nodup) : l.reverse.Nodup := by
  rw [List.Nodup, List.pairwise_reverse]
  exact h.imp fun h' => Ne.symm h'

/-- A value is never empty, so `value` fails on empty input. -/
theorem value_nil (L : Limits) (fuel budget : Nat) (v : Value) (r : Text) :
    (value L fuel budget).run [] ≠ .ok (v, r) := by
  cases fuel <;> simp [value]

/-! ## What each parser function guarantees, at a given fuel -/

def ValueOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget t v rest, (value L fuel budget).run t = .ok (v, rest) → ∃ x, t = x ++ rest ∧ Val L budget x v

def VariantOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget c t0 v rest, isUpper c = true → (variant L fuel budget).run (c :: t0) = .ok (v, rest) →
    ∃ x, c :: t0 = x ++ rest ∧ Val L budget x v

def RecordOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget t0 fs rest, (record L fuel budget).run ('{' :: t0) = .ok (fs, rest) →
    ∃ x b, budget = b + 1 ∧ '{' :: t0 = x ++ rest ∧ Record L b x fs

def FieldsOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget start acc t fs rest, (acc.map Prod.fst).Nodup →
    (fields L fuel budget start acc).run t = .ok (fs, rest) →
    ∃ inner fs', t = inner ++ '}' :: rest ∧ fs = acc.reverse ++ fs' ∧ (fs.map Prod.fst).Nodup ∧
      ((inner = [] ∧ fs' = []) ∨ FieldsFrom L budget inner fs')

def ItemsOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget close o t0 xs rest, (items L fuel budget close).run (o :: t0) = .ok (xs, rest) →
    ∃ inner b, budget = b + 1 ∧ t0 = inner ++ close :: rest ∧ Items L b inner xs

def ItemsLoopOk (L : Limits) (fuel : Nat) : Prop :=
  ∀ budget close start acc t xs rest, (itemsLoop L fuel budget close start acc).run t = .ok (xs, rest) →
    ∃ inner xs', t = inner ++ close :: rest ∧ xs = acc.reverse ++ xs' ∧
      ((inner = [] ∧ xs' = []) ∨ ItemsFrom L budget inner xs')

/-! ## One step: each function, assuming the others one fuel lower -/

theorem record_step (L : Limits) (fuel : Nat) (hf : FieldsOk L fuel) : RecordOk L (fuel + 1) := by
  intro budget t0 fs rest h
  cases budget with
  | zero => simp [record] at h
  | succ b =>
    simp only [record, run_bind, run_get, run_skip, List.drop_succ_cons, List.drop_zero] at h
    cases hw : ws.run t0 with
    | error e => simp [hw] at h
    | ok res =>
      obtain ⟨⟨⟩, r1⟩ := res
      simp only [hw] at h
      obtain ⟨inner, fs', hr1, hfs, hnd, hcases⟩ := hf b _ [] r1 fs rest (by simp) h
      obtain ⟨w, ht0, hW⟩ := ws_ws hw (by simp [hr1])
      simp only [List.reverse_nil, List.nil_append] at hfs
      subst hfs
      refine ⟨'{' :: (w ++ inner) ++ ['}'], b, rfl, by simp [ht0, hr1], .mk b (w ++ inner) fs ?_ hnd⟩
      rcases hcases with ⟨rfl, rfl⟩ | hff
      · simpa using Fields.empty b w hW
      · exact .some b w inner fs hW hff

theorem items_step (L : Limits) (fuel : Nat) (hl : ItemsLoopOk L fuel) : ItemsOk L (fuel + 1) := by
  intro budget close o t0 xs rest h
  cases budget with
  | zero => simp [items] at h
  | succ b =>
    simp only [items, run_bind, run_get, run_skip, List.drop_succ_cons, List.drop_zero] at h
    cases hw : ws.run t0 with
    | error e => simp [hw] at h
    | ok res =>
      obtain ⟨⟨⟩, r1⟩ := res
      simp only [hw] at h
      obtain ⟨inner, xs', hr1, hxs, hcases⟩ := hl b close _ [] r1 xs rest h
      obtain ⟨w, ht0, hW⟩ := ws_ws hw (by simp [hr1])
      simp only [List.reverse_nil, List.nil_append] at hxs
      subst hxs
      refine ⟨w ++ inner, b, rfl, by simp [ht0, hr1], ?_⟩
      rcases hcases with ⟨rfl, rfl⟩ | hif
      · simpa using Items.empty b w hW
      · exact .some b w inner xs hW hif

theorem itemsLoop_step (L : Limits) (fuel : Nat) (hv : ValueOk L fuel) (hl : ItemsLoopOk L fuel) :
    ItemsLoopOk L (fuel + 1) := by
  intro budget close start acc t xs rest h
  simp only [itemsLoop, run_bind, run_get] at h
  split at h
  · rename_i c r
    by_cases hc : c = close
    · subst hc
      simp at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨[], [], rfl, by simp, .inl ⟨rfl, rfl⟩⟩
    · simp only [beq_iff_eq, hc, ↓reduceIte, run_bind] at h
      cases hvr : (value L fuel budget).run (c :: r) with
      | error e => simp [hvr] at h
      | ok res =>
        obtain ⟨v, r1⟩ := res
        obtain ⟨xv, hxv, hval⟩ := hv budget _ v r1 hvr
        simp only [hvr] at h
        cases hw : ws.run r1 with
        | error e => simp [hw] at h
        | ok res =>
          obtain ⟨⟨⟩, r2⟩ := res
          simp only [hw, run_get] at h
          split at h
          · -- a comma: more items, or the closing bracket after a trailing comma
            rename_i r3
            simp only [run_bind, run_set] at h
            cases hw2 : ws.run r3 with
            | error e => simp [hw2] at h
            | ok res =>
              obtain ⟨⟨⟩, r4⟩ := res
              simp only [hw2] at h
              obtain ⟨inner', xs'', hr4, hxs, hcases⟩ := hl budget close start (v :: acc) r4 xs rest h
              obtain ⟨w, hr1, hW⟩ := ws_ws hw (by simp)
              obtain ⟨w', hr3, hW'⟩ := ws_ws hw2 (by simp [hr4])
              refine ⟨xv ++ w ++ ',' :: w' ++ inner', v :: xs'', by simp [hxv, hr1, hr3, hr4], by simp [hxs], .inr ?_⟩
              rcases hcases with ⟨rfl, rfl⟩ | hif
              · simpa using ItemsFrom.lastComma budget xv w w' v hval hW hW'
              · simpa using ItemsFrom.cons budget xv w w' inner' v xs'' hval hW hW' hif
          · -- the closing bracket
            rename_i c' r3 _
            by_cases hc' : c' = close
            · subst hc'
              simp at h
              obtain ⟨rfl, rfl⟩ := h
              obtain ⟨w, hr1, hW⟩ := ws_ws hw (by simp)
              exact ⟨xv ++ w, [v], by simp [hxv, hr1], by simp, .inr (ItemsFrom.last budget xv w v hval hW)⟩
            · simp [hc'] at h
          · simp at h
  · simp at h

theorem fields_step (L : Limits) (fuel : Nat) (hv : ValueOk L fuel) (hf : FieldsOk L fuel) :
    FieldsOk L (fuel + 1) := by
  intro budget start acc t fs rest hnd h
  simp only [fields, run_bind, run_get] at h
  split at h
  · -- the closing brace
    simp at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨[], [], rfl, by simp, by simpa [List.map_reverse] using nodup_reverse hnd, .inl ⟨rfl, rfl⟩⟩
  · simp at h
  · -- a field: key, ':', value
    cases hk : (key L).run t with
    | error e => simp [hk] at h
    | ok res =>
      obtain ⟨k, r1⟩ := res
      obtain ⟨xk, hxk, hkey⟩ := key_sound L t r1 k hk
      simp only [hk, run_bind] at h
      cases hw1 : ws.run r1 with
      | error e => simp [hw1] at h
      | ok res =>
        obtain ⟨⟨⟩, r2⟩ := res
        simp only [hw1] at h
        cases he : (expect ':' s!"expected ':' after key '{k}'").run r2 with
        | error e => simp [he] at h
        | ok res =>
          obtain ⟨⟨⟩, r3⟩ := res
          have hr2 := expect_sound ':' _ r2 r3 he
          simp only [he] at h
          cases hw2 : ws.run r3 with
          | error e => simp [hw2] at h
          | ok res =>
            obtain ⟨⟨⟩, r4⟩ := res
            simp only [hw2] at h
            cases hvr : (value L fuel budget).run r4 with
            | error e => simp [hvr] at h
            | ok res =>
              obtain ⟨v, r5⟩ := res
              obtain ⟨xv, hxv, hval⟩ := hv budget r4 v r5 hvr
              simp only [hvr] at h
              have hr4 : r4 ≠ [] := by rintro rfl; exact value_nil L fuel budget v r5 hvr
              obtain ⟨w1, hr1, hW1⟩ := ws_ws hw1 (by simp [hr2])
              obtain ⟨w2, hr3, hW2⟩ := ws_ws hw2 hr4
              have hfield := Field.mk budget xk w1 w2 xv k v hkey hW1 hW2 hval
              by_cases hdup : (acc.any fun x => x.fst == k) = true
              · simp [hdup] at h
              · have hk' : k ∉ acc.map Prod.fst := by
                  intro hm
                  apply hdup
                  obtain ⟨⟨k', v'⟩, hmem, rfl⟩ := List.mem_map.mp hm
                  exact List.any_eq_true.mpr ⟨(k', v'), hmem, by simp⟩
                simp only [hdup, Bool.false_eq_true, ↓reduceIte, run_bind] at h
                cases hw3 : ws.run r5 with
                | error e => simp [hw3] at h
                | ok res =>
                  obtain ⟨⟨⟩, r6⟩ := res
                  simp only [hw3, run_get] at h
                  split at h
                  · -- a comma: more fields, or the closing brace after a trailing comma
                    rename_i r7
                    simp only [run_bind, run_set] at h
                    cases hw4 : ws.run r7 with
                    | error e => simp [hw4] at h
                    | ok res =>
                      obtain ⟨⟨⟩, r8⟩ := res
                      simp only [hw4] at h
                      obtain ⟨inner', fs'', hr8, hfs, hnd', hcases⟩ :=
                        hf budget start ((k, v) :: acc) r8 fs rest (List.nodup_cons.mpr ⟨hk', hnd⟩) h
                      obtain ⟨w3, hr5, hW3⟩ := ws_ws hw3 (by simp)
                      obtain ⟨w4, hr7, hW4⟩ := ws_ws hw4 (by simp [hr8])
                      refine ⟨(xk ++ w1 ++ ':' :: w2 ++ xv) ++ w3 ++ ',' :: w4 ++ inner', (k, v) :: fs'',
                        by simp [hxk, hr1, hr2, hr3, hxv, hr5, hr7, hr8], by simp [hfs], hnd', .inr ?_⟩
                      rcases hcases with ⟨rfl, rfl⟩ | hff
                      · simpa using FieldsFrom.lastComma budget _ w3 w4 (k, v) hfield hW3 hW4
                      · exact FieldsFrom.cons budget _ w3 w4 inner' (k, v) fs'' hfield hW3 hW4 hff
                  · -- the closing brace
                    rename_i r7
                    simp at h
                    obtain ⟨rfl, rfl⟩ := h
                    obtain ⟨w3, hr5, hW3⟩ := ws_ws hw3 (by simp)
                    refine ⟨(xk ++ w1 ++ ':' :: w2 ++ xv) ++ w3, [(k, v)],
                      by simp [hxk, hr1, hr2, hr3, hxv, hr5], rfl, ?_, .inr (FieldsFrom.last budget _ w3 (k, v) hfield hW3)⟩
                    simpa [List.map_reverse, List.nodup_append] using
                      (List.nodup_cons.mpr ⟨hk', hnd⟩ |> nodup_reverse)
                  · simp at h
                  · simp at h

/-- The tag at the start of `c :: t0`, when `c` is uppercase. -/
theorem tag_takeWhile {c : Char} {t0 : Text} (hc : isUpper c = true) : Tag ((c :: t0).takeWhile isIdentChar) := by
  have hci : isIdentChar c = true := by simp [isIdentChar, hc]
  exact ⟨c, t0.takeWhile isIdentChar, by simp [hci], hc, fun x hx => mem_takeWhile hx⟩

theorem variant_step (L : Limits) (fuel : Nat) (hi : ItemsOk L fuel) (hr : RecordOk L fuel) :
    VariantOk L (fuel + 1) := by
  intro budget c t0 v rest hc h
  simp only [variant, run_bind, run_takeWhile, run_get] at h
  have htag := tag_takeWhile (t0 := t0) hc
  have hsplit := List.takeWhile_append_dropWhile (p := isIdentChar) (l := c :: t0)
  have hsp := List.takeWhile_append_dropWhile (p := isBlank)
    (l := (c :: t0).dropWhile isIdentChar)
  have hblank : ∀ x ∈ ((c :: t0).dropWhile isIdentChar).takeWhile isBlank, isBlank x = true :=
    fun x hx => mem_takeWhile hx
  split at h
  · -- `Tag(…)`
    rename_i r0 hr0
    cases hit : (items L fuel budget ')').run ('(' :: r0) with
    | error e => simp [hr0, hit] at h
    | ok res =>
      obtain ⟨xs, r1⟩ := res
      obtain ⟨inner, b, rfl, hr0', hits⟩ := hi budget ')' '(' r0 xs r1 hit
      simp only [hr0, hit, run_bind] at h
      split at h
      · simp at h
      · rename_i hne
        simp at h
        obtain ⟨rfl, rfl⟩ := h
        refine ⟨(c :: t0).takeWhile isIdentChar ++ ((c :: t0).dropWhile isIdentChar).takeWhile isBlank ++
          '(' :: inner ++ [')'], ?_, .payload b _ _ inner xs htag hblank hits (by simpa using hne)⟩
        conv => lhs; rw [← hsplit, ← hsp, hr0, hr0']
        simp
  · -- `Tag { … }`
    rename_i r0 hr0
    cases hrec : (record L fuel budget).run ('{' :: r0) with
    | error e => simp [hr0, hrec] at h
    | ok res =>
      obtain ⟨fs, r1⟩ := res
      obtain ⟨x, b, rfl, hx, hrecord⟩ := hr budget r0 fs r1 hrec
      rw [hr0] at h
      simp only [run_bind, hrec, run_pure, Except.ok.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      refine ⟨(c :: t0).takeWhile isIdentChar ++ ((c :: t0).dropWhile isIdentChar).takeWhile isBlank ++ x,
        ?_, .recordPayload b _ _ x fs htag hblank hrecord⟩
      conv => lhs; rw [← hsplit, ← hsp, hr0, hx]
      simp
  · -- `Tag` alone
    simp only [run_bind, run_set, run_pure, Except.ok.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨(c :: t0).takeWhile isIdentChar, by rw [hsplit], .tag budget _ htag⟩

theorem value_step (L : Limits) (fuel : Nat) (hr : RecordOk L fuel) (hi : ItemsOk L fuel)
    (hvar : VariantOk L fuel) : ValueOk L (fuel + 1) := by
  intro budget t v rest h
  simp only [value, run_bind, run_get] at h
  split at h
  · -- a record
    rename_i t0
    cases hrec : (record L fuel budget).run ('{' :: t0) with
    | error e => simp [hrec] at h
    | ok res =>
      obtain ⟨fs, r1⟩ := res
      obtain ⟨x, b, rfl, hx, hrecord⟩ := hr budget t0 fs r1 hrec
      simp [hrec] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨x, hx, .record b x fs hrecord⟩
  · -- an array
    rename_i t0
    cases hit : (items L fuel budget ']').run ('[' :: t0) with
    | error e => simp [hit] at h
    | ok res =>
      obtain ⟨xs, r1⟩ := res
      obtain ⟨inner, b, rfl, ht0, hits⟩ := hi budget ']' '[' t0 xs r1 hit
      simp [hit] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨'[' :: inner ++ [']'], by simp [ht0], .array b inner xs hits⟩
  · -- a block string
    rename_i t0
    cases hb : (blockString L).run ('"' :: '"' :: '"' :: t0) with
    | error e => simp [hb] at h
    | ok res =>
      obtain ⟨str, r1⟩ := res
      obtain ⟨raw, heq, hbs⟩ := blockString_sound L t0 r1 str hb
      simp [hb] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨raw, heq, .blockString budget raw str hbs⟩
  · -- a string
    rename_i t0 _
    cases hb : (basicString L).run ('"' :: t0) with
    | error e => simp [hb] at h
    | ok res =>
      obtain ⟨str, r1⟩ := res
      obtain ⟨raw, heq, hbs⟩ := basicString_sound L t0 r1 str hb
      simp [hb] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨raw, heq, .string budget raw str hbs⟩
  · -- a byte string
    rename_i t0
    obtain ⟨raw, bs, heq, hbc, hlen, rfl⟩ := bytes_sound L t0 rest v h
    exact ⟨['x', '"'] ++ raw ++ ['"'], by simpa using heq, .bytes budget raw bs hbc hlen⟩
  · rename_i c t0 _ _ _ _ _
    split at h
    · -- a number
      obtain ⟨lit, heq, hlit, rfl⟩ := number_sound L _ rest v h
      exact ⟨lit, heq, .number budget lit hlit⟩
    · split at h
      · -- a variant
        rename_i _ hup
        exact hvar budget c t0 v rest hup h
      · split at h <;> simp at h
  · simp at h

/-- All six, at every fuel: by induction, each step using the others one fuel lower. -/
theorem values_ok (L : Limits) : ∀ fuel, ValueOk L fuel ∧ VariantOk L fuel ∧ RecordOk L fuel ∧
    FieldsOk L fuel ∧ ItemsOk L fuel ∧ ItemsLoopOk L fuel := by
  intro fuel
  induction fuel with
  | zero =>
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro _ _ _ _ h; simp [value] at h
    · intro _ _ _ _ _ _ h; simp [variant] at h
    · intro _ _ _ _ h; simp [record] at h
    · intro _ _ _ _ _ _ _ h; simp [fields] at h
    · intro _ _ _ _ _ _ h; simp [items] at h
    · intro _ _ _ _ _ _ _ h; simp [itemsLoop] at h
  | succ n ih =>
    obtain ⟨hv, hvar, hr, hf, hi, hl⟩ := ih
    exact ⟨value_step L n hr hi hvar, variant_step L n hi hr, record_step L n hf, fields_step L n hv hf,
      items_step L n hl, itemsLoop_step L n hv hl⟩

/-- **Values are sound:** whatever `value` reads is a `Val` of the grammar, within its depth budget. -/
theorem value_sound (L : Limits) (fuel budget : Nat) (t rest : Text) (v : Value)
    (h : (value L fuel budget).run t = .ok (v, rest)) : ∃ x, t = x ++ rest ∧ Val L budget x v :=
  (values_ok L fuel).1 budget t v rest h

/-! ## Files -/

theorem WsRead.wsEnd {w : Text} (h : WsRead w []) : WSEnd w := by
  rcases h with h | ⟨-, h⟩
  · exact .ws w h
  · exact h

theorem fileLoop_sound (L : Limits) (fuel : Nat) : ∀ (n : Nat) (acc : List Value) (t : Text) (vs : List Value) (rest : Text),
    (fileLoop L fuel n acc).run t = .ok (vs, rest) →
    ∃ xs, vs = acc.reverse ++ xs ∧ ((t = [] ∧ xs = []) ∨ (t ≠ [] ∧ FileItems L t xs)) := by
  intro n
  induction n with
  | zero => intro acc t vs rest h; simp [fileLoop] at h
  | succ n ih =>
    intro acc t vs rest h
    simp only [fileLoop, run_bind, run_get] at h
    by_cases ht : t = []
    · subst ht
      simp at h
      exact ⟨[], by simp [h.1], .inl ⟨rfl, rfl⟩⟩
    · simp only [List.isEmpty_iff, ht, ↓reduceIte, run_bind] at h
      cases hvr : (value L fuel L.maxDepth).run t with
      | error e => simp [hvr] at h
      | ok res =>
        obtain ⟨v, r1⟩ := res
        obtain ⟨xv, hxv, hval⟩ := value_sound L fuel L.maxDepth t r1 v hvr
        simp only [hvr] at h
        cases hw : ws.run r1 with
        | error e => simp [hw] at h
        | ok res =>
          obtain ⟨⟨⟩, r2⟩ := res
          obtain ⟨w, hr1, -, hwr⟩ := ws_sound r1 r2 hw
          simp only [hw, run_get] at h
          split at h
          · -- the last value: ws reached the end
            simp at h
            obtain ⟨rfl, rfl⟩ := h
            refine ⟨[v], by simp, .inr ⟨ht, ?_⟩⟩
            rw [hxv, hr1, List.append_nil]
            exact .last xv w v hval hwr.wsEnd
          · -- a comma, then more values or the end
            rename_i r3
            simp only [run_bind, run_set] at h
            cases hw2 : ws.run r3 with
            | error e => simp [hw2] at h
            | ok res =>
              obtain ⟨⟨⟩, r4⟩ := res
              obtain ⟨w', hr3, -, hwr'⟩ := ws_sound r3 r4 hw2
              simp only [hw2] at h
              obtain ⟨xs, hvs, hcases⟩ := ih (v :: acc) r4 vs rest h
              have hW : WS w := hwr.ws (by simp)
              refine ⟨v :: xs, by simp [hvs], .inr ⟨ht, ?_⟩⟩
              rw [hxv, hr1, hr3]
              rcases hcases with ⟨rfl, rfl⟩ | ⟨hne, hfi⟩
              · simpa using FileItems.lastComma xv w w' v hval hW hwr'.wsEnd
              · simpa using FileItems.cons xv w w' r4 v xs hval hW (hwr'.ws hne) hfi
          · simp at h

/-- After the byte order mark: whitespace, then the file's values. -/
theorem afterBom_sound (L : Limits) (fuel : Nat) (b t : Text) (vs : List Value) (hb : Bom b)
    (h : (do ws; fileLoop L fuel fuel [] : P (List Value)).run' t = .ok vs) : File L (b ++ t) vs := by
  rw [run'_eq] at h
  simp only [run_bind] at h
  cases hw : ws.run t with
  | error e => simp [hw, Except.map] at h
  | ok res =>
    obtain ⟨⟨⟩, r1⟩ := res
    obtain ⟨w, rfl, -, hwr⟩ := ws_sound t r1 hw
    cases hf : (fileLoop L fuel fuel []).run r1 with
    | error e => simp [hw, hf, Except.map] at h
    | ok res =>
      obtain ⟨vs', rest⟩ := res
      simp [hw, hf, Except.map] at h
      subst h
      obtain ⟨xs, hvs, hcases⟩ := fileLoop_sound L fuel fuel [] r1 vs' rest hf
      simp at hvs
      subst hvs
      rcases hcases with ⟨rfl, rfl⟩ | ⟨hne, hfi⟩
      · simpa using File.empty b w hb hwr.wsEnd
      · simpa using File.values b w r1 _ hb (hwr.ws hne) hfi

/--
**The reference parser is sound:** whatever it accepts is a haus file in the
grammar, with exactly the values it returned. With `File.noBidi`,
`File.controls`, `File.uniqueKeys` and `File.bounded`, everything it returns
has the security properties A1–A4.
-/
theorem parse_sound (L : Limits) (input : Text) (vs : List Value) (h : Parser.parse L input = .ok vs) :
    File L input vs := by
  unfold Parser.parse at h
  split at h
  · rename_i r
    simpa using afterBom_sound L _ ['\uFEFF'] r vs (.inr rfl) h
  · simpa using afterBom_sound L _ [] input vs (.inl rfl) h

end Haus.Sound
