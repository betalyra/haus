import Haus.Grammar
import Haus.Sound.Monad
import Haus.Sound.Lexical

/-!
# Soundness of whitespace and comments

`ws` only skips text that the grammar's `WS` allows (or `WSEnd`, when an
unterminated line comment runs to the end of the input).

Block comments are the interesting part: the parser counts nesting depth as
it scans, while the grammar describes nested comments as a tree. `Scan` is
the scan written as rules; `Scan.split` shows every scan has the grammar's
nested shape.
-/

namespace Haus.Sound
open Haus Grammar Parser

/-! ## Block comments -/

/--
What `blockComment` reads `d` comments deep, up to and including the `*/`
that closes the outermost: the scan, one step at a time.
-/
inductive Scan : Nat → Text → Prop
  | close : Scan 1 ['*', '/']
  | closeInner (d : Nat) (y : Text) : Scan (d + 1) y → Scan (d + 2) ('*' :: '/' :: y)
  | open_ (d : Nat) (y : Text) : Scan (d + 2) y → Scan (d + 1) ('/' :: '*' :: y)
  | char (d : Nat) (c : Char) (y : Text) :
      ¬ (c = '/' ∧ y.head? = some '*') → ¬ (c = '*' ∧ y.head? = some '/') →
      (TextChar c ∨ c = '\n' ∨ (c = '\r' ∧ y.head? = some '\n')) →
      Scan d y → Scan d (c :: y)

theorem Scan.pos {d : Nat} {x : Text} (h : Scan d x) : 1 ≤ d := by
  induction h <;> omega

/-- Closing `d` comments: the rest of the innermost one's body, its `*/`, then closing the others. -/
theorem Scan.split : ∀ (n : Nat) (d : Nat) (x : Text), x.length ≤ n → Scan d x →
    ∃ b y, x = b ++ ['*', '/'] ++ y ∧ CommentBody b ∧ (d = 1 → y = []) ∧ (1 < d → Scan (d - 1) y) := by
  intro n
  induction n with
  | zero => intro d x hn h; cases h <;> simp at hn
  | succ n ih =>
    intro d x hn h
    cases h with
    | close => exact ⟨[], [], rfl, .nil, fun _ => rfl, fun h => by omega⟩
    | closeInner d y hy => exact ⟨[], y, rfl, .nil, fun h => by omega, fun _ => by simpa using hy⟩
    | open_ d y hy =>
      -- the nested comment, then the rest at this depth
      obtain ⟨b1, y1, rfl, hb1, -, hy1⟩ := ih (d + 2) y (by simp at hn; omega) hy
      have hy1 := hy1 (by omega)
      simp only [show d + 2 - 1 = d + 1 by omega] at hy1
      obtain ⟨b2, y2, rfl, hb2, h1, h2⟩ := ih (d + 1) y1
        (by simp only [List.length_cons, List.length_append, List.length_nil] at hn ⊢; omega) hy1
      refine ⟨('/' :: '*' :: b1 ++ ['*', '/']) ++ b2, y2, by simp, ?_, h1, h2⟩
      exact .nested _ _ (.mk b1 hb1) hb2
    | char d c y h1 h2 h3 hy =>
      obtain ⟨b, y', rfl, hb, hd1, hd2⟩ := ih d y (by simp at hn; omega) hy
      refine ⟨c :: b, y', by simp, .char c b ?_ ?_ ?_ hb, hd1, hd2⟩
      · -- a CR is followed by LF in the body: right before `*/` it would be followed by `*`
        rcases h3 with h | h | ⟨rfl, hcr⟩
        · exact .inl h
        · exact .inr (.inl h)
        · refine .inr (.inr ⟨rfl, ?_⟩)
          cases b with
          | nil => simp at hcr
          | cons _ _ => simpa using hcr
      · intro hc hb'
        cases b with
        | nil => simp at hb'
        | cons x xs => simp at hb'; subst hb'; exact h2 ⟨hc, by simp⟩
      · intro hc
        subst hc
        cases b with
        | nil => exact absurd ⟨rfl, by simp⟩ h1
        | cons x xs => exact ⟨fun hx => h1 ⟨rfl, by simpa using hx⟩, by simp⟩

