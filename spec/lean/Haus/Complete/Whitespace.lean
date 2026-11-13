import Haus.Complete.Lexical

/-!
# Completeness of whitespace and comments

`ws` reads exactly the whitespace the grammar describes, provided what follows
can't continue it (`WsFollow`).

`wsLoop` takes fuel, and a line comment at the end of a file needs one more
step than the whitespace before it. So `wsLoop_complete` is stated for any
continuation: given how `wsLoop` behaves on what follows (for fuel above
some `k`), it behaves the same after reading `WS` first. `ws_complete` and
`wsEnd_complete` plug in the two continuations that occur.
-/

namespace Haus.Complete
open Haus Grammar Parser Sound

/-- What may follow whitespace: nothing that continues it. -/
def WsFollow (r : Text) : Prop :=
  ∀ c, r.head? = some c → c ≠ ' ' ∧ c ≠ '\t' ∧ c ≠ '\n' ∧ c ≠ '\r' ∧ c ≠ '/'

/-! ## Block comments -/

/-- One character of a comment body: `blockComment` moves past it. -/
theorem blockComment_char (start : Text) (d : Nat) (c : Char) (r : Text)
    (hok : TextChar c ∨ c = '\n' ∨ (c = '\r' ∧ r.head? = some '\n'))
    (hstar : c = '*' → r.head? ≠ some '/') (hslash : c = '/' → r.head? ≠ some '*') :
    blockComment start d (c :: r) = blockComment start d r := by
  have hbidi : isBidi c = false := by
    rcases hok with ⟨-, h⟩ | rfl | ⟨rfl, -⟩
    · exact h
    · decide
    · decide
  have hctl : (isRawControl c && c != '\t' && c != '\n' && !(c == '\r' && r.head? == some '\n')) = false := by
    rcases hok with ⟨rfl | h, -⟩ | rfl | ⟨rfl, h⟩
    · simp
    · simp [h]
    · simp
    · simp [h]
  conv => lhs; unfold blockComment
  split
  · rename_i heq; simp at heq
  · rename_i heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; exact absurd rfl (hslash rfl)
  · rename_i heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; exact absurd rfl (hstar rfl)
  · rename_i _ _ heq; simp at heq; obtain ⟨rfl, rfl⟩ := heq; simp only [hbidi, hctl, Bool.false_eq_true, ↓reduceIte]

