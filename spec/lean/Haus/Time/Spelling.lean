import Haus.Time.Calendar
import Haus.Time.Props
import Haus.Time.Correct

/-!
# std/time: one spelling per value (plan step T6)

`std/time.md` ("Values") says which valid strings denote the same time:
trailing zeros in a fraction of a second never change the value, and an
`Instant` (or the instant of a `ZonedDateTime`) can be written with any
offset. Every other value has exactly one spelling. This file proves it.

* `fraction_eq_iff`: two fractions denote the same nanoseconds exactly
  when they are equal after removing trailing zeros (`.250` and `.25`,
  `.0` and nothing).
* `ZerosOnly s s'`: `s` and `s'` differ at most in trailing zeros of one
  fraction.
* For every type, two valid strings have the same value exactly when
  `ZerosOnly` holds (for `Instant` and `ZonedDateTime`: when their offsets
  are the same). `Date`, `YearMonth` and `TimeZone` have no fraction, so
  the same value means the same string.
-/

namespace Haus.Time
open Haus RoundTrip

/-! ## Fractions -/

/-- The digits without trailing zeros. -/
def stripZeros (ds : Text) : Text := (ds.reverse.dropWhile (· == '0')).reverse

/-- A fraction without trailing zeros: `.250` → `.25`, `.0` → nothing. -/
def stripFraction : Text → Text
  | '.' :: ds => if stripZeros ds = [] then [] else '.' :: stripZeros ds
  | _ => []

