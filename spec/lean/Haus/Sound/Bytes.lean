import Haus.Grammar
import Haus.Sound.Monad

/-! # Soundness of byte strings -/

namespace Haus.Sound
open Haus Grammar Parser

theorem byteChars_sound : ∀ (t : Text) (bs : List UInt8) (rest : Text), byteChars t = .ok (bs, rest) →
    ∃ raw, t = raw ++ '"' :: rest ∧ ByteChars raw bs := by
  intro t
  fun_induction byteChars t with
  | case1 r => intro bs rest h; simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨[], rfl, .nil⟩
  | case2 c r _ hb ih =>
    intro bs rest h
    obtain ⟨raw, rfl, hr⟩ := ih bs rest h
    exact ⟨c :: raw, rfl, .blank c raw bs hb hr⟩
  | case3 => intro bs rest h; simp at h
  | case4 c _ _ hh l r' hl _ ih =>
    intro bs rest h
    cases h' : byteChars r' with
    | error e => simp [h', Except.map] at h
    | ok res =>
      simp only [h', Except.map, Except.ok.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      obtain ⟨raw, rfl, hr⟩ := ih res.1 res.2 h'
      exact ⟨c :: l :: raw, rfl, .byte c l raw res.1 (by simpa using hh) hl hr⟩
  | case5 => intro bs rest h; simp at h
  | case6 => intro bs rest h; simp at h
  | case7 => intro bs rest h; simp at h

/-- **Byte strings are sound:** `x"…"` as the grammar allows, within the length limit. -/
theorem bytes_sound (L : Limits) (t0 rest : Text) (v : Value)
    (h : (bytes L).run ('x' :: '"' :: t0) = .ok (v, rest)) :
    ∃ raw bs, 'x' :: '"' :: t0 = ['x', '"'] ++ raw ++ ['"'] ++ rest ∧ ByteChars raw bs ∧
      raw.length ≤ L.maxStringLength ∧ v = .bytes bs := by
  simp only [bytes, run_bind, run_get] at h
  cases hb : byteChars t0 with
  | error e =>
    simp [hb] at h
    split at h <;> simp at h
  | ok res =>
    obtain ⟨raw, rfl, hr⟩ := byteChars_sound t0 res.1 res.2 hb
    simp [hb] at h
    have e : raw.length + (res.2.length + 1) + 1 + 1 - res.2.length - 3 = raw.length := by omega
    rw [e] at h
    split at h
    · simp at h
    · simp at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨raw, res.1, by simp, hr, by omega, rfl⟩

end Haus.Sound
