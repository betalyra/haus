import Haus.Schema.Float

/-!
# The spelling of a float rounds back to it (spec §15)

`floatLaw`: for every float a literal decodes to, its spelling decodes to the
same float. Three facts make it:

- **Rounding depends only on the value.** `roundRat` reads `a / b` through
  its bit lengths, but every decision it takes is a comparison of `a / b`
  with a power of two, so two fractions of the same value round alike
  (`roundMag_cross`).
- **Rounding is the identity on floats** (`roundMag_self`): a value
  `roundMag` returns rounds to itself. So the exact decimal expansion of a
  float rounds back to it, and the search for the shortest spelling, which
  checks each candidate, finds one within its 1100 tries
  (`shortest_float`).
- **The layout reads back** (`decBody_layout`): the text `layout` writes is
  a literal whose value is the digits and exponent it was given.
-/

namespace Haus.Schema
open Haus

/-! ## Comparing with powers of two -/

/-- `geTwoPow` for any way of writing the exponent as a difference. -/
theorem geTwoPow_iff {a b P S : Nat} {e : Int} (h : (P : Int) - S = e) :
    geTwoPow a b e = true ↔ b * 2 ^ P ≤ a * 2 ^ S := by
  unfold geTwoPow
  split
  · rename_i he
    have hp : P = e.toNat + S := by omega
    subst hp
    rw [Nat.pow_add, ← Nat.mul_assoc, Nat.mul_le_mul_right_iff (Nat.two_pow_pos _)]
    simp only [ge_iff_le, decide_eq_true_eq]
  · rename_i he
    have hs : S = (-e).toNat + P := by omega
    subst hs
    rw [Nat.pow_add, ← Nat.mul_assoc, Nat.mul_le_mul_right_iff (Nat.two_pow_pos _)]
    simp only [ge_iff_le, decide_eq_true_eq]