/-- A whole block comment: `/*`, then a scan one level deep. -/
theorem Scan.blockComment {x : Text} (h : Scan 1 x) : BlockComment (['/', '*'] ++ x) := by
  obtain ⟨b, y, rfl, hb, hy, -⟩ := Scan.split x.length 1 x (Nat.le_refl _) h
  rw [hy rfl]
  simpa using BlockComment.mk b hb

/-- A character the comment scanner accepts is text or part of a line break. -/
theorem commentChar_ok {c : Char} {r : Text} (hb : isBidi c = false)
    (hc : ¬ (isRawControl c = true ∧ c ≠ '\t' ∧ c ≠ '\n' ∧ ¬ (c = '\r' ∧ r.head? = some '\n'))) :
    TextChar c ∨ c = '\n' ∨ (c = '\r' ∧ r.head? = some '\n') := by
  by_cases hrc : isRawControl c = true
  · by_cases h1 : c = '\t'
    · exact .inl ⟨.inl h1, hb⟩
    · by_cases h2 : c = '\n'
      · exact .inr (.inl h2)
      · exact .inr (.inr (Classical.byContradiction fun h3 => hc ⟨hrc, h1, h2, h3⟩))
  · exact .inl ⟨.inr (by simpa using hrc), hb⟩

/-- `blockComment` reads a scan `d` comments deep. -/
theorem blockComment_scan (start : Text) :
    ∀ (d : Nat) (r rest : Text), 1 ≤ d → blockComment start d r = .ok rest →
    ∃ x, r = x ++ rest ∧ Scan d x := by
  intro d r
  fun_induction blockComment start d r with
  | case1 => intro rest _ h; simp at h
  | case2 d r ih =>
    intro rest hd h
    obtain ⟨x, rfl, hx⟩ := ih rest (by omega) h
    obtain ⟨k, rfl⟩ : ∃ k, d = k + 1 := ⟨d - 1, by omega⟩
    exact ⟨'/' :: '*' :: x, rfl, .open_ k x hx⟩
  | case3 d r hle =>
    intro rest hd h
    simp at h
    subst h
    obtain rfl : d = 1 := by omega
    exact ⟨['*', '/'], rfl, .close⟩
  | case4 d r hle ih =>
    intro rest hd h
    obtain ⟨x, rfl, hx⟩ := ih rest (by omega) h
    obtain ⟨k, rfl⟩ : ∃ k, d = k + 2 := ⟨d - 2, by omega⟩
    exact ⟨'*' :: '/' :: x, rfl, .closeInner k x (by simpa using hx)⟩
  | case5 d c r hno1 hno2 hb => intro rest _ h; simp at h
  | case6 d c r hno1 hno2 hb hc => intro rest _ h; simp at h
  | case7 d c r hno1 hno2 hb hc ih =>
    intro rest hd h
    obtain ⟨x, rfl, hx⟩ := ih rest hd h
    -- A scan is never empty, so the checks' "next character" is x's first.
    have hne : x ≠ [] := by cases hx <;> simp
    obtain ⟨y, ys, rfl⟩ := List.exists_cons_of_ne_nil hne
    refine ⟨c :: y :: ys, rfl, .char d c (y :: ys) ?_ ?_ ?_ hx⟩
    · rintro ⟨h1, h2⟩
      simp at h2
      exact hno1 (ys ++ rest) h1 (by simp [h2])
    · rintro ⟨h1, h2⟩
      simp at h2
      exact hno2 (ys ++ rest) h1 (by simp [h2])
    · apply commentChar_ok (by simpa using hb)
      rintro ⟨h1, h2, h3, h4⟩
      apply hc
      simp only [List.cons_append, List.head?_cons] at h4 ⊢
      by_cases hcr : c = '\r' <;> simp_all

/-! ## The whitespace loop -/

/-- Where `ws` stops: not at whitespace or a comment. -/
def WsStop (r : Text) : Prop := ∀ c, r.head? = some c → c ≠ ' ' ∧ c ≠ '\t' ∧ c ≠ '\n' ∧ c ≠ '\r' ∧ c ≠ '/'

/-- What `ws` skipped: whitespace, or whitespace ending in an unterminated line comment at the end of the input. -/
def WsRead (w r : Text) : Prop := WS w ∨ (r = [] ∧ WSEnd w)