mutual
/-- A block comment, inside a comment `d ≥ 1` levels deep, is skipped. -/
theorem _root_.Haus.Grammar.BlockComment.complete {c : Text} (start : Text) : BlockComment c →
    ∀ d x, 1 ≤ d → blockComment start d (c ++ x) = blockComment start d x
  | .mk body hb, d, x, hd => by
    have := hb.complete start (d + 1) ('*' :: '/' :: x) (by omega) (by simp)
    have hd' : ¬ d + 1 ≤ 1 := by omega
    simp only [List.append_assoc, List.cons_append, List.nil_append] at this ⊢
    rw [blockComment, this, blockComment]
    simp [hd']

/-- A comment body, followed by text that doesn't start with `/`, is skipped. -/
theorem _root_.Haus.Grammar.CommentBody.complete {body : Text} (start : Text) : CommentBody body →
    ∀ d x, 1 ≤ d → x.head? ≠ some '/' → blockComment start d (body ++ x) = blockComment start d x
  | .nil, _, _, _, _ => rfl
  | .char c rest hok hstar hslash hr, d, x, hd, hx => by
    have ih := hr.complete start d x hd hx
    simp only [List.cons_append]
    rw [blockComment_char start d c (rest ++ x), ih]
    · rcases hok with h | h | ⟨h1, h2⟩
      · exact .inl h
      · exact .inr (.inl h)
      · refine .inr (.inr ⟨h1, ?_⟩)
        cases rest with
        | nil => simp at h2
        | cons => simpa using h2
    · intro h1
      cases rest with
      | nil => simpa using hx
      | cons => simpa using hstar h1
    · intro h1
      obtain ⟨h2, h3⟩ := hslash h1
      cases rest with
      | nil => exact absurd rfl h3
      | cons => simpa using h2
  | .nested inner rest hi hr, d, x, hd, hx => by
    rw [List.append_assoc, hi.complete start d (rest ++ x) hd, hr.complete start d x hd hx]
end

/-! ## Whitespace -/

theorem wsLoop_stop {r : Text} (hr : WsFollow r) (n : Nat) : (wsLoop (n + 1)).run r = .ok ((), r) := by
  simp only [wsLoop, run_bind, run_get]
  split
  all_goals first | rfl | (exfalso; have := hr _ rfl; simp at this)

theorem wsLoop_blank {c : Char} (hc : isBlank c = true) (n : Nat) (r : Text) :
    (wsLoop (n + 1)).run (c :: r) = (wsLoop n).run r := by
  have := isBlank_iff.mp hc
  rcases this with rfl | rfl <;> simp [wsLoop]

theorem wsLoop_newline {nl : Text} (h : Newline nl) (n : Nat) (r : Text) :
    (wsLoop (n + 1)).run (nl ++ r) = (wsLoop n).run r := by
  cases h <;> simp [wsLoop]

/-- A line comment, up to a line break or the end of the input. -/
theorem wsLoop_line {body : Text} (hb : LineBody body) {x : Text}
    (hx : ∀ c, x.head? = some c → c = '\n' ∨ c = '\r') (n : Nat) :
    (wsLoop (n + 1)).run ('/' :: '/' :: (body ++ x)) = (wsLoop n).run x := by
  have hp : ∀ c ∈ body, (c != '\n' && c != '\r') = true := by
    intro c hc
    obtain ⟨h1 | h1, -⟩ := hb c hc
    · subst h1; decide
    · have hn : c ≠ '\n' := by rintro rfl; simp [isRawControl] at h1
      have hr : c ≠ '\r' := by rintro rfl; simp [isRawControl] at h1
      simp [hn, hr]
  obtain ⟨ht, hd⟩ := takeWhile_append hp (x := x) fun c hc => by rcases hx c hc with rfl | rfl <;> decide
  have hf : body.findIdx? (fun c => isBidi c || (isRawControl c && c != '\t')) = none := by
    rw [List.findIdx?_eq_none_iff]
    intro c hc
    obtain ⟨h1 | h1, h2⟩ := hb c hc
    · subst h1; decide
    · simp [h1, h2]
  simp [wsLoop, ht, hd, hf]

theorem wsLoop_block {c : Text} (h : BlockComment c) (n : Nat) (r : Text) :
    (wsLoop (n + 1)).run (c ++ r) = (wsLoop n).run r := by
  cases h with
  | mk body hb =>
    have hbc := hb.complete ('/' :: '*' :: (body ++ '*' :: '/' :: r)) 1 ('*' :: '/' :: r) (by omega) (by simp)
    simp only [List.append_assoc, List.cons_append, List.nil_append] at hbc ⊢
    simp [wsLoop, hbc, blockComment]

/--
`wsLoop` reads `WS` and then behaves as it does on what follows, given that
behaviour for fuel above `k`.
-/
theorem wsLoop_complete {w : Text} (h : WS w) (r : Text) {k : Nat} {Q : Except Error (Unit × Text)}
    (hr : ∀ m, k < m → (wsLoop m).run r = Q) : ∀ fuel, w.length + k < fuel → (wsLoop fuel).run (w ++ r) = Q := by
  induction h with
  | nil => intro fuel hf; exact hr fuel (by simpa using hf)
  | blank c rest hc _ ih =>
    intro fuel hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    rw [List.cons_append, wsLoop_blank hc, ih n (by simp at hf; omega)]
  | newline nl rest hnl _ ih =>
    intro fuel hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    have : 1 ≤ nl.length := by cases hnl <;> simp
    rw [List.append_assoc, wsLoop_newline hnl, ih n (by simp at hf; omega)]
  | lineComment body nl rest hb hnl _ ih =>
    intro fuel hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 2 := ⟨fuel - 2, by simp at hf; omega⟩
    have hx : ∀ c, (nl ++ (rest ++ r)).head? = some c → c = '\n' ∨ c = '\r' := by
      cases hnl <;> simp
    have : 1 ≤ nl.length := by cases hnl <;> simp
    simp only [List.append_assoc, List.cons_append, List.nil_append]
    rw [show n + 2 = (n + 1) + 1 from rfl, wsLoop_line hb hx, wsLoop_newline hnl, ih n (by simp at hf; omega)]
  | blockComment c rest hc _ ih =>
    intro fuel hf
    obtain ⟨n, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hf; omega⟩
    have : 1 ≤ c.length := by cases hc; simp
    rw [List.append_assoc, wsLoop_block hc, ih n (by simp at hf; omega)]

theorem ws_complete {w : Text} (h : WS w) {r : Text} (hr : WsFollow r) : ws.run (w ++ r) = .ok ((), r) := by
  simp only [ws, run_bind, run_get]
  exact wsLoop_complete h r (k := 0) (fun m hm => by
    obtain ⟨n, rfl⟩ : ∃ n, m = n + 1 := ⟨m - 1, by omega⟩
    exact wsLoop_stop hr n) _ (by simp; omega)

theorem wsEnd_complete {w : Text} (h : WSEnd w) : ws.run w = .ok ((), []) := by
  cases h with
  | ws w hw => simpa using ws_complete hw (r := []) (fun c hc => by simp at hc)
  | lineComment w body hw hb =>
    simp only [ws, run_bind, run_get]
    rw [show w ++ ['/', '/'] ++ body = w ++ ('/' :: '/' :: body) by simp]
    refine wsLoop_complete hw ('/' :: '/' :: body) (k := 1) ?_ _ (by simp)
    intro m hm
    obtain ⟨n, rfl⟩ : ∃ n, m = n + 2 := ⟨m - 2, by omega⟩
    have := wsLoop_line hb (x := []) (by simp) (n + 1)
    simp only [List.append_nil] at this
    rw [show n + 2 = (n + 1) + 1 from rfl, this, wsLoop_stop (fun c hc => by simp at hc)]
