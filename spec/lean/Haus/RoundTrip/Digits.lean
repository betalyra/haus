import Haus.Lists

/-!
# Digits

`Nat.toDigits` and `digitsValue` undo each other, in decimal and in hex
(lowercase, or uppercase as in `\u{…}` escapes). The canonical form writes
numbers and escapes with `toDigits`; the parser reads them with
`digitsValue`.
-/

namespace Haus.RoundTrip
open Haus

theorem hexValue_digitChar : ∀ d < 16, hexValue (Nat.digitChar d) = d := by decide
theorem hexValue_toUpper_digitChar : ∀ d < 16, hexValue (Nat.digitChar d).toUpper = d := by decide
theorem isHexDigit_digitChar : ∀ d < 16, isHexDigit (Nat.digitChar d) = true := by decide
theorem isHexDigit_toUpper_digitChar : ∀ d < 16, isHexDigit (Nat.digitChar d).toUpper = true := by decide
theorem isDigit_digitChar : ∀ d < 10, isDigit (Nat.digitChar d) = true := by decide

theorem digitsValue_append (b : Nat) (l : Text) (c : Char) :
    digitsValue b (l ++ [c]) = digitsValue b l * b + hexValue c := by
  simp [digitsValue, List.foldl_append]

/-- Reading back the digits `toDigits` wrote, after mapping each digit by `f` (e.g. `toUpper`). -/
theorem digitsValue_map_toDigits {b : Nat} (hb : 1 < b) (h16 : b ≤ 16) (f : Char → Char)
    (hf : ∀ d < 16, hexValue (f (Nat.digitChar d)) = d) (n : Nat) :
    digitsValue b ((Nat.toDigits b n).map f) = n := by
  induction n using Nat.strongRecOn with
  | _ n ih =>
    rw [Nat.toDigits_eq_ite hb]
    split
    · rename_i h; simp [digitsValue, hf n (by omega)]
    · rename_i h
      have hq : n / b < n := Nat.div_lt_self (by omega) hb
      rw [List.map_append, List.map_singleton, digitsValue_append, ih _ hq,
        hf _ (by have := Nat.mod_lt n (show b > 0 by omega); omega)]
      exact Nat.div_add_mod' n b

theorem digitsValue_toDigits {b : Nat} (hb : 1 < b) (h16 : b ≤ 16) (n : Nat) :
    digitsValue b (Nat.toDigits b n) = n := by
  simpa using digitsValue_map_toDigits hb h16 id hexValue_digitChar n

theorem mem_toDigits {b n : Nat} {c : Char} (hb : 1 < b) (h : c ∈ Nat.toDigits b n) :
    ∃ d < b, c = Nat.digitChar d := by
  induction n using Nat.strongRecOn generalizing c with
  | _ n ih =>
    rw [Nat.toDigits_eq_ite hb] at h
    split at h
    · simp at h; exact ⟨n, by omega, h⟩
    · rename_i hn
      rcases List.mem_append.mp h with h | h
      · exact ih _ (Nat.div_lt_self (by omega) hb) h
      · simp at h; exact ⟨n % b, Nat.mod_lt _ (by omega), h⟩

theorem toDigits_decimal {n : Nat} : ∀ c ∈ Nat.toDigits 10 n, isDigit c = true := by
  intro c hc
  obtain ⟨d, hd, rfl⟩ := mem_toDigits (by decide) hc
  exact isDigit_digitChar d hd

theorem toDigits_hex {n : Nat} : ∀ c ∈ Nat.toDigits 16 n, isHexDigit c = true := by
  intro c hc
  obtain ⟨d, hd, rfl⟩ := mem_toDigits (by decide) hc
  exact isHexDigit_digitChar d hd

/-! ## Values of digit sequences -/

theorem digitsValue_cons_zero (b : Nat) (l : Text) : digitsValue b ('0' :: l) = digitsValue b l := by
  simp [digitsValue, hexValue, isDigit]

theorem digitsValue_dropZeros (b : Nat) : ∀ l : Text, digitsValue b (l.dropWhile (· == '0')) = digitsValue b l
  | [] => rfl
  | c :: l => by
    by_cases h : c = '0'
    · subst h; simp [List.dropWhile, digitsValue_cons_zero, digitsValue_dropZeros b l]
    · have : (c == '0') = false := by simp [h]
      simp [List.dropWhile, this]

theorem digitsValue_lt {b : Nat} {ds : Text} (h : ∀ c ∈ ds, hexValue c < b) : digitsValue b ds < b ^ ds.length := by
  have : ∀ acc, ds.foldl (fun n c => n * b + hexValue c) acc < (acc + 1) * b ^ ds.length := by
    induction ds with
    | nil => intro acc; simp
    | cons c cs ih =>
      intro acc
      have hc := h c (by simp)
      have := ih (fun x hx => h x (by simp [hx])) (acc * b + hexValue c)
      simp only [List.foldl_cons, List.length_cons, Nat.pow_succ]
      calc _ < (acc * b + hexValue c + 1) * b ^ cs.length := this
        _ ≤ (acc + 1) * (b ^ cs.length * b) := by
          rw [Nat.mul_comm (b ^ cs.length) b, ← Nat.mul_assoc]
          exact Nat.mul_le_mul_right _ (by rw [Nat.add_mul, Nat.one_mul]; omega)
  simpa [digitsValue] using this 0

theorem hexValue_digit {c : Char} (h : isDigit c = true) : hexValue c < 10 := by
  simp only [isDigit, Bool.and_eq_true, decide_eq_true_eq] at h
  have h1 : c.toNat ≤ '9'.toNat := h.2
  have e : '9'.toNat = 57 := rfl
  simp [hexValue, isDigit, h.1, h.2]; omega