theorem num_zeros (a : Text) (k : Nat) : num (a ++ List.replicate k '0') = num a * 10 ^ k := by
  induction k with
  | zero => simp
  | succ k ih =>
    rw [List.replicate_succ', ← List.append_assoc]
    simp only [num, digitsValue_append] at ih ⊢
    rw [ih, Nat.pow_succ]
    have : hexValue '0' = 0 := by decide
    rw [this, Nat.add_zero, Nat.mul_assoc]

theorem dropWhile_zeros (k : Nat) (x : Text) :
    (List.replicate k '0' ++ x).dropWhile (· == '0') = x.dropWhile (· == '0') := by
  induction k with
  | zero => rfl
  | succ k ih => simp [List.replicate_succ, ih]

theorem stripZeros_zeros (x : Text) (k : Nat) : stripZeros (x ++ List.replicate k '0') = stripZeros x := by
  simp [stripZeros, List.reverse_append]

theorem stripZeros_spec (ds : Text) : ∃ k, ds = stripZeros ds ++ List.replicate k '0' := by
  obtain ⟨n, hn⟩ : ∃ n, ds.reverse.takeWhile (· == '0') = List.replicate n '0' :=
    ⟨_, List.eq_replicate_iff.mpr ⟨rfl, fun c hc => by simpa using mem_takeWhile hc⟩⟩
  refine ⟨n, ?_⟩
  unfold stripZeros
  conv => lhs; rw [← List.reverse_reverse ds, ← List.takeWhile_append_dropWhile (p := (· == '0')) (l := ds.reverse), hn]
  simp [List.reverse_replicate]

/-- A fraction's digits padded to nine: its nanoseconds as text. -/
def pad9 (ds : Text) : Text := ds ++ List.replicate (9 - ds.length) '0'

theorem fractionNanos_pad (ds : Text) : fractionNanos ('.' :: ds) = num (pad9 ds) := by
  simp [fractionNanos, pad9, num_zeros]

theorem pad9_digits {ds : Text} (h : ds.length ≤ 9) (hd : ∀ c ∈ ds, isDigit c = true) : DigitsN 9 (pad9 ds) := by
  refine ⟨by simp [pad9]; omega, fun c hc => ?_⟩
  simp only [pad9, List.mem_append, List.mem_replicate] at hc
  rcases hc with hc | ⟨-, rfl⟩
  · exact hd c hc
  · decide

theorem stripZeros_pad9 (ds : Text) : stripZeros (pad9 ds) = stripZeros ds := stripZeros_zeros _ _

/-- Two lists of nine digits with the same value are the same. -/
theorem digits9_inj {a b : Text} (ha : DigitsN 9 a) (hb : DigitsN 9 b) (h : num a = num b) : a = b := by
  rw [← pad_num 9 a ha, ← pad_num 9 b hb, h]

theorem pad9_of_strip {a b : Text} (ha : a.length ≤ 9) (hb : b.length ≤ 9) (h : stripZeros a = stripZeros b) :
    pad9 a = pad9 b := by
  obtain ⟨k, hk⟩ := stripZeros_spec a
  obtain ⟨k', hk'⟩ := stripZeros_spec b
  have la := congrArg List.length hk
  have lb := congrArg List.length hk'
  simp only [List.length_append, List.length_replicate] at la lb
  unfold pad9
  rw [hk, hk', h]
  simp only [List.append_assoc, List.append_cancel_left_eq, List.replicate_append_replicate]
  rw [h] at la
  congr 1
  simp only [List.length_append, List.length_replicate]
  omega

/-- **Two fractions denote the same nanoseconds exactly when they agree after removing trailing zeros.** -/
theorem fraction_eq_iff {f f' : Text} (h : Fraction f) (h' : Fraction f') :
    fractionNanos f = fractionNanos f' ↔ stripFraction f = stripFraction f' := by
  -- A fraction as at most nine digits (none for no fraction).
  have rep : ∀ {f}, Fraction f → ∃ ds, ds.length ≤ 9 ∧ (∀ c ∈ ds, isDigit c = true) ∧
      fractionNanos f = num (pad9 ds) ∧ stripFraction f = stripFraction ('.' :: ds) := by
    intro f hf
    rcases hf with rfl | ⟨ds, rfl, -, h9, hd⟩
    · refine ⟨[], by simp, by simp, ?_, by simp [stripFraction, stripZeros]⟩
      decide
    · exact ⟨ds, h9, hd, fractionNanos_pad ds, rfl⟩
  obtain ⟨a, ha, hda, ea, sa⟩ := rep h
  obtain ⟨b, hb, hdb, eb, sb⟩ := rep h'
  rw [ea, eb, sa, sb]
  have step1 : num (pad9 a) = num (pad9 b) ↔ stripZeros a = stripZeros b := by
    constructor
    · intro e
      have := digits9_inj (pad9_digits ha hda) (pad9_digits hb hdb) e
      rw [← stripZeros_pad9 a, ← stripZeros_pad9 b, this]
    · intro e; rw [pad9_of_strip ha hb e]
  rw [step1]
  simp only [stripFraction]
  constructor
  · intro e; rw [e]
  · intro e
    by_cases h1 : stripZeros a = [] <;> by_cases h2 : stripZeros b = [] <;> simp_all

/-! ## Fractions inside a string -/

/-- The text with the fraction after its first `.` written without trailing zeros. -/
def normFrac : Text → Text
  | [] => []
  | '.' :: r => stripFraction ('.' :: r.takeWhile isDigit) ++ r.dropWhile isDigit
  | c :: r => c :: normFrac r

theorem normFrac_cons {c : Char} (hc : c ≠ '.') (r : Text) : normFrac (c :: r) = c :: normFrac r := by
  rw [normFrac.eq_3 c r hc]

theorem normFrac_append {p : Text} (hp : '.' ∉ p) (x : Text) : normFrac (p ++ x) = p ++ normFrac x := by
  induction p with
  | nil => rfl
  | cons c p ih =>
    simp only [List.mem_cons, not_or] at hp
    rw [List.cons_append, normFrac_cons (Ne.symm hp.1), ih hp.2]; rfl

theorem normFrac_nodot {b : Text} (hb : '.' ∉ b) : normFrac b = b := by
  have := normFrac_append hb []
  simp only [List.append_nil] at this
  rw [this]; simp [normFrac]

/-- A fraction followed by text that continues neither it nor another fraction. -/
theorem normFrac_frac {f b : Text} (hf : Fraction f) (hb : '.' ∉ b) (hbd : ∀ c, b.head? = some c → isDigit c = false) :
    normFrac (f ++ b) = stripFraction f ++ b := by
  rcases hf with rfl | ⟨ds, rfl, -, -, hd⟩
  · simp [normFrac_nodot hb, stripFraction]
  · obtain ⟨ht, hdw⟩ := takeWhile_append hd hbd
    simp only [List.cons_append, normFrac, ht, hdw]

/-! ## Digits -/

theorem digit_eq {a b : Char} (ha : isDigit a = true) (hb : isDigit b = true) (h : hexValue a = hexValue b) : a = b := by
  rw [← digitChar_hexValue ha, ← digitChar_hexValue hb, h]

theorem num2 (a b : Char) : num [a, b] = hexValue a * 10 + hexValue b := by simp [num, digitsValue]
theorem num4 (a b c d : Char) : num [a, b, c, d] = ((hexValue a * 10 + hexValue b) * 10 + hexValue c) * 10 + hexValue d := by
  simp [num, digitsValue]

theorem digits4 {t : Text} (h : DigitsN 4 t) :
    ∃ a b c d, t = [a, b, c, d] ∧ isDigit a = true ∧ isDigit b = true ∧ isDigit c = true ∧ isDigit d = true := by
  obtain ⟨hl, hd⟩ := h
  match t, hl with
  | [a, b, c, d], _ => exact ⟨a, b, c, d, rfl, hd a (by simp), hd b (by simp), hd c (by simp), hd d (by simp)⟩

/-! ## Time -/

/-- The value of a `Time`: nanoseconds since midnight. -/
def timeValue : Text → Nat
  | h1 :: h2 :: _ :: m1 :: m2 :: _ :: s1 :: s2 :: f =>
    ((num [h1, h2] * 60 + num [m1, m2]) * 60 + num [s1, s2]) * 10 ^ 9 + fractionNanos f
  | _ => 0

theorem time_shape {s : Text} (h : Time s) : ∃ h1 h2 m1 m2 s1 s2 f,
    s = [h1, h2, ':', m1, m2, ':', s1, s2] ++ f ∧ isDigit h1 = true ∧ isDigit h2 = true ∧ isDigit m1 = true ∧
    isDigit m2 = true ∧ isDigit s1 = true ∧ isDigit s2 = true ∧ Fraction f ∧
    num [h1, h2] ≤ 23 ∧ num [m1, m2] ≤ 59 ∧ num [s1, s2] ≤ 59 := by
  obtain ⟨th, tm, ts, f, rfl, hh, hm, hs, hf, b1, b2, b3⟩ := h
  obtain ⟨h1, h2, rfl, d1, d2⟩ := digits2 hh
  obtain ⟨m1, m2, rfl, d3, d4⟩ := digits2 hm
  obtain ⟨s1, s2, rfl, d5, d6⟩ := digits2 hs
  exact ⟨h1, h2, m1, m2, s1, s2, f, by simp, d1, d2, d3, d4, d5, d6, hf, b1, b2, b3⟩

/-- **Two valid `Time`s are the same time exactly when they differ at most in trailing zeros of the fraction.** -/
theorem time_same_iff {s s' : Text} (h : Time s) (h' : Time s') :
    timeValue s = timeValue s' ↔ normFrac s = normFrac s' := by
  obtain ⟨h1, h2, m1, m2, s1, s2, f, rfl, d1, d2, d3, d4, d5, d6, hf, b1, b2, b3⟩ := time_shape h
  obtain ⟨h1', h2', m1', m2', s1', s2', f', rfl, d1', d2', d3', d4', d5', d6', hf', b1', b2', b3'⟩ := time_shape h'
  have np : ∀ x y z u v w (g : Text), '.' ∉ [x, y, ':', z, u, ':', v, w] → normFrac ([x, y, ':', z, u, ':', v, w] ++ g) =
      [x, y, ':', z, u, ':', v, w] ++ normFrac g := fun _ _ _ _ _ _ g hp => normFrac_append hp g
  have dot : ∀ c, isDigit c = true → '.' ≠ c := by intro c hc; rintro rfl; revert hc; decide
  have nf := normFrac_frac (b := []) hf (by simp) (by simp)
  have nf' := normFrac_frac (b := []) hf' (by simp) (by simp)
  simp only [List.append_nil] at nf nf'
  rw [np _ _ _ _ _ _ _ (by simp [dot _ d1, dot _ d2, dot _ d3, dot _ d4, dot _ d5, dot _ d6]),
    np _ _ _ _ _ _ _ (by simp [dot _ d1', dot _ d2', dot _ d3', dot _ d4', dot _ d5', dot _ d6']), nf, nf']
  simp only [List.cons_append, List.nil_append, timeValue, List.cons.injEq, true_and, num2] at b1 b2 b3 b1' b2' b3' ⊢
  have v := fun c (hc : isDigit c = true) => hexValue_digit hc
  have n1 := Fraction.nanos_lt hf
  have n2 := Fraction.nanos_lt hf'
  have v1 := v _ d1; have v2 := v _ d2; have v3 := v _ d3; have v4 := v _ d4; have v5 := v _ d5; have v6 := v _ d6
  have w1 := v _ d1'; have w2 := v _ d2'; have w3 := v _ d3'; have w4 := v _ d4'; have w5 := v _ d5'; have w6 := v _ d6'
  constructor
  · intro e
    have e1 : hexValue h1 = hexValue h1' := by omega
    have e2 : hexValue h2 = hexValue h2' := by omega
    have e3 : hexValue m1 = hexValue m1' := by omega
    have e4 : hexValue m2 = hexValue m2' := by omega
    have e5 : hexValue s1 = hexValue s1' := by omega
    have e6 : hexValue s2 = hexValue s2' := by omega
    have e7 : fractionNanos f = fractionNanos f' := by omega
    exact ⟨digit_eq d1 d1' e1, digit_eq d2 d2' e2, digit_eq d3 d3' e3, digit_eq d4 d4' e4, digit_eq d5 d5' e5,
      digit_eq d6 d6' e6, (fraction_eq_iff hf hf').mp e7⟩
  · rintro ⟨rfl, rfl, rfl, rfl, rfl, rfl, e⟩
    rw [(fraction_eq_iff hf hf').mpr e]

theorem timeValue_lt {s : Text} (h : Time s) : timeValue s < 86400 * 10 ^ 9 := by
  obtain ⟨h1, h2, m1, m2, s1, s2, f, rfl, -, -, -, -, -, -, hf, b1, b2, b3⟩ := time_shape h
  have n := Fraction.nanos_lt hf
  simp only [List.cons_append, List.nil_append, timeValue]
  omega

/-! ## Date and YearMonth -/

/-- The value of a `Date` (and of a `DateTime`'s date): its day number. -/
def dateValue : Text → Nat
  | y1 :: y2 :: y3 :: y4 :: _ :: m1 :: m2 :: _ :: d1 :: d2 :: _ =>
    dayNumber (num [y1, y2, y3, y4]) (num [m1, m2]) (num [d1, d2])
  | _ => 0

theorem date_shape {s : Text} (h : Date s) : ∃ y1 y2 y3 y4 m1 m2 d1 d2,
    s = [y1, y2, y3, y4, '-', m1, m2, '-', d1, d2] ∧
    (∀ c ∈ [y1, y2, y3, y4, m1, m2, d1, d2], isDigit c = true) ∧
    DateOk (num [y1, y2, y3, y4]) (num [m1, m2]) (num [d1, d2]) := by
  obtain ⟨ty, tm, td, rfl, hy, hm, hd, hm1, hm2, hd1, hd2⟩ := h
  obtain ⟨y1, y2, y3, y4, rfl, e1, e2, e3, e4⟩ := digits4 hy
  obtain ⟨m1, m2, rfl, e5, e6⟩ := digits2 hm
  obtain ⟨d1, d2, rfl, e7, e8⟩ := digits2 hd
  have : num [y1, y2, y3, y4] ≤ 9999 := by
    have := hexValue_digit e1; have := hexValue_digit e2; have := hexValue_digit e3; have := hexValue_digit e4
    rw [num4]; omega
  exact ⟨y1, y2, y3, y4, m1, m2, d1, d2, by simp, by simp [e1, e2, e3, e4, e5, e6, e7, e8],
    ⟨this, hm1, hm2, hd1, hd2⟩⟩

/-- Digits with the same values are the same digits. -/
theorem digits_eq {cs cs' : Text} (h : ∀ c ∈ cs, isDigit c = true) (h' : ∀ c ∈ cs', isDigit c = true)
    (e : cs.map hexValue = cs'.map hexValue) : cs = cs' := by
  induction cs generalizing cs' with
  | nil => cases cs' <;> simp_all
  | cons c cs ih =>
    cases cs' with
    | nil => simp at e
    | cons c' cs' =>
      simp only [List.map_cons, List.cons.injEq] at e
      simp only [List.mem_cons, forall_eq_or_imp] at h h'
      rw [digit_eq h.1 h'.1 e.1, ih h.2 h'.2 e.2]

/-- **A `Date` has one spelling:** two valid dates are the same day exactly when they are the same string. -/
theorem date_same_iff {s s' : Text} (h : Date s) (h' : Date s') : dateValue s = dateValue s' ↔ s = s' := by
  refine ⟨fun e => ?_, fun e => e ▸ rfl⟩
  obtain ⟨y1, y2, y3, y4, m1, m2, d1, d2, rfl, hd, hok⟩ := date_shape h
  obtain ⟨y1', y2', y3', y4', m1', m2', d1', d2', rfl, hd', hok'⟩ := date_shape h'
  simp only [dateValue] at e
  obtain ⟨ey, em, ed⟩ := dateOk_iff_day.2.1 _ _ _ _ _ _ hok hok' e
  simp only [List.mem_cons, List.not_mem_nil, or_false, forall_eq_or_imp, forall_eq] at hd hd'
  have v := fun c (hc : isDigit c = true) => hexValue_digit hc
  have := v _ hd.1; have := v _ hd.2.1; have := v _ hd.2.2.1; have := v _ hd.2.2.2.1
  have := v _ hd.2.2.2.2.1; have := v _ hd.2.2.2.2.2.1; have := v _ hd.2.2.2.2.2.2.1; have := v _ hd.2.2.2.2.2.2.2
  have := v _ hd'.1; have := v _ hd'.2.1; have := v _ hd'.2.2.1; have := v _ hd'.2.2.2.1
  have := v _ hd'.2.2.2.2.1; have := v _ hd'.2.2.2.2.2.1; have := v _ hd'.2.2.2.2.2.2.1; have := v _ hd'.2.2.2.2.2.2.2
  rw [num4, num4] at ey; rw [num2, num2] at em ed
  have := digits_eq (cs := [y1, y2, y3, y4, m1, m2, d1, d2]) (cs' := [y1', y2', y3', y4', m1', m2', d1', d2'])
    (by simp [hd.1, hd.2.1, hd.2.2.1, hd.2.2.2.1, hd.2.2.2.2.1, hd.2.2.2.2.2.1, hd.2.2.2.2.2.2.1, hd.2.2.2.2.2.2.2])
    (by simp [hd'.1, hd'.2.1, hd'.2.2.1, hd'.2.2.2.1, hd'.2.2.2.2.1, hd'.2.2.2.2.2.1, hd'.2.2.2.2.2.2.1,
      hd'.2.2.2.2.2.2.2])
    (by simp only [List.map_cons, List.map_nil, List.cons.injEq, and_true]; omega)
  simp only [List.cons.injEq, and_true] at this
  obtain ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ := this
  rfl

/-- The value of a `YearMonth`: months since 0000-01. -/
def yearMonthValue : Text → Nat
  | y1 :: y2 :: y3 :: y4 :: _ :: m1 :: m2 :: _ => num [y1, y2, y3, y4] * 12 + num [m1, m2]
  | _ => 0

/-- **A `YearMonth` has one spelling.** -/
theorem yearMonth_same_iff {s s' : Text} (h : YearMonth s) (h' : YearMonth s') :
    yearMonthValue s = yearMonthValue s' ↔ s = s' := by
  refine ⟨fun e => ?_, fun e => e ▸ rfl⟩
  obtain ⟨ty, tm, rfl, hy, hm, hm1, hm2⟩ := h
  obtain ⟨ty', tm', rfl, hy', hm', hm1', hm2'⟩ := h'
  obtain ⟨y1, y2, y3, y4, rfl, e1, e2, e3, e4⟩ := digits4 hy
  obtain ⟨m1, m2, rfl, e5, e6⟩ := digits2 hm
  obtain ⟨y1', y2', y3', y4', rfl, e1', e2', e3', e4'⟩ := digits4 hy'
  obtain ⟨m1', m2', rfl, e5', e6'⟩ := digits2 hm'
  simp only [List.cons_append, List.nil_append, yearMonthValue] at e
  rw [num2] at hm1 hm2 hm1' hm2'
  rw [num4, num4, num2, num2] at e
  have v := fun c (hc : isDigit c = true) => hexValue_digit hc
  have := v _ e1; have := v _ e2; have := v _ e3; have := v _ e4; have := v _ e5; have := v _ e6
  have := v _ e1'; have := v _ e2'; have := v _ e3'; have := v _ e4'; have := v _ e5'; have := v _ e6'
  have := digits_eq (cs := [y1, y2, y3, y4, m1, m2]) (cs' := [y1', y2', y3', y4', m1', m2'])
    (by simp [e1, e2, e3, e4, e5, e6]) (by simp [e1', e2', e3', e4', e5', e6'])
    (by simp only [List.map_cons, List.map_nil, List.cons.injEq, and_true]; omega)
  simp only [List.cons.injEq, and_true] at this
  obtain ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩ := this
  rfl

/-! ## DateTime -/

/-- The value of a `DateTime`: nanoseconds since 0000-01-01T00:00:00. -/
def dateTimeValue (s : Text) : Nat := dateValue s * (86400 * 10 ^ 9) + timeValue (s.drop 11)

theorem dateTime_shape {s : Text} (h : DateTime s) : ∃ d t, s = d ++ 'T' :: t ∧ Date d ∧ Time t ∧ d.length = 10 := by
  obtain ⟨d, t, rfl, hd, ht⟩ := h
  obtain ⟨y1, y2, y3, y4, m1, m2, d1, d2, rfl, -, -⟩ := date_shape hd
  exact ⟨_, t, rfl, hd, ht, rfl⟩

theorem date_nodot {d : Text} (h : Date d) : '.' ∉ d := by
  obtain ⟨y1, y2, y3, y4, m1, m2, d1, d2, rfl, hd, -⟩ := date_shape h
  intro hm
  simp only [List.mem_cons, List.not_mem_nil, or_false] at hm
  have dot : ∀ c, isDigit c = true → '.' ≠ c := by intro c hc; rintro rfl; revert hc; decide
  rcases hm with h | h | h | h | h | h | h | h | h | h
  all_goals first | exact absurd h (by decide) | exact dot _ (hd _ (by simp [← h])) h

theorem dateValue_append {d : Text} (h : Date d) (r : Text) : dateValue (d ++ r) = dateValue d := by
  obtain ⟨y1, y2, y3, y4, m1, m2, d1, d2, rfl, -, -⟩ := date_shape h
  rfl

/-- **Two valid `DateTime`s are the same exactly when they differ at most in trailing zeros of the fraction.** -/
theorem dateTime_same_iff {s s' : Text} (h : DateTime s) (h' : DateTime s') :
    dateTimeValue s = dateTimeValue s' ↔ normFrac s = normFrac s' := by
  obtain ⟨d, t, rfl, hd, ht, hl⟩ := dateTime_shape h
  obtain ⟨d', t', rfl, hd', ht', hl'⟩ := dateTime_shape h'
  have dr : ∀ (d t : Text), d.length = 10 → (d ++ 'T' :: t).drop 11 = t := by
    intro d t hl; rw [show 11 = d.length + 1 by omega, ← List.drop_drop, List.drop_left]; rfl
  unfold dateTimeValue
  rw [dr d t hl, dr d' t' hl', dateValue_append hd, dateValue_append hd',
    normFrac_append (date_nodot hd), normFrac_append (date_nodot hd'), normFrac_cons (by decide),
    normFrac_cons (by decide)]
  have b := timeValue_lt ht
  have b' := timeValue_lt ht'
  constructor
  · intro e
    simp only [Nat.reducePow, Nat.reduceMul] at e b b'
    have e1 : dateValue d = dateValue d' := by omega
    have e2 : timeValue t = timeValue t' := by omega
    rw [(date_same_iff hd hd').mp e1, (time_same_iff ht ht').mp e2]
  · intro e
    obtain ⟨rfl, e2⟩ := List.append_inj e (by rw [hl, hl'])
    simp only [List.cons.injEq, true_and] at e2
    rw [(time_same_iff ht ht').mpr e2]

/-! ## Instant and ZonedDateTime -/

/-- The offset in seconds: `Z` is 0, `+01:00` is 3600. -/
def offsetSeconds : Text → Int
  | [sg, h1, h2, _, m1, m2] => (if sg = '-' then -1 else 1) * ((num [h1, h2] * 60 + num [m1, m2]) * 60 : Nat)
  | _ => 0

/-- The value of an `Instant` written as `dt ++ o`: nanoseconds since 0000-01-01T00:00:00Z (negative just before). -/
def instantValue (dt o : Text) : Int := (dateTimeValue dt : Int) - offsetSeconds o * 10 ^ 9

theorem time_nodot_prefix {t : Text} (h : Time t) : ∃ p f, t = p ++ f ∧ '.' ∉ p ∧ Fraction f := by
  obtain ⟨h1, h2, m1, m2, s1, s2, f, rfl, d1, d2, d3, d4, d5, d6, hf, -⟩ := time_shape h
  have dot : ∀ c, isDigit c = true → '.' ≠ c := by intro c hc; rintro rfl; revert hc; decide
  exact ⟨_, f, rfl, by simp [dot _ d1, dot _ d2, dot _ d3, dot _ d4, dot _ d5, dot _ d6], hf⟩

/-- What follows a `DateTime` in an `Instant`: no `.`, and no digit first. -/
theorem normFrac_dateTime {dt o : Text} (h : DateTime dt) (ho : '.' ∉ o) (hd : ∀ c, o.head? = some c → isDigit c = false) :
    normFrac (dt ++ o) = normFrac dt ++ o := by
  obtain ⟨d, t, rfl, hdt, ht, -⟩ := dateTime_shape h
  obtain ⟨p, f, rfl, hp, hf⟩ := time_nodot_prefix ht
  have hq : '.' ∉ d ++ 'T' :: p := by simp [date_nodot hdt, hp]
  have e1 := normFrac_append hq (f ++ o)
  have e2 := normFrac_append hq f
  simp only [List.append_assoc, List.cons_append] at e1 e2 ⊢
  rw [e1, e2, normFrac_frac hf ho hd]
  have := normFrac_frac (b := []) hf (by simp) (by simp)
  simp only [List.append_nil] at this
  rw [this]; simp

theorem offset_follow {o : Text} (h : Offset o) : '.' ∉ o ∧ ∀ c, o.head? = some c → isDigit c = false := by
  rcases h with rfl | ⟨sg, h1, m, rfl, hsg, hh, hm, -⟩
  · exact ⟨by simp, by intro c hc; simp at hc; subst hc; decide⟩
  · obtain ⟨a, b, rfl, ha, hb⟩ := digits2 hh
    obtain ⟨c, d, rfl, hc, hd⟩ := digits2 hm
    have dot : ∀ c, isDigit c = true → '.' ≠ c := by intro c hc; rintro rfl; revert hc; decide
    refine ⟨?_, ?_⟩
    · rcases hsg with rfl | rfl <;> simp [dot _ ha, dot _ hb, dot _ hc, dot _ hd]
    · intro x hx; simp at hx; subst hx; rcases hsg with rfl | rfl <;> decide

/--
**Two valid `Instant`s with the same offset are the same instant exactly
when they differ at most in trailing zeros of the fraction.** (With different
offsets, the same instant has other spellings: `…T10:00:00+01:00` is
`…T09:00:00Z`.)
-/
theorem instant_same_iff {dt dt' o : Text} (h : DateTime dt) (h' : DateTime dt') (ho : Offset o) :
    instantValue dt o = instantValue dt' o ↔ normFrac (dt ++ o) = normFrac (dt' ++ o) := by
  obtain ⟨hd, hh⟩ := offset_follow ho
  rw [normFrac_dateTime h hd hh, normFrac_dateTime h' hd hh, List.append_cancel_right_eq, ← dateTime_same_iff h h']
  unfold instantValue
  omega

/--
**Two valid `ZonedDateTime`s with the same offset are the same value** (the
same instant and the same zone) **exactly when they differ at most in
trailing zeros of the fraction.**
-/
theorem zoned_same_iff {dt dt' o z z' : Text} (h : DateTime dt) (h' : DateTime dt') (ho : Offset o) :
    (instantValue dt o = instantValue dt' o ∧ z = z') ↔
      (normFrac (dt ++ o) = normFrac (dt' ++ o) ∧ z = z') := by
  rw [instant_same_iff h h' ho]

/-- Different offsets can be the same instant: `10:00+01:00` is `09:00Z`. -/
example : instantValue "2026-11-13T10:00:00".toList "+01:00".toList = instantValue "2026-11-13T09:00:00".toList ['Z'] := by
  decide

/-! ## Duration -/

/-- The seconds' whole number, after the minutes. -/
def secondsWhole (t : Text) : Nat := num (t.takeWhile isDigit)

/-- The seconds' fraction, after the minutes. -/
def secondsFraction (t : Text) : Text := (t.dropWhile isDigit).dropLast

/-- Hours, minutes, seconds and nanoseconds of a duration's time part (0 when absent). -/
def timeValues : Text → List Nat
  | 'T' :: t =>
    let (h, t) := component 'H' t
    let (mi, t) := component 'M' t
    [h.getD 0, mi.getD 0, secondsWhole t, fractionNanos (secondsFraction t)]
  | _ => [0, 0, 0, 0]

/-- Years, months, weeks and days, and what follows them. -/
def dateValues (t : Text) : List Nat × Text :=
  let (y, t) := component 'Y' t
  let (mo, t) := component 'M' t
  let (w, t) := component 'W' t
  let (d, t) := component 'D' t
  ([y.getD 0, mo.getD 0, w.getD 0, d.getD 0], t)

/-- The value of a `Duration`: its sign, and years, months, weeks, days, hours, minutes, seconds and nanoseconds. -/
def durationValue : Text → Bool × List Nat
  | '-' :: 'P' :: t => (true, (dateValues t).1 ++ timeValues (dateValues t).2)
  | 'P' :: t => (false, (dateValues t).1 ++ timeValues (dateValues t).2)
  | _ => (false, [])

theorem durationValue_pos (t : Text) :
    durationValue ('P' :: t) = (false, (dateValues t).1 ++ timeValues (dateValues t).2) := rfl
theorem durationValue_neg (t : Text) :
    durationValue ('-' :: 'P' :: t) = (true, (dateValues t).1 ++ timeValues (dateValues t).2) := rfl
theorem timeValues_T (t : Text) : timeValues ('T' :: t) =
    [(component 'H' t).1.getD 0, (component 'M' (component 'H' t).2).1.getD 0,
      secondsWhole (component 'M' (component 'H' t).2).2,
      fractionNanos (secondsFraction (component 'M' (component 'H' t).2).2)] := rfl

/-- A component's text, from its value: nothing for 0. -/
def componentText (u : Char) (n : Nat) : Text := if n = 0 then [] else Nat.toDigits 10 n ++ [u]

theorem component_text {u : Char} {ct : Text} {v : Option Nat} (hc : Component u ct v) (hz : v ≠ some 0) :
    ct = componentText u (v.getD 0) := by
  cases hc with
  | none => simp [componentText]
  | some ds hds =>
    have hn : num ds ≠ 0 := fun e => hz (by rw [e])
    rw [Option.getD_some]; unfold componentText; simp only [hn, ↓reduceIte]
    simp only [num]
    rw [toDigits_digitsValue hds.1.1 hds.1.2 hds.2]

theorem duration_parts' {sg ty tm tw td tt : Text} {y mo w d : Option Nat} (hsg : sg = [] ∨ sg = ['-'])
    (hcy : Component 'Y' ty y) (hcm : Component 'M' tm mo) (hcw : Component 'W' tw w) (hcd : Component 'D' td d)
    (l0 : Later [] tt) :
    durationValue (sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ tt) =
      (decide (sg = ['-']), [y.getD 0, mo.getD 0, w.getD 0, d.getD 0] ++ timeValues tt) := by
  have ed := component_complete hcd (later_mono l0 (us' := []) (by simp)) (by simp) (by simp) (by decide)
  have l1 := later_component hcd (later_mono l0 (us' := ['D']) (by simp)) (by simp)
  have ew := component_complete hcw l1 (by simp) (by decide) (by decide)
  have l2 := later_component hcw (later_mono l1 (us' := ['W', 'D']) (by simp)) (by simp)
  have em := component_complete hcm l2 (by simp) (by decide) (by decide)
  have l3 := later_component hcm (later_mono l2 (us' := ['M', 'W', 'D']) (by simp)) (by simp)
  have ey := component_complete hcy l3 (by simp) (by decide) (by decide)
  have dv : dateValues (ty ++ tm ++ tw ++ td ++ tt) = ([y.getD 0, mo.getD 0, w.getD 0, d.getD 0], tt) := by
    simp only [List.append_assoc] at ey em ew ed ⊢
    simp only [dateValues, ey, em, ew, ed]
  rcases hsg with rfl | rfl
  · simp only [List.nil_append, List.cons_append] at dv ⊢
    rw [durationValue_pos, dv]; simp
  · simp only [List.cons_append, List.nil_append] at dv ⊢
    rw [durationValue_neg, dv]; simp

/-- The parts of a duration, as the grammar gives them, and its value. -/
theorem duration_parts {sg ty tm tw td tt : Text} {y mo w d hh mi se : Option Nat} (hsg : sg = [] ∨ sg = ['-'])
    (hcy : Component 'Y' ty y) (hcm : Component 'M' tm mo) (hcw : Component 'W' tw w) (hcd : Component 'D' td d)
    (htp : TimePart tt hh mi se) :
    durationValue (sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ tt) =
      (decide (sg = ['-']), [y.getD 0, mo.getD 0, w.getD 0, d.getD 0] ++ timeValues tt) :=
  duration_parts' hsg hcy hcm hcw hcd (later_timePart htp)

theorem timeValues_some {th tm ts : Text} {h mi se : Option Nat} (hch : Component 'H' th h) (hcm : Component 'M' tm mi)
    (hcs : Seconds ts se) :
    timeValues ('T' :: th ++ tm ++ ts) = [h.getD 0, mi.getD 0, secondsWhole ts, fractionNanos (secondsFraction ts)] := by
  have hl := later_seconds hcs
  have e1 := component_complete hch (later_component hcm (later_mono hl (us' := ['M', '.', 'S'])
    (by simp)) (by simp)) (by simp) (by decide) (by decide)
  have e2 := component_complete hcm hl (by simp) (by decide) (by decide)
  simp only [List.append_assoc] at e1 e2 ⊢
  rw [List.cons_append, timeValues_T, e1]; dsimp only; rw [e2]

theorem seconds_some_values {ds f : Text} (hds : Natural ds) (hf : Fraction f) :
    secondsWhole (ds ++ f ++ ['S']) = num ds ∧ secondsFraction (ds ++ f ++ ['S']) = f := by
  have hx : ∀ c, (f ++ ['S']).head? = some c → isDigit c = false := by
    rcases hf with rfl | ⟨fs, rfl, -⟩ <;> intro c hc <;> simp at hc <;> subst hc <;> decide
  obtain ⟨ht, hdw⟩ := takeWhile_append hds.1.2 hx
  rw [List.append_assoc]
  refine ⟨by simp only [secondsWhole, ht], ?_⟩
  simp only [secondsFraction, hdw]
  rw [List.dropLast_concat]

theorem seconds_values {ts : Text} {v : Option Nat} (h : Seconds ts v) :
    (ts = [] ∧ v = none ∧ secondsWhole ts = 0 ∧ secondsFraction ts = []) ∨
      ∃ ds f, ts = ds ++ f ++ ['S'] ∧ Natural ds ∧ Fraction f ∧ v = some (num ds) ∧
        secondsWhole ts = num ds ∧ secondsFraction ts = f := by
  cases h with
  | none => exact .inl ⟨rfl, rfl, rfl, rfl⟩
  | some ds f hds hf =>
    refine .inr ⟨ds, f, rfl, hds, hf, rfl, ?_⟩
    have hx : ∀ c, (f ++ ['S']).head? = some c → isDigit c = false := by
      rcases hf with rfl | ⟨fs, rfl, -⟩ <;> intro c hc <;> simp at hc <;> subst hc <;> decide
    obtain ⟨ht, hdw⟩ := takeWhile_append hds.1.2 hx
    rw [List.append_assoc]
    refine ⟨by simp only [secondsWhole, ht], ?_⟩
    simp only [secondsFraction, hdw]
    rw [List.dropLast_concat]

/-! ### Writing a duration from its value -/

/-- A fraction from its nanoseconds, without trailing zeros: 250000000 → `.25`, 0 → nothing. -/
def fractionText (n : Nat) : Text := stripFraction ('.' :: pad 9 n)

/-- Seconds from their value: nothing for none. -/
def secondsText (sec n : Nat) : Text :=
  if sec = 0 ∧ n = 0 then [] else Nat.toDigits 10 sec ++ fractionText n ++ ['S']

/-- **The one spelling of a duration value.** -/
def durationText : Bool × List Nat → Text
  | (neg, [y, mo, w, d, h, mi, sec, n]) =>
    (if neg then ['-'] else []) ++ 'P' ::
      (if y = 0 ∧ mo = 0 ∧ w = 0 ∧ d = 0 ∧ h = 0 ∧ mi = 0 ∧ sec = 0 ∧ n = 0 then ['T', '0', 'S'] else
        componentText 'Y' y ++ componentText 'M' mo ++ componentText 'W' w ++ componentText 'D' d ++
          (if h = 0 ∧ mi = 0 ∧ sec = 0 ∧ n = 0 then [] else
            'T' :: componentText 'H' h ++ componentText 'M' mi ++ secondsText sec n))
  | _ => []

theorem durationText_def (neg : Bool) (y mo w d h mi sec n : Nat) :
    durationText (neg, [y, mo, w, d, h, mi, sec, n]) = (if neg then ['-'] else []) ++ 'P' ::
      (if y = 0 ∧ mo = 0 ∧ w = 0 ∧ d = 0 ∧ h = 0 ∧ mi = 0 ∧ sec = 0 ∧ n = 0 then ['T', '0', 'S'] else
        componentText 'Y' y ++ componentText 'M' mo ++ componentText 'W' w ++ componentText 'D' d ++
          (if h = 0 ∧ mi = 0 ∧ sec = 0 ∧ n = 0 then [] else
            'T' :: componentText 'H' h ++ componentText 'M' mi ++ secondsText sec n)) := rfl

#guard durationText (false, [1, 0, 0, 2, 0, 30, 0, 250000000]) == "P1Y2DT30M0.25S".toList
#guard durationText (true, [0, 0, 0, 0, 0, 0, 0, 0]) == "-PT0S".toList
#guard durationText (false, [0, 0, 0, 0, 0, 0, 0, 0]) == "PT0S".toList

theorem fractionText_nanos {f : Text} (h : Fraction f) : fractionText (fractionNanos f) = stripFraction f := by
  rcases h with rfl | ⟨ds, rfl, -, h9, hd⟩
  · decide
  · unfold fractionText
    rw [fractionNanos_pad, pad_num 9 _ (pad9_digits h9 hd)]
    simp only [stripFraction, stripZeros_pad9]

/-- Digits are all `0` exactly when their value is 0. -/
theorem num_eq_zero {t : Text} (h : ∀ c ∈ t, isDigit c = true) : num t = 0 ↔ ∀ c ∈ t, c = '0' := by
  induction t using snoc_induction with
  | nil => simp [num, digitsValue]
  | snoc l c ih =>
    have hc := h c (by simp)
    have ih := ih (fun x hx => h x (by simp [hx]))
    simp only [num, digitsValue_append] at ih ⊢
    have hv : hexValue c = 0 ↔ c = '0' := by
      constructor
      · intro e; rw [← digitChar_hexValue hc, e]; rfl
      · rintro rfl; rfl
    simp only [List.mem_append, List.mem_singleton]
    constructor
    · intro e
      have e1 : digitsValue 10 l = 0 := by omega
      have e2 : hexValue c = 0 := by omega
      intro x hx; rcases hx with hx | rfl
      · exact ih.mp e1 x hx
      · exact hv.mp e2
    · intro hall
      have e1 := ih.mpr (fun x hx => hall x (.inl hx))
      have e2 := hv.mpr (hall c (.inr rfl))
      omega

theorem fraction_zero {f : Text} (h : Fraction f) : fractionNanos f = 0 ↔ ∀ c ∈ f, isDigit c = true → c = '0' := by
  rcases h with rfl | ⟨ds, rfl, -, h9, hd⟩
  · simp [fractionNanos]
  · rw [fractionNanos_pad, num_eq_zero (pad9_digits h9 hd).2]
    simp only [pad9, List.mem_append, List.mem_replicate, List.mem_cons]
    constructor
    · intro hall c hc hcd
      rcases hc with rfl | hc
      · revert hcd; decide
      · exact hall c (.inl hc)
    · intro hall c hc
      rcases hc with hc | ⟨-, rfl⟩
      · exact hall c (.inr hc) (hd c hc)
      · rfl

theorem digit_nodot {c : Char} (h : isDigit c = true) : c ≠ '.' := by rintro rfl; revert h; decide

theorem componentText_nodot (u : Char) (hu : u ≠ '.') (n : Nat) : '.' ∉ componentText u n := by
  unfold componentText
  split
  · simp
  · simp only [List.mem_append, List.mem_singleton, not_or]
    exact ⟨fun hm => digit_nodot (toDigits_decimal _ hm) rfl, fun e => hu e.symm⟩

theorem componentText_nil (u : Char) (n : Nat) : componentText u n = [] ↔ n = 0 := by
  unfold componentText; split <;> simp_all

theorem natural_eq_zero {ds : Text} (h : Natural ds) (h0 : num ds = 0) : ds = ['0'] := by
  have hz := (num_eq_zero h.1.2).mp h0
  obtain ⟨hne, -⟩ := h.1
  obtain ⟨c, r, rfl⟩ : ∃ c r, ds = c :: r := by cases ds with | nil => exact absurd rfl hne | cons c r => exact ⟨c, r, rfl⟩
  exact h.2 (by simp [hz c (by simp)])

/--
**Formatting a duration's value gives back its text**, with the fraction
written without trailing zeros: the one spelling of the value.
-/
theorem duration_text {s : Text} (hs : Duration s) : normFrac s = durationText (durationValue s) := by
  obtain ⟨sg, ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hsg, hcy, hcm, hcw, hcd, htp, hsome,
    ⟨n1, n2, n3, n4, n5, n6⟩, hzero, hsign, -⟩ := hs
  rw [duration_parts hsg hcy hcm hcw hcd htp]
  have ey := component_text hcy n1; have em := component_text hcm n2
  have ew := component_text hcw n3; have ed := component_text hcd n4
  have gz : ∀ v : Option Nat, v ≠ some 0 → (v.getD 0 = 0 ↔ v = none) := by
    intro v hv; cases v with
    | none => simp
    | some n => simp only [Option.getD_some, reduceCtorEq, iff_false]; intro e; exact hv (by rw [e])
  have sgn : sg = (if decide (sg = ['-']) then ['-'] else []) := by rcases hsg with rfl | rfl <;> rfl
  have hp : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td := by
    rw [ey, em, ew, ed]
    rcases hsg with rfl | rfl <;>
      simp [componentText_nodot 'Y' (by decide), componentText_nodot 'M' (by decide),
        componentText_nodot 'W' (by decide), componentText_nodot 'D' (by decide)]
  cases htp with
  | none =>
    -- No time part: a date component is there, and isn't zero.
    have hd0 : ¬ (y.getD 0 = 0 ∧ mo.getD 0 = 0 ∧ w.getD 0 = 0 ∧ d.getD 0 = 0) := by
      rintro ⟨a, b, c, e⟩
      rw [(gz _ n1).mp a, (gz _ n2).mp b, (gz _ n3).mp c, (gz _ n4).mp e] at hsome
      simp at hsome
    rw [List.append_nil, normFrac_nodot hp]
    have tv : timeValues [] = [0, 0, 0, 0] := rfl
    rw [tv]
    simp only [List.cons_append, List.nil_append, durationText]
    simp only [and_self]
    conv => lhs; rw [sgn, ey, em, ew, ed]
    simp only [List.cons_append, List.append_assoc]
    have c2 : ¬(y.getD 0 = 0 ∧ mo.getD 0 = 0 ∧ w.getD 0 = 0 ∧ d.getD 0 = 0 ∧ True) :=
      fun hc => hd0 ⟨hc.1, hc.2.1, hc.2.2.1, hc.2.2.2.1⟩
    simp only [c2, ↓reduceIte, List.append_nil]
  | some th tmi ts h mi se hch hcmi hcs hs hzts =>
    rw [timeValues_some hch hcmi hcs]
    have eh := component_text hch n5
    have emi := component_text hcmi n6
    have a1 := componentText_nodot 'Y' (by decide) (y.getD 0)
    have a2 := componentText_nodot 'M' (by decide) (mo.getD 0)
    have a3 := componentText_nodot 'W' (by decide) (w.getD 0)
    have a4 := componentText_nodot 'D' (by decide) (d.getD 0)
    have a5 := componentText_nodot 'H' (by decide) (h.getD 0)
    have a6 := componentText_nodot 'M' (by decide) (mi.getD 0)
    have a0 : '.' ∉ sg := by rcases hsg with rfl | rfl <;> decide
    have hq : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi := by
      rw [ey, em, ew, ed, eh, emi]; simp [a0, a1, a2, a3, a4, a5, a6]
    rcases seconds_values hcs with ⟨rfl, rfl, sw, sf⟩ | ⟨ds, f, rfl, hds, hf, rfl, sw, sf⟩
    · -- No seconds: hours or minutes are there, and not zero.
      rw [sw, sf]
      have ht0 : ¬ (h.getD 0 = 0 ∧ mi.getD 0 = 0) := by
        rintro ⟨a, b⟩
        rw [(gz _ n5).mp a, (gz _ n6).mp b] at hs
        simp at hs
      have := normFrac_nodot hq
      simp only [List.append_assoc, List.cons_append, List.append_nil] at this ⊢
      rw [this]
      have n0 : fractionNanos [] = 0 := rfl
      have c1 : ¬(y.getD 0 = 0 ∧ mo.getD 0 = 0 ∧ w.getD 0 = 0 ∧ d.getD 0 = 0 ∧ h.getD 0 = 0 ∧ mi.getD 0 = 0) :=
        fun hc => ht0 ⟨hc.2.2.2.2.1, hc.2.2.2.2.2⟩
      simp only [n0, List.nil_append, List.cons_append, durationText_def, secondsText, and_true, and_self, ht0,
        ↓reduceIte, List.append_nil]
      conv => lhs; rw [sgn, ey, em, ew, ed, eh, emi]
      simp
    · rw [sw, sf]
      have nf : normFrac (sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi ++ ds ++ f ++ ['S']) =
          sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi ++ ds ++ stripFraction f ++ ['S'] := by
        have a7 : '.' ∉ ds := fun hm => digit_nodot (hds.1.2 _ hm) rfl
        have hd : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi ++ ds := by
          rw [ey, em, ew, ed, eh, emi]; simp [a0, a1, a2, a3, a4, a5, a6, a7]
        have := normFrac_append hd (f ++ ['S'])
        rw [normFrac_frac hf (by simp) (by intro c hc; simp at hc; subst hc; decide)] at this
        simp only [List.append_assoc] at this ⊢
        exact this
      simp only [List.append_assoc] at nf ⊢
      rw [nf]
      by_cases hz : num ds = 0 ∧ fractionNanos f = 0
      · -- The zero duration: `PT0S`, its fraction all zeros.
        have ds0 := natural_eq_zero hds hz.1
        subst ds0
        have sf0 : stripFraction f = [] := by
          have := (fraction_eq_iff hf (f' := []) (.inl rfl)).mp (by rw [hz.2]; rfl)
          simpa [stripFraction] using this
        have fz := (fraction_zero hf).mp hz.2
        have zdigits : ∀ c ∈ '0' :: (f ++ ['S']), isDigit c = true → c = '0' := by
          intro c hc hd
          simp only [List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at hc
          rcases hc with rfl | hc | rfl
          · rfl
          · exact fz c hc hd
          · revert hd; decide
        obtain ⟨th0, tm0⟩ := hzts ⟨by simp, by simpa using zdigits⟩
        have hh0 : h.getD 0 = 0 := (componentText_nil 'H' _).mp (eh ▸ th0)
        have hm0 : mi.getD 0 = 0 := (componentText_nil 'M' _).mp (emi ▸ tm0)
        subst th0 tm0
        have hdate := hzero ⟨by simp, by
          intro c hc hd
          simp only [List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at hc
          rcases hc with rfl | hc
          · revert hd; decide
          · exact zdigits c (by simp only [List.mem_cons, List.mem_append] at hc ⊢; rcases hc with (h1 | h1) | h1 <;> simp [h1]) hd⟩
        simp only [List.append_eq_nil_iff] at hdate
        obtain ⟨⟨⟨hy0, hm0'⟩, hw0⟩, hd0⟩ := hdate
        have v1 := (componentText_nil 'Y' _).mp (ey ▸ hy0)
        have v2 := (componentText_nil 'M' _).mp (em ▸ hm0')
        have v3 := (componentText_nil 'W' _).mp (ew ▸ hw0)
        have v4 := (componentText_nil 'D' _).mp (ed ▸ hd0)
        subst hy0 hm0' hw0 hd0
        have hsg0 : sg = [] := by
          rcases hsg with rfl | rfl
          · rfl
          · obtain ⟨c, hc, hd, h0⟩ := hsign rfl
            simp only [List.nil_append, List.mem_cons, List.mem_append, List.not_mem_nil, or_false] at hc
            rcases hc with rfl | hc
            · revert hd; decide
            · exact absurd (zdigits c (by simp only [List.mem_cons, List.mem_append] at hc ⊢; rcases hc with (h1 | h1) | h1 <;> simp [h1]) hd) h0
        subst hsg0
        rw [v1, v2, v3, v4, hh0, hm0, hz.1, hz.2, sf0]
        rfl
      · -- Seconds that aren't zero: written as they are, without the fraction's trailing zeros.
        have c1 : ¬(y.getD 0 = 0 ∧ mo.getD 0 = 0 ∧ w.getD 0 = 0 ∧ d.getD 0 = 0 ∧ h.getD 0 = 0 ∧ mi.getD 0 = 0 ∧
            num ds = 0 ∧ fractionNanos f = 0) := fun hc => hz hc.2.2.2.2.2.2
        have c2 : ¬(h.getD 0 = 0 ∧ mi.getD 0 = 0 ∧ num ds = 0 ∧ fractionNanos f = 0) := fun hc => hz hc.2.2
        have e : List.cons (y.getD 0) [mo.getD 0, w.getD 0, d.getD 0] ++ [h.getD 0, mi.getD 0, num ds, fractionNanos f] =
          [y.getD 0, mo.getD 0, w.getD 0, d.getD 0, h.getD 0, mi.getD 0, num ds, fractionNanos f] := rfl
        rw [e, durationText_def]; simp only [c2, ↓reduceIte]
        unfold secondsText
        simp only [hz, ↓reduceIte]; rw [fractionText_nanos hf]
        have tds : Nat.toDigits 10 (num ds) = ds := toDigits_digitsValue hds.1.1 hds.1.2 hds.2
        rw [tds]
        conv => lhs; rw [sgn, ey, em, ew, ed, eh, emi]
        simp

theorem dropWhile_idem (p : Char → Bool) (l : Text) : (l.dropWhile p).dropWhile p = l.dropWhile p := by
  cases h : l.dropWhile p with
  | nil => rfl
  | cons c r =>
    have := head_dropWhile (p := p) (l := l) (c := c) (by rw [h]; rfl)
    simp [List.dropWhile, this]

theorem stripZeros_idem (x : Text) : stripZeros (stripZeros x) = stripZeros x := by
  simp [stripZeros, dropWhile_idem]

/-- Without trailing zeros, a fraction is still a fraction, of the same value. -/
theorem stripFraction_ok {f : Text} (hf : Fraction f) :
    Fraction (stripFraction f) ∧ fractionNanos (stripFraction f) = fractionNanos f := by
  rcases hf with rfl | ⟨ds, rfl, h1, h9, hd⟩
  · exact ⟨.inl rfl, rfl⟩
  · obtain ⟨k, hk⟩ := stripZeros_spec ds
    have hl := congrArg List.length hk
    simp only [List.length_append, List.length_replicate] at hl
    by_cases h0 : stripZeros ds = []
    · simp only [stripFraction]
      simp only [h0, ↓reduceIte]
      refine ⟨.inl rfl, ?_⟩
      rw [h0, List.nil_append] at hk
      rw [fractionNanos_pad, hk]
      simp only [pad9, List.length_replicate, List.replicate_append_replicate]
      exact ((num_eq_zero (fun c hc => by simp at hc; rw [hc.2]; decide)).mpr (fun c hc => by simp at hc; exact hc.2)).symm
    · simp only [stripFraction, h0, ↓reduceIte]
      have hsub : ∀ c ∈ stripZeros ds, c ∈ ds := fun c hc => by rw [hk]; simp [hc]
      refine ⟨.inr ⟨stripZeros ds, rfl, ?_, by omega, fun c hc => hd c (hsub c hc)⟩, ?_⟩
      · cases hz : stripZeros ds with
        | nil => exact absurd hz h0
        | cons => simp
      · rw [fractionNanos_pad, fractionNanos_pad,
          pad9_of_strip (by omega) h9 (stripZeros_idem ds)]

/-- Removing trailing zeros from the fraction doesn't change a duration's value. -/
theorem duration_value_norm {s : Text} (hs : Duration s) : durationValue (normFrac s) = durationValue s := by
  obtain ⟨sg, ty, tm, tw, td, tt, y, mo, w, d, h, mi, se, rfl, hsg, hcy, hcm, hcw, hcd, htp, -, ⟨n1, n2, n3, n4, n5, n6⟩,
    -, -, -⟩ := hs
  have ey := component_text hcy n1; have em := component_text hcm n2
  have ew := component_text hcw n3; have ed := component_text hcd n4
  have a1 := componentText_nodot 'Y' (by decide) (y.getD 0)
  have a2 := componentText_nodot 'M' (by decide) (mo.getD 0)
  have a3 := componentText_nodot 'W' (by decide) (w.getD 0)
  have a4 := componentText_nodot 'D' (by decide) (d.getD 0)
  have a0 : '.' ∉ sg := by rcases hsg with rfl | rfl <;> decide
  have hp : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td := by rw [ey, em, ew, ed]; simp [a0, a1, a2, a3, a4]
  cases htp with
  | none => rw [List.append_nil, normFrac_nodot hp]
  | some th tmi ts h mi se hch hcmi hcs _ _ =>
    have eh := component_text hch n5
    have emi := component_text hcmi n6
    have a5 := componentText_nodot 'H' (by decide) (h.getD 0)
    have a6 := componentText_nodot 'M' (by decide) (mi.getD 0)
    have hq : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi := by
      rw [ey, em, ew, ed, eh, emi]; simp [a0, a1, a2, a3, a4, a5, a6]
    rcases seconds_values hcs with ⟨rfl, -⟩ | ⟨ds, f, rfl, hds, hf, rfl, -, -⟩
    · have := normFrac_nodot hq
      simp only [List.append_assoc, List.cons_append, List.append_nil] at this ⊢
      rw [this]
    · have a7 : '.' ∉ ds := fun hm => digit_nodot (hds.1.2 _ hm) rfl
      have hd : '.' ∉ sg ++ 'P' :: ty ++ tm ++ tw ++ td ++ 'T' :: th ++ tmi ++ ds := by
        rw [ey, em, ew, ed, eh, emi]; simp [a0, a1, a2, a3, a4, a5, a6, a7]
      have nf := normFrac_append hd (f ++ ['S'])
      rw [normFrac_frac hf (by simp) (by intro c hc; simp at hc; subst hc; decide)] at nf
      obtain ⟨hf', hn⟩ := stripFraction_ok hf
      have hcs' : Seconds (ds ++ stripFraction f ++ ['S']) (some (num ds)) := .some ds _ hds hf'
      simp only [List.append_assoc] at nf ⊢
      rw [nf]
      have p1 := duration_parts' (tt := 'T' :: (th ++ (tmi ++ (ds ++ (stripFraction f ++ ['S'])))))
        hsg hcy hcm hcw hcd (.inr (.inl ⟨_, rfl⟩))
      have p2 := duration_parts' (tt := 'T' :: (th ++ (tmi ++ (ds ++ (f ++ ['S'])))))
        hsg hcy hcm hcw hcd (.inr (.inl ⟨_, rfl⟩))
      simp only [List.append_assoc, List.cons_append] at p1 p2 ⊢
      rw [p1, p2]
      have t1 := timeValues_some hch hcmi hcs'
      have t2 := timeValues_some hch hcmi (.some ds f hds hf)
      simp only [List.append_assoc, List.cons_append] at t1 t2
      obtain ⟨w1, f1⟩ := seconds_some_values hds hf'
      obtain ⟨w2, f2⟩ := seconds_some_values hds hf
      simp only [List.append_assoc] at w1 f1 w2 f2
      rw [t1, t2, w1, f1, w2, f2, hn]

/-- **Two valid durations are the same exactly when they differ at most in trailing zeros of the fraction.** -/
theorem duration_same_iff {s s' : Text} (h : Duration s) (h' : Duration s') :
    durationValue s = durationValue s' ↔ normFrac s = normFrac s' := by
  constructor
  · intro e; rw [duration_text h, duration_text h', e]
  · intro e
    rw [← duration_value_norm h, ← duration_value_norm h', e]

end Haus.Time
