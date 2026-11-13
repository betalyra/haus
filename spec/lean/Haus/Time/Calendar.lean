import Haus.Time.Spec
import Haus.RoundTrip.Digits

/-!
# std/time: the calendar is right (plan step T5)

`Date` accepts a day when `1 ≤ d ≤ daysIn y m`. This file checks that rule
against the standard day-count formula of the proleptic Gregorian calendar,
which doesn't use `daysIn`: counting years from March, a year has 365 days,
one more every 4th year, one fewer every 100th, one more every 400th, and
the months from March to February have the lengths
31 30 31 30 31 31 30 31 30 31 31 28/29, which `(153 * M + 2) / 5` adds up.

* `next_dayNumber`: the day after a valid date (by `daysIn`) is the next day
  of the formula.
* `dateOk_iff_day`: valid dates correspond exactly to the day numbers from
  0000-01-01 (day 0) to 9999-12-31 (day 3652424), one date per day.
* `date_iff`: the same for `Date` strings: a string is a valid `Date`
  exactly when it is `dateText n` for a day `n` in that range, and
  `dateText` gives different strings for different days.

So `daysIn` has the right month lengths and leap years for every year: if
it allowed one day too many or too few anywhere, consecutive dates would
skip a day number or repeat one.
-/

namespace Haus.Time
open Haus RoundTrip

/-! ## The day-count formula -/