theorem hexValue_hex {c : Char} (h : isHexDigit c = true) : hexValue c < 16 := by
  simp only [isHexDigit, isDigit, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq] at h
  have e1 : '9'.toNat = 57 := rfl
  have e2 : 'f'.toNat = 102 := rfl
  have e3 : 'F'.toNat = 70 := rfl
  have e4 : 'a'.toNat = 97 := rfl
  have e5 : 'A'.toNat = 65 := rfl
  have e6 : '0'.toNat = 48 := rfl
  rcases h with (⟨h1, h2⟩ | ⟨h1, h2⟩) | ⟨h1, h2⟩
  · have : c.toNat ≤ 57 := h2
    simp [hexValue, isDigit, h1, h2]; omega
  · have : 97 ≤ c.toNat := h1
    have : c.toNat ≤ 102 := h2
    have hn : ¬ c ≤ '9' := fun h => by have : c.toNat ≤ 57 := h; omega
    simp [hexValue, isDigit, hn, h1, h2]; omega
  · have : 65 ≤ c.toNat := h1
    have : c.toNat ≤ 70 := h2
    have hn : ¬ c ≤ '9' := fun h => by have : c.toNat ≤ 57 := h; omega
    have hn2 : ¬ 'a' ≤ c := fun h => by have : 97 ≤ c.toNat := h; omega
    simp [hexValue, isDigit, hn, hn2, h1, h2]; omega

/-- A decimal digit is the digit character of its value. -/
theorem digitChar_hexValue {c : Char} (h : isDigit c = true) : Nat.digitChar (hexValue c) = c := by
  have hv := hexValue_digit h
  simp only [isDigit, Bool.and_eq_true, decide_eq_true_eq] at h
  have h1 : '0'.toNat ≤ c.toNat := h.1
  have h2 : c.toNat ≤ '9'.toNat := h.2
  have e : hexValue c = c.toNat - 48 := by simp [hexValue, isDigit, h.1, h.2]
  have dc : ∀ d < 10, (Nat.digitChar d).toNat = 48 + d := by decide
  apply Char.toNat_inj.mp
  rw [e, dc _ (by rw [← e]; exact hv)]
  have : '0'.toNat = 48 := rfl
  omega

/-- Induction from the end of a list. -/
theorem snoc_induction {P : Text → Prop} (nil : P []) (snoc : ∀ l c, P l → P (l ++ [c])) : ∀ l, P l := by
  intro l
  rw [← List.reverse_reverse l]
  generalize l.reverse = r
  induction r with
  | nil => exact nil
  | cons c r ih => rw [List.reverse_cons]; exact snoc _ _ ih

theorem digitsValue_pos {b : Nat} (hb : 0 < b) : ∀ {l : Text}, (∃ c ∈ l, 0 < hexValue c) → 0 < digitsValue b l := by
  intro l
  induction l using snoc_induction with
  | nil => simp
  | snoc l c ih =>
    intro ⟨x, hx, hpos⟩
    rw [digitsValue_append]
    rcases List.mem_append.mp hx with hx | hx
    · have := ih ⟨x, hx, hpos⟩; exact Nat.lt_of_lt_of_le (Nat.mul_pos this hb) (Nat.le_add_right _ _)
    · simp at hx; subst hx; omega

/-- Decimal digits without a leading zero (or just `0`) are the digits of their value. -/
theorem toDigits_digitsValue : ∀ {l : Text}, l ≠ [] → (∀ c ∈ l, isDigit c = true) →
    (l.head? = some '0' → l = ['0']) → Nat.toDigits 10 (digitsValue 10 l) = l := by
  intro l
  induction l using snoc_induction with
  | nil => intro h; exact absurd rfl h
  | snoc l c ih =>
    intro _ hd h0
    have hc := hd c (by simp)
    rw [digitsValue_append]
    rcases l with _ | ⟨x, xs⟩
    · rw [show digitsValue 10 [] = 0 from rfl, Nat.zero_mul, Nat.zero_add,
        Nat.toDigits_of_lt_base (hexValue_digit hc), digitChar_hexValue hc]
      rfl
    · -- the leading digit isn't 0, so the rest has a positive value
      have hx : x ≠ '0' := by intro hx; subst hx; have := h0 rfl; simp at this
      have hxd := hd x (by simp)
      have hpos : 0 < digitsValue 10 (x :: xs) := digitsValue_pos (by decide) ⟨x, by simp, by
        have := digitChar_hexValue hxd
        rcases Nat.eq_zero_or_pos (hexValue x) with h | h
        · rw [h] at this; exact absurd this.symm hx
        · exact h⟩
      have ih' := ih (by simp) (fun y hy => hd y (List.mem_append_left _ hy)) (by simp [hx])
      rw [Nat.mul_comm, ← Nat.toDigits_append_toDigits (by decide) hpos (hexValue_digit hc), ih',
        Nat.toDigits_of_lt_base (hexValue_digit hc), digitChar_hexValue hc]

/-- For 12 digits and more, a number has at least two fewer hex digits than decimal ones. -/
theorem ten_pow_le (D : Nat) (h : 12 ≤ D) : 10 ^ D ≤ 16 ^ (D - 2) := by
  have : ∀ k, 10 ^ (k + 12) ≤ 16 ^ (k + 10) := by
    intro k
    induction k with
    | zero => decide
    | succ k ih =>
      rw [show k + 1 + 12 = (k + 12) + 1 by omega, show k + 1 + 10 = (k + 10) + 1 by omega, Nat.pow_succ, Nat.pow_succ]
      exact Nat.mul_le_mul ih (by decide)
  have := this (D - 12)
  rwa [show D - 12 + 12 = D by omega, show D - 12 + 10 = D - 2 by omega] at this

end Haus.RoundTrip