theorem blockComment_head {x : Text} (h : BlockComment x) : x.head? = some '/' := by
  cases h; simp

/-- Whitespace that starts with a line break starts with a `Newline`. -/
theorem WS.newline_head {w : Text} (h : WS w) (hc : w.head? = some '\n' ∨ w.head? = some '\r') :
    ∃ nl w', w = nl ++ w' ∧ Newline nl ∧ WS w' := by
  cases h with
  | nil => simp at hc
  | blank c rest hb _ => simp [isBlank] at hb hc; rcases hb with rfl | rfl <;> simp at hc
  | newline nl rest hn hr => exact ⟨nl, rest, rfl, hn, hr⟩
  | lineComment => simp at hc
  | blockComment c rest hcm _ =>
    have := blockComment_head hcm
    cases c with
    | nil => simp at this
    | cons x xs => simp at this hc; subst this; simp at hc

theorem WsRead.prepend {p w r : Text} (hp : ∀ w, WS w → WS (p ++ w)) (h : WsRead w r) : WsRead (p ++ w) r := by
  rcases h with h | ⟨rfl, h⟩
  · exact .inl (hp w h)
  · refine .inr ⟨rfl, ?_⟩
    cases h with
    | ws _ h => exact .ws _ (hp _ h)
    | lineComment w1 b h1 hb => simpa using WSEnd.lineComment (p ++ w1) b (hp w1 h1) hb

theorem head_dropWhile {p : Char → Bool} {l : Text} {c : Char} (h : (l.dropWhile p).head? = some c) :
    p c = false := by
  induction l with
  | nil => simp at h
  | cons x xs ih =>
    simp only [List.dropWhile] at h
    split at h
    · exact ih h
    · simp at h; subst h; simp_all