/--
Days from the start of year 0 (counted from March, which keeps the leap day
at a year's end) to the start of year `Y`: 365 a year, one more every 4th,
one fewer every 100th, one more every 400th.
-/
def yearStart (Y : Nat) : Nat := 365 * Y + Y / 4 - Y / 100 + Y / 400

/-- Days from 1 March to the first of month `m`: the months from March to February have 31 30 31 30 31 31 30 31 30 31 31 days, which `(153 * M + 2) / 5` adds up. -/
def monthStart (m : Nat) : Nat := (153 * (if m ≤ 2 then m + 9 else m - 3) + 2) / 5

/-- The year counted from March, shifted by 400 years so that every number is natural. -/
def marchYear (y m : Nat) : Nat := if m ≤ 2 then y + 399 else y + 400

/-- The day count of `y-m-d` before shifting it to start at 0. -/
def absDay (y m d : Nat) : Nat := yearStart (marchYear y m) + monthStart m + d

/-- **Days from 0000-01-01 to `y-m-d`**, by the standard formula. -/
def dayNumber (y m d : Nat) : Nat := absDay y m d - absDay 0 1 1

/-- The number of days from 0000-01-01 to 9999-12-31, both included. -/
def calendarDays : Nat := 3652425

#guard dayNumber 0 1 1 == 0
#guard dayNumber 9999 12 31 == calendarDays - 1
-- The Unix epoch, and today: 1970-01-01 is day 719528, a Thursday (0000-01-01 was a Saturday).
#guard dayNumber 1970 1 1 == 719528 && (dayNumber 1970 1 1 + 6) % 7 == 4
#guard (dayNumber 2026 11 13 - dayNumber 1970 1 1) == 20770 && (dayNumber 2026 11 13 + 6) % 7 == 5

/-- A valid date, as numbers. -/
def DateOk (y m d : Nat) : Prop := y ≤ 9999 ∧ 1 ≤ m ∧ m ≤ 12 ∧ 1 ≤ d ∧ d ≤ daysIn y m

/-- The next day. -/
def next (y m d : Nat) : Nat × Nat × Nat :=
  if d < daysIn y m then (y, m, d + 1)
  else if m < 12 then (y, m + 1, 1)
  else (y + 1, 1, 1)

/-- The day before. -/
def prev (y m d : Nat) : Nat × Nat × Nat :=
  if 1 < d then (y, m, d - 1)
  else if 1 < m then (y, m - 1, daysIn y (m - 1))
  else (y - 1, 12, 31)

/-! ## Months and leap years as arithmetic -/

theorem month_cases {m : Nat} (h1 : 1 ≤ m) (h2 : m ≤ 12) :
    m = 1 ∨ m = 2 ∨ m = 3 ∨ m = 4 ∨ m = 5 ∨ m = 6 ∨ m = 7 ∨ m = 8 ∨ m = 9 ∨ m = 10 ∨ m = 11 ∨ m = 12 := by
  omega

/-- February's length, and the leap-year rule, as arithmetic `omega` can use. -/
theorem feb (y : Nat) : (daysIn y 2 = 29 ∧ y % 4 = 0 ∧ (y % 100 ≠ 0 ∨ y % 400 = 0)) ∨
    (daysIn y 2 = 28 ∧ ¬ (y % 4 = 0 ∧ (y % 100 ≠ 0 ∨ y % 400 = 0))) := by
  have hL : isLeap y = true ↔ y % 4 = 0 ∧ (y % 100 ≠ 0 ∨ y % 400 = 0) := by simp [isLeap]
  cases hl : isLeap y
  · right; refine ⟨by simp [daysIn, hl], fun h => ?_⟩; have := hL.mpr h; simp [hl] at this
  · left; exact ⟨by simp [daysIn, hl], hL.mp hl⟩

/-- Month lengths: 28 to 31 days. -/
theorem daysIn_range (y m : Nat) : 28 ≤ daysIn y m ∧ daysIn y m ≤ 31 := by
  unfold daysIn; split <;> (try split) <;> (try split) <;> omega

theorem daysIn_month (y : Nat) : daysIn y 1 = 31 ∧ daysIn y 3 = 31 ∧ daysIn y 4 = 30 ∧ daysIn y 5 = 31 ∧
    daysIn y 6 = 30 ∧ daysIn y 7 = 31 ∧ daysIn y 8 = 31 ∧ daysIn y 9 = 30 ∧ daysIn y 10 = 31 ∧
    daysIn y 11 = 30 ∧ daysIn y 12 = 31 := by
  simp [daysIn]

theorem next_day {y m d : Nat} (h : d < daysIn y m) : next y m d = (y, m, d + 1) := by simp [next, h]
theorem next_month {y m d : Nat} (h : ¬ d < daysIn y m) (hm : m < 12) : next y m d = (y, m + 1, 1) := by
  simp [next, h, hm]
theorem next_year {y m d : Nat} (h : ¬ d < daysIn y m) (hm : ¬ m < 12) : next y m d = (y + 1, 1, 1) := by
  simp [next, h, hm]

/-! ## Consecutive days -/

theorem monthStart_values : monthStart 1 = 306 ∧ monthStart 2 = 337 ∧ monthStart 3 = 0 ∧ monthStart 4 = 31 ∧
    monthStart 5 = 61 ∧ monthStart 6 = 92 ∧ monthStart 7 = 122 ∧ monthStart 8 = 153 ∧ monthStart 9 = 184 ∧
    monthStart 10 = 214 ∧ monthStart 11 = 245 ∧ monthStart 12 = 275 := by decide

theorem marchYear_early {y m : Nat} (h : m ≤ 2) : marchYear y m = y + 399 := by simp [marchYear, h]
theorem marchYear_late {y m : Nat} (h : ¬ m ≤ 2) : marchYear y m = y + 400 := by simp [marchYear, h]

/-- A year counted from March has 366 days when the February at its end is a leap February. -/
theorem yearStart_succ (y : Nat) : yearStart (y + 400) = yearStart (y + 399) + 337 + daysIn y 2 := by
  have hf := feb y
  have h4 : (y % 4 = 0 → (y + 400) / 4 = (y + 399) / 4 + 1) ∧ (y % 4 ≠ 0 → (y + 400) / 4 = (y + 399) / 4) := by
    constructor <;> intro <;> omega
  have h100 : (y % 100 = 0 → (y + 400) / 100 = (y + 399) / 100 + 1) ∧
      (y % 100 ≠ 0 → (y + 400) / 100 = (y + 399) / 100) := by
    constructor <;> intro <;> omega
  have h400 : (y % 400 = 0 → (y + 400) / 400 = (y + 399) / 400 + 1) ∧
      (y % 400 ≠ 0 → (y + 400) / 400 = (y + 399) / 400) := by
    constructor <;> intro <;> omega
  have hle : (y + 399) / 100 ≤ (y + 399) / 4 := Nat.div_le_div_left (by decide) (by decide)
  unfold yearStart
  generalize (y + 400) / 4 = a4 at *
  generalize (y + 399) / 4 = b4 at *
  generalize (y + 400) / 100 = a100 at *
  generalize (y + 399) / 100 = b100 at *
  generalize (y + 400) / 400 = a400 at *
  generalize (y + 399) / 400 = b400 at *
  have m4 : y % 4 = 0 ∨ y % 4 ≠ 0 := by omega
  have m100 : y % 100 = 0 → y % 4 = 0 := by omega
  have m400 : y % 400 = 0 → y % 100 = 0 := by omega
  generalize y % 4 = r4 at *
  generalize y % 100 = r100 at *
  generalize y % 400 = r400 at *
  omega

/-- **The day after a valid date is the next day of the formula.** -/
theorem next_absDay {y m d : Nat} (h : DateOk y m d) :
    absDay (next y m d).1 (next y m d).2.1 (next y m d).2.2 = absDay y m d + 1 := by
  obtain ⟨hy, hm1, hm2, hd1, hd2⟩ := h
  have hn := daysIn_month y
  have hv := monthStart_values
  by_cases hlt : d < daysIn y m
  · simp only [next_day hlt, absDay]; omega
  · by_cases h12 : m < 12
    · simp only [next_month hlt h12]
      have hd : d = daysIn y m := by omega
      subst hd
      by_cases h2 : m = 2
      · subst h2
        have := yearStart_succ y
        have := daysIn_range y 2
        simp only [Nat.reduceAdd, absDay, marchYear_early (show 2 ≤ 2 by omega), marchYear_late (show ¬ 3 ≤ 2 by omega)]
        omega
      · rcases month_cases hm1 hm2 with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
          first | omega | (simp only [absDay, marchYear]; simp; omega)
    · simp only [next_year hlt h12]
      have : m = 12 := by omega
      subst this
      simp only [absDay, marchYear]; simp only [show y + 1 + 399 = y + 400 by omega]; simp; omega

theorem next_dayNumber {y m d : Nat} (h : DateOk y m d) :
    dayNumber (next y m d).1 (next y m d).2.1 (next y m d).2.2 = dayNumber y m d + 1 := by
  have h1 := next_absDay h
  have h0 : absDay 0 1 1 ≤ absDay y m d := by
    obtain ⟨-, hm1, hm2, hd1, -⟩ := h
    have hv := monthStart_values
    unfold absDay yearStart marchYear
    rcases month_cases hm1 hm2 with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
      simp <;> omega
  unfold dayNumber
  omega

/-- The day after a valid date other than 9999-12-31 is valid. -/
theorem next_ok {y m d : Nat} (h : DateOk y m d) (hl : ¬ (y = 9999 ∧ m = 12 ∧ d = 31)) :
    DateOk (next y m d).1 (next y m d).2.1 (next y m d).2.2 := by
  obtain ⟨hy, hm1, hm2, hd1, hd2⟩ := h
  have hn := daysIn_month y
  by_cases hlt : d < daysIn y m
  · simp only [next_day hlt]; exact ⟨hy, hm1, hm2, by omega, by omega⟩
  · by_cases h12 : m < 12
    · simp only [next_month hlt h12]; have := daysIn_range y (m + 1); exact ⟨hy, by omega, by omega, Nat.le_refl 1, by omega⟩
    · simp only [next_year hlt h12]
      have : m = 12 := by omega
      subst this
      exact ⟨by omega, Nat.le_refl 1, by omega, Nat.le_refl 1, by simp [daysIn]⟩

/-- The day before a valid date other than 0000-01-01 is valid, and its next day is that date. -/
theorem prev_ok {y m d : Nat} (h : DateOk y m d) (hf : ¬ (y = 0 ∧ m = 1 ∧ d = 1)) :
    ∃ y' m' d', DateOk y' m' d' ∧ next y' m' d' = (y, m, d) := by
  obtain ⟨hy, hm1, hm2, hd1, hd2⟩ := h
  by_cases h1 : 1 < d
  · exact ⟨y, m, d - 1, ⟨hy, hm1, hm2, by omega, by omega⟩, by rw [next_day (by omega)]; congr 2; omega⟩
  · have hd : d = 1 := by omega
    subst hd
    by_cases hm : 1 < m
    · have := daysIn_range y (m - 1)
      refine ⟨y, m - 1, daysIn y (m - 1), ⟨hy, by omega, by omega, by omega, Nat.le_refl _⟩, ?_⟩
      rw [next_month (Nat.lt_irrefl _) (by omega)]; congr 2; omega
    · have hm' : m = 1 := by omega
      subst hm'
      have h31 : daysIn (y - 1) 12 = 31 := by simp [daysIn]
      refine ⟨y - 1, 12, 31, ⟨by omega, by omega, Nat.le_refl 12, by omega, by omega⟩, ?_⟩
      rw [next_year (by omega) (by omega)]; congr 1; omega

/-! ## Counting the days -/

/-- The `k`th day after 0000-01-01. -/
def nth : Nat → Nat × Nat × Nat
  | 0 => (0, 1, 1)
  | k + 1 => let x := nth k; next x.1 x.2.1 x.2.2

theorem nth_ok : ∀ k, k < calendarDays →
    DateOk (nth k).1 (nth k).2.1 (nth k).2.2 ∧ dayNumber (nth k).1 (nth k).2.1 (nth k).2.2 = k
  | 0, _ => ⟨by simp (config := { decide := true }) [DateOk], by decide⟩
  | k + 1, hk => by
    obtain ⟨hok, hn⟩ := nth_ok k (by omega)
    have hl : ¬ ((nth k).1 = 9999 ∧ (nth k).2.1 = 12 ∧ (nth k).2.2 = 31) := by
      rintro ⟨h1, h2, h3⟩
      rw [h1, h2, h3] at hn
      have : dayNumber 9999 12 31 = calendarDays - 1 := by decide
      omega
    refine ⟨next_ok hok hl, ?_⟩
    simp only [nth]
    rw [next_dayNumber hok, hn]

/-- Every valid date is the `k`th day, for its day number `k`. -/
theorem eq_nth : ∀ n y m d, DateOk y m d → dayNumber y m d = n → (y, m, d) = nth n
  | 0, y, m, d, h, hn => by
    obtain ⟨-, hm1, hm2, hd1, -⟩ := h
    have hv := monthStart_values
    unfold dayNumber absDay yearStart marchYear at hn
    simp only [nth]
    rcases month_cases hm1 hm2 with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
      simp at hn ⊢ <;> omega
  | n + 1, y, m, d, h, hn => by
    have hf : ¬ (y = 0 ∧ m = 1 ∧ d = 1) := by rintro ⟨rfl, rfl, rfl⟩; simp [dayNumber] at hn
    obtain ⟨y', m', d', hp, hpn⟩ := prev_ok h hf
    have hd := next_dayNumber hp
    rw [hpn] at hd
    simp only at hd
    have ih := eq_nth n _ _ _ hp (by omega)
    simp only [nth]
    rw [← ih]
    exact hpn.symm

/-- A valid date's day number is below `calendarDays`. -/
theorem dayNumber_lt {y m d : Nat} (h : DateOk y m d) : dayNumber y m d < calendarDays := by
  obtain ⟨hy, hm1, hm2, hd1, hd2⟩ := h
  have hv := monthStart_values
  have hn := daysIn_month y
  have := daysIn_range y 2
  unfold dayNumber absDay yearStart marchYear calendarDays
  rcases month_cases hm1 hm2 with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl <;>
    simp <;> omega

/--
**Valid dates are exactly the days 0 to 3652424** (0000-01-01 to 9999-12-31):
every valid date has a day number in that range, two valid dates with the
same number are the same, and every number in the range is a valid date.
-/
theorem dateOk_iff_day : (∀ y m d, DateOk y m d → dayNumber y m d < calendarDays) ∧
    (∀ y m d y' m' d', DateOk y m d → DateOk y' m' d' → dayNumber y m d = dayNumber y' m' d' →
      y = y' ∧ m = m' ∧ d = d') ∧
    (∀ n < calendarDays, ∃ y m d, DateOk y m d ∧ dayNumber y m d = n) := by
  refine ⟨fun y m d h => dayNumber_lt h, fun y m d y' m' d' h h' e => ?_, fun n hn => ?_⟩
  · have a := eq_nth _ y m d h rfl
    have b := eq_nth _ y' m' d' h' rfl
    rw [e] at a
    have := a.trans b.symm
    simp only [Prod.mk.injEq] at this
    exact this
  · obtain ⟨hok, hd⟩ := nth_ok n hn
    exact ⟨_, _, _, hok, hd⟩

/-! ## Date strings -/

/-- `v` as exactly `k` decimal digits, with leading zeros. -/
def pad : Nat → Nat → Text
  | 0, _ => []
  | k + 1, v => pad k (v / 10) ++ [Nat.digitChar (v % 10)]

theorem pad_length : ∀ k v, (pad k v).length = k
  | 0, _ => rfl
  | k + 1, v => by simp [pad, pad_length k]

theorem pad_digits : ∀ k v, ∀ c ∈ pad k v, isDigit c = true
  | 0, _ => by simp [pad]
  | k + 1, v => by
    intro c hc
    simp only [pad, List.mem_append, List.mem_singleton] at hc
    rcases hc with hc | rfl
    · exact pad_digits k _ c hc
    · exact isDigit_digitChar _ (Nat.mod_lt _ (by decide))

theorem num_pad : ∀ k v, num (pad k v) = v % 10 ^ k
  | 0, v => by simp [pad, num, digitsValue, Nat.mod_one]
  | k + 1, v => by
    have ih := num_pad k (v / 10)
    simp only [num] at ih
    simp only [pad, num, digitsValue_append, ih]
    rw [hexValue_digitChar (v % 10) (by omega), Nat.pow_succ, Nat.mul_comm (10 ^ k) 10, Nat.mod_mul]
    omega

/-- `k` digits are the padded form of their value. -/
theorem pad_num : ∀ k t, DigitsN k t → pad k (num t) = t
  | 0, t, h => by simp [pad, List.eq_nil_of_length_eq_zero h.1]
  | k + 1, t, h => by
    obtain ⟨hl, hd⟩ := h
    have hne : t ≠ [] := by rintro rfl; simp at hl
    obtain ⟨t', c, rfl⟩ : ∃ t' c, t = t' ++ [c] := ⟨t.dropLast, t.getLast hne, (List.dropLast_concat_getLast hne).symm⟩
    have hc : isDigit c = true := hd c (by simp)
    have hv := hexValue_digit hc
    have ih := pad_num k t' ⟨by simp at hl; omega, fun x hx => hd x (by simp [hx])⟩
    simp only [pad, num, digitsValue_append] at ih ⊢
    have e1 : (digitsValue 10 t' * 10 + hexValue c) / 10 = digitsValue 10 t' := by omega
    have e2 : (digitsValue 10 t' * 10 + hexValue c) % 10 = hexValue c := by omega
    rw [e1, e2, ih, digitChar_hexValue hc]

/-- The text of the `n`th day: `YYYY-MM-DD`. -/
def dateText (n : Nat) : Text :=
  pad 4 (nth n).1 ++ '-' :: pad 2 (nth n).2.1 ++ '-' :: pad 2 (nth n).2.2

theorem date_numbers {s : Text} (h : Date s) :
    ∃ y m d, DateOk y m d ∧ s = pad 4 y ++ '-' :: pad 2 m ++ '-' :: pad 2 d := by
  obtain ⟨ty, tm, td, rfl, hy, hm, hd, hm1, hm2, hd1, hd2⟩ := h
  have hy' : num ty ≤ 9999 := by
    have := digitsValue_lt (b := 10) (ds := ty) (fun c hc => hexValue_digit (hy.2 c hc))
    rw [hy.1] at this; simp only [num]; omega
  exact ⟨num ty, num tm, num td, ⟨hy', hm1, hm2, hd1, hd2⟩, by rw [pad_num 4 ty hy, pad_num 2 tm hm, pad_num 2 td hd]⟩

theorem date_of_numbers {y m d : Nat} (h : DateOk y m d) : Date (pad 4 y ++ '-' :: pad 2 m ++ '-' :: pad 2 d) := by
  obtain ⟨hy, hm1, hm2, hd1, hd2⟩ := h
  have hd31 := daysIn_range y m
  refine ⟨pad 4 y, pad 2 m, pad 2 d, rfl, ⟨pad_length _ _, pad_digits _ _⟩, ⟨pad_length _ _, pad_digits _ _⟩,
    ⟨pad_length _ _, pad_digits _ _⟩, ?_⟩
  simp only [num_pad]
  have e1 : y % 10 ^ 4 = y := Nat.mod_eq_of_lt (by omega)
  have e2 : m % 10 ^ 2 = m := Nat.mod_eq_of_lt (by omega)
  have e3 : d % 10 ^ 2 = d := Nat.mod_eq_of_lt (by omega)
  rw [e1, e2, e3]
  exact ⟨hm1, hm2, hd1, hd2⟩

theorem pad_inj {y m d y' m' d' : Nat} (h : DateOk y m d) (h' : DateOk y' m' d')
    (e : pad 4 y ++ '-' :: pad 2 m ++ '-' :: pad 2 d = pad 4 y' ++ '-' :: pad 2 m' ++ '-' :: pad 2 d') :
    y = y' ∧ m = m' ∧ d = d' := by
  have back : ∀ k v, v < 10 ^ k → num (pad k v) = v := fun k v hv => by rw [num_pad, Nat.mod_eq_of_lt hv]
  obtain ⟨hy, hm1, hm2, -, hd2⟩ := h
  obtain ⟨hy', hm1', hm2', -, hd2'⟩ := h'
  have := daysIn_range y m
  have := daysIn_range y' m'
  simp only [List.append_assoc, List.cons_append] at e
  obtain ⟨e1, e⟩ := List.append_inj e (by simp [pad_length])
  simp only [List.cons.injEq, true_and] at e
  obtain ⟨e2, e⟩ := List.append_inj e (by simp [pad_length])
  simp only [List.cons.injEq, true_and] at e
  refine ⟨?_, ?_, ?_⟩
  · have := congrArg num e1; rwa [back 4 y (by omega), back 4 y' (by omega)] at this
  · have := congrArg num e2; rwa [back 2 m (by omega), back 2 m' (by omega)] at this
  · have := congrArg num e; rwa [back 2 d (by omega), back 2 d' (by omega)] at this

/--
**Valid `Date` strings are exactly the days from 0000-01-01 to 9999-12-31**,
one string per day: a string is a valid `Date` exactly when it is
`dateText n` for some `n < 3652425`, and different days have different texts.
-/
theorem date_iff (s : Text) : Date s ↔ ∃ n < calendarDays, s = dateText n := by
  constructor
  · intro h
    obtain ⟨y, m, d, hok, rfl⟩ := date_numbers h
    refine ⟨dayNumber y m d, dayNumber_lt hok, ?_⟩
    have := eq_nth _ y m d hok rfl
    simp only [dateText, ← this]
  · rintro ⟨n, hn, rfl⟩
    exact date_of_numbers (nth_ok n hn).1

theorem dateText_inj {n n' : Nat} (hn : n < calendarDays) (hn' : n' < calendarDays) (e : dateText n = dateText n') :
    n = n' := by
  obtain ⟨h, hd⟩ := nth_ok n hn
  obtain ⟨h', hd'⟩ := nth_ok n' hn'
  obtain ⟨e1, e2, e3⟩ := pad_inj h h' e
  rw [← hd, ← hd', e1, e2, e3]

end Haus.Time