/-- The larger the power, the harder to reach. -/
theorem geTwoPow_mono {a b : Nat} {e e' : Int} (h : geTwoPow a b e = true) (he : e' ≤ e) :
    geTwoPow a b e' = true := by
  have h1 : (((e + (e.natAbs + e'.natAbs)).toNat : Nat) : Int) - (e.natAbs + e'.natAbs : Nat) = e := by omega
  have h2 : (((e' + (e.natAbs + e'.natAbs)).toNat : Nat) : Int) - (e.natAbs + e'.natAbs : Nat) = e' := by omega
  rw [geTwoPow_iff h1] at h
  rw [geTwoPow_iff h2]
  refine Nat.le_trans (Nat.mul_le_mul_left _ (Nat.pow_le_pow_right (by decide) ?_)) h
  omega

theorem geTwoPow_mul {c : Nat} (hc : 0 < c) (a b : Nat) (e : Int) :
    geTwoPow (c * a) (c * b) e = geTwoPow a b e := by
  have h : ((e.toNat : Nat) : Int) - ((-e).toNat : Nat) = e := by omega
  apply Bool.eq_iff_iff.mpr
  rw [geTwoPow_iff h, geTwoPow_iff h, Nat.mul_assoc, Nat.mul_assoc, Nat.mul_le_mul_left_iff hc]

/-! ## Rounding a quotient -/

theorem roundDiv_mul {c : Nat} (hc : 0 < c) (a b : Nat) : roundDiv (c * a) (c * b) = roundDiv a b := by
  simp only [roundDiv]
  rw [Nat.mul_div_mul_left _ _ hc, Nat.mul_mod_mul_left, Nat.mul_left_comm 2 c]
  have e1 : (c * (2 * (a % b)) > c * b) = (2 * (a % b) > b) :=
    propext (Nat.mul_lt_mul_left hc)
  have e2 : (c * (2 * (a % b)) == c * b) = (2 * (a % b) == b) := by
    apply Bool.eq_iff_iff.mpr
    simp only [beq_iff_eq]
    exact ⟨Nat.eq_of_mul_eq_mul_left hc, fun h => by rw [h]⟩
  simp only [e1, e2]

theorem div_le_roundDiv (a b : Nat) : a / b ≤ roundDiv a b := by
  simp only [roundDiv]; split <;> omega

theorem roundDiv_le (a b : Nat) : roundDiv a b ≤ a / b + 1 := by
  simp only [roundDiv]; split <;> omega

theorem roundDiv_exact (m : Nat) {b : Nat} (hb : 0 < b) : roundDiv (m * b) b = m := by
  simp only [roundDiv, Nat.mul_div_cancel _ hb, Nat.mul_mod_left]
  split
  · rename_i h
    simp only [Nat.mul_zero, Bool.or_eq_true, decide_eq_true_eq, Bool.and_eq_true, beq_iff_eq] at h
    omega
  · rfl

/-- The significand at exponent `q`: `a / (b · 2^q)` rounded. -/
def scaled (a b : Nat) (q : Int) : Nat :=
  if 0 ≤ q then roundDiv a (b * 2 ^ q.toNat) else roundDiv (a * 2 ^ (-q).toNat) b

theorem scaled_eq {a b P S : Nat} {q : Int} (h : (P : Int) - S = q) :
    scaled a b q = roundDiv (a * 2 ^ S) (b * 2 ^ P) := by
  unfold scaled
  split
  · rename_i hq
    have hp : P = q.toNat + S := by omega
    subst hp
    rw [show a * 2 ^ S = 2 ^ S * a from Nat.mul_comm _ _,
      show b * 2 ^ (q.toNat + S) = 2 ^ S * (b * 2 ^ q.toNat) by rw [Nat.pow_add]; ac_rfl,
      roundDiv_mul (Nat.two_pow_pos _)]
  · rename_i hq
    have hs : S = (-q).toNat + P := by omega
    subst hs
    rw [show a * 2 ^ ((-q).toNat + P) = 2 ^ P * (a * 2 ^ (-q).toNat) by rw [Nat.pow_add]; ac_rfl,
      show b * 2 ^ P = 2 ^ P * b from Nat.mul_comm _ _, roundDiv_mul (Nat.two_pow_pos _)]

theorem scaled_mul {c : Nat} (hc : 0 < c) (a b : Nat) (q : Int) : scaled (c * a) (c * b) q = scaled a b q := by
  unfold scaled
  split
  · rw [Nat.mul_assoc, roundDiv_mul hc]
  · rw [Nat.mul_assoc, roundDiv_mul hc]

/-! ## The binary exponent -/

/-- `⌊log₂ (a / b)⌋`, as `roundMag` computes it. -/
def lexp (a b : Nat) : Int :=
  let t : Int := (a.log2 : Int) - b.log2
  if geTwoPow a b t then t else t - 1

/-- What `roundMag` does once it knows the binary exponent `L`. -/
def roundFrom (F : Format) (a b : Nat) (L : Int) : Option (Nat × Int) :=
  let q := max (L - (F.prec - 1 : Nat)) F.emin
  let m := scaled a b q
  let (m, q) := if m = 2 ^ F.prec then (2 ^ (F.prec - 1), q + 1) else (m, q)
  if q > F.emax then none else some (m, q)

theorem roundMag_zero (F : Format) (b : Nat) : roundMag F 0 b = some (0, F.emin) := rfl

theorem roundMag_eq {F : Format} {a : Nat} (b : Nat) (ha : a ≠ 0) :
    roundMag F a b = roundFrom F a b (lexp a b) := by
  simp only [roundMag, ha, ↓reduceIte]
  rfl

/-- `2^L ≤ a / b < 2^(L+1)`. -/
def IsLexp (a b : Nat) (L : Int) : Prop := geTwoPow a b L = true ∧ geTwoPow a b (L + 1) = false

theorem lexp_spec {a b : Nat} (ha : a ≠ 0) (hb : b ≠ 0) : IsLexp a b (lexp a b) := by
  have la := Nat.log2_self_le ha
  have lb := Nat.log2_self_le hb
  have ua := @Nat.lt_log2_self a
  have ub := @Nat.lt_log2_self b
  have lo : geTwoPow a b ((a.log2 : Int) - b.log2 - 1) = true := by
    rw [geTwoPow_iff (P := a.log2) (S := b.log2 + 1) (by omega)]
    rw [Nat.mul_comm a]
    exact Nat.mul_le_mul (Nat.le_of_lt ub) la
  have hi : geTwoPow a b ((a.log2 : Int) - b.log2 + 1) = false := by
    apply Bool.eq_false_iff.mpr
    rw [ne_eq, geTwoPow_iff (P := a.log2 + 1) (S := b.log2) (by omega)]
    intro h
    have : a * 2 ^ b.log2 < 2 ^ (a.log2 + 1) * b :=
      Nat.lt_of_lt_of_le (Nat.mul_lt_mul_of_pos_right ua (Nat.two_pow_pos _)) (Nat.mul_le_mul_left _ lb)
    rw [Nat.mul_comm b] at h
    omega
  simp only [lexp]
  split
  · exact ⟨by assumption, hi⟩
  · rename_i h
    refine ⟨lo, ?_⟩
    simpa using h

theorem IsLexp.unique {a b : Nat} {L L' : Int} (h : IsLexp a b L) (h' : IsLexp a b L') : L = L' := by
  rcases Int.lt_trichotomy L L' with hl | hl | hl
  · have := geTwoPow_mono h'.1 (show L + 1 ≤ L' by omega)
    rw [h.2] at this; cases this
  · exact hl
  · have := geTwoPow_mono h.1 (show L' + 1 ≤ L by omega)
    rw [h'.2] at this; cases this

theorem IsLexp.mul {a b c : Nat} {L : Int} (hc : 0 < c) (h : IsLexp (c * a) (c * b) L) : IsLexp a b L := by
  rw [IsLexp, geTwoPow_mul hc, geTwoPow_mul hc] at h
  exact h

/-! ## Rounding depends only on the value -/

theorem roundFrom_mul {c : Nat} (hc : 0 < c) (F : Format) (a b : Nat) (L : Int) :
    roundFrom F (c * a) (c * b) L = roundFrom F a b L := by
  simp only [roundFrom, scaled_mul hc]

theorem roundMag_mul {c : Nat} (hc : 0 < c) (F : Format) (a : Nat) {b : Nat} (hb : 0 < b) :
    roundMag F (c * a) (c * b) = roundMag F a b := by
  by_cases ha : a = 0
  · subst ha; rw [Nat.mul_zero, roundMag_zero, roundMag_zero]
  · have hca : c * a ≠ 0 := Nat.mul_ne_zero (by omega) ha
    have hcb : c * b ≠ 0 := Nat.mul_ne_zero (by omega) (by omega)
    rw [roundMag_eq _ hca, roundMag_eq _ ha, roundFrom_mul hc,
      ((lexp_spec hca hcb).mul hc).unique (lexp_spec ha (by omega))]

/-- Two fractions of the same value round alike. -/
theorem roundMag_cross (F : Format) {a b a' b' : Nat} (hb : 0 < b) (hb' : 0 < b') (h : a * b' = a' * b) :
    roundMag F a b = roundMag F a' b' := by
  rw [← roundMag_mul hb' F a hb, ← roundMag_mul hb F a' hb', Nat.mul_comm b' a, h, Nat.mul_comm a',
    Nat.mul_comm b']

theorem roundRat_cross (F : Format) (neg : Bool) {a b a' b' : Nat} (hb : 0 < b) (hb' : 0 < b')
    (h : a * b' = a' * b) : roundRat F neg a b = roundRat F neg a' b' := by
  unfold roundRat; rw [roundMag_cross F hb hb' h]

/-! ## What rounding returns -/

theorem roundFrom_some {F : Format} {a b : Nat} {L : Int} {m : Nat} {q : Int} (h : roundFrom F a b L = some (m, q)) :
    let q0 := max (L - ((F.prec - 1 : Nat) : Int)) F.emin
    ((scaled a b q0 = 2 ^ F.prec ∧ m = 2 ^ (F.prec - 1) ∧ q = q0 + 1) ∨
      (scaled a b q0 ≠ 2 ^ F.prec ∧ m = scaled a b q0 ∧ q = q0)) ∧ q ≤ F.emax := by
  intro q0
  simp only [roundFrom] at h
  by_cases hc : scaled a b q0 = 2 ^ F.prec
  · simp only [q0, hc, ↓reduceIte] at h
    split at h
    · cases h
    · rename_i hle
      cases h
      exact ⟨.inl ⟨hc, rfl, rfl⟩, by omega⟩
  · simp only [q0, hc, ↓reduceIte] at h
    split at h
    · cases h
    · rename_i hle
      cases h
      exact ⟨.inr ⟨hc, rfl, rfl⟩, by omega⟩

theorem roundFrom_of {F : Format} {a b : Nat} {L q0 : Int} {m0 : Nat}
    (hq0 : max (L - ((F.prec - 1 : Nat) : Int)) F.emin = q0) (hm0 : scaled a b q0 = m0)
    (hne : m0 ≠ 2 ^ F.prec) (hle : q0 ≤ F.emax) : roundFrom F a b L = some (m0, q0) := by
  simp only [roundFrom, hq0, hm0, hne, ↓reduceIte]
  have : ¬ q0 > F.emax := by omega
  simp only [this, ↓reduceIte]

/-- A float of the format `F`, as `roundMag` returns them: `m < 2^prec`, normalized or subnormal. -/
structure Normal (F : Format) (m : Nat) (q : Int) : Prop where
  lt : m < 2 ^ F.prec
  norm : 2 ^ (F.prec - 1) ≤ m ∨ q = F.emin
  ge : F.emin ≤ q
  le : q ≤ F.emax

theorem roundFrom_normal {F : Format} (hp : 1 ≤ F.prec) {a b : Nat} (hb : 0 < b) {L : Int} (hL : IsLexp a b L)
    {m : Nat} {q : Int} (h : roundFrom F a b L = some (m, q)) : Normal F m q := by
  obtain ⟨hc, hle⟩ := roundFrom_some h
  generalize hq0 : max (L - ((F.prec - 1 : Nat) : Int)) F.emin = q0 at hc
  have hrep : ((q0.toNat : Nat) : Int) - ((-q0).toNat : Nat) = q0 := by omega
  rw [scaled_eq hrep] at hc
  have hBpos : 0 < b * 2 ^ q0.toNat := Nat.mul_pos hb (Nat.two_pow_pos _)
  -- `a / b < 2^(q0 + prec)`
  have hup : roundDiv (a * 2 ^ (-q0).toNat) (b * 2 ^ q0.toNat) ≤ 2 ^ F.prec := by
    have hf : geTwoPow a b (q0 + (F.prec : Nat)) = false := by
      apply Bool.eq_false_iff.mpr
      intro ht
      have := geTwoPow_mono ht (show L + 1 ≤ q0 + (F.prec : Nat) by omega)
      rw [hL.2] at this; cases this
    have hn : ¬ b * 2 ^ (q0.toNat + F.prec) ≤ a * 2 ^ (-q0).toNat := by
      rw [← geTwoPow_iff (e := q0 + (F.prec : Nat)) (by omega), hf]; simp
    have hlt : a * 2 ^ (-q0).toNat / (b * 2 ^ q0.toNat) < 2 ^ F.prec := by
      rw [Nat.div_lt_iff_lt_mul hBpos]
      rw [Nat.pow_add, ← Nat.mul_assoc] at hn
      rw [Nat.mul_comm (2 ^ F.prec)]; omega
    have := roundDiv_le (a * 2 ^ (-q0).toNat) (b * 2 ^ q0.toNat)
    omega
  -- `a / b ≥ 2^(q0 + prec - 1)` when `q0` is not the least exponent
  have hlo : q0 = L - ((F.prec - 1 : Nat) : Int) →
      2 ^ (F.prec - 1) ≤ roundDiv (a * 2 ^ (-q0).toNat) (b * 2 ^ q0.toNat) := by
    intro he
    have hg : b * 2 ^ (q0.toNat + (F.prec - 1)) ≤ a * 2 ^ (-q0).toNat := by
      rw [← geTwoPow_iff (e := L) (by omega)]; exact hL.1
    rw [Nat.pow_add, ← Nat.mul_assoc] at hg
    have : 2 ^ (F.prec - 1) ≤ a * 2 ^ (-q0).toNat / (b * 2 ^ q0.toNat) := by
      rw [Nat.le_div_iff_mul_le hBpos, Nat.mul_comm]; exact hg
    exact Nat.le_trans this (div_le_roundDiv _ _)
  have hpow : 2 ^ (F.prec - 1) < 2 ^ F.prec := Nat.pow_lt_pow_right (by decide) (by omega)
  have hq0e : F.emin ≤ q0 := by omega
  rcases hc with ⟨_, hm, hq⟩ | ⟨hne, hm, hq⟩
  · subst hm; rw [hq] at hle ⊢
    exact ⟨hpow, .inl (Nat.le_refl _), by omega, hle⟩
  · subst hm; rw [hq] at hle ⊢
    refine ⟨by omega, ?_, hq0e, hle⟩
    by_cases he : q0 = F.emin
    · exact .inr he
    · exact .inl (hlo (by omega))

/-- What `roundMag` returns is a float of the format. -/
theorem roundMag_normal {F : Format} (hp : 1 ≤ F.prec) (hF : F.emin ≤ F.emax) {a b : Nat} (hb : 0 < b)
    {m : Nat} {q : Int} (h : roundMag F a b = some (m, q)) : Normal F m q := by
  by_cases ha : a = 0
  · subst ha
    rw [roundMag_zero] at h
    cases h
    exact ⟨Nat.two_pow_pos _, .inr rfl, Int.le_refl _, hF⟩
  · rw [roundMag_eq _ ha] at h
    exact roundFrom_normal hp hb (lexp_spec ha (by omega)) h

/--
**Rounding is the identity on floats**: a fraction `a / b` whose value is
`m · 2^q`, a float of the format, rounds to `m · 2^q`.
-/
theorem roundMag_self {F : Format} {m : Nat} {q : Int} (hn : Normal F m q) (hm : 0 < m)
    {a b P S : Nat} (hb : 0 < b) (hq : (P : Int) - S = q) (hab : a * 2 ^ S = m * (b * 2 ^ P)) :
    roundMag F a b = some (m, q) := by
  have hBpos : 0 < b * 2 ^ P := Nat.mul_pos hb (Nat.two_pow_pos _)
  have ha : a ≠ 0 := by
    intro h0; subst h0
    have : m * (b * 2 ^ P) = 0 := by rw [← hab, Nat.zero_mul]
    have := Nat.mul_pos hm hBpos
    omega
  have hL := lexp_spec (b := b) ha (by omega)
  rw [roundMag_eq _ ha]
  -- `2^(q + prec - 1) ≤ a / b` exactly when `2^(prec - 1) ≤ m`
  have key : geTwoPow a b (q + ((F.prec - 1 : Nat) : Int)) = true ↔ 2 ^ (F.prec - 1) ≤ m := by
    rw [geTwoPow_iff (P := P + (F.prec - 1)) (S := S) (by omega), hab, Nat.pow_add,
      show b * (2 ^ P * 2 ^ (F.prec - 1)) = 2 ^ (F.prec - 1) * (b * 2 ^ P) by ac_rfl]
    exact Nat.mul_le_mul_right_iff hBpos
  have hq0 : max (lexp a b - ((F.prec - 1 : Nat) : Int)) F.emin = q := by
    by_cases hlo : 2 ^ (F.prec - 1) ≤ m
    · have hup : geTwoPow a b (q + ((F.prec - 1 : Nat) : Int) + 1) = false := by
        apply Bool.eq_false_iff.mpr
        rw [ne_eq, geTwoPow_iff (P := P + (F.prec - 1) + 1) (S := S) (by omega), hab, Nat.pow_add,
          Nat.pow_add]
        intro hc
        have hlt := hn.lt
        have : 2 ^ (F.prec - 1) * 2 ^ 1 ≤ m := by
          rw [show b * (2 ^ P * 2 ^ (F.prec - 1) * 2 ^ 1) = (2 ^ (F.prec - 1) * 2 ^ 1) * (b * 2 ^ P) by
            ac_rfl] at hc
          exact (Nat.mul_le_mul_right_iff hBpos).mp hc
        rw [← Nat.pow_add] at this
        have : 2 ^ F.prec ≤ 2 ^ (F.prec - 1 + 1) := Nat.pow_le_pow_right (by decide) (by omega)
        omega
      have := hL.unique ⟨key.mpr hlo, hup⟩
      have := hn.ge
      omega
    · have he : q = F.emin := hn.norm.resolve_left hlo
      have : lexp a b < q + ((F.prec - 1 : Nat) : Int) := by
        apply Int.lt_of_not_ge
        intro hge
        exact hlo (key.mp (geTwoPow_mono hL.1 hge))
      omega
  refine roundFrom_of hq0 ?_ (by have := hn.lt; omega) hn.le
  rw [scaled_eq hq, hab, roundDiv_exact _ hBpos]

/-! ## The search for the shortest spelling -/

/-- A spelling the search returns rounds back. -/
theorem digitsAt_some {F : Format} {x : Flt} {neg : Bool} {a b : Nat} {n : Int} {k d : Nat}
    (h : digitsAt F x neg a b n k = some d) : roundsTo F x neg d (n - k) = true := by
  unfold digitsAt at h
  generalize (if 0 ≤ n - (k : Int) then (a, b * 10 ^ (n - k).toNat) else (a * 10 ^ ((k : Int) - n).toNat, b)) = p at h
  obtain ⟨num, den⟩ := p
  simp only [Bool.and_eq_true] at h
  split at h
  · rename_i hc
    split at h <;> cases h
    · exact hc.1
    · exact hc.2.2
  · split at h
    · cases h; assumption
    · split at h
      · cases h; rename_i hh; exact hh.2
      · cases h

/-- With digits enough to write `a / b` exactly, the search finds a spelling. -/
theorem digitsAt_isSome {F : Format} {x : Flt} {neg : Bool} {a b : Nat} {n : Int} {k : Nat} (hb : 0 < b)
    (hk : n < k) (hdiv : b ∣ a * 10 ^ ((k : Int) - n).toNat) (hself : roundRat F neg a b = some x) :
    (digitsAt F x neg a b n k).isSome := by
  have hneg : ¬ 0 ≤ n - (k : Int) := by omega
  have hlo : roundsTo F x neg (a * 10 ^ ((k : Int) - n).toNat / b) (n - k) = true := by
    obtain ⟨c, hc⟩ := hdiv
    simp only [roundsTo, fraction, hneg, ↓reduceIte, beq_iff_eq]
    rw [← hself, hc, Nat.mul_div_cancel_left _ hb, show (-(n - (k : Int))).toNat = ((k : Int) - n).toNat by omega]
    apply roundRat_cross F neg (Nat.pow_pos (by decide)) hb
    rw [Nat.mul_comm c, hc]
  unfold digitsAt
  simp only [hneg, ↓reduceIte, hlo, Bool.true_and]
  split
  · split <;> rfl
  · rfl

theorem shortest_some {F : Format} {x : Flt} {neg : Bool} {a b : Nat} {n : Int} :
    ∀ {fuel k0 d k : Nat}, shortest F x neg a b n fuel k0 = some (d, k) → digitsAt F x neg a b n k = some d
  | 0, _, _, _, h => by simp [shortest] at h
  | fuel + 1, k0, d, k, h => by
    simp only [shortest] at h
    cases hd : digitsAt F x neg a b n k0 with
    | some d' =>
      rw [hd] at h
      simp only [Option.map_some, Option.some_or, Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      exact hd
    | none =>
      rw [hd] at h
      simp only [Option.map_none, Option.none_or] at h
      exact shortest_some h

theorem shortest_isSome {F : Format} {x : Flt} {neg : Bool} {a b : Nat} {n : Int} {k : Nat}
    (hk : (digitsAt F x neg a b n k).isSome) :
    ∀ {fuel k0 : Nat}, k0 ≤ k → k < k0 + fuel → (shortest F x neg a b n fuel k0).isSome
  | 0, _, h1, h2 => by omega
  | fuel + 1, k0, h1, h2 => by
    simp only [shortest]
    cases hd : digitsAt F x neg a b n k0 with
    | some d' => rfl
    | none =>
      simp only [Option.map_none, Option.none_or]
      by_cases he : k0 = k
      · subst he; rw [hd] at hk; cases hk
      · exact shortest_isSome hk (by omega) (by omega)

/-! ## Spelling a float -/

/-- What the search needs of a format: its floats have at most 1000 digits before the point and after it. -/
structure Format.Fits (F : Format) : Prop where
  prec : 1 ≤ F.prec
  range : F.emin ≤ F.emax
  large : 2 ^ F.prec * 2 ^ F.emax.toNat ≤ 10 ^ 1000
  digits : 2 ^ F.prec ≤ 10 ^ 16
  small : (-F.emin).toNat ≤ 1080

theorem binary64_fits : binary64.Fits := ⟨by decide, by decide, by decide +kernel, by decide +kernel, by decide⟩
theorem binary32_fits : binary32.Fits := ⟨by decide, by decide, by decide +kernel, by decide +kernel, by decide⟩

theorem FloatType.fits : ∀ k : FloatType, k.format.Fits
  | .f32 => binary32_fits
  | .f64 => binary64_fits

theorem decimalExponent_le (a b : Nat) : decimalExponent a b ≤ (Nat.toDigits 10 a).length := by
  have : (Nat.toDigits 10 b).length ≠ 0 := by simp [Nat.toDigits_ne_nil]
  unfold decimalExponent
  simp only
  split <;> omega

theorem toDigits_length_le {a j : Nat} (hj : 0 < j) (h : a < 10 ^ j) : (Nat.toDigits 10 a).length ≤ j :=
  (Nat.length_toDigits_le_iff (by decide) hj).mpr h

/-- A float of the format rounds to itself. -/
theorem roundRat_self {F : Format} {neg : Bool} {m : Nat} {q : Int} (hn : Normal F m q) (hm : 0 < m) :
    roundRat F neg (Flt.fin neg m q).fraction.1 (Flt.fin neg m q).fraction.2 = some (.fin neg m q) := by
  unfold roundRat
  by_cases hq : 0 ≤ q
  · simp only [Flt.fraction, hq, ↓reduceIte]
    rw [roundMag_self hn hm (P := q.toNat) (S := 0) (by decide) (by omega) (by simp)]
    rfl
  · simp only [Flt.fraction, hq, ↓reduceIte]
    rw [roundMag_self hn hm (P := 0) (S := (-q).toNat) (Nat.two_pow_pos _) (by omega) (by simp)]
    rfl

/-- For a float of a format that fits, the search finds a spelling. -/
theorem shortest_float {F : Format} (hF : F.Fits) {neg : Bool} {m : Nat} {q : Int} (hn : Normal F m q) (hm : 0 < m) :
    let x := Flt.fin neg m q
    (shortest F x neg x.fraction.1 x.fraction.2 (decimalExponent x.fraction.1 x.fraction.2) 1100 1).isSome := by
  intro x
  have hself := roundRat_self (neg := neg) hn hm
  generalize hn' : decimalExponent x.fraction.1 x.fraction.2 = n
  have hle := decimalExponent_le x.fraction.1 x.fraction.2
  rw [hn'] at hle
  by_cases hq : 0 ≤ q
  · have ha : x.fraction = (m * 2 ^ q.toNat, 1) := by simp only [x, Flt.fraction, hq, ↓reduceIte]
    rw [ha] at hself hle ⊢
    dsimp only at hle
    have hlen : (Nat.toDigits 10 (m * 2 ^ q.toNat)).length ≤ 1000 := by
      apply toDigits_length_le (by decide)
      have : 2 ^ q.toNat ≤ 2 ^ F.emax.toNat := Nat.pow_le_pow_right (by decide) (by have := hn.le; omega)
      have := Nat.mul_lt_mul_of_lt_of_le hn.lt this (Nat.two_pow_pos _)
      exact Nat.lt_of_lt_of_le this hF.large
    apply shortest_isSome (k := n.toNat + 1)
      (digitsAt_isSome (by decide) (by omega) (Nat.one_dvd _) hself) (by omega) (by omega)
  · have ha : x.fraction = (m, 2 ^ (-q).toNat) := by simp only [x, Flt.fraction, hq, ↓reduceIte]
    rw [ha] at hself hle ⊢
    dsimp only at hle
    have hlen : (Nat.toDigits 10 m).length ≤ 16 :=
      toDigits_length_le (by decide) (Nat.lt_of_lt_of_le hn.lt hF.digits)
    have hs : (-q).toNat ≤ 1080 := by have := hn.ge; have := hF.small; omega
    apply shortest_isSome (k := (n + (-q).toNat).toNat + 1) (digitsAt_isSome (Nat.two_pow_pos _) (by omega) ?_ hself)
      (by omega) (by omega)
    apply Nat.dvd_mul_left_of_dvd
    rw [show (10 : Nat) = 2 * 5 from rfl, Nat.mul_pow]
    apply Nat.dvd_mul_right_of_dvd
    exact Nat.pow_dvd_pow 2 (by omega)

/-! ## Reading the layout back -/

/-- The exponent part of a literal, as `decimal?` reads it. -/
def expOf (t : Text) : Option Int := match t with
  | [] => some 0
  | 'e' :: '-' :: ds => if ds ≠ [] && ds.all isDigit then some (-(digitsValue 10 ds : Int)) else none
  | 'e' :: ds => if ds ≠ [] && ds.all isDigit then some (digitsValue 10 ds) else none
  | _ => none

/-- The fraction part of a literal and what follows it, as `decimal?` reads them. -/
def fracOf (t : Text) : Text × Text := match t with
  | '.' :: r => (r.takeWhile isDigit, r.dropWhile isDigit)
  | r => ([], r)

/-- `decimal?` after the sign. -/
def decBody (neg : Bool) (t : Text) : Option (Bool × Nat × Int) :=
  let int := t.takeWhile isDigit
  let (frac, t) := fracOf (t.dropWhile isDigit)
  if int.isEmpty then none else
  (expOf t).map fun e => (neg, digitsValue 10 (int ++ frac), e - frac.length)

theorem decimal?_minus (t : Text) : decimal? ('-' :: t) = decBody true t := rfl

theorem decimal?_plain {c : Char} {t : Text} (hc : c ≠ '-') : decimal? (c :: t) = decBody false (c :: t) := by
  unfold decimal?
  split
  · rename_i neg t' heq
    split at heq
    · rename_i h; cases h; exact absurd rfl hc
    · cases heq; rfl

/-- Digits, then something that is not a digit. -/
theorem digits_split {l r : Text} (hl : ∀ c ∈ l, isDigit c = true)
    (hr : ∀ c r', r = c :: r' → isDigit c = false) :
    (l ++ r).takeWhile isDigit = l ∧ (l ++ r).dropWhile isDigit = r := by
  induction l with
  | nil =>
    cases r with
    | nil => simp
    | cons c r => simp [hr c r rfl]
  | cons c l ih =>
    obtain ⟨h1, h2⟩ := ih fun c hc => hl c (List.mem_cons_of_mem _ hc)
    simp [hl c List.mem_cons_self, h1, h2]

theorem decBody_eq (neg : Bool) {i rest : Text} (hi : i ≠ []) (hd : ∀ c ∈ i, isDigit c = true)
    (hr : ∀ c r', rest = c :: r' → isDigit c = false) :
    decBody neg (i ++ rest) = (expOf (fracOf rest).2).map
      fun e => (neg, digitsValue 10 (i ++ (fracOf rest).1), e - ((fracOf rest).1.length : Int)) := by
  obtain ⟨h1, h2⟩ := digits_split hd hr
  have : i.isEmpty = false := by cases i <;> simp_all
  simp only [decBody, h1, h2, this, Bool.false_eq_true, ↓reduceIte]

theorem fracOf_dot {f r : Text} (hf : ∀ c ∈ f, isDigit c = true) (hr : ∀ c r', r = c :: r' → isDigit c = false) :
    fracOf ('.' :: (f ++ r)) = (f, r) := by
  obtain ⟨h1, h2⟩ := digits_split hf hr
  simp only [fracOf, h1, h2]

theorem expOf_intText (e : Int) : expOf ('e' :: RoundTrip.intText (decide (e < 0)) e.natAbs) = some e := by
  have hd : ∀ v : Nat, (Nat.toDigits 10 v ≠ [] && (Nat.toDigits 10 v).all isDigit) = true := by
    intro v
    simp only [Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true]
    exact ⟨Nat.toDigits_ne_nil, RoundTrip.toDigits_decimal⟩
  have hv := RoundTrip.digitsValue_toDigits (b := 10) (by decide) (by decide) e.natAbs
  unfold RoundTrip.intText
  by_cases he : e < 0
  · have : (decide (e < 0) && e.natAbs != 0) = true := by simp; omega
    simp only [this, ↓reduceIte, List.cons_append, List.nil_append, expOf, hd, hv]
    congr 1; omega
  · have : (decide (e < 0) && e.natAbs != 0) = false := by simp; omega
    simp only [this, Bool.false_eq_true, ↓reduceIte, List.nil_append]
    have hm := RoundTrip.toDigits_not_minus 10 e.natAbs (by decide) (by decide)
    obtain ⟨c, r, hcr⟩ : ∃ c r, Nat.toDigits 10 e.natAbs = c :: r := by
      cases h : Nat.toDigits 10 e.natAbs with
      | nil => exact absurd h Nat.toDigits_ne_nil
      | cons c r => exact ⟨c, r, rfl⟩
    have hd' := hd e.natAbs
    rw [hcr] at hm hd' hv ⊢
    have hc : c ≠ '-' := by simpa using hm
    unfold expOf
    split
    · rename_i h; simp at h
    · rename_i h; simp only [List.cons.injEq] at h; exact absurd h.2.1 hc
    · rename_i h
      simp only [List.cons.injEq] at h
      obtain ⟨-, rfl⟩ := h
      simp only [hd', hv, ↓reduceIte]
      congr 1; omega
    · rename_i h1 h2 h3; exact (h3 (c :: r) rfl).elim

theorem isDigit_replicate (j : Nat) : ∀ c ∈ List.replicate j '0', isDigit c = true := by
  intro c hc; rw [List.eq_of_mem_replicate hc]; rfl

theorem digitsValue_zeros (l : Text) : ∀ j, digitsValue 10 (l ++ List.replicate j '0') = digitsValue 10 l * 10 ^ j
  | 0 => by simp
  | j + 1 => by
    rw [List.replicate_succ', ← List.append_assoc, RoundTrip.digitsValue_append, digitsValue_zeros l j,
      Nat.pow_succ, ← Nat.mul_assoc]
    rfl

theorem digitsValue_leadingZeros (l : Text) : ∀ j, digitsValue 10 (List.replicate j '0' ++ l) = digitsValue 10 l
  | 0 => rfl
  | j + 1 => by
    rw [List.replicate_succ, List.cons_append, RoundTrip.digitsValue_cons_zero, digitsValue_leadingZeros l j]

theorem not_digit_dot : isDigit '.' = false := rfl
theorem not_digit_e : isDigit 'e' = false := rfl

theorem decBody_some (neg : Bool) {i rest f r : Text} {e : Int} (hi : i ≠ []) (hd : ∀ c ∈ i, isDigit c = true)
    (hr : ∀ c r', rest = c :: r' → isDigit c = false) (hfr : fracOf rest = (f, r)) (he : expOf r = some e) :
    decBody neg (i ++ rest) = some (neg, digitsValue 10 (i ++ f), e - f.length) := by
  rw [decBody_eq neg hi hd hr, hfr, he]; rfl

/--
**The layout reads back**: the text `layout` writes for the digits `ds` and
the exponent `n` reads as a literal whose value is `0.ds · 10^n`.
-/
theorem decBody_layout (neg : Bool) {ds : Text} (hne : ds ≠ []) (hd : ∀ c ∈ ds, isDigit c = true) (n : Int) :
    ∃ D E, decBody neg (layout ds n) = some (neg, D, E) ∧
      fraction D E = fraction (digitsValue 10 ds) (n - ds.length) := by
  have hlen : 0 < ds.length := List.length_pos_iff.mpr hne
  have dot : ∀ (r : Text) c r', '.' :: r = c :: r' → isDigit c = false := by
    intro r c r' h; cases h; rfl
  have ee : ∀ (r : Text) c r', 'e' :: r = c :: r' → isDigit c = false := by
    intro r c r' h; cases h; rfl
  have nil : ∀ c r', ([] : Text) = c :: r' → isDigit c = false := by intro c r' h; cases h
  have htake : ∀ j, ∀ c ∈ ds.take j, isDigit c = true := fun j c hc => hd c (List.mem_of_mem_take hc)
  have hdrop : ∀ j, ∀ c ∈ ds.drop j, isDigit c = true := fun j c hc => hd c (List.mem_of_mem_drop hc)
  have htake1 : ds.take 1 ≠ [] := by cases ds <;> simp_all
  simp only [layout]
  by_cases h1 : (ds.length : Int) ≤ n ∧ n ≤ 21
  · have hb : (decide ((ds.length : Int) ≤ n) && decide (n ≤ 21)) = true := by simp [h1]
    simp only [hb, ↓reduceIte]
    rw [← List.append_nil (ds ++ _)]
    refine ⟨_, _, decBody_some neg (by simp [hne])
      (fun c hc => (List.mem_append.mp hc).elim (hd c) (isDigit_replicate _ c)) nil rfl rfl, ?_⟩
    have hnn : ¬ (n - ds.length < 0) := by omega
    simp only [List.append_nil, digitsValue_zeros, fraction, Int.sub_zero, List.length_nil, Int.cast_ofNat_Int,
      Int.le_refl, ↓reduceIte, Int.toNat_zero, Nat.pow_zero, Nat.mul_one, Int.sub_nonneg.mpr h1.1]
  · have hb : (decide ((ds.length : Int) ≤ n) && decide (n ≤ 21)) = false := by simp; omega
    simp only [hb, Bool.false_eq_true, ↓reduceIte]
    by_cases h2 : 0 < n ∧ n ≤ 21
    · have hb2 : (decide (0 < n) && decide (n ≤ 21)) = true := by simp [h2]
      simp only [hb2, ↓reduceIte]
      rw [← List.append_nil (List.drop _ ds)]
      have hi : ds.take n.toNat ≠ [] := by
        simp only [ne_eq, List.take_eq_nil_iff, not_or]; exact ⟨by omega, hne⟩
      refine ⟨_, _, decBody_some neg hi (htake _) (dot _) (fracOf_dot (hdrop _) nil) rfl, ?_⟩
      rw [List.take_append_drop, List.length_drop]
      congr 1; omega
    · have hb2 : (decide (0 < n) && decide (n ≤ 21)) = false := by simp; omega
      simp only [hb2, Bool.false_eq_true, ↓reduceIte]
      by_cases h3 : -6 < n ∧ n ≤ 0
      · have hb3 : (decide (-6 < n) && decide (n ≤ 0)) = true := by simp [h3]
        simp only [hb3, ↓reduceIte]
        rw [show ('0' :: '.' :: List.replicate (-n).toNat '0') ++ ds =
          ['0'] ++ '.' :: ((List.replicate (-n).toNat '0' ++ ds) ++ []) by simp]
        refine ⟨_, _, decBody_some neg (by simp) (by simp; rfl) (dot _)
          (fracOf_dot (fun c hc => (List.mem_append.mp hc).elim (isDigit_replicate _ c) (hd c)) nil) rfl, ?_⟩
        rw [List.singleton_append, RoundTrip.digitsValue_cons_zero, digitsValue_leadingZeros,
          List.length_append, List.length_replicate]
        congr 1; omega
      · have hb3 : (decide (-6 < n) && decide (n ≤ 0)) = false := by simp; omega
        simp only [hb3, Bool.false_eq_true, ↓reduceIte]
        by_cases h4 : ds.length > 1
        · simp only [h4, ↓reduceIte, List.append_assoc, List.cons_append]
          refine ⟨_, _, decBody_some neg htake1 (htake _) (dot _) (fracOf_dot (hdrop _) (ee _))
            (expOf_intText _), ?_⟩
          rw [List.take_append_drop, List.length_drop]
          congr 1; omega
        · simp only [h4, ↓reduceIte, List.append_nil]
          refine ⟨_, _, decBody_some neg htake1 (htake _) (ee _) rfl (expOf_intText _), ?_⟩
          rw [List.append_nil, List.take_of_length_le (by omega)]
          congr 1; simp; omega

/-! ## The law -/

theorem mem_takeWhile {p : Char → Bool} : ∀ {l : Text} {x : Char}, x ∈ l.takeWhile p → p x = true
  | [], _, h => by simp at h
  | c :: l, x, h => by
    by_cases hc : p c = true
    · simp only [List.takeWhile, hc, List.mem_cons] at h
      rcases h with rfl | h
      · exact hc
      · exact mem_takeWhile h
    · simp [List.takeWhile, hc] at h

/-- Stripping trailing zeros: the digits are the stripped digits, then zeros. -/
theorem stripTrailing_zeros (l : Text) : ∃ z, l = stripTrailing l ++ List.replicate z '0' := by
  have h := List.takeWhile_append_dropWhile (p := (· == '0')) (l := l.reverse)
  have hz : l.reverse.takeWhile (· == '0') = List.replicate (l.reverse.takeWhile (· == '0')).length '0' :=
    List.eq_replicate_iff.mpr ⟨rfl, fun c hc => by simpa using mem_takeWhile hc⟩
  refine ⟨(l.reverse.takeWhile (· == '0')).length, ?_⟩
  conv => lhs; rw [← List.reverse_reverse l, ← h, hz]
  rw [List.reverse_append, List.reverse_replicate]
  rfl

theorem fraction_pos (m : Nat) (e : Int) : 0 < (fraction m e).2 := by
  unfold fraction; split
  · exact Nat.one_pos
  · exact Nat.pow_pos (by decide)

/-- `(V · 10^z) · 10^e` and `V · 10^(e + z)` are the same value. -/
theorem fraction_shift (V z : Nat) (e : Int) :
    (fraction (V * 10 ^ z) e).1 * (fraction V (e + z)).2 = (fraction V (e + z)).1 * (fraction (V * 10 ^ z) e).2 := by
  unfold fraction
  by_cases he : 0 ≤ e
  · have : 0 ≤ e + z := by omega
    simp only [he, this, ↓reduceIte, Nat.mul_one, Nat.mul_assoc, ← Nat.pow_add]
    congr 2; omega
  · simp only [he, ↓reduceIte]
    by_cases hz : 0 ≤ e + z
    · simp only [hz, ↓reduceIte, Nat.mul_one, Nat.mul_assoc, ← Nat.pow_add]
      congr 2; omega
    · simp only [hz, ↓reduceIte, Nat.mul_assoc, ← Nat.pow_add]
      congr 2; omega

/-- A literal `decBody` reads starts with a digit. -/
theorem decBody_head {neg : Bool} {t : Text} {r : Bool × Nat × Int} (h : decBody neg t = some r) :
    ∃ c t', t = c :: t' ∧ isDigit c = true := by
  cases t with
  | nil => simp [decBody] at h
  | cons c t' =>
    refine ⟨c, t', rfl, ?_⟩
    cases hc : isDigit c
    · simp [decBody, hc] at h
    · rfl

theorem decimal?_sign {neg : Bool} {t : Text} {r : Bool × Nat × Int} (h : decBody neg t = some r) :
    decimal? ((if neg then "-" else "").toList ++ t) = some r := by
  cases neg
  · obtain ⟨c, t', rfl, hc⟩ := decBody_head h
    have : c ≠ '-' := by rintro rfl; cases hc
    rw [← h]; exact decimal?_plain this
  · exact h

theorem fraction_zero (e : Int) : (fraction 0 e).1 = 0 := by
  unfold fraction; split <;> simp

/-- **The spelling of a float rounds back to it.** -/
theorem spell_fin (k : FloatType) {neg : Bool} {m : Nat} {q : Int} (hn : Normal k.format m q) :
    roundLit k (spell k (.fin neg m q)) = some (.fin neg m q) := by
  unfold spell
  simp only
  by_cases hm : m = 0
  · subst hm
    have hq : q = k.format.emin :=
      hn.norm.resolve_left (by have := Nat.two_pow_pos (k.format.prec - 1); omega)
    subst hq
    simp only [↓reduceIte]
    cases neg <;> cases k <;> rfl
  · simp only [hm, ↓reduceIte]
    have hsome := shortest_float k.fits (neg := neg) hn (by omega)
    split
    · rename_i d k' hs
      have hr := digitsAt_some (shortest_some hs)
      simp only [roundsTo, beq_iff_eq] at hr
      generalize decimalExponent _ _ = n at hr ⊢
      have hd0 : d ≠ 0 := by
        rintro rfl
        rw [fraction_zero, roundRat, roundMag_zero] at hr
        simp only [Option.map_some, Option.some.injEq, Flt.fin.injEq] at hr
        omega
      obtain ⟨z, hz⟩ := stripTrailing_zeros (Nat.toDigits 10 d)
      generalize stripTrailing (Nat.toDigits 10 d) = s at hz ⊢
      have hV : d = digitsValue 10 s * 10 ^ z := by
        rw [← digitsValue_zeros, ← hz, RoundTrip.digitsValue_toDigits (by decide) (by decide)]
      have hsne : s ≠ [] := by rintro rfl; simp [digitsValue] at hV; omega
      have hsd : ∀ c ∈ s, isDigit c = true := fun c hc =>
        RoundTrip.toDigits_decimal c (by rw [hz]; exact List.mem_append_left _ hc)
      have hlen : (Nat.toDigits 10 d).length = s.length + z := by
        conv => lhs; rw [hz]
        simp
      obtain ⟨D, E, hdec, hfr⟩ := decBody_layout neg hsne hsd (n - k' + (Nat.toDigits 10 d).length)
      unfold roundLit
      rw [String.toList_append, String.toList_ofList, decimal?_sign hdec]
      simp only [Option.bind_some]
      rw [hfr, ← hr, show n - k' + ((Nat.toDigits 10 d).length : Int) - s.length = (n - k') + z by omega, hV]
      exact roundRat_cross _ _ (fraction_pos _ _) (fraction_pos _ _) (fraction_shift _ _ _).symm
    · rename_i hs
      simp only [hs] at hsome
      cases hsome

/--
**`FloatLaw`** (§15): the spelling of a decoded float, in `Float64` or
`Float32`, decodes to the same float.
-/
theorem floatLaw : FloatLaw := by
  intro k lit x h
  unfold roundLit at h
  obtain ⟨⟨neg, M, e⟩, -, h⟩ := Option.bind_eq_some_iff.mp h
  obtain ⟨⟨m, q⟩, hm, rfl⟩ := Option.map_eq_some_iff.mp h
  exact spell_fin k (roundMag_normal k.fits.prec k.fits.range (fraction_pos M e) hm)

end Haus.Schema
