import Haus.Grammar
import Haus.Sound.Monad
import Haus.Sound.Lexical

/-!
# Soundness of block strings

The parser finds the closing `"""`, splits what is before it into lines, takes
the last line as the indent and decodes the others. Each step gets a lemma
connecting it to the grammar's `BlockString`.
-/

namespace Haus.Sound
open Haus Grammar Parser

/-! ## Finding the closing quotes -/

/-- Before an unescaped `"""`, `noTripleQuote` looks one character at a time. -/
theorem noTripleQuote_cons {c : Char} {a : Text} (h1 : c ≠ '\\') (h2 : ¬ (c = '"' ∧ a.take 2 = ['"', '"'])) :
    noTripleQuote (c :: a) = noTripleQuote a := by
  match a with
  | [] => simp [noTripleQuote]
  | [x] =>
    rw [noTripleQuote]
    · simp_all
    all_goals intros; simp_all
  | x :: y :: z =>
    rw [noTripleQuote]
    · simp_all
    all_goals simp_all

theorem findClose_spec : ∀ (t a b : Text), findClose t = some (a, b) →
    t = a ++ ['"', '"', '"'] ++ b ∧ noTripleQuote a = true := by
  intro t
  fun_induction findClose t with
  | case1 c r ih =>
    intro a b h
    cases h' : findClose r with
    | none => simp [h'] at h
    | some p =>
      simp [h'] at h
      obtain ⟨rfl, rfl⟩ := h
      obtain ⟨h1, h2⟩ := ih p.1 p.2 h'
      exact ⟨by simp [h1], by simpa [noTripleQuote] using h2⟩
  | case2 r => intro a b h; simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨rfl, by simp [noTripleQuote]⟩
  | case3 c r hesc htri ih =>
    intro a b h
    cases h' : findClose r with
    | none => simp [h'] at h
    | some p =>
      simp [h'] at h
      obtain ⟨rfl, rfl⟩ := h
      obtain ⟨h1, h2⟩ := ih p.1 p.2 h'
      refine ⟨by simp [h1], ?_⟩
      rw [noTripleQuote_cons]
      · exact h2
      · -- a backslash here would be followed by at least the closing quotes: case 1
        rintro rfl
        cases hp : p.1 with
        | nil => exact hesc '"' ('"' :: '"' :: p.2) rfl (by simp [h1, hp])
        | cons x xs => exact hesc x (xs ++ ['"', '"', '"'] ++ p.2) rfl (by simp [h1, hp])
      · -- `""` after a quote would make `"""` here: case 2
        rintro ⟨rfl, ht⟩
        obtain ⟨z, hz⟩ : ∃ z, p.1 = '"' :: '"' :: z := by
          match hp : p.1, ht with
          | x :: y :: z, ht => simp at ht; obtain ⟨rfl, rfl⟩ := ht; exact ⟨z, rfl⟩
        exact htri (z ++ ['"', '"', '"'] ++ p.2) rfl (by simp [h1, hz])
  | case4 => intro a b h; simp at h

/-! ## Lines -/

theorem splitLines_ne_nil (t : Text) : splitLines t ≠ [] := by
  fun_induction splitLines t <;> simp_all

/-- `splitLines` cuts at line feeds: its lines have none, and joining them gives back the text. -/
theorem splitLines_spec (t : Text) :
    List.intercalate ['\n'] (splitLines t) = t ∧ ∀ l ∈ splitLines t, '\n' ∉ l := by
  fun_induction splitLines t with
  | case1 => simp
  | case2 r ih =>
    refine ⟨?_, ?_⟩
    · rw [List.intercalate_cons_of_ne_nil (splitLines_ne_nil r), ih.1]; rfl
    · intro l hl
      rcases List.mem_cons.mp hl with rfl | hl
      · simp
      · exact ih.2 l hl
  | case3 c r hc l ls hsplit ih =>
    rw [hsplit] at ih
    refine ⟨by rw [List.intercalate_cons_cons_left, ih.1], ?_⟩
    intro x hx
    rcases List.mem_cons.mp hx with rfl | hx
    · simp only [List.mem_cons, not_or]
      exact ⟨fun h => by subst h; exact hc rfl, ih.2 l (by simp)⟩
    · exact ih.2 x (by simp [hx])
  | case4 c r hc hsplit => exact absurd hsplit (splitLines_ne_nil r)

/-- Joining lines with a separator, the last one apart. -/
theorem intercalate_append_singleton (sep : Text) (xs : List Text) (y : Text) :
    List.intercalate sep (xs ++ [y]) = (xs.map (· ++ sep)).flatten ++ y := by
  induction xs with
  | nil => simp
  | cons x xs ih =>
    rw [List.cons_append, List.intercalate_cons_of_ne_nil (by simp), ih]
    simp [List.append_assoc]

/-- One decoded content line: with its line break, a `BlockLine` of the grammar. -/
theorem blockLine_sound (indent line s : Text) (h : blockLine indent line = .ok s) :
    ∃ raw nl, line ++ ['\n'] = raw ++ nl ∧ Newline nl ∧ BlockLine indent raw s := by
  unfold blockLine at h
  -- the line without its CR, and the line break that follows it
  obtain ⟨raw, nl, hsplit, hnl, hraw⟩ : ∃ raw nl, line ++ ['\n'] = raw ++ nl ∧ Newline nl ∧
      raw = (if line.getLast? == some '\r' then line.dropLast else line) := by
    by_cases hl : line.getLast? = some '\r'
    · obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hl
      exact ⟨ys, ['\r', '\n'], by simp, .crlf, by simp⟩
    · exact ⟨line, ['\n'], rfl, .lf, by simp [hl]⟩
  rw [← hraw] at h
  refine ⟨raw, nl, hsplit, hnl, ?_⟩
  dsimp only at h
  split at h
  · -- the indent is there: escapes and characters until the end of the line
    rename_i hpre
    rw [run'_eq] at h
    simp only [Except.map, List.length_drop] at h
    cases hc : (chars "block string" (raw.drop indent.length) blockChar List.isEmpty
        (raw.length - indent.length + 1) []).run (raw.drop indent.length) with
    | error e => simp [hc] at h
    | ok res =>
      simp only [hc, Except.ok.injEq] at h
      obtain ⟨raw0, s', h1, h2, h3, h4⟩ := chars_sound _ _ _ _ _ _ _ _ _ hc
      simp only [List.isEmpty_iff] at h3
      rw [h3, List.append_nil] at h1
      have heq : raw = indent ++ raw.drop indent.length := (List.prefix_iff_eq_append.mp hpre).symm
      rw [heq, h1, ← h, h2]
      refine .indented raw0 _ (Chars.mono ?_ h4)
      intro c ⟨hok, hb, hbidi⟩
      refine ⟨hb, ?_, hbidi⟩
      simp only [blockChar, Bool.or_eq_true, beq_iff_eq, Bool.not_eq_true'] at hok
      exact hok
  · split at h
    · simp at h
      subst h
      rename_i hpre hblank
      exact .blank raw (by simpa using hblank) hpre
    · simp at h

/-- The decoded content lines, each with its line break: `BlockLines` of the grammar. -/
theorem blockLines_of_mapM (indent : Text) : ∀ (ls ss : List Text),
    ls.mapM (blockLine indent) = .ok ss → BlockLines indent ((ls.map (· ++ ['\n'])).flatten) ss := by
  intro ls
  induction ls with
  | nil => intro ss h; simp [List.mapM_nil] at h; subst h; exact .nil
  | cons l ls ih =>
    intro ss h
    simp only [List.mapM_cons] at h
    cases hl : blockLine indent l with
    | error e => simp [hl] at h
    | ok s =>
      cases hls : ls.mapM (blockLine indent) with
      | error e => simp [hl, hls] at h
      | ok ss' =>
        simp [hl, hls] at h
        subst h
        obtain ⟨raw, nl, hsplit, hnl, hraw⟩ := blockLine_sound indent l s hl
        have := BlockLines.line raw nl _ s ss' hraw hnl (ih ss' hls)
        simpa [← List.append_assoc, ← hsplit] using this

/-- Everything after the opening line: content, indent, the closing quotes. -/
theorem blockBody_sound (L : Limits) (start r2 rest : Text) (str : String)
    (h : (blockBody L start).run r2 = .ok (str, rest)) :
    ∃ content indent ss, r2 = content ++ indent ++ ['"', '"', '"'] ++ rest ∧
      (∀ c ∈ indent, isBlank c = true) ∧ BlockLines indent content ss ∧
      noTripleQuote (content ++ indent) = true ∧ (blockText ss).length ≤ L.maxStringLength ∧
      str = blockText ss := by
  simp only [blockBody, run_bind, run_get] at h
  cases hf : findClose r2 with
  | none => simp [hf] at h
  | some p =>
    obtain ⟨a, rest'⟩ := p
    obtain ⟨hr2, hq⟩ := findClose_spec r2 a rest' hf
    simp only [hf] at h
    -- the lines before the closing quotes; the last one is the indent
    have hne := splitLines_ne_nil a
    have hsplit := splitLines_spec a
    obtain ⟨last, hlast⟩ : ∃ last, (splitLines a).getLast? = some last :=
      ⟨_, List.getLast?_eq_some_getLast hne⟩
    have ha : a = ((splitLines a).dropLast.map (· ++ ['\n'])).flatten ++ last := by
      obtain ⟨ys, hys⟩ := List.getLast?_eq_some_iff.mp hlast
      conv => lhs; rw [← hsplit.1, hys]
      rw [intercalate_append_singleton, hys, List.dropLast_concat]
    simp only [hlast, Option.getD_some] at h
    by_cases hb : last.all isBlank = true
    · simp only [hb, Bool.not_true, Bool.false_eq_true, ↓reduceIte] at h
      cases hm : (splitLines a).dropLast.mapM (blockLine last) with
      | error e => simp [hm] at h
      | ok ds =>
        simp only [hm, run_bind, run_pure, run_set, checkLength] at h
        split at h
        · simp at h
        · rename_i hlen
          simp only [run_pure, Except.ok.injEq, Prod.mk.injEq] at h
          obtain ⟨rfl, rfl⟩ := h
          have hr : r2 = (((splitLines a).dropLast.map (· ++ ['\n'])).flatten ++ last) ++ ['"', '"', '"'] ++ rest' := by
            rw [hr2, ← ha]
          refine ⟨_, last, ds, by simpa using hr, by simpa using hb, blockLines_of_mapM last _ ds hm,
            by rw [← ha]; exact hq, ?_, rfl⟩
          simp only [blockText, String.length_ofList]
          omega
    · simp only [Bool.not_eq_true] at hb
      simp [hb] at h

/-- **Block strings are sound.** -/
theorem blockString_sound (L : Limits) (t0 rest : Text) (str : String)
    (h : (blockString L).run ('"' :: '"' :: '"' :: t0) = .ok (str, rest)) :
    ∃ raw, '"' :: '"' :: '"' :: t0 = raw ++ rest ∧ BlockString L raw str := by
  simp only [blockString, run_bind, run_get, run_skip, run_takeWhile, List.drop_succ_cons, List.drop_zero] at h
  -- the blanks and the line break after the opening quotes
  have hsp := List.takeWhile_append_dropWhile (p := isBlank) (l := t0)
  have hblank : ∀ c ∈ t0.takeWhile isBlank, isBlank c = true := fun c hc => mem_takeWhile hc
  have body : ∀ nl r2, Newline nl → t0.dropWhile isBlank = nl ++ r2 →
      (blockBody L ('"' :: '"' :: '"' :: t0)).run r2 = .ok (str, rest) →
      ∃ raw, '"' :: '"' :: '"' :: t0 = raw ++ rest ∧ BlockString L raw str := by
    intro nl r2 hnl hd hb
    obtain ⟨content, indent, ss, rfl, hi, hl, hq, hlen, rfl⟩ := blockBody_sound L _ r2 rest str hb
    refine ⟨['"', '"', '"'] ++ t0.takeWhile isBlank ++ nl ++ content ++ indent ++ ['"', '"', '"'], ?_,
      .mk _ nl content indent ss hblank hnl hi hl hq hlen⟩
    conv => lhs; rw [← hsp, hd]
    simp
  split at h
  · rename_i r2 hd
    simp only [run_bind, run_set] at h
    exact body ['\r', '\n'] r2 .crlf (by simp [hd]) h
  · rename_i r2 hd
    simp only [run_bind, run_set] at h
    exact body ['\n'] r2 .lf (by simp [hd]) h
  · simp at h


end Haus.Sound