/-- A line comment, then whatever `ws` read after it. -/
theorem lineComment_step {body rest0 w' r : Text} (hb : LineBody body)
    (hrest : rest0 = [] ∨ rest0.head? = some '\n' ∨ rest0.head? = some '\r')
    (heq : rest0 = w' ++ r) (hs : WsStop r) (hw : WsRead w' r) :
    ∃ w, ['/', '/'] ++ body ++ rest0 = w ++ r ∧ WsRead w r := by
  rcases hrest with rfl | hh
  · -- the comment ends the input
    obtain ⟨rfl, rfl⟩ := List.append_eq_nil_iff.mp heq.symm
    exact ⟨['/', '/'] ++ body, by simp, .inr ⟨rfl, by simpa using WSEnd.lineComment [] body .nil hb⟩⟩
  · -- a line break follows, so ws read it: w' starts with it
    have hw' : w'.head? = some '\n' ∨ w'.head? = some '\r' := by
      cases w' with
      | nil =>
        simp at heq; subst heq
        rcases hh with hh | hh <;> exact absurd (hs _ hh) (by simp)
      | cons x xs => simpa [heq] using hh
    -- WS starting with a line break: the comment and that line break are one WS step
    have lc : ∀ w, WS w → (w.head? = some '\n' ∨ w.head? = some '\r') →
        WS (['/', '/'] ++ body ++ w) := fun w h hh => by
      obtain ⟨nl, w'', rfl, hn, hw''⟩ := WS.newline_head h hh
      simpa using WS.lineComment body nl w'' hb hn hw''
    rcases hw with h | ⟨rfl, h⟩
    · exact ⟨['/', '/'] ++ body ++ w', by simp [heq], .inl (lc w' h hw')⟩
    · cases h with
      | ws _ h => exact ⟨['/', '/'] ++ body ++ w', by simp [heq], .inr ⟨rfl, .ws _ (lc w' h hw')⟩⟩
      | lineComment w1 b h1 hb1 =>
        have hw1 : w1.head? = some '\n' ∨ w1.head? = some '\r' := by
          cases w1 with
          | nil => simp at hw'
          | cons x xs => simpa using hw'
        refine ⟨['/', '/'] ++ body ++ w1 ++ ['/', '/'] ++ b, by simp [heq], .inr ⟨rfl, ?_⟩⟩
        simpa using WSEnd.lineComment _ b (lc w1 h1 hw1) hb1

theorem wsLoop_sound : ∀ (n : Nat) (t r : Text), (wsLoop n).run t = .ok ((), r) →
    ∃ w, t = w ++ r ∧ WsStop r ∧ WsRead w r := by
  intro n
  induction n with
  | zero => intro t r h; simp [wsLoop] at h
  | succ n ih =>
    intro t r h
    simp only [wsLoop, run_bind, run_get] at h
    -- One character or a line break, then the rest of the loop.
    have step : ∀ (p r0 : Text), (∀ w, WS w → WS (p ++ w)) → (wsLoop n).run r0 = .ok ((), r) →
        ∃ w, p ++ r0 = w ++ r ∧ WsStop r ∧ WsRead w r := fun p r0 hp h => by
      obtain ⟨w, rfl, hs, hw⟩ := ih _ _ h
      exact ⟨p ++ w, by simp, hs, hw.prepend hp⟩
    split at h
    · simp only [run_bind, run_set] at h
      exact step [' '] _ (fun w hw => .blank ' ' w rfl hw) h
    · simp only [run_bind, run_set] at h
      exact step ['\t'] _ (fun w hw => .blank '\t' w rfl hw) h
    · simp only [run_bind, run_set] at h
      exact step ['\n'] _ (fun w hw => .newline _ w .lf hw) h
    · simp only [run_bind, run_set] at h
      exact step ['\r', '\n'] _ (fun w hw => .newline _ w .crlf hw) h
    · simp at h
    · -- a line comment
      rename_i r0
      simp only [run_bind, run_set, run_takeWhile] at h
      split at h
      · split at h <;> simp at h
      · rename_i hnone
        obtain ⟨w', heq, hs, hw⟩ := ih _ _ h
        have hb : LineBody (r0.takeWhile fun c => c != '\n' && c != '\r') := by
          intro c hc
          have h1 := List.findIdx?_eq_none_iff.mp hnone c hc
          refine ⟨?_, ?_⟩
          · by_cases ht : c = '\t'
            · exact .inl ht
            · right; cases hrc : isRawControl c <;> simp_all
          · cases hb : isBidi c <;> simp_all
        have hrest : (r0.dropWhile fun c => c != '\n' && c != '\r') = [] ∨
            (r0.dropWhile fun c => c != '\n' && c != '\r').head? = some '\n' ∨
            (r0.dropWhile fun c => c != '\n' && c != '\r').head? = some '\r' := by
          cases hd : r0.dropWhile fun c => c != '\n' && c != '\r' with
          | nil => exact .inl rfl
          | cons c cs =>
            have := head_dropWhile (p := fun c => c != '\n' && c != '\r') (l := r0) (c := c) (by simp [hd])
            simp at this
            by_cases hn : c = '\n'
            · subst hn; simp
            · have := this hn; subst this; simp
        obtain ⟨w, hw1, hw2⟩ := lineComment_step hb hrest heq hs hw
        refine ⟨w, ?_, hs, hw2⟩
        rw [← hw1]
        simp [List.takeWhile_append_dropWhile]
    · -- a block comment
      rename_i r0
      cases hbc : blockComment ('/' :: '*' :: r0) 1 r0 with
      | error e => simp [hbc] at h
      | ok rest0 =>
        simp only [run_bind, run_liftM, hbc, run_set] at h
        obtain ⟨x, rfl, hx⟩ := blockComment_scan _ 1 r0 rest0 (Nat.le_refl _) hbc
        obtain ⟨w, hw1, hs, hw⟩ := step (['/', '*'] ++ x) _ (fun w h => .blockComment _ w hx.blockComment h) h
        exact ⟨w, by simpa using hw1, hs, hw⟩
    · simp at h
    · -- nothing to skip: ws stops here
      simp at h
      subst h
      refine ⟨[], rfl, ?_, .inl .nil⟩
      intro c hc
      cases t with
      | nil => simp at hc
      | cons x xs =>
        simp at hc; subst hc
        refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> rintro rfl <;> simp_all

/-- **`ws` is sound:** it skips whitespace the grammar allows, and stops before anything else. -/
theorem ws_sound (t r : Text) (h : ws.run t = .ok ((), r)) : ∃ w, t = w ++ r ∧ WsStop r ∧ WsRead w r := by
  simp only [ws, run_bind, run_get] at h
  exact wsLoop_sound _ _ _ h

end Haus.Sound
